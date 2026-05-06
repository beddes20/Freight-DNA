/**
 * ValueIQ retrieval layer.
 *
 * Single entry point `retrieveContext()` that returns top-k chunks from:
 *   - the org corpus (auto-indexed CRM data)
 *   - the user's personal Library
 *   - the active project's pinned context (if any)
 *
 * Bounded per bucket, de-dup'd by source key, fail-open when embeddings or
 * pgvector are unavailable. Callers receive a flat list of `RetrievalHit`
 * plus a `degraded` flag so the UI/agent can warn the rep.
 */
import { sql } from "drizzle-orm";
import { db } from "../storage";
import { embed } from "./memory";

export interface RetrievalHit {
  bucket: "org" | "library" | "project";
  sourceKind: string;
  sourceId: string;
  text: string;
  similarity: number | null;
  metadata?: Record<string, unknown> | null;
  /** ISO timestamp of when the source content was last updated (org corpus) or created (library). */
  updatedAt?: string | null;
  /** Optional human-friendly title (library items expose this). */
  title?: string | null;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  degraded: boolean;
  /** Per-source breakdown so the UI can name *which* layer failed. */
  health?: {
    embedder: "ok" | "down";
    orgCorpus: "ok" | "down";
    library: "ok" | "down";
    project: "ok" | "down" | "n/a";
  };
}

export interface RetrievalArgs {
  organizationId: string;
  userId: string;
  query: string;
  projectId?: string | null;
  perBucket?: number;
}

const DEFAULT_PER_BUCKET = 6;

export async function retrieveContext(args: RetrievalArgs): Promise<RetrievalResult> {
  const limit = Math.min(Math.max(args.perBucket ?? DEFAULT_PER_BUCKET, 1), 12);

  // Skip embedding entirely for trivially small queries — saves a round trip
  // (and lets the rest of the envelope arrive sooner).
  const trimmed = args.query.trim();
  if (trimmed.length < 3) {
    return {
      hits: [],
      degraded: false,
      health: { embedder: "ok", orgCorpus: "ok", library: "ok", project: args.projectId ? "ok" : "n/a" },
    };
  }

  const vec = await embed(trimmed);

  if (!vec) {
    return {
      hits: [],
      degraded: true,
      health: { embedder: "down", orgCorpus: "down", library: "down", project: args.projectId ? "down" : "n/a" },
    };
  }
  const literal = `[${vec.join(",")}]`;

  // Run org corpus, personal library, and project pin lookups concurrently —
  // a slow library scan must not block org-corpus results, and vice versa.
  const orgPromise = (async () => {
    try {
      const rows = await db.execute<{
        source_kind: string; source_id: string; text: string;
        metadata: Record<string, unknown> | null; similarity: number;
        updated_at: string | Date | null;
      }>(sql`
        SELECT source_kind, source_id, text, metadata, updated_at,
               1 - (embedding <=> ${literal}::vector) AS similarity
        FROM org_corpus_chunks
        WHERE organization_id = ${args.organizationId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${limit}
      `);
      const hs: RetrievalHit[] = rows.rows.map((r) => ({
        bucket: "org" as const,
        sourceKind: r.source_kind,
        sourceId: r.source_id,
        text: r.text,
        similarity: typeof r.similarity === "number" ? r.similarity : null,
        metadata: r.metadata,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      }));
      return { ok: true, hits: hs };
    } catch (err) {
      console.warn("[retrieval] org corpus search failed:", err);
      return { ok: false, hits: [] as RetrievalHit[] };
    }
  })();

  const libPromise = (async () => {
    try {
      const rows = await db.execute<{
        id: string; kind: string; title: string; body: string | null;
        metadata: Record<string, unknown> | null; similarity: number;
        created_at: string | Date | null;
      }>(sql`
        SELECT id, kind, title, body, metadata, created_at,
               1 - (embedding <=> ${literal}::vector) AS similarity
        FROM library_items
        WHERE user_id = ${args.userId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${limit}
      `);
      const hs: RetrievalHit[] = rows.rows.map((r) => ({
        bucket: "library" as const,
        sourceKind: r.kind,
        sourceId: r.id,
        text: r.body ? `${r.title}\n${r.body}` : r.title,
        similarity: typeof r.similarity === "number" ? r.similarity : null,
        metadata: r.metadata,
        updatedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        title: r.title,
      }));
      return { ok: true, hits: hs };
    } catch (err) {
      console.warn("[retrieval] library search failed:", err);
      return { ok: false, hits: [] as RetrievalHit[] };
    }
  })();

  const projPromise = (async () => {
    if (!args.projectId) return { ok: true, hits: [] as RetrievalHit[], skipped: true };
    try {
      const rows = await db.execute<{ id: string; name: string; pinned_context: string | null; updated_at: string | Date | null }>(sql`
        SELECT id, name, pinned_context, updated_at FROM thread_projects WHERE id = ${args.projectId} AND user_id = ${args.userId} LIMIT 1
      `);
      const row = rows.rows[0];
      const hs: RetrievalHit[] = [];
      if (row?.pinned_context && row.pinned_context.trim()) {
        hs.push({
          bucket: "project",
          sourceKind: "project_pin",
          sourceId: row.id,
          text: `Project pinned context (${row.name}):\n${row.pinned_context.trim().slice(0, 4000)}`,
          similarity: null,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
          title: row.name,
        });
      }
      return { ok: true, hits: hs, skipped: false };
    } catch (err) {
      console.warn("[retrieval] project pin lookup failed:", err);
      return { ok: false, hits: [] as RetrievalHit[], skipped: false };
    }
  })();

  const [orgRes, libRes, projRes] = await Promise.all([orgPromise, libPromise, projPromise]);
  const hits: RetrievalHit[] = [...orgRes.hits, ...libRes.hits, ...projRes.hits];
  const health: NonNullable<RetrievalResult["health"]> = {
    embedder: "ok",
    orgCorpus: orgRes.ok ? "ok" : "down",
    library: libRes.ok ? "ok" : "down",
    project: !args.projectId ? "n/a" : (projRes.ok ? "ok" : "down"),
  };
  const degraded = !orgRes.ok || !libRes.ok || (!!args.projectId && !projRes.ok);

  // De-dup: collapse by (bucket, sourceKind, sourceId), keeping the
  // highest-similarity hit. Then collapse near-identical text bodies across
  // buckets by a stable signature (first 120 chars, lowercased, whitespace-normalized).
  const byKey = new Map<string, RetrievalHit>();
  for (const h of hits) {
    const k = `${h.bucket}::${h.sourceKind}::${h.sourceId}`;
    const prev = byKey.get(k);
    if (!prev || (h.similarity ?? 0) > (prev.similarity ?? 0)) byKey.set(k, h);
  }
  const bySig = new Map<string, RetrievalHit>();
  for (const h of byKey.values()) {
    const sig = h.text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
    const prev = bySig.get(sig);
    if (!prev || (h.similarity ?? 0) > (prev.similarity ?? 0)) bySig.set(sig, h);
  }
  const deduped = Array.from(bySig.values()).sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  return { hits: deduped, degraded, health };
}

export function formatHitsForPrompt(hits: RetrievalHit[], maxChars = 4000): string {
  if (!hits.length) return "";
  const lines: string[] = ["", "=== Retrieved context (use only if relevant) ==="];
  let used = 0;
  for (const h of hits) {
    const tag = h.bucket === "org"
      ? `[${h.sourceKind}]`
      : h.bucket === "library"
        ? `[library:${h.sourceKind}]`
        : `[project]`;
    const snippet = h.text.length > 600 ? h.text.slice(0, 600) + "…" : h.text;
    const block = `${tag} ${snippet}`;
    if (used + block.length > maxChars) break;
    lines.push("• " + block);
    used += block.length;
  }
  return lines.join("\n");
}
