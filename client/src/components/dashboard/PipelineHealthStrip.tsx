// Phase 1.5 S9 — Top-of-dashboard "Pipeline health" trust strip.
//
// Compact read-only summary of the three trustworthy freshness signals
// already wired in earlier slices:
//
//   - Financials       — financial_uploads.uploadedAt (S8)
//   - Recommendations  — nba_cards.createdAt (S7)
//   - Freight          — load_fact_import_{morning,afternoon} heartbeats (S2/S3)
//
// Three states (mirror AsOfLabel + decidePortletState vocabulary):
//   - ok       → green dot, no banner tone
//   - stale    → amber dot, plain copy ("Stale — last refresh ...")
//   - unknown  → neutral grey dot, italic ("Freshness unavailable")
//
// Task #1109a invariant: unknown is NEVER painted as stale (no amber tone
// on the unknown branch).
//
// Role-awareness (per brief): hidden for logistics roles whose dashboards
// don't surface these data sources; shown to everyone else (the brief
// explicitly directs us to start uniform across non-logistics roles and
// only widen rules if needed).
import { useQuery } from "@tanstack/react-query";
import type { PortletFreshness } from "@shared/schema";

export interface DashboardHealth {
  financials: PortletFreshness | null;
  nba: PortletFreshness | null;
  freight: PortletFreshness | null;
}

interface PipelineHealthStripProps {
  /** Hide the strip for logistics roles whose dashboards don't surface
   *  these data sources. While auth is still loading (`role === undefined`)
   *  we ALSO hide — never render the strip for an unknown role, otherwise
   *  a logistics user briefly sees + fetches the strip on first paint. */
  role?: string | null;
}

const ROLE_HIDDEN = new Set(["logistics_manager", "logistics_coordinator"]);

/** Hidden when role is logistics OR while auth is still resolving (no role yet).
 *  This is the architect-flagged "treat undefined as pending/hidden" rule
 *  — see review note for Phase 1.5 S9. */
function isStripHidden(role: string | null | undefined): boolean {
  if (!role) return true;
  return ROLE_HIDDEN.has(role);
}

const SOURCE_DISPLAY: Array<{
  key: keyof DashboardHealth;
  label: string;
  testIdSuffix: string;
}> = [
  { key: "financials", label: "Financials", testIdSuffix: "financials" },
  { key: "nba", label: "Recommendations", testIdSuffix: "nba" },
  { key: "freight", label: "Freight", testIdSuffix: "freight" },
];

function relativeTimeFrom(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const ageMs = Date.now() - ms;
  if (ageMs < 0) return null;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function statusFor(freshness: PortletFreshness | null | undefined): "ok" | "stale" | "unknown" {
  if (!freshness) return "unknown";
  if (freshness.status === "stale") return "stale";
  if (freshness.status === "unknown") return "unknown";
  return "ok";
}

export function PipelineHealthStrip({ role }: PipelineHealthStripProps) {
  const isHidden = isStripHidden(role);

  const { data, isLoading, isError } = useQuery<DashboardHealth>({
    queryKey: ["/api/dashboard/health"],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    enabled: !isHidden,
  });

  if (isHidden) return null;

  // While loading, render a stable shell so the strip's vertical position
  // doesn't jitter — matches the sync-alert area's quiet skeleton style.
  if (isLoading) {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs"
        data-testid="pipeline-health-strip-loading"
      >
        <span className="font-medium text-muted-foreground">Pipeline health</span>
        <span className="text-muted-foreground italic">Checking…</span>
      </div>
    );
  }

  // Top-level fetch failure — collapse to unknown, never painting amber.
  if (isError || !data) {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs"
        data-testid="pipeline-health-strip"
        data-strip-overall="unknown"
      >
        <span className="font-medium text-muted-foreground">Pipeline health</span>
        <span className="text-muted-foreground italic" data-testid="pipeline-health-fallback">
          Freshness unavailable
        </span>
      </div>
    );
  }

  // Overall pill = worst-of-three for a quick glance, BUT we still render
  // every per-source chip so reps can see which signal is degraded.
  const states = SOURCE_DISPLAY.map((s) => statusFor(data[s.key]));
  const overall: "ok" | "stale" | "unknown" = states.includes("stale")
    ? "stale"
    : states.every((s) => s === "ok")
    ? "ok"
    : "unknown";

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs"
      data-testid="pipeline-health-strip"
      data-strip-overall={overall}
    >
      <span className="font-medium text-foreground/80">Pipeline health</span>
      {SOURCE_DISPLAY.map(({ key, label, testIdSuffix }) => {
        const fr = data[key];
        const state = statusFor(fr);
        const dotTone =
          state === "stale"
            ? "bg-amber-500"
            : state === "unknown"
            ? "bg-muted-foreground/40"
            : "bg-emerald-500";
        const labelTone =
          state === "stale"
            ? "text-amber-700 dark:text-amber-300"
            : state === "unknown"
            ? "text-muted-foreground italic"
            : "text-foreground/80";
        const rel = relativeTimeFrom(fr?.lastUpdatedAt);
        let suffix: string | null = null;
        if (state === "ok" && rel) suffix = rel;
        else if (state === "stale") suffix = rel ? `Stale — last refresh ${rel}` : "Stale";
        else if (state === "unknown") suffix = "Freshness unavailable";

        return (
          <span
            key={key}
            className="inline-flex items-center gap-1.5"
            data-testid={`pipeline-health-${testIdSuffix}`}
            data-source-state={state}
          >
            <span className={`h-2 w-2 rounded-full ${dotTone}`} aria-hidden="true" />
            <span className="font-medium text-foreground/70">{label}</span>
            {suffix && <span className={labelTone}>{suffix}</span>}
          </span>
        );
      })}
    </div>
  );
}
