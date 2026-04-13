import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2, XCircle, Minus, Sun, Clock, Download, RefreshCw } from "lucide-react";
import { format, subDays } from "date-fns";

interface CheckinRow {
  id: number;
  check_date: string;
  check_type: "morning" | "afternoon";
  check_calls_done: boolean | null;
  board_clean: boolean | null;
  checkout_done: boolean | null;
  notes: string | null;
  created_at: string;
  reviewer_id: string;
  reviewer_name: string;
  lm_id: string;
  lm_name: string;
}

function BoolCell({ value }: { value: boolean | null }) {
  if (value === true) return <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />;
  if (value === false) return <XCircle className="w-4 h-4 text-red-500" />;
  return <Minus className="w-4 h-4 text-muted-foreground/40" />;
}

function safeFormatDate(dateValue: unknown): string {
  try {
    let dateStr: string;
    if (dateValue instanceof Date) {
      dateStr = dateValue.toISOString().slice(0, 10);
    } else if (typeof dateValue === "string") {
      dateStr = dateValue.slice(0, 10);
    } else {
      return String(dateValue ?? "");
    }
    return format(new Date(dateStr + "T12:00:00"), "EEEE, MMMM d, yyyy");
  } catch {
    return String(dateValue ?? "");
  }
}

function normalizeCheckDate(dateValue: unknown): string {
  try {
    if (dateValue instanceof Date) {
      if (isNaN(dateValue.getTime())) return "";
      return dateValue.toISOString().slice(0, 10);
    }
    if (typeof dateValue === "string") {
      return dateValue.slice(0, 10);
    }
    return String(dateValue ?? "");
  } catch {
    return "";
  }
}

export default function LmCheckinHistory() {
  const { user } = useAuth();
  const [from, setFrom] = useState(format(subDays(new Date(), 14), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [filterType, setFilterType] = useState("all");

  const managerRoles = ["admin","director","national_account_manager","sales_director","account_manager"];
  const isAuthorized = !!user && managerRoles.includes(user.role);

  const params = new URLSearchParams({ from, to });
  const { data: rows = [], isLoading, refetch } = useQuery<CheckinRow[]>({
    queryKey: [`/api/lm-checkins/history?${params.toString()}`],
    enabled: isAuthorized,
  });

  if (!isAuthorized) {
    return <div className="p-8 text-muted-foreground text-sm">Access denied.</div>;
  }

  const filtered = filterType === "all" ? rows : rows.filter(r => r.check_type === filterType);

  // Group by date for visual separation — normalize check_date to string in case DB returns a Date object
  const grouped: Record<string, CheckinRow[]> = {};
  for (const r of filtered) {
    const dateKey = normalizeCheckDate(r.check_date);
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(r);
  }
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  // Stats summary
  const totalMorning = rows.filter(r => r.check_type === "morning");
  const totalAfternoon = rows.filter(r => r.check_type === "afternoon");
  const morningCallsYes = totalMorning.filter(r => r.check_calls_done === true).length;
  const morningBoardYes = totalMorning.filter(r => r.board_clean === true).length;
  const afternoonCheckoutYes = totalAfternoon.filter(r => r.checkout_done === true).length;
  const afternoonBoardYes = totalAfternoon.filter(r => r.board_clean === true).length;

  function exportCsv() {
    const headers = ["Date", "Type", "Reviewer", "LM", "Check Calls Done", "Board Clean", "Checkout Done", "Notes"];
    const csvRows = rows.map(r => [
      r.check_date, r.check_type, r.reviewer_name, r.lm_name,
      r.check_calls_done === null ? "" : r.check_calls_done ? "Yes" : "No",
      r.board_clean === null ? "" : r.board_clean ? "Yes" : "No",
      r.checkout_done === null ? "" : r.checkout_done ? "Yes" : "No",
      (r.notes ?? "").replace(/,/g, ";"),
    ]);
    const csv = [headers, ...csvRows].map(row => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `lm-checkins-${from}-${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          LM Check-In History
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Daily accountability log — review and coach based on your team's check-in responses.
        </p>
      </div>

      {/* Summary cards */}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1"><Sun className="w-3 h-3" /> Check Calls Done</p>
            <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {totalMorning.length ? Math.round(morningCallsYes / totalMorning.length * 100) : "–"}%
            </p>
            <p className="text-xs text-muted-foreground">{morningCallsYes}/{totalMorning.length} checks</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1"><Sun className="w-3 h-3" /> Morning Board Clean</p>
            <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {totalMorning.length ? Math.round(morningBoardYes / totalMorning.length * 100) : "–"}%
            </p>
            <p className="text-xs text-muted-foreground">{morningBoardYes}/{totalMorning.length} checks</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1"><Clock className="w-3 h-3" /> Checkout Done</p>
            <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {totalAfternoon.length ? Math.round(afternoonCheckoutYes / totalAfternoon.length * 100) : "–"}%
            </p>
            <p className="text-xs text-muted-foreground">{afternoonCheckoutYes}/{totalAfternoon.length} checks</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1"><Clock className="w-3 h-3" /> Afternoon Board Clean</p>
            <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              {totalAfternoon.length ? Math.round(afternoonBoardYes / totalAfternoon.length * 100) : "–"}%
            </p>
            <p className="text-xs text-muted-foreground">{afternoonBoardYes}/{totalAfternoon.length} checks</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">From</p>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-8 text-xs w-36" data-testid="input-from-date" />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">To</p>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-8 text-xs w-36" data-testid="input-to-date" />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">Check Type</p>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="h-8 text-xs w-36" data-testid="select-check-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="morning">Morning</SelectItem>
              <SelectItem value="afternoon">Afternoon</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()} data-testid="btn-refresh">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
        {rows.length > 0 && (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={exportCsv} data-testid="btn-export-csv">
            <Download className="w-3.5 h-3.5 mr-1" /> Export CSV
          </Button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center">No check-ins found for this period.</div>
      ) : (
        <div className="space-y-4">
          {dates.map(date => (
            <div key={date}>
              <p className="text-xs font-semibold text-muted-foreground mb-2 sticky top-0 bg-background py-1">
                {safeFormatDate(date)}
              </p>
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-xs" data-testid={`table-checkin-${date}`}>
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">LM</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Reviewer</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Type</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Check Calls</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Board Clean</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground">Checkout</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped[date].map(r => (
                      <tr key={r.id} className="border-t border-border hover:bg-muted/20 transition-colors" data-testid={`row-checkin-${r.id}`}>
                        <td className="px-3 py-2 font-medium">{r.lm_name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.reviewer_name}</td>
                        <td className="px-3 py-2 text-center">
                          {r.check_type === "morning"
                            ? <Badge variant="outline" className="text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800"><Sun className="w-3 h-3 mr-0.5" />AM</Badge>
                            : <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800"><Clock className="w-3 h-3 mr-0.5" />PM</Badge>
                          }
                        </td>
                        <td className="px-3 py-2 text-center"><div className="flex justify-center"><BoolCell value={r.check_calls_done} /></div></td>
                        <td className="px-3 py-2 text-center"><div className="flex justify-center"><BoolCell value={r.board_clean} /></div></td>
                        <td className="px-3 py-2 text-center"><div className="flex justify-center"><BoolCell value={r.checkout_done} /></div></td>
                        <td className="px-3 py-2 text-muted-foreground max-w-[200px] truncate" title={r.notes ?? ""}>{r.notes || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
