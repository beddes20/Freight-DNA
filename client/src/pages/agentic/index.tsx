import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bot, ArrowRight, ShieldAlert, AlertTriangle } from "lucide-react";
import type { WorkflowAgent } from "@shared/schema";

const AUTONOMY_COLOR: Record<string, string> = {
  off: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  suggest: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200",
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  auto_hitl: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  auto: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
};

export default function AgenticIndexPage() {
  const { data, isLoading } = useQuery<{ agents: WorkflowAgent[]; stats: { byAgent: Record<string, Record<string, number>> } }>({
    queryKey: ["/api/agentic/agents"],
  });

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-agents">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Bot className="h-6 w-6" /> Agentic Brokerage Program
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Six workflow agents own outcomes end-to-end. Every action is staged through HITL until you flip
            an agent into Auto. All adapters default to dry-run.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/approvals"><Button variant="outline" data-testid="link-approvals">Approvals Inbox</Button></Link>
          <Link href="/pods"><Button variant="outline" data-testid="link-pods">Pods</Button></Link>
        </div>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Loading agent fleet…</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {(data?.agents ?? []).map((a) => {
          const s = data?.stats?.byAgent?.[a.id] ?? {};
          const pending = s.pending ?? 0;
          return (
            <Card key={a.id} data-testid={`card-agent-${a.slug}`} className="hover-elevate">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      {a.name}
                      {a.killSwitch && <ShieldAlert className="h-4 w-4 text-red-500" />}
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">Loop: {a.loop}</div>
                  </div>
                  <Badge className={AUTONOMY_COLOR[a.autonomy] ?? ""} data-testid={`badge-autonomy-${a.slug}`}>
                    {a.autonomy}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground line-clamp-3">{a.description}</p>
                <div className="flex items-center gap-3 text-xs">
                  <span className={a.enabled ? "text-emerald-600" : "text-muted-foreground"}>
                    {a.enabled ? "Enabled" : "Disabled"}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="flex items-center gap-1" data-testid={`text-pending-${a.slug}`}>
                    {pending > 0 && <AlertTriangle className="h-3 w-3 text-amber-500" />}
                    {pending} pending
                  </span>
                  {a.targetMetric && (<><span className="text-muted-foreground">·</span><span className="text-muted-foreground">target: {a.targetMetric}</span></>)}
                </div>
                <Link href={`/agents/${a.slug}`}>
                  <Button variant="ghost" size="sm" className="w-full justify-between" data-testid={`link-agent-${a.slug}`}>
                    Open cockpit <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
