/**
 * Available Freight Cockpit (Task #601) — auto-pilot scheduler.
 *
 * Hourly cron tick that, for each org, finds company outreach policies with
 * `autoSendEnabled = true` and a configured `autoSendHourCt` matching the
 * current Central-Time hour, and dispatches a top-N wave for each candidate
 * opportunity for that company.
 *
 * Guardrails reused (NOT bypassed):
 *   - sendOpportunityWave reloads the policy at send time and re-evaluates
 *     `doNotAutomate`, `enabled`, and per-carrier eligibility / dedup. Auto
 *     pilot never skips that gate; it only chooses which carrier rows to
 *     hand it.
 *   - `autoSendMaxPerDay` caps the carrier sends per company per UTC day so a
 *     misconfigured policy cannot blast a customer's bench.
 *   - The created-by user is the policy's `updatedById`. If null we bail
 *     rather than impersonate a system actor.
 */

import { storage } from "./storage";
import { sendOpportunityWave } from "./freightOpportunityOutreachService";
import { ensureShortlistRanked } from "./proactiveOpportunityService";
import type {
  CompanyOutreachPolicy, FreightOpportunity, InsertCompanyOutreachPolicy, User,
} from "@shared/schema";
import type { IStorage } from "./storage";

const CT_TZ = "America/Chicago";

/**
 * Returns the current hour (0–23) in Central Time.
 * Pure helper extracted for tests.
 */
export function currentCentralHour(now = new Date()): number {
  // Intl is the only correct way to get a wall-clock hour in a named tz.
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: CT_TZ,
  });
  const parts = fmt.formatToParts(now);
  const hourPart = parts.find(p => p.type === "hour");
  const h = hourPart ? parseInt(hourPart.value, 10) : NaN;
  // Intl returns "24" instead of "00" in some locales — normalize.
  return Number.isFinite(h) ? (h === 24 ? 0 : h) : 0;
}

/**
 * Did `lastRunAt` happen during the same Central-Time calendar day as `now`?
 * Used to dedup the daily auto-pilot tick.
 */
export function sameCentralDay(lastRunAt: Date | null | undefined, now = new Date()): boolean {
  if (!lastRunAt) return false;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: CT_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(lastRunAt) === fmt.format(now);
}

export interface AutoPilotTickResult {
  policiesConsidered: number;
  policiesFired: number;
  opportunitiesProcessed: number;
  carriersSent: number;
  carriersBlocked: number;
  errors: Array<{ orgId: string; companyId: string; message: string }>;
}

/**
 * Run a single auto-pilot tick for all configured orgs. Safe to call from a
 * cron job or directly from tests.
 */
export async function runAutoPilotTick(
  s: IStorage = storage,
  now: Date = new Date(),
): Promise<AutoPilotTickResult> {
  const result: AutoPilotTickResult = {
    policiesConsidered: 0,
    policiesFired: 0,
    opportunitiesProcessed: 0,
    carriersSent: 0,
    carriersBlocked: 0,
    errors: [],
  };

  const orgs = await s.getOrganizations();
  const ctHour = currentCentralHour(now);

  for (const org of orgs) {
    const policies = await s.listCompanyOutreachPolicies(org.id, { enabledOnly: true });
    for (const policy of policies) {
      if (!policy.autoSendEnabled) continue;
      result.policiesConsidered += 1;
      if (policy.autoSendHourCt !== ctHour) continue;
      if (sameCentralDay(policy.autoSendLastRunAt, now)) continue;

      const actor = await resolveActor(s, policy);
      if (!actor) {
        result.errors.push({
          orgId: org.id,
          companyId: policy.companyId,
          message: "No updatedById on policy — refusing to auto-send without an actor",
        });
        continue;
      }

      let sentForCompany = 0;
      const cap = Math.max(1, policy.autoSendMaxPerDay);
      try {
        const opps = await s.listFreightOpportunities(org.id, {
          companyId: policy.companyId,
          status: ["ready_to_send", "new", "awaiting_approval"],
          limit: 50,
        });
        // Prefer the most-urgent first (storage already orders by urgencyScore desc).
        for (const opp of opps) {
          if (sentForCompany >= cap) break;
          // Skip snoozed opps so the cockpit's snooze respects auto-pilot.
          if (isSnoozed(opp, now)) continue;
          // Auto-pilot honors the customer policy as the single source of truth.
          // When approvalRequired=false on the policy, the rep has explicitly
          // opted into hands-off sending — including for available_freight_import
          // rows — so we don't second-guess them by hard-coding a source-based
          // gate. When approvalRequired=true, awaiting_approval rows are skipped
          // until the rep approves them in the cockpit.
          if (policy.approvalRequired && !opp.approvedAt) continue;

          await ensureShortlistRanked(s, opp);
          const carriers = await s.listFreightOpportunityCarriers(opp.id);
          const remaining = cap - sentForCompany;
          const candidates = carriers
            .filter(c => !c.excludedReason && !c.sentAt)
            .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
            .slice(0, Math.min(policy.autoSendTopN, remaining));
          if (candidates.length === 0) continue;

          try {
            const { results } = await sendOpportunityWave(s, org.id, opp.id, actor, {
              carrierRowIds: candidates.map(c => c.id),
              // Task #631 — tag the source so the unified contact-lock view
              // surfaces "Contacted via auto-pilot" (and omits the rep name,
              // which is the policy owner here, not the actual sender).
              sourceModule: "auto_pilot",
            });
            const sent = results.filter(r => r.status === "sent" || r.status === "scheduled").length;
            const blocked = results.filter(r => r.status === "blocked").length;
            result.carriersSent += sent;
            result.carriersBlocked += blocked;
            sentForCompany += sent;
            result.opportunitiesProcessed += 1;

            await s.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "outreach_sent",
              actorUserId: actor.id,
              payload: {
                kind: "auto_pilot_tick",
                ctHour,
                sent,
                blocked,
                topN: policy.autoSendTopN,
                cap,
              },
            });
          } catch (sendErr) {
            const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
            // Per-opp send errors must not stop the loop — log and move on.
            console.warn(`[freight-autopilot] send failed org=${org.id} opp=${opp.id}: ${msg}`);
            await s.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "outreach_blocked",
              actorUserId: actor.id,
              payload: { kind: "auto_pilot_tick_failed", message: msg },
            }).catch(() => {});
          }
        }
        // Even a fired-but-zero-sent run still counts so we record lastRunAt
        // and don't re-attempt the same hour later.
        result.policiesFired += 1;
        await s.upsertCompanyOutreachPolicy(buildPolicyUpsert(policy, { autoSendLastRunAt: now }));
      } catch (err) {
        result.errors.push({
          orgId: org.id,
          companyId: policy.companyId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

function isSnoozed(opp: FreightOpportunity, now: Date): boolean {
  if (!opp.snoozedUntil) return false;
  const t = new Date(opp.snoozedUntil).getTime();
  if (!Number.isFinite(t)) return false;
  return t > now.getTime();
}

/**
 * Build a typed `InsertCompanyOutreachPolicy` payload from an existing row plus
 * an override patch. We can't spread the full select row because it carries
 * `id`/`updatedAt` columns that the insert schema omits — building the payload
 * explicitly keeps the upsert call type-safe and review-friendly.
 */
function buildPolicyUpsert(
  policy: CompanyOutreachPolicy,
  patch: Partial<InsertCompanyOutreachPolicy>,
): InsertCompanyOutreachPolicy {
  return {
    orgId: policy.orgId,
    companyId: policy.companyId,
    enabled: policy.enabled,
    mode: policy.mode as InsertCompanyOutreachPolicy["mode"],
    approvalRequired: policy.approvalRequired,
    maxCarriersPerOpportunity: policy.maxCarriersPerOpportunity,
    leadTimeMinDays: policy.leadTimeMinDays,
    leadTimeMaxDays: policy.leadTimeMaxDays,
    approvedCarrierOnly: policy.approvedCarrierOnly,
    approvedCarrierIds: policy.approvedCarrierIds ?? [],
    doNotAutomate: policy.doNotAutomate,
    specialNotes: policy.specialNotes,
    autoSendEnabled: policy.autoSendEnabled,
    autoSendHourCt: policy.autoSendHourCt,
    autoSendTopN: policy.autoSendTopN,
    autoSendMaxPerDay: policy.autoSendMaxPerDay,
    autoSendLastRunAt: policy.autoSendLastRunAt,
    updatedById: policy.updatedById,
    ...patch,
  };
}

async function resolveActor(s: IStorage, policy: CompanyOutreachPolicy): Promise<User | null> {
  if (!policy.updatedById) return null;
  try {
    const user = await s.getUser(policy.updatedById);
    return user ?? null;
  } catch {
    return null;
  }
}
