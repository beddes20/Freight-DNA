import { eq, and } from "drizzle-orm";
import { db } from "../storage";
import { agentCapabilities, type UserRole, type User } from "@shared/schema";

/**
 * Capability identifiers used by tools. Read tools get `read.*`, writes `write.*`.
 * Adding a new tool? Pick a capability key (or reuse one) and register the tool's
 * `capability` field in the tool registry.
 */
export type Capability =
  // Reads — broad, low risk; default allow for everyone
  | "read.account"
  | "read.contact"
  | "read.touchpoint"
  | "read.task"
  | "read.rfp"
  | "read.award"
  | "read.opportunity"
  | "read.lane"
  | "read.carrier"
  | "read.market"
  | "read.financial"
  | "read.memory"
  | "read.nba"
  // Navigation
  | "navigate.crm"
  // Writes inside the CRM — default HITL for everyone
  | "write.touchpoint"
  | "write.task"
  | "write.task.complete"
  | "write.touchpoint.meaningful"
  | "write.account"
  | "write.opportunity"
  | "write.memory"
  | "write.email.draft"
  // External outreach (drivers/dispatchers) — default deny except admin/director
  | "write.sms.driver"
  | "write.voice.driver"
  | "write.email.external";

export type Effect = "allow" | "deny" | "auto";
export type Decision =
  | { allowed: true; auto: boolean; effect: Effect; source: "override" | "default" }
  | { allowed: false; reason: string; source: "override" | "default" };

const ALL_READS: Capability[] = [
  "read.account", "read.contact", "read.touchpoint", "read.task", "read.rfp",
  "read.award", "read.opportunity", "read.lane", "read.carrier", "read.market",
  "read.financial", "read.memory", "read.nba",
];

const ALL_HITL_WRITES: Capability[] = [
  "write.touchpoint", "write.task", "write.task.complete",
  "write.touchpoint.meaningful", "write.account", "write.opportunity",
  "write.email.draft",
];

// Writes that are safe to execute directly without a confirmation card.
// `remember_this` is a personal memory note — no business side effects.
const ALL_AUTO_WRITES: Capability[] = ["write.memory"];

const ALL_EXTERNAL: Capability[] = [
  "write.sms.driver", "write.voice.driver", "write.email.external",
];

function buildDefaults(): Record<Capability, Effect> {
  const defaults: Partial<Record<Capability, Effect>> = {};
  for (const c of ALL_READS) defaults[c] = "allow";
  defaults["navigate.crm"] = "allow";
  for (const c of ALL_HITL_WRITES) defaults[c] = "allow";
  for (const c of ALL_AUTO_WRITES) defaults[c] = "auto";
  for (const c of ALL_EXTERNAL) defaults[c] = "deny";
  return defaults as Record<Capability, Effect>;
}

const READ_ONLY_DEFAULTS = (() => {
  const d = buildDefaults();
  for (const c of ALL_HITL_WRITES) d[c] = "deny";
  // Personal memory is still allowed for read-only roles (no business impact).
  for (const c of ALL_AUTO_WRITES) d[c] = "auto";
  return d;
})();

const ADMIN_DEFAULTS = (() => {
  const d = buildDefaults();
  for (const c of ALL_EXTERNAL) d[c] = "allow";
  return d;
})();

/**
 * Per-role default capability matrix. Per-user `agent_capabilities` rows
 * override these. Anything not listed for a role inherits from its base
 * (account_manager-style HITL writes).
 */
export const ROLE_DEFAULTS: Record<UserRole, Record<Capability, Effect>> = {
  admin: ADMIN_DEFAULTS,
  director: ADMIN_DEFAULTS,
  sales_director: buildDefaults(),
  national_account_manager: buildDefaults(),
  account_manager: buildDefaults(),
  sales: buildDefaults(),
  logistics_manager: buildDefaults(),
  logistics_coordinator: READ_ONLY_DEFAULTS,
};

export function defaultEffectFor(role: UserRole, capability: Capability): Effect {
  return ROLE_DEFAULTS[role]?.[capability] ?? "deny";
}

/**
 * Resolve whether `rep` can invoke `capability`.
 * - "allow" → permitted; HITL still required for write.* unless override is "auto"
 * - "auto"  → permitted AND no HITL needed (standing approval)
 * - "deny"  → not permitted
 */
export async function canInvoke(rep: User, capability: Capability): Promise<Decision> {
  // Per-user override
  const [override] = await db
    .select()
    .from(agentCapabilities)
    .where(and(eq(agentCapabilities.userId, rep.id), eq(agentCapabilities.capability, capability)))
    .limit(1);

  if (override) {
    if (override.effect === "deny") {
      return { allowed: false, reason: "Per-user override: deny", source: "override" };
    }
    return { allowed: true, auto: override.effect === "auto", effect: override.effect as Effect, source: "override" };
  }

  const def = defaultEffectFor(rep.role as UserRole, capability);
  if (def === "deny") {
    return { allowed: false, reason: `Role ${rep.role} default: deny`, source: "default" };
  }
  return { allowed: true, auto: def === "auto", effect: def, source: "default" };
}

export async function listCapabilitiesForUser(userId: string): Promise<Array<{ capability: string; effect: Effect; note: string | null }>> {
  const rows = await db.select().from(agentCapabilities).where(eq(agentCapabilities.userId, userId));
  return rows.map((r) => ({ capability: r.capability, effect: r.effect as Effect, note: r.note }));
}
