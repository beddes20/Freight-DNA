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
  CompanyOutreachPolicy, FreightOpportunity, FreightOpportunityCarrier,
  InsertCompanyOutreachPolicy, User,
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
 * Compute the next-fire UTC instant for a policy. The scheduler runs hourly;
 * a policy fires the next time the CT clock hits `policy.autoSendHourCt` and
 * `sameCentralDay(policy.autoSendLastRunAt, fireTime)` is false.
 *
 * If the policy already ran today (CT), the next fire is tomorrow at HH:00 CT.
 * Otherwise, if today's HH:00 CT is in the future relative to `now`, fire
 * today; if today's HH:00 CT is in the past, the policy missed its window
 * today and will fire tomorrow.
 */
export function nextRunAtForPolicy(policy: CompanyOutreachPolicy, now = new Date()): Date {
  const hour = Math.max(0, Math.min(23, policy.autoSendHourCt));
  const ranToday = sameCentralDay(policy.autoSendLastRunAt, now);
  // Build today's HH:00 CT instant by formatting "now" as a CT calendar date
  // and constructing a UTC anchor for that date — then fold in the CT offset.
  const ctDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: CT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const today = ctHourToUtc(ctDate, hour);
  if (!ranToday && today.getTime() > now.getTime()) return today;
  return ctHourToUtc(addOneCtDay(ctDate), hour);
}

/** Format "YYYY-MM-DD" + hour-in-CT into the corresponding UTC Date instant. */
function ctHourToUtc(ctDate: string, hour: number): Date {
  // Probe a noon-UTC anchor for the date to learn the CT offset on that date
  // (handles DST). The probe is in UTC, so adding the offset gives us HH:00 CT.
  const probe = new Date(`${ctDate}T12:00:00.000Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ, hour12: false, hour: "2-digit",
  });
  const ctHourAtProbe = parseInt(fmt.formatToParts(probe).find(p => p.type === "hour")!.value, 10) % 24;
  const offsetHours = 12 - ctHourAtProbe; // probe was UTC noon
  const utcHour = (hour + offsetHours + 24) % 24;
  // If the requested CT hour rolled past UTC midnight, push forward a day.
  const utcDayShift = (hour + offsetHours) >= 24 ? 1 : (hour + offsetHours) < 0 ? -1 : 0;
  const base = new Date(`${ctDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + utcDayShift);
  base.setUTCHours(utcHour, 0, 0, 0);
  return base;
}

function addOneCtDay(ctDate: string): string {
  const d = new Date(`${ctDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/**
 * Read-only mirror of `runAutoPilotTick` selection logic. Used by the
 * "Auto-pilot preview" drawer to show reps EXACTLY which (company, opp,
 * top-N carriers) tuples are armed for the next CT run, without actually
 * dispatching anything. Picks identical candidates by:
 *   - listCompanyOutreachPolicies(enabledOnly: true)
 *   - autoSendEnabled gate
 *   - sameCentralDay(autoSendLastRunAt) skip
 *   - listFreightOpportunities (status ready/new/awaiting_approval)
 *   - !isSnoozed
 *   - approval gate (when policy.approvalRequired)
 *   - ensureShortlistRanked (so freshly imported opps surface)
 *   - top-N + maxPerDay cap
 *
 * The single intentional difference: this helper does NOT honor the
 * `autoSendHourCt` hour-match gate so the drawer can preview policies whose
 * next fire is in a future hour. That gate is re-applied at run-time by
 * `runAutoPilotTick`.
 */
export interface AutoPilotPendingCarrier {
  rowId: string;
  carrierId: string;
  rank: number | null;
  fitScore: number;
  bucket: string | null;
  explanation: string | null;
}
export interface AutoPilotPendingOpportunity {
  opportunity: FreightOpportunity;
  candidates: AutoPilotPendingCarrier[];
  /** Eligible carriers beyond the top-N cut, surfaced for transparency. */
  remaining: AutoPilotPendingCarrier[];
  /** Excluded carriers, surfaced so reps see the suppressions. */
  suppressed: Array<AutoPilotPendingCarrier & { reason: string }>;
}
export interface AutoPilotPendingPolicyEntry {
  policy: CompanyOutreachPolicy;
  nextRunAt: Date;
  opportunities: AutoPilotPendingOpportunity[];
  totalCarriers: number;
  /** When set, the policy is armed but cannot actually fire (e.g. no actor). */
  blockedReason?: "missing_actor";
}

function carrierToPending(c: FreightOpportunityCarrier): AutoPilotPendingCarrier {
  return {
    rowId: c.id,
    carrierId: c.carrierId,
    rank: c.rank,
    fitScore: c.fitScore,
    bucket: c.bucket,
    explanation: c.explanation,
  };
}

export async function listAutoPilotPendingForOrg(
  s: IStorage,
  orgId: string,
  now: Date = new Date(),
): Promise<AutoPilotPendingPolicyEntry[]> {
  const out: AutoPilotPendingPolicyEntry[] = [];
  const policies = await s.listCompanyOutreachPolicies(orgId, { enabledOnly: true });
  for (const policy of policies) {
    if (!policy.autoSendEnabled) continue;
    if (sameCentralDay(policy.autoSendLastRunAt, now)) continue;

    const cap = Math.max(1, policy.autoSendMaxPerDay);
    const opps = await s.listFreightOpportunities(orgId, {
      companyId: policy.companyId,
      status: ["ready_to_send", "new", "awaiting_approval"],
      limit: 50,
    });

    const entry: AutoPilotPendingPolicyEntry = {
      policy,
      nextRunAt: nextRunAtForPolicy(policy, now),
      opportunities: [],
      totalCarriers: 0,
    };
    if (!policy.updatedById) entry.blockedReason = "missing_actor";

    let allocated = 0;
    for (const opp of opps) {
      if (allocated >= cap) break;
      if (isSnoozed(opp, now)) continue;
      if (policy.approvalRequired && !opp.approvedAt) continue;

      // Make sure the shortlist exists; preview must mirror what runAutoPilotTick
      // would have at fire-time.
      await ensureShortlistRanked(s, opp);
      const carriers = await s.listFreightOpportunityCarriers(opp.id);
      const eligible = carriers
        .filter(c => !c.excludedReason && !c.sentAt)
        .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
      const remainingCap = cap - allocated;
      const take = Math.min(policy.autoSendTopN, remainingCap);
      const candidates = eligible.slice(0, take).map(carrierToPending);
      const remaining = eligible.slice(take).map(carrierToPending);
      const suppressed = carriers
        .filter(c => !!c.excludedReason)
        .map(c => ({ ...carrierToPending(c), reason: c.excludedReason! }));

      if (candidates.length === 0 && suppressed.length === 0) continue;

      entry.opportunities.push({
        opportunity: opp,
        candidates,
        remaining,
        suppressed,
      });
      allocated += candidates.length;
      entry.totalCarriers += candidates.length;
    }

    if (entry.opportunities.length > 0) out.push(entry);
  }
  // Sort by nextRunAt ascending so the soonest run shows first.
  out.sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime());
  return out;
}

/**
 * Suppress exactly the *next* scheduled auto-pilot run for this policy
 * without changing the policy schema. We do this by stamping
 * `autoSendLastRunAt` to a moment inside the CT day on which the next fire
 * would land — so when the scheduler tick runs at that hour,
 * `sameCentralDay(autoSendLastRunAt, fireInstant)` returns true and the
 * tick skips. The run after that (next CT day) fires normally.
 *
 * Why we don't just stamp `now`: if today's CT fire window already passed
 * (e.g. user clicks Skip at 10:00 CT for an 07:00 CT policy), stamping
 * `now` would mark "today" as already-ran — but the next fire was
 * tomorrow anyway, so nothing is skipped. By stamping the next-fire CT
 * day instead, we always cancel the upcoming tick, regardless of the
 * current clock.
 */
export function buildSkipNextRunPolicyUpsert(
  policy: CompanyOutreachPolicy,
  now: Date,
): InsertCompanyOutreachPolicy {
  const next = nextRunAtForPolicy(policy, now);
  return buildPolicyUpsertExternal(policy, { autoSendLastRunAt: next });
}

/**
 * Mark `autoSendEnabled = false` while preserving the rest of the policy.
 * Used by the drawer's "Disable policy" action.
 */
export function buildDisableAutoSendPolicyUpsert(
  policy: CompanyOutreachPolicy,
): InsertCompanyOutreachPolicy {
  return buildPolicyUpsertExternal(policy, { autoSendEnabled: false });
}

// Wrap the local `buildPolicyUpsert` so route code can reuse it without
// duplicating the type-safe column list.
function buildPolicyUpsertExternal(
  policy: CompanyOutreachPolicy,
  patch: Partial<InsertCompanyOutreachPolicy>,
): InsertCompanyOutreachPolicy {
  return buildPolicyUpsert(policy, patch);
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
