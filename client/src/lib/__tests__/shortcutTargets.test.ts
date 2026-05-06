// Task #970 — unit tests for the deterministic shortcut-target registry.
//
// The registry replaces the previous setTimeout-based focus dance for
// Shift+L. The contract is:
//   * `invokeShortcutTarget(key)` fires synchronously when a callback is
//     registered, otherwise queues the invocation indefinitely.
//   * The next `registerShortcutTarget(key, cb)` drains a queued
//     invocation immediately.
//   * `consumePendingShortcutInvocation(key)` lets app-level handlers
//     drop a stale pending invocation explicitly — there is no time
//     bound that drops it silently behind the rep's back.

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerShortcutTarget,
  invokeShortcutTarget,
  hasPendingShortcutInvocation,
  _resetShortcutTargetsForTests,
} from "@/lib/shortcutTargets";

describe("shortcutTargets registry", () => {
  beforeEach(() => {
    _resetShortcutTargetsForTests();
  });

  it("fires synchronously when a callback is registered", () => {
    let calls = 0;
    registerShortcutTarget("focus", () => {
      calls += 1;
    });
    const fired = invokeShortcutTarget("focus");
    expect(fired).toBe(true);
    expect(calls).toBe(1);
  });

  it("queues when no callback is registered and drains on next register", () => {
    let calls = 0;
    const fired = invokeShortcutTarget("focus");
    expect(fired).toBe(false);
    expect(hasPendingShortcutInvocation("focus")).toBe(true);
    expect(calls).toBe(0);

    // Page mounts and registers — should drain the pending invocation.
    registerShortcutTarget("focus", () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    expect(hasPendingShortcutInvocation("focus")).toBe(false);
  });

  it("retains pending invocations indefinitely until drained", () => {
    let calls = 0;
    invokeShortcutTarget("focus");
    expect(hasPendingShortcutInvocation("focus")).toBe(true);

    // No matter how long elapses, the registry retains the pending
    // invocation. The next register fires it once.
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(hasPendingShortcutInvocation("focus")).toBe(true);
        registerShortcutTarget("focus", () => {
          calls += 1;
        });
        expect(calls).toBe(1);
        expect(hasPendingShortcutInvocation("focus")).toBe(false);
        resolve();
      }, 10);
    });
  });

  it("unregister removes the callback", () => {
    let calls = 0;
    const unregister = registerShortcutTarget("focus", () => {
      calls += 1;
    });
    unregister();
    invokeShortcutTarget("focus");
    expect(calls).toBe(0);
  });

  it("multiple keys are isolated", () => {
    let aCalls = 0;
    let bCalls = 0;
    registerShortcutTarget("a", () => { aCalls += 1; });
    registerShortcutTarget("b", () => { bCalls += 1; });
    invokeShortcutTarget("a");
    invokeShortcutTarget("a");
    invokeShortcutTarget("b");
    expect(aCalls).toBe(2);
    expect(bCalls).toBe(1);
  });

  it("re-registering replaces the prior callback", () => {
    let firstCalls = 0;
    let secondCalls = 0;
    registerShortcutTarget("focus", () => { firstCalls += 1; });
    registerShortcutTarget("focus", () => { secondCalls += 1; });
    invokeShortcutTarget("focus");
    expect(firstCalls).toBe(0);
    expect(secondCalls).toBe(1);
  });

  it("a buggy callback does not break the registry", () => {
    registerShortcutTarget("focus", () => {
      throw new Error("boom");
    });
    // Should not throw out to the caller.
    expect(() => invokeShortcutTarget("focus")).not.toThrow();
  });
});
