/**
 * NBA Outcome Classifier (Task #374)
 *
 * Sweeps every 15 minutes for resolved nba_cards whose attribution window
 * has elapsed but for which no nba_card_outcomes row exists yet. For each
 * card, applies a rule-type-specific attribution heuristic to classify the
 * outcome as "worked" / "no_response" / "partial" and attribute an estimated
 * $ impact (defaulting to the card's at_stake_amount).
 *
 * Attribution windows by rule type (days after resolved_at):
 *   stale_account              7
 *   single_thread_risk        14
 *   recurring_lane_capacity   14
 *   missed_inbound_call        3
 *   relationship_decay        14
 *   commitment_overdue         3
 *   default                    7
 *
 * "Worked" signal:
 *   - actioned + a meaningful touchpoint exists for the card's company
 *     within the window (or the linked commitment is now completed); or
 *   - lane capacity card auto-resolved via outreach threshold.
 * "No response":
 *   - dismissed or expired with no follow-up signal in window.
 */
import cron from "node-cron";
import { sql } from "drizzle-orm";
import { db, storage } from "./storage";
import { organizations, type NbaCard } from "@shared/schema";

const ATTR_WINDOWS: Record<string, number> = {
  stale_account: 7,
  single_thread_risk: 14,
  recurring_lane_capacity: 14,
  missed_inbound_call: 3,
  relationship_decay: 14,
  commitment_overdue: 3,
};
const DEFAULT_WINDOW = 7;

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [nba-outcome-classifier] ${msg}`);
}

function windowFor(ruleType: string): number {
  return ATTR_WINDOWS[ruleType] ?? DEFAULT_WINDOW;
}

async function classifyCard(card: NbaCard): Promise<boolean> {
  const ruleType = card.ruleType;
  const status = card.status;
  if (!card.resolvedAt) return false;
  const resolvedAt = new Date(card.resolvedAt);
  const windowDays = windowFor(ruleType);
  const windowEnd = new Date(resolvedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
  if (windowEnd > new Date()) return false; // window not yet elapsed

  const cardId = card.id;
  const orgId = card.orgId;
  const userId = card.userId;
  const companyId = card.companyId;
  const atStake = card.atStakeAmount;
  const dollarImpact = atStake != null ? String(atStake) : null;

  let outcome: "worked" | "no_response" | "partial" | "unknown" = "unknown";
  let basis = "";
  const signals: Record<string, unknown> = { windowDays, status };

  // 1) Lane capacity auto-completion via outreach threshold or program toggle
  if (ruleType === "recurring_lane_capacity" && status === "actioned") {
    outcome = "worked";
    basis = "Lane capacity card resolved via outreach threshold or program activation";
  }
  // 2) Linked commitment completed within the window
  else if (card.linkedCommitmentId) {
    const commitmentId = card.linkedCommitmentId;
    const cRow = await db.execute<{ status: string; completed_at: string | null; updated_at: string | null }>(sql`
      SELECT status, completed_at, updated_at FROM weekly_commitments WHERE id = ${commitmentId} LIMIT 1
    `);
    const c = (cRow.rows ?? [])[0];
    // Require completion to have happened in [resolvedAt, windowEnd] so we
    // don't credit commitments that completed before the card was even resolved.
    const completedTs = c?.completed_at ?? c?.updated_at ?? null;
    if (
      c && c.status === "completed" && completedTs &&
      new Date(completedTs) >= resolvedAt &&
      new Date(completedTs) <= windowEnd
    ) {
      outcome = "worked";
      basis = "Linked commitment was completed within attribution window";
      signals.commitmentId = commitmentId;
    }
  }

  // 3) Touchpoint logged for this company within the window (after resolved)
  if (outcome === "unknown" && companyId) {
    const tpRow = await db.execute<{ id: string; created_at: string; is_meaningful: boolean | null }>(sql`
      SELECT id, created_at, is_meaningful FROM touchpoints
      WHERE company_id = ${companyId}
        AND logged_by_id = ${userId}
        AND created_at >= ${resolvedAt.toISOString()}
        AND created_at <= ${windowEnd.toISOString()}
      ORDER BY is_meaningful DESC NULLS LAST, created_at ASC
      LIMIT 1
    `);
    const tp = (tpRow.rows ?? [])[0];
    if (tp) {
      const meaningful = tp.is_meaningful === true;
      // Meaningful touchpoint after a card action is the strongest non-commitment
      // success signal we have. Non-meaningful touchpoints get partial credit.
      if (meaningful && status === "actioned") {
        outcome = "worked";
        basis = `Meaningful touchpoint logged within ${windowDays}-day window`;
      } else if (status === "actioned") {
        outcome = "partial";
        basis = `Touchpoint logged within window but not flagged meaningful`;
      } else {
        outcome = "partial";
        basis = `Touchpoint logged after ${status} action — partial credit`;
      }
      signals.touchpointId = tp.id;
      signals.touchpointMeaningful = meaningful;
    }
  }

  // 4) Default: actioned without follow-up = partial; dismissed/expired = no_response
  if (outcome === "unknown") {
    if (status === "actioned") {
      outcome = "partial";
      basis = "Action taken but no follow-up touchpoint detected in window";
    } else if (status === "dismissed" || status === "expired") {
      outcome = "no_response";
      basis = `Card was ${status} and no follow-up activity detected in window`;
    } else if (status === "snoozed") {
      outcome = "no_response";
      basis = "Card was snoozed and not subsequently actioned within window";
    } else if (status === "alternate") {
      // Rep took a different action than the suggested one — partial credit
      // and capture the rep's note as a signal so engine learning can analyze it.
      outcome = "partial";
      basis = "Rep took an alternate action vs. the suggested action";
      if (card.alternateActionNote) signals.alternateActionNote = card.alternateActionNote;
    }
  }

  // partial credit on $ impact
  const impact = outcome === "worked" ? dollarImpact
    : outcome === "partial" && dollarImpact ? String(Number(dollarImpact) * 0.5)
    : null;

  await storage.upsertNbaCardOutcome({
    cardId,
    orgId,
    userId,
    ruleType,
    outcome,
    basis,
    dollarImpact: impact,
    fromAction: status,
    attributionWindowDays: windowDays,
    signals,
  });

  await storage.recordNbaCardEvent({
    cardId, orgId, userId,
    actorUserId: null,
    eventType: "outcome_classified",
    reason: outcome,
    metadata: { dollarImpact: impact, basis, windowDays },
  });
  return true;
}

export async function classifyPendingOutcomes(): Promise<{ classified: number }> {
  try {
    const orgs = await db.select({ id: organizations.id }).from(organizations);
    let total = 0;
    for (const org of orgs) {
      const cards = await storage.getResolvedNbaCardsAwaitingClassification(org.id);
      for (const c of cards) {
        try {
          if (await classifyCard(c)) total++;
        } catch (e) {
          log(`Failed card ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (total > 0) log(`Classified ${total} resolved card(s).`);
    return { classified: total };
  } catch (err) {
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return { classified: 0 };
  }
}

export function initNbaOutcomeClassifier() {
  classifyPendingOutcomes();
  cron.schedule("*/15 * * * *", () => classifyPendingOutcomes());
  log("NBA outcome classifier initialized (every 15 min).");
}
