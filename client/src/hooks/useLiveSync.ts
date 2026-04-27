// Cross-tab UX (option A) — opens a single SSE connection to
// /api/live-sync/stream and invalidates the matching React Query keys when
// events arrive. Pairs with `server/services/liveSync.ts` and
// `server/routes/liveSync.ts`.
//
// Mount this once near the top of the authenticated app shell. Calling it
// from multiple components is harmless (it just opens multiple
// connections), but wasteful — one mount is enough.
//
// Topic → query-key invalidation map:
//   The values are PREFIXES — TanStack Query's `invalidateQueries` matches
//   any cached query whose key starts with the same array. That keeps the
//   table tiny while still catching keys like
//   `["/api/customer-quotes/list", filterQs]` or
//   `["/api/carrier-hub", carrierId]`.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

// Every topic also invalidates `/api/lane-inbox` so the unified feed updates
// in real time without per-page wiring. The inbox endpoint is cheap and
// already capped, so we don't worry about thundering-herd refreshes.
const LANE_INBOX_KEY = ["/api/lane-inbox"] as const;

// Today's Priorities (the daily workspace) is sensitive to almost every
// signal-producing surface — quotes answered, lanes claimed, carrier outreach
// completed, freight opportunities resolved. Including it in each topic's
// invalidation list keeps the page live without adding per-write hooks.
const DAILY_WORKSPACE_KEY = ["/api/nba/daily-workspace"] as const;

const TOPIC_TO_QUERY_KEYS: Record<string, ReadonlyArray<ReadonlyArray<string>>> = {
  freight_opportunity: [
    ["/api/freight-opportunities/cockpit"],
    ["/api/freight-opportunities"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  recurring_lane: [
    ["/api/recurring-lanes/work-queue"],
    ["/api/recurring-lanes"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  carrier_outreach: [
    ["/api/carrier-hub"],
    ["/api/recurring-lanes/work-queue"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  customer_quote: [
    ["/api/customer-quotes/snapshot"],
    ["/api/customer-quotes/list"],
    ["/api/customer-quotes/action-queue"],
    // A quote outcome edit can also drop a quote out of (or back into) the
    // stale-followup window, so refresh the badge + page list on every
    // customer_quote event without waiting for the dedicated topic to fire.
    ["/api/customer-quotes/stale-followups"],
    ["/api/customer-quotes/stale-followups/count"],
    LANE_INBOX_KEY,
    DAILY_WORKSPACE_KEY,
  ],
  // Task #690 — fires when the per-org stale-followup membership changes
  // (a quote ages into the window, gets decided, or is reassigned). Keeps
  // the sidebar badge and the open Customer Quotes page in sync without
  // either side polling aggressively. The Customer Quotes page renders
  // its stale-followups module from the snapshot endpoint (not the list
  // endpoint), so include the snapshot key here as well.
  customer_quote_followup: [
    ["/api/customer-quotes/stale-followups"],
    ["/api/customer-quotes/stale-followups/count"],
    ["/api/customer-quotes/snapshot"],
    DAILY_WORKSPACE_KEY,
  ],
  carrier: [
    ["/api/carrier-hub"],
    ["/api/carriers"],
  ],
  daily_workspace: [
    DAILY_WORKSPACE_KEY,
  ],
};

// Topics that ship a per-company `key` and need per-company caches
// refreshed in addition to the topic-wide prefixes above. Touchpoint POSTs
// respond before background AI/growth-score work finishes; the trailing
// `daily_workspace` event is what surfaces those updates per company.
const PER_COMPANY_TOPICS: ReadonlySet<string> = new Set(["daily_workspace"]);
const buildPerCompanyKeys = (companyId: string): ReadonlyArray<ReadonlyArray<string>> => [
  ["/api/companies", companyId, "growth-score"],
  ["/api/companies", companyId, "next-best-action"],
  ["/api/companies", companyId, "touchpoints"],
  ["/api/companies", companyId, "touch-logs"],
  ["/api/nba/company", companyId, "card"],
  ["/api/tasks"],
  ["/api/tasks/company", companyId],
];

interface LiveSyncEvent {
  type?: string;
  topic?: string;
  key?: string;
  ts?: number;
}

export function useLiveSync(topics?: ReadonlyArray<string>): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Skip in non-browser environments (defensive — this hook only runs in
    // the browser, but TS narrowing protects SSR setups too).
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let mounted = true;

    const open = () => {
      if (!mounted) return;
      // EventSource sends the session cookie automatically when same-origin,
      // which is the case in dev and prod. `withCredentials` is only needed
      // for cross-origin streams; setting it here is harmless either way.
      es = new EventSource("/api/live-sync/stream", { withCredentials: true });

      es.onmessage = (msg) => {
        let evt: LiveSyncEvent;
        try {
          evt = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (!evt || evt.type === "hello" || !evt.topic) return;
        if (topics && !topics.includes(evt.topic)) return;

        const keyPrefixes = TOPIC_TO_QUERY_KEYS[evt.topic];
        if (!keyPrefixes) return;
        for (const prefix of keyPrefixes) {
          // Cast: invalidateQueries accepts a readonly key, but the type
          // signature here expects a mutable array. The runtime ignores
          // mutability, so the cast is safe.
          queryClient.invalidateQueries({ queryKey: prefix as unknown as unknown[] });
        }
        if (evt.key && PER_COMPANY_TOPICS.has(evt.topic)) {
          for (const prefix of buildPerCompanyKeys(evt.key)) {
            queryClient.invalidateQueries({ queryKey: prefix as unknown as unknown[] });
          }
        }
      };

      es.onerror = () => {
        // EventSource re-connects on its own when readyState !== CLOSED.
        // If the browser actually closed the stream (auth expired, server
        // down), back off briefly and try again — one tab going stale would
        // defeat the whole purpose of live sync.
        if (es?.readyState === EventSource.CLOSED && mounted && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            open();
          }, 2_000);
        }
      };
    };

    open();

    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
    // The topics array is intentionally not in the dep list — callers pass a
    // static array and we want one connection per mount, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
