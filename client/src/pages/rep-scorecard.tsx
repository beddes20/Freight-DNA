import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart3, PhoneCall, Mail, MessageSquare, Building2, Star, UserPlus, Trophy,
  TrendingUp, TrendingDown, Minus, ChevronUp, ChevronDown,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

type TimeRange = "last_week" | "mtd" | "last_month" | "ytd";

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "last_week", label: "Last Week" },
  { value: "mtd", label: "MTD" },
  { value: "last_month", label: "Last Month" },
  { value: "ytd", label: "YTD" },
];

interface RepResult {
  userId: string;
  name: string;
  role: string;
  weeklyTotal: number;
  weeklyCalls: number;
  weeklyEmails: number;
  weeklyTexts: number;
  weeklySiteVisits: number;
  weeklyMeaningful: number;
  contactsAdded: number;
  touchpointGoalTarget: number | null;
  meaningfulGoalTarget: number | null;
  contactsGoalTarget: number | null;
}

interface ScorecardData {
  weekStart: string;
  results: RepResult[];
}

type SortKey = "weeklyTotal" | "weeklyMeaningful" | "contactsAdded" | "weeklyCalls";

const ROLE_LABELS: Record<string, string> = {
  account_manager: "AM",
  national_account_manager: "NAM",
  logistics_manager: "LM",
  logistics_coordinator: "LC",
  sales: "Sales",
};

function GoalBar({ value, target, label }: { value: number; target: number | null; label: string }) {
  if (!target) return <span className="text-sm font-semibold">{value}</span>;
  const pct = Math.min(Math.round((value / target) * 100), 100);
  const color = pct >= 100 ? "bg-emerald-500" : pct >= 70 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{value}</span>
        <span className="text-xs text-muted-foreground">/{target}</span>
      </div>
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PaceBadge({ value, target }: { value: number; target: number | null }) {
  if (!target) return null;
  const pct = Math.round((value / target) * 100);
  if (pct >= 100) return <Badge className="text-[10px] h-4 px-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 font-medium">On pace</Badge>;
  if (pct >= 70) return <Badge className="text-[10px] h-4 px-1 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 font-medium">Near</Badge>;
  return <Badge className="text-[10px] h-4 px-1 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 font-medium">Behind</Badge>;
}

export default function RepScorecardPage() {
  const { user } = useAuth();
  const [sortKey, setSortKey] = useState<SortKey>("weeklyTotal");
  const [sortAsc, setSortAsc] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>("last_week");

  const { data, isLoading, error } = useQuery<ScorecardData>({
    queryKey: ["/api/rep-scorecard", timeRange],
    queryFn: async () => {
      const res = await fetch(`/api/rep-scorecard?range=${timeRange}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch scorecard");
      return res.json();
    },
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  };

  const sorted = data?.results
    ? [...data.results].sort((a, b) => {
        const diff = (a[sortKey] as number) - (b[sortKey] as number);
        return sortAsc ? diff : -diff;
      })
    : [];

  const SortButton = ({ k, label }: { k: SortKey; label: string }) => (
    <button onClick={() => toggleSort(k)} className="flex items-center gap-0.5 hover:text-foreground transition-colors" data-testid={`sort-${k}`}>
      {label}
      {sortKey === k ? (sortAsc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
    </button>
  );

  if (!["admin", "director", "national_account_manager", "sales_director"].includes(user?.role ?? "")) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Access restricted to directors and admins.</p>
      </div>
    );
  }

  const selectedRangeLabel = TIME_RANGE_OPTIONS.find(o => o.value === timeRange)?.label ?? "";

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="max-w-7xl mx-auto w-full px-6 py-6 space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-primary" />
              Rep Scorecard
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {data?.weekStart ? `From ${data.weekStart}` : `${selectedRangeLabel} activity`}
            </p>
          </div>

          {/* Time range pill toggle */}
          <div className="flex items-center bg-muted rounded-full p-1 gap-0.5" data-testid="time-range-toggle">
            {TIME_RANGE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setTimeRange(opt.value)}
                data-testid={`range-${opt.value}`}
                className={`px-3 py-1 rounded-full text-sm font-medium transition-all ${
                  timeRange === opt.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {error && (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Failed to load scorecard data.</CardContent></Card>
        )}

        {!isLoading && sorted.length === 0 && (
          <Card><CardContent className="py-8 text-center text-muted-foreground">No rep data available.</CardContent></Card>
        )}

        {!isLoading && sorted.length > 0 && (
          <>
            {/* Summary stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: `Total Touchpoints (${selectedRangeLabel})`, value: sorted.reduce((s, r) => s + r.weeklyTotal, 0), icon: PhoneCall, color: "text-blue-500" },
                { label: "Meaningful Conversations", value: sorted.reduce((s, r) => s + r.weeklyMeaningful, 0), icon: Star, color: "text-amber-500" },
                { label: `Contacts Added (${selectedRangeLabel})`, value: sorted.reduce((s, r) => s + r.contactsAdded, 0), icon: UserPlus, color: "text-emerald-500" },
                { label: "Active Reps", value: sorted.filter(r => r.weeklyTotal > 0).length, icon: Trophy, color: "text-purple-500" },
              ].map(stat => (
                <Card key={stat.label}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <stat.icon className={`h-4 w-4 ${stat.color}`} />
                      <span className="text-xs text-muted-foreground">{stat.label}</span>
                    </div>
                    <p className="text-2xl font-bold">{stat.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Leaderboard table */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Rep Rankings</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-rep-scorecard">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left pb-2 pr-4 font-medium w-6">#</th>
                      <th className="text-left pb-2 pr-4 font-medium">Rep</th>
                      <th className="text-right pb-2 px-3 font-medium">
                        <SortButton k="weeklyTotal" label="Touches" />
                      </th>
                      <th className="text-right pb-2 px-3 font-medium hidden sm:table-cell">Calls</th>
                      <th className="text-right pb-2 px-3 font-medium hidden sm:table-cell">Emails</th>
                      <th className="text-right pb-2 px-3 font-medium hidden md:table-cell">Texts</th>
                      <th className="text-right pb-2 px-3 font-medium hidden md:table-cell">Visits</th>
                      <th className="text-right pb-2 px-3 font-medium">
                        <SortButton k="weeklyMeaningful" label="Meaningful" />
                      </th>
                      <th className="text-right pb-2 pl-3 font-medium">
                        <SortButton k="contactsAdded" label="New Contacts" />
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sorted.map((rep, idx) => {
                      const rank = idx + 1;
                      const rankIcon = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}`;
                      const isMe = rep.userId === user?.id;
                      return (
                        <tr key={rep.userId} className={`hover:bg-muted/40 transition-colors ${isMe ? "bg-primary/5" : ""}`} data-testid={`row-rep-${rep.userId}`}>
                          <td className="py-3 pr-4 text-sm font-medium text-muted-foreground">{rankIcon}</td>
                          <td className="py-3 pr-4">
                            <div className="flex items-center gap-2">
                              <div>
                                <p className="font-medium flex items-center gap-1.5">
                                  {rep.name}
                                  {isMe && <Badge variant="outline" className="text-[10px] h-4 px-1 font-normal">You</Badge>}
                                </p>
                                <p className="text-xs text-muted-foreground">{ROLE_LABELS[rep.role] ?? rep.role}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="min-w-[60px]">
                              <GoalBar value={rep.weeklyTotal} target={rep.touchpointGoalTarget} label="touches" />
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right hidden sm:table-cell">
                            <span className="text-sm font-medium">{rep.weeklyCalls}</span>
                          </td>
                          <td className="py-3 px-3 text-right hidden sm:table-cell">
                            <span className="text-sm font-medium">{rep.weeklyEmails}</span>
                          </td>
                          <td className="py-3 px-3 text-right hidden md:table-cell">
                            <span className="text-sm font-medium">{rep.weeklyTexts}</span>
                          </td>
                          <td className="py-3 px-3 text-right hidden md:table-cell">
                            <span className="text-sm font-medium">{rep.weeklySiteVisits}</span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="flex flex-col items-end gap-0.5">
                              <GoalBar value={rep.weeklyMeaningful} target={rep.meaningfulGoalTarget} label="meaningful" />
                              <PaceBadge value={rep.weeklyMeaningful} target={rep.meaningfulGoalTarget} />
                            </div>
                          </td>
                          <td className="py-3 pl-3 text-right">
                            <div className="flex flex-col items-end gap-0.5">
                              <GoalBar value={rep.contactsAdded} target={rep.contactsGoalTarget} label="contacts" />
                              <PaceBadge value={rep.contactsAdded} target={rep.contactsGoalTarget} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Breakdown cards per rep */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {sorted.map((rep, idx) => {
                const totalPct = rep.touchpointGoalTarget ? Math.min(Math.round((rep.weeklyTotal / rep.touchpointGoalTarget) * 100), 100) : null;
                const barColor = totalPct == null ? "bg-primary" : totalPct >= 100 ? "bg-emerald-500" : totalPct >= 70 ? "bg-amber-500" : "bg-red-500";
                return (
                  <Card key={rep.userId} className={rep.userId === user?.id ? "ring-2 ring-primary/30" : ""} data-testid={`card-rep-${rep.userId}`}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-sm">{idx + 1}. {rep.name}</p>
                          <p className="text-xs text-muted-foreground">{ROLE_LABELS[rep.role] ?? rep.role}</p>
                        </div>
                        {totalPct != null && (
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${barColor} text-white`}>{totalPct}%</span>
                        )}
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="bg-muted/50 rounded-md p-2">
                          <PhoneCall className="h-3 w-3 mx-auto text-blue-500 mb-0.5" />
                          <p className="text-base font-bold">{rep.weeklyCalls}</p>
                          <p className="text-[10px] text-muted-foreground">Calls</p>
                        </div>
                        <div className="bg-muted/50 rounded-md p-2">
                          <Mail className="h-3 w-3 mx-auto text-purple-500 mb-0.5" />
                          <p className="text-base font-bold">{rep.weeklyEmails}</p>
                          <p className="text-[10px] text-muted-foreground">Emails</p>
                        </div>
                        <div className="bg-muted/50 rounded-md p-2">
                          <Star className="h-3 w-3 mx-auto text-amber-500 mb-0.5" />
                          <p className="text-base font-bold">{rep.weeklyMeaningful}</p>
                          <p className="text-[10px] text-muted-foreground">Meaningful</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border">
                        <span className="flex items-center gap-1"><UserPlus className="h-3 w-3" />{rep.contactsAdded} new contacts</span>
                        <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{rep.weeklySiteVisits} visits</span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
