/**
 * Org corpus indexer.
 *
 * Walks each indexable source kind (companies, contacts, lanes, touchpoints,
 * RFPs, plays, proven_tactics, market_signals) and embeds a short summary text
 * into `org_corpus_chunks`. Designed to be safe to run repeatedly:
 *   - rows are upserted by (organization_id, source_kind, source_id, chunk_index)
 *   - missing sources cause that kind to be skipped, never crash
 *   - one row per source (chunk_index = 0) — keeps the table compact for MVP
 *
 * Exposes:
 *   - `indexOrg(orgId)` — full pass for one org
 *   - `indexAllOrgs()` — full pass for every org (used by nightly cron)
 *   - `enqueueRowChange(...)` — fire-and-forget incremental hook (best-effort)
 */
import { sql } from "drizzle-orm";
import { db } from "../storage";
import { embed } from "./memory";

type Sql = typeof sql;

interface SourceRow {
  sourceKind: string;
  sourceId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

async function fetchCompanyRows(orgId: string): Promise<SourceRow[]> {
  const rows = await db.execute<{
    id: string; name: string; industry: string | null;
    notes: string | null; account_summary: string | null;
    process_notes: string | null; account_quirks: string | null;
    tender_style: string | null; estimated_freight_spend: string | null;
  }>(sql`
    SELECT id, name, industry, notes, account_summary, process_notes,
           account_quirks, tender_style, estimated_freight_spend
    FROM companies WHERE organization_id = ${orgId} AND archived_at IS NULL
    LIMIT 5000
  `);
  return rows.rows.map((c) => {
    const parts = [
      `Company: ${c.name}${c.industry ? ` — ${c.industry}` : ""}`,
      c.account_summary ? `Summary: ${c.account_summary}` : "",
      c.tender_style ? `Tender style: ${c.tender_style}` : "",
      c.process_notes ? `Process: ${c.process_notes}` : "",
      c.account_quirks ? `Quirks: ${c.account_quirks}` : "",
      c.notes ? `Notes: ${c.notes}` : "",
      c.estimated_freight_spend ? `Est. freight spend: $${c.estimated_freight_spend}` : "",
    ].filter(Boolean);
    return {
      sourceKind: "company",
      sourceId: c.id,
      text: parts.join("\n").slice(0, 4000),
      metadata: { name: c.name },
    };
  });
}

async function fetchContactRows(orgId: string): Promise<SourceRow[]> {
  const rows = await db.execute<{
    id: string; name: string; title: string | null; email: string | null;
    company_id: string | null; company_name: string | null;
  }>(sql`
    SELECT c.id, c.name, c.title, c.email, c.company_id, co.name AS company_name
    FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
    WHERE co.organization_id = ${orgId} LIMIT 5000
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows.map((c) => ({
    sourceKind: "contact",
    sourceId: c.id,
    text: `Contact: ${c.name}${c.title ? ` (${c.title})` : ""}${c.company_name ? ` at ${c.company_name}` : ""}${c.email ? ` — ${c.email}` : ""}`,
    metadata: { companyId: c.company_id },
  }));
}

async function fetchLaneRows(orgId: string): Promise<SourceRow[]> {
  const rows = await db.execute<{
    id: string; origin_label: string | null; dest_label: string | null;
    mode: string | null; loads_30d: number | null; avg_carrier_pay: string | null;
    company_id: string | null;
  }>(sql`
    SELECT id, origin_label, dest_label, mode, loads_30d, avg_carrier_pay, company_id
    FROM lane_summary_cache
    WHERE organization_id = ${orgId}
    ORDER BY COALESCE(loads_30d, 0) DESC
    LIMIT 1500
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows.map((l) => ({
    sourceKind: "lane",
    sourceId: l.id,
    text: `Lane ${l.origin_label ?? "?"} → ${l.dest_label ?? "?"} (${l.mode ?? "Van"}). ${l.loads_30d ?? 0} loads/30d, avg carrier pay ${l.avg_carrier_pay ?? "n/a"}.`,
    metadata: { companyId: l.company_id },
  }));
}

async function fetchTouchpointRows(orgId: string): Promise<SourceRow[]> {
  const rows = await db.execute<{
    id: string; type: string | null; notes: string | null;
    company_id: string | null; created_at: Date;
  }>(sql`
    SELECT t.id, t.type, t.notes, t.company_id, t.created_at::timestamp AS created_at
    FROM touchpoints t JOIN companies co ON co.id = t.company_id
    WHERE co.organization_id = ${orgId} AND t.notes IS NOT NULL
    ORDER BY t.created_at DESC LIMIT 2000
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows.map((t) => ({
    sourceKind: "touchpoint",
    sourceId: t.id,
    text: `Touchpoint (${t.type ?? "note"}, ${new Date(t.created_at).toISOString().slice(0, 10)}): ${(t.notes ?? "").slice(0, 1500)}`,
    metadata: { companyId: t.company_id },
  }));
}

async function fetchPlayRows(orgId: string): Promise<SourceRow[]> {
  const rows = await db.execute<{ id: string; name: string; when_to_use: string; body: string }>(sql`
    SELECT p.id, p.name, p.when_to_use, p.body
    FROM agent_plays p JOIN agents a ON a.id = p.agent_id
    WHERE a.organization_id = ${orgId} AND p.enabled = true
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows.map((p) => ({
    sourceKind: "play",
    sourceId: p.id,
    text: `Play "${p.name}" — when: ${p.when_to_use}\n${p.body}`,
  }));
}

async function fetchProvenTacticRows(orgId: string): Promise<SourceRow[]> {
  const rows = await db.execute<{ id: string; signal_type: string | null; tactic_summary: string | null }>(sql`
    SELECT id, signal_type, tactic_summary FROM proven_tactics
    WHERE organization_id = ${orgId} LIMIT 500
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows
    .filter((r) => r.tactic_summary)
    .map((r) => ({
      sourceKind: "proven_tactic",
      sourceId: r.id,
      text: `Proven tactic for ${r.signal_type ?? "signal"}: ${r.tactic_summary}`,
    }));
}

async function fetchMarketSignalRows(orgId: string): Promise<SourceRow[]> {
  const rows = await db.execute<{ id: string; signal_type: string | null; explanation: string | null; created_at: Date }>(sql`
    SELECT id, signal_type, explanation, created_at::timestamp AS created_at FROM market_signals
    WHERE organization_id = ${orgId} ORDER BY created_at DESC LIMIT 200
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows
    .filter((r) => r.explanation)
    .map((r) => ({
      sourceKind: "market_signal",
      sourceId: r.id,
      text: `Market signal (${r.signal_type ?? "?"}, ${new Date(r.created_at).toISOString().slice(0, 10)}): ${r.explanation}`,
    }));
}

const FETCHERS: Array<(orgId: string) => Promise<SourceRow[]>> = [
  fetchCompanyRows,
  fetchContactRows,
  fetchLaneRows,
  fetchTouchpointRows,
  fetchPlayRows,
  fetchProvenTacticRows,
  fetchMarketSignalRows,
];

async function upsertChunk(orgId: string, row: SourceRow): Promise<boolean> {
  const trimmed = row.text.trim();
  if (!trimmed) return false;
  const vec = await embed(trimmed);
  const literal = vec ? `[${vec.join(",")}]` : null;
  const meta = row.metadata ? JSON.stringify(row.metadata) : null;
  try {
    await db.execute(sql`
      INSERT INTO org_corpus_chunks (organization_id, source_kind, source_id, chunk_index, text, embedding, metadata, updated_at)
      VALUES (${orgId}, ${row.sourceKind}, ${row.sourceId}, 0, ${trimmed}, ${literal ? sql`${literal}::vector` : sql`NULL`}, ${meta ? sql`${meta}::jsonb` : sql`NULL`}, now())
      ON CONFLICT (organization_id, source_kind, source_id, chunk_index)
      DO UPDATE SET text = EXCLUDED.text, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = now()
    `);
    return true;
  } catch (err) {
    console.warn(`[corpus] upsert ${row.sourceKind}:${row.sourceId} failed:`, err);
    return false;
  }
}

export async function indexOrg(orgId: string): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;
  for (const fetch of FETCHERS) {
    let rows: SourceRow[] = [];
    try {
      rows = await fetch(orgId);
    } catch (err) {
      console.warn(`[corpus] fetcher failed for org ${orgId}:`, err);
      continue;
    }
    for (const r of rows) {
      const ok = await upsertChunk(orgId, r);
      if (ok) written++;
      else skipped++;
    }
  }
  console.log(`[corpus] indexed org ${orgId}: ${written} written, ${skipped} skipped`);
  return { written, skipped };
}

export async function indexAllOrgs(): Promise<void> {
  const rows = await db.execute<{ id: string }>(sql`SELECT id FROM organizations`);
  for (const o of rows.rows) {
    try {
      await indexOrg(o.id);
    } catch (err) {
      console.error(`[corpus] indexOrg failed for ${o.id}:`, err);
    }
  }
}

// ── Incremental queue ────────────────────────────────────────────────────
// Lightweight in-process throttle. When a row changes, callers can drop a
// hint here and we re-embed within ~30s without blocking the request.
type QueueItem = { orgId: string; sourceKind: string; sourceId: string };
const queue: QueueItem[] = [];
let timer: NodeJS.Timeout | null = null;

export function enqueueRowChange(item: QueueItem) {
  if (queue.length > 500) return;
  queue.push(item);
  if (!timer) {
    timer = setTimeout(drainQueue, 30_000);
    timer.unref?.();
  }
}

async function drainQueue() {
  timer = null;
  const batch = queue.splice(0, 50);
  if (!batch.length) return;
  // Naive: re-fetch+upsert each row's parent kind. A real implementation would
  // selectively re-embed only the touched row; MVP pulls the whole table.
  const orgIds = Array.from(new Set(batch.map((b) => b.orgId)));
  for (const orgId of orgIds) {
    try {
      await indexOrg(orgId);
    } catch (err) {
      console.warn(`[corpus] incremental drain failed for org ${orgId}:`, err);
    }
  }
}
