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

async function fetchEmailBodyRows(orgId: string): Promise<SourceRow[]> {
  // Rolling 30-day window of customer email bodies. We index inbound mail
  // linked to a customer account so the agent can recall recent thread
  // content during retrieval.
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = await db.execute<{
    id: string; subject: string | null; body: string | null;
    from_email: string | null; created_at: Date;
    linked_account_id: string | null;
  }>(sql`
    SELECT id, subject, body, from_email, created_at::timestamp AS created_at, linked_account_id
    FROM email_messages
    WHERE org_id = ${orgId}
      AND linked_account_id IS NOT NULL
      AND body IS NOT NULL
      AND created_at >= ${since}::timestamp
    ORDER BY created_at DESC LIMIT 1500
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows
    .filter((e) => (e.body ?? "").trim().length > 0)
    .map((e) => ({
      sourceKind: "email_body",
      sourceId: e.id,
      text: `Email (${new Date(e.created_at).toISOString().slice(0, 10)}, from ${e.from_email ?? "?"}): ${e.subject ?? "(no subject)"}\n${(e.body ?? "").slice(0, 2400)}`,
      metadata: { companyId: e.linked_account_id },
    }));
}

async function fetchNbaCardRows(orgId: string): Promise<SourceRow[]> {
  // Active/recent NBA card narratives — the why/suggested-action pairing is
  // the most retrieval-worthy "what should I do" surface in the system.
  const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const rows = await db.execute<{
    id: string; rule_type: string; company_id: string | null; company_name: string | null;
    why_this_now: string; suggested_action: string; expected_outcome: string;
    urgency_score: number; status: string; created_at: string;
  }>(sql`
    SELECT id, rule_type, company_id, company_name, why_this_now, suggested_action,
           expected_outcome, urgency_score, status, created_at
    FROM nba_cards
    WHERE org_id = ${orgId}
      AND created_at >= ${since}
    ORDER BY urgency_score DESC, created_at DESC LIMIT 800
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows.map((c) => ({
    sourceKind: "nba_card",
    sourceId: c.id,
    text: `NBA card [${c.rule_type}, urgency ${c.urgency_score}, status ${c.status}] ${c.company_name ?? ""}\nWhy: ${c.why_this_now}\nSuggested: ${c.suggested_action}\nExpected: ${c.expected_outcome}`,
    metadata: { companyId: c.company_id, ruleType: c.rule_type },
  }));
}

async function fetchPipelineNoteRows(orgId: string): Promise<SourceRow[]> {
  // Pipeline notes: prospect-level narrative + per-opportunity notes. Both
  // tables are scoped to organization_id so the join is just a filter.
  const prospectRows = await db.execute<{
    id: number; name: string; stage: string;
    notes: string | null; next_steps: string | null;
    pain_points: string | null; opportunity_notes: string | null;
    intel_brief: string | null;
  }>(sql`
    SELECT id, name, stage, notes, next_steps, pain_points, opportunity_notes, intel_brief
    FROM prospects WHERE organization_id = ${orgId}
    ORDER BY updated_at DESC LIMIT 1500
  `).catch(() => ({ rows: [] as any[] }));
  const fromProspects: SourceRow[] = prospectRows.rows
    .map((p) => {
      const parts = [
        `Prospect ${p.name} — stage ${p.stage}`,
        p.notes ? `Notes: ${p.notes}` : "",
        p.next_steps ? `Next steps: ${p.next_steps}` : "",
        p.pain_points ? `Pain points: ${p.pain_points}` : "",
        p.opportunity_notes ? `Opportunity: ${p.opportunity_notes}` : "",
        p.intel_brief ? `Intel: ${p.intel_brief}` : "",
      ].filter(Boolean);
      return parts.length > 1
        ? { sourceKind: "pipeline_note", sourceId: `prospect-${p.id}`, text: parts.join("\n").slice(0, 4000) }
        : null;
    })
    .filter((r): r is SourceRow => r !== null);

  const oppRows = await db.execute<{
    id: number; name: string; stage: string; notes: string | null;
    lost_reason: string | null; outcome: string | null; company_id: string | null;
  }>(sql`
    SELECT id, name, stage, notes, lost_reason, outcome, company_id
    FROM crm_opportunities WHERE organization_id = ${orgId}
      AND (notes IS NOT NULL OR lost_reason IS NOT NULL)
    ORDER BY updated_at DESC LIMIT 1500
  `).catch(() => ({ rows: [] as any[] }));
  const fromOpps: SourceRow[] = oppRows.rows.map((o) => ({
    sourceKind: "pipeline_note",
    sourceId: `opportunity-${o.id}`,
    text: `Opportunity ${o.name} — stage ${o.stage}${o.outcome ? ` (${o.outcome})` : ""}\n${o.notes ?? ""}${o.lost_reason ? `\nLost reason: ${o.lost_reason}` : ""}`.slice(0, 4000),
    metadata: { companyId: o.company_id },
  }));
  return [...fromProspects, ...fromOpps];
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

async function fetchDocumentPageRows(orgId: string): Promise<SourceRow[]> {
  // Index a chunked excerpt per page. We cap text length and total rows so the
  // indexer stays bounded — full-doc retrieval still happens via find_documents
  // + the document_pages table directly. Skip non-parsed pages.
  const rows = await db.execute<{
    document_id: string;
    page_number: number;
    text: string | null;
    filename: string;
    class_label: string;
  }>(sql`
    SELECT dp.document_id, dp.page_number, dp.text, d.filename, d.class_label
    FROM document_pages dp
    INNER JOIN documents d ON d.id = dp.document_id
    WHERE d.organization_id = ${orgId}
      AND d.status = 'parsed'
      AND dp.text IS NOT NULL
      AND length(dp.text) > 40
    ORDER BY d.created_at DESC
    LIMIT 1000
  `).catch(() => ({ rows: [] as any[] }));
  return rows.rows.map((r) => ({
    sourceKind: "document_page",
    sourceId: `${r.document_id}:${r.page_number}`,
    text: `Document "${r.filename}" (${r.class_label}) page ${r.page_number}: ${(r.text ?? "").slice(0, 1500)}`,
    metadata: { documentId: r.document_id, pageNumber: r.page_number, classLabel: r.class_label, filename: r.filename },
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
  // Phase 2 — Data & Tools Expansion (Task #422)
  fetchEmailBodyRows,
  fetchNbaCardRows,
  fetchPipelineNoteRows,
  // Phase 2 slice 1 — Copilot Doc Ingestion (Task #910)
  fetchDocumentPageRows,
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
