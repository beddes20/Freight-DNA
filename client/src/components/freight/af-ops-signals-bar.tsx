// Task #1024 — Available Freight ops-signals bar.
//
// Lightweight link-out pills for Action / Coverage modes. The cockpit
// owns SIGNALS (status + counts) only; the dedicated ops surfaces
// (admin imports page, leak console, Ops mode) own the full controls
// and configuration. Keeping these pills tiny and same-weight prevents
// them from competing with the primary triage actions.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ShieldAlert, Truck, EyeOff, Activity } from "lucide-react";
import type { ImportHealthResponse, ImportHealthStatus } from "./af-import-health-pill";

export interface AfOpsSignalsBarProps {
  /** Number of rows hidden under the current scope (totalInScope - visible). */
  hiddenCount: number;
  /** Active mode (used to build the hidden-loads link target). */
  opsModeHref: string;
  /** Manager scope — gates the leak-count pill. */
  isManagerScope: boolean;
  /** Optional carrier-id deep-link to preserve when jumping into Ops mode. */
  preservedSearch?: string;
  testId?: string;
}

interface AutoPilotPreviewLite {
  totalCompanies: number;
  totalCarriers: number;
}

interface LeakKpiLite {
  counts: {
    noContactableUnderDemand: number;
    unstableSpotDeployed: number;
    recurringCoveredOnSpot: number;
    ownedUntouchedUnderPressure: number;
  };
}

function healthTone(status: ImportHealthStatus | undefined): { dot: string; label: string; pill: string } {
  switch (status) {
    case "ok":
      return {
        dot: "bg-emerald-500",
        label: "Health OK",
        pill: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
      };
    case "stale":
      return {
        dot: "bg-amber-500",
        label: "Health degraded",
        pill: "border-amber-500/40 text-amber-700 dark:text-amber-300",
      };
    case "failed":
      return {
        dot: "bg-red-500",
        label: "Health failing",
        pill: "border-red-500/40 text-red-700 dark:text-red-300",
      };
    default:
      return {
        dot: "bg-muted-foreground",
        label: "Health unknown",
        pill: "border-border text-muted-foreground",
      };
  }
}

const PILL_BASE =
  "inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium hover-elevate transition-colors";

export function AfOpsSignalsBar({
  hiddenCount,
  opsModeHref,
  isManagerScope,
  testId = "bar-af-ops-signals",
}: AfOpsSignalsBarProps): JSX.Element {
  const { data: health } = useQuery<ImportHealthResponse>({
    queryKey: ["/api/freight-opportunities/import-health"],
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const { data: ap } = useQuery<AutoPilotPreviewLite>({
    queryKey: ["/api/freight-opportunities/auto-pilot/preview"],
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const { data: leaks } = useQuery<LeakKpiLite>({
    queryKey: ["/api/leak-console/kpi"],
    enabled: isManagerScope,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const tone = healthTone(health?.status);
  const apOn = (ap?.totalCompanies ?? 0) > 0;
  const apQueued = ap?.totalCarriers ?? 0;
  const leakTotal = leaks
    ? leaks.counts.noContactableUnderDemand +
      leaks.counts.unstableSpotDeployed +
      leaks.counts.recurringCoveredOnSpot +
      leaks.counts.ownedUntouchedUnderPressure
    : 0;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid={testId}
      role="group"
      aria-label="Available Freight ops signals"
    >
      <Link href="/admin/available-freight/imports">
        <a
          className={`${PILL_BASE} ${tone.pill}`}
          data-testid="pill-signal-health"
          data-import-health-status={health?.status ?? "unknown"}
          title={`${tone.label} — open import history`}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
          <Activity className="h-3 w-3" />
          <span>{tone.label}</span>
        </a>
      </Link>

      <Link href={opsModeHref}>
        <a
          className={`${PILL_BASE} text-muted-foreground`}
          data-testid="pill-signal-hidden"
          data-hidden-count={hiddenCount}
          title="Open Ops & health for the full hidden-loads breakdown"
          aria-disabled={hiddenCount === 0 ? "true" : undefined}
        >
          <EyeOff className="h-3 w-3" />
          <span>Hidden {hiddenCount}</span>
        </a>
      </Link>

      <Link href={opsModeHref}>
        <a
          className={`${PILL_BASE} ${apOn ? "text-foreground" : "text-muted-foreground"}`}
          data-testid="pill-signal-auto-pilot"
          data-auto-pilot-on={apOn}
          data-auto-pilot-queued={apQueued}
          title="Open Ops & health for the auto-pilot preview"
        >
          <Truck className="h-3 w-3" />
          <span>
            Auto-pilot: {apOn ? "on" : "off"}
            {apOn ? ` · ${apQueued} queued` : ""}
          </span>
        </a>
      </Link>

      {isManagerScope && (
        <Link href="/leak-console">
          <a
            className={`${PILL_BASE} ${leakTotal > 0 ? "border-amber-500/40 text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
            data-testid="pill-signal-leaks"
            data-leak-count={leakTotal}
            title="Open Leak Console"
          >
            <ShieldAlert className="h-3 w-3" />
            <span>Leaks {leakTotal}</span>
          </a>
        </Link>
      )}
    </div>
  );
}
