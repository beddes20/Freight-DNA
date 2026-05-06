import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Plus, Upload, Filter, Search, Kanban, LayoutList, Trophy, Clock, Building2,
  AlertCircle, ChevronDown, ChevronUp, Settings, ShieldCheck, ArrowUpDown,
} from "lucide-react";
import type { ProspectStage } from "@shared/schema";
import { PROSPECT_STAGE_LABELS, PROSPECT_LOST_REASON_LABELS, accountStatuses, ACCOUNT_STATUS_LABELS } from "@shared/schema";
import { isOverdue, isDueToday, weightedValue, formatCurrency, daysAgo } from "../utils";
import { ACTIVE_STAGES, CLOSED_STAGES, STAGE_BORDER, ACCOUNT_STATUS_DOT, type EnrichedProspect } from "../types";
import { ProspectCard } from "./ProspectCard";
import { AccountStatusBadge } from "./AccountStatusBadge";

type OppSummary = { openCount: number; closedWonCount: number; pipelineValue: number };

interface PipelineSectionProps {
  prospects: EnrichedProspect[];
  isLoading: boolean;
  oppsSummary: Record<number, OppSummary>;
  activeStages: ProspectStage[];
  stageLabels: Record<string, string>;
  staleThreshold: number;
  settingsLeadSources: Array<{ key: string; label: string }>;
  ownerOptions: Array<[string, string]>;
  isSalesDirectorOrAdmin: boolean;
  userRole: string;
  onAddAccount: () => void;
  onImport: () => void;
  onAdminOwnership: () => void;
  onCrmSettings: () => void;
  onSelectProspect: (p: EnrichedProspect) => void;
}

export function PipelineSection({
  prospects, isLoading, oppsSummary, activeStages, stageLabels, staleThreshold,
  settingsLeadSources, ownerOptions, isSalesDirectorOrAdmin, userRole,
  onAddAccount, onImport, onAdminOwnership, onCrmSettings, onSelectProspect,
}: PipelineSectionProps) {
  const [viewMode, setViewMode] = useState<"kanban" | "table">("kanban");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOwner, setFilterOwner] = useState("all");
  const [filterPriority, setFilterPriority] = useState("all");
  const [filterLeadSource, setFilterLeadSource] = useState("all");
  const [filterAccountStatus, setFilterAccountStatus] = useState("all");
  const [tableSortField, setTableSortField] = useState<"name" | "accountStatus" | "openOpps" | "pipeline" | "lastActivity">("name");
  const [tableSortDir, setTableSortDir] = useState<"asc" | "desc">("asc");
  const [lostOpen, setLostOpen] = useState(false);

  const filtered = useMemo(() => prospects.filter(p => {
    if (filterOwner !== "all" && p.ownerId !== filterOwner) return false;
    if (filterPriority !== "all" && p.priority !== filterPriority) return false;
    if (filterLeadSource !== "all" && p.leadSource !== filterLeadSource) return false;
    if (filterAccountStatus !== "all" && (p.accountStatus ?? "prospecting") !== filterAccountStatus) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !(p.industry ?? "").toLowerCase().includes(q) && !(p.primaryContactName ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [prospects, filterOwner, filterPriority, filterLeadSource, filterAccountStatus, searchQuery]);

  const tableSorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (tableSortField) {
        case "accountStatus": {
          const order = ["prospecting", "intro_scheduled", "active_customer", "dormant", "lost"];
          cmp = (order.indexOf(a.accountStatus ?? "prospecting")) - (order.indexOf(b.accountStatus ?? "prospecting"));
          break;
        }
        case "openOpps": cmp = (oppsSummary[a.id]?.openCount ?? 0) - (oppsSummary[b.id]?.openCount ?? 0); break;
        case "pipeline": cmp = (oppsSummary[a.id]?.pipelineValue ?? 0) - (oppsSummary[b.id]?.pipelineValue ?? 0); break;
        case "lastActivity": cmp = new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime(); break;
        default: cmp = a.name.localeCompare(b.name);
      }
      return tableSortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, tableSortField, tableSortDir, oppsSummary]);

  const activeProspects = filtered.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && !p.convertedToCompanyId);
  const closedProspects = filtered.filter(p => CLOSED_STAGES.includes(p.stage as ProspectStage));
  const byStage = (stage: ProspectStage) => activeProspects.filter(p => p.stage === stage);

  const totalActive = prospects.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && !p.convertedToCompanyId).length;
  const overdueCount = prospects.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && isOverdue(p.followUpDate)).length;
  const dueTodayCount = prospects.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && isDueToday(p.followUpDate)).length;
  const wonCount = prospects.filter(p => p.stage === "first_load_won").length;
  const totalWeightedValue = activeProspects.reduce((sum, p) => sum + weightedValue(p), 0);

  const sortCol = (key: typeof tableSortField) => {
    if (tableSortField === key) setTableSortDir(d => d === "asc" ? "desc" : "asc");
    else { setTableSortField(key); setTableSortDir("asc"); }
  };

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-6 flex-1 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Prospects from first contact to first load
            {totalWeightedValue > 0 && <> · <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{formatCurrency(totalWeightedValue)} weighted</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center border rounded-md overflow-hidden">
            <button className={`px-2 py-1.5 flex items-center gap-1 text-xs transition-colors ${viewMode === "kanban" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} onClick={() => setViewMode("kanban")} data-testid="button-view-kanban">
              <Kanban className="h-3.5 w-3.5" />Board
            </button>
            <button className={`px-2 py-1.5 flex items-center gap-1 text-xs border-l transition-colors ${viewMode === "table" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} onClick={() => setViewMode("table")} data-testid="button-view-table">
              <LayoutList className="h-3.5 w-3.5" />List
            </button>
          </div>
          {isSalesDirectorOrAdmin && (
            <Button variant="outline" onClick={onAdminOwnership} className="gap-2 relative" data-testid="button-admin-ownership">
              <ShieldCheck className="h-4 w-4" /> Transfers
            </Button>
          )}
          {userRole === "admin" && (
            <Button variant="outline" size="icon" onClick={onCrmSettings} title="CRM Settings" className="h-9 w-9" data-testid="button-crm-settings">
              <Settings className="h-4 w-4" />
            </Button>
          )}
          <Button variant="outline" onClick={onImport} className="gap-2" data-testid="button-import-prospects">
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button onClick={onAddAccount} className="gap-2" data-testid="button-add-prospect">
            <Plus className="h-4 w-4" /> Add Account
          </Button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Active Prospects", value: totalActive, icon: Building2, color: "text-blue-600 dark:text-blue-400" },
          { label: "Due Today", value: dueTodayCount, icon: Clock, color: "text-amber-600 dark:text-amber-400" },
          { label: "Overdue Follow-ups", value: overdueCount, icon: AlertCircle, color: "text-red-600 dark:text-red-400" },
          { label: "First Loads Won", value: wonCount, icon: Trophy, color: "text-emerald-600 dark:text-emerald-400" },
        ].map(stat => (
          <Card key={stat.label} className="p-3" data-testid={`stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <div className="flex items-center gap-2">
              <stat.icon className={`h-4 w-4 shrink-0 ${stat.color}`} />
              <div>
                <p className="text-lg font-bold leading-none">{stat.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search accounts…" className="h-7 pl-7 text-xs w-44" data-testid="input-search-prospects" />
        </div>
        <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {isSalesDirectorOrAdmin && (
          <Select value={filterOwner} onValueChange={setFilterOwner}>
            <SelectTrigger className="h-7 text-xs w-36" data-testid="filter-owner"><SelectValue placeholder="All reps" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reps</SelectItem>
              {ownerOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filterPriority} onValueChange={setFilterPriority}>
          <SelectTrigger className="h-7 text-xs w-28" data-testid="filter-priority"><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            <SelectItem value="hot">🔴 Hot</SelectItem>
            <SelectItem value="warm">🟡 Warm</SelectItem>
            <SelectItem value="cold">🔵 Cold</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterLeadSource} onValueChange={setFilterLeadSource}>
          <SelectTrigger className="h-7 text-xs w-36" data-testid="filter-lead-source"><SelectValue placeholder="Lead source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {settingsLeadSources.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterAccountStatus} onValueChange={setFilterAccountStatus}>
          <SelectTrigger className="h-7 text-xs w-36" data-testid="filter-account-status"><SelectValue placeholder="Account status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {accountStatuses.map(s => (
              <SelectItem key={s} value={s}>
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${ACCOUNT_STATUS_DOT[s] ?? "bg-slate-400"}`} />
                  {ACCOUNT_STATUS_LABELS[s]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(filterOwner !== "all" || filterPriority !== "all" || filterLeadSource !== "all" || filterAccountStatus !== "all") && (
          <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={() => { setFilterOwner("all"); setFilterPriority("all"); setFilterLeadSource("all"); setFilterAccountStatus("all"); }}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Board or List view */}
      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {(activeStages.length > 0 ? activeStages : ACTIVE_STAGES).map(s => (
            <div key={s} className="flex-shrink-0 w-64 space-y-2">
              <Skeleton className="h-6 w-32" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      ) : viewMode === "kanban" ? (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0">
          {activeStages.map(stage => {
            const cards = byStage(stage as ProspectStage);
            const stageLabel = stageLabels[stage] ?? stage;
            const isWon = stage === "first_load_won";
            const colWeighted = cards.reduce((sum, p) => sum + weightedValue(p), 0);
            return (
              <div key={stage} className="flex-shrink-0 w-64 flex flex-col gap-2" data-testid={`kanban-column-${stage}`}>
                <div className="px-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {isWon && <Trophy className="h-3.5 w-3.5 text-emerald-500" />}
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{stageLabel}</span>
                    </div>
                    {cards.length > 0 && <Badge variant="secondary" className="text-[10px] font-semibold h-4 px-1.5">{cards.length}</Badge>}
                  </div>
                  {colWeighted > 0 && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-0.5 font-medium">{formatCurrency(colWeighted)} weighted</p>}
                </div>
                <div className="flex flex-col gap-2 flex-1 min-h-[120px] bg-muted/20 rounded-lg p-2">
                  {cards.length === 0 ? (
                    <div className="flex items-center justify-center h-16 text-xs text-muted-foreground/50">Empty</div>
                  ) : (
                    cards.map(p => <ProspectCard key={p.id} prospect={p} onClick={() => onSelectProspect(p)} oppSummary={oppsSummary[p.id]} staleThreshold={staleThreshold} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Table / List view */
        <div className="border rounded-lg overflow-hidden overflow-x-auto flex-1 min-h-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                {([
                  { key: "name", label: "Account", sortable: true },
                  { key: "accountStatus", label: "Account Status", sortable: true },
                  { key: "stage", label: "Stage", sortable: false },
                  { key: "owner", label: "Owner", sortable: false },
                  { key: "priority", label: "Priority", sortable: false },
                  { key: "openOpps", label: "Open Opps", sortable: true },
                  { key: "pipeline", label: "Pipeline", sortable: true },
                  { key: "followUp", label: "Follow-up", sortable: false },
                  { key: "lastActivity", label: "Last Activity", sortable: true },
                ] as const).map(col => (
                  <TableHead
                    key={col.key}
                    className={`text-xs py-2 ${col.sortable ? "cursor-pointer select-none hover:bg-muted/60" : ""}`}
                    onClick={col.sortable && (col.key === "name" || col.key === "accountStatus" || col.key === "openOpps" || col.key === "pipeline" || col.key === "lastActivity") ? () => sortCol(col.key as typeof tableSortField) : undefined}
                    data-testid={col.sortable ? `th-sort-${col.key}` : undefined}
                  >
                    <span className="flex items-center gap-1">
                      {col.label}
                      {tableSortField === col.key && <span className="text-[10px]">{tableSortDir === "asc" ? "↑" : "↓"}</span>}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableSorted.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground text-sm py-8">No accounts match your filters</TableCell></TableRow>
              )}
              {tableSorted.map(p => {
                const overdue = isOverdue(p.followUpDate);
                const dueToday = isDueToday(p.followUpDate);
                const summary = oppsSummary[p.id];
                return (
                  <TableRow key={p.id} className="cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => onSelectProspect(p)} data-testid={`table-row-${p.id}`}>
                    <TableCell className="py-2">
                      <div><p className="font-medium text-sm">{p.name}</p>{p.industry && <p className="text-xs text-muted-foreground">{p.industry}</p>}</div>
                    </TableCell>
                    <TableCell className="py-2">
                      <AccountStatusBadge status={p.accountStatus} changedAt={p.accountStatusChangedAt} />
                    </TableCell>
                    <TableCell className="py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${STAGE_BORDER[p.stage]?.replace("border-t-", "text-").replace("-400", "-600").replace("-500", "-600") ?? ""} bg-muted`}>
                        {stageLabels[p.stage] ?? PROSPECT_STAGE_LABELS[p.stage as ProspectStage]}
                      </span>
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">{p.ownerName ?? "—"}</TableCell>
                    <TableCell className="py-2">
                      {p.priority === "hot" && <span className="text-[10px] font-semibold text-red-600">🔴 Hot</span>}
                      {p.priority === "warm" && <span className="text-[10px] font-semibold text-amber-600">🟡 Warm</span>}
                      {p.priority === "cold" && <span className="text-[10px] font-semibold text-blue-600">🔵 Cold</span>}
                      {!p.priority && <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {summary?.openCount ? <span className="text-blue-600 font-medium" data-testid={`table-opp-count-${p.id}`}>{summary.openCount}</span> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {summary?.pipelineValue ? <span className="text-emerald-600 font-semibold" data-testid={`table-pipeline-${p.id}`}>{formatCurrency(summary.pipelineValue)}/mo</span> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {p.followUpDate ? (
                        <span className={overdue ? "text-red-600 font-medium" : dueToday ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                          {p.followUpDate}{overdue ? " ⚠" : dueToday ? " · Today" : ""}
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">{daysAgo(p.updatedAt as unknown as string)}d ago</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Lost / Disqualified accordion */}
      {closedProspects.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <button className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/40 hover:bg-muted/60 text-sm font-medium transition-colors" onClick={() => setLostOpen(v => !v)} data-testid="button-toggle-lost">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-500" />
              <span>Lost / Disqualified <span className="text-muted-foreground font-normal">({closedProspects.length})</span></span>
            </div>
            {lostOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
          {lostOpen && (
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 border-t bg-background">
              {closedProspects.map(p => (
                <div key={p.id} className="border rounded-lg p-3 cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => onSelectProspect(p)} data-testid={`lost-card-${p.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-sm text-muted-foreground">{p.name}</p>
                      {p.industry && <p className="text-xs text-muted-foreground">{p.industry}</p>}
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0 text-red-600 border-red-300 dark:text-red-400 dark:border-red-700">
                      {stageLabels[p.stage] ?? PROSPECT_STAGE_LABELS[p.stage as ProspectStage]}
                    </Badge>
                  </div>
                  {p.lostReason && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {PROSPECT_LOST_REASON_LABELS[p.lostReason as keyof typeof PROSPECT_LOST_REASON_LABELS] ?? p.lostReason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
