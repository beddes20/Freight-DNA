/**
 * Task #973 — Live-sync subscriber registry regression tests.
 *
 * The original singleton-lock implementation gated on "first mount
 * wins" with no real refcount. In React, child effects run before
 * parent effects, so a page mounted under <App> would acquire the
 * lock first; once the page unmounted the lock was released and the
 * App-level mount — whose effect had already executed — never
 * reopened the stream. The result was a *silently disabled* live-sync
 * for the rest of the session.
 *
 * These tests drive the module-scoped manager directly with a fake
 * EventSource so the regression cannot recur:
 *
 *   1. Two mounts → one shared connection.
 *   2. Topic filtering is per-subscriber (no merge that lets one
 *      mount's narrow filter starve another's wide one).
 *   3. Page-mount-first then App-mount, then page unmount: the SSE
 *      stays open. (This is the exact reviewer-reported regression.)
 *   4. Last enabled demand unsubscribes → connection torn down.
 *   5. resetKey change forces tear-down + reopen so a stale Clerk
 *      JWT can't keep serving a signed-out session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  subscribeLiveSyncDemand,
  _resetLiveSyncMountLockForTests,
  _setLiveSyncManagerDepsForTests,
  _getLiveSyncManagerStateForTests,
  _resetLiveSyncStatusForTests,
} from "../../hooks/useLiveSync";

// ── Fake EventSource ────────────────────────────────────────────────
//
// Captures every constructor call so the test can inspect how many
// real connections the manager opened (the headline assertion is
// "exactly one even with two mounts").

interface FakeES {
  url: string;
  closed: boolean;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
  emit(payload: unknown): void;
  fail(): void;
}

const _instances: FakeES[] = [];

class FakeEventSource implements FakeES {
  url: string;
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string, _opts?: EventSourceInit) {
    this.url = url;
    _instances.push(this);
  }
  close(): void { this.closed = true; }
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  fail(): void { this.onerror?.(); }
}

let _scheduledTimers: Array<{ fn: () => void; ms: number }> = [];

beforeEach(() => {
  _instances.length = 0;
  _scheduledTimers = [];
  _resetLiveSyncMountLockForTests();
  _resetLiveSyncStatusForTests();
  _setLiveSyncManagerDepsForTests({
    EventSourceCtor: FakeEventSource as unknown as typeof EventSource,
    scheduleTimeout: (fn, ms) => {
      _scheduledTimers.push({ fn, ms });
      return _scheduledTimers.length - 1;
    },
    clearScheduledTimeout: () => { /* not needed in these tests */ },
    now: () => 1_700_000_000_000,
    ensureTabId: () => "tab-test",
  });
});

afterEach(() => {
  _resetLiveSyncMountLockForTests();
});

async function flush(): Promise<void> {
  // The manager's `openConnection` awaits `getStreamUrl()` before
  // constructing the EventSource. Give the microtask queue a tick.
  await Promise.resolve();
  await Promise.resolve();
}

describe("LiveSyncManager — single connection across multiple mounts", () => {
  it("opens exactly one EventSource even when two demands register", async () => {
    const inv1 = vi.fn();
    const inv2 = vi.fn();
    const u1 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream?token=t1",
      resetKey: "clerk:1:1",
      topics: undefined,
      invalidate: inv1,
    });
    const u2 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream?token=t2",
      resetKey: "clerk:1:1",
      topics: ["customer_quote"],
      invalidate: inv2,
    });
    await flush();
    expect(_instances).toHaveLength(1);
    expect(_getLiveSyncManagerStateForTests().demandCount).toBe(2);
    u1();
    u2();
  });

  it("dispatches each event to every demand, with per-demand topic filtering", async () => {
    const invGlobal = vi.fn();
    const invQuotes = vi.fn();
    subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream",
      resetKey: "k",
      topics: undefined, // wide
      invalidate: invGlobal,
    });
    subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream",
      resetKey: "k",
      topics: ["customer_quote"], // narrow
      invalidate: invQuotes,
    });
    await flush();
    expect(_instances).toHaveLength(1);
    const es = _instances[0];

    // A `mailbox_inbound` event must reach the wide subscriber but
    // NOT the narrow one — proving topic filters are per-demand and
    // one mount's narrow filter cannot starve another's wide filter.
    es.emit({ topic: "mailbox_inbound" });
    expect(invGlobal).toHaveBeenCalled();
    expect(invQuotes).not.toHaveBeenCalled();

    invGlobal.mockClear();
    es.emit({ topic: "customer_quote" });
    expect(invGlobal).toHaveBeenCalled();
    expect(invQuotes).toHaveBeenCalled();
  });
});

describe("LiveSyncManager — page-mount-first, then App-mount regression", () => {
  it("keeps SSE alive after the first-mounted (page) demand unsubscribes", async () => {
    // Reproduce the React effect ordering that broke the original
    // singleton-lock fix: the page hook runs its effect *before* the
    // App-level hook (children before parents in passive effects).
    // The page is the "first mount" and would have grabbed the lock.
    const pageInv = vi.fn();
    const appInv = vi.fn();
    const unsubPage = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream?token=page",
      resetKey: "clerk:1:1",
      topics: ["customer_quote"],
      invalidate: pageInv,
    });
    // Then App's effect runs and registers a second, wider demand.
    const unsubApp = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream?token=app",
      resetKey: "clerk:1:1",
      topics: undefined,
      invalidate: appInv,
    });
    await flush();
    expect(_instances).toHaveLength(1);
    expect(_getLiveSyncManagerStateForTests().hasConnection).toBe(true);

    // User navigates away — the page hook's cleanup unsubscribes.
    // The App hook is still mounted, so the EventSource MUST stay
    // open. (This is the assertion that fails the old design.)
    unsubPage();
    expect(_instances).toHaveLength(1);
    expect(_instances[0].closed).toBe(false);
    expect(_getLiveSyncManagerStateForTests().hasConnection).toBe(true);

    // And the App-level subscriber must keep receiving events.
    _instances[0].emit({ topic: "mailbox_inbound" });
    expect(appInv).toHaveBeenCalled();

    unsubApp();
    expect(_instances[0].closed).toBe(true);
    expect(_getLiveSyncManagerStateForTests().hasConnection).toBe(false);
  });
});

describe("LiveSyncManager — last-out closes the stream", () => {
  it("tears down the EventSource when the final enabled demand unsubscribes", async () => {
    const u1 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream",
      resetKey: "k",
      invalidate: vi.fn(),
    });
    const u2 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream",
      resetKey: "k",
      invalidate: vi.fn(),
    });
    await flush();
    expect(_instances).toHaveLength(1);
    u1();
    expect(_instances[0].closed).toBe(false); // u2 still demands.
    u2();
    expect(_instances[0].closed).toBe(true);
    expect(_getLiveSyncManagerStateForTests().hasConnection).toBe(false);
  });

  it("does not open a connection when the only demand is disabled", async () => {
    const unsub = subscribeLiveSyncDemand({
      enabled: false,
      getStreamUrl: async () => "/api/live-sync/stream",
      resetKey: "signed-out",
      invalidate: vi.fn(),
    });
    await flush();
    expect(_instances).toHaveLength(0);
    expect(_getLiveSyncManagerStateForTests().hasConnection).toBe(false);
    unsub();
  });
});

describe("LiveSyncManager — resetKey change forces a fresh connection", () => {
  it("tears down + reopens when a new demand carries a different resetKey", async () => {
    const u1 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream?token=stale",
      resetKey: "clerk:1:0", // signed-out → signed-in transition
      invalidate: vi.fn(),
    });
    await flush();
    expect(_instances).toHaveLength(1);
    const first = _instances[0];

    const u2 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream?token=fresh",
      resetKey: "clerk:1:1",
      invalidate: vi.fn(),
    });
    await flush();
    expect(first.closed).toBe(true);
    expect(_instances).toHaveLength(2);
    expect(_instances[1].closed).toBe(false);

    u1();
    u2();
  });

  it("does not strand a stale-credential connection when resetKey changes mid-getStreamUrl()", async () => {
    // Race: the very first demand kicks off `openConnection` which
    // awaits `getStreamUrl()`. Before that promise resolves, the
    // demand unsubscribes (mimicking a Clerk session flip cleaning up
    // the old hook) and a brand-new demand with a different resetKey
    // registers. The manager must not finish opening with the stale
    // URL — we resolved it under the old credentials.
    let releaseStale: (url: string) => void;
    const stalePromise = new Promise<string>((resolve) => {
      releaseStale = resolve;
    });
    const u1 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: () => stalePromise,
      resetKey: "clerk:1:0",
      invalidate: vi.fn(),
    });
    // The manager kicked off openConnection() which is awaiting our
    // `stalePromise`; no EventSource yet.
    await Promise.resolve();
    expect(_instances).toHaveLength(0);

    // Simulate the React effect cleanup: the old demand goes away
    // and is immediately replaced by one with a new resetKey.
    u1();
    const u2 = subscribeLiveSyncDemand({
      enabled: true,
      getStreamUrl: async () => "/api/live-sync/stream?token=fresh",
      resetKey: "clerk:1:1",
      invalidate: vi.fn(),
    });
    // Now resolve the stale URL — the in-flight openConnection sees
    // the original demand has been removed and replaced. It must NOT
    // construct an EventSource pointing at the stale URL; the
    // *fresh* demand's openConnection (kicked off by subscribe)
    // wins.
    releaseStale!("/api/live-sync/stream?token=stale");
    await flush();

    // Exactly one EventSource, opened with the fresh URL.
    expect(_instances).toHaveLength(1);
    expect(_instances[0].url).toContain("token=fresh");
    expect(_instances[0].url).not.toContain("token=stale");
    u2();
  });
});
