import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Phone,
  Mail,
  MessageSquare,
  MapPin,
  Search,
  Star,
  History,
  User,
  Building2,
  Filter,
  Trash2,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type EnrichedTouchpoint = {
  id: string;
  date: string;
  type: string;
  notes: string | null;
  sentiment: string | null;
  isMeaningful: boolean;
  createdAt: string;
  contactId: string | null;
  contactName: string | null;
  companyId: string;
  companyName: string;
  loggedById: string;
  loggedByName: string;
};

const TYPE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  call:       { label: "Call",       icon: Phone,          color: "text-blue-600 dark:text-blue-400"   },
  email:      { label: "Email",      icon: Mail,           color: "text-violet-600 dark:text-violet-400" },
  text:       { label: "Text",       icon: MessageSquare,  color: "text-emerald-600 dark:text-emerald-400" },
  site_visit: { label: "Site Visit", icon: MapPin,         color: "text-amber-600 dark:text-amber-400"  },
};

const SENTIMENT_CONFIG: Record<string, { label: string; dot: string }> = {
  positive: { label: "Positive", dot: "bg-emerald-500" },
  neutral:  { label: "Neutral",  dot: "bg-yellow-500"  },
  negative: { label: "Negative", dot: "bg-red-500"     },
};

const PRESETS = [
  { label: "Last 7 days",  days: 7   },
  { label: "Last 30 days", days: 30  },
  { label: "Last 90 days", days: 90  },
  { label: "All time",     days: 0   },
];

function dateFromDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

function TypeIcon({ type }: { type: string }) {
  const cfg = TYPE_CONFIG[type] ?? { icon: History, color: "text-muted-foreground" };
  const Icon = cfg.icon;
  return <Icon className={`h-4 w-4 ${cfg.color} shrink-0`} />;
}

const MANAGER_ROLES = ["admin", "director", "national_account_manager", "sales", "sales_director"];
const DELETE_ROLES = ["admin", "director"];

export default function TouchpointHistoryPage() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user?.role ?? "");
  const canDelete = DELETE_ROLES.includes(user?.role ?? "");
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [presetIdx, setPresetIdx] = useState(1); // default: last 30 days
  const [repFilter, setRepFilter] = useState("all");

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/touchpoints/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/today"] });
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/company-summary"] });
      toast({ title: "Touchpoint deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete touchpoint", variant: "destructive" });
    },
  });

  const { data: touchpoints, isLoading } = useQuery<EnrichedTouchpoint[]>({
    queryKey: ["/api/touchpoints/history"],
  });

  const reps = useMemo(() => {
    if (!touchpoints) return [];
    const map = new Map<string, string>();
    touchpoints.forEach(tp => map.set(tp.loggedById, tp.loggedByName));
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [touchpoints]);

  const filtered = useMemo(() => {
    if (!touchpoints) return [];
    const preset = PRESETS[presetIdx];
    const sinceDate = preset.days > 0 ? dateFromDaysAgo(preset.days) : null;
    const q = search.toLowerCase();

    return touchpoints.filter(tp => {
      if (sinceDate && tp.date < sinceDate) return false;
      if (typeFilter !== "all" && tp.type !== typeFilter) return false;
      if (repFilter !== "all" && tp.loggedById !== repFilter) return false;
      if (q && !tp.companyName.toLowerCase().includes(q) && !(tp.contactName ?? "").toLowerCase().includes(q) && !(tp.notes ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [touchpoints, presetIdx, typeFilter, repFilter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, call: 0, email: 0, text: 0, site_visit: 0 };
    filtered.forEach(tp => {
      c.all++;
      if (c[tp.type] !== undefined) c[tp.type]++;
    });
    return c;
  }, [filtered]);

  const meaningful = useMemo(() => filtered.filter(tp => tp.isMeaningful).length, [filtered]);

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <History className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            Touchpoint History
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isLoading ? "Loading…" : `${filtered.length} touchpoints · ${meaningful} meaningful`}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Date presets */}
        <div className="flex rounded-md border border-border overflow-hidden shrink-0">
          {PRESETS.map((p, i) => (
            <button
              key={i}
              onClick={() => setPresetIdx(i)}
              data-testid={`button-preset-${i}`}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                presetIdx === i
                  ? "bg-emerald-600 text-white"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-8 w-40 text-xs" data-testid="select-type-filter">
            <Filter className="h-3 w-3 mr-1.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types ({counts.all})</SelectItem>
            <SelectItem value="call">Calls ({counts.call})</SelectItem>
            <SelectItem value="email">Emails ({counts.email})</SelectItem>
            <SelectItem value="text">Texts ({counts.text})</SelectItem>
            <SelectItem value="site_visit">Site Visits ({counts.site_visit})</SelectItem>
          </SelectContent>
        </Select>

        {/* Rep filter — managers only */}
        {isManager && reps.length > 1 && (
          <Select value={repFilter} onValueChange={setRepFilter}>
            <SelectTrigger className="h-8 w-44 text-xs" data-testid="select-rep-filter">
              <User className="h-3 w-3 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="All reps" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reps</SelectItem>
              {reps.map(r => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Search */}
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search company, contact, or notes…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs"
            data-testid="input-touchpoint-search"
          />
        </div>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden bg-background">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border text-left">
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">Date</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">Type</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">Company</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">Contact</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground">Notes</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">Sentiment</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">Rep</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">⭐</th>
                {canDelete && <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap w-10"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="hover:bg-muted/30">
                    {[160, 80, 140, 120, 240, 80, 100, 40, ...(canDelete ? [28] : [])].map((w, j) => (
                      <td key={j} className="px-4 py-3">
                        <Skeleton className="h-4" style={{ width: w }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={canDelete ? 9 : 8} className="px-4 py-16 text-center text-muted-foreground text-sm">
                    No touchpoints found for the selected filters.
                  </td>
                </tr>
              ) : (
                filtered.map(tp => {
                  const typeCfg = TYPE_CONFIG[tp.type];
                  const sentCfg = tp.sentiment ? SENTIMENT_CONFIG[tp.sentiment] : null;
                  return (
                    <tr key={tp.id} className="group hover:bg-muted/30 transition-colors" data-testid={`row-touchpoint-${tp.id}`}>
                      <td className="px-4 py-3 whitespace-nowrap text-foreground font-mono text-xs">
                        {tp.date}
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                          <TypeIcon type={tp.type} />
                          <span className={`text-xs font-medium ${typeCfg?.color ?? "text-muted-foreground"}`}>
                            {typeCfg?.label ?? tp.type}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Link href={`/companies/${tp.companyId}`} className="text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1">
                          <Building2 className="h-3 w-3 shrink-0" />
                          {tp.companyName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-foreground">
                        {tp.contactName ?? <span className="text-muted-foreground italic text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        {tp.notes ? (
                          <span className="text-sm text-foreground line-clamp-2" title={stripHtml(tp.notes)}>
                            {stripHtml(tp.notes)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground italic text-xs">No notes</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {sentCfg ? (
                          <span className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className={`h-2 w-2 rounded-full shrink-0 ${sentCfg.dot}`} />
                            <span className="text-xs text-muted-foreground">{sentCfg.label}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">
                        {tp.loggedByName}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {tp.isMeaningful ? (
                          <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500 mx-auto" />
                        ) : (
                          <span className="text-muted-foreground/30 text-xs">·</span>
                        )}
                      </td>
                      {canDelete && (
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => {
                              if (confirm("Delete this touchpoint? This cannot be undone.")) {
                                deleteMutation.mutate(tp.id);
                              }
                            }}
                            disabled={deleteMutation.isPending}
                            className="text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                            data-testid={`button-delete-touchpoint-${tp.id}`}
                            title="Delete touchpoint"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!isLoading && filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-right">
          Showing {filtered.length} of {touchpoints?.length ?? 0} total
        </p>
      )}
    </div>
  );
}
