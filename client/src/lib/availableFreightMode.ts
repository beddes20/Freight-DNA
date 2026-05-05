// Task #1023 — Available Freight mode contract.
//
// Available Freight today tries to be triage queue, coverage dashboard,
// filter lab, system-health console, and auto-pilot control surface on
// one screen. Tasks A–C tightened the truth and hierarchy; this helper
// introduces three explicit modes so each job has its own surface and
// the primary execution mode (Action) stays uncluttered.
//
// Modes:
//   - "action"   — default triage cockpit. Bucket strip, scope summary,
//                  compact KPIs, the row list with primary actions.
//   - "coverage" — focused outreach funnel: sent / awaiting / responded
//                  / covered with carrier-side detail.
//   - "ops"      — import health, hidden loads detail, leak indicators,
//                  auto-pilot preview. Clearly secondary.
//
// Mode is shared with the underlying cockpit scope: switching modes
// MUST NOT change the scope (owner / pickup / saved view / bucket /
// filters). The Scope Summary remains the single source of truth.
//
// Persistence:
//   - URL  — `?mode=` (deep-linkable; absent ⇒ default).
//   - Local — `localStorage.af:mode` per browser/user (sticky).
// The URL wins on first paint; localStorage seeds it when no `?mode=`
// is present so a returning rep lands on the mode they last used.
//
// Decision recorded for Task D: ship Ops as a TAB on this page (not a
// new admin route). Task E will move ops surfaces wholesale to an
// admin-scoped surface; until then a tab keeps everything one click
// away and avoids losing the ops affordances mid-refactor.

export type AvailableFreightMode = "action" | "coverage" | "ops";

export const AVAILABLE_FREIGHT_MODES: AvailableFreightMode[] = [
  "action",
  "coverage",
  "ops",
];

export const DEFAULT_AVAILABLE_FREIGHT_MODE: AvailableFreightMode = "action";

export const AF_MODE_STORAGE_KEY = "af:mode";
export const AF_MODE_URL_PARAM = "mode";

export function isAvailableFreightMode(
  v: unknown,
): v is AvailableFreightMode {
  return v === "action" || v === "coverage" || v === "ops";
}

/** Parse a mode token from any string (URL param, storage value). */
export function parseMode(
  v: string | null | undefined,
): AvailableFreightMode | null {
  if (typeof v !== "string") return null;
  const lower = v.trim().toLowerCase();
  return isAvailableFreightMode(lower) ? lower : null;
}

export interface ResolveModeInput {
  url?: string | null;
  storage?: string | null;
}

/**
 * Resolve the initial mode from URL (wins) then storage then default.
 * Pure: no side-effects so tests can drive every branch.
 */
export function resolveInitialMode(input: ResolveModeInput): AvailableFreightMode {
  return (
    parseMode(input.url) ??
    parseMode(input.storage) ??
    DEFAULT_AVAILABLE_FREIGHT_MODE
  );
}

/**
 * Returns a mutated URL string with `?mode=` set or removed (default
 * mode is removed for clean URLs). Pure — does not call history APIs.
 */
export function applyModeToUrl(href: string, mode: AvailableFreightMode): string {
  const url = new URL(href);
  if (mode === DEFAULT_AVAILABLE_FREIGHT_MODE) {
    url.searchParams.delete(AF_MODE_URL_PARAM);
  } else {
    url.searchParams.set(AF_MODE_URL_PARAM, mode);
  }
  return url.toString();
}

export interface AvailableFreightModeMeta {
  id: AvailableFreightMode;
  label: string;
  shortLabel: string;
  description: string;
  testId: string;
}

export const AVAILABLE_FREIGHT_MODE_META: Record<
  AvailableFreightMode,
  AvailableFreightModeMeta
> = {
  action: {
    id: "action",
    label: "Action",
    shortLabel: "Action",
    description: "Triage open freight in priority order with primary actions.",
    testId: "tab-mode-action",
  },
  coverage: {
    id: "coverage",
    label: "Coverage",
    shortLabel: "Coverage",
    description: "Track in-flight outreach: sent, awaiting reply, responded, covered.",
    testId: "tab-mode-coverage",
  },
  ops: {
    id: "ops",
    label: "Ops & health",
    shortLabel: "Ops",
    description: "Import health, hidden loads, leak indicators, auto-pilot preview.",
    testId: "tab-mode-ops",
  },
};
