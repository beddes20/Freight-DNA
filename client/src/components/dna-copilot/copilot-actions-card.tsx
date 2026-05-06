/**
 * Reusable audit-trail card showing recent confirmed DNA Copilot actions.
 * Used on the rep profile/report page (`scope="user"`) and on the
 * company activity feed (`scope="company"`). Server enforces org scope
 * and visibility — this component is pure presentation + fetch.
 */
import { useQuery } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ActionRow {
  id: string;
  tool: string;
  result: "success" | "failure" | "dismissed";
  errorMessage?: string | null;
  completedAt: string;
  userName?: string;
  relatedCompanyId?: string | null;
}

const RESULT_STYLE: Record<ActionRow["result"], string> = {
  success:   "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/40",
  failure:   "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border-rose-200 dark:border-rose-900/40",
  dismissed: "bg-muted text-muted-foreground border-border",
};

function prettyTool(tool: string) {
  return tool.replace(/_/g, " ");
}

export function CopilotActionsCard({
  scope,
  id,
  limit = 10,
}: {
  scope: "user" | "company";
  id: string;
  limit?: number;
}) {
  const url = scope === "user"
    ? `/api/agent/analytics/actions/by-user/${id}`
    : `/api/agent/analytics/actions/by-company/${id}`;

  const { data, isLoading } = useQuery<ActionRow[]>({
    queryKey: ["/api/agent/analytics/actions", scope, id, limit],
    queryFn: () => fetch(`${url}?limit=${limit}`, { credentials: "include" }).then((r) => {
      if (!r.ok) return [];
      return r.json();
    }),
  });

  return (
    <section className="rounded-xl border bg-card" data-testid={`copilot-actions-${scope}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
        <Bot className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Recent DNA Copilot actions</h2>
        <span className="text-xs text-muted-foreground ml-auto">last {limit}</span>
      </div>
      {isLoading ? (
        <div className="p-6 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : !data || data.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          No copilot actions in the audit trail yet.
        </div>
      ) : (
        <ul className="divide-y divide-border/50">
          {data.map((row) => (
            <li
              key={row.id}
              className="px-4 py-2.5 flex items-start gap-3"
              data-testid={`copilot-action-${row.id}`}
            >
              <span
                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0 ${RESULT_STYLE[row.result]}`}
              >
                {row.result}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{prettyTool(row.tool)}</p>
                <p className="text-xs text-muted-foreground">
                  {row.userName ? `${row.userName} · ` : ""}
                  {(() => {
                    try { return formatDistanceToNow(new Date(row.completedAt), { addSuffix: true }); }
                    catch { return ""; }
                  })()}
                </p>
                {row.errorMessage && (
                  <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-300 line-clamp-2">
                    {row.errorMessage}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
