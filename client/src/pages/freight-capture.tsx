/**
 * Task #673 — Freight Capture Funnel page.
 *
 * Standalone page that wraps <FreightCaptureFunnel/> with a slim filter bar
 * (Customer / Rep / Equipment / Time period). Uses the same filter shape the
 * Customer Quotes endpoints already understand. Page-level RBAC mirrors the
 * Customer Quotes page; the funnel API additionally scopes account_managers
 * to their own quotes.
 */
import { useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FreightCaptureFunnel, type FunnelFilters } from "@/components/customer-quotes/FreightCaptureFunnel";

// Mirror of the role gate on /customer-quotes — reps outside this set don't
// see the Capture Funnel sidebar entry, but a direct URL still lands here so
// the gate is the last line of defence on the client.
const FREIGHT_CAPTURE_ROLES = new Set<string>([
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "account_manager",
]);

// Per Task #673 spec: This Week / This Month / Last 30 Days / Custom.
// "All time" remains as an explicit reset escape-hatch but is not part of the
// task's required set.
const TIME_PERIODS = [
  { key: "this_week", label: "This week" },
  { key: "this_month", label: "This month" },
  { key: "30d", label: "Last 30 days" },
  { key: "custom", label: "Custom range" },
  { key: "all", label: "All time" },
] as const;
type TimePeriodKey = typeof TIME_PERIODS[number]["key"];

const EQUIPMENTS = ["Van", "Reefer", "Flatbed", "Stepdeck", "Power-Only", "Specialized"];

type CustomerOpt = { id: string; name: string };
type RepOpt = { id: string; name: string };

type SnapshotLite = {
  customers?: CustomerOpt[];
  reps?: RepOpt[];
};

function periodToDates(
  key: TimePeriodKey,
  customStart: string,
  customEnd: string,
): { startDate?: string; endDate?: string } {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  if (key === "all") return {};
  if (key === "30d") {
    const start = new Date(today.getTime() - 29 * 24 * 3600 * 1000);
    return { startDate: start.toISOString().slice(0, 10), endDate: todayIso };
  }
  if (key === "this_week") {
    // ISO week — Monday as first day.
    const dow = today.getDay(); // 0=Sun..6=Sat
    const daysSinceMon = (dow + 6) % 7;
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysSinceMon);
    return { startDate: start.toISOString().slice(0, 10), endDate: todayIso };
  }
  if (key === "this_month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { startDate: start.toISOString().slice(0, 10), endDate: todayIso };
  }
  if (key === "custom") {
    const out: { startDate?: string; endDate?: string } = {};
    if (customStart) out.startDate = customStart;
    if (customEnd) out.endDate = customEnd;
    return out;
  }
  return {};
}

export default function FreightCapturePage(): JSX.Element {
  const { user, isLoading: authLoading } = useAuth();

  const hasAccess =
    !!user
    && typeof user === "object"
    && "role" in user
    && FREIGHT_CAPTURE_ROLES.has((user as { role: string }).role);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="freight-capture-auth-loading">
        <Skeleton className="h-6 w-32 bg-card" />
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="freight-capture-access-required">
        <p className="text-muted-foreground">Access required</p>
      </div>
    );
  }

  return <FreightCapturePageInner />;
}

function FreightCapturePageInner(): JSX.Element {
  const [period, setPeriod] = useState<TimePeriodKey>("30d");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [repId, setRepId] = useState<string | undefined>(undefined);
  const [equipment, setEquipment] = useState<string | undefined>(undefined);
  const [laneSearch, setLaneSearch] = useState<string>("");

  // Pull customer + rep lists from the existing snapshot endpoint (cached).
  // Slim subset is enough for our filter selects.
  const snapshot = useQuery<SnapshotLite>({
    queryKey: ["/api/customer-quotes/snapshot", "__funnel-filters__"],
    queryFn: async () => {
      const res = await fetch("/api/customer-quotes/snapshot", { credentials: "include" });
      if (!res.ok) throw new Error("snapshot failed");
      const json = (await res.json()) as SnapshotLite;
      return { customers: json.customers ?? [], reps: json.reps ?? [] };
    },
    staleTime: 5 * 60 * 1000,
  });

  const filters: FunnelFilters = useMemo(() => {
    const dates = periodToDates(period, customStart, customEnd);
    const f: FunnelFilters = { ...dates };
    if (customerId) f.customerId = customerId;
    if (repId) f.repId = repId;
    if (equipment) f.equipment = equipment;
    if (laneSearch.trim().length > 0) f.laneSearch = laneSearch.trim();
    return f;
  }, [period, customStart, customEnd, customerId, repId, equipment, laneSearch]);

  const clearAll = (): void => {
    setPeriod("30d");
    setCustomStart("");
    setCustomEnd("");
    setCustomerId(undefined);
    setRepId(undefined);
    setEquipment(undefined);
    setLaneSearch("");
  };

  // Lanes performer rows feed back into the lane filter.
  const onLaneClick = (laneLabel: string): void => {
    setLaneSearch(laneLabel);
  };

  return (
    <div className="flex flex-col h-full bg-background text-foreground" data-testid="page-freight-capture">
      <div className="px-6 py-4 border-b border-border bg-background shrink-0" data-testid="header-freight-capture">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Freight Capture Funnel</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Quote opportunity flow from request to win — filterable by rep, customer, mode, and time period.
            </p>
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-20 px-6 py-3 border-b border-border bg-background/95 backdrop-blur shrink-0" data-testid="freight-capture-filter-bar">
        <div className="flex flex-wrap items-end gap-2">
          <FilterBox label="Time period">
            <Select value={period} onValueChange={(v) => setPeriod(v as TimePeriodKey)}>
              <SelectTrigger className="h-8 w-[160px] bg-card border-border text-xs" data-testid="select-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_PERIODS.map(p => (
                  <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBox>

          {period === "custom" && (
            <>
              <FilterBox label="From">
                <Input
                  type="date"
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  className="h-8 w-[150px] bg-card border-border text-xs"
                  data-testid="input-custom-start"
                />
              </FilterBox>
              <FilterBox label="To">
                <Input
                  type="date"
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  className="h-8 w-[150px] bg-card border-border text-xs"
                  data-testid="input-custom-end"
                />
              </FilterBox>
            </>
          )}

          <FilterBox label="Customer">
            <Select value={customerId ?? "_all"} onValueChange={v => setCustomerId(v === "_all" ? undefined : v)}>
              <SelectTrigger className="h-8 w-[180px] bg-card border-border text-xs" data-testid="select-customer">
                <SelectValue placeholder="All customers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All customers</SelectItem>
                {(snapshot.data?.customers ?? []).map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBox>

          <FilterBox label="Rep">
            <Select value={repId ?? "_all"} onValueChange={v => setRepId(v === "_all" ? undefined : v)}>
              <SelectTrigger className="h-8 w-[160px] bg-card border-border text-xs" data-testid="select-rep">
                <SelectValue placeholder="All reps" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All reps</SelectItem>
                {(snapshot.data?.reps ?? []).map(r => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterBox>

          <FilterBox label="Mode (equipment)">
            <Select value={equipment ?? "_all"} onValueChange={v => setEquipment(v === "_all" ? undefined : v)}>
              <SelectTrigger className="h-8 w-[140px] bg-card border-border text-xs" data-testid="select-equipment">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All</SelectItem>
                {EQUIPMENTS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>

          <FilterBox label="Lane">
            <Input
              value={laneSearch}
              onChange={e => setLaneSearch(e.target.value)}
              placeholder="Origin / dest..."
              className="h-8 w-[180px] bg-card border-border text-xs"
              data-testid="input-lane-search"
            />
          </FilterBox>

          <Button
            size="sm"
            variant="ghost"
            onClick={clearAll}
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            data-testid="button-clear-filters"
          >
            Clear filters
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <FreightCaptureFunnel filters={filters} onLaneClick={onLaneClick} />
      </div>
    </div>
  );
}

function FilterBox({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
