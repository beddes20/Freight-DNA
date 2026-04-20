/**
 * Persona & playbook loader for the agent core.
 *
 * Resolves the live system prompt for a given agent + channel by stitching
 * together the active base persona, the channel-specific overlay (if any),
 * and any enabled named "plays". Falls back to a hardcoded default whenever
 * the database has no active row, so the bot never goes silent.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../storage";
import { agents, agentPersonas, agentPlays } from "@shared/schema";

export const DEFAULT_BASE_PERSONA = `You are DNA, an AI logistics employee inside the Freight DNA CRM at Value Truck. You are not "an assistant" — you are a colleague reps trust to help them move faster.

Style:
- Short and casual. Reps are busy. No filler, no corporate voice.
- Bullet points for lists, plain sentences otherwise.
- When data isn't available, just say so.

Operating rules:
- You have tools. Use them aggressively instead of guessing or asking clarifying questions you could answer yourself.
- For account questions, call get_company_details before answering.
- For "open / go to / show me X" requests, call navigate_to_company.
- For market / lane / rate questions, call the appropriate market tool.
- For tasks/touchpoints/notes the rep wants to write, call the corresponding write tool — it will surface a confirmation card to the rep automatically.
- If the rep tells you something worth remembering across sessions ("I always X", "moving forward Y", "remember Z"), call remember_this.
- If the rep references a prior conversation or decision, call recall_memory before answering.

Do not list every tool you have. Just use the right one and answer.`;

export type ChannelSlot = "base" | "in_app" | "email" | "sms_voice" | "teams";

const ALL_SLOTS: ChannelSlot[] = ["base", "in_app", "email", "sms_voice", "teams"];

export function isChannelSlot(value: string): value is ChannelSlot {
  return (ALL_SLOTS as string[]).includes(value);
}

export function listChannelSlots(): ChannelSlot[] {
  return [...ALL_SLOTS];
}

/** Map a runtime channel name onto the persona slot used in the DB. */
export function mapChannelToSlot(channel: string): ChannelSlot {
  if (channel === "sms" || channel === "voice") return "sms_voice";
  if (channel === "in_app" || channel === "email" || channel === "teams") return channel;
  return "base";
}

const PLAY_BUDGET_BYTES = 5000;
const CACHE_TTL_MS = 30_000;

type CacheEntry<T> = { value: T; ts: number };
const personaCache = new Map<string, CacheEntry<string | null>>();
const playsCache = new Map<string, CacheEntry<Array<{ name: string; whenToUse: string; body: string }>>>();
const agentIdCache = new Map<string, CacheEntry<string>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

export function invalidatePersonaCache(agentId?: string) {
  if (!agentId) {
    personaCache.clear();
    playsCache.clear();
    return;
  }
  for (const k of Array.from(personaCache.keys())) {
    if (k.startsWith(agentId + ":")) personaCache.delete(k);
  }
  playsCache.delete(agentId);
}

/** Get-or-create the org's default DNA agent, returning its id. */
export async function ensureDefaultAgent(organizationId: string): Promise<string> {
  const cached = cacheGet(agentIdCache, organizationId);
  if (cached) return cached;

  const [existing] = await db.select().from(agents)
    .where(and(eq(agents.organizationId, organizationId), eq(agents.slug, "dna")))
    .limit(1);
  if (existing) {
    agentIdCache.set(organizationId, { value: existing.id, ts: Date.now() });
    return existing.id;
  }

  const [created] = await db.insert(agents).values({
    organizationId,
    slug: "dna",
    name: "DNA",
    description: "DNA Logistics Bot — your AI freight desk colleague.",
    isDefault: true,
    status: "published",
  }).returning();
  agentIdCache.set(organizationId, { value: created.id, ts: Date.now() });
  return created.id;
}

/** Active persona body for (agentId, channel slot), or null if none saved. */
export async function getActivePersonaBody(agentId: string, channel: ChannelSlot): Promise<string | null> {
  const key = `${agentId}:${channel}`;
  const cached = cacheGet(personaCache, key);
  if (cached !== undefined) return cached;

  const [row] = await db.select({ body: agentPersonas.body }).from(agentPersonas)
    .where(and(
      eq(agentPersonas.agentId, agentId),
      eq(agentPersonas.channel, channel),
      eq(agentPersonas.isActive, true),
    ))
    .orderBy(desc(agentPersonas.version))
    .limit(1);
  const value = row?.body ?? null;
  personaCache.set(key, { value, ts: Date.now() });
  return value;
}

async function listEnabledPlays(agentId: string) {
  const cached = cacheGet(playsCache, agentId);
  if (cached) return cached;

  const rows = await db.select({
    name: agentPlays.name,
    whenToUse: agentPlays.whenToUse,
    body: agentPlays.body,
  })
    .from(agentPlays)
    .where(and(eq(agentPlays.agentId, agentId), eq(agentPlays.enabled, true)))
    .orderBy(agentPlays.sortOrder, agentPlays.createdAt);

  let bytes = 0;
  const out: typeof rows = [];
  for (const r of rows) {
    const size = r.name.length + r.whenToUse.length + r.body.length + 64;
    if (bytes + size > PLAY_BUDGET_BYTES) break;
    out.push(r);
    bytes += size;
  }
  playsCache.set(agentId, { value: out, ts: Date.now() });
  return out;
}

/**
 * Build the full system prompt for a turn: base persona + (optional) channel
 * overlay + (optional) enabled plays. Falls back to the built-in default when
 * no row is saved or the DB lookup fails.
 */
export async function buildSystemPrompt(agentId: string, runtimeChannel: string): Promise<string> {
  let base: string | null = null;
  let overlay: string | null = null;
  let plays: Array<{ name: string; whenToUse: string; body: string }> = [];
  const slot = mapChannelToSlot(runtimeChannel);
  try {
    base = await getActivePersonaBody(agentId, "base");
    if (slot !== "base") overlay = await getActivePersonaBody(agentId, slot);
    plays = await listEnabledPlays(agentId);
  } catch (err) {
    console.error("[agent.persona] loader failed, falling back to defaults:", err);
  }

  let prompt = (base && base.trim()) ? base.trim() : DEFAULT_BASE_PERSONA;

  if (overlay && overlay.trim()) {
    prompt += `\n\n=== Channel overlay (${slot}) ===\n${overlay.trim()}`;
  }

  if (plays.length) {
    prompt += `\n\n=== Available plays — apply when the situation matches ===`;
    for (const p of plays) {
      prompt += `\n\n• ${p.name}\n  When to use: ${p.whenToUse}\n  Approach: ${p.body}`;
    }
  }

  return prompt;
}
