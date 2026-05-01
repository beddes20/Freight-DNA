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

import { useEffect, useMemo } from "react";

export type LaneKeyId =
  | "next"
  | "prev"
  | "open"
  | "openCockpit"
  | "swapSurface"
  | "openContacts"
  | "openNote"
  | "showHelp";

export interface LaneKeyBinding {
  id: LaneKeyId;
  /** Single-character key (case-sensitive — uppercase L for cockpit). */
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
  { id: "next",            key: "j",     label: "Next row",                  shared: true  },
  { id: "prev",            key: "k",     label: "Previous row",              shared: true  },
  { id: "open",            key: "Enter", label: "Open the focused row",      shared: true  },
  { id: "swapSurface",     key: "w",     label: "Swap to the other freight surface (LWQ ↔ AF)", shared: true },
  { id: "openContacts",    key: "c",     label: "Open lane contacts",        shared: true  },
  { id: "openNote",        key: "n",     label: "Add a note on this lane",   shared: true  },
  { id: "openCockpit",     key: "L",     label: "Open Lane Cockpit overlay", shared: true  },
  { id: "showHelp",        key: "?",     label: "Show this cheat sheet",     shared: true  },
] as const;

/**
 * Throws if any two bindings collide on the same key. Runs at module
 * load so a misconfigured registry fails fast — both in vitest and at
 * page-load time in the browser. Exported for tests.
 */
export function assertNoDuplicateBindings(bindings: readonly LaneKeyBinding[]) {
  const seenKeys = new Map<string, LaneKeyId>();
  const seenIds = new Set<LaneKeyId>();
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

/**
 * Test helper — exposed so vitest can dispatch synthetic key events
 * against a stand-in target without coupling to jsdom keyboard quirks.
 * Returns the binding that fired (if any).
 */
export function dispatchLaneKey(
  bindings: readonly LaneKeyBinding[],
  ev: { key: string },
): LaneKeyBinding | null {
  return bindings.find(b => b.key === ev.key) ?? null;
}

/**
 * Attach the registry to the window. Skips when typing into form fields
 * (input/textarea/select/contenteditable) so the rep can still actually
 * type into composer boxes without hijacking j/k.
 */
export function useSharedLaneKeyboard(opts: UseSharedLaneKeyboardOptions) {
  const { handlers, enabled = true } = opts;
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
      const binding = LANE_KEY_BINDINGS.find(b => b.key === ev.key);
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
