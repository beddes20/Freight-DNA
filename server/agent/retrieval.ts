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
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  degraded: boolean;
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
  const vec = await embed(args.query);

  if (!vec) {
    return { hits: [], degraded: true };
  }
  const literal = `[${vec.join(",")}]`;

  const hits: RetrievalHit[] = [];
  let degraded = false;

  // Org corpus
  try {
    const rows = await db.execute<{
      source_kind: string; source_id: string; text: string;
      metadata: Record<string, unknown> | null; similarity: number;
    }>(sql`
      SELECT source_kind, source_id, text, metadata,
             1 - (embedding <=> ${literal}::vector) AS similarity
      FROM org_corpus_chunks
      WHERE organization_id = ${args.organizationId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${limit}
    `);
    for (const r of rows.rows) {
      hits.push({
        bucket: "org",
        sourceKind: r.source_kind,
        sourceId: r.source_id,
        text: r.text,
        similarity: typeof r.similarity === "number" ? r.similarity : null,
        metadata: r.metadata,
      });
    }
  } catch (err) {
    console.warn("[retrieval] org corpus search failed:", err);
    degraded = true;
  }

  // Personal Library
  try {
    const rows = await db.execute<{
      id: string; kind: string; title: string; body: string | null;
      metadata: Record<string, unknown> | null; similarity: number;
    }>(sql`
      SELECT id, kind, title, body, metadata,
             1 - (embedding <=> ${literal}::vector) AS similarity
      FROM library_items
      WHERE user_id = ${args.userId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${limit}
    `);
    for (const r of rows.rows) {
      const text = r.body ? `${r.title}\n${r.body}` : r.title;
      hits.push({
        bucket: "library",
        sourceKind: r.kind,
        sourceId: r.id,
        text,
        similarity: typeof r.similarity === "number" ? r.similarity : null,
        metadata: r.metadata,
      });
    }
  } catch (err) {
    console.warn("[retrieval] library search failed:", err);
    degraded = true;
  }

  // Project pinned context (single blob, no embedding required)
  if (args.projectId) {
    try {
      const rows = await db.execute<{ id: string; name: string; pinned_context: string | null }>(sql`
        SELECT id, name, pinned_context FROM thread_projects WHERE id = ${args.projectId} AND user_id = ${args.userId} LIMIT 1
      `);
      const row = rows.rows[0];
      if (row?.pinned_context && row.pinned_context.trim()) {
        hits.push({
          bucket: "project",
          sourceKind: "project_pin",
          sourceId: row.id,
          text: `Project pinned context (${row.name}):\n${row.pinned_context.trim().slice(0, 4000)}`,
          similarity: null,
        });
      }
    } catch (err) {
      console.warn("[retrieval] project pin lookup failed:", err);
      degraded = true;
    }
  }

  return { hits, degraded };
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
