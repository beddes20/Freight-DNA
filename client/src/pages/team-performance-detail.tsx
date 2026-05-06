import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Phone, MessageSquare, Mail, UserCheck, Heart,
  Clock, AlertTriangle, Building2, UserPlus, ArrowUpRight,
  ChevronUp, ChevronDown, ChevronsUpDown, Paperclip,
} from "lucide-react";
import { useState } from "react";

type PeriodOption = "current" | "last" | "ytd";

interface TouchpointRow {
  id: string;
  repName: string;
  contactName: string | null;
  companyName: string | null;
  date: string;
  notes: string | null;
  hasAttachments: boolean;
  isMeaningful: boolean;
  type: string;
}

interface TaskRow {
  id: string;
  title: string;
  notes: string | null;
  repName: string;
  companyName: string | null;
  dueDate: string | null;
  status: string;
  isOverdue: boolean;
}

interface AccountRow {
  id: string;
  accountName: string;
  repName: string;
  industry: string | null;
}

interface NewContactRow {
  id: string;
  contactName: string;
  companyName: string | null;
  repName: string;
  dateAdded: string | null;
}

interface RelationshipRow {
  id: string;
  contactName: string;
  companyName: string | null;
  repName: string;
  dateAdvanced: string | null;
  relationshipBase: string | null;
}

type DetailRow = TouchpointRow | TaskRow | AccountRow | NewContactRow | RelationshipRow;

interface DetailResponse {
  metric: string;
  period: string;
  startDate: string;
  endDate: string;
  rows: DetailRow[];
}

function getPeriodLabel(period: PeriodOption): string {
  const now = new Date();
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  if (period === "current") {
    const month = monthNames[now.getMonth()];
    const day = now.getDate();
    return `${month} 1 – ${month} ${day}, ${now.getFullYear()}`;
  } else if (period === "last") {
    const lastMonthIdx = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const lastMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const lastDay = new Date(lastMonthYear, lastMonthIdx + 1, 0).getDate();
    return `${monthNames[lastMonthIdx]} 1 – ${monthNames[lastMonthIdx]} ${lastDay}, ${lastMonthYear}`;
  } else {
    const month = monthNames[now.getMonth()];
    const day = now.getDate();
    return `Jan 1 – ${month} ${day}, ${now.getFullYear()}`;
  }
}

interface MetricConfig {
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  tableType: "touchpoint" | "task" | "account";
}

const METRIC_CONFIGS: Record<string, MetricConfig> = {
  calls: { label: "Calls", icon: <Phone className="h-5 w-5 text-blue-500" />, color: "text-blue-600", bgColor: "bg-blue-100 dark:bg-blue-900/40", tableType: "touchpoint" },
  texts: { label: "Texts", icon: <MessageSquare className="h-5 w-5 text-green-500" />, color: "text-green-600", bgColor: "bg-green-100 dark:bg-green-900/40", tableType: "touchpoint" },
  emails: { label: "Emails", icon: <Mail className="h-5 w-5 text-purple-500" />, color: "text-purple-600", bgColor: "bg-purple-100 dark:bg-purple-900/40", tableType: "touchpoint" },
  touched: { label: "Contacts Touched", icon: <UserCheck className="h-5 w-5 text-cyan-500" />, color: "text-cyan-600", bgColor: "bg-cyan-100 dark:bg-cyan-900/40", tableType: "touchpoint" },
  meaningful: { label: "Meaningful Touchpoints", icon: <Heart className="h-5 w-5 text-rose-500" />, color: "text-rose-600", bgColor: "bg-rose-100 dark:bg-rose-900/40", tableType: "touchpoint" },
  open_tasks: { label: "Open Tasks", icon: <Clock className="h-5 w-5 text-amber-500" />, color: "text-amber-600", bgColor: "bg-amber-100 dark:bg-amber-900/40", tableType: "task" },
  overdue: { label: "Overdue Tasks", icon: <AlertTriangle className="h-5 w-5 text-red-500" />, color: "text-red-600", bgColor: "bg-red-100 dark:bg-red-900/40", tableType: "task" },
  total_accounts: { label: "Total Accounts", icon: <Building2 className="h-5 w-5 text-blue-500" />, color: "text-blue-600", bgColor: "bg-blue-100 dark:bg-blue-900/40", tableType: "account" },
  new_contacts: { label: "New Contacts", icon: <UserPlus className="h-5 w-5 text-emerald-500" />, color: "text-emerald-600", bgColor: "bg-emerald-100 dark:bg-emerald-900/40", tableType: "account" },
  relationships_moved: { label: "Relationships Moved", icon: <ArrowUpRight className="h-5 w-5 text-teal-500" />, color: "text-teal-600", bgColor: "bg-teal-100 dark:bg-teal-900/40", tableType: "account" },
};

type SortDir = "asc" | "desc" | null;

function SortIcon({ dir }: { dir: SortDir }) {
  if (dir === "asc") return <ChevronUp className="h-3.5 w-3.5 ml-1 inline" />;
  if (dir === "desc") return <ChevronDown className="h-3.5 w-3.5 ml-1 inline" />;
  return <ChevronsUpDown className="h-3 w-3 ml-1 inline text-muted-foreground/50" />;
}

function SortableHeader({ label, field, sortField, sortDir, onSort }: {
  label: string;
  field: string;
  sortField: string | null;
  sortDir: SortDir;
  onSort: (field: string) => void;
}) {
  const active = sortField === field;
  return (
    <th
      className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap"
      onClick={() => onSort(field)}
      data-testid={`header-sort-${field}`}
    >
      {label}
      <SortIcon dir={active ? sortDir : null} />
    </th>
  );
}

function ExpandableNotes({ notes }: { notes: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!notes) return <span className="text-muted-foreground text-xs">—</span>;
  const isLong = notes.length > 80;
  if (!isLong) return <span className="text-xs">{notes}</span>;
  return (
    <span className="text-xs">
      {expanded ? notes : `${notes.slice(0, 80)}…`}
      <button
        className="ml-1 text-blue-500 hover:underline text-[11px]"
        onClick={() => setExpanded(v => !v)}
        data-testid="button-expand-notes"
      >
        {expanded ? "less" : "more"}
      </button>
    </span>
  );
}

function sortByField<T extends object>(rows: T[], field: string, dir: SortDir): T[] {
  if (!field || !dir) return rows;
  return [...rows].sort((a, b) => {
    const av = String((a as Record<string, unknown>)[field] ?? "");
    const bv = String((b as Record<string, unknown>)[field] ?? "");
    const cmp = av.localeCompare(bv, undefined, { numeric: true });
    return dir === "asc" ? cmp : -cmp;
  });
}

function TouchpointTable({ rows }: { rows: TouchpointRow[] }) {
  const [sortField, setSortField] = useState<string>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const sorted = sortByField<TouchpointRow>(rows, sortField, sortDir);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="table-touchpoints">
        <thead className="bg-muted/40 border-b">
          <tr>
            <SortableHeader label="Rep" field="repName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Contact" field="contactName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Company" field="companyName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Date" field="date" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Notes</th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Att.</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((row, i) => (
            <tr key={row.id ?? i} className="hover:bg-muted/30 transition-colors" data-testid={`row-touchpoint-${row.id ?? i}`}>
              <td className="px-3 py-2.5 font-medium text-sm whitespace-nowrap">{row.repName}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.contactName ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.companyName ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.date}</td>
              <td className="px-3 py-2.5 max-w-xs"><ExpandableNotes notes={row.notes} /></td>
              <td className="px-3 py-2.5 text-center">
                {row.hasAttachments
                  ? <Paperclip className="h-3.5 w-3.5 text-muted-foreground inline" />
                  : <span className="text-muted-foreground text-xs">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskTable({ rows }: { rows: TaskRow[] }) {
  const [sortField, setSortField] = useState<string>("dueDate");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sorted = sortByField<TaskRow>(rows, sortField, sortDir);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="table-tasks">
        <thead className="bg-muted/40 border-b">
          <tr>
            <SortableHeader label="Title" field="title" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Assigned Rep" field="repName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Company" field="companyName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Due Date" field="dueDate" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Status" field="status" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((row, i) => (
            <tr key={row.id ?? i} className="hover:bg-muted/30 transition-colors" data-testid={`row-task-${row.id ?? i}`}>
              <td className="px-3 py-2.5">
                <div className="font-medium text-sm">{row.title}</div>
                {row.notes && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{row.notes}</div>}
              </td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.repName}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.companyName ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">
                {row.dueDate
                  ? <span className={row.isOverdue ? "text-red-600 font-medium" : ""}>{row.dueDate}</span>
                  : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-2.5">
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 h-5 capitalize ${row.status === "completed" ? "border-green-300 text-green-700 dark:border-green-700 dark:text-green-400" : row.isOverdue ? "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400" : ""}`}
                  data-testid={`badge-status-${row.id}`}
                >
                  {row.status.replace(/_/g, " ")}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountTable({ rows, metric }: { rows: AccountRow[]; metric: string }) {
  const [sortField, setSortField] = useState<string>("accountName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sorted = sortByField<AccountRow>(rows, sortField, sortDir);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="table-accounts">
        <thead className="bg-muted/40 border-b">
          <tr>
            <SortableHeader label="Account Name" field="accountName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Assigned Rep" field="repName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Industry" field="industry" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((row, i) => (
            <tr key={row.id ?? i} className="hover:bg-muted/30 transition-colors" data-testid={`row-account-${row.id ?? i}`}>
              <td className="px-3 py-2.5 font-medium text-sm">{row.accountName}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.repName}</td>
              <td className="px-3 py-2.5 text-sm">{row.industry ?? <span className="text-muted-foreground">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewContactTable({ rows }: { rows: NewContactRow[] }) {
  const [sortField, setSortField] = useState<string>("dateAdded");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const sorted = sortByField<NewContactRow>(rows, sortField, sortDir);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="table-new-contacts">
        <thead className="bg-muted/40 border-b">
          <tr>
            <SortableHeader label="Contact Name" field="contactName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Company" field="companyName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Rep" field="repName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Date Added" field="dateAdded" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((row, i) => (
            <tr key={row.id ?? i} className="hover:bg-muted/30 transition-colors" data-testid={`row-contact-${row.id ?? i}`}>
              <td className="px-3 py-2.5 font-medium text-sm whitespace-nowrap">{row.contactName}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.companyName ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.repName}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.dateAdded ?? <span className="text-muted-foreground">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RelationshipTable({ rows }: { rows: RelationshipRow[] }) {
  const [sortField, setSortField] = useState<string>("dateAdvanced");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const sorted = sortByField<RelationshipRow>(rows, sortField, sortDir);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="table-relationships">
        <thead className="bg-muted/40 border-b">
          <tr>
            <SortableHeader label="Contact Name" field="contactName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Company" field="companyName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Rep" field="repName" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Date Advanced" field="dateAdvanced" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
            <SortableHeader label="Relationship Level" field="relationshipBase" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {sorted.map((row, i) => (
            <tr key={row.id ?? i} className="hover:bg-muted/30 transition-colors" data-testid={`row-relationship-${row.id ?? i}`}>
              <td className="px-3 py-2.5 font-medium text-sm whitespace-nowrap">{row.contactName}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.companyName ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.repName}</td>
              <td className="px-3 py-2.5 text-sm whitespace-nowrap">{row.dateAdvanced ?? <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-2.5 text-sm capitalize">{row.relationshipBase ?? <span className="text-muted-foreground">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TeamPerformanceDetailPage() {
  const { metric } = useParams<{ metric: string }>();
  const search = useSearch();
  const [, navigate] = useLocation();
  const period = (new URLSearchParams(search).get("period") ?? "current") as PeriodOption;
  // UI Trust Micro-Batch (Task #1075) — Task #1060 added the My Team / All
  // Teams toggle on the parent page and serializes `scope` into the URL
  // when navigating to a card drill-down (team-performance.tsx:1089). The
  // server already honors `scope` (server/routes.ts:3648) but the detail
  // page wasn't forwarding it, so clicking a card in "All Teams" view
  // returned the caller's "Mine" tree instead. Read scope from the URL,
  // include it in the queryKey so cache doesn't collide across scopes,
  // and pass it through to the API.
  const scope = (new URLSearchParams(search).get("scope") === "all" ? "all" : "mine") as "mine" | "all";
  const { user } = useAuth();
  const canCoach = !!user && ["admin", "director", "national_account_manager", "sales_director"].includes(user.role);

  const config = metric ? METRIC_CONFIGS[metric] : null;

  const { data, isLoading, isError } = useQuery<DetailResponse>({
    queryKey: ["/api/team/performance/detail", metric, period, scope],
    queryFn: async () => {
      const res = await fetch(`/api/team/performance/detail/${metric}?period=${period}&scope=${scope}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      return res.json();
    },
    enabled: !!metric && !!config,
  });

  const periodLabel = getPeriodLabel(period);

  if (!config) {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center">
        <p className="text-muted-foreground">Unknown metric</p>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  function renderTable() {
    if (!data || rows.length === 0) return null;
    if (config!.tableType === "touchpoint") {
      return <TouchpointTable rows={rows as TouchpointRow[]} />;
    }
    if (config!.tableType === "task") {
      return <TaskTable rows={rows as TaskRow[]} />;
    }
    if (metric === "total_accounts") {
      return <AccountTable rows={rows as AccountRow[]} metric={metric} />;
    }
    if (metric === "new_contacts") {
      return <NewContactTable rows={rows as NewContactRow[]} />;
    }
    if (metric === "relationships_moved") {
      return <RelationshipTable rows={rows as RelationshipRow[]} />;
    }
    return null;
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => navigate(`/team-performance?period=${period}`)}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${config.bgColor}`}>
            {config.icon}
          </div>
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-detail-title">{config.label}</h1>
            <p className="text-sm text-muted-foreground">{periodLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {canCoach && (
            <Link href="/coaching">
              <Button variant="outline" size="sm" data-testid="button-view-in-coaching">
                View in Coaching
              </Button>
            </Link>
          )}
          {!isLoading && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className={`text-2xl font-bold ${config.color}`} data-testid="text-total-count">{rows.length}</span>
            </div>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="pt-6 pb-4 text-center text-muted-foreground">
            Failed to load data. Please try again.
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="pt-6 pb-4 text-center text-muted-foreground" data-testid="text-empty-state">
            No records found for this period.
          </CardContent>
        </Card>
      ) : (
        renderTable()
      )}
    </div>
  );
}
