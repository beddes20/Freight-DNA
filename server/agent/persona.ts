/**
 * Persona & playbook loader for the agent core.
 *
 * Resolves the live system prompt for a given agent + channel by stitching
 * together the active base persona, the channel-specific overlay (if any),
 * and any enabled named "plays". Falls back to a hardcoded default whenever
 * the database has no active row, so the bot never goes silent.
 */
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../storage";
import { agents, agentPersonas, agentPlays, agentTools } from "@shared/schema";

/**
 * MD5s of every prior DEFAULT_BASE_PERSONA body that we are willing to
 * silently replace at startup. Add entries here (never remove) when bumping
 * the default — `migrateLegacyDefaultPersonas` will supersede any active
 * row whose body matches one of these. Customised persona bodies (anything
 * not in this set) are left alone.
 */
const LEGACY_DEFAULT_PERSONA_MD5S = new Set<string>([
  // Pre-Phase-2A default (no team-activity routing rule).
  "7a3890049f2c14f849a6a580f94de797",
  // Phase-2A default (admin/director/sales_director wording — superseded by
  // the broader manager-tier wording when subtree-scoping landed).
  "c2f0b2f794cee8e162129d9ec76c9e59",
]);

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

Team activity questions — always call the right rollup tool, never guess:
- "who hasn't logged a touchpoint", "which reps are dark", "who needs a nudge", "who's behind on activity" → call reps_missing_touchpoints.
- "how many touchpoints did each rep make", "team activity today/this week", "who's been most active", "per-rep tally", "leaderboard" → call team_touchpoint_tally.
- These are manager tools. Admins see the whole org; other managers (director, sales director, NAM, logistics manager) see their own team. If the rep isn't a manager, the tool itself returns a polite refusal — pass that message through verbatim, don't editorialize.
- Default the date window to today unless the rep says otherwise ("this week", "yesterday", a specific date).

Do not list every tool you have. Just use the right one and answer.`;

export type ChannelSlot = "base" | "in_app" | "email" | "sms" | "voice" | "teams";

const ALL_SLOTS: ChannelSlot[] = ["base", "in_app", "email", "sms", "voice", "teams"];

export function isChannelSlot(value: string): value is ChannelSlot {
  return (ALL_SLOTS as string[]).includes(value);
}

export function listChannelSlots(): ChannelSlot[] {
  return [...ALL_SLOTS];
}

/**
 * Map a runtime channel name onto the persona slot used in the DB. Each
 * supported channel has its own slot so SMS and voice can diverge over time
 * without another migration.
 */
export function mapChannelToSlot(channel: string): ChannelSlot {
  if (isChannelSlot(channel)) return channel;
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

const runtimeCache = new Map<string, CacheEntry<AgentRuntime>>();

export interface AgentRuntime {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  model: string;
  toolAllowlist: string[] | null;
  description: string | null;
  status: string;
}

/**
 * Load the runtime config for a given agent (model, tool allowlist, name).
 * `toolAllowlist` is null when the agent has no explicit row — in that case
 * core.ts treats it as "every tool the rep has permission for".
 */
export async function getAgentRuntime(agentId: string): Promise<AgentRuntime | null> {
  const cached = cacheGet(runtimeCache, agentId);
  if (cached) return cached;
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!row) return null;
  const tools = await db.select({ capability: agentTools.capability })
    .from(agentTools).where(eq(agentTools.agentId, agentId));
  const runtime: AgentRuntime = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    organizationId: row.organizationId,
    model: row.model || "gpt-4o",
    toolAllowlist: tools.length ? tools.map((t) => t.capability) : null,
    description: row.description,
    status: row.status,
  };
  runtimeCache.set(agentId, { value: runtime, ts: Date.now() });
  return runtime;
}

export function invalidateAgentRuntime(agentId?: string) {
  if (!agentId) runtimeCache.clear();
  else runtimeCache.delete(agentId);
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

/**
 * Seed an active base persona row so the DB reflects what the bot is currently
 * saying. Does nothing if a base persona already exists for this agent.
 */
async function seedBasePersonaIfMissing(agentId: string) {
  const [existing] = await db.select({ id: agentPersonas.id }).from(agentPersonas)
    .where(and(
      eq(agentPersonas.agentId, agentId),
      eq(agentPersonas.channel, "base"),
      eq(agentPersonas.isActive, true),
    ))
    .limit(1);
  if (existing) return;
  try {
    await db.insert(agentPersonas).values({
      agentId,
      channel: "base",
      body: DEFAULT_BASE_PERSONA,
      isActive: true,
      version: 1,
    });
  } catch (err) {
    // Partial unique index may race with a concurrent seed — that's fine.
    console.warn("[agent.persona] base seed race (ignored):", (err as Error)?.message);
  }
}

/**
 * Phase 2A migration: supersede any active base persona body that still
 * matches a known legacy DEFAULT_BASE_PERSONA hash. Inserts a new active
 * row at version+1 with the current default and marks the old one inactive.
 *
 * This runs at startup so live orgs pick up new built-in routing rules
 * (e.g. team-activity tool guidance) without an operator having to touch
 * the AI Center. Customised persona bodies (anything whose md5 is not in
 * `LEGACY_DEFAULT_PERSONA_MD5S`) are left strictly alone.
 *
 * Safe to re-run: once the body matches the current default, its md5 is no
 * longer "legacy" so the migration becomes a no-op.
 */
export async function migrateLegacyDefaultPersonas(): Promise<void> {
  const currentMd5 = createHash("md5").update(DEFAULT_BASE_PERSONA).digest("hex");
  if (LEGACY_DEFAULT_PERSONA_MD5S.has(currentMd5)) {
    // Sanity guard: the live default must never be in the legacy set, or we
    // would loop replacing rows with themselves on every boot.
    console.error("[agent.persona] DEFAULT_BASE_PERSONA md5 is in the legacy set — refusing to migrate.");
    return;
  }
  let migrated = 0;
  try {
    const rows = await db
      .select({ id: agentPersonas.id, agentId: agentPersonas.agentId, version: agentPersonas.version, body: agentPersonas.body })
      .from(agentPersonas)
      .where(and(eq(agentPersonas.channel, "base"), eq(agentPersonas.isActive, true)));
    for (const row of rows) {
      const md5 = createHash("md5").update(row.body).digest("hex");
      if (!LEGACY_DEFAULT_PERSONA_MD5S.has(md5)) continue;
      try {
        await db.transaction(async (tx) => {
          await tx.update(agentPersonas).set({ isActive: false }).where(eq(agentPersonas.id, row.id));
          await tx.insert(agentPersonas).values({
            agentId: row.agentId,
            channel: "base",
            body: DEFAULT_BASE_PERSONA,
            isActive: true,
            version: row.version + 1,
          });
        });
        invalidatePersonaCache(row.agentId);
        migrated++;
      } catch (err) {
        console.error(`[agent.persona] migrate failed for agent ${row.agentId}:`, err);
      }
    }
    if (migrated > 0) {
      console.log(`[agent.persona] migrated ${migrated} legacy default base persona row(s) to current default`);
    }
  } catch (err) {
    console.error("[agent.persona] legacy persona migration skipped:", err);
  }
}

/**
 * Backfill: ensure every organization has a DNA agent and an active base
 * persona row. Called once at server startup so we don't have to wait for the
 * first user turn to seed an org. Failures are logged but never crash boot —
 * the lazy ensureDefaultAgent in runtime paths covers any miss.
 */
export async function backfillDefaultAgentsForAllOrgs(): Promise<void> {
  try {
    const { organizations } = await import("@shared/schema");
    const orgs = await db.select({ id: organizations.id }).from(organizations);
    let created = 0;
    for (const o of orgs) {
      try {
        await ensureDefaultAgent(o.id);
        created++;
      } catch (err) {
        console.error(`[agent.persona] backfill failed for org ${o.id}:`, err);
      }
    }
    console.log(`[agent.persona] startup backfill complete — ${created}/${orgs.length} orgs have DNA agent + base persona`);
  } catch (err) {
    console.error("[agent.persona] backfill skipped (will run lazily per org):", err);
  }
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
    await seedBasePersonaIfMissing(existing.id);
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
  await seedBasePersonaIfMissing(created.id);
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

  let prompt: string;
  if (base && base.trim()) {
    prompt = base.trim();
  } else {
    if (base !== null && base !== undefined && !base.trim()) {
      console.warn(`[agent.persona] active base persona for agent ${agentId} is blank — falling back to built-in default`);
    }
    prompt = DEFAULT_BASE_PERSONA;
  }

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
