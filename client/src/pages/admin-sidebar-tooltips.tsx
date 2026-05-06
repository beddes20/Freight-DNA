import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { SIDEBAR_TOOLTIP_DEFAULTS } from "@/lib/sidebar-tooltip-catalog";
import type { SidebarTooltip } from "@shared/schema";

const MAX_LEN = 500;

export default function AdminSidebarTooltipsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ items: SidebarTooltip[] }>({
    queryKey: ["/api/sidebar-tooltips"],
  });

  const overrides = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of data?.items ?? []) m[t.itemKey] = t.description;
    return m;
  }, [data]);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    setDrafts(prev => {
      const next: Record<string, string> = {};
      for (const item of SIDEBAR_TOOLTIP_DEFAULTS) {
        next[item.key] = prev[item.key] ?? overrides[item.key] ?? "";
      }
      return next;
    });
  }, [overrides]);

  const saveMutation = useMutation({
    mutationFn: async ({ itemKey, description }: { itemKey: string; description: string }) => {
      const res = await apiRequest("PUT", "/api/sidebar-tooltips", { itemKey, description });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sidebar-tooltips"] });
      toast({ title: variables.description.trim() ? "Tooltip updated" : "Tooltip reset to default" });
    },
    onError: () => toast({ title: "Failed to save tooltip", variant: "destructive" }),
  });

  const resetMutation = useMutation({
    mutationFn: async (itemKey: string) => {
      const res = await apiRequest("DELETE", `/api/sidebar-tooltips/${encodeURIComponent(itemKey)}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sidebar-tooltips"] });
      toast({ title: "Tooltip reset to default" });
    },
    onError: () => toast({ title: "Failed to reset tooltip", variant: "destructive" }),
  });

  if (user && user.role !== "admin") {
    return (
      <div className="container mx-auto p-4 max-w-screen-md">
        <Card>
          <CardHeader>
            <CardTitle>Admin access required</CardTitle>
            <CardDescription>You don't have permission to edit sidebar tooltips.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const groups = useMemo(() => {
    const g = new Map<string, typeof SIDEBAR_TOOLTIP_DEFAULTS>();
    for (const item of SIDEBAR_TOOLTIP_DEFAULTS) {
      const arr = g.get(item.group) ?? [];
      arr.push(item);
      g.set(item.group, arr);
    }
    return Array.from(g.entries());
  }, []);

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-screen-lg">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">Sidebar tooltip copy</h1>
        <p className="text-sm text-muted-foreground">
          Edit the short helper text shown when a user hovers a sidebar item. Leave a field empty
          (or click Reset) to fall back to the default copy. Changes apply to your organization
          and show up the next time the sidebar refreshes.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!isLoading && groups.map(([groupName, items]) => (
        <Card key={groupName}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{groupName}</CardTitle>
            <CardDescription>{items.length} item{items.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {items.map(item => {
              const draft = drafts[item.key] ?? "";
              const current = overrides[item.key] ?? "";
              const isOverridden = current.length > 0;
              const isDirty = draft.trim() !== current.trim();
              const effective = draft.trim().length > 0 ? draft : item.defaultDescription;
              return (
                <div key={item.key} className="border rounded-md p-3 space-y-2" data-testid={`row-tooltip-${item.key}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium" data-testid={`text-title-${item.key}`}>{item.title}</p>
                      <p className="text-xs text-muted-foreground">
                        Default: {item.defaultDescription}
                      </p>
                    </div>
                    {isOverridden && (
                      <span className="text-[10px] uppercase tracking-wide rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 px-1.5 py-0.5 shrink-0" data-testid={`badge-overridden-${item.key}`}>
                        Custom
                      </span>
                    )}
                  </div>
                  <Textarea
                    value={draft}
                    maxLength={MAX_LEN}
                    rows={2}
                    onChange={e => setDrafts(d => ({ ...d, [item.key]: e.target.value }))}
                    placeholder={item.defaultDescription}
                    data-testid={`input-tooltip-${item.key}`}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground">
                      Preview: <span className="italic">{effective}</span>
                      <span className="ml-2">({draft.length}/{MAX_LEN})</span>
                    </p>
                    <div className="flex gap-2">
                      {isOverridden && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={resetMutation.isPending}
                          onClick={() => {
                            setDrafts(d => ({ ...d, [item.key]: "" }));
                            resetMutation.mutate(item.key);
                          }}
                          data-testid={`button-reset-${item.key}`}
                        >
                          Reset
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={!isDirty || saveMutation.isPending}
                        onClick={() => saveMutation.mutate({ itemKey: item.key, description: draft })}
                        data-testid={`button-save-${item.key}`}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
