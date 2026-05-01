// Task #872 — Manager Leak Console.
//
// Manager-only console that surfaces 4 leak classes across AF and LWQ.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, ArrowUpRight, Wrench, Users, Activity, ShieldAlert, ChevronDown } from "lucide-react";

// ── Types (mirror server/leakConsoleService.ts) ──────────────────────────────

const PANELS = [
  "no_contactable_under_demand",
  "unstable_spot_deployed",
  "recurring_covered_on_spot",
  "owned_untouched_under_pressure",
] as const;
type Panel = (typeof PANELS)[number];

const PANEL_META: Record<Panel, { title: string; subtitle: string; icon: typeof AlertTriangle; key: keyof KpiCounts }> = {
  no_contactable_under_demand: {
    title: "No-contactable under demand",
    subtitle: "Live AF rows with no contactable LWQ carriers",
    icon: AlertTriangle,
    key: "noContactableUnderDemand",
  },
  unstable_spot_deployed: {
    title: "Unstable lanes still spot-deployed",
    subtitle: "Volatile lanes covered through AF instead of LWQ",
    icon: Activity,
    key: "unstableSpotDeployed",
  },
  recurring_covered_on_spot: {
    title: "Recurring covered on spot",
    subtitle: "Recurring lanes with no LWQ touchpoint in trailing window",
    icon: ShieldAlert,
    key: "recurringCoveredOnSpot",
  },
  owned_untouched_under_pressure: {
    title: "Owned-but-untouched under pressure",
    subtitle: "Owned recurring lanes with stale touch and live AF",
    icon: Users,
    key: "ownedUntouchedUnderPressure",
  },
};

interface EvidenceChip {
  label: string;
  tone?: "neutral" | "warn" | "danger" | "info";
}

interface LeakRow {
  laneId: string;
  laneSig: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyId: string | null;
  companyName: string | null;
  companyTier: "A" | "B" | "C" | "new";
  ownerUserId: string | null;
  ownerName: string | null;
  laneScore: number | null;
  volatilityPenalty: number | null;
  health: "stable" | "volatile" | "hot";
  evidence: EvidenceChip[];
}

interface PanelResponse {
  panel: Panel;
  rows: LeakRow[];
  total: number;
}

interface KpiCounts {
  noContactableUnderDemand: number;
  unstableSpotDeployed: number;
  recurringCoveredOnSpot: number;
  ownedUntouchedUnderPressure: number;
}

interface KpiResponse {
  counts: KpiCounts;
  trend: Array<{ date: string } & KpiCounts>;
}

interface SimpleUser {
  id: string;
  name: string;
  role: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tone(c?: EvidenceChip["tone"]): string {
  switch (c) {
    case "danger":
      return "bg-red-100 text-red-800 border-red-300 dark:bg-red-950 dark:text-red-200 dark:border-red-800";
    case "warn":
      return "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800";
    case "info":
      return "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-800";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function laneLabel(r: LeakRow): string {
  const o = `${r.origin}${r.originState ? ", " + r.originState : ""}`;
  const d = `${r.destination}${r.destinationState ? ", " + r.destinationState : ""}`;
  const e = r.equipmentType ? ` · ${r.equipmentType}` : "";
  return `${o} → ${d}${e}`;
}

const FIX_OPTIONS: Record<Panel, Array<{ kind: string; label: string; needsOwner?: boolean }>> = {
  no_contactable_under_demand: [
    { kind: "build_bench", label: "Build bench" },
    { kind: "reassign_owner", label: "Reassign owner", needsOwner: true },
  ],
  unstable_spot_deployed: [
    { kind: "stabilize", label: "Stabilize" },
    { kind: "demote_from_recurring", label: "Demote from recurring" },
  ],
  recurring_covered_on_spot: [
    { kind: "push_to_lwq_owner", label: "Push to LWQ owner", needsOwner: true },
    { kind: "reassign_owner", label: "Reassign owner", needsOwner: true },
  ],
  owned_untouched_under_pressure: [
    { kind: "nudge_owner", label: "Nudge owner" },
    { kind: "reassign_owner", label: "Reassign owner", needsOwner: true },
  ],
};

// ── Sparkline (tiny inline SVG) ──────────────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return <div className="h-6 w-24" />;
  const w = 96;
  const h = 24;
  const max = Math.max(1, ...values);
  const points = values
    .map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * w;
      const y = h - (v / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible" data-testid="sparkline">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={points} className="text-primary" />
    </svg>
  );
}

// ── KPI tile ─────────────────────────────────────────────────────────────────

function KpiTile({
  panel,
  count,
  trend,
  active,
  onClick,
}: {
  panel: Panel;
  count: number;
  trend: number[];
  active: boolean;
  onClick: () => void;
}) {
  const meta = PANEL_META[panel];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`kpi-tile-${panel}`}
      className={`text-left rounded-md border p-3 transition hover-elevate active-elevate-2 ${active ? "border-primary ring-1 ring-primary" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{meta.title}</span>
        </div>
        <div className="text-muted-foreground">
          <Sparkline values={trend} />
        </div>
      </div>
      <div className="mt-2 flex items-end justify-between">
        <div className="text-3xl font-semibold tabular-nums" data-testid={`kpi-count-${panel}`}>
          {count}
        </div>
        <span className="text-xs text-muted-foreground">{meta.subtitle}</span>
      </div>
    </button>
  );
}

// ── Fix dialog ───────────────────────────────────────────────────────────────

interface FixDialogState {
  panel: Panel;
  row: LeakRow;
  fixKind: string;
  needsOwner: boolean;
}

function FixDialog({
  state,
  users,
  onClose,
}: {
  state: FixDialogState | null;
  users: SimpleUser[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [newOwnerUserId, setNewOwnerUserId] = useState<string>("");
  const [note, setNote] = useState<string>("");

  const fix = useMutation({
    mutationFn: async () => {
      if (!state) return;
      return apiRequest("POST", "/api/leak-console/fix", {
        panel: state.panel,
        fixKind: state.fixKind,
        laneId: state.row.laneId,
        newOwnerUserId: state.needsOwner ? newOwnerUserId : undefined,
        note: note || undefined,
      });
    },
    onSuccess: () => {
      toast({ title: "Fix applied", description: "Leak Console action recorded and audit row written." });
      queryClient.invalidateQueries({ queryKey: ["/api/leak-console/kpi"] });
      PANELS.forEach((p) => queryClient.invalidateQueries({ queryKey: ["/api/leak-console/panels", p] }));
      onClose();
      setNewOwnerUserId("");
      setNote("");
    },
    onError: (err: Error) => {
      toast({ title: "Fix failed", description: err.message, variant: "destructive" });
    },
  });

  if (!state) return null;
  const isDeepLink = state.fixKind === "stabilize" || state.fixKind === "build_bench";
  const deepLinkHref =
    state.fixKind === "stabilize"
      ? `/lanes/work-queue?lane=${state.row.laneId}`
      : `/lanes/work-queue?lane=${state.row.laneId}&action=add-carrier`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-fix" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{FIX_OPTIONS[state.panel].find((f) => f.kind === state.fixKind)?.label ?? state.fixKind}</DialogTitle>
          <DialogDescription>{laneLabel(state.row)}</DialogDescription>
        </DialogHeader>
        {state.needsOwner ? (
          <div className="space-y-2">
            <label className="text-sm font-medium">Assign to</label>
            <Select value={newOwnerUserId} onValueChange={setNewOwnerUserId}>
              <SelectTrigger data-testid="select-fix-owner">
                <SelectValue placeholder="Select owner" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id} data-testid={`option-fix-owner-${u.id}`}>
                    {u.name} <span className="text-muted-foreground text-xs">({u.role})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-2">
          <label className="text-sm font-medium">Note (optional)</label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add context for the audit log"
            data-testid="input-fix-note"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="button-fix-cancel">
            Cancel
          </Button>
          {isDeepLink ? (
            <Button
              asChild
              onClick={() => {
                fix.mutate();
              }}
              data-testid="button-fix-deeplink"
            >
              <Link href={deepLinkHref}>
                Open <ArrowUpRight className="ml-1 h-3 w-3" />
              </Link>
            </Button>
          ) : (
            <Button
              onClick={() => fix.mutate()}
              disabled={(state.needsOwner && !newOwnerUserId) || fix.isPending}
              data-testid="button-fix-apply"
            >
              {fix.isPending ? "Applying…" : "Apply fix"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Lane row + Panel ─────────────────────────────────────────────────────────

function LaneRow({
  panel,
  row,
  onFix,
}: {
  panel: Panel;
  row: LeakRow;
  onFix: (kind: string, needsOwner: boolean) => void;
}) {
  const fixes = FIX_OPTIONS[panel];
  return (
    <div
      className="flex items-center justify-between gap-3 border-t py-3 px-3"
      data-testid={`row-leak-${row.laneId}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate" data-testid={`text-lane-${row.laneId}`}>
            {laneLabel(row)}
          </span>
          <Badge variant="outline" className="text-xs" data-testid={`badge-tier-${row.laneId}`}>
            {row.companyTier}
          </Badge>
          <Badge variant="outline" className="text-xs" data-testid={`badge-health-${row.laneId}`}>
            {row.health}
          </Badge>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {row.companyName ?? "—"}
          {" · "}
          {row.ownerName ? `owner ${row.ownerName}` : "unowned"}
          {row.laneScore != null ? ` · score ${row.laneScore}` : ""}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {row.evidence.map((c, i) => (
            <span
              key={i}
              className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${tone(c.tone)}`}
              data-testid={`chip-evidence-${row.laneId}-${i}`}
            >
              {c.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {fixes.map((f) => (
          <Button
            key={f.kind}
            size="sm"
            variant={f === fixes[0] ? "default" : "outline"}
            onClick={() => onFix(f.kind, !!f.needsOwner)}
            data-testid={`button-fix-${row.laneId}-${f.kind}`}
          >
            <Wrench className="mr-1 h-3 w-3" />
            {f.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function PanelCard({
  panel,
  filters,
  onFix,
  expanded,
  onToggle,
}: {
  panel: Panel;
  filters: Record<string, string>;
  onFix: (panel: Panel, row: LeakRow, kind: string, needsOwner: boolean) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = PANEL_META[panel];
  const params = new URLSearchParams(filters).toString();
  const url = params ? `/api/leak-console/panels/${panel}?${params}` : `/api/leak-console/panels/${panel}`;
  const { data, isLoading } = useQuery<PanelResponse>({
    queryKey: ["/api/leak-console/panels", panel, params],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load ${panel}`);
      return res.json();
    },
    enabled: expanded,
  });
  return (
    <Card data-testid={`panel-${panel}`}>
      <CardHeader className="cursor-pointer" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{meta.title}</CardTitle>
            <CardDescription>{meta.subtitle}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {data ? (
              <Badge variant="secondary" data-testid={`badge-total-${panel}`}>
                {data.total}
              </Badge>
            ) : null}
            <ChevronDown className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} />
          </div>
        </div>
      </CardHeader>
      {expanded ? (
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground" data-testid={`empty-${panel}`}>
              No leaks detected for the current filters. Healthy as of right now.
            </div>
          ) : (
            data.rows.map((r) => (
              <LaneRow
                key={r.laneId}
                panel={panel}
                row={r}
                onFix={(kind, needsOwner) => onFix(panel, r, kind, needsOwner)}
              />
            ))
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function LeakConsolePage() {
  const { user } = useAuth();
  const isManager =
    !!user &&
    ["admin", "director", "sales_director", "national_account_manager"].includes(user.role ?? "");

  const [activePanel, setActivePanel] = useState<Panel>("no_contactable_under_demand");
  const [expanded, setExpanded] = useState<Record<Panel, boolean>>({
    no_contactable_under_demand: true,
    unstable_spot_deployed: false,
    recurring_covered_on_spot: false,
    owned_untouched_under_pressure: false,
  });
  const [filters, setFilters] = useState<{ owner: string; tier: string; health: string; windowDays: string }>({
    owner: "all",
    tier: "all",
    health: "all",
    windowDays: "14",
  });
  const [fixState, setFixState] = useState<FixDialogState | null>(null);

  const filterParams = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (filters.owner !== "all") out.ownerUserId = filters.owner;
    if (filters.tier !== "all") out.tier = filters.tier;
    if (filters.health !== "all") out.health = filters.health;
    if (filters.windowDays && filters.windowDays !== "14") out.windowDays = filters.windowDays;
    return out;
  }, [filters]);

  const { data: kpi, isLoading: kpiLoading } = useQuery<KpiResponse>({
    queryKey: ["/api/leak-console/kpi"],
    enabled: isManager,
  });
  const { data: users } = useQuery<SimpleUser[]>({
    queryKey: ["/api/users"],
    enabled: isManager,
  });

  if (!user) {
    return <div className="p-8">Loading…</div>;
  }
  if (!isManager) {
    return (
      <div className="p-8 max-w-xl mx-auto" data-testid="leak-console-forbidden">
        <Card>
          <CardHeader>
            <CardTitle>Manager-only console</CardTitle>
            <CardDescription>
              The Leak Console is restricted to admins, directors, sales directors, and national account
              managers. Ask your manager if you need access.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const trendValuesFor = (key: keyof KpiCounts): number[] => {
    if (!kpi?.trend) return [];
    return kpi.trend.map((t) => t[key]);
  };

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-leak-console">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-primary" /> Manager Leak Console
          </h1>
          <p className="text-sm text-muted-foreground">
            Where coverage is leaking right now and who owns the fix.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/lanes/work-queue">
            <Button variant="outline" size="sm" data-testid="link-back-lwq">
              Lane Work Queue
            </Button>
          </Link>
          <Link href="/available-freight">
            <Button variant="outline" size="sm" data-testid="link-back-af">
              Available Freight
            </Button>
          </Link>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {PANELS.map((p) => (
          <KpiTile
            key={p}
            panel={p}
            count={kpiLoading ? 0 : kpi?.counts[PANEL_META[p].key] ?? 0}
            trend={trendValuesFor(PANEL_META[p].key)}
            active={activePanel === p}
            onClick={() => {
              setActivePanel(p);
              setExpanded((e) => ({ ...e, [p]: true }));
            }}
          />
        ))}
      </div>

      {/* Filter bar */}
      <Card data-testid="leak-console-filters">
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Owner</label>
            <Select value={filters.owner} onValueChange={(v) => setFilters((f) => ({ ...f, owner: v }))}>
              <SelectTrigger className="w-[180px]" data-testid="filter-owner">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                {(users ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id} data-testid={`filter-owner-${u.id}`}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Tier</label>
            <Select value={filters.tier} onValueChange={(v) => setFilters((f) => ({ ...f, tier: v }))}>
              <SelectTrigger className="w-[140px]" data-testid="filter-tier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tiers</SelectItem>
                <SelectItem value="A">Tier A</SelectItem>
                <SelectItem value="B">Tier B</SelectItem>
                <SelectItem value="C">Tier C</SelectItem>
                <SelectItem value="new">New</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Health</label>
            <Select value={filters.health} onValueChange={(v) => setFilters((f) => ({ ...f, health: v }))}>
              <SelectTrigger className="w-[140px]" data-testid="filter-health">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All health</SelectItem>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="volatile">Volatile</SelectItem>
                <SelectItem value="hot">Hot</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Trailing window</label>
            <Select value={filters.windowDays} onValueChange={(v) => setFilters((f) => ({ ...f, windowDays: v }))}>
              <SelectTrigger className="w-[140px]" data-testid="filter-window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters({ owner: "all", tier: "all", health: "all", windowDays: "14" })}
            data-testid="button-clear-filters"
          >
            Clear filters
          </Button>
        </CardContent>
      </Card>

      {/* Panels */}
      <div className="space-y-3">
        {PANELS.map((p) => (
          <PanelCard
            key={p}
            panel={p}
            filters={filterParams}
            expanded={!!expanded[p]}
            onToggle={() => setExpanded((e) => ({ ...e, [p]: !e[p] }))}
            onFix={(panel, row, fixKind, needsOwner) =>
              setFixState({ panel, row, fixKind, needsOwner })
            }
          />
        ))}
      </div>

      <FixDialog state={fixState} users={users ?? []} onClose={() => setFixState(null)} />
    </div>
  );
}
