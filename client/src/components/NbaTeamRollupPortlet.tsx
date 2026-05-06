import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChevronRight, ChevronDown, Activity, AlertTriangle, DollarSign, Eye, X } from "lucide-react";

interface PerAm {
  userId: string;
  userName: string;
  open: number;
  untouched3d: number;
  fired: number;
  actioned: number;
  dismissed: number;
  conversionRate: number;
  worked: number;
  dollarMoved: number;
  dismissReasons?: Array<{ reason: string; count: number }>;
}

interface Rollup {
  daysBack: number;
  perAm: PerAm[];
  dismissReasons: Array<{ reason: string; count: number }>;
  topUnworked: Array<{
    cardId: string; userId: string; userName: string;
    companyId: string | null; companyName: string | null;
    atStakeAmount: number; ruleType: string; ageDays: number;
  }>;
  totals: { open: number; untouched3d: number; conversionRate: number; dollarMoved: number; worked: number; fired: number };
}

interface RepFeedResponse {
  repId: string;
  repName: string;
  cards: Array<{ id: string; whyThisNow: string; suggestedAction: string; ruleType: string; outcomeType: string; status: string; atStakeAmount: string | null; createdAt: string; companyName?: string | null }>;
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  setLocation: (path: string) => void;
}

const RULE_LABEL: Record<string, string> = {
  stale_account: "Stale account",
  single_thread_risk: "Single-thread",
  recurring_lane_capacity: "Lane capacity",
  missed_inbound_call: "Missed call",
  relationship_decay: "Relationship",
  commitment_overdue: "Overdue commit",
};

function fmt$(v: number): string {
  if (!v) return "$0";
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 100) / 10}k`;
  return `$${Math.round(v)}`;
}

export function NbaTeamRollupPortlet({ collapsed, onToggle, setLocation }: Props) {
  const [drillRepId, setDrillRepId] = useState<string | null>(null);
  const { data, isLoading } = useQuery<Rollup>({
    queryKey: ["/api/nba/team-rollup"],
  });

  const { data: repFeed, isLoading: repFeedLoading } = useQuery<RepFeedResponse>({
    queryKey: ["/api/nba/team-rollup", drillRepId, "cards"],
    enabled: !!drillRepId,
  });

  return (
    <Card data-testid="nba-team-rollup-portlet">
      <CardHeader className="pb-3">
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-2 hover:opacity-80 transition-opacity"
          data-testid="button-toggle-nba-rollup"
        >
          {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-amber-500" />
            Team NBA rollup
          </CardTitle>
          <span className="ml-auto text-xs font-normal text-muted-foreground">last {data?.daysBack ?? 30}d</span>
        </button>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0 space-y-4">
          {isLoading ? (
            <div className="space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /></div>
          ) : !data || data.perAm.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3" data-testid="text-rollup-empty">
              No AMs in your scope, or no NBAs fired yet.
            </p>
          ) : (
            <>
              {/* Totals strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-md border p-2" data-testid="totals-open">
                  <div className="text-xs text-muted-foreground">Open</div>
                  <div className="text-lg font-bold">{data.totals.open}</div>
                </div>
                <div className="rounded-md border p-2" data-testid="totals-untouched">
                  <div className="text-xs text-muted-foreground">Untouched 3d+</div>
                  <div className="text-lg font-bold flex items-center gap-1">
                    {data.totals.untouched3d > 0 && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                    {data.totals.untouched3d}
                  </div>
                </div>
                <div className="rounded-md border p-2" data-testid="totals-conversion">
                  <div className="text-xs text-muted-foreground">Conversion</div>
                  <div className="text-lg font-bold">{Math.round(data.totals.conversionRate * 100)}%</div>
                </div>
                <div className="rounded-md border p-2" data-testid="totals-dollar-moved">
                  <div className="text-xs text-muted-foreground">$ moved</div>
                  <div className="text-lg font-bold flex items-center gap-1">
                    <DollarSign className="h-3.5 w-3.5 text-emerald-500" />
                    {fmt$(data.totals.dollarMoved)}
                  </div>
                </div>
              </div>

              {/* Per-AM table */}
              <div className="border rounded-md overflow-hidden">
                <div className="grid grid-cols-[1fr_60px_70px_70px_70px_70px] gap-2 px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/40">
                  <div>AM</div>
                  <div className="text-right">Open</div>
                  <div className="text-right">3d+</div>
                  <div className="text-right">Conv</div>
                  <div className="text-right">$ moved</div>
                  <div></div>
                </div>
                <div className="divide-y">
                  {data.perAm.map(am => (
                    <div key={am.userId} className="px-3 py-2" data-testid={`row-am-${am.userId}`}>
                      <div className="grid grid-cols-[1fr_60px_70px_70px_70px_70px] gap-2 text-sm items-center">
                        <span className="truncate">{am.userName}</span>
                        <span className="text-right font-medium">{am.open}</span>
                        <span className={`text-right ${am.untouched3d > 0 ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}`}>{am.untouched3d}</span>
                        <span className="text-right">{am.fired > 0 ? `${Math.round(am.conversionRate * 100)}%` : "—"}</span>
                        <span className="text-right text-muted-foreground text-xs">{fmt$(am.dollarMoved)}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => setDrillRepId(am.userId)}
                          data-testid={`button-drill-${am.userId}`}
                        >
                          <Eye className="h-3 w-3 mr-1" /> View
                        </Button>
                      </div>
                      {am.dismissReasons && am.dismissReasons.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1" data-testid={`am-dismiss-reasons-${am.userId}`}>
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wide self-center">Dismissed:</span>
                          {am.dismissReasons.slice(0, 4).map(r => (
                            <Badge
                              key={r.reason}
                              variant="outline"
                              className="text-[10px] py-0 px-1.5 h-5"
                              data-testid={`am-dismiss-reason-${am.userId}-${r.reason}`}
                            >
                              {r.reason} <span className="ml-1 font-bold">{r.count}</span>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Top unworked high-$ accounts */}
              {data.topUnworked.length > 0 && (
                <div className="border rounded-md">
                  <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b">
                    Top unworked high-$ accounts
                  </div>
                  <div className="divide-y">
                    {data.topUnworked.map(c => (
                      <div key={c.cardId} className="flex items-center gap-2 px-3 py-2 text-sm" data-testid={`row-unworked-${c.cardId}`}>
                        <span
                          className={`flex-1 truncate ${c.companyId ? "cursor-pointer hover:underline" : ""}`}
                          onClick={() => c.companyId && setLocation(`/companies/${c.companyId}`)}
                        >
                          {c.companyName ?? RULE_LABEL[c.ruleType] ?? c.ruleType}
                        </span>
                        <Badge variant="outline" className="text-[10px]">{RULE_LABEL[c.ruleType] ?? c.ruleType}</Badge>
                        <span className="text-xs text-muted-foreground w-16 truncate text-right">{c.userName}</span>
                        <span className="text-xs text-muted-foreground w-12 text-right">{c.ageDays}d</span>
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400 w-16 text-right">{fmt$(c.atStakeAmount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Dismiss reasons */}
              {data.dismissReasons.length > 0 && (
                <div className="border rounded-md">
                  <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b">
                    Dismiss reasons
                  </div>
                  <div className="px-3 py-2 flex flex-wrap gap-1.5">
                    {data.dismissReasons.map(r => (
                      <Badge key={r.reason} variant="secondary" className="text-[11px]" data-testid={`dismiss-reason-${r.reason}`}>
                        {r.reason} <span className="ml-1 font-bold">{r.count}</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}

      {/* Read-only drill-in sheet */}
      <Sheet open={!!drillRepId} onOpenChange={o => !o && setDrillRepId(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4" />
              {repFeed?.repName ?? "Loading…"} — NBA feed (read-only)
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-2">
            {repFeedLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !repFeed || repFeed.cards.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active NBAs for this rep.</p>
            ) : (
              repFeed.cards.map(c => (
                <div key={c.id} className="border rounded-md p-3" data-testid={`drill-card-${c.id}`}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="font-semibold text-sm">
                        {c.companyName ?? (RULE_LABEL[c.ruleType] ?? c.ruleType)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{c.whyThisNow}</div>
                      <div className="text-xs mt-1"><span className="font-medium">Suggested:</span> {c.suggestedAction}</div>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge variant="outline" className="text-[10px]">{RULE_LABEL[c.ruleType] ?? c.ruleType}</Badge>
                        <Badge variant="outline" className="text-[10px]">{c.outcomeType}</Badge>
                        {c.atStakeAmount && (
                          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                            {fmt$(Number(c.atStakeAmount))} at stake
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}
