/**
 * Personal Library indexer. Wraps inserts into `library_items` with embedding
 * generation so the retrieval layer can find them. Falls back to a row without
 * an embedding when embeddings are unavailable — the row is still searchable
 * by listing/filtering, just not by semantic recall.
 */
import { sql } from "drizzle-orm";
import { db } from "../storage";
import { embed } from "./memory";

export type LibraryKind = "memory" | "file" | "thread" | "fact";

export interface AddLibraryItemArgs {
  organizationId: string;
  userId: string;
  kind: LibraryKind;
  title: string;
  body?: string | null;
  sourceId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function addLibraryItem(args: AddLibraryItemArgs): Promise<string> {
  const blob = `${args.title}\n\n${args.body ?? ""}`.trim();
  const vec = blob ? await embed(blob) : null;
  const literal = vec ? `[${vec.join(",")}]` : null;
  const meta = args.metadata ? JSON.stringify(args.metadata) : null;
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO library_items (organization_id, user_id, kind, source_id, title, body, embedding, metadata)
    VALUES (
      ${args.organizationId}, ${args.userId}, ${args.kind}, ${args.sourceId ?? null},
      ${args.title}, ${args.body ?? null},
      ${literal ? sql`${literal}::vector` : sql`NULL`},
      ${meta ? sql`${meta}::jsonb` : sql`NULL`}
    )
    RETURNING id
  `);
  return result.rows[0]?.id ?? "";
}

export async function listLibraryItems(userId: string): Promise<Array<{
  id: string; kind: string; title: string; body: string | null; createdAt: string;
  metadata: Record<string, unknown> | null;
}>> {
  const rows = await db.execute<{
    id: string; kind: string; title: string; body: string | null;
    created_at: Date; metadata: Record<string, unknown> | null;
  }>(sql`
    SELECT id, kind, title, body, created_at::timestamp AS created_at, metadata
    FROM library_items WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 500
  `);
  return rows.rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body,
    createdAt: new Date(r.created_at).toISOString(), metadata: r.metadata,
  }));
}

export async function deleteLibraryItem(userId: string, itemId: string): Promise<boolean> {
  const result = await db.execute(sql`
    DELETE FROM library_items WHERE id = ${itemId} AND user_id = ${userId}
  `);
  return (result.rowCount ?? 0) > 0;
}
