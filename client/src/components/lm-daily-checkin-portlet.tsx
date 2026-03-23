import { useMutation, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Phone, LogOut, CheckCircle2, XCircle, Clock } from "lucide-react";

type LmDailyCheck = {
  id: string;
  organizationId: string;
  lmUserId: string;
  checkedByUserId: string;
  checkedByName?: string | null;
  date: string;
  callsBeforeSevenThirty: boolean | null;
  checkoutCompleted: boolean | null;
};

type Props = {
  lmUserId: string;
  canEdit: boolean;
};

function formatDate(dateStr: string) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function StatusBadge({ value }: { value: boolean | null }) {
  if (value === null || value === undefined) {
    return (
      <Badge variant="secondary" className="gap-1 text-xs">
        <Clock className="h-3 w-3" />
        Pending
      </Badge>
    );
  }
  if (value) {
    return (
      <Badge variant="default" className="gap-1 text-xs bg-green-600 hover:bg-green-700">
        <CheckCircle2 className="h-3 w-3" />
        Yes
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1 text-xs">
      <XCircle className="h-3 w-3" />
      No
    </Badge>
  );
}

function CheckInPortlet({
  title,
  icon: Icon,
  field,
  lmUserId,
  canEdit,
  todayEntry,
  log,
  isPending,
  onUpdate,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  field: "callsBeforeSevenThirty" | "checkoutCompleted";
  lmUserId: string;
  canEdit: boolean;
  todayEntry: LmDailyCheck | null;
  log: LmDailyCheck[];
  isPending: boolean;
  onUpdate: (value: boolean) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const todayValue = todayEntry ? todayEntry[field] : null;

  const pastEntries = log.filter(e => e.date !== today).slice(0, 30);

  return (
    <Card data-testid={`card-lm-checkin-${field}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-blue-500" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Today</span>
            <StatusBadge value={todayValue} />
          </div>
          {canEdit && (
            <div className="flex gap-1.5 shrink-0">
              <Button
                size="sm"
                variant={todayValue === true ? "default" : "outline"}
                className={`h-7 px-2.5 text-xs gap-1 ${todayValue === true ? "bg-green-600 hover:bg-green-700 text-white" : "hover:bg-green-50 hover:border-green-400 hover:text-green-700 dark:hover:bg-green-950/30 dark:hover:border-green-700 dark:hover:text-green-400"}`}
                onClick={() => onUpdate(true)}
                disabled={isPending}
                data-testid={`button-checkin-yes-${field}`}
              >
                <CheckCircle2 className="h-3 w-3" />
                Yes
              </Button>
              <Button
                size="sm"
                variant={todayValue === false ? "destructive" : "outline"}
                className={`h-7 px-2.5 text-xs gap-1 ${todayValue === false ? "" : "hover:bg-red-50 hover:border-red-400 hover:text-red-700 dark:hover:bg-red-950/30 dark:hover:border-red-700 dark:hover:text-red-400"}`}
                onClick={() => onUpdate(false)}
                disabled={isPending}
                data-testid={`button-checkin-no-${field}`}
              >
                <XCircle className="h-3 w-3" />
                No
              </Button>
            </div>
          )}
        </div>

        {pastEntries.length > 0 && (
          <div className="max-h-40 overflow-y-auto space-y-1 pr-1" data-testid={`list-checkin-log-${field}`}>
            {pastEntries.map(entry => (
              <div
                key={entry.id}
                className="flex items-center justify-between py-1 px-2 rounded text-xs hover:bg-muted/40"
                data-testid={`row-checkin-${field}-${entry.date}`}
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-muted-foreground">{formatDate(entry.date)}</span>
                  {entry.checkedByName && (
                    <span className="text-[10px] text-muted-foreground/70 truncate">by {entry.checkedByName}</span>
                  )}
                </div>
                <StatusBadge value={entry[field]} />
              </div>
            ))}
          </div>
        )}

        {pastEntries.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">No past entries yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function LmDailyCheckInPortlets({ lmUserId, canEdit }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();

  const { data: checks = [], isLoading } = useQuery<LmDailyCheck[]>({
    queryKey: ["/api/lm-daily-checks", lmUserId],
    queryFn: async () => {
      const res = await fetch(`/api/lm-daily-checks/${lmUserId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!lmUserId,
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { callsBeforeSevenThirty?: boolean | null; checkoutCompleted?: boolean | null }) => {
      const res = await apiRequest("POST", `/api/lm-daily-checks/${lmUserId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lm-daily-checks", lmUserId] });
    },
    onError: () => {
      toast({ title: "Failed to save check-in", variant: "destructive" });
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const todayEntry = checks.find(c => c.date === today) ?? null;

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="lm-daily-checkin-portlets">
      <CheckInPortlet
        title="Check calls Done Before 07:30"
        icon={Phone}
        field="callsBeforeSevenThirty"
        lmUserId={lmUserId}
        canEdit={canEdit}
        todayEntry={todayEntry}
        log={checks}
        isPending={updateMutation.isPending}
        onUpdate={(value) => updateMutation.mutate({ callsBeforeSevenThirty: value })}
      />
      <CheckInPortlet
        title="Check-Out Process Completed"
        icon={LogOut}
        field="checkoutCompleted"
        lmUserId={lmUserId}
        canEdit={canEdit}
        todayEntry={todayEntry}
        log={checks}
        isPending={updateMutation.isPending}
        onUpdate={(value) => updateMutation.mutate({ checkoutCompleted: value })}
      />
    </div>
  );
}
