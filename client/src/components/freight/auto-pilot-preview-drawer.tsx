/**
 * Auto-pilot transparency drawer (Task #634).
 *
 * Side drawer launched from the Available Freight cockpit header. Shows every
 * (company, opportunity, top-N carriers, suggested rate) tuple the auto-pilot
 * scheduler would dispatch at the next CT hour, grouped by company with the
 * policy reference. Per-row actions:
 *   - Skip-this-run: one-time suppression for today's CT day.
 *   - Edit carriers: deep-link to the opportunity detail (existing flow).
 *   - Approve-now: reuses sendOpportunityWave with sourceModule "auto_pilot".
 *   - Disable policy: toggles autoSendEnabled off (with confirm).
 *
 * Header summary: "Next run at HH:mm CT · N companies · ~M carriers"
 * Empty state: "No customers are armed for auto-pilot right now."
 */

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle, ChevronDown, Inbox, PauseCircle, Pencil, Send, ShieldOff, Truck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface AutoPilotPreviewCarrier {
  rowId: string;
  carrierId: string;
  carrierName: string;
  rank: number | null;
  fitScore: number;
  bucket: string | null;
  explanation: string | null;
}
interface AutoPilotPreviewSuppressed {
  carrierId: string;
  carrierName: string;
  reason: string;
}
interface AutoPilotPreviewOpportunity {
  opportunityId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string;
  pickupWindowStart: string | null;
  loadCount: number;
  status: string;
  candidates: AutoPilotPreviewCarrier[];
  suppressed: AutoPilotPreviewSuppressed[];
  suggestedBuy: { rate: number | null; confidence: string; reason: string } | null;
}
interface AutoPilotPreviewCompany {
  companyId: string;
  companyName: string;
  policyId: string;
  nextRunAt: string;
  ctHour: number;
  topN: number;
  maxPerDay: number;
  approvalRequired: boolean;
  autoSendEnabled: boolean;
  blockedReason: string | null;
  totalCarriers: number;
  opportunities: AutoPilotPreviewOpportunity[];
}
interface AutoPilotPreviewResponse {
  nextRunAt: string | null;
  ctHour: number | null;
  totalCompanies: number;
  totalCarriers: number;
  companies: AutoPilotPreviewCompany[];
}

const PREVIEW_KEY = ["/api/freight-opportunities/auto-pilot/preview"] as const;

export function AutoPilotPreviewDrawer({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery<AutoPilotPreviewResponse>({
    queryKey: PREVIEW_KEY,
    enabled: open,
    refetchInterval: open ? 60_000 : false,
    staleTime: 30_000,
  });

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (companyId: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(companyId)) next.delete(companyId); else next.add(companyId);
    return next;
  });

  // ── Mutations ────────────────────────────────────────────────────────────
  const skipMutation = useMutation({
    mutationFn: async (companyId: string) => {
      const r = await apiRequest("POST", "/api/freight-opportunities/auto-pilot/skip", { companyId });
      return r.json();
    },
    onSuccess: (_, companyId) => {
      toast({ title: "Auto-pilot skipped for today", description: `Customer ${companyId.slice(0, 8)}…` });
      qc.invalidateQueries({ queryKey: PREVIEW_KEY });
    },
    onError: (e: Error) => toast({ title: "Couldn't skip", description: e.message, variant: "destructive" }),
  });

  const disableMutation = useMutation({
    mutationFn: async (companyId: string) => {
      const r = await apiRequest("POST", "/api/freight-opportunities/auto-pilot/disable", { companyId, confirm: true });
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Auto-pilot disabled" });
      qc.invalidateQueries({ queryKey: PREVIEW_KEY });
      qc.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't disable", description: e.message, variant: "destructive" }),
  });

  const approveNowMutation = useMutation({
    mutationFn: async (vars: { opportunityId: string; carrierRowIds: string[] }) => {
      const r = await apiRequest("POST", "/api/freight-opportunities/auto-pilot/approve-now", vars);
      return r.json();
    },
    onSuccess: (resp: { results?: Array<{ status: string }> }) => {
      const sent = (resp.results ?? []).filter(r => r.status === "sent" || r.status === "scheduled").length;
      toast({ title: "Carriers contacted", description: `${sent} carrier${sent === 1 ? "" : "s"} dispatched.` });
      qc.invalidateQueries({ queryKey: PREVIEW_KEY });
      qc.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't send", description: e.message, variant: "destructive" }),
  });

  const headerSummary = useMemo(() => {
    if (!data || data.totalCompanies === 0) return null;
    const next = data.nextRunAt ? new Date(data.nextRunAt) : null;
    const fmt = next
      ? new Intl.DateTimeFormat(undefined, {
        timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(next)
      : "—";
    return `Next run at ${fmt} CT · ${data.totalCompanies} ${data.totalCompanies === 1 ? "company" : "companies"} · ~${data.totalCarriers} carriers`;
  }, [data]);

  const handleSkip = (companyId: string, companyName: string) => {
    if (!window.confirm(`Skip the next auto-pilot run for ${companyName}? It will resume on the next CT day.`)) return;
    skipMutation.mutate(companyId);
  };
  const handleDisable = (companyId: string, companyName: string) => {
    if (!window.confirm(`Disable auto-pilot for ${companyName}? The policy stays but auto-send turns off until you re-enable it.`)) return;
    disableMutation.mutate(companyId);
  };
  const handleApproveNow = (opp: AutoPilotPreviewOpportunity) => {
    if (opp.candidates.length === 0) {
      toast({ title: "No carriers to send", variant: "destructive" });
      return;
    }
    if (!window.confirm(`Send to ${opp.candidates.length} carrier${opp.candidates.length === 1 ? "" : "s"} now for ${opp.origin} → ${opp.destination}?`)) return;
    approveNowMutation.mutate({
      opportunityId: opp.opportunityId,
      carrierRowIds: opp.candidates.map(c => c.rowId),
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-y-auto"
        data-testid="drawer-auto-pilot-preview"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" /> Auto-pilot preview
          </SheetTitle>
          <SheetDescription data-testid="text-auto-pilot-summary">
            {isLoading
              ? "Computing what auto-pilot will send next…"
              : headerSummary ?? "No customers are armed for auto-pilot right now."}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          {isError ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center" data-testid="state-auto-pilot-error">
              <AlertCircle className="h-8 w-8 text-destructive" />
              <p className="text-sm font-medium">Couldn't load preview</p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
            </div>
          ) : isLoading ? (
            <div className="space-y-2" data-testid="state-auto-pilot-loading">
              {[0, 1, 2].map(i => <Skeleton key={i} className="h-32 w-full" />)}
            </div>
          ) : !data || data.companies.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center" data-testid="state-auto-pilot-empty">
              <Inbox className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No customers are armed for auto-pilot</p>
                <p className="text-xs text-muted-foreground">
                  Enable a customer outreach policy with an auto-send hour to see it here.
                </p>
              </div>
            </div>
          ) : (
            data.companies.map(company => {
              const isCollapsed = collapsed.has(company.companyId);
              return (
                <Card key={company.companyId} data-testid={`card-auto-pilot-company-${company.companyId}`}>
                  <CardContent className="p-3 space-y-2">
                    <button
                      type="button"
                      className="w-full flex items-start justify-between gap-2 text-left"
                      onClick={() => toggleCollapsed(company.companyId)}
                      data-testid={`button-toggle-company-${company.companyId}`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <ChevronDown className={`h-4 w-4 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                          <span className="font-semibold text-sm" data-testid={`text-company-name-${company.companyId}`}>
                            {company.companyName}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {String(company.ctHour).padStart(2, "0")}:00 CT
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            top {company.topN}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            cap {company.maxPerDay}/day
                          </Badge>
                          {company.approvalRequired && (
                            <Badge variant="secondary" className="text-[10px]">approval gated</Badge>
                          )}
                          {company.blockedReason === "missing_actor" && (
                            <Badge variant="destructive" className="text-[10px]">no actor</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {company.opportunities.length} opportunit{company.opportunities.length === 1 ? "y" : "ies"} · {company.totalCarriers} carrier{company.totalCarriers === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 text-xs">
                        <span className="text-muted-foreground">policy {company.policyId.slice(0, 8)}…</span>
                      </div>
                    </button>

                    {/* Per-company actions */}
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <Button
                        size="sm" variant="outline"
                        onClick={() => handleSkip(company.companyId, company.companyName)}
                        disabled={skipMutation.isPending}
                        data-testid={`button-skip-company-${company.companyId}`}
                      >
                        <PauseCircle className="h-3 w-3 mr-1" /> Skip this run
                      </Button>
                      <Button
                        size="sm" variant="outline"
                        onClick={() => handleDisable(company.companyId, company.companyName)}
                        disabled={disableMutation.isPending}
                        data-testid={`button-disable-policy-${company.companyId}`}
                      >
                        <ShieldOff className="h-3 w-3 mr-1" /> Disable policy
                      </Button>
                    </div>

                    {!isCollapsed && (
                      <div className="space-y-2 pt-2">
                        {company.opportunities.map(opp => (
                          <div
                            key={opp.opportunityId}
                            className="rounded-md border bg-muted/20 p-2 space-y-2"
                            data-testid={`row-auto-pilot-opp-${opp.opportunityId}`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="space-y-0.5">
                                <div className="text-sm font-medium" data-testid={`text-opp-lane-${opp.opportunityId}`}>
                                  {opp.origin}{opp.originState ? `, ${opp.originState}` : ""} → {opp.destination}{opp.destinationState ? `, ${opp.destinationState}` : ""}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {opp.equipmentType} · {opp.loadCount} load{opp.loadCount === 1 ? "" : "s"}
                                  {opp.pickupWindowStart && (
                                    <> · pickup {new Date(opp.pickupWindowStart).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>
                                  )}
                                </div>
                                {opp.suggestedBuy && (
                                  <div className="text-xs" data-testid={`text-suggested-buy-${opp.opportunityId}`}>
                                    Suggested buy:{" "}
                                    {opp.suggestedBuy.rate !== null
                                      ? <span className="font-semibold">${opp.suggestedBuy.rate.toFixed(2)}/mi</span>
                                      : <span className="text-muted-foreground">not available</span>}
                                    <span className="text-muted-foreground"> · {opp.suggestedBuy.confidence}</span>
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-1">
                                <Link href={`/available-freight/${opp.opportunityId}`}>
                                  <Button
                                    size="sm" variant="outline"
                                    onClick={() => onOpenChange(false)}
                                    data-testid={`button-edit-carriers-${opp.opportunityId}`}
                                  >
                                    <Pencil className="h-3 w-3 mr-1" /> Edit carriers
                                  </Button>
                                </Link>
                                <Button
                                  size="sm"
                                  onClick={() => handleApproveNow(opp)}
                                  disabled={approveNowMutation.isPending || opp.candidates.length === 0}
                                  data-testid={`button-approve-now-${opp.opportunityId}`}
                                >
                                  <Send className="h-3 w-3 mr-1" /> Approve now
                                </Button>
                              </div>
                            </div>

                            {opp.candidates.length > 0 ? (
                              <ul className="space-y-1" data-testid={`list-candidates-${opp.opportunityId}`}>
                                {opp.candidates.map(c => (
                                  <li
                                    key={c.rowId}
                                    className="flex items-center justify-between gap-2 text-xs rounded border bg-background px-2 py-1"
                                    data-testid={`item-candidate-${c.rowId}`}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <Badge variant="outline" className="text-[10px]">
                                        #{c.rank ?? "?"}
                                      </Badge>
                                      <span className="truncate font-medium">{c.carrierName}</span>
                                      {c.bucket && (
                                        <span className="text-muted-foreground">· {c.bucket}</span>
                                      )}
                                    </div>
                                    <span className="text-muted-foreground tabular-nums">
                                      fit {Math.round(c.fitScore)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-xs text-muted-foreground italic">
                                No carriers will be sent (cap reached or none eligible).
                              </p>
                            )}

                            {opp.suppressed.length > 0 && (
                              <details className="text-xs">
                                <summary
                                  className="cursor-pointer text-muted-foreground"
                                  data-testid={`summary-suppressed-${opp.opportunityId}`}
                                >
                                  {opp.suppressed.length} suppressed
                                </summary>
                                <ul className="mt-1 space-y-0.5 pl-3">
                                  {opp.suppressed.map(s => (
                                    <li key={s.carrierId} className="text-muted-foreground">
                                      {s.carrierName} — {s.reason}
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
