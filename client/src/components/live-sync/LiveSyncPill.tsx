// Task #967 — Shared live-sync health pill.
//
// One pill, one signal, one tooltip — mounted in the page-header strip
// of every ops tab so reps can answer "is my screen still updating in
// real time?" without context-switching to dev-tools. Backed by the
// `useLiveSyncStatus()` selector in `client/src/hooks/useLiveSync.ts`,
// which is fed by the singleton EventSource that the app shell already
// mounts.
//
// State → presentation:
//
//   live        → green dot + "Live"
//   stale       → amber dot + "Stale (Xm)"
//   connecting  → yellow pulsing dot + "Connecting…"
//   disabled    → muted dot + "Live sync off"
//   idle        → muted dot + "Connecting…" (the pre-first-mount window
//                 is rare enough that we collapse it into "Connecting…"
//                 to avoid a third inactive label)
//
// The pill is a button on purpose — clicking opens the tooltip on touch
// devices. Keyboard focus picks it up so the same diagnostics are
// reachable without a mouse.

import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useLiveSyncStatus,
  type LiveSyncConnectionState,
} from "@/hooks/useLiveSync";

interface PillCopy {
  label: string;
  dotClassName: string;
  ariaLabel: string;
}

function pillCopyFor(
  state: LiveSyncConnectionState,
  staleAgeMs: number | null,
): PillCopy {
  switch (state) {
    case "live":
      return {
        label: "Live",
        dotClassName: "bg-emerald-500",
        ariaLabel: "Live sync is connected",
      };
    case "stale": {
      const minutes = staleAgeMs != null ? Math.max(1, Math.round(staleAgeMs / 60_000)) : null;
      return {
        label: minutes ? `Stale (${minutes}m)` : "Stale",
        dotClassName: "bg-amber-500",
        ariaLabel: minutes ? `Live sync is stale; no updates for ${minutes} minute${minutes === 1 ? "" : "s"}` : "Live sync is stale",
      };
    }
    case "connecting":
    case "idle":
      return {
        label: "Connecting…",
        dotClassName: "bg-yellow-400 animate-pulse",
        ariaLabel: "Live sync is connecting",
      };
    case "disabled":
      return {
        label: "Live sync off",
        dotClassName: "bg-muted-foreground",
        ariaLabel: "Live sync is off",
      };
  }
}

function formatAgo(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export interface LiveSyncPillProps {
  /** Per-surface test-id suffix so multiple pills on one page stay unique. */
  testId?: string;
  className?: string;
}

export function LiveSyncPill({ testId, className }: LiveSyncPillProps): JSX.Element {
  const status = useLiveSyncStatus();
  const now = Date.now();
  const staleAge =
    status.state === "stale" && status.lastEventAt != null
      ? now - status.lastEventAt
      : null;
  const copy = useMemo(() => pillCopyFor(status.state, staleAge), [status.state, staleAge]);

  const rootTestId = testId ?? "pill-live-sync";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={
              "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
              (className ?? "")
            }
            data-testid={rootTestId}
            data-live-sync-state={status.state}
            aria-label={copy.ariaLabel}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${copy.dotClassName}`}
              aria-hidden
            />
            <span>{copy.label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="text-xs">
          <div className="font-medium mb-1" data-testid={`${rootTestId}-tooltip-title`}>
            Cross-tab live updates
          </div>
          <div className="space-y-0.5 text-[11px]">
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <span className="font-medium" data-testid={`${rootTestId}-tooltip-state`}>
                {copy.label}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Last event:</span>{" "}
              <span data-testid={`${rootTestId}-tooltip-last-event`}>
                {status.lastEventAt ? formatAgo(now - status.lastEventAt) : "never"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Last connect:</span>{" "}
              <span data-testid={`${rootTestId}-tooltip-last-connect`}>
                {status.lastConnectAt ? formatAgo(now - status.lastConnectAt) : "never"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Topics seen:</span>{" "}
              <span data-testid={`${rootTestId}-tooltip-topics`}>
                {status.topicsSeen.size === 0 ? "none" : status.topicsSeen.size}
              </span>
            </div>
            {status.polledFallbackActive && (
              // Task #968 — explicit "your screen is still updating, just
              // via a polled refetch instead of SSE" trust-cue. Surfaces
              // when the page-side fallback loop is running.
              <div
                className="mt-1 pt-1 border-t border-border/50 text-amber-600 dark:text-amber-400"
                data-testid={`${rootTestId}-tooltip-fallback`}
              >
                Polling fallback active (30s)
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
