// Task #971 — AF-specific Excel-import health pill. Backed by
// GET /api/freight-opportunities/import-health, polled every 60s.

import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type ImportHealthStatus = "ok" | "stale" | "failed";

export interface ImportHealthHistoryRow {
  id: string;
  createdAt: string;
  inserted: number;
  updated: number;
  expired: number;
  unmatchedCompanies: number;
  triggeredBy: string;
  fileName: string | null;
  error: string | null;
}

// Task #971 (rework #3) — scheduler / integration health surface
// returned alongside run history. Drives the "Integration: …" line in
// the pill panel so a credential / breaker failure is visible even when
// the importer hasn't logged a new run row yet.
export type IntegrationHealthState = "healthy" | "degraded" | "failed" | "unknown";

export interface ImportHealthIntegration {
  source: "onedrive";
  healthState: IntegrationHealthState;
  breakerState: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  snapshotAt: string | null;
}

export interface ImportHealthResponse {
  status: ImportHealthStatus;
  ageMinutes: number | null;
  lastImportAt: string | null;
  lastError: string | null;
  thresholds: { freshMinutes: number; failedMinutes: number };
  history: ImportHealthHistoryRow[];
  integration?: ImportHealthIntegration;
}

function integrationLabel(state: IntegrationHealthState): string {
  switch (state) {
    case "healthy": return "OneDrive healthy";
    case "degraded": return "OneDrive degraded";
    case "failed": return "OneDrive failing";
    case "unknown": return "OneDrive status unknown";
  }
}

function integrationToneClass(state: IntegrationHealthState): string {
  switch (state) {
    case "healthy": return "text-emerald-700 dark:text-emerald-300";
    case "degraded": return "text-amber-700 dark:text-amber-300";
    case "failed": return "text-red-700 dark:text-red-300";
    case "unknown": return "text-muted-foreground";
  }
}

function fmtAge(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  if (min < 60) return `${Math.max(0, Math.round(min))}m`;
  const h = min / 60;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function toneFor(status: ImportHealthStatus): { pill: string; dot: string; label: string } {
  switch (status) {
    case "ok":
      return {
        pill: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        dot: "bg-emerald-500",
        label: "Import healthy",
      };
    case "stale":
      return {
        pill: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        dot: "bg-amber-500",
        label: "Import degraded",
      };
    case "failed":
      return {
        pill: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
        dot: "bg-red-500",
        label: "Import failing",
      };
  }
}

function fmtRunTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export interface AfImportHealthPillProps {
  testId?: string;
}

export function AfImportHealthPill({
  testId = "pill-af-import-health",
}: AfImportHealthPillProps): JSX.Element {
  const { data } = useQuery<ImportHealthResponse>({
    queryKey: ["/api/freight-opportunities/import-health"],
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const status: ImportHealthStatus = data?.status ?? "stale";
  const tone = toneFor(status);
  const ageLabel = data?.ageMinutes != null ? `${fmtAge(data.ageMinutes)} ago` : "no imports yet";
  const history = data?.history ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium hover:opacity-90 ${tone.pill}`}
          data-testid={testId}
          data-import-health-status={status}
          aria-label={`${tone.label}; last import ${ageLabel}`}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />
          <span>{tone.label}</span>
          <span className="text-[10px] opacity-80" data-testid={`${testId}-age`}>
            · {ageLabel}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-96 p-3 text-xs"
        data-testid={`${testId}-panel`}
      >
        <div className="font-semibold text-sm mb-1">Excel importer health</div>
        <div className="space-y-0.5 mb-2">
          <div>
            <span className="text-muted-foreground">Status:</span>{" "}
            <span className="font-medium" data-testid={`${testId}-panel-status`}>
              {tone.label}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Last import:</span>{" "}
            <span data-testid={`${testId}-panel-age`}>{ageLabel}</span>
          </div>
          {data?.lastError && (
            <div>
              <span className="text-muted-foreground">Last error:</span>{" "}
              <span
                className="text-red-600 dark:text-red-400"
                data-testid={`${testId}-panel-error`}
              >
                {data.lastError}
              </span>
            </div>
          )}
          {data?.integration && (
            <div data-testid={`${testId}-panel-integration`}>
              <span className="text-muted-foreground">Scheduler:</span>{" "}
              <span
                className={`font-medium ${integrationToneClass(data.integration.healthState)}`}
                data-integration-state={data.integration.healthState}
              >
                {integrationLabel(data.integration.healthState)}
              </span>
              {data.integration.breakerState === "open" && (
                <span className="ml-1 text-[10px] text-red-600 dark:text-red-400">
                  (breaker open)
                </span>
              )}
              {data.integration.lastErrorMessage && data.integration.healthState !== "healthy" && (
                <div
                  className="text-[10px] text-red-600 dark:text-red-400 truncate"
                  data-testid={`${testId}-panel-integration-error`}
                >
                  {data.integration.lastErrorMessage}
                </div>
              )}
            </div>
          )}
          {data?.thresholds && (
            <div className="text-[10px] text-muted-foreground">
              Fresh ≤ {data.thresholds.freshMinutes}m · Failed &gt; {data.thresholds.failedMinutes}m
            </div>
          )}
        </div>
        <div className="border-t pt-2">
          <div className="font-medium mb-1.5">Recent runs</div>
          {history.length === 0 ? (
            <div
              className="text-muted-foreground"
              data-testid={`${testId}-panel-history-empty`}
            >
              No imports recorded yet.
            </div>
          ) : (
            <ul className="space-y-1.5" data-testid={`${testId}-panel-history`}>
              {history.slice(0, 5).map((h) => (
                <li
                  key={h.id}
                  className="flex items-start gap-2"
                  data-testid={`${testId}-panel-history-${h.id}`}
                  data-history-status={h.error ? "failed" : "ok"}
                >
                  <span
                    className={`mt-1 inline-block h-1.5 w-1.5 rounded-full ${
                      h.error ? "bg-red-500" : "bg-emerald-500"
                    }`}
                    aria-hidden
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium tabular-nums">{fmtRunTime(h.createdAt)}</span>
                      <span className="text-[10px] text-muted-foreground">{h.triggeredBy}</span>
                    </div>
                    {h.error ? (
                      <div className="text-red-600 dark:text-red-400 truncate">{h.error}</div>
                    ) : (
                      <div className="text-muted-foreground tabular-nums">
                        +{h.inserted} new · {h.updated} updated · {h.expired} expired
                        {h.unmatchedCompanies > 0
                          ? ` · ${h.unmatchedCompanies} unmatched`
                          : ""}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
