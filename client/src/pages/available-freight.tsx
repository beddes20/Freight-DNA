import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Truck, AlertCircle, ChevronRight, RefreshCw, Search, Inbox,
  ArrowUpRight,
} from "lucide-react";
import type {
  Company,
  FreightOpportunity,
  FreightOpportunityStatus,
  FreightOpportunityMode,
} from "@shared/schema";

type OpportunityListItem = FreightOpportunity & {
  recommendedCarrierCount?: number;
  includedCarrierCount?: number;
};

interface OpportunityListResponse {
  items: OpportunityListItem[];
}

const STATUS_LABELS: Record<FreightOpportunityStatus, string> = {
  new: "New",
  ready_to_send: "Ready",
  sent: "Sent",
  awaiting_carrier_reply: "Awaiting carrier",
  awaiting_customer_confirm: "Confirm w/ customer",
  partially_covered: "Partial",
  covered: "Covered",
  expired: "Expired",
  cancelled: "Cancelled",
};

const MODE_LABELS: Record<FreightOpportunityMode, string> = {
  exact_load: "Exact load",
  lane_building: "Lane build",
  both: "Both",
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    new: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
    ready_to_send: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
    sent: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
    partially_covered: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    covered: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    expired: "bg-muted text-muted-foreground border-border",
    cancelled: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge
      variant="outline"
      className={map[status] ?? "bg-muted text-muted-foreground border-border"}
      data-testid={`badge-status-${status}`}
    >
      {STATUS_LABELS[status as FreightOpportunityStatus] ?? status}
    </Badge>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  return (
    <Badge variant="secondary" data-testid={`badge-mode-${mode}`}>
      {MODE_LABELS[mode as FreightOpportunityMode] ?? mode}
    </Badge>
  );
}

function fmtWindow(start: string | null | undefined, end: string | null | undefined) {
  if (!start) return "—";
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  const dOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const sStr = s.toLocaleDateString(undefined, dOpts);
  if (!e || isNaN(e.getTime())) return sStr;
  const eStr = e.toLocaleDateString(undefined, dOpts);
  return sStr === eStr ? sStr : `${sStr} → ${eStr}`;
}

function leadTimeDays(start: string): number {
  const s = new Date(start).getTime();
  const now = Date.now();
  return Math.max(0, Math.round((s - now) / (1000 * 60 * 60 * 24)));
}

export default function AvailableFreightPage() {
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [modeFilter, setModeFilter] = useState<string>("all");
  const [confidenceFilter, setConfidenceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [leadTimeFilter, setLeadTimeFilter] = useState<string>("any");
  const [search, setSearch] = useState("");

  const statusParam =
    statusFilter === "active"
      // Task #365 — include the new in-flight statuses so newly transitioned
      // opps stay visible in the default queue view (was excluding them).
      ? "new,ready_to_send,sent,awaiting_carrier_reply,awaiting_customer_confirm,partially_covered"
      : statusFilter === "all"
        ? ""
        : statusFilter;

  const { data, isLoading, isError, refetch, isFetching } = useQuery<OpportunityListResponse>({
    queryKey: ["/api/freight-opportunities", { status: statusParam }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusParam) params.set("status", statusParam);
      params.set("limit", "200");
      const res = await fetch(`/api/freight-opportunities?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const { data: companies } = useQuery<Company[]>({ queryKey: ["/api/companies"] });
  const companyById = useMemo(() => {
    const m = new Map<string, Company>();
    (companies ?? []).forEach(c => m.set(c.id, c));
    return m;
  }, [companies]);

  const items = data?.items ?? [];

  const filtered = useMemo(() => {
    return items.filter(opp => {
      if (companyFilter !== "all" && opp.companyId !== companyFilter) return false;
      if (modeFilter !== "all" && opp.mode !== modeFilter) return false;
      if (confidenceFilter !== "all" && opp.confidenceFlag !== confidenceFilter) return false;
      if (leadTimeFilter !== "any") {
        const days = leadTimeDays(opp.pickupWindowStart);
        if (leadTimeFilter === "lt2" && days >= 2) return false;
        if (leadTimeFilter === "2to4" && (days < 2 || days > 4)) return false;
        if (leadTimeFilter === "5to7" && (days < 5 || days > 7)) return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const haystack = [
          opp.origin, opp.destination, opp.equipmentType ?? "",
          companyById.get(opp.companyId)?.name ?? "",
        ].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [items, companyFilter, modeFilter, confidenceFilter, leadTimeFilter, search, companyById]);

  const enabledCompanies = useMemo(() => {
    const ids = new Set(items.map(i => i.companyId));
    return Array.from(ids)
      .map(id => companyById.get(id))
      .filter((c): c is Company => Boolean(c))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, companyById]);

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-screen-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="heading-available-freight">
            <Truck className="h-6 w-6" /> Available Freight Outreach
          </h1>
          <p className="text-sm text-muted-foreground">
            Customer-eligible open freight, with ranked carrier shortlists. Review-only —
            sending happens in a later phase.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-opportunities"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription className="text-xs">
            Showing {filtered.length} of {items.length} opportunities
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="lg:col-span-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search lane, equipment, customer…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="input-filter-search"
                />
              </div>
            </div>
            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger data-testid="select-filter-company"><SelectValue placeholder="Customer" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All customers</SelectItem>
                {enabledCompanies.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={modeFilter} onValueChange={setModeFilter}>
              <SelectTrigger data-testid="select-filter-mode"><SelectValue placeholder="Mode" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modes</SelectItem>
                <SelectItem value="exact_load">Exact load</SelectItem>
                <SelectItem value="lane_building">Lane building</SelectItem>
              </SelectContent>
            </Select>
            <Select value={leadTimeFilter} onValueChange={setLeadTimeFilter}>
              <SelectTrigger data-testid="select-filter-leadtime"><SelectValue placeholder="Lead time" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any lead time</SelectItem>
                <SelectItem value="lt2">&lt; 2 days</SelectItem>
                <SelectItem value="2to4">2–4 days</SelectItem>
                <SelectItem value="5to7">5–7 days</SelectItem>
              </SelectContent>
            </Select>
            <Select value={confidenceFilter} onValueChange={setConfidenceFilter}>
              <SelectTrigger data-testid="select-filter-confidence"><SelectValue placeholder="Confidence" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any confidence</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="low">Low only</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="select-filter-status"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active queue</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="ready_to_send">Ready</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="awaiting_carrier_reply">Awaiting carrier</SelectItem>
                <SelectItem value="awaiting_customer_confirm">Confirm w/ customer</SelectItem>
                <SelectItem value="partially_covered">Partial</SelectItem>
                <SelectItem value="covered">Covered</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isError ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center" data-testid="state-error">
              <AlertCircle className="h-8 w-8 text-destructive" />
              <p className="text-sm font-medium">Couldn't load opportunities</p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2" data-testid="state-loading">
              {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" data-testid="state-empty">
              <Inbox className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No opportunities match these filters</p>
                <p className="text-xs text-muted-foreground">
                  Opportunities appear once eligible customers have unbooked freight in the
                  configured lead-time window.
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Lane</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Pickup window</TableHead>
                    <TableHead className="text-right">Loads</TableHead>
                    <TableHead className="text-right">Carriers</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(opp => {
                    const company = companyById.get(opp.companyId);
                    const days = leadTimeDays(opp.pickupWindowStart);
                    return (
                      <TableRow
                        key={opp.id}
                        className="hover-elevate cursor-pointer"
                        data-testid={`row-opportunity-${opp.id}`}
                      >
                        <TableCell className="font-medium">
                          <Link
                            href={`/available-freight/${opp.id}`}
                            data-testid={`link-opportunity-${opp.id}`}
                            className="hover:underline"
                          >
                            {company?.name ?? "Unknown customer"}
                          </Link>
                          {company?.archivedAt && (
                            <Badge variant="outline" className="ml-2 text-[10px]">archived</Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span data-testid={`text-lane-${opp.id}`}>{opp.origin} → {opp.destination}</span>
                          {opp.equipmentType && (
                            <span className="ml-2 text-xs text-muted-foreground">{opp.equipmentType}</span>
                          )}
                        </TableCell>
                        <TableCell><ModeBadge mode={opp.mode} /></TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <div>{fmtWindow(opp.pickupWindowStart, opp.pickupWindowEnd)}</div>
                          <div className="text-xs text-muted-foreground">
                            in {days} day{days === 1 ? "" : "s"}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{opp.loadCount}</TableCell>
                        <TableCell className="text-right tabular-nums" data-testid={`text-carrier-count-${opp.id}`}>
                          {opp.recommendedCarrierCount === undefined ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span title={`${opp.includedCarrierCount ?? 0} included of ${opp.recommendedCarrierCount} recommended`}>
                              <span className="font-medium">{opp.includedCarrierCount ?? 0}</span>
                              <span className="text-muted-foreground"> / {opp.recommendedCarrierCount}</span>
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {opp.confidenceFlag === "low" ? (
                            <Badge variant="outline" className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" data-testid={`badge-confidence-${opp.id}`}>
                              Low
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Normal</span>
                          )}
                        </TableCell>
                        <TableCell><StatusBadge status={opp.status} /></TableCell>
                        <TableCell>
                          <Link href={`/available-freight/${opp.id}`}>
                            <Button variant="ghost" size="icon" data-testid={`button-open-${opp.id}`}>
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <ArrowUpRight className="h-3 w-3" />
        Open an opportunity to see ranked carriers, explanations, and include/exclude controls.
      </p>
    </div>
  );
}
