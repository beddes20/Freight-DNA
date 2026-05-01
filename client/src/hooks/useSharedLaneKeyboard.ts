// Task #871 — Single source of truth for the lane-surface keyboard.
//
// Both `/lanes/work-queue` (LWQ) and `/available-freight` (AF) reach for
// the same hot keys today (j/k navigation, enter to act, w/c/n to drill,
// L to open the cockpit, ? for help). This hook owns the registry so
// the cheat sheet rendered on either page is generated from the same
// source as the actual key handlers — no copy/paste drift.
//
// The registry also REJECTS duplicate bindings at module load. If two
// actions both claim "j" the import will throw — caught by vitest in
// CI, caught by Vite's HMR boundary in dev. Pages cannot ship a silent
// keymap conflict.
//
// Task #907 — Workflow OS shared keys (x, a, A, b, /, g o, g p) added
// to the same registry. `g o` / `g p` are CHORD keys (`g` then `o`)
// dispatched via the chord-sequence handler below; see
// docs/workflow-os-spec.md section H.

import { useEffect, useMemo, useRef } from "react";

export type LaneKeyId =
  | "next"
  | "prev"
  | "open"
  | "openCockpit"
  | "swapSurface"
  | "openContacts"
  | "openNote"
  | "showHelp"
  // Workflow OS shared keys (Task #907 — see docs/workflow-os-spec.md
  // section H). These belong to the shared lane registry so AF, LWQ, and
  // Available Loads cannot silently re-bind them.
  | "toggleSelection"
  | "selectAllVisible"
  | "deselectAll"
  | "openBulkOutreach"
  | "focusSearch"
  | "jumpOwnerFilter"
  | "jumpPickupScope";

export interface LaneKeyBinding {
  id: LaneKeyId;
  /**
   * Single-character key (case-sensitive — uppercase L for cockpit) OR
   * a two-character chord written as `"<prefix> <next>"` (e.g. `"g o"`).
   * Chord keys are matched by the chord-sequence handler with a 1.5s
   * window between keystrokes.
   */
  key: string;
  /** Human-readable label rendered in the cheat sheet. */
  label: string;
  /**
   * Whether this binding is shared across both LWQ and AF (true) or
   * surface-specific (false). Surface-specific keys still use the same
   * registry to guarantee no collisions but only render in the
   * surface's own cheat sheet.
   */
  shared: boolean;
}

/**
 * The canonical registry. Order here drives cheat-sheet display order.
 * Adding a new binding? Pick a key not already present; the duplicate
 * check below will throw at module load if you accidentally collide.
 */
export const LANE_KEY_BINDINGS: readonly LaneKeyBinding[] = [
  { id: "next",             key: "j",     label: "Next row",                  shared: true  },
  { id: "prev",             key: "k",     label: "Previous row",              shared: true  },
  { id: "open",             key: "Enter", label: "Open the focused row",      shared: true  },
  { id: "toggleSelection",  key: "x",     label: "Toggle selection on focused row", shared: true },
  { id: "selectAllVisible", key: "a",     label: "Select all visible",        shared: true  },
  { id: "deselectAll",      key: "A",     label: "Deselect all",              shared: true  },
  { id: "openBulkOutreach", key: "b",     label: "Open bulk outreach",        shared: true  },
  { id: "focusSearch",      key: "/",     label: "Focus search",              shared: true  },
  { id: "jumpOwnerFilter",  key: "g o",   label: "Jump to Owner filter",      shared: true  },
  { id: "jumpPickupScope",  key: "g p",   label: "Jump to Pickup scope",      shared: true  },
  { id: "swapSurface",      key: "w",     label: "Swap to the other freight surface (LWQ ↔ AF)", shared: true },
  { id: "openContacts",     key: "c",     label: "Open lane contacts",        shared: true  },
  { id: "openNote",         key: "n",     label: "Add a note on this lane",   shared: true  },
  { id: "openCockpit",      key: "L",     label: "Open Lane Cockpit overlay", shared: true  },
  { id: "showHelp",         key: "?",     label: "Show this cheat sheet",     shared: true  },
] as const;

/** True if `key` is a chord (e.g. `"g o"`), false for single-keys. */
export function isChordKey(key: string): boolean {
  return key.includes(" ");
}

/**
 * Throws if any two bindings collide on the same key/id, OR if a
 * single-key binding shadows a chord prefix (e.g. a `g` single-key
 * binding would make `g o` undispatchable). Runs at module load so a
 * misconfigured registry fails fast — both in vitest and at page-load
 * time in the browser. Exported for tests.
 */
export function assertNoDuplicateBindings(bindings: readonly LaneKeyBinding[]) {
  const seenKeys = new Map<string, LaneKeyId>();
  const seenIds = new Set<LaneKeyId>();
  const chordPrefixes = new Map<string, LaneKeyId>();
  for (const b of bindings) {
    if (seenIds.has(b.id)) {
      throw new Error(
        `[useSharedLaneKeyboard] Duplicate binding id "${b.id}" — every action must be unique.`,
      );
    }
    seenIds.add(b.id);
    if (seenKeys.has(b.key)) {
      throw new Error(
        `[useSharedLaneKeyboard] Duplicate key "${b.key}" claimed by both ` +
          `"${seenKeys.get(b.key)}" and "${b.id}". Pick a different key.`,
      );
    }
    seenKeys.set(b.key, b.id);
    if (isChordKey(b.key)) {
      chordPrefixes.set(b.key.split(" ")[0], b.id);
    }
  }
  // Single-key vs chord-prefix shadow check.
  for (const [singleKey, singleId] of seenKeys) {
    if (isChordKey(singleKey)) continue;
    if (chordPrefixes.has(singleKey)) {
      throw new Error(
        `[useSharedLaneKeyboard] Single-key binding "${singleKey}" (${singleId}) ` +
          `shadows the chord prefix used by "${chordPrefixes.get(singleKey)}".`,
      );
    }
  }
}

assertNoDuplicateBindings(LANE_KEY_BINDINGS);

export type LaneKeyHandlers = Partial<Record<LaneKeyId, () => void>>;

export interface UseSharedLaneKeyboardOptions {
  /** Map from binding id → handler. Missing handlers are no-ops. */
  handlers: LaneKeyHandlers;
  /**
   * When false the listener is detached. Defaults to true. Pages should
   * pass false while a modal/sheet is open if they want the modal to
   * own the keyboard.
   */
  enabled?: boolean;
}

/** ms between the prefix keystroke and the second keystroke for a chord. */
export const CHORD_WINDOW_MS = 1500;

/**
 * Stateful chord-sequence dispatcher. Keep one instance per active
 * keyboard session — `useSharedLaneKeyboard` does this via a ref.
 * Exposed and constructed externally so tests can step a synthetic key
 * stream without coupling to jsdom timer quirks.
 */
export interface ChordDispatcherState {
  pendingPrefix: string | null;
  pendingExpiresAt: number | null;
}

export function makeChordDispatcherState(): ChordDispatcherState {
  return { pendingPrefix: null, pendingExpiresAt: null };
}

/**
 * Step the chord state forward with one event. Returns the binding
 * that fired (if any). `now` lets tests pin the clock; defaults to
 * Date.now() for runtime callers.
 */
export function dispatchLaneKey(
  bindings: readonly LaneKeyBinding[],
  ev: { key: string },
  state: ChordDispatcherState = makeChordDispatcherState(),
  now: number = Date.now(),
): LaneKeyBinding | null {
  // Expire stale prefix.
  if (state.pendingPrefix && state.pendingExpiresAt !== null && now > state.pendingExpiresAt) {
    state.pendingPrefix = null;
    state.pendingExpiresAt = null;
  }
  // 1) If a prefix is pending, try to complete a chord.
  if (state.pendingPrefix) {
    const chordKey = `${state.pendingPrefix} ${ev.key}`;
    const chordHit = bindings.find((b) => b.key === chordKey) ?? null;
    state.pendingPrefix = null;
    state.pendingExpiresAt = null;
    if (chordHit) return chordHit;
    // Fall through — second key may still be a single-key binding.
  }
  // 2) Single-key match.
  const singleHit = bindings.find((b) => b.key === ev.key) ?? null;
  if (singleHit) return singleHit;
  // 3) If `ev.key` is itself a chord prefix, arm the state.
  const isPrefix = bindings.some((b) => isChordKey(b.key) && b.key.split(" ")[0] === ev.key);
  if (isPrefix) {
    state.pendingPrefix = ev.key;
    state.pendingExpiresAt = now + CHORD_WINDOW_MS;
  }
  return null;
}

/**
 * Attach the registry to the window. Skips when typing into form fields
 * (input/textarea/select/contenteditable) so the rep can still actually
 * type into composer boxes without hijacking j/k. Uses a ref-stored
 * chord state so the prefix persists across keydown events.
 */
export function useSharedLaneKeyboard(opts: UseSharedLaneKeyboardOptions) {
  const { handlers, enabled = true } = opts;
  const chordStateRef = useRef<ChordDispatcherState>(makeChordDispatcherState());
  useEffect(() => {
    if (!enabled) return;
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          (target as HTMLElement).isContentEditable
        ) return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const binding = dispatchLaneKey(LANE_KEY_BINDINGS, { key: ev.key }, chordStateRef.current);
      if (!binding) return;
      const handler = handlers[binding.id];
      if (!handler) return;
      ev.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers, enabled]);
}

/**
 * Stable cheat-sheet rows derived from the registry. Pages render this
 * directly so the help dialog and the actual handlers can never disagree.
 */
export function useLaneCheatSheetRows(opts: { surface: "lwq" | "af" }) {
  const { surface } = opts;
  return useMemo(() => {
    return LANE_KEY_BINDINGS.map(b => ({
      key: b.key,
      label: b.label,
      shared: b.shared,
      surface,
    }));
  }, [surface]);
}
