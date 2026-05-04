/**
 * Task #973 — Active-connection registry contracts.
 *
 * Two invariants that *must* hold for the SSE registry to actually
 * stop the prod "100 phantom sockets per tab" pathology:
 *
 *  1. Same-tab supersede: a fresh connect from the same (userId, tabId)
 *     immediately closes the prior socket — without it, every reconnect
 *     would leak a fd until the kernel killed us.
 *  2. Per-user cap: when a single user opens more than the cap, the
 *     oldest connection is evicted; total active count for that user
 *     never exceeds the cap regardless of how many opens we do.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerActiveConnection,
  _resetLiveSyncMetricsForTests,
  _getActiveConnectionsForTests,
  LIVE_SYNC_MAX_CONNS_PER_USER,
  isConnectRateLimited,
  recordConnectAttempt,
  LIVE_SYNC_CONNECT_RATE_LIMIT,
} from "../services/liveSync";

interface Conn {
  userId: string;
  orgId: string;
  tabId: string;
  openedAt: number;
  close: ReturnType<typeof vi.fn>;
}

function makeConn(userId: string, tabId: string, openedAt: number, orgId = "org-1"): Conn {
  return { userId, orgId, tabId, openedAt, close: vi.fn() };
}

describe("registerActiveConnection — same-tab supersede", () => {
  beforeEach(() => _resetLiveSyncMetricsForTests());

  it("closes the prior socket for the same (userId, tabId) and replaces it", () => {
    const first = makeConn("u1", "tab-A", 1_000);
    const release1 = registerActiveConnection(first);
    expect(_getActiveConnectionsForTests()).toHaveLength(1);

    const second = makeConn("u1", "tab-A", 2_000);
    const release2 = registerActiveConnection(second);

    // Prior socket got close("superseded-by-same-tab"), the registry
    // contains only the fresh one.
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledWith("superseded-by-same-tab");
    const active = _getActiveConnectionsForTests();
    expect(active).toHaveLength(1);
    expect(active[0].openedAt).toBe(2_000);

    release1(); // idempotent — already removed during supersede.
    release2();
    expect(_getActiveConnectionsForTests()).toHaveLength(0);
  });

  it("treats different tabIds as independent — no supersede across tabs", () => {
    const a = makeConn("u1", "tab-A", 1_000);
    const b = makeConn("u1", "tab-B", 2_000);
    registerActiveConnection(a);
    registerActiveConnection(b);
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    expect(_getActiveConnectionsForTests()).toHaveLength(2);
  });
});

describe("registerActiveConnection — per-user cap", () => {
  beforeEach(() => _resetLiveSyncMetricsForTests());

  it("never exceeds LIVE_SYNC_MAX_CONNS_PER_USER even under flood", () => {
    const conns: Conn[] = [];
    // Open cap+5 distinct tabs in monotonically increasing order so the
    // oldest is unambiguous.
    for (let i = 0; i < LIVE_SYNC_MAX_CONNS_PER_USER + 5; i++) {
      const c = makeConn("u1", `tab-${i}`, 1_000 + i);
      conns.push(c);
      registerActiveConnection(c);
    }

    const active = _getActiveConnectionsForTests();
    expect(active).toHaveLength(LIVE_SYNC_MAX_CONNS_PER_USER);

    // The first 5 (oldest) must have been evicted with the cap reason.
    for (let i = 0; i < 5; i++) {
      expect(conns[i].close).toHaveBeenCalledWith("per-user-cap");
    }
    // The newest cap entries must still be open.
    for (let i = 5; i < LIVE_SYNC_MAX_CONNS_PER_USER + 5; i++) {
      expect(conns[i].close).not.toHaveBeenCalled();
    }
  });

  it("isolates the cap per user — flooding one user does not evict another", () => {
    // Flood u1 to the cap.
    for (let i = 0; i < LIVE_SYNC_MAX_CONNS_PER_USER; i++) {
      registerActiveConnection(makeConn("u1", `tab-${i}`, 1_000 + i));
    }
    // u2 opens one — must survive.
    const u2 = makeConn("u2", "tab-only", 99_999);
    registerActiveConnection(u2);
    // Push u1 over the cap once more.
    registerActiveConnection(makeConn("u1", "tab-extra", 100_000));

    expect(u2.close).not.toHaveBeenCalled();
    const active = _getActiveConnectionsForTests();
    const u1Count = active.filter((c) => c.userId === "u1").length;
    const u2Count = active.filter((c) => c.userId === "u2").length;
    expect(u1Count).toBe(LIVE_SYNC_MAX_CONNS_PER_USER);
    expect(u2Count).toBe(1);
  });
});

describe("isConnectRateLimited / recordConnectAttempt — per-fingerprint", () => {
  beforeEach(() => _resetLiveSyncMetricsForTests());

  it("allows the first `burst` attempts and rejects the (burst+1)th", () => {
    const fp = "abc12345…wxyz";
    const burst = LIVE_SYNC_CONNECT_RATE_LIMIT.burst;
    for (let i = 0; i < burst; i++) {
      expect(isConnectRateLimited(fp)).toBe(false);
      recordConnectAttempt(fp);
    }
    // After burst attempts inside the window, the next call is rejected.
    expect(isConnectRateLimited(fp)).toBe(true);
  });

  it("isolates fingerprints — one bad client cannot rate-limit another user", () => {
    const noisy = "noisy-fp";
    const calm = "calm-fp";
    const burst = LIVE_SYNC_CONNECT_RATE_LIMIT.burst;
    for (let i = 0; i < burst + 5; i++) recordConnectAttempt(noisy);
    expect(isConnectRateLimited(noisy)).toBe(true);
    // The calm user has had no attempts and must not be affected.
    expect(isConnectRateLimited(calm)).toBe(false);
    recordConnectAttempt(calm);
    expect(isConnectRateLimited(calm)).toBe(false);
  });

  it("clears the limit after the window passes (timestamp-based prune)", () => {
    const fp = "stale-burst";
    const burst = LIVE_SYNC_CONNECT_RATE_LIMIT.burst;
    const past = Date.now() - LIVE_SYNC_CONNECT_RATE_LIMIT.windowMs - 1_000;
    for (let i = 0; i < burst; i++) recordConnectAttempt(fp, past);
    // Now-time check sees only stale entries → not limited.
    expect(isConnectRateLimited(fp)).toBe(false);
  });
});
