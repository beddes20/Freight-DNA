import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Shield, RotateCcw } from "lucide-react";

type Effect = "allow" | "deny" | "auto";
interface SimpleUser { id: string; name: string; role: string }
interface CapRow {
  capability: string;
  defaultEffect: Effect;
  effect: Effect;
  hasOverride: boolean;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

function groupOf(cap: string) {
  if (cap.startsWith("read.")) return "Reads";
  if (cap.startsWith("navigate.")) return "Navigation";
  if (cap === "write.sms.driver" || cap === "write.voice.driver" || cap === "write.email.external") return "External Outreach";
  return "Writes";
}

function effectColor(e: Effect) {
  if (e === "auto") return "text-emerald-600";
  if (e === "allow") return "text-blue-600";
  return "text-red-600";
}

export default function AdminAiPermissionsPage() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const { data: users, isLoading: usersLoading } = useQuery<SimpleUser[]>({ queryKey: ["/api/users"] });

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="h-7 w-7 text-amber-500" />
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">AI Permissions</h1>
          <p className="text-sm text-muted-foreground">Override the default capability matrix for any user. Defaults inherit from the user's role.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Select a user</CardTitle>
          <CardDescription>Pick anyone in the org to view and override their AI permissions.</CardDescription>
        </CardHeader>
        <CardContent>
          {usersLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
            <Select value={selectedUserId ?? undefined} onValueChange={setSelectedUserId}>
              <SelectTrigger className="w-full md:w-96" data-testid="select-user">
                <SelectValue placeholder="Choose a user..." />
              </SelectTrigger>
              <SelectContent>
                {(users ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((u) => (
                  <SelectItem key={u.id} value={u.id} data-testid={`option-user-${u.id}`}>
                    {u.name} <span className="text-muted-foreground">— {u.role}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {selectedUserId && <UserCapabilityGrid userId={selectedUserId} />}
    </div>
  );
}

function UserCapabilityGrid({ userId }: { userId: string }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ user: SimpleUser; rows: CapRow[] }>({
    queryKey: ["/api/agent/admin/users", userId, "capabilities"],
    queryFn: async () => {
      const res = await fetch(`/api/agent/admin/users/${userId}/capabilities`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const update = useMutation({
    mutationFn: async ({ capability, effect }: { capability: string; effect: Effect | null }) =>
      apiRequest("PUT", `/api/agent/admin/users/${userId}/capabilities`, { capability, effect }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/users", userId, "capabilities"] });
      toast({ title: "Updated" });
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  if (isLoading) return <Loader2 className="h-6 w-6 animate-spin" />;
  if (!data) return null;

  const grouped: Record<string, CapRow[]> = { Reads: [], Writes: [], "External Outreach": [], Navigation: [] };
  for (const r of data.rows) grouped[groupOf(r.capability)].push(r);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.user.name}</CardTitle>
        <CardDescription>Role: <Badge variant="outline">{data.user.role}</Badge></CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {Object.entries(grouped).map(([label, items]) => (
          items.length === 0 ? null : (
            <div key={label}>
              <h3 className="font-semibold text-sm mb-2 uppercase tracking-wide text-muted-foreground">{label}</h3>
              <div className="rounded-md border">
                <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground">
                  <div className="col-span-5">Capability</div>
                  <div className="col-span-2">Role default</div>
                  <div className="col-span-3">Override</div>
                  <div className="col-span-2 text-right">Actions</div>
                </div>
                {items.map((row) => (
                  <div key={row.capability}
                    className="grid grid-cols-12 gap-2 px-4 py-2 border-t items-center"
                    data-testid={`row-cap-${row.capability}`}>
                    <div className="col-span-5">
                      <div className="font-mono text-xs">{row.capability}</div>
                    </div>
                    <div className={`col-span-2 text-sm ${effectColor(row.defaultEffect)}`}>{row.defaultEffect}</div>
                    <div className="col-span-3">
                      <Select
                        value={row.hasOverride ? row.effect : "__inherit__"}
                        onValueChange={(v) => {
                          const effect = v === "__inherit__" ? null : (v as Effect);
                          update.mutate({ capability: row.capability, effect });
                        }}
                      >
                        <SelectTrigger data-testid={`select-effect-${row.capability}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__inherit__">Inherit role default</SelectItem>
                          <SelectItem value="allow">Allow (HITL)</SelectItem>
                          <SelectItem value="auto">Auto-approve</SelectItem>
                          <SelectItem value="deny">Deny</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2 text-right">
                      {row.hasOverride && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => update.mutate({ capability: row.capability, effect: null })}
                          data-testid={`button-clear-${row.capability}`}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Reset
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        ))}
      </CardContent>
    </Card>
  );
}
