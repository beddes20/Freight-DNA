// Task #639 — Today queue landing page.
//
// Single prioritized work list collapsing four upstream surfaces (LWQ
// touchpoints, Available Freight opps, hot reply threads, SLA-breaching
// customer quotes). The composite ranker lives on the server; this page
// just renders the page and provides the per-item primary action and the
// "Done for now" snooze affordance.
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Truck, Mail, Inbox, FileText, ChevronRight, Clock, Sparkles, Settings2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { TodayQueueSource } from "@shared/schema";

// Server payload — kept inline (single-file page, no shared types module
// dance needed) so the response shape is obvious to anyone reading.
interface TodayQueueItem {
  id: string;
  source: TodayQueueSource;
  sourceId: string;
  summary: string;
  urgencyScore: number;
  urgencyLevel: "critical" | "high" | "medium" | "low";
  priorityScore: number;
  reason: string;
  primaryActionLabel: string;
  primaryAction: string;
  deepLink: string;
  customerName: string | null;
  ageMinutes: number | null;
}
interface TodayQueueResponse {
  items: TodayQueueItem[];
  nextCursor: string | null;
  totalBeforePagination: number;
  generatedAt: string;
  bySource: Record<TodayQueueSource, number>;
}

const SOURCE_META: Record<TodayQueueSource, { label: string; icon: React.ComponentType<{ className?: string }>; chip: string }> = {
  lwq:         { label: "LWQ",        icon: Truck,    chip: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300" },
  freight_opp: { label: "Freight",    icon: Inbox,    chip: "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300" },
  hot_reply:   { label: "Reply",      icon: Mail,     chip: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" },
  quote_sla:   { label: "Quote SLA",  icon: FileText, chip: "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300" },
};

const URGENCY_META: Record<TodayQueueItem["urgencyLevel"], { label: string; chip: string }> = {
  critical: { label: "Critical", chip: "bg-red-600 text-white" },
  high:     { label: "High",     chip: "bg-orange-500 text-white" },
  medium:   { label: "Medium",   chip: "bg-yellow-400 text-yellow-950" },
  low:      { label: "Low",      chip: "bg-slate-300 text-slate-800 dark:bg-slate-700 dark:text-slate-100" },
};

function fmtAge(ageMin: number | null): string {
  if (ageMin === null) return "—";
  if (ageMin < 60) return `${ageMin}m`;
  if (ageMin < 60 * 24) return `${Math.round(ageMin / 60)}h`;
  return `${Math.round(ageMin / (60 * 24))}d`;
}

export default function TodayQueuePage(): JSX.Element {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<TodayQueueResponse>({
    queryKey: ["/api/today-queue"],
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4 sm:gap-6 p-3 sm:p-6" data-testid="page-today-queue">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="text-today-title">
            <Sparkles className="h-6 w-6 text-amber-500" />
            Today
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-today-subtitle">
            Your prioritized work — replies first, then by customer tier × urgency × freshness.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="text-source-counts">
              {(Object.keys(SOURCE_META) as TodayQueueSource[]).map(src => (
                <span key={src} className="flex items-center gap-1" data-testid={`count-${src}`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${SOURCE_META[src].chip.split(" ")[0]}`} />
                  {SOURCE_META[src].label} {data.bySource[src] ?? 0}
                </span>
              ))}
            </div>
          )}
          <LandingPreferenceToggle />
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span data-testid="text-today-count">
              {data ? `${data.totalBeforePagination} item${data.totalBeforePagination === 1 ? "" : "s"}` : "Loading…"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/today-queue"] })}
              data-testid="button-refresh-today"
            >
              Refresh
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading && (
            <div className="p-6 space-y-3" data-testid="state-today-loading">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          )}

          {!isLoading && items.length === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground" data-testid="state-today-empty">
              You're caught up. New work will appear here as it comes in.
            </div>
          )}

          {!isLoading && items.length > 0 && (
            <ul className="divide-y" data-testid="list-today-items">
              {items.map(item => (
                <TodayRow
                  key={item.id}
                  item={item}
                  onSnoozed={() => queryClient.invalidateQueries({ queryKey: ["/api/today-queue"] })}
                  onActivate={() => navigate(item.deepLink)}
                  onError={(msg) => toast({ title: "Action failed", description: msg, variant: "destructive" })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


function TodayRow(props: {
  item: TodayQueueItem;
  onSnoozed: () => void;
  onActivate: () => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const { item, onSnoozed, onActivate, onError } = props;
  const SrcIcon = SOURCE_META[item.source].icon;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [hours, setHours] = useState<string>("4");
  const [reason, setReason] = useState<string>("");

  const snooze = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/today-queue/snooze", {
        source: item.source,
        sourceId: item.sourceId,
        hours: Number.parseInt(hours, 10),
        reason: reason.trim() || null,
      });
    },
    onSuccess: () => {
      setSnoozeOpen(false);
      setReason("");
      onSnoozed();
    },
    onError: (err: Error) => onError(err.message),
  });

  return (
    <li className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40" data-testid={`row-today-${item.id}`}>
      <Badge variant="secondary" className={`shrink-0 ${SOURCE_META[item.source].chip}`} data-testid={`badge-source-${item.id}`}>
        <SrcIcon className="h-3 w-3 mr-1" />
        {SOURCE_META[item.source].label}
      </Badge>
      <Badge className={`shrink-0 ${URGENCY_META[item.urgencyLevel].chip}`} data-testid={`badge-urgency-${item.id}`}>
        {URGENCY_META[item.urgencyLevel].label} · {item.urgencyScore}
      </Badge>

      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={onActivate}
          className="text-sm font-medium text-left truncate w-full hover:underline"
          data-testid={`text-summary-${item.id}`}
        >
          {item.summary}
        </button>
        <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-reason-${item.id}`}>
          {item.reason} · <Clock className="h-3 w-3 inline-block -mt-0.5" /> {fmtAge(item.ageMinutes)}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" onClick={onActivate} data-testid={`button-action-${item.id}`}>
          {item.primaryActionLabel}
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>

        <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" data-testid={`button-snooze-${item.id}`}>
              Done for now
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72" align="end">
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Snooze this item</p>
                <p className="text-xs text-muted-foreground">It will resurface after the time you choose.</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">For how long?</label>
                <Select value={hours} onValueChange={setHours}>
                  <SelectTrigger data-testid={`select-snooze-hours-${item.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">2 hours</SelectItem>
                    <SelectItem value="4">4 hours</SelectItem>
                    <SelectItem value="8">8 hours (rest of day)</SelectItem>
                    <SelectItem value="24">24 hours</SelectItem>
                    <SelectItem value="72">3 days</SelectItem>
                    <SelectItem value="168">1 week</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Why? (optional)</label>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Waiting on customer reply, etc."
                  className="min-h-[60px] text-sm"
                  data-testid={`input-snooze-reason-${item.id}`}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setSnoozeOpen(false)} data-testid={`button-snooze-cancel-${item.id}`}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => snooze.mutate()} disabled={snooze.isPending} data-testid={`button-snooze-confirm-${item.id}`}>
                  {snooze.isPending ? "Snoozing…" : "Snooze"}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </li>
  );
}


// Small inline toggle so reps can opt back to the classic dashboard from
// inside the Today page itself. Mirrors the banner on the dashboard.
function LandingPreferenceToggle(): JSX.Element {
  const { toast } = useToast();
  const { data } = useQuery<{ defaultToTodayQueue: boolean }>({
    queryKey: ["/api/users/me/landing-preference"],
    staleTime: 60_000,
  });
  const [, navigate] = useLocation();
  const mut = useMutation({
    mutationFn: async (next: boolean) => {
      return apiRequest("PATCH", "/api/users/me/landing-preference", { defaultToTodayQueue: next });
    },
    onSuccess: (_d, next) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users/me/landing-preference"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: next ? "Today is now your home" : "Classic dashboard restored",
        description: next ? "We'll land you here on sign-in." : "We'll land you on the dashboard on sign-in.",
      });
      if (!next) navigate("/dashboard");
    },
  });

  const isCurrent = data?.defaultToTodayQueue ?? true;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Settings2 className="h-3.5 w-3.5" />
      <Link href="/dashboard" className="underline hover:text-foreground" data-testid="link-classic-dashboard">
        Classic dashboard
      </Link>
      <span>·</span>
      <button
        type="button"
        onClick={() => mut.mutate(!isCurrent)}
        disabled={mut.isPending}
        className="underline hover:text-foreground"
        data-testid="button-toggle-landing"
      >
        {isCurrent ? "Use classic as home" : "Use Today as home"}
      </button>
    </div>
  );
}
