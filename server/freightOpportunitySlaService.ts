/**
 * Freight Opportunity Approval SLA Service (Task #364).
 *
 * Computes "awaiting approval" age, tracks per-opportunity SLA breach
 * notifications, and runs a periodic sweep to nudge approving managers
 * (L1) and escalate to their manager (L2) when an opportunity sits too
 * long without a signature.
 *
 * Clock semantics:
 *   - Starts whenever an opportunity is in `ready_to_send` with
 *     approvedAt = null. The importer / approve / revoke / assign
 *     handlers stamp `awaitingApprovalSince` so this service stays a
 *     pure read-side scanner.
 *   - The two `slaNotifiedL1At` / `slaNotifiedL2At` columns are dedup
 *     stamps. They are reset (set to null) every time the awaiting clock
 *     restarts, so a re-import that bounces approval will re-arm both
 *     levels correctly.
 *
 * Recipient semantics:
 *   - L1 (default 2h): the rep's manager (`users.managerId` of the
 *     opportunity's owner / delegate). If the rep has no manager, fall
 *     back to any APPROVER role in the org so the load doesn't go
 *     un-nudged.
 *   - L2 (default 4h): the L1 recipient's own manager. If none, fall
 *     back to admins in the org.
 */

import { and, eq, isNull, isNotNull, lte, inArray, or, sql } from "drizzle-orm";
import { db, storage } from "./storage";
import { freightOpportunities, users } from "@shared/schema";
import type { FreightOpportunity, FreightOpportunityAudit, User } from "@shared/schema";

interface SlaAuditPayload {
  level?: "L1" | "L2";
  ageHours?: number;
  recipientUserIds?: string[];
  thresholdHours?: number;
}

function parseSlaAuditPayload(payload: unknown): SlaAuditPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const recipients = Array.isArray(p.recipientUserIds)
    ? p.recipientUserIds.filter((x): x is string => typeof x === "string")
    : undefined;
  const level = p.level === "L1" || p.level === "L2" ? p.level : undefined;
  return { level, recipientUserIds: recipients };
}

const APPROVER_ROLES = new Set([
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "logistics_manager",
]);

function envHours(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SLA_L1_HOURS = envHours("FREIGHT_APPROVAL_SLA_HOURS", 2);
export const SLA_L2_HOURS = envHours("FREIGHT_APPROVAL_ESCALATION_HOURS", 4);

export type SlaState = "ok" | "warning" | "over" | "escalated";

/**
 * Compute the SLA state + age for one opportunity. Pure helper — no DB.
 * `now` is injectable for tests.
 */
export function computeSlaState(
  opp: Pick<FreightOpportunity, "approvedAt" | "status" | "awaitingApprovalSince">,
  now: Date = new Date(),
): { state: SlaState; ageHours: number | null; awaitingSince: string | null } {
  if (opp.approvedAt) return { state: "ok", ageHours: null, awaitingSince: null };
  if (!opp.awaitingApprovalSince) return { state: "ok", ageHours: null, awaitingSince: null };
  if (opp.status !== "ready_to_send") {
    return { state: "ok", ageHours: null, awaitingSince: null };
  }
  const startMs = opp.awaitingApprovalSince instanceof Date
    ? opp.awaitingApprovalSince.getTime()
    : new Date(opp.awaitingApprovalSince as unknown as string).getTime();
  const ageHours = (now.getTime() - startMs) / 3_600_000;
  let state: SlaState = "ok";
  if (ageHours >= SLA_L2_HOURS) state = "escalated";
  else if (ageHours >= SLA_L1_HOURS) state = "over";
  else if (ageHours >= SLA_L1_HOURS * 0.75) state = "warning";
  return {
    state,
    ageHours,
    awaitingSince: opp.awaitingApprovalSince instanceof Date
      ? opp.awaitingApprovalSince.toISOString()
      : (opp.awaitingApprovalSince as unknown as string),
  };
}

/**
 * Returns opportunities currently awaiting approval longer than `thresholdHours`,
 * org-scoped. Used by the manager dashboard count & the cron sweep.
 */
export async function listOverSlaOpportunities(
  orgId: string,
  thresholdHours: number = SLA_L1_HOURS,
): Promise<FreightOpportunity[]> {
  const cutoff = new Date(Date.now() - thresholdHours * 3_600_000);
  return db.select().from(freightOpportunities).where(and(
    eq(freightOpportunities.orgId, orgId),
    isNull(freightOpportunities.approvedAt),
    isNotNull(freightOpportunities.awaitingApprovalSince),
    eq(freightOpportunities.status, "ready_to_send"),
    lte(freightOpportunities.awaitingApprovalSince, cutoff),
  ));
}

/** In-memory user fetch helper that batches per sweep. */
async function loadUsersByIds(ids: string[]): Promise<Map<string, User>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(users).where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, u as User]));
}

async function approverFallbacks(orgId: string): Promise<User[]> {
  const rows = await db.select().from(users).where(and(
    eq(users.organizationId, orgId),
    inArray(users.role, ["admin", "director", "sales_director", "national_account_manager", "logistics_manager"]),
  ));
  return rows as User[];
}

async function adminFallbacks(orgId: string): Promise<User[]> {
  const rows = await db.select().from(users).where(and(
    eq(users.organizationId, orgId),
    eq(users.role, "admin"),
  ));
  return rows as User[];
}

interface SweepCounts {
  scanned: number;
  l1Notified: number;
  l2Notified: number;
  skipped: number;
  l1NoRecipients: number;
  l2NoRecipients: number;
  l1ClaimRaces: number;
  l2ClaimRaces: number;
  notifyFailures: number;
}

/**
 * Atomically claim an L1 (or L2) notification slot via a conditional update.
 * Returns true if this caller "won" the claim and should send notifications;
 * false if another concurrent sweep already stamped the row.
 */
async function tryClaimSlaStamp(
  orgId: string,
  oppId: string,
  level: "L1" | "L2",
  now: Date,
): Promise<boolean> {
  const col = level === "L1" ? "sla_notified_l1_at" : "sla_notified_l2_at";
  const result = await db.execute<{ id: string }>(sql`
    UPDATE freight_opportunities
    SET ${sql.raw(col)} = ${now}
    WHERE id = ${oppId}
      AND org_id = ${orgId}
      AND ${sql.raw(col)} IS NULL
      AND approved_at IS NULL
    RETURNING id
  `);
  // node-pg returns { rows: [...] }; some drivers return the array directly.
  const maybeRows = (result as unknown as { rows?: unknown[] }).rows;
  const rows: unknown[] = Array.isArray(maybeRows)
    ? maybeRows
    : Array.isArray(result)
      ? (result as unknown as unknown[])
      : [];
  return rows.length > 0;
}

/**
 * Roll back a claim when no recipient could be notified — keeps the dedup
 * stamp clear so the next sweep can try again instead of silently suppressing
 * the alert forever.
 */
async function releaseSlaStamp(orgId: string, oppId: string, level: "L1" | "L2"): Promise<void> {
  const col = level === "L1" ? "sla_notified_l1_at" : "sla_notified_l2_at";
  await db.execute(sql`
    UPDATE freight_opportunities
    SET ${sql.raw(col)} = NULL
    WHERE id = ${oppId} AND org_id = ${orgId}
  `);
}

/**
 * Single-org sweep: walks awaiting opps, fires L1 / L2 notifications when
 * thresholds cross, dedupes via the per-row stamp columns, and writes audit.
 * Returns counts for the caller (cron logs, manager observability).
 */
export async function runOrgSlaSweep(orgId: string, now: Date = new Date()): Promise<SweepCounts> {
  const counts: SweepCounts = {
    scanned: 0, l1Notified: 0, l2Notified: 0, skipped: 0,
    l1NoRecipients: 0, l2NoRecipients: 0,
    l1ClaimRaces: 0, l2ClaimRaces: 0, notifyFailures: 0,
  };
  // Pull anything past L1 threshold — L2 candidates are a subset of these.
  const candidates = await listOverSlaOpportunities(orgId, SLA_L1_HOURS);
  if (candidates.length === 0) return counts;
  counts.scanned = candidates.length;

  // Pre-load owner / delegate / manager users.
  const ownerIds = candidates.flatMap((o) => [o.ownerUserId, o.delegatedToUserId]).filter(
    (x): x is string => !!x,
  );
  const owners = await loadUsersByIds(ownerIds);
  const managerIds = Array.from(owners.values()).map((u) => u.managerId).filter(
    (x): x is string => !!x,
  );
  const managers = await loadUsersByIds(managerIds);
  const grandManagerIds = Array.from(managers.values()).map((u) => u.managerId).filter(
    (x): x is string => !!x,
  );
  const grandManagers = await loadUsersByIds(grandManagerIds);

  let approverFallback: User[] | null = null;
  let adminFallback: User[] | null = null;

  for (const opp of candidates) {
    const { state, ageHours } = computeSlaState(opp, now);
    if (state !== "over" && state !== "escalated") {
      counts.skipped++;
      continue;
    }
    const ownerId = opp.delegatedToUserId ?? opp.ownerUserId ?? null;
    const owner = ownerId ? owners.get(ownerId) ?? null : null;

    // Track which user we actually escalated to at L1, so L2 can route to
    // *that* recipient's manager (not the rep's grand-manager via owner chain).
    let l1ActualRecipients: User[] = [];

    // ── L1 notification ────────────────────────────────────────────────
    if (!opp.slaNotifiedL1At) {
      let l1Recipients: User[] = [];
      if (owner?.managerId) {
        const mgr = managers.get(owner.managerId);
        if (mgr) l1Recipients = [mgr];
      }
      if (l1Recipients.length === 0) {
        if (!approverFallback) approverFallback = await approverFallbacks(orgId);
        l1Recipients = approverFallback.filter((u) => !owner || u.id !== owner.id);
      } else {
        l1Recipients = l1Recipients.filter((u) => !owner || u.id !== owner.id);
      }

      if (l1Recipients.length === 0) {
        // Nothing we can do — log + count, but DO NOT stamp the dedup column,
        // so the next sweep gets another shot once orgs/managers change.
        counts.l1NoRecipients++;
        console.warn(`[freight-sla] L1 skipped — no recipients for opp=${opp.id} org=${orgId}`);
      } else {
        // Atomic claim BEFORE notifying, prevents concurrent-sweep duplicates.
        const claimed = await tryClaimSlaStamp(orgId, opp.id, "L1", now);
        if (!claimed) {
          counts.l1ClaimRaces++;
        } else {
          const company = await storage.getCompany(opp.companyId).catch(() => null);
          const lane = formatLane(opp);
          const customer = company?.name ?? "Customer";
          const ageStr = ageHours != null ? `${ageHours.toFixed(1)}h` : "?";
          let anySent = false;
          for (const r of l1Recipients) {
            try {
              await storage.createNotification({
                userId: r.id,
                type: "freight_approval_sla",
                title: `Approval overdue (${ageStr}) — ${customer}`,
                body: `${customer} · ${lane}. Waiting on your approval. Open Available Freight to approve & unblock the rep.`,
                link: `/available-freight/${opp.id}`,
                relatedId: opp.id,
                read: false,
              });
              anySent = true;
            } catch (err) {
              counts.notifyFailures++;
              console.error(`[freight-sla] L1 notify failed opp=${opp.id} user=${r.id}:`, err);
            }
          }
          if (!anySent) {
            // All sends failed → release the claim so we retry next sweep.
            await releaseSlaStamp(orgId, opp.id, "L1");
            counts.l1NoRecipients++;
          } else {
            l1ActualRecipients = l1Recipients;
            await storage.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "sla_nudged",
              actorUserId: null,
              payload: {
                level: "L1",
                ageHours: Number(ageHours?.toFixed(2) ?? 0),
                recipientUserIds: l1Recipients.map((u) => u.id),
                thresholdHours: SLA_L1_HOURS,
              },
            });
            counts.l1Notified++;
          }
        }
      }
    } else if (opp.slaNotifiedL1At) {
      // L1 fired in a prior sweep — recover the actual recipient list from
      // the latest sla_nudged audit so L2 routing escalates to *that* user's
      // manager (not the rep's grand-manager via owner chain). This matters
      // when L1 used the approver-fallback path.
      try {
        const audits = await storage.listFreightOpportunityAudit(opp.id);
        // listFreightOpportunityAudit orders ASC (oldest first) — scan in
        // reverse to get the most recent L1 nudge after multi-cycle resets.
        let lastL1: FreightOpportunityAudit | undefined;
        let lastL1Payload: SlaAuditPayload | null = null;
        for (let i = audits.length - 1; i >= 0; i--) {
          const a = audits[i];
          if (a.eventType !== "sla_nudged") continue;
          const parsed = parseSlaAuditPayload(a.payload);
          if (parsed?.level === "L1") {
            lastL1 = a;
            lastL1Payload = parsed;
            break;
          }
        }
        void lastL1;
        const recipientIds: string[] = lastL1Payload?.recipientUserIds ?? [];
        if (recipientIds.length > 0) {
          const recovered = await loadUsersByIds(recipientIds);
          l1ActualRecipients = Array.from(recovered.values());
        }
      } catch (err) {
        console.warn(`[freight-sla] L1 recovery failed for opp=${opp.id}:`, err);
      }
      if (l1ActualRecipients.length === 0 && owner?.managerId) {
        const mgr = managers.get(owner.managerId);
        if (mgr) l1ActualRecipients = [mgr];
      }
    }

    // ── L2 escalation ─────────────────────────────────────────────────
    if (state === "escalated" && !opp.slaNotifiedL2At) {
      let l2Recipients: User[] = [];
      // Prefer L1-recipient's manager (the actual person we paged), then fall
      // back to owner's grand-manager, then admins.
      const l1Manager: User | null = (() => {
        for (const r of l1ActualRecipients) {
          if (r.managerId) {
            const cached = managers.get(r.managerId) ?? grandManagers.get(r.managerId);
            if (cached) return cached;
          }
        }
        return null;
      })();
      if (l1Manager) {
        l2Recipients = [l1Manager];
      } else if (owner?.managerId) {
        const mgr = managers.get(owner.managerId);
        if (mgr?.managerId) {
          const grand = grandManagers.get(mgr.managerId);
          if (grand) l2Recipients = [grand];
        }
      }
      if (l2Recipients.length === 0) {
        if (!adminFallback) adminFallback = await adminFallbacks(orgId);
        l2Recipients = adminFallback;
      }
      l2Recipients = l2Recipients.filter((u) => !owner || u.id !== owner.id);

      if (l2Recipients.length === 0) {
        counts.l2NoRecipients++;
        console.warn(`[freight-sla] L2 skipped — no recipients for opp=${opp.id} org=${orgId}`);
      } else {
        const claimed = await tryClaimSlaStamp(orgId, opp.id, "L2", now);
        if (!claimed) {
          counts.l2ClaimRaces++;
        } else {
          const company = await storage.getCompany(opp.companyId).catch(() => null);
          const lane = formatLane(opp);
          const customer = company?.name ?? "Customer";
          const ageStr = ageHours != null ? `${ageHours.toFixed(1)}h` : "?";
          let anySent = false;
          for (const r of l2Recipients) {
            try {
              await storage.createNotification({
                userId: r.id,
                type: "freight_approval_escalation",
                title: `Escalation (${ageStr}) — ${customer} freight unapproved`,
                body: `${customer} · ${lane} has been waiting > ${SLA_L2_HOURS}h. Their manager hasn't approved. Step in via Available Freight.`,
                link: `/available-freight/${opp.id}`,
                relatedId: opp.id,
                read: false,
              });
              anySent = true;
            } catch (err) {
              counts.notifyFailures++;
              console.error(`[freight-sla] L2 notify failed opp=${opp.id} user=${r.id}:`, err);
            }
          }
          if (!anySent) {
            await releaseSlaStamp(orgId, opp.id, "L2");
            counts.l2NoRecipients++;
          } else {
            await storage.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "sla_escalated",
              actorUserId: null,
              payload: {
                level: "L2",
                ageHours: Number(ageHours?.toFixed(2) ?? 0),
                recipientUserIds: l2Recipients.map((u) => u.id),
                thresholdHours: SLA_L2_HOURS,
              },
            });
            counts.l2Notified++;
          }
        }
      }
    }
  }
  return counts;
}

function formatLane(opp: Pick<FreightOpportunity, "origin" | "originState" | "destination" | "destinationState">): string {
  const o = opp.originState ? `${opp.origin}, ${opp.originState}` : opp.origin;
  const d = opp.destinationState ? `${opp.destination}, ${opp.destinationState}` : opp.destination;
  return `${o} → ${d}`;
}

/**
 * Cross-org sweep — invoked by cron. Errors per-org are swallowed so a
 * single bad org never starves the rest.
 */
export async function runScheduledSlaSweep(): Promise<void> {
  const orgs = await storage.getOrganizations();
  for (const org of orgs) {
    try {
      const counts = await runOrgSlaSweep(org.id);
      if (counts.l1Notified || counts.l2Notified) {
        console.log(
          `[freight-sla-sweep] org=${org.id} scanned=${counts.scanned} ` +
          `l1=${counts.l1Notified} l2=${counts.l2Notified}`,
        );
      }
    } catch (err) {
      console.error(`[freight-sla-sweep] org=${org.id} failed:`, err);
    }
  }
}

/**
 * Convenience helper for the My Procurement endpoint — counts over-SLA
 * opportunities org-wide, used to drive the manager dashboard badge.
 */
export async function countOverSlaForOrg(orgId: string): Promise<number> {
  const cutoff = new Date(Date.now() - SLA_L1_HOURS * 3_600_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(freightOpportunities)
    .where(and(
      eq(freightOpportunities.orgId, orgId),
      isNull(freightOpportunities.approvedAt),
      isNotNull(freightOpportunities.awaitingApprovalSince),
      eq(freightOpportunities.status, "ready_to_send"),
      lte(freightOpportunities.awaitingApprovalSince, cutoff),
    ));
  return n ?? 0;
}

export { APPROVER_ROLES };
