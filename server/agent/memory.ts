import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../storage";
import { agentMemories, agentFacts, type AgentFact } from "@shared/schema";
import { getAgentOpenAI, AGENT_MODELS } from "./openai";

const EMBED_DIM = 1536;

/**
 * Embed a piece of text with text-embedding-3-small. Returns null on failure
 * — callers fall back to text search.
 */
export async function embed(text: string): Promise<number[] | null> {
  const trimmed = text.trim().slice(0, 8000);
  if (!trimmed) return null;
  try {
    const client = getAgentOpenAI();
    const resp = await client.embeddings.create({
      model: AGENT_MODELS.embedding,
      input: trimmed,
    });
    const v = resp.data[0]?.embedding;
    if (!Array.isArray(v) || v.length !== EMBED_DIM) return null;
    return v;
  } catch {
    return null;
  }
}

export interface MemoryHit {
  id: string;
  content: string;
  kind: string;
  importance: number;
  relatedCompanyId: string | null;
  similarity: number | null;
  createdAt: string;
}

/**
 * Top-k memory retrieval for a rep. Tries pgvector cosine similarity first;
 * falls back to recency-ordered text matches if embedding fails.
 */
export async function searchMemories(userId: string, query: string, limit = 5): Promise<MemoryHit[]> {
  const vec = await embed(query);

  if (vec) {
    try {
      const literal = `[${vec.join(",")}]`;
      const rows = await db.execute<{
        id: string; content: string; kind: string; importance: number;
        related_company_id: string | null; created_at: Date;
        similarity: number;
      }>(sql`
        SELECT id, content, kind, importance, related_company_id, created_at,
               1 - (embedding <=> ${literal}::vector) AS similarity
        FROM agent_memories
        WHERE user_id = ${userId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${limit}
      `);
      return rows.rows.map((r) => ({
        id: r.id, content: r.content, kind: r.kind, importance: r.importance,
        relatedCompanyId: r.related_company_id,
        similarity: typeof r.similarity === "number" ? r.similarity : null,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    } catch (err) {
      console.warn("[agent.memory] pgvector search failed, falling back to recency:", err);
      // Fall through to recency-based fallback below.
    }
  }

  // Fallback: recent + naive ILIKE on the most distinctive query word.
  const word = query.split(/\s+/).filter((w) => w.length > 3)[0] ?? "";
  const rows = await db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.userId, userId))
    .orderBy(desc(agentMemories.createdAt))
    .limit(limit * 4);
  const filtered = word
    ? rows.filter((r) => r.content.toLowerCase().includes(word.toLowerCase()))
    : rows;
  return filtered.slice(0, limit).map((r) => ({
    id: r.id, content: r.content, kind: r.kind, importance: r.importance,
    relatedCompanyId: r.relatedCompanyId,
    similarity: null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}

export interface SaveMemoryArgs {
  organizationId: string;
  userId: string;
  content: string;
  kind?: "episodic" | "decision" | "preference" | "outcome";
  relatedCompanyId?: string | null;
  relatedContactId?: string | null;
  importance?: number;
}

export async function saveMemory(args: SaveMemoryArgs): Promise<string> {
  const vec = await embed(args.content);
  if (vec) {
    try {
      const literal = `[${vec.join(",")}]`;
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO agent_memories (organization_id, user_id, kind, content, embedding, related_company_id, related_contact_id, importance)
        VALUES (${args.organizationId}, ${args.userId}, ${args.kind ?? "episodic"}, ${args.content}, ${literal}::vector,
                ${args.relatedCompanyId ?? null}, ${args.relatedContactId ?? null}, ${args.importance ?? 1})
        RETURNING id
      `);
      return result.rows[0]?.id ?? "";
    } catch (err) {
      console.warn("[agent.memory] pgvector insert failed, saving without embedding:", err);
      // Fall through to non-vector insert below.
    }
  }
  const [row] = await db.insert(agentMemories).values({
    organizationId: args.organizationId,
    userId: args.userId,
    kind: args.kind ?? "episodic",
    content: args.content,
    relatedCompanyId: args.relatedCompanyId ?? null,
    relatedContactId: args.relatedContactId ?? null,
    importance: args.importance ?? 1,
  }).returning({ id: agentMemories.id });
  return row?.id ?? "";
}

export async function deleteMemory(userId: string, memoryId: string): Promise<boolean> {
  const result = await db
    .delete(agentMemories)
    .where(and(eq(agentMemories.id, memoryId), eq(agentMemories.userId, userId)))
    .returning({ id: agentMemories.id });
  return result.length > 0;
}

export async function listFacts(userId: string): Promise<AgentFact[]> {
  return db
    .select()
    .from(agentFacts)
    .where(eq(agentFacts.userId, userId))
    .orderBy(desc(agentFacts.pinned), desc(agentFacts.createdAt));
}

export async function addFact(args: { organizationId: string; userId: string; fact: string; pinned?: boolean; source?: string }): Promise<AgentFact> {
  const [row] = await db.insert(agentFacts).values({
    organizationId: args.organizationId,
    userId: args.userId,
    fact: args.fact,
    pinned: args.pinned ?? false,
    source: args.source ?? "rep",
  }).returning();
  return row;
}

export async function deleteFact(userId: string, factId: string): Promise<boolean> {
  const result = await db
    .delete(agentFacts)
    .where(and(eq(agentFacts.id, factId), eq(agentFacts.userId, userId)))
    .returning({ id: agentFacts.id });
  return result.length > 0;
}
