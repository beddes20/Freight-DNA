import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2, Trash2, Plus, Pin, Sparkles, Activity, Shield, Users, Settings as SettingsIcon,
  ArrowDownLeft, ArrowUpRight, Wrench, AlertTriangle, CheckCircle2, XCircle, RotateCcw, Brain,
  BookOpen, ChevronDown, ChevronRight, History, Save,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { format, formatDistanceToNow } from "date-fns";

type Effect = "allow" | "deny" | "auto";

// ─── Shared types ──────────────────────────────────────────────────────────
interface CapRow { capability: string; defaultEffect: Effect; effect: Effect; hasOverride: boolean; note?: string | null }
interface Fact { id: string; fact: string; pinned: boolean; source: string; createdAt: string }
interface Memory { id: string; kind: string; content: string; importance: number; relatedCompanyId: string | null; createdAt: string }
interface ModuleAccessUser { id: string; name: string; email: string; role: string; defaultEffect: Effect; effect: Effect; enabled: boolean; hasOverride: boolean; updatedAt: string | null }
interface OrgSettings { id: string; moduleEnabled: boolean; defaultAccessForNewUsers: string; defaultModel: string; autoApprovePersonalMemory: boolean; allowExternalOutreach: boolean; notes: string | null; updatedAt: string }
interface SimpleUser { id: string; name: string; role: string }
interface ActivityRow {
  id: string; userId: string; userName: string; channel: string; direction: string;
  tool: string | null; capability: string | null; summary: string | null;
  model: string | null; latencyMs: number | null; outcome: string;
  errorMessage: string | null; relatedCompanyId: string | null; createdAt: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function effectBadge(e: Effect) {
  if (e === "auto") return <Badge className="bg-emerald-600 hover:bg-emerald-700" data-testid={`badge-effect-${e}`}>Auto-approved</Badge>;
  if (e === "allow") return <Badge variant="secondary" data-testid={`badge-effect-${e}`}>Allowed (asks first)</Badge>;
  return <Badge variant="destructive" data-testid={`badge-effect-${e}`}>Denied</Badge>;
}
function prettyCap(cap: string) {
  return cap.replace(/^read\./, "View ").replace(/^write\./, "Modify ")
    .replace(/^navigate\./, "Navigate ").replace(/^module\./, "Module ").replace(/\./g, " ");
}
function groupOf(cap: string) {
  if (cap === "module.access") return "Module";
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

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PORTAL PAGE
// ═══════════════════════════════════════════════════════════════════════════
export default function AiAgentPortal() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const isAdmin = user?.role === "admin";

  // Tab state from URL hash so deep links work.
  const initialTab = typeof window !== "undefined" && window.location.hash
    ? window.location.hash.slice(1) : "my-assistant";
  const [tab, setTab] = useState(initialTab);

  const handleTabChange = (v: string) => {
    setTab(v);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `#${v}`);
  };

  // Module access check banner
  const { data: access } = useQuery<{ allowed: boolean; reason?: string }>({
    queryKey: ["/api/agent/me/module-access"],
  });

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <div className="flex items-center gap-3">
        <Sparkles className="h-7 w-7 text-amber-500" />
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">AI Agent</h1>
          <p className="text-sm text-muted-foreground">
            Configure DNA Logistics Bot — your single AI teammate for the freight desk.
          </p>
        </div>
      </div>

      {access && !access.allowed && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="pt-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
            <div className="text-sm">
              <span className="font-medium">DNA is not enabled for you.</span> {access.reason}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="my-assistant" data-testid="tab-my-assistant">
            <SettingsIcon className="h-4 w-4 mr-2" />My Assistant
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">
            <Activity className="h-4 w-4 mr-2" />Activity
          </TabsTrigger>
          {isAdmin && <TabsTrigger value="module-access" data-testid="tab-module-access">
            <Users className="h-4 w-4 mr-2" />Module Access
          </TabsTrigger>}
          {isAdmin && <TabsTrigger value="permissions" data-testid="tab-permissions">
            <Shield className="h-4 w-4 mr-2" />Permissions
          </TabsTrigger>}
          {isAdmin && <TabsTrigger value="persona" data-testid="tab-persona">
            <BookOpen className="h-4 w-4 mr-2" />Persona & Playbook
          </TabsTrigger>}
          {isAdmin && <TabsTrigger value="org-defaults" data-testid="tab-org-defaults">
            <Sparkles className="h-4 w-4 mr-2" />Org Defaults
          </TabsTrigger>}
        </TabsList>

        <TabsContent value="my-assistant" className="mt-4 space-y-6">
          <MyAssistantPanel />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityPanel />
        </TabsContent>
        {isAdmin && <TabsContent value="module-access" className="mt-4">
          <ModuleAccessPanel />
        </TabsContent>}
        {isAdmin && <TabsContent value="permissions" className="mt-4">
          <PermissionsAdminPanel />
        </TabsContent>}
        {isAdmin && <TabsContent value="persona" className="mt-4">
          <PersonaPlaybookPanel />
        </TabsContent>}
        {isAdmin && <TabsContent value="org-defaults" className="mt-4">
          <OrgDefaultsPanel />
        </TabsContent>}
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL: My Assistant (everyone)
// ═══════════════════════════════════════════════════════════════════════════
function MyAssistantPanel() {
  return (
    <div className="space-y-6">
      <MyPermissionsCard />
      <MyFactsCard />
      <MyMemoriesCard />
    </div>
  );
}

function MyPermissionsCard() {
  const { data, isLoading } = useQuery<CapRow[]>({ queryKey: ["/api/agent/me/capabilities"] });
  if (isLoading) return <Loader2 className="h-6 w-6 animate-spin" />;
  const rows = data ?? [];
  const groups: Record<string, CapRow[]> = { Module: [], Reads: [], Writes: [], "External Outreach": [], Navigation: [] };
  for (const r of rows) groups[groupOf(r.capability)].push(r);

  return (
    <Card>
      <CardHeader>
        <CardTitle>What DNA can do for you</CardTitle>
        <CardDescription>Read-only view. Ask an admin to change anything here.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {Object.entries(groups).map(([label, items]) => items.length === 0 ? null : (
          <div key={label}>
            <h3 className="font-semibold text-sm mb-2 uppercase tracking-wide text-muted-foreground">{label}</h3>
            <div className="rounded-md border">
              {items.map((row, i) => (
                <div key={row.capability}
                  className={`flex items-center justify-between px-4 py-3 ${i > 0 ? "border-t" : ""}`}
                  data-testid={`row-cap-${row.capability}`}>
                  <div>
                    <div className="font-medium capitalize">{prettyCap(row.capability)}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.capability}
                      {row.hasOverride && <span className="ml-2 text-amber-600">• admin override</span>}
                    </div>
                  </div>
                  {effectBadge(row.effect)}
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function MyFactsCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Fact[]>({ queryKey: ["/api/agent/me/facts"] });
  const [draft, setDraft] = useState("");
  const [pinned, setPinned] = useState(true);
  const add = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/agent/me/facts", { fact: draft.trim(), pinned }),
    onSuccess: () => { setDraft(""); queryClient.invalidateQueries({ queryKey: ["/api/agent/me/facts"] }); toast({ title: "Saved" }); },
    onError: () => toast({ title: "Could not save", variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/agent/me/facts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/agent/me/facts"] }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Standing instructions</CardTitle>
        <CardDescription>Notes DNA will always remember about how you work. Pinned items are loaded into every conversation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 items-center">
          <Input placeholder="e.g. Always cc dispatch@acme on Acme threads"
            value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="input-new-fact" />
          <div className="flex items-center gap-2 shrink-0">
            <Switch checked={pinned} onCheckedChange={setPinned} data-testid="switch-pinned" />
            <span className="text-sm text-muted-foreground">Pin</span>
          </div>
          <Button disabled={!draft.trim() || add.isPending} onClick={() => add.mutate()} data-testid="button-add-fact">
            {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </Button>
        </div>
        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          (data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid="text-empty-facts">
              No standing instructions yet.
            </div>
          ) : (
            <div className="rounded-md border">
              {(data ?? []).map((f, i) => (
                <div key={f.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i > 0 ? "border-t" : ""}`} data-testid={`row-fact-${f.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {f.pinned && <Pin className="h-3 w-3 text-amber-500" />}
                      <span className="font-medium">{f.fact}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Added {format(new Date(f.createdAt), "MMM d, yyyy")} · source: {f.source}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(f.id)} data-testid={`button-delete-fact-${f.id}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

function MyMemoriesCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Memory[]>({ queryKey: ["/api/agent/me/memories"] });
  const del = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/agent/me/memories/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/agent/me/memories"] }); toast({ title: "Memory removed" }); },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle><Brain className="h-4 w-4 inline mr-2" />What DNA remembers about you</CardTitle>
        <CardDescription>Episodic memories DNA captured from prior conversations.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          (data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid="text-empty-memories">No memories saved yet.</div>
          ) : (
            <div className="rounded-md border">
              {(data ?? []).map((m, i) => (
                <div key={m.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i > 0 ? "border-t" : ""}`} data-testid={`row-memory-${m.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-xs">{m.kind}</Badge>
                      <span className="text-xs text-muted-foreground">{format(new Date(m.createdAt), "MMM d, yyyy h:mma")}</span>
                    </div>
                    <div className="text-sm">{m.content}</div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(m.id)} data-testid={`button-delete-memory-${m.id}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL: Activity
// ═══════════════════════════════════════════════════════════════════════════
function ActivityPanel() {
  const { user } = useAuth();
  const isManager = user?.role === "admin" || user?.role === "director" ||
    user?.role === "sales_director" || user?.role === "national_account_manager";
  const isAdmin = user?.role === "admin";
  const [scope, setScope] = useState<"me" | "team" | "org">("me");
  const { data, isLoading } = useQuery<ActivityRow[]>({
    queryKey: ["/api/agent/activity", { scope }],
    queryFn: async () => {
      const res = await fetch(`/api/agent/activity?scope=${scope}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });
  const dirIcon = (d: string) => d === "inbound" ? <ArrowDownLeft className="h-4 w-4 text-blue-500" />
    : d === "outbound" ? <ArrowUpRight className="h-4 w-4 text-emerald-500" />
    : d === "tool" ? <Wrench className="h-4 w-4 text-amber-500" />
    : <Activity className="h-4 w-4 text-muted-foreground" />;
  const outBadge = (o: string) =>
    o === "ok" ? <Badge variant="outline" className="text-emerald-600 border-emerald-200"><CheckCircle2 className="h-3 w-3 mr-1" />OK</Badge>
    : o === "denied" ? <Badge variant="outline" className="text-amber-700 border-amber-200"><AlertTriangle className="h-3 w-3 mr-1" />Denied</Badge>
    : o === "error" ? <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Error</Badge>
    : <Badge variant="outline">{o}</Badge>;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>Activity timeline</CardTitle>
            <CardDescription>Every message DNA received, every tool it ran, and every action it took.</CardDescription>
          </div>
          <Tabs value={scope} onValueChange={(v) => setScope(v as any)}>
            <TabsList>
              <TabsTrigger value="me" data-testid="tab-scope-me">Mine</TabsTrigger>
              {isManager && <TabsTrigger value="team" data-testid="tab-scope-team">Team</TabsTrigger>}
              {isAdmin && <TabsTrigger value="org" data-testid="tab-scope-org">Whole Org</TabsTrigger>}
            </TabsList>
          </Tabs>
        </div>
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
                    <div className="mt-1 shrink-0">{dirIcon(row.direction)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        {scope !== "me" && <span className="font-medium">{row.userName}</span>}
                        <Badge variant="outline" className="text-xs">{row.channel}</Badge>
                        {row.tool && <Badge variant="secondary" className="text-xs font-mono">{row.tool}</Badge>}
                        {outBadge(row.outcome)}
                        {row.model && <span className="text-xs text-muted-foreground">{row.model}</span>}
                        {row.latencyMs !== null && <span className="text-xs text-muted-foreground">{row.latencyMs}ms</span>}
                      </div>
                      {row.summary && <div className="text-sm mt-1 whitespace-pre-wrap break-words">{row.summary}</div>}
                      {row.errorMessage && <div className="text-xs text-red-600 mt-1">{row.errorMessage}</div>}
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
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL: Module Access (admin)
// ═══════════════════════════════════════════════════════════════════════════
function ModuleAccessPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ModuleAccessUser[]>({ queryKey: ["/api/agent/admin/module-access"] });
  const [bulkRole, setBulkRole] = useState<string>("");
  const toggle = useMutation({
    mutationFn: async ({ userId, enabled }: { userId: string; enabled: boolean }) =>
      apiRequest("PUT", `/api/agent/admin/module-access/${userId}`, { enabled }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/module-access"] }); toast({ title: "Updated" }); },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });
  const bulk = useMutation({
    mutationFn: async ({ enabled }: { enabled: boolean }) =>
      apiRequest("POST", "/api/agent/admin/module-access/bulk", { role: bulkRole, enabled }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/module-access"] });
      toast({ title: vars.enabled ? `Enabled for all ${bulkRole}` : `Disabled for all ${bulkRole}` });
    },
    onError: () => toast({ title: "Bulk update failed", variant: "destructive" }),
  });

  if (isLoading) return <Loader2 className="h-6 w-6 animate-spin" />;
  const rows = data ?? [];
  const enabledCount = rows.filter((r) => r.enabled).length;
  const roles = Array.from(new Set(rows.map((r) => r.role))).sort();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Who can use DNA</CardTitle>
        <CardDescription>
          Toggle access per user. {enabledCount} of {rows.length} users currently have access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap p-3 rounded-md bg-muted/40 border">
          <span className="text-sm font-medium">Bulk apply by role:</span>
          <Select value={bulkRole} onValueChange={setBulkRole}>
            <SelectTrigger className="w-56" data-testid="select-bulk-role"><SelectValue placeholder="Choose role..." /></SelectTrigger>
            <SelectContent>{roles.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" disabled={!bulkRole || bulk.isPending}
            onClick={() => bulk.mutate({ enabled: true })} data-testid="button-bulk-enable">Enable all</Button>
          <Button size="sm" variant="outline" disabled={!bulkRole || bulk.isPending}
            onClick={() => bulk.mutate({ enabled: false })} data-testid="button-bulk-disable">Disable all</Button>
        </div>

        <div className="rounded-md border">
          <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground">
            <div className="col-span-4">User</div>
            <div className="col-span-3">Role</div>
            <div className="col-span-3">Status</div>
            <div className="col-span-2 text-right">Access</div>
          </div>
          {rows.map((u) => (
            <div key={u.id} className="grid grid-cols-12 gap-2 px-4 py-3 border-t items-center" data-testid={`row-user-${u.id}`}>
              <div className="col-span-4">
                <div className="font-medium">{u.name}</div>
                <div className="text-xs text-muted-foreground">{u.email}</div>
              </div>
              <div className="col-span-3"><Badge variant="outline">{u.role}</Badge></div>
              <div className="col-span-3 text-xs text-muted-foreground">
                {u.hasOverride ? <span className="text-amber-600">Override</span> : <span>Role default ({u.defaultEffect})</span>}
              </div>
              <div className="col-span-2 text-right">
                <Switch
                  checked={u.enabled}
                  onCheckedChange={(v) => toggle.mutate({ userId: u.id, enabled: v })}
                  data-testid={`switch-access-${u.id}`}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL: Permissions (admin) — per-user override grid
// ═══════════════════════════════════════════════════════════════════════════
function PermissionsAdminPanel() {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const { data: users, isLoading } = useQuery<SimpleUser[]>({ queryKey: ["/api/users"] });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Per-user permission overrides</CardTitle>
          <CardDescription>Pick a user to fine-tune what DNA can do for them.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
            <Select value={selectedUserId ?? undefined} onValueChange={setSelectedUserId}>
              <SelectTrigger className="w-full md:w-96" data-testid="select-user"><SelectValue placeholder="Choose a user..." /></SelectTrigger>
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
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/users", userId, "capabilities"] }); toast({ title: "Updated" }); },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });
  if (isLoading) return <Loader2 className="h-6 w-6 animate-spin" />;
  if (!data) return null;
  const grouped: Record<string, CapRow[]> = { Module: [], Reads: [], Writes: [], "External Outreach": [], Navigation: [] };
  for (const r of data.rows) grouped[groupOf(r.capability)].push(r);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.user.name}</CardTitle>
        <CardDescription>Role: <Badge variant="outline">{data.user.role}</Badge></CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {Object.entries(grouped).map(([label, items]) => items.length === 0 ? null : (
          <div key={label}>
            <h3 className="font-semibold text-sm mb-2 uppercase tracking-wide text-muted-foreground">{label}</h3>
            <div className="rounded-md border">
              <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground">
                <div className="col-span-5">Capability</div>
                <div className="col-span-2">Default</div>
                <div className="col-span-3">Override</div>
                <div className="col-span-2 text-right">Reset</div>
              </div>
              {items.map((row) => (
                <div key={row.capability} className="grid grid-cols-12 gap-2 px-4 py-2 border-t items-center" data-testid={`row-cap-${row.capability}`}>
                  <div className="col-span-5"><div className="font-mono text-xs">{row.capability}</div></div>
                  <div className={`col-span-2 text-sm ${effectColor(row.defaultEffect)}`}>{row.defaultEffect}</div>
                  <div className="col-span-3">
                    <Select value={row.hasOverride ? row.effect : "__inherit__"}
                      onValueChange={(v) => update.mutate({ capability: row.capability, effect: v === "__inherit__" ? null : (v as Effect) })}>
                      <SelectTrigger data-testid={`select-effect-${row.capability}`}><SelectValue /></SelectTrigger>
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
                      <Button variant="ghost" size="sm"
                        onClick={() => update.mutate({ capability: row.capability, effect: null })}
                        data-testid={`button-clear-${row.capability}`}>
                        <RotateCcw className="h-3 w-3 mr-1" />Reset
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL: Org Defaults (admin) — mass foundational settings
// ═══════════════════════════════════════════════════════════════════════════
function OrgDefaultsPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<OrgSettings>({ queryKey: ["/api/agent/admin/org-settings"] });
  const [draft, setDraft] = useState<Partial<OrgSettings>>({});

  const merged = { ...data, ...draft } as OrgSettings;

  const save = useMutation({
    mutationFn: async () => apiRequest("PUT", "/api/agent/admin/org-settings", draft),
    onSuccess: (res: any) => {
      setDraft({});
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/org-settings"] });
      toast({ title: "Saved" });
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  if (isLoading || !data) return <Loader2 className="h-6 w-6 animate-spin" />;
  const dirty = Object.keys(draft).length > 0;
  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div className="space-y-6">
      <Card className={merged.moduleEnabled ? "" : "border-red-300 bg-red-50/40 dark:bg-red-950/20"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" /> Master switch
          </CardTitle>
          <CardDescription>Turn DNA on or off for the entire organization. Disabling here overrides every per-user permission.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-base">AI Agent module enabled</Label>
            <p className="text-xs text-muted-foreground">When off, no one in this org can talk to DNA — through any channel.</p>
          </div>
          <Switch checked={merged.moduleEnabled} onCheckedChange={(v) => set("moduleEnabled", v)} data-testid="switch-module-enabled" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default policy for new users</CardTitle>
          <CardDescription>Applied to anyone you onboard from now on, unless overridden per-user.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>New users get DNA access</Label>
              <p className="text-xs text-muted-foreground">If "Deny", admins must explicitly grant access in Module Access.</p>
            </div>
            <Select value={merged.defaultAccessForNewUsers}
              onValueChange={(v) => set("defaultAccessForNewUsers", v)}>
              <SelectTrigger className="w-40" data-testid="select-default-access"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Allow</SelectItem>
                <SelectItem value="deny">Deny</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Auto-approve "remember this" personal notes</Label>
              <p className="text-xs text-muted-foreground">DNA can save personal-style memories without asking each time.</p>
            </div>
            <Switch checked={merged.autoApprovePersonalMemory}
              onCheckedChange={(v) => set("autoApprovePersonalMemory", v)} data-testid="switch-auto-memory" />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Allow external outreach (SMS / voice / external email)</Label>
              <p className="text-xs text-muted-foreground">When off, DNA cannot contact drivers or dispatchers regardless of per-user permission.</p>
            </div>
            <Switch checked={merged.allowExternalOutreach}
              onCheckedChange={(v) => set("allowExternalOutreach", v)} data-testid="switch-external-outreach" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default model</CardTitle>
          <CardDescription>The base GPT model DNA uses when no tier-specific override applies.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={merged.defaultModel} onValueChange={(v) => set("defaultModel", v)}>
            <SelectTrigger className="w-72" data-testid="select-default-model"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gpt-4o-mini">GPT-4o-mini (fast, cheap)</SelectItem>
              <SelectItem value="gpt-4o">GPT-4o (balanced)</SelectItem>
              <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Internal notes</CardTitle>
          <CardDescription>For your own team. Not shown to DNA.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea rows={4} value={merged.notes ?? ""} onChange={(e) => set("notes", e.target.value)}
            placeholder="e.g. Reviewed by IT 2026-04-20" data-testid="textarea-notes" />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2 sticky bottom-4">
        {dirty && <Button variant="outline" onClick={() => setDraft({})} data-testid="button-discard">Discard</Button>}
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="button-save-org-settings">
          {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL: Persona & Playbook (admin)
// ═══════════════════════════════════════════════════════════════════════════
type ChannelSlot = "base" | "in_app" | "email" | "sms_voice" | "teams";
interface PersonaChannel {
  channel: ChannelSlot;
  body: string | null;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}
interface PersonaResponse {
  agentId: string;
  defaultBody: string;
  channels: PersonaChannel[];
}
interface Play {
  id: string;
  agentId: string;
  name: string;
  whenToUse: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
interface PersonaHistoryRow {
  id: string;
  channel: string;
  body: string;
  version: number;
  isActive: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

const SLOT_LABELS: Record<ChannelSlot, { label: string; help: string }> = {
  base: {
    label: "Base persona",
    help: "Foundation prompt used everywhere DNA shows up. Channel overlays and plays are appended on top.",
  },
  in_app: {
    label: "In-app chat overlay",
    help: "Tone & format adjustments for the in-app chatbot. Leave blank to use base only.",
  },
  email: {
    label: "Email overlay",
    help: "Adjustments when DNA replies via email (longer-form, formal closings, signature, etc.).",
  },
  sms_voice: {
    label: "SMS / Voice overlay",
    help: "Adjustments for SMS and voice channels. Keep responses short and skimmable.",
  },
  teams: {
    label: "Microsoft Teams overlay",
    help: "Adjustments when DNA posts inside Teams threads.",
  },
};

function PersonaPlaybookPanel() {
  return (
    <div className="space-y-6">
      <PersonaCard />
      <PlaysCard />
    </div>
  );
}

function PersonaCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<PersonaResponse>({ queryKey: ["/api/agent/admin/persona"] });
  const [openSlot, setOpenSlot] = useState<ChannelSlot | null>("base");
  const [drafts, setDrafts] = useState<Partial<Record<ChannelSlot, string>>>({});

  const save = useMutation({
    mutationFn: async ({ channel, body }: { channel: ChannelSlot; body: string }) =>
      apiRequest("PUT", "/api/agent/admin/persona", { channel, body }),
    onSuccess: (_r, vars) => {
      setDrafts((d) => { const n = { ...d }; delete n[vars.channel]; return n; });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/persona"] });
      toast({ title: "Persona saved" });
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });
  const reset = useMutation({
    mutationFn: async (channel: ChannelSlot) =>
      apiRequest("POST", "/api/agent/admin/persona/reset", { channel }),
    onSuccess: (_r, channel) => {
      setDrafts((d) => { const n = { ...d }; delete n[channel]; return n; });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/persona"] });
      toast({ title: "Reset to default" });
    },
    onError: () => toast({ title: "Failed to reset", variant: "destructive" }),
  });

  if (isLoading || !data) return <Loader2 className="h-6 w-6 animate-spin" />;
  const slots: ChannelSlot[] = ["base", "in_app", "email", "sms_voice", "teams"];
  const byChannel = new Map(data.channels.map((c) => [c.channel, c]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-5 w-5" /> Persona
        </CardTitle>
        <CardDescription>
          The base persona is what DNA "is" everywhere. Add channel overlays only when the channel needs different behavior.
          Reps see the same DNA — only the wording changes per channel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {slots.map((slot) => {
          const ch = byChannel.get(slot)!;
          const open = openSlot === slot;
          const draft = drafts[slot];
          const liveBody = ch.body ?? (slot === "base" ? data.defaultBody : "");
          const value = draft !== undefined ? draft : liveBody;
          const dirty = draft !== undefined && draft !== liveBody;
          const isUsingDefault = slot === "base" && ch.body === null;
          const isOverlayEmpty = slot !== "base" && ch.body === null;

          return (
            <div key={slot} className="rounded-md border" data-testid={`row-persona-${slot}`}>
              <button
                type="button"
                className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40"
                onClick={() => setOpenSlot(open ? null : slot)}
                data-testid={`toggle-persona-${slot}`}
              >
                <div className="flex items-center gap-2">
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <div className="text-left">
                    <div className="font-medium">{SLOT_LABELS[slot].label}</div>
                    <div className="text-xs text-muted-foreground">{SLOT_LABELS[slot].help}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {dirty && <Badge variant="outline" className="text-amber-700 border-amber-300">Unsaved</Badge>}
                  {isUsingDefault && <Badge variant="outline">Built-in default</Badge>}
                  {isOverlayEmpty && <Badge variant="outline">No overlay</Badge>}
                  {ch.body !== null && <Badge variant="secondary">v{ch.version}</Badge>}
                </div>
              </button>

              {open && (
                <div className="px-4 pb-4 space-y-3 border-t pt-3">
                  <Textarea
                    rows={slot === "base" ? 14 : 8}
                    value={value}
                    onChange={(e) => setDrafts((d) => ({ ...d, [slot]: e.target.value }))}
                    placeholder={slot === "base" ? "" : "Optional overlay applied on top of the base persona…"}
                    className="font-mono text-xs"
                    data-testid={`textarea-persona-${slot}`}
                  />
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-xs text-muted-foreground">
                      {ch.updatedAt && <>Last edit {formatDistanceToNow(new Date(ch.updatedAt), { addSuffix: true })}</>}
                    </div>
                    <div className="flex items-center gap-2">
                      <PersonaHistorySheet channel={slot} />
                      {ch.body !== null && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={reset.isPending}
                          onClick={() => reset.mutate(slot)}
                          data-testid={`button-reset-${slot}`}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          {slot === "base" ? "Use built-in default" : "Remove overlay"}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={!dirty || save.isPending || !value.trim()}
                        onClick={() => save.mutate({ channel: slot, body: value })}
                        data-testid={`button-save-persona-${slot}`}
                      >
                        {save.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                        Save
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function PersonaHistorySheet({ channel }: { channel: ChannelSlot }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<PersonaHistoryRow[]>({
    queryKey: ["/api/agent/admin/persona/history", { channel }],
    queryFn: async () => {
      const res = await fetch(`/api/agent/admin/persona/history?channel=${channel}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open,
  });
  const restore = useMutation({
    mutationFn: async (versionId: string) => apiRequest("POST", "/api/agent/admin/persona/restore", { versionId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/persona"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/persona/history", { channel }] });
      toast({ title: "Restored" });
      setOpen(false);
    },
    onError: () => toast({ title: "Failed to restore", variant: "destructive" }),
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" data-testid={`button-history-${channel}`}>
          <History className="h-3 w-3 mr-1" /> History
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{SLOT_LABELS[channel].label} — version history</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          {isLoading && <Loader2 className="h-5 w-5 animate-spin" />}
          {!isLoading && (data ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground py-12 text-center">No saved versions yet.</div>
          )}
          {(data ?? []).map((row) => (
            <div key={row.id} className="rounded-md border p-3 space-y-2" data-testid={`row-history-${row.id}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={row.isActive ? "default" : "outline"}>v{row.version}{row.isActive ? " · active" : ""}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(row.createdAt), "MMM d, yyyy h:mma")} · {row.createdByName ?? "system"}
                  </span>
                </div>
                {!row.isActive && (
                  <Button size="sm" variant="outline" disabled={restore.isPending}
                    onClick={() => restore.mutate(row.id)} data-testid={`button-restore-${row.id}`}>
                    Restore
                  </Button>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-words text-xs bg-muted/40 rounded p-2 max-h-48 overflow-y-auto">{row.body}</pre>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PlaysCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Play[]>({ queryKey: ["/api/agent/admin/plays"] });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const blank = { name: "", whenToUse: "", body: "", enabled: true, sortOrder: 0 };
  const [draft, setDraft] = useState<typeof blank>(blank);

  const create = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/agent/admin/plays", draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/plays"] });
      setEditing(null); setDraft(blank); toast({ title: "Play added" });
    },
    onError: () => toast({ title: "Failed to add", variant: "destructive" }),
  });
  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<typeof blank> }) =>
      apiRequest("PUT", `/api/agent/admin/plays/${id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/plays"] });
      setEditing(null);
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/agent/admin/plays/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/admin/plays"] });
      toast({ title: "Removed" });
    },
  });

  const startNew = () => { setDraft(blank); setEditing("new"); };
  const startEdit = (p: Play) => {
    setDraft({ name: p.name, whenToUse: p.whenToUse, body: p.body, enabled: p.enabled, sortOrder: p.sortOrder });
    setEditing(p.id);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5" /> Plays</CardTitle>
          <CardDescription>
            Reusable response approaches DNA can apply when the situation matches a play's "When to use".
            Disabled plays are hidden from the prompt. Total budget: ~5KB.
          </CardDescription>
        </div>
        <Button size="sm" onClick={startNew} disabled={editing === "new"} data-testid="button-add-play">
          <Plus className="h-4 w-4 mr-1" /> New play
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing === "new" && (
          <PlayEditor
            draft={draft} setDraft={setDraft}
            onCancel={() => { setEditing(null); setDraft(blank); }}
            onSave={() => create.mutate()}
            saving={create.isPending}
            testIdSuffix="new"
          />
        )}
        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          (data ?? []).length === 0 && editing !== "new" ? (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-empty-plays">
              No plays yet. Add one to teach DNA a reusable approach.
            </div>
          ) : (
            (data ?? []).map((p) => editing === p.id ? (
              <PlayEditor
                key={p.id}
                draft={draft} setDraft={setDraft}
                onCancel={() => setEditing(null)}
                onSave={() => update.mutate({ id: p.id, patch: draft })}
                saving={update.isPending}
                testIdSuffix={p.id}
              />
            ) : (
              <div key={p.id} className="rounded-md border p-3 space-y-2" data-testid={`row-play-${p.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      {!p.enabled && <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      <span className="font-medium">When:</span> {p.whenToUse}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={(v) => update.mutate({ id: p.id, patch: { enabled: v } })}
                      data-testid={`switch-play-${p.id}`}
                    />
                    <Button variant="ghost" size="sm" onClick={() => startEdit(p)} data-testid={`button-edit-play-${p.id}`}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => del.mutate(p.id)} data-testid={`button-delete-play-${p.id}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <pre className="whitespace-pre-wrap break-words text-xs bg-muted/40 rounded p-2">{p.body}</pre>
              </div>
            ))
          )
        )}
      </CardContent>
    </Card>
  );
}

interface PlayDraft { name: string; whenToUse: string; body: string; enabled: boolean; sortOrder: number }
function PlayEditor({
  draft, setDraft, onSave, onCancel, saving, testIdSuffix,
}: {
  draft: PlayDraft;
  setDraft: (d: PlayDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  testIdSuffix: string;
}) {
  const valid = draft.name.trim().length >= 2 && draft.whenToUse.trim().length >= 2 && draft.body.trim().length >= 2;
  return (
    <div className="rounded-md border p-3 space-y-3 bg-muted/20" data-testid={`editor-play-${testIdSuffix}`}>
      <div className="space-y-1">
        <Label>Name</Label>
        <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="e.g. Lane lost — find win-back angle" data-testid={`input-play-name-${testIdSuffix}`} />
      </div>
      <div className="space-y-1">
        <Label>When to use</Label>
        <Textarea rows={2} value={draft.whenToUse} onChange={(e) => setDraft({ ...draft, whenToUse: e.target.value })}
          placeholder="One sentence — describe the situation that triggers this play."
          data-testid={`input-play-when-${testIdSuffix}`} />
      </div>
      <div className="space-y-1">
        <Label>Approach</Label>
        <Textarea rows={6} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder="Step-by-step approach DNA should follow."
          data-testid={`input-play-body-${testIdSuffix}`} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
            data-testid={`switch-play-enabled-${testIdSuffix}`} />
          <span className="text-sm">Enabled</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} data-testid={`button-cancel-play-${testIdSuffix}`}>Cancel</Button>
          <Button size="sm" disabled={!valid || saving} onClick={onSave} data-testid={`button-save-play-${testIdSuffix}`}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
