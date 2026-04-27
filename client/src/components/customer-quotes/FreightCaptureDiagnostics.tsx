/**
 * Task #723 — Capture funnel diagnostics (admin-only).
 *
 * A collapsible panel that surfaces the plumbing behind the Freight Capture
 * page so admins can answer "why aren't we seeing decisions?" without
 * digging through server logs:
 *   - Last TMS sync: scanned / exact-matched / probable / unchanged
 *   - Email classifier (last 14d): inbound replies that landed Won / Lost
 *     / neither, scoped to the same filter slice as the funnel
 *   - Top "near-miss" TMS candidates the looser matcher flagged but didn't
 *     auto-flip — usually surfaces a customer-name typo or alias gap
 *
 * Mounted only for admin / director / sales_director (page-level RBAC plus
 * a server 403). Renders nothing for other roles even if accidentally
 * imported on a shared route.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, AlertCircle, Wrench } from "lucide-react";
import type { FunnelFilters } from "./FreightCaptureFunnel";

type SyncStats = {
  ranAt: string;
  scanned: number;
  exactMatches: number;
  aliasMatches: number;
  probable: number;
  noMatch: number;
  won: number;
  lost: number;
  expired: number;
  unchanged: number;
};

type ProbableCandidate = {
  quoteId: string;
  customerName: string;
  lane: string;
  requestDate: string;
  factOrderId: string | null;
  factCustomerName: string | null;
  factPickupDate: string | null;
  factBucket: string;
  reason: string;
};

type DiagnosticsResult = {
  scopedToRepId: string | null;
  lastSync: SyncStats | null;
  emailClassifier: { windowDays: number; won: number; lost: number; neither: number };
  nearMissCandidates: ProbableCandidate[];
};

interface Props {
  filters: FunnelFilters;
  /** Caller decides RBAC; we keep it explicit instead of pulling useAuth so
   *  this component is easy to test and embed in storybook fixtures. */
  enabled: boolean;
  /** Optional controlled open state — when provided, parent owns the
   *  open/close. Used by Task #723 review fix so the "Why they go quiet"
   *  card can pop the panel open via a footer link. When omitted the
   *  component falls back to its own internal state (the original behaviour). */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
}

function buildQs(f: FunnelFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

function fmtTs(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function FreightCaptureDiagnostics({ filters, enabled, open: openProp, onOpenChange }: Props): JSX.Element | null {
  const [openState, setOpenState] = useState<boolean>(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openState;
  const setOpen = (next: boolean | ((prev: boolean) => boolean)): void => {
    const value = typeof next === "function" ? next(open) : next;
    if (!isControlled) setOpenState(value);
    onOpenChange?.(value);
  };
  const qs = buildQs(filters);
  const queryKey = useMemo(() => ["/api/customer-quotes/funnel-diagnostics", filters] as const, [filters]);

  const { data, isLoading, isError, error } = useQuery<DiagnosticsResult>({
    queryKey,
    enabled: enabled && open,
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/funnel-diagnostics${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Diagnostics request failed (${res.status})`);
      return res.json() as Promise<DiagnosticsResult>;
    },
    staleTime: 30_000,
  });

  if (!enabled) return null;

  return (
    <Card data-testid="capture-diagnostics-card" className="border-dashed">
      <CardHeader className="pb-2">
        <button
          type="button"
          className="flex items-center justify-between w-full text-left"
          onClick={() => setOpen(o => !o)}
          data-testid="capture-diagnostics-toggle"
        >
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            Capture funnel diagnostics
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">Admin</Badge>
          </CardTitle>
          {open
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>
        {!open && (
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Show TMS-sync, email-classifier, and near-miss diagnostics for the current slice.
          </p>
        )}
      </CardHeader>

      {open && (
        <CardContent>
          {isLoading && (
            <div className="space-y-2" data-testid="capture-diagnostics-loading">
              <Skeleton className="h-16 w-full bg-card" />
              <Skeleton className="h-16 w-full bg-card" />
            </div>
          )}
          {isError && (
            <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs" data-testid="capture-diagnostics-error">
              <AlertCircle className="h-4 w-4" />
              <span>Could not load diagnostics: {error instanceof Error ? error.message : "Unknown error"}</span>
            </div>
          )}
          {data && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="capture-diagnostics-content">
              <DiagnosticTile title="Last TMS sync" testId="diag-sync">
                {data.lastSync ? (
                  <>
                    <div className="text-[11px] text-muted-foreground mb-1.5">
                      Ran {fmtTs(data.lastSync.ranAt)}
                    </div>
                    <KvGrid
                      items={[
                        { label: "Scanned", value: data.lastSync.scanned },
                        { label: "Exact match", value: data.lastSync.exactMatches },
                        { label: "Alias match", value: data.lastSync.aliasMatches },
                        { label: "Probable", value: data.lastSync.probable },
                        { label: "No match", value: data.lastSync.noMatch },
                        { label: "Flipped → won", value: data.lastSync.won },
                        { label: "Flipped → lost", value: data.lastSync.lost },
                        { label: "Flipped → expired", value: data.lastSync.expired },
                        { label: "Unchanged", value: data.lastSync.unchanged },
                      ]}
                    />
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground" data-testid="diag-sync-empty">
                    No TMS sync has run in this process yet.
                  </p>
                )}
              </DiagnosticTile>

              <DiagnosticTile title="Email classifier" testId="diag-email">
                <div className="text-[11px] text-muted-foreground mb-1.5">
                  Inbound replies on quote threads · last {data.emailClassifier.windowDays}d
                </div>
                <KvGrid
                  items={[
                    { label: "Classified Won", value: data.emailClassifier.won },
                    { label: "Classified Lost", value: data.emailClassifier.lost },
                    { label: "Neither (review)", value: data.emailClassifier.neither },
                  ]}
                />
              </DiagnosticTile>

              <DiagnosticTile title="Near-miss TMS candidates" testId="diag-nearmiss" wide>
                {data.nearMissCandidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="diag-nearmiss-empty">
                    No probable matches in this slice — the matcher is in agreement with itself.
                  </p>
                ) : (
                  <table className="w-full text-xs" data-testid="diag-nearmiss-table">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b border-border">
                        <th className="py-1 pr-2 font-medium">Quote customer</th>
                        <th className="py-1 px-1 font-medium">Probable TMS customer</th>
                        <th className="py-1 px-1 font-medium">Lane</th>
                        <th className="py-1 px-1 font-medium">TMS bucket</th>
                        <th className="py-1 pl-1 font-medium">Why probable</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.nearMissCandidates.map(c => (
                        <tr key={c.quoteId} className="border-b border-border/60 last:border-0" data-testid={`diag-nearmiss-row-${c.quoteId}`}>
                          <td className="py-1 pr-2 truncate max-w-[160px]">{c.customerName}</td>
                          <td className="py-1 px-1 truncate max-w-[160px] text-foreground/80">{c.factCustomerName ?? "—"}</td>
                          <td className="py-1 px-1 truncate max-w-[160px] text-muted-foreground">{c.lane}</td>
                          <td className="py-1 px-1 text-muted-foreground">{c.factBucket}</td>
                          <td className="py-1 pl-1 text-muted-foreground truncate max-w-[200px]" title={c.reason}>{c.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </DiagnosticTile>
            </div>
          )}
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
              data-testid="capture-diagnostics-close"
            >
              Hide
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

interface DiagnosticTileProps { title: string; children: React.ReactNode; testId: string; wide?: boolean; }
function DiagnosticTile({ title, children, testId, wide = false }: DiagnosticTileProps): JSX.Element {
  return (
    <div className={`rounded border border-border bg-card p-3 ${wide ? "md:col-span-2" : ""}`} data-testid={testId}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      {children}
    </div>
  );
}

interface KvGridProps { items: Array<{ label: string; value: number }>; }
function KvGrid({ items }: KvGridProps): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
      {items.map(it => (
        <div key={it.label} className="flex items-center justify-between" data-testid={`kv-${it.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
          <span className="text-muted-foreground">{it.label}</span>
          <span className="text-foreground font-medium tabular-nums">{it.value}</span>
        </div>
      ))}
    </div>
  );
}
