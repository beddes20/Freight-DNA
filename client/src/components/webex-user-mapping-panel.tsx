import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Ban,
  Video,
  Search,
  History,
} from "lucide-react";

interface WebexMapping {
  id: string;
  orgId: string;
  webexPersonId: string | null;
  webexEmail: string | null;
  webexDisplayName: string | null;
  userId: string | null;
  status: string;
  matchSource: string | null;
  notes: string | null;
}

interface OrgUserLite {
  id: string;
  name: string;
  username: string;
  role: string;
}

interface MappingsResponse {
  mappings: WebexMapping[];
  users: OrgUserLite[];
}

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  confirmed: { label: "Confirmed", tone: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  auto_matched: { label: "Auto-matched", tone: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  needs_review: { label: "Needs review", tone: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
  ignored: { label: "Ignored", tone: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
};

export function WebexUserMappingPanel() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<"all" | "needs_review" | "auto_matched" | "confirmed" | "ignored">("all");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<MappingsResponse>({
    queryKey: ["/api/webex/user-mappings"],
  });

  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/webex/user-mappings/seed");
      return res.json();
    },
    onSuccess: (result: any) => {
      toast({
        title: "Auto-match complete",
        description: `Processed ${result.candidatesProcessed} Webex users — ${result.matched} matched, ${result.needsReview} need review (source: ${result.source}).`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/webex/user-mappings"] });
    },
    onError: (err: any) =>
      toast({ title: "Auto-match failed", description: err.message, variant: "destructive" }),
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/webex/backfill-attribution", { daysBack: 90 });
      return res.json();
    },
    onSuccess: (result: any) => {
      const tp = result?.touchpoints ?? {};
      const cards = result?.nbaCards ?? {};
      const tasks = result?.tasks ?? {};
      toast({
        title: "Backfill complete",
        description:
          `Touchpoints: ${tp.reassigned ?? 0} reassigned / ${tp.scanned ?? 0} scanned. ` +
          `Missed-call cards: ${cards.reassigned ?? 0}/${cards.scanned ?? 0}. ` +
          `Follow-up tasks: ${tasks.reassigned ?? 0}/${tasks.scanned ?? 0}.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/webex/user-mappings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/touchpoints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/nba-cards"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
    onError: (err: any) =>
      toast({ title: "Backfill failed", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; userId?: string | null; status?: string }) => {
      const res = await apiRequest("PATCH", `/api/webex/user-mappings/${id}`, patch);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/webex/user-mappings"] });
    },
    onError: (err: any) =>
      toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const counts = useMemo(() => {
    const mappings = data?.mappings ?? [];
    return {
      all: mappings.length,
      needs_review: mappings.filter(m => m.status === "needs_review").length,
      auto_matched: mappings.filter(m => m.status === "auto_matched").length,
      confirmed: mappings.filter(m => m.status === "confirmed").length,
      ignored: mappings.filter(m => m.status === "ignored").length,
    };
  }, [data?.mappings]);

  const filtered = useMemo(() => {
    const mappings = data?.mappings ?? [];
    const q = search.trim().toLowerCase();
    return mappings.filter(m => {
      if (filter !== "all" && m.status !== filter) return false;
      if (!q) return true;
      return (
        (m.webexDisplayName || "").toLowerCase().includes(q) ||
        (m.webexEmail || "").toLowerCase().includes(q)
      );
    });
  }, [data?.mappings, filter, search]);

  const userById = useMemo(() => {
    const map = new Map<string, OrgUserLite>();
    for (const u of data?.users ?? []) map.set(u.id, u);
    return map;
  }, [data?.users]);

  return (
    <Card data-testid="card-webex-user-mappings">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-amber-600" />
            <h2 className="font-semibold text-sm">Webex → User Mapping</h2>
            <span className="text-xs text-muted-foreground">
              Routes synced calls, follow-ups, and missed-call cards to the right rep.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => backfillMutation.mutate()}
              disabled={backfillMutation.isPending}
              data-testid="button-webex-backfill-attribution"
              className="gap-1.5"
              title="Re-attribute past Webex calls, missed-call cards, and follow-up tasks using the current mappings."
            >
              {backfillMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <History className="w-3.5 h-3.5" />
              )}
              Re-attribute past calls
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
              data-testid="button-webex-mapping-seed"
              className="gap-1.5"
            >
              {seedMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Re-run auto-match
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {(["all", "needs_review", "auto_matched", "confirmed", "ignored"] as const).map(key => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? "default" : "outline"}
              onClick={() => setFilter(key)}
              data-testid={`button-filter-${key}`}
              className="h-7 text-xs"
            >
              {key === "all" ? "All" : STATUS_LABEL[key]?.label || key} ({counts[key]})
            </Button>
          ))}
          <div className="relative ml-auto">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search Webex name / email"
              className="h-7 w-56 pl-7 text-xs"
              data-testid="input-mapping-search"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading mappings…
          </div>
        ) : !data || data.mappings.length === 0 ? (
          <div className="text-center py-8 space-y-3" data-testid="empty-mappings">
            <p className="text-sm text-muted-foreground">
              No Webex user mappings yet. Click <strong>Re-run auto-match</strong> to seed them.
            </p>
            <p className="text-xs text-muted-foreground">
              Existing call activity that was attributed to the default user will not be retroactively re-assigned.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left p-2.5">Webex User</th>
                  <th className="text-left p-2.5">Mapped to</th>
                  <th className="text-left p-2.5">Status</th>
                  <th className="text-right p-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(m => {
                  const status = STATUS_LABEL[m.status] || { label: m.status, tone: "bg-gray-100 text-gray-800" };
                  const mappedUser = m.userId ? userById.get(m.userId) : null;
                  return (
                    <tr key={m.id} className="border-t" data-testid={`row-mapping-${m.id}`}>
                      <td className="p-2.5">
                        <div className="font-medium" data-testid={`text-webex-name-${m.id}`}>{m.webexDisplayName || "(no name)"}</div>
                        <div className="text-xs text-muted-foreground" data-testid={`text-webex-email-${m.id}`}>{m.webexEmail || "(no email)"}</div>
                      </td>
                      <td className="p-2.5">
                        <Select
                          value={m.userId || "none"}
                          onValueChange={val =>
                            updateMutation.mutate({
                              id: m.id,
                              userId: val === "none" ? null : val,
                              status: val === "none" ? "needs_review" : "confirmed",
                            })
                          }
                          disabled={m.status === "ignored"}
                        >
                          <SelectTrigger
                            className="h-8 text-xs w-56"
                            data-testid={`select-user-${m.id}`}
                          >
                            <SelectValue placeholder="Pick app user" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">— Unassigned —</SelectItem>
                            {(data.users || [])
                              .slice()
                              .sort((a, b) => a.name.localeCompare(b.name))
                              .map(u => (
                                <SelectItem key={u.id} value={u.id}>
                                  {u.name} <span className="text-muted-foreground">({u.username})</span>
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        {mappedUser && (
                          <div className="text-[11px] text-muted-foreground mt-1">
                            {mappedUser.role.replace(/_/g, " ")}
                          </div>
                        )}
                      </td>
                      <td className="p-2.5">
                        <Badge className={`${status.tone} pointer-events-none`} data-testid={`badge-status-${m.id}`}>
                          {m.status === "confirmed" && <CheckCircle2 className="w-3 h-3 mr-1" />}
                          {m.status === "needs_review" && <AlertTriangle className="w-3 h-3 mr-1" />}
                          {m.status === "ignored" && <Ban className="w-3 h-3 mr-1" />}
                          {status.label}
                        </Badge>
                        {m.matchSource && (
                          <div className="text-[10px] text-muted-foreground mt-1">{m.matchSource}</div>
                        )}
                      </td>
                      <td className="p-2.5 text-right space-x-1">
                        {m.status !== "ignored" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() =>
                              updateMutation.mutate({ id: m.id, status: "ignored", userId: null })
                            }
                            data-testid={`button-ignore-${m.id}`}
                          >
                            Ignore
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() =>
                              updateMutation.mutate({ id: m.id, status: "needs_review" })
                            }
                            data-testid={`button-unignore-${m.id}`}
                          >
                            Un-ignore
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-xs text-muted-foreground py-6">
                      No mappings match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          New calls, follow-ups, and missed-call cards route through these mappings automatically. Use
          <strong> Re-attribute past calls</strong> to retro-credit previously synced Webex activity once
          mappings are confirmed. Mappings in <em>Ignored</em> status are skipped.
        </p>
      </CardContent>
    </Card>
  );
}
