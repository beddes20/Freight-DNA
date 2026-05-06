/**
 * Task #701 — First-time-degraded notifier.
 *
 * Whenever a fresh snapshot reports `degraded`, we look up the previous
 * snapshot for the same source. If the prior state was anything other
 * than `degraded` (i.e. healthy → degraded, unknown → degraded, etc.) we
 * fan out a notification to every admin in the org, throttled to once
 * per source per 24h via a lookup against the notifications feed.
 *
 * Called from `/api/admin/integrations/health` right after the new
 * snapshot row is persisted so it sees both rows in the same DB call.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../storage";
import { storage } from "../storage";
import {
  notifications,
  users,
} from "@shared/schema";
import type { IntegrationHealthSnapshot } from "./probeRegistry";

const NOTIFICATION_TYPE = "integration_degraded";
const THROTTLE_MS = 24 * 60 * 60 * 1000;

const SOURCE_LABEL: Record<string, string> = {
  sonar: "FreightWaves SONAR",
  graph: "Microsoft Graph (Outlook)",
  webex: "Webex Calling",
  zoominfo: "ZoomInfo",
  onedrive: "OneDrive",
  trac: "FreightWaves TRAC",
  stripe: "Stripe",
};

interface MaybeProbeShape {
  source: string;
  healthState: string;
  lastErrorMessage?: string | null;
}

export interface NotifyOptions {
  /**
   * Restrict the admin fanout to this organization. Required to prevent
   * cross-tenant alert leakage — the admin who triggered the refresh
   * passes their own `organizationId` here.
   */
  organizationId: string;
}

/**
 * Notify admins on the first time *this org* observes a degraded snapshot
 * for any source in the supplied batch (within a rolling 24h window).
 * Returns the source ids that triggered a notification (mainly for tests
 * / debugging). Safe to call repeatedly — the throttle prevents duplicate
 * notifications.
 *
 * Why no global "transition" check: the `integration_health_snapshots`
 * table is global (the integrations themselves are global — one SONAR
 * account, one Stripe account). When org A polls and inserts a degraded
 * row, then org B polls 5 minutes later and inserts another degraded
 * row, a "previous row was non-degraded" check would always be false
 * for org B and silently suppress its alert. Instead, we let the per-org
 * 24h throttle (`wasNotifiedRecently`) carry the "first time" semantics —
 * which is exactly what the user-facing notification feed needs anyway.
 *
 * Race-safe: the per-source throttle check + fanout runs inside a single
 * transaction holding a postgres advisory lock keyed on `(orgId, source)`,
 * so two concurrent admin refreshes from the same org cannot both pass
 * the throttle.
 */
export async function notifyOnFirstTimeDegraded(
  snapshots: ReadonlyArray<IntegrationHealthSnapshot | MaybeProbeShape>,
  opts: NotifyOptions,
): Promise<string[]> {
  const fired: string[] = [];
  const orgId = opts.organizationId;

  for (const snap of snapshots) {
    if (snap.healthState !== "degraded") continue;
    try {
      const didFire = await db.transaction(async (tx) => {
        // Per-(org, source) advisory lock — serializes concurrent fanouts
        // so the throttle window check is race-safe.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`integration-degraded:${orgId}:${snap.source}`}))`);
        const recent = await wasNotifiedRecently(snap.source, orgId, tx);
        if (recent) return false;
        await fanOutToAdmins(snap.source, snap.lastErrorMessage ?? null, orgId, tx);
        return true;
      });
      if (didFire) fired.push(snap.source);
    } catch (err) {
      console.warn(
        `[integration-degraded-notifier] failed for ${snap.source}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return fired;
}

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function wasNotifiedRecently(source: string, organizationId: string, tx: TxLike): Promise<boolean> {
  const cutoff = new Date(Date.now() - THROTTLE_MS);
  // Scope the throttle check to admins in this organization. We avoid
  // suppressing alerts for a different tenant that hasn't been notified
  // yet just because some unrelated org was already alerted.
  const [row] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(
      eq(notifications.type, NOTIFICATION_TYPE),
      eq(notifications.relatedId, source),
      eq(users.organizationId, organizationId),
      gte(notifications.createdAt, cutoff),
    ))
    .limit(1);
  return !!row;
}

async function fanOutToAdmins(
  source: string,
  errorMessage: string | null,
  organizationId: string,
  tx: TxLike,
): Promise<void> {
  // Scope to admins in the same organization as the requester. This prevents
  // cross-tenant alert leakage in multi-tenant deployments.
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.organizationId, organizationId)));
  if (admins.length === 0) return;

  const label = SOURCE_LABEL[source] ?? source;
  const title = `${label} integration degraded`;
  const body = errorMessage
    ? `Last error: ${errorMessage.slice(0, 280)}`
    : "Numbers in dependent surfaces may be stale until this clears.";

  // Note: storage.createNotification() runs on the base db connection, not the
  // transaction. That's acceptable here because the advisory lock guards the
  // critical section against concurrent fanouts; the throttle row check (which
  // runs inside this tx) is what we need to be race-safe.
  for (const admin of admins) {
    await storage.createNotification({
      userId: admin.id,
      type: NOTIFICATION_TYPE,
      title,
      body,
      link: "/admin/integrations-health",
      relatedId: source,
    });
  }
}

// Exposes the underlying SQL fragment for tests that need to reset state.
export const _internals = { NOTIFICATION_TYPE, THROTTLE_MS, sql };
