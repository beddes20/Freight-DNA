// Shared, viewport-aware lane-signal cache.
//
// Multiple consumers (LWQ, Available Freight, Customer Quotes) request
// per-lane VOTRI/TRAC signals through this hook. Per-lane react-query keys
// (`["lane-signal", "<origin>|<destination>"]`) ensure that asking for the
// same lane from any page reuses the cached value with a 4-hour staleTime.
// Uncached lanes are coalesced via a microtask-batched flush so a screenful
// of new lanes still produces a single GET to /api/sonar/lane-signals.

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer } from "react";

export interface LaneSignalResult {
  origin: string;
  destination: string;
  qualifier: string;
  votri: number | null;
  votriWoW: number | null;
  signal: "hot" | "warm" | "stable" | "cool" | null;
  timestamp: string;
  isStale: boolean;
  lastSuccessfulPull?: string | null;
}

export type LaneSig = string;

/** "<origin city>|<destination city>" — matches the LWQ batch key format. */
export function laneSigKey(origin: string, destination: string): LaneSig {
  return `${origin}|${destination}`;
}

export function parseLaneSig(sig: LaneSig): { origin: string; destination: string } | null {
  const i = sig.indexOf("|");
  if (i <= 0 || i === sig.length - 1) return null;
  return { origin: sig.slice(0, i), destination: sig.slice(i + 1) };
}

const SIGNAL_STALE_MS = 4 * 60 * 60 * 1000;
const SIGNAL_GC_MS = 24 * 60 * 60 * 1000;

type Waiter = {
  resolve: (v: LaneSignalResult | null) => void;
  reject: (e: unknown) => void;
};

const pendingSigs = new Map<LaneSig, Waiter[]>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // Microtask gives all consumers within the current render frame a chance
  // to enqueue their sigs before the single fetch fires.
  queueMicrotask(() => {
    flushScheduled = false;
    void flushPending();
  });
}

async function flushPending(): Promise<void> {
  if (pendingSigs.size === 0) return;
  const sigs = Array.from(pendingSigs.keys());
  const waiters = new Map(pendingSigs);
  pendingSigs.clear();
  try {
    const valid = sigs.filter(s => parseLaneSig(s) !== null);
    if (valid.length === 0) {
      for (const ws of waiters.values()) for (const w of ws) w.resolve(null);
      return;
    }
    const lanesParam = valid.join(";");
    const res = await fetch(
      `/api/sonar/lane-signals?lanes=${encodeURIComponent(lanesParam)}`,
      { credentials: "include" },
    );
    const data = res.ok ? (await res.json() as { signals?: LaneSignalResult[] }) : { signals: [] };
    const map = new Map<LaneSig, LaneSignalResult>();
    for (const s of data.signals ?? []) {
      map.set(laneSigKey(s.origin, s.destination), s);
    }
    for (const [sig, ws] of waiters) {
      const result = map.get(sig) ?? null;
      for (const w of ws) w.resolve(result);
    }
  } catch (err) {
    for (const ws of waiters.values()) for (const w of ws) w.reject(err);
  }
}

function batchedFetchSig(sig: LaneSig): Promise<LaneSignalResult | null> {
  return new Promise<LaneSignalResult | null>((resolve, reject) => {
    let list = pendingSigs.get(sig);
    if (!list) {
      list = [];
      pendingSigs.set(sig, list);
    }
    list.push({ resolve, reject });
    scheduleFlush();
  });
}

function dedupeSigs(input: ReadonlyArray<LaneSig>): LaneSig[] {
  const seen = new Set<LaneSig>();
  const out: LaneSig[] = [];
  for (const s of input) {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Subscribe a set of lane signatures to the shared cache. Cached lanes
 * resolve from memory (no fetch); uncached lanes coalesce into a single
 * batched GET per microtask flush.
 */
export function useLaneSignals(laneSigs: ReadonlyArray<LaneSig>): {
  signals: Map<LaneSig, LaneSignalResult | null>;
  isLoading: boolean;
  isFetching: boolean;
} {
  const sigs = useMemo(() => dedupeSigs(laneSigs), [laneSigs.join(",")]);

  const queries = useQueries({
    queries: sigs.map(sig => ({
      queryKey: ["lane-signal", sig] as const,
      queryFn: () => batchedFetchSig(sig),
      staleTime: SIGNAL_STALE_MS,
      gcTime: SIGNAL_GC_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    })),
  });

  const signals = useMemo(() => {
    const m = new Map<LaneSig, LaneSignalResult | null>();
    sigs.forEach((sig, i) => {
      const data = queries[i]?.data;
      if (data !== undefined) m.set(sig, data);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigs, queries.map(q => q.dataUpdatedAt).join(",")]);

  return {
    signals,
    isLoading: queries.some(q => q.isLoading),
    isFetching: queries.some(q => q.isFetching),
  };
}

/**
 * Read-only snapshot of every currently-cached lane signal. Subscribes to
 * the react-query cache so callers re-render as new signals fill in.
 * Triggers no fetches — pair with `useLaneSignals(...)` elsewhere on the
 * page when you want to seed the cache.
 */
export function useCachedLaneSignals(): Map<LaneSig, LaneSignalResult> {
  const qc = useQueryClient();
  const [, force] = useReducer((x: number) => (x + 1) | 0, 0);

  useEffect(() => {
    let pendingId: number | null = null;
    let usedRaf = false;
    const hasRaf = typeof requestAnimationFrame === "function";
    const schedule = () => {
      if (pendingId !== null) return;
      if (hasRaf) {
        usedRaf = true;
        pendingId = requestAnimationFrame(() => {
          pendingId = null;
          force();
        });
      } else {
        usedRaf = false;
        pendingId = setTimeout(() => {
          pendingId = null;
          force();
        }, 16) as unknown as number;
      }
    };
    const unsub = qc.getQueryCache().subscribe(event => {
      const k = (event as { query?: { queryKey?: unknown } }).query?.queryKey;
      if (Array.isArray(k) && k[0] === "lane-signal") schedule();
    });
    return () => {
      unsub();
      if (pendingId !== null) {
        if (usedRaf && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(pendingId);
        } else {
          clearTimeout(pendingId as unknown as ReturnType<typeof setTimeout>);
        }
        pendingId = null;
      }
    };
  }, [qc]);

  const map = new Map<LaneSig, LaneSignalResult>();
  for (const q of qc.getQueryCache().getAll()) {
    const k = q.queryKey;
    if (
      Array.isArray(k)
      && k[0] === "lane-signal"
      && typeof k[1] === "string"
      && q.state.data
    ) {
      map.set(k[1], q.state.data as LaneSignalResult);
    }
  }
  return map;
}

// Test-only hooks. Exposed because the shared cache is module-scoped so
// each playwright spec must be able to reset state between cases.
export const __testing__ = {
  reset(): void {
    pendingSigs.clear();
    flushScheduled = false;
  },
  pendingCount(): number {
    return pendingSigs.size;
  },
};
