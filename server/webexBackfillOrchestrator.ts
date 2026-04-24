/**
 * Auto-trigger Webex backfill on (re)connect (Task #466).
 *
 * Kicks off org-level CDR attribution backfill out to the maximum Webex
 * retention window (~395 days), plus snapshot-style pulls for workspaces,
 * locations, devices, call queues, and hunt groups. Each data source has
 * its own row in `webex_sync_state` so progress survives restarts and the
 * admin Webex Health panel can show what's stale.
 *
 * Fire-and-forget from the OAuth callback — the function never throws.
 */
import { storage } from "./storage";
import {
  listWebexDevices,
  listWebexWorkspaces,
  listWebexLocations,
  listWebexCallQueues,
  listWebexHuntGroups,
  hasWebexTokens,
  webexNeedsReauth,
} from "./webexService";
import { backfillWebexAttribution } from "./webexAttributionBackfill";
import type { InsertWebexInventory } from "@shared/schema";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex-backfill-orchestrator] ${msg}`);
}

/** ~13 months — Webex CDR retention ceiling. */
export const MAX_BACKFILL_DAYS = 395;

const _running = new Set<string>();

async function recordSuccess(orgId: string, dataSource: string) {
  await storage.upsertWebexSyncState({
    orgId,
    userId: null,
    dataSource,
    lastSuccessAt: new Date(),
    lastAttemptAt: new Date(),
    lastErrorAt: null,
    lastError: null,
    backfillCompletedAt: new Date(),
  });
}

async function recordError(orgId: string, dataSource: string, err: string) {
  await storage.upsertWebexSyncState({
    orgId,
    userId: null,
    dataSource,
    lastAttemptAt: new Date(),
    lastErrorAt: new Date(),
    lastError: err.slice(0, 1000),
  });
}

async function snapshotInventory(
  orgId: string,
  kind: string,
  fetcher: () => Promise<{ items: any[]; lastError: string | null }>,
) {
  try {
    const { items, lastError } = await fetcher();
    if (lastError && items.length === 0) {
      await recordError(orgId, kind, lastError);
      return;
    }
    const rows: InsertWebexInventory[] = items.map(it => ({
      orgId,
      kind,
      externalId: String(it.id ?? it.uuid ?? `${kind}-${Math.random().toString(36).slice(2)}`),
      name: it.displayName ?? it.name ?? null,
      payload: it as any,
    }));
    await storage.upsertWebexInventoryItems(rows);
    await recordSuccess(orgId, kind);
    log(`snapshot ${kind} → ${rows.length} for org=${orgId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordError(orgId, kind, msg);
    log(`snapshot ${kind} failed: ${msg}`);
  }
}

/**
 * Fire off the full backfill set for an org. Safe to call multiple times —
 * a per-org reentrancy guard prevents double-running. Awaits nothing for
 * the caller (returns immediately after kicking off the background work).
 */
export function kickOffOrgBackfill(orgId: string, daysBack: number = MAX_BACKFILL_DAYS): void {
  if (!orgId) return;
  if (_running.has(orgId)) {
    log(`backfill already running for org=${orgId} — skipping duplicate`);
    return;
  }
  if (!hasWebexTokens() || webexNeedsReauth()) {
    log(`backfill skipped for org=${orgId} — no usable org token (needs reauth)`);
    return;
  }
  _running.add(orgId);

  const days = Math.max(1, Math.min(MAX_BACKFILL_DAYS, Math.floor(daysBack) || MAX_BACKFILL_DAYS));

  void (async () => {
    try {
      log(`Starting full backfill for org=${orgId} (daysBack=${days})`);

      // Snapshot inventory in parallel — each pulls from independent endpoints.
      await Promise.allSettled([
        snapshotInventory(orgId, "device", () => listWebexDevices().then(items => ({ items, lastError: null }))),
        snapshotInventory(orgId, "workspace", () => listWebexWorkspaces()),
        snapshotInventory(orgId, "location", () => listWebexLocations()),
        snapshotInventory(orgId, "call_queue", () => listWebexCallQueues()),
        snapshotInventory(orgId, "hunt_group", () => listWebexHuntGroups()),
      ]);

      // CDR attribution backfill last — it's the longest-running.
      await storage.upsertWebexSyncState({
        orgId,
        userId: null,
        dataSource: "cdr_history",
        lastAttemptAt: new Date(),
        backfillStartedAt: new Date(),
        backfillTotalDays: days,
      });
      try {
        const result = await backfillWebexAttribution(orgId, days);
        await storage.upsertWebexSyncState({
          orgId,
          userId: null,
          dataSource: "cdr_history",
          lastSuccessAt: new Date(),
          lastAttemptAt: new Date(),
          backfillCompletedAt: new Date(),
          backfillCompletedDays: days,
          lastError: null,
          lastErrorAt: null,
        });
        log(`CDR backfill done for org=${orgId}: ${JSON.stringify({
          touchpointsBackfilled: result.touchpointsBackfilled ?? 0,
          chunkFetches: result.chunkFetches,
        })}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordError(orgId, "cdr_history", msg);
        log(`CDR backfill failed for org=${orgId}: ${msg}`);
      }
    } finally {
      _running.delete(orgId);
    }
  })();
}
