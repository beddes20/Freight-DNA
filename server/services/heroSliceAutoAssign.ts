/**
 * Hero Slice Auto-Assign (Task #1069)
 *
 * Narrow, config-driven LM auto-assignment for the email→quote→won→load
 * hero loop. Outside the hero slice(s) the existing NAM/AM popup
 * (server/routes/wonLoadAutopilot.ts) remains the only assignment path.
 *
 * Config is stored as JSON under the `hero_slice_auto_assign:<orgId>`
 * setting key so adding a new slice never requires a code change. Schema:
 *
 *   {
 *     "slices": [
 *       {
 *         "id": "acme-mw-se-vans",                  // human-readable slice id
 *         "customerNamePattern": "ACME LOGISTICS",  // case-insensitive substring
 *         "originStatePattern": "IL|IN|OH",         // optional; pipe-separated state list
 *         "destinationStatePattern": "GA|FL|NC",    // optional; pipe-separated state list
 *         "equipmentPattern": "VAN",                // optional; case-insensitive substring
 *         "lmUserId": "u_xxx"                        // logistics_manager users.id
 *       }
 *     ]
 *   }
 *
 * Match rules:
 *   - customerNamePattern is required and matched case-insensitively as a
 *     substring against the freight opportunity's customer name.
 *   - origin/destination/equipment patterns are optional. When present the
 *     row's value must match ONE of the pipe-separated tokens (case-
 *     insensitive). Empty/missing row values fail the optional gate.
 *   - First matching slice wins.
 *
 * On match the converter promotes the new freight_opportunities row to
 *   { delegatedToUserId, status: "ready_to_send", approvedAt: now,
 *     approvedById: <actor or LM>, awaitingApprovalSince: null }
 * in the SAME insert so the LM picks it up in Available Freight without
 * the NAM/AM popup. The slice rule is intentionally narrow so the global
 * popup contract is unchanged for every other customer.
 */
import { storage } from "../storage";

export interface HeroSliceConfig {
  id: string;
  customerNamePattern: string;
  originStatePattern?: string | null;
  destinationStatePattern?: string | null;
  equipmentPattern?: string | null;
  lmUserId: string;
}

export interface HeroSliceAutoAssignInput {
  customerName: string | null;
  originState: string | null;
  destinationState: string | null;
  equipmentType: string | null;
}

export function heroSliceSettingKey(orgId: string): string {
  return `hero_slice_auto_assign:${orgId}`;
}

export async function getHeroSlices(orgId: string): Promise<HeroSliceConfig[]> {
  const raw = await storage.getSetting(heroSliceSettingKey(orgId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const slices = Array.isArray(parsed?.slices) ? parsed.slices : [];
    return slices.filter((s: unknown): s is HeroSliceConfig => {
      if (!s || typeof s !== "object") return false;
      const o = s as Record<string, unknown>;
      return typeof o.id === "string"
        && typeof o.customerNamePattern === "string"
        && typeof o.lmUserId === "string"
        && o.lmUserId.length > 0;
    });
  } catch (err) {
    console.error(`[hero-slice] config parse failed org=${orgId}:`, err);
    return [];
  }
}

export async function setHeroSlices(orgId: string, slices: HeroSliceConfig[]): Promise<void> {
  await storage.setSetting(heroSliceSettingKey(orgId), JSON.stringify({ slices }));
}

function matchesTokenList(value: string | null, pattern: string | null | undefined): boolean {
  if (!pattern) return true; // optional gate
  if (!value) return false;
  const tokens = pattern.split("|").map(t => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return true;
  const v = value.trim().toLowerCase();
  return tokens.some(t => v === t || v.includes(t));
}

function matchesSubstring(value: string | null, pattern: string | null | undefined): boolean {
  if (!pattern) return true;
  if (!value) return false;
  return value.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Pure matcher (exported for tests and the guardrail). Returns the first
 * slice whose every gate matches the input, else null.
 */
export function matchHeroSlice(
  slices: HeroSliceConfig[],
  input: HeroSliceAutoAssignInput,
): HeroSliceConfig | null {
  if (!input.customerName) return null;
  for (const slice of slices) {
    if (!matchesSubstring(input.customerName, slice.customerNamePattern)) continue;
    if (!matchesTokenList(input.originState, slice.originStatePattern)) continue;
    if (!matchesTokenList(input.destinationState, slice.destinationStatePattern)) continue;
    if (!matchesSubstring(input.equipmentType, slice.equipmentPattern)) continue;
    return slice;
  }
  return null;
}

/**
 * Resolves the auto-assignment for a brand-new freight opportunity built
 * from a won quote. Returns the LM + ready_to_send promotion when the
 * slice matches, else null (caller falls back to pending_approval).
 */
export async function resolveHeroSliceAutoAssign(
  orgId: string,
  input: HeroSliceAutoAssignInput,
): Promise<{ slice: HeroSliceConfig; lmUserId: string } | null> {
  const slices = await getHeroSlices(orgId);
  if (slices.length === 0) return null;
  const slice = matchHeroSlice(slices, input);
  if (!slice) return null;
  return { slice, lmUserId: slice.lmUserId };
}
