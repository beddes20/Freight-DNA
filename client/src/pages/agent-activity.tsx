import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Activity, ArrowDownLeft, ArrowUpRight, Wrench, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

type Scope = "me" | "team" | "org";

interface ActivityRow {
  id: string;
  userId: string;
  userName: string;
  channel: string;
  direction: string;
  tool: string | null;
  capability: string | null;
  summary: string | null;
  model: string | null;
  latencyMs: number | null;
  outcome: string;
  errorMessage: string | null;
  relatedCompanyId: string | null;
  createdAt: string;
}

function directionIcon(d: string) {
  if (d === "inbound") return <ArrowDownLeft className="h-4 w-4 text-blue-500" />;
  if (d === "outbound") return <ArrowUpRight className="h-4 w-4 text-emerald-500" />;
  if (d === "tool") return <Wrench className="h-4 w-4 text-amber-500" />;
  return <Activity className="h-4 w-4 text-muted-foreground" />;
}

function outcomeBadge(o: string) {
  if (o === "ok") return <Badge variant="outline" className="text-emerald-600 border-emerald-200"><CheckCircle2 className="h-3 w-3 mr-1" />OK</Badge>;
  if (o === "denied") return <Badge variant="outline" className="text-amber-700 border-amber-200"><AlertTriangle className="h-3 w-3 mr-1" />Denied</Badge>;
  if (o === "error") return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Error</Badge>;
  return <Badge variant="outline">{o}</Badge>;
}

export default function AgentActivityPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>("me");

  const isManager = user?.role === "admin" || user?.role === "director" ||
    user?.role === "sales_director" || user?.role === "national_account_manager";
  const isAdmin = user?.role === "admin";

  const { data, isLoading } = useQuery<ActivityRow[]>({
    queryKey: ["/api/agent/activity", { scope }],
    queryFn: async () => {
      const res = await fetch(`/api/agent/activity?scope=${scope}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div className="flex items-center gap-3">
        <Activity className="h-7 w-7 text-amber-500" />
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">Agent Activity</h1>
          <p className="text-sm text-muted-foreground">Every message DNA received, every tool it ran, and every action it took.</p>
        </div>
      </div>

      <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
        <TabsList>
          <TabsTrigger value="me" data-testid="tab-scope-me">My Activity</TabsTrigger>
          {isManager && <TabsTrigger value="team" data-testid="tab-scope-team">My Team</TabsTrigger>}
          {isAdmin && <TabsTrigger value="org" data-testid="tab-scope-org">Whole Org</TabsTrigger>}
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>
            {scope === "me" ? "Your own DNA conversations and tool calls."
              : scope === "team" ? "Activity from you and the reps you manage."
              : "Every DNA action across the organization."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? <Loader2 className="h-6 w-6 animate-spin" /> : (
            (data ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground py-12 text-center" data-testid="text-empty-activity">
                No activity yet. Talk to DNA and it'll show up here.
              </div>
            ) : (
              <div className="rounded-md border divide-y">
                {(data ?? []).map((row) => (
                  <div key={row.id} className="px-4 py-3 hover:bg-muted/30" data-testid={`row-activity-${row.id}`}>
                    <div className="flex items-start gap-3">
                      <div className="mt-1 shrink-0">{directionIcon(row.direction)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap text-sm">
                          {scope !== "me" && <span className="font-medium">{row.userName}</span>}
                          <Badge variant="outline" className="text-xs">{row.channel}</Badge>
                          {row.tool && <Badge variant="secondary" className="text-xs font-mono">{row.tool}</Badge>}
                          {outcomeBadge(row.outcome)}
                          {row.model && <span className="text-xs text-muted-foreground">{row.model}</span>}
                          {row.latencyMs !== null && <span className="text-xs text-muted-foreground">{row.latencyMs}ms</span>}
                        </div>
                        {row.summary && (
                          <div className="text-sm mt-1 text-foreground/90 whitespace-pre-wrap break-words">
                            {row.summary}
                          </div>
                        )}
                        {row.errorMessage && (
                          <div className="text-xs text-red-600 mt-1">{row.errorMessage}</div>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0 text-right" title={format(new Date(row.createdAt), "PPpp")}>
                        {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
