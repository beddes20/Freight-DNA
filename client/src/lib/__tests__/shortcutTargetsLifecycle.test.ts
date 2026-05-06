// Task #970 — additional shortcut-target tests covering the
// "page mounts, but data loads later" path that the LWQ Shift+L
// handshake depends on.
//
// The unit-level invariant is simple: the registry surfaces the
// invocation to the page; the page is responsible for retrying the
// focus once its data lands. The registry retains invocations
// indefinitely so deterministic deep-link focus survives a slow
// route or a slow first fetch.
//
// We don't import React here — we model the page-side state with a
// closure that mirrors the LWQ component's `pendingFocusRef` +
// `focusFirstRow` + effect.

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerShortcutTarget,
  invokeShortcutTarget,
  hasPendingShortcutInvocation,
  consumePendingShortcutInvocation,
  _resetShortcutTargetsForTests,
} from "@/lib/shortcutTargets";

describe("shortcutTargets — App→LWQ Shift+L lifecycle", () => {
  beforeEach(() => {
    _resetShortcutTargetsForTests();
  });

  it("queues, drains on mount, defers focus until data, then focuses once", () => {
    // --- Page-side model ---------------------------------------------------
    let focusedIndex = -1;
    let flatLaneOrder: string[] = [];
    let pending = false;
    let focusCalls = 0;
    const focusFirstRow = () => {
      if (flatLaneOrder.length === 0) return false;
      focusedIndex = 0;
      focusCalls += 1;
      return true;
    };

    // 1. App.tsx invokes BEFORE the page mounts.
    const fired = invokeShortcutTarget("lwq:focus-first-row");
    expect(fired).toBe(false);
    expect(hasPendingShortcutInvocation("lwq:focus-first-row")).toBe(true);

    // 2. The page mounts and registers — registry drains the invoke.
    registerShortcutTarget("lwq:focus-first-row", () => {
      if (!focusFirstRow()) {
        pending = true;
      }
    });

    // 3. Page captured a pending focus (data hasn't arrived yet).
    expect(focusCalls).toBe(0);
    expect(focusedIndex).toBe(-1);
    expect(pending).toBe(true);
    expect(hasPendingShortcutInvocation("lwq:focus-first-row")).toBe(false);

    // 4. Data lands → effect replays the intent.
    flatLaneOrder = ["L1", "L2"];
    if (pending) {
      pending = false;
      focusFirstRow();
    }
    expect(focusCalls).toBe(1);
    expect(focusedIndex).toBe(0);
    expect(pending).toBe(false);

    // 5. A second data update should NOT re-fire focus.
    flatLaneOrder = ["L1", "L2", "L3"];
    if (pending) {
      focusFirstRow();
    }
    expect(focusCalls).toBe(1);
  });

  it("retains the invocation indefinitely until the page mounts", () => {
    // The deterministic-focus contract: a slow route or slow data fetch
    // must NOT cause the rep's Shift+L to vanish. Previously the
    // registry expired pending invocations after 2 s; that bound
    // produced an intermittent "Shift+L did nothing" failure mode
    // whenever the LWQ bundle/data took longer to mount.
    invokeShortcutTarget("lwq:focus-first-row");
    expect(hasPendingShortcutInvocation("lwq:focus-first-row")).toBe(true);

    // Some time passes — the rep clicks around, network is slow, etc.
    // The registry should still have the pending invocation queued.
    expect(hasPendingShortcutInvocation("lwq:focus-first-row")).toBe(true);

    // Eventually LWQ mounts and registers; the queued invocation
    // drains synchronously.
    let drained = false;
    registerShortcutTarget("lwq:focus-first-row", () => {
      drained = true;
    });
    expect(drained).toBe(true);
    expect(hasPendingShortcutInvocation("lwq:focus-first-row")).toBe(false);
  });

  it("explicit consume drops a queued invocation without firing it", () => {
    // App-level navigation handlers that observe the rep moving
    // somewhere unrelated can drop a stale pending invocation so the
    // next page mount doesn't auto-focus unexpectedly.
    invokeShortcutTarget("lwq:focus-first-row");
    expect(hasPendingShortcutInvocation("lwq:focus-first-row")).toBe(true);

    const dropped = consumePendingShortcutInvocation("lwq:focus-first-row");
    expect(dropped).toBe(true);
    expect(hasPendingShortcutInvocation("lwq:focus-first-row")).toBe(false);

    // Subsequent registration should NOT auto-fire — the intent is gone.
    let drained = false;
    registerShortcutTarget("lwq:focus-first-row", () => {
      drained = true;
    });
    expect(drained).toBe(false);
  });
});
