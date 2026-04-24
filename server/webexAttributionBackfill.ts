import { and, eq, inArray, sql } from "drizzle-orm";
import { storage, db } from "./storage";
import { touchpoints, nbaCards, tasks } from "@shared/schema";
import type { Touchpoint, WebexUserMapping } from "@shared/schema";
import { fetchCallHistory } from "./webexService";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex-backfill] ${msg}`);
}

export interface BackfillCounts {
  scanned: number;
  reassigned: number;
  unchanged: number;
  noCdr: number;
  noMapping: number;
  ignored: number;
}

export interface BackfillTaskCounts {
  scanned: number;
  reassigned: number;
  unchanged: number;
  noMatchingTouchpoint: number;
}

export interface BackfillChunkStats {
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface BackfillResult {
  orgId: string;
  daysBack: number;
  cdrsScanned: number;
  chunkFetches: BackfillChunkStats;
  touchpoints: BackfillCounts;
  nbaCards: BackfillCounts;
  tasks: BackfillTaskCounts;
}

const DEFAULT_DAYS_BACK = 90;
const MAX_DAYS_BACK = 395; // ~13 months — Webex CDR retention ceiling (Task #466).

function buildLocalResolver(mappings: WebexUserMapping[]) {
  const byPerson = new Map<string, WebexUserMapping>();
  const byEmail = new Map<string, WebexUserMapping>();
  for (const m of mappings) {
    if (m.webexPersonId) byPerson.set(m.webexPersonId, m);
    if (m.webexEmail) byEmail.set(m.webexEmail.toLowerCase(), m);
  }
  return function resolve(
    webexPersonId: string | undefined,
    webexUserEmail: string | undefined,
  ): { userId: string | null; mapping: WebexUserMapping | null } {
    let mapping: WebexUserMapping | undefined;
    if (webexPersonId) mapping = byPerson.get(webexPersonId);
    if (!mapping && webexUserEmail) mapping = byEmail.get(webexUserEmail.toLowerCase());
    if (!mapping) return { userId: null, mapping: null };
    if (mapping.status !== "confirmed" && mapping.status !== "auto_matched") {
      return { userId: null, mapping };
    }
    return { userId: mapping.userId ?? null, mapping };
  };
}

async function buildCdrMap(
  daysBack: number,
): Promise<{
  cdrMap: Map<string, { webexPersonId?: string; webexUserEmail?: string }>;
  chunkFetches: BackfillChunkStats;
}> {
  const cdrMap = new Map<string, { webexPersonId?: string; webexUserEmail?: string }>();
  const chunkFetches: BackfillChunkStats = { attempted: 0, succeeded: 0, failed: 0 };
  const endMs = Date.now();
  const chunkHours = 24;
  const totalHours = daysBack * 24;
  for (let offset = 0; offset < totalHours; offset += chunkHours) {
    const chunkEndMs = endMs - offset * 3600_000;
    const chunkStartMs = chunkEndMs - chunkHours * 3600_000;
    chunkFetches.attempted++;
    try {
      const records = await fetchCallHistory(
        new Date(chunkStartMs).toISOString(),
        new Date(chunkEndMs).toISOString(),
        500,
      );
      for (const r of records) {
        if (r.id && !cdrMap.has(r.id)) {
          cdrMap.set(r.id, {
            webexPersonId: r.webexPersonId,
            webexUserEmail: r.webexUserEmail,
          });
        }
      }
      chunkFetches.succeeded++;
    } catch (err) {
      chunkFetches.failed++;
      log(`fetchCallHistory chunk failed (${new Date(chunkStartMs).toISOString()} → ${new Date(chunkEndMs).toISOString()}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { cdrMap, chunkFetches };
}

/**
 * Re-attribute previously-synced Webex touchpoints, missed-call NBA cards, and
 * auto-generated follow-up tasks to the internal user identified by the
 * current Webex → user mapping. Idempotent — rows already pointing at the
 * right user are left untouched, and `ignored` mappings never route activity.
 */
export async function backfillWebexAttribution(
  orgId: string,
  daysBack: number = DEFAULT_DAYS_BACK,
): Promise<BackfillResult> {
  const days = Math.max(1, Math.min(MAX_DAYS_BACK, Math.floor(daysBack) || DEFAULT_DAYS_BACK));
  log(`Starting backfill for org ${orgId} (daysBack=${days})`);

  const mappings = await storage.getWebexUserMappings(orgId);
  const resolve = buildLocalResolver(mappings);

  const { cdrMap, chunkFetches } = await buildCdrMap(days);
  log(
    `Loaded ${cdrMap.size} CDRs from Webex call history ` +
      `(chunks attempted=${chunkFetches.attempted}, succeeded=${chunkFetches.succeeded}, failed=${chunkFetches.failed})`,
  );

  // ── Touchpoints ─────────────────────────────────────────────────────────
  const tpCounts: BackfillCounts = { scanned: 0, reassigned: 0, unchanged: 0, noCdr: 0, noMapping: 0, ignored: 0 };
  const allOrgTouchpoints = await storage.getTouchpointsByOrg(orgId);
  const webexTouchpoints = allOrgTouchpoints.filter(
    t => t.type === "call" && t.notes && /\[Webex CDR: [^\]]+\]/.test(t.notes),
  );
  tpCounts.scanned = webexTouchpoints.length;

  const touchpointReassignments: Array<{ touchpoint: Touchpoint; newUserId: string }> = [];

  for (const tp of webexTouchpoints) {
    const m = tp.notes!.match(/\[Webex CDR: ([^\]]+)\]/);
    if (!m) { tpCounts.noCdr++; continue; }
    const cdrId = m[1];
    const cdr = cdrMap.get(cdrId);
    if (!cdr) { tpCounts.noCdr++; continue; }

    const resolved = resolve(cdr.webexPersonId, cdr.webexUserEmail);
    if (resolved.mapping?.status === "ignored") { tpCounts.ignored++; continue; }
    if (!resolved.userId) { tpCounts.noMapping++; continue; }
    if (resolved.userId === tp.loggedById) { tpCounts.unchanged++; continue; }

    await db.update(touchpoints).set({ loggedById: resolved.userId }).where(eq(touchpoints.id, tp.id));
    tpCounts.reassigned++;
    touchpointReassignments.push({ touchpoint: tp, newUserId: resolved.userId });
  }

  // ── Missed-call NBA cards ───────────────────────────────────────────────
  const cardCounts: BackfillCounts = { scanned: 0, reassigned: 0, unchanged: 0, noCdr: 0, noMapping: 0, ignored: 0 };
  const orgCards = await db
    .select()
    .from(nbaCards)
    .where(and(eq(nbaCards.orgId, orgId), eq(nbaCards.ruleType, "webex_missed_call")));
  cardCounts.scanned = orgCards.length;

  for (const card of orgCards) {
    const sigs = Array.isArray(card.signalSummary) ? card.signalSummary : [];
    let cdrId: string | null = null;
    for (const s of sigs) {
      const mm = typeof s === "string" ? s.match(/\[CDR:([^\]]+)\]/) : null;
      if (mm) { cdrId = mm[1]; break; }
    }
    if (!cdrId) { cardCounts.noCdr++; continue; }
    const cdr = cdrMap.get(cdrId);
    if (!cdr) { cardCounts.noCdr++; continue; }

    const resolved = resolve(cdr.webexPersonId, cdr.webexUserEmail);
    if (resolved.mapping?.status === "ignored") { cardCounts.ignored++; continue; }
    if (!resolved.userId) { cardCounts.noMapping++; continue; }
    if (resolved.userId === card.userId) { cardCounts.unchanged++; continue; }

    await db.update(nbaCards).set({ userId: resolved.userId }).where(eq(nbaCards.id, card.id));
    cardCounts.reassigned++;
  }

  // ── Auto follow-up tasks ────────────────────────────────────────────────
  // We can't match tasks to CDRs directly (they only reference contactId), so
  // we anchor each task to the nearest Webex touchpoint we just re-attributed
  // for the same contact, within a 10-minute window of createdAt.
  const taskCounts: BackfillTaskCounts = { scanned: 0, reassigned: 0, unchanged: 0, noMatchingTouchpoint: 0 };
  const contactIdsWithChanges = Array.from(
    new Set(
      touchpointReassignments
        .map(r => r.touchpoint.contactId)
        .filter((x): x is string => !!x),
    ),
  );

  if (contactIdsWithChanges.length > 0) {
    const autoTasks = await db
      .select()
      .from(tasks)
      .where(
        and(
          sql`${tasks.notes} LIKE 'Auto-created from Webex call with %'`,
          inArray(tasks.contactId, contactIdsWithChanges),
        ),
      );
    taskCounts.scanned = autoTasks.length;

    for (const task of autoTasks) {
      const candidates = touchpointReassignments.filter(
        r => r.touchpoint.contactId === task.contactId,
      );
      if (candidates.length === 0) { taskCounts.noMatchingTouchpoint++; continue; }

      const taskTs = new Date(task.createdAt).getTime();
      let best: { newUserId: string; diff: number } | null = null;
      for (const c of candidates) {
        const diff = Math.abs(new Date(c.touchpoint.createdAt).getTime() - taskTs);
        if (!best || diff < best.diff) best = { newUserId: c.newUserId, diff };
      }
      if (!best || best.diff > 10 * 60_000) { taskCounts.noMatchingTouchpoint++; continue; }

      if (task.assignedTo === best.newUserId && task.assignedBy === best.newUserId) {
        taskCounts.unchanged++;
        continue;
      }
      await db
        .update(tasks)
        .set({ assignedTo: best.newUserId, assignedBy: best.newUserId })
        .where(eq(tasks.id, task.id));
      taskCounts.reassigned++;
    }
  }

  const result: BackfillResult = {
    orgId,
    daysBack: days,
    cdrsScanned: cdrMap.size,
    chunkFetches,
    touchpoints: tpCounts,
    nbaCards: cardCounts,
    tasks: taskCounts,
  };

  log(
    `Backfill complete org=${orgId}: ` +
      `touchpoints reassigned=${tpCounts.reassigned}/${tpCounts.scanned} ` +
      `(unchanged=${tpCounts.unchanged}, noCdr=${tpCounts.noCdr}, noMapping=${tpCounts.noMapping}, ignored=${tpCounts.ignored}); ` +
      `nbaCards reassigned=${cardCounts.reassigned}/${cardCounts.scanned}; ` +
      `tasks reassigned=${taskCounts.reassigned}/${taskCounts.scanned}`,
  );

  return result;
}
