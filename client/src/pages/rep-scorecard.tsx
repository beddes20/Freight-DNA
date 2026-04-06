import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  BarChart3, PhoneCall, Mail, MessageSquare, Building2, Star, UserPlus, Trophy,
  TrendingUp, ChevronUp, ChevronDown,
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
  relationshipsMoved: number;
  touchpointGoalTarget: number | null;
  meaningfulGoalTarget: number | null;
  contactsGoalTarget: number | null;
}

interface ScorecardData {
  weekStart: string;
  results: RepResult[];
}

type SortKey = "weeklyTotal" | "weeklyMeaningful" | "contactsAdded" | "weeklyCalls" | "relationshipsMoved";

const ROLE_LABELS: Record<string, string> = {
  account_manager: "AM",
  national_account_manager: "NAM",
};

function GoalBar({ value, target }: { value: number; target: number | null }) {
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

interface PortletProps {
  title: string;
  reps: RepResult[];
  currentUserId: string | undefined;
}

function RepPortlet({ title, reps, currentUserId }: PortletProps) {
  const [sortKey, setSortKey] = useState<SortKey>("weeklyTotal");
  const [sortAsc, setSortAsc] = useState(false);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  };

  const sorted = [...reps].sort((a, b) => {
    const diff = (a[sortKey] as number) - (b[sortKey] as number);
    return sortAsc ? diff : -diff;
  });

  const SortButton = ({ k, label }: { k: SortKey; label: string }) => (
    <button
      onClick={() => toggleSort(k)}
      className="flex items-center gap-0.5 hover:text-foreground transition-colors"
      data-testid={`sort-${title.replace(/\s+/g, "-").toLowerCase()}-${k}`}
    >
      {label}
      {sortKey === k ? (sortAsc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
    </button>
  );

  if (sorted.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Card><CardContent className="py-6 text-center text-muted-foreground text-sm">No reps in this group.</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2" data-testid={`portlet-title-${title.replace(/\s+/g, "-").toLowerCase()}`}>
        {title}
        <Badge variant="secondary" className="text-xs font-normal">{sorted.length} reps</Badge>
      </h2>

      {/* Leaderboard table */}
      <Card>
        <CardContent className="pt-4 overflow-x-auto">
          <table className="w-full text-sm" data-testid={`table-${title.replace(/\s+/g, "-").toLowerCase()}`}>
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
                <th className="text-right pb-2 px-3 font-medium">
                  <SortButton k="contactsAdded" label="New Contacts" />
                </th>
                <th className="text-right pb-2 pl-3 font-medium">
                  <SortButton k="relationshipsMoved" label="Rel. Moved Up" />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((rep, idx) => {
                const rank = idx + 1;
                const rankIcon = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `${rank}`;
                const isMe = rep.userId === currentUserId;
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
                        <GoalBar value={rep.weeklyTotal} target={rep.touchpointGoalTarget} />
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
                        <GoalBar value={rep.weeklyMeaningful} target={rep.meaningfulGoalTarget} />
                        <PaceBadge value={rep.weeklyMeaningful} target={rep.meaningfulGoalTarget} />
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        <GoalBar value={rep.contactsAdded} target={rep.contactsGoalTarget} />
                        <PaceBadge value={rep.contactsAdded} target={rep.contactsGoalTarget} />
                      </div>
                    </td>
                    <td className="py-3 pl-3 text-right">
                      <span className="text-sm font-semibold">{rep.relationshipsMoved}</span>
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
            <Card key={rep.userId} className={rep.userId === currentUserId ? "ring-2 ring-primary/30" : ""} data-testid={`card-rep-${rep.userId}`}>
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

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-muted/50 rounded-md p-2">
                    <UserPlus className="h-3 w-3 mx-auto text-emerald-500 mb-0.5" />
                    <p className="text-base font-bold">{rep.contactsAdded}</p>
                    <p className="text-[10px] text-muted-foreground">New Contacts</p>
                  </div>
                  <div className="bg-muted/50 rounded-md p-2">
                    <Building2 className="h-3 w-3 mx-auto text-slate-500 mb-0.5" />
                    <p className="text-base font-bold">{rep.weeklySiteVisits}</p>
                    <p className="text-[10px] text-muted-foreground">Visits</p>
                  </div>
                  <div className="bg-muted/50 rounded-md p-2">
                    <TrendingUp className="h-3 w-3 mx-auto text-indigo-500 mb-0.5" />
                    <p className="text-base font-bold">{rep.relationshipsMoved}</p>
                    <p className="text-[10px] text-muted-foreground">Rel. Moved Up</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export default function RepScorecardPage() {
  const { user } = useAuth();
  const [timeRange, setTimeRange] = useState<TimeRange>("last_week");

  const { data, isLoading, error } = useQuery<ScorecardData>({
    queryKey: ["/api/rep-scorecard", timeRange],
    queryFn: async () => {
      const res = await fetch(`/api/rep-scorecard?range=${timeRange}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch scorecard");
      return res.json();
    },
  });

  if (!["admin", "director", "national_account_manager", "sales_director"].includes(user?.role ?? "")) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Access restricted to directors and admins.</p>
      </div>
    );
  }

  const selectedRangeLabel = TIME_RANGE_OPTIONS.find(o => o.value === timeRange)?.label ?? "";
  const allReps = data?.results ?? [];
  const nams = allReps.filter(r => r.role === "national_account_manager");
  const ams = allReps.filter(r => r.role === "account_manager");

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="max-w-7xl mx-auto w-full px-6 py-6 space-y-8">

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

        {!isLoading && !error && (
          <>
            {/* Summary stat cards (all reps combined) */}
            {allReps.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: `Total Touchpoints (${selectedRangeLabel})`, value: allReps.reduce((s, r) => s + r.weeklyTotal, 0), icon: PhoneCall, color: "text-blue-500" },
                  { label: "Meaningful Conversations", value: allReps.reduce((s, r) => s + r.weeklyMeaningful, 0), icon: Star, color: "text-amber-500" },
                  { label: `Contacts Added (${selectedRangeLabel})`, value: allReps.reduce((s, r) => s + r.contactsAdded, 0), icon: UserPlus, color: "text-emerald-500" },
                  { label: "Active Reps", value: allReps.filter(r => r.weeklyTotal > 0).length, icon: Trophy, color: "text-purple-500" },
                ].map(stat => (
                  <Card key={stat.label}>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <stat.icon className={`h-4 w-4 ${stat.color}`} />
                        <span className="text-xs text-muted-foreground">{stat.label}</span>
                      </div>
                      <p className="text-2xl font-bold" data-testid={`stat-${stat.label.replace(/\s+/g, "-").toLowerCase()}`}>{stat.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* NAM Portlet */}
            <RepPortlet
              title="National Account Managers"
              reps={nams}
              currentUserId={user?.id}
            />

            {/* AM Portlet */}
            <RepPortlet
              title="Account Managers"
              reps={ams}
              currentUserId={user?.id}
            />
          </>
        )}
      </div>
    </div>
  );
}
