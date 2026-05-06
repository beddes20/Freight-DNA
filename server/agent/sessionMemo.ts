/**
 * Per-conversation entity memo for the DNA Copilot.
 *
 * Tracks the entities (companies, carriers, lanes, etc.) referenced during a
 * conversation so the router can resolve "the first one", "that carrier", or
 * "summarize it" without an LLM round-trip. In-memory only — light footprint
 * per conversation, evicted when the process recycles.
 */

export type EntityType = "company" | "carrier" | "lane" | "rfp" | "task" | "contact" | "prospect";

export interface MemoEntity {
  type: EntityType;
  id: string;
  name: string;
  lastMentionedAt: number;
  /** Optional ordinal — useful for "the first one" / "the second" references. */
  rank?: number;
}

interface ConvoMemo {
  entities: MemoEntity[];
  updatedAt: number;
}

const STORE = new Map<string, ConvoMemo>();
const MAX_ENTITIES_PER_CONVO = 12;
const TTL_MS = 1000 * 60 * 60 * 4; // 4 hours

function gc() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of STORE) {
    if (v.updatedAt < cutoff) STORE.delete(k);
  }
}

export function getMemo(convoRef: string | null): MemoEntity[] {
  if (!convoRef) return [];
  return STORE.get(convoRef)?.entities ?? [];
}

export function rememberEntity(convoRef: string | null, entity: Omit<MemoEntity, "lastMentionedAt">) {
  if (!convoRef) return;
  const memo = STORE.get(convoRef) ?? { entities: [], updatedAt: Date.now() };
  // De-dupe by (type,id) — push to front.
  memo.entities = memo.entities.filter((e) => !(e.type === entity.type && e.id === entity.id));
  memo.entities.unshift({ ...entity, lastMentionedAt: Date.now() });
  if (memo.entities.length > MAX_ENTITIES_PER_CONVO) memo.entities.length = MAX_ENTITIES_PER_CONVO;
  memo.updatedAt = Date.now();
  STORE.set(convoRef, memo);
  if (Math.random() < 0.05) gc();
}

export function rememberMany(convoRef: string | null, entities: Array<Omit<MemoEntity, "lastMentionedAt">>) {
  // Reverse so the first entity ends up at the front (most recent).
  for (let i = entities.length - 1; i >= 0; i--) rememberEntity(convoRef, entities[i]);
}

const ORDINAL_MAP: Record<string, number> = {
  first: 0, "1st": 0, one: 0, "#1": 0,
  second: 1, "2nd": 1, two: 1, "#2": 1,
  third: 2, "3rd": 2, three: 2, "#3": 2,
  fourth: 3, "4th": 3, four: 3,
  last: -1, latest: -1, recent: -1,
};

/**
 * Try to resolve a reference like "the first one", "that carrier", "it" against
 * the memo. Returns the matched entity or null. Caller decides whether to use
 * it (router uses it deterministically; LLM gets it as a context hint).
 */
export function resolveReference(convoRef: string | null, message: string): MemoEntity | null {
  const memo = getMemo(convoRef);
  if (!memo.length) return null;
  const lower = message.toLowerCase().trim();

  // Type-prefixed reference: "that carrier" / "this account"
  const typeMatch = lower.match(/(?:that|this|the)\s+(carrier|company|account|lane|rfp|task|contact|prospect)/);
  if (typeMatch) {
    const wanted = typeMatch[1] === "account" ? "company" : (typeMatch[1] as EntityType);
    return memo.find((e) => e.type === wanted) ?? null;
  }

  // Ordinal: "the first one", "the second"
  const ordinalMatch = lower.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th|one|two|three|four|#1|#2|#3|last|latest)\b/);
  if (ordinalMatch && /\b(one|it|that|this)\b/.test(lower) === false) {
    const ord = ORDINAL_MAP[ordinalMatch[1]];
    if (ord === -1) return memo[0];
    // Prefer entities that carry an explicit rank (search results), else fall
    // back to insertion order.
    const ranked = memo.filter((e) => typeof e.rank === "number").sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    if (ranked.length > ord) return ranked[ord];
    if (memo.length > ord) return memo[ord];
  }

  // Plain pronoun ("it", "they", "them") with no other entity name in the
  // message → most-recent entity.
  if (/^(it|that|this|them|they|those)[\s,.?!]/.test(lower) || /\b(summarize|tell me about) (it|that|this)\b/.test(lower)) {
    return memo[0];
  }

  return null;
}

export function clearMemo(convoRef: string | null) {
  if (!convoRef) return;
  STORE.delete(convoRef);
}
