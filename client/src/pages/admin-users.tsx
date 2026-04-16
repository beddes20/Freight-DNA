import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plus, Pencil, Trash2, Users, Shield, ShieldCheck, UserCircle, Crown, Clock, LogIn, Upload, CheckCircle2, SkipForward, List, Network, Mail, XCircle, AlertTriangle, Wifi, TrendingUp, Save, CreditCard, CalendarDays, Download, FileText, ExternalLink, Building2, Contact, RefreshCw, Database } from "lucide-react";
import type { User } from "@shared/schema";
import { WebexConnectionStatus } from "@/components/webex-connection-status";

interface PromotionCriteria {
  id: string;
  fromRole: string;
  toRole: string;
  minLoadCount: number | null;
  minMarginPct: string | null;
  minTouchpoints: number | null;
  minTenureMonths: number | null;
  notes: string | null;
}

function CriteriaForm({ fromRole, toRole, label, existing }: { fromRole: string; toRole: string; label: string; existing?: PromotionCriteria }) {
  const { toast } = useToast();
  const [minLoadCount, setMinLoadCount] = useState(existing?.minLoadCount?.toString() || "");
  const [minMarginPct, setMinMarginPct] = useState(existing?.minMarginPct?.toString() || "");
  const [minTouchpoints, setMinTouchpoints] = useState(existing?.minTouchpoints?.toString() || "");
  const [minTenureMonths, setMinTenureMonths] = useState(existing?.minTenureMonths?.toString() || "");
  const [notes, setNotes] = useState(existing?.notes || "");
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (existing && !synced) {
      setMinLoadCount(existing.minLoadCount?.toString() || "");
      setMinMarginPct(existing.minMarginPct?.toString() || "");
      setMinTouchpoints(existing.minTouchpoints?.toString() || "");
      setMinTenureMonths(existing.minTenureMonths?.toString() || "");
      setNotes(existing.notes || "");
      setSynced(true);
    }
  }, [existing, synced]);

  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PUT", `/api/promotion/criteria/${encodeURIComponent(fromRole)}/${encodeURIComponent(toRole)}`, {
        minLoadCount: minLoadCount ? parseInt(minLoadCount) : null,
        minMarginPct: minMarginPct ? parseFloat(minMarginPct) : null,
        minTouchpoints: minTouchpoints ? parseInt(minTouchpoints) : null,
        minTenureMonths: minTenureMonths ? parseInt(minTenureMonths) : null,
        notes: notes || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/promotion/criteria"] });
      toast({ title: "Criteria saved" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <TrendingUp className="w-4 h-4 text-amber-600" />
        <h3 className="font-semibold text-sm">{label}</h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Min Load Count</Label>
          <Input
            type="number"
            min="0"
            placeholder="e.g. 50"
            value={minLoadCount}
            onChange={e => setMinLoadCount(e.target.value)}
            data-testid={`input-criteria-loads-${fromRole}`}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Min Margin %</Label>
          <Input
            type="number"
            min="0"
            step="0.1"
            placeholder="e.g. 12.5"
            value={minMarginPct}
            onChange={e => setMinMarginPct(e.target.value)}
            data-testid={`input-criteria-margin-${fromRole}`}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Min Touchpoints / Month</Label>
          <Input
            type="number"
            min="0"
            placeholder="e.g. 30"
            value={minTouchpoints}
            onChange={e => setMinTouchpoints(e.target.value)}
            data-testid={`input-criteria-touchpoints-${fromRole}`}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Min Tenure (months)</Label>
          <Input
            type="number"
            min="0"
            placeholder="e.g. 12"
            value={minTenureMonths}
            onChange={e => setMinTenureMonths(e.target.value)}
            data-testid={`input-criteria-tenure-${fromRole}`}
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Additional Notes / Custom Criteria</Label>
        <Textarea
          placeholder="Any additional qualitative criteria..."
          value={notes}
          onChange={e => setNotes(e.target.value)}
          data-testid={`textarea-criteria-notes-${fromRole}`}
          className="text-sm min-h-[60px]"
        />
      </div>
      <Button
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        data-testid={`button-save-criteria-${fromRole}`}
        className="gap-1.5"
      >
        {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        Save Criteria
      </Button>
    </div>
  );
}

function CareerProgressionSection() {
  const { data: criteria = [] } = useQuery<PromotionCriteria[]>({ queryKey: ["/api/promotion/criteria"] });

  const lmToAm = criteria.find(c => c.fromRole === "logistics_manager" && c.toRole === "account_manager");
  const amToNam = criteria.find(c => c.fromRole === "account_manager" && c.toRole === "national_account_manager");

  return (
    <div className="border rounded-xl p-5 space-y-4 bg-muted/30" data-testid="section-career-progression">
      <div className="flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-amber-600" />
        <h2 className="font-semibold text-sm">Career Progression Criteria</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Define the minimum benchmarks reps must meet to be considered for promotion. These are shown to reps on their profile as a readiness checklist.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <CriteriaForm
          fromRole="logistics_manager"
          toRole="account_manager"
          label="LM → Account Manager"
          existing={lmToAm}
        />
        <CriteriaForm
          fromRole="account_manager"
          toRole="national_account_manager"
          label="AM → National Account Manager"
          existing={amToNam}
        />
      </div>
    </div>
  );
}

type SafeUser = Omit<User, "password">;

function formatLastLogin(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  national_account_manager: "National Account Manager",
  account_manager: "Account Manager",
  sales: "Sales",
  sales_director: "Sales Director",
  logistics_manager: "Logistics Manager",
  logistics_coordinator: "Logistics Coordinator",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  director: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  national_account_manager: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  account_manager: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  sales: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  sales_director: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  logistics_manager: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
  logistics_coordinator: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
};

const ROLE_ICONS: Record<string, any> = {
  admin: Shield,
  director: Crown,
  national_account_manager: ShieldCheck,
  account_manager: UserCircle,
  sales: UserCircle,
  sales_director: Crown,
  logistics_manager: UserCircle,
  logistics_coordinator: UserCircle,
};

const AVATAR_COLORS: Record<string, string> = {
  admin: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
  director: "bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300",
  national_account_manager: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
  account_manager: "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300",
  sales: "bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300",
  sales_director: "bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300",
  logistics_manager: "bg-teal-100 dark:bg-teal-900 text-teal-700 dark:text-teal-300",
  logistics_coordinator: "bg-cyan-100 dark:bg-cyan-900 text-cyan-700 dark:text-cyan-300",
};

const SHORT_ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  director: "Director",
  national_account_manager: "NAM",
  account_manager: "Acct Mgr",
  sales: "Sales",
  sales_director: "Sales Dir.",
  logistics_manager: "Log. Mgr.",
  logistics_coordinator: "Log. Coord.",
};

// ─── Org Chart ────────────────────────────────────────────────────────────────

const NODE_W = 152;
const CHILD_GAP = 20;
const CONN_H = 36;

function subtreeWidth(userId: string, all: SafeUser[]): number {
  const kids = all.filter(u => u.managerId === userId);
  if (kids.length === 0) return NODE_W;
  return kids.reduce((s, k, i) => s + subtreeWidth(k.id, all) + (i < kids.length - 1 ? CHILD_GAP : 0), 0);
}

function OrgChartNode({ user, allUsers, onEdit }: { user: SafeUser; allUsers: SafeUser[]; onEdit: (u: SafeUser) => void }) {
  const children = allUsers
    .filter(u => u.managerId === user.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const initials = user.name
    .split(" ")
    .filter(Boolean)
    .map(n => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const childWidths = children.map(c => subtreeWidth(c.id, allUsers));
  const totalW = childWidths.reduce((s, w, i) => s + w + (i < children.length - 1 ? CHILD_GAP : 0), 0);
  const mySubtreeW = Math.max(totalW, NODE_W);

  const childCenters: number[] = [];
  let offset = 0;
  for (let i = 0; i < children.length; i++) {
    childCenters.push(offset + childWidths[i] / 2);
    offset += childWidths[i] + (i < children.length - 1 ? CHILD_GAP : 0);
  }

  return (
    <div className="flex flex-col items-center" style={{ width: mySubtreeW }}>
      {/* Node card */}
      <div
        className="bg-card border border-border rounded-lg p-2.5 shadow-sm hover:shadow-md hover:border-primary/40 transition-all flex-shrink-0 cursor-pointer"
        style={{ width: NODE_W }}
        data-testid={`org-node-${user.id}`}
        onClick={() => onEdit(user)}
        title={`Edit ${user.name}`}
      >
        <div className="flex flex-col items-center gap-1 text-center">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${AVATAR_COLORS[user.role] || "bg-muted text-muted-foreground"}`}>
            {initials}
          </div>
          <p className="text-xs font-semibold leading-tight line-clamp-2 w-full">{user.name}</p>
          <Badge className={`${ROLE_COLORS[user.role]} text-[10px] px-1.5 py-0 pointer-events-none`}>
            {SHORT_ROLE_LABELS[user.role] || user.role}
          </Badge>
          {children.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              {children.length} report{children.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>
      </div>

      {/* Connectors + children */}
      {children.length > 0 && (
        <>
          {/* Connector lines */}
          <div className="relative flex-shrink-0" style={{ width: totalW, height: CONN_H }}>
            {/* Vertical from node center down */}
            <div
              className="absolute bg-border"
              style={{ left: totalW / 2 - 0.5, top: 0, width: 1, height: CONN_H / 2 }}
            />
            {/* Horizontal bar (only for multiple children) */}
            {children.length > 1 && (
              <div
                className="absolute bg-border"
                style={{
                  left: childCenters[0],
                  top: CONN_H / 2,
                  width: childCenters[childCenters.length - 1] - childCenters[0],
                  height: 1,
                }}
              />
            )}
            {/* Vertical drops to each child */}
            {childCenters.map((cx, i) => (
              <div
                key={i}
                className="absolute bg-border"
                style={{
                  left: cx - 0.5,
                  top: children.length === 1 ? 0 : CONN_H / 2,
                  width: 1,
                  height: children.length === 1 ? CONN_H : CONN_H / 2,
                }}
              />
            ))}
          </div>

          {/* Children row */}
          <div className="flex items-start flex-shrink-0" style={{ gap: CHILD_GAP }}>
            {children.map(child => (
              <OrgChartNode key={child.id} user={child} allUsers={allUsers} onEdit={onEdit} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SALES_ROLES = new Set(["sales", "sales_director"]);

function OrgChartView({ users, onEdit }: { users: SafeUser[]; onEdit: (u: SafeUser) => void }) {
  const chartUsers = users.filter(u => !SALES_ROLES.has(u.role));
  const chartUserIds = new Set(chartUsers.map(u => u.id));
  // Treat anyone whose manager isn't in the visible list as a root (handles NAM/director scoped views)
  const roots = chartUsers.filter(u => !u.managerId || !chartUserIds.has(u.managerId)).sort((a, b) => a.name.localeCompare(b.name));

  if (users.length === 0) {
    return <p className="text-center py-12 text-muted-foreground">No users to display.</p>;
  }

  return (
    <div className="overflow-x-auto overflow-y-auto pb-6">
      <div className="min-w-max px-6 pt-4 pb-8">
        {roots.length === 0 ? (
          <p className="text-center py-12 text-muted-foreground">Everyone has a manager assigned — no root nodes found.</p>
        ) : (
          <div className="flex gap-12 justify-start">
            {roots.map(root => (
              <OrgChartNode key={root.id} user={root} allUsers={chartUsers} onEdit={onEdit} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── User Dialog ──────────────────────────────────────────────────────────────

function UserDialog({ user, users, onClose, isNAM }: { user?: SafeUser; users: SafeUser[]; onClose: () => void; isNAM?: boolean }) {
  const [name, setName] = useState(user?.name || "");
  const [username, setUsername] = useState(user?.username || "");
  const [email, setEmail] = useState((user as any)?.email || "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user?.role || "account_manager");
  const [managerId, setManagerId] = useState(user?.managerId || "none");
  const [financialRepId, setFinancialRepId] = useState((user as any)?.financialRepId || "");
  const [emailSignature, setEmailSignature] = useState(user?.emailSignature || "");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (data: any) => {
      if (user) {
        await apiRequest("PATCH", `/api/users/${user.id}`, data);
      } else {
        await apiRequest("POST", "/api/users", data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team-members"] });
      toast({ title: user ? "User updated" : "User created" });
      onClose();
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data: any = { name, username, email: email.trim() || null, role, managerId: managerId === "none" ? null : managerId, financialRepId: financialRepId.trim() || null, emailSignature: emailSignature.trim() || null };
    if (password) data.password = password;
    if (!user && !password) {
      toast({ title: "Error", description: "Password is required", variant: "destructive" });
      return;
    }
    mutation.mutate(data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>Full Name</Label>
        <Input data-testid="input-user-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>Login Email (Username)</Label>
        <Input data-testid="input-user-email" type="email" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>Report Delivery Email <span className="text-muted-foreground font-normal text-xs">(if different from login)</span></Label>
        <Input data-testid="input-user-report-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={username || "Same as login email"} />
      </div>
      <div className="space-y-2">
        <Label>{user ? "New Password (leave blank to keep)" : "Password"}</Label>
        <Input data-testid="input-user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!user} />
      </div>
      {!isNAM && (
        <>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger data-testid="select-user-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="director">Director</SelectItem>
                <SelectItem value="national_account_manager">National Account Manager</SelectItem>
                <SelectItem value="account_manager">Account Manager</SelectItem>
                <SelectItem value="sales">Sales</SelectItem>
                <SelectItem value="sales_director">Sales Director</SelectItem>
                <SelectItem value="logistics_manager">Logistics Manager</SelectItem>
                <SelectItem value="logistics_coordinator">Logistics Coordinator</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Reports To</Label>
            <Select value={managerId || "none"} onValueChange={setManagerId}>
              <SelectTrigger data-testid="select-user-manager">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {users.filter(m => m.id !== user?.id).sort((a, b) => a.name.localeCompare(b.name)).map(m => (
                  <SelectItem key={m.id} value={m.id}>{m.name} ({ROLE_LABELS[m.role]})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Financial Rep ID <span className="text-muted-foreground font-normal text-xs">(matches rep code in Excel uploads)</span></Label>
            <Input
              data-testid="input-user-financial-rep-id"
              value={financialRepId}
              onChange={(e) => setFinancialRepId(e.target.value)}
              placeholder="e.g. baagard, zsatteson"
            />
          </div>
        </>
      )}
      <div className="space-y-2">
        <Label>Email Signature <span className="text-muted-foreground font-normal text-xs">(appended to outgoing emails)</span></Label>
        <Textarea
          data-testid="textarea-user-email-signature"
          value={emailSignature}
          onChange={(e) => setEmailSignature(e.target.value)}
          placeholder="e.g. John Smith&#10;Account Manager | Value Truck&#10;john.smith@valuetruck.com"
          rows={4}
          className="text-sm resize-none"
        />
      </div>
      <Button type="submit" className="w-full" disabled={mutation.isPending} data-testid="button-save-user">
        {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {user ? "Update User" : "Create User"}
      </Button>
    </form>
  );
}

// ─── Bulk Import ──────────────────────────────────────────────────────────────

function BulkImportDialog() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [defaultPassword, setDefaultPassword] = useState("Shipping123!");
  const [result, setResult] = useState<{ created: string[]; skipped: string[]; errors: string[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("defaultPassword", defaultPassword);
      const res = await fetch("/api/users/bulk-import", { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setFile(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-bulk-import">
          <Upload className="w-4 h-4 mr-2" /> Bulk Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk Import Users</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg bg-green-50 dark:bg-green-950 p-3">
                <p className="text-2xl font-bold text-green-600">{result.created.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Created</p>
              </div>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950 p-3">
                <p className="text-2xl font-bold text-amber-600">{result.skipped.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Already Exist</p>
              </div>
              <div className="rounded-lg bg-red-50 dark:bg-red-950 p-3">
                <p className="text-2xl font-bold text-red-600">{result.errors.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Errors</p>
              </div>
            </div>
            {result.created.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1"><CheckCircle2 className="w-4 h-4 text-green-500" /> Created</p>
                <div className="max-h-40 overflow-y-auto text-sm space-y-1">
                  {result.created.map(n => <p key={n} className="text-muted-foreground">{n}</p>)}
                </div>
              </div>
            )}
            {result.skipped.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1"><SkipForward className="w-4 h-4 text-amber-500" /> Skipped (already exist)</p>
                <div className="max-h-32 overflow-y-auto text-sm space-y-1">
                  {result.skipped.map(n => <p key={n} className="text-muted-foreground">{n}</p>)}
                </div>
              </div>
            )}
            <Button className="w-full" onClick={handleClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Upload an Excel file with columns: <strong>display_name</strong>, <strong>Email</strong>, <strong>title</strong>. Roles are mapped automatically from the title column.
              </p>
              <a
                href="/api/import-templates/users"
                download
                className="shrink-0 inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                data-testid="link-download-users-template"
              >
                <Download className="h-3.5 w-3.5" /> Template
              </a>
            </div>
            <div className="space-y-2">
              <Label>Excel File (.xlsx)</Label>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                data-testid="input-bulk-import-file"
                className="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-950 dark:file:text-blue-300"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>
            <div className="space-y-2">
              <Label>Default Password for New Users</Label>
              <Input
                data-testid="input-bulk-import-password"
                value={defaultPassword}
                onChange={(e) => setDefaultPassword(e.target.value)}
                placeholder="Default password"
              />
              <p className="text-xs text-muted-foreground">All newly created users will have this password. They can change it after logging in.</p>
            </div>
            <div className="bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground mb-1">Title → Role mapping:</p>
              <p>Account Manager → Account Manager</p>
              <p>National Account Manager → NAM</p>
              <p>Logistics Manager → Logistics Manager</p>
              <p>Logistics Coordinator → Logistics Coordinator</p>
              <p>Sales → Sales &nbsp;|&nbsp; Sales Director → Sales Director</p>
              <p>Admin → Admin &nbsp;|&nbsp; Director → Director</p>
            </div>
            <Button
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={!file || !defaultPassword || loading}
              onClick={handleImport}
              data-testid="button-confirm-bulk-import"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? "Importing..." : `Import Users`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk Import Companies ─────────────────────────────────────────────────────

function BulkImportCompaniesDialog() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ created: string[]; skipped: string[]; errors: string[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/companies/bulk-import", { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setFile(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-bulk-import-companies">
          <Building2 className="w-4 h-4 mr-2" /> Import Companies
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk Import Companies</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg bg-green-50 dark:bg-green-950 p-3">
                <p className="text-2xl font-bold text-green-600">{result.created.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Created</p>
              </div>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950 p-3">
                <p className="text-2xl font-bold text-amber-600">{result.skipped.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Already Exist</p>
              </div>
              <div className="rounded-lg bg-red-50 dark:bg-red-950 p-3">
                <p className="text-2xl font-bold text-red-600">{result.errors.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Errors</p>
              </div>
            </div>
            {result.created.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1"><CheckCircle2 className="w-4 h-4 text-green-500" /> Created</p>
                <div className="max-h-40 overflow-y-auto text-sm space-y-1">
                  {result.created.map(n => <p key={n} className="text-muted-foreground">{n}</p>)}
                </div>
              </div>
            )}
            {result.skipped.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1"><SkipForward className="w-4 h-4 text-amber-500" /> Skipped (already exist)</p>
                <div className="max-h-32 overflow-y-auto text-sm space-y-1">
                  {result.skipped.map(n => <p key={n} className="text-muted-foreground">{n}</p>)}
                </div>
              </div>
            )}
            {result.errors.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1"><XCircle className="w-4 h-4 text-red-500" /> Errors</p>
                <div className="max-h-32 overflow-y-auto text-sm space-y-1">
                  {result.errors.map((e, i) => <p key={i} className="text-muted-foreground">{e}</p>)}
                </div>
              </div>
            )}
            <Button className="w-full" onClick={handleClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Upload an Excel file to create customer accounts in bulk. Duplicate company names are skipped automatically.
              </p>
              <a
                href="/api/import-templates/companies"
                download
                className="shrink-0 inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                data-testid="link-download-companies-template"
              >
                <Download className="h-3.5 w-3.5" /> Template
              </a>
            </div>
            <div className="bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground mb-1">Required &amp; optional columns:</p>
              <p><strong>company_name</strong> (required), industry, website</p>
              <p>shipping_modes (comma-separated: FTL,LTL,Drayage,IMDL)</p>
              <p>estimated_freight_spend, assigned_rep_email, account_summary, financial_alias</p>
            </div>
            <div className="space-y-2">
              <Label>Excel File (.xlsx)</Label>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                data-testid="input-bulk-import-companies-file"
                className="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-950 dark:file:text-blue-300"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>
            <Button
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={!file || loading}
              onClick={handleImport}
              data-testid="button-confirm-bulk-import-companies"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? "Importing..." : "Import Companies"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk Import Contacts ──────────────────────────────────────────────────────

function BulkImportContactsDialog() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ created: string[]; errors: string[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/contacts/bulk-import", { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setFile(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-bulk-import-contacts">
          <Contact className="w-4 h-4 mr-2" /> Import Contacts
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk Import Contacts</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-green-50 dark:bg-green-950 p-3">
                <p className="text-2xl font-bold text-green-600">{result.created.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Created</p>
              </div>
              <div className="rounded-lg bg-red-50 dark:bg-red-950 p-3">
                <p className="text-2xl font-bold text-red-600">{result.errors.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Errors</p>
              </div>
            </div>
            {result.created.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1"><CheckCircle2 className="w-4 h-4 text-green-500" /> Created</p>
                <div className="max-h-48 overflow-y-auto text-sm space-y-1">
                  {result.created.map((n, i) => <p key={i} className="text-muted-foreground">{n}</p>)}
                </div>
              </div>
            )}
            {result.errors.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2 flex items-center gap-1"><XCircle className="w-4 h-4 text-red-500" /> Errors</p>
                <div className="max-h-32 overflow-y-auto text-sm space-y-1">
                  {result.errors.map((e, i) => <p key={i} className="text-muted-foreground">{e}</p>)}
                </div>
              </div>
            )}
            <Button className="w-full" onClick={handleClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Upload an Excel file to create contacts across all companies. Contacts are matched to companies by name — import companies first.
              </p>
              <a
                href="/api/import-templates/contacts"
                download
                className="shrink-0 inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                data-testid="link-download-contacts-template"
              >
                <Download className="h-3.5 w-3.5" /> Template
              </a>
            </div>
            <div className="bg-muted/40 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground mb-1">Required &amp; optional columns:</p>
              <p><strong>contact_name</strong>, <strong>company_name</strong> (required — must match exactly)</p>
              <p>title, email, phone, relationship_base</p>
              <p className="text-amber-600 dark:text-amber-400">Tip: relationship_base values — 1st Base, 2nd Base, 3rd Base, Home Run</p>
            </div>
            <div className="space-y-2">
              <Label>Excel File (.xlsx)</Label>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                data-testid="input-bulk-import-contacts-file"
                className="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-950 dark:file:text-blue-300"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>
            <Button
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={!file || loading}
              onClick={handleImport}
              data-testid="button-confirm-bulk-import-contacts"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? "Importing..." : "Import Contacts"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── ZoomInfo Mapping Panel ───────────────────────────────────────────────────

const ZOOMINFO_CRM_FIELDS = [
  { key: "name",                   label: "Company Name *" },
  { key: "industry",               label: "Industry" },
  { key: "estimatedAnnualRevenue", label: "Est. Annual Revenue" },
  { key: "employeeCount",          label: "Employee Count" },
  { key: "website",                label: "Website" },
  { key: "primaryContactName",     label: "Contact 1 Name" },
  { key: "primaryContactTitle",    label: "Contact 1 Title" },
  { key: "primaryContactEmail",    label: "Contact 1 Email" },
  { key: "primaryContactPhone",    label: "Contact 1 Phone" },
  { key: "contact2Name",           label: "Contact 2 Name" },
  { key: "contact2Email",          label: "Contact 2 Email" },
  { key: "contact3Name",           label: "Contact 3 Name" },
  { key: "contact3Email",          label: "Contact 3 Email" },
  { key: "currentCarrier",         label: "Current Carrier" },
  { key: "notes",                  label: "Notes" },
];

function ZoomInfoMappingPanel() {
  const { toast } = useToast();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<{ mapping: Record<string, string> }>({
    queryKey: ["/api/settings/zoominfo-mapping"],
  });

  useEffect(() => {
    if (data?.mapping) setMapping(data.mapping);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PUT", "/api/settings/zoominfo-mapping", { mapping });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/zoominfo-mapping"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast({ title: "ZoomInfo field mapping saved" });
    },
    onError: () => toast({ title: "Failed to save mapping", variant: "destructive" }),
  });

  return (
    <div className="rounded-xl border border-border p-5 space-y-4" data-testid="section-zoominfo-mapping">
      <div>
        <p className="font-semibold text-sm flex items-center gap-1.5 mb-1">
          <Database className="w-4 h-4 text-blue-600" /> ZoomInfo Column Mapping
        </p>
        <p className="text-xs text-muted-foreground">
          Configure which ZoomInfo export column names map to CRM fields. These defaults are used when auto-detecting columns during import. Leave blank to use built-in auto-detection.
        </p>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {ZOOMINFO_CRM_FIELDS.map(f => (
            <div key={f.key} className="flex items-center gap-2">
              <label className="text-xs w-36 shrink-0 text-muted-foreground">{f.label}</label>
              <Input
                value={mapping[f.key] || ""}
                onChange={e => setMapping(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder="ZoomInfo column name…"
                className="h-7 text-xs flex-1"
                data-testid={`zoominfo-mapping-${f.key}`}
              />
            </div>
          ))}
        </div>
      )}

      <Button
        size="sm"
        className="gap-1.5 h-8 text-xs"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending}
        data-testid="button-save-zoominfo-mapping"
      >
        {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <Save className="h-3.5 w-3.5" />}
        {saved ? "Saved!" : "Save Mapping"}
      </Button>
    </div>
  );
}

// ─── Demo Org Tools ───────────────────────────────────────────────────────────

function DemoOrgTools() {
  const { toast } = useToast();
  const [log, setLog] = useState<string | null>(null);

  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/seed-demo");
      return res.json();
    },
    onSuccess: (data) => {
      setLog(data.message || "Seed complete");
      toast({ title: "Demo org refreshed", description: "All demo data has been reseeded successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Seed failed", description: err?.message || "An error occurred", variant: "destructive" });
    },
  });

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-5 space-y-4" data-testid="section-demo-org-tools">
      <div>
        <p className="font-semibold text-sm flex items-center gap-1.5 text-amber-800 dark:text-amber-300 mb-1">
          <Database className="w-4 h-4" /> Demo Org Tools
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Use this to reseed the demo org with fresh dummy data. Login: <strong>admin@freightdna-demo.com</strong> / <strong>Demo1234!</strong>
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="border-amber-400 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 gap-1.5"
          onClick={() => { setLog(null); seedMutation.mutate(); }}
          disabled={seedMutation.isPending}
          data-testid="button-reseed-demo-org"
        >
          {seedMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {seedMutation.isPending ? "Seeding… (30–60s)" : "Reseed Demo Org"}
        </Button>
      </div>
      {log && (
        <p className="text-xs text-green-700 dark:text-green-400 flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" /> {log}
        </p>
      )}
    </div>
  );
}

// ─── Billing Panel ────────────────────────────────────────────────────────────

const BILLING_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  past_due: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

interface Invoice {
  id: string;
  number: string | null;
  amountPaid: number;
  currency: string;
  status: string | null;
  created: number;
  periodStart: number;
  periodEnd: number;
  invoicePdf: string | null;
  hostedInvoiceUrl: string | null;
}

function formatCurrency(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function BillingPanel() {
  const { data, isLoading } = useQuery<{
    organization: {
      id: string;
      name: string;
      billingStatus: string | null;
      planName: string | null;
      stripeCustomerId: string | null;
      currentPeriodEnd: string | null;
    } | null;
  }>({
    queryKey: ["/api/admin/billing"],
  });

  const { data: invoiceData, isLoading: invoicesLoading } = useQuery<{ invoices: Invoice[] }>({
    queryKey: ["/api/admin/billing/invoices"],
  });

  const org = data?.organization ?? null;
  const invoices = invoiceData?.invoices ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!org) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="section-billing-panel">
        No billing information found for your organization.
      </p>
    );
  }

  const status = org.billingStatus || "pending";

  return (
    <div className="space-y-4" data-testid="section-billing-panel">
      {/* Subscription status card */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border border-border bg-background">
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate" data-testid={`text-org-name-${org.id}`}>{org.name || "—"}</p>
          {org.planName && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <CreditCard className="w-3 h-3" />
              {org.planName}
            </p>
          )}
          {org.currentPeriodEnd && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <CalendarDays className="w-3 h-3" />
              Renews {new Date(org.currentPeriodEnd).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {org.stripeCustomerId && (
            <Badge variant="outline" className="text-[10px] font-mono">{org.stripeCustomerId.slice(0, 14)}…</Badge>
          )}
          <Badge className={`text-xs capitalize ${BILLING_STATUS_COLORS[status] ?? BILLING_STATUS_COLORS.pending}`} data-testid={`badge-billing-status-${org.id}`}>
            {status}
          </Badge>
        </div>
      </div>

      {/* Invoice history */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5" /> Invoice History
        </p>

        {invoicesLoading ? (
          <div className="flex items-center gap-2 py-3 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading invoices…
          </div>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2" data-testid="text-no-invoices">
            No invoices yet — they'll appear here once your first billing cycle completes.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden" data-testid="list-invoices">
            {invoices.map((inv) => {
              const periodLabel = `${new Date(inv.periodStart * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" })} – ${new Date(inv.periodEnd * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
              return (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 bg-background hover:bg-muted/40 transition-colors"
                  data-testid={`row-invoice-${inv.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{inv.number || inv.id}</p>
                    <p className="text-xs text-muted-foreground">{periodLabel}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-semibold">
                      {formatCurrency(inv.amountPaid, inv.currency)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {inv.invoicePdf && (
                        <a
                          href={inv.invoicePdf}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Download PDF"
                          data-testid={`button-invoice-pdf-${inv.id}`}
                        >
                          <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs">
                            <Download className="w-3.5 h-3.5" /> PDF
                          </Button>
                        </a>
                      )}
                      {inv.hostedInvoiceUrl && (
                        <a
                          href={inv.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View invoice"
                          data-testid={`button-invoice-view-${inv.id}`}
                        >
                          <Button size="sm" variant="ghost" className="h-7 px-2">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const { data: users = [], isLoading } = useQuery<SafeUser[]>({ queryKey: ["/api/users"] });
  const [editUser, setEditUser] = useState<SafeUser | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<SafeUser | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "org">("list");
  const { toast } = useToast();

  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [search, setSearch] = useState("");

  const smtpTestMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/smtp/test");
      return res.json();
    },
    onSuccess: (d) => setSmtpResult(d),
    onError: (e: any) => setSmtpResult({ ok: false, error: e.message || "Connection failed" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team-members"] });
      toast({ title: "User deleted" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const impersonateMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiRequest("POST", `/api/admin/impersonate/${userId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.href = "/";
    },
    onError: (error: any) => {
      toast({ title: "Could not switch account", description: error.message, variant: "destructive" });
    },
  });

  const isNAM = currentUser?.role === "national_account_manager" || currentUser?.role === "director" || currentUser?.role === "sales" || currentUser?.role === "sales_director";

  if (currentUser?.role !== "admin" && !isNAM) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Access required</p>
      </div>
    );
  }

  const getManager = (managerId: string | null) => {
    if (!managerId) return null;
    return users.find(u => u.id === managerId);
  };

  const q = search.toLowerCase().trim();
  const filteredUsers = q
    ? users.filter(u =>
        u.name.toLowerCase().includes(q) ||
        u.role.toLowerCase().replace(/_/g, " ").includes(q) ||
        (u.username || "").toLowerCase().includes(q)
      )
    : users;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {currentUser?.role === "admin" && <WebexConnectionStatus />}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-admin-title">
            <Users className="w-6 h-6 text-amber-600" />
            User Management
          </h1>
          <p className="text-muted-foreground mt-1">
            {q ? `${filteredUsers.length} of ${users.length} users` : `${users.length} users`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search by name or role…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-9 w-52 rounded-lg border border-input bg-background px-3 pr-8 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="input-user-search"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                data-testid="button-clear-search"
              >
                ×
              </button>
            )}
          </div>
          {/* View toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden" data-testid="view-toggle">
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="sm"
              className="rounded-none gap-1.5 px-3"
              onClick={() => setViewMode("list")}
              data-testid="button-view-list"
            >
              <List className="w-4 h-4" /> List
            </Button>
            <Button
              variant={viewMode === "org" ? "default" : "ghost"}
              size="sm"
              className="rounded-none gap-1.5 px-3 border-l border-border"
              onClick={() => setViewMode("org")}
              data-testid="button-view-org"
            >
              <Network className="w-4 h-4" /> Org Chart
            </Button>
          </div>

          {currentUser?.role === "admin" && (
            <>
              <BulkImportDialog />
              <BulkImportCompaniesDialog />
              <BulkImportContactsDialog />
            </>
          )}
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditUser(undefined); }}>
            <DialogTrigger asChild>
              <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="button-add-user">
                <Plus className="w-4 h-4 mr-2" /> {isNAM ? "Add Account Manager" : "Add User"}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editUser ? "Edit User" : isNAM ? "Add Account Manager" : "Add User"}</DialogTitle>
              </DialogHeader>
              <UserDialog
                user={editUser}
                users={users}
                isNAM={isNAM}
                onClose={() => { setDialogOpen(false); setEditUser(undefined); }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : viewMode === "org" ? (
        <OrgChartView users={users} onEdit={(u) => { setEditUser(u); setDialogOpen(true); }} />
      ) : (
        <div className="grid gap-4">
          {filteredUsers.length === 0 && (
            <p className="text-muted-foreground text-sm text-center py-10">
              No users match <strong>"{search}"</strong>.
            </p>
          )}
          {filteredUsers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => {
            const RoleIcon = ROLE_ICONS[u.role] || UserCircle;
            const manager = getManager(u.managerId);
            return (
              <Card key={u.id} data-testid={`card-user-${u.id}`}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-900 dark:to-amber-950 flex items-center justify-center">
                      <RoleIcon className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <p className="font-medium" data-testid={`text-user-name-${u.id}`}>{u.name}</p>
                      <p className="text-sm text-muted-foreground">{u.username}</p>
                      {manager && (
                        <p className="text-xs text-muted-foreground mt-0.5">Reports to: {manager.name}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1" data-testid={`text-user-lastlogin-${u.id}`}>
                        <Clock className="w-3 h-3" />
                        Last login: {formatLastLogin(u.lastLoginAt)}
                      </p>
                      {currentUser?.role === "admin" && u.role !== "admin" && !(u as any).financialRepId && (
                        <span className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 rounded px-1.5 py-0.5 cursor-pointer hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors" title="Set a Financial Rep ID so this user's data is matched in financial uploads" onClick={() => { setEditUser(u); setDialogOpen(true); }} data-testid={`badge-missing-fin-id-${u.id}`}>
                          <AlertTriangle className="w-2.5 h-2.5" />
                          No Financial ID
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={ROLE_COLORS[u.role]} data-testid={`badge-user-role-${u.id}`}>
                      {ROLE_LABELS[u.role] || u.role}
                    </Badge>
                    {currentUser?.role === "admin" && u.role !== "admin" && u.id !== currentUser?.id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-blue-500 hover:text-blue-700"
                        title="Login as this user"
                        onClick={() => impersonateMutation.mutate(u.id)}
                        disabled={impersonateMutation.isPending}
                        data-testid={`button-login-as-${u.id}`}
                      >
                        <LogIn className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setEditUser(u); setDialogOpen(true); }}
                      data-testid={`button-edit-user-${u.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    {u.id !== currentUser?.id && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-red-500 hover:text-red-700"
                        onClick={() => setUserToDelete(u)}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-user-${u.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {currentUser?.role === "admin" && <CareerProgressionSection />}

      {currentUser?.role === "admin" && (
        <div className="border rounded-xl p-5 space-y-4 bg-muted/30">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-blue-600" />
            <h2 className="font-semibold text-sm">Email / SMTP Configuration</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {[
              { label: "Host", value: "smtpout.secureserver.net" },
              { label: "Port", value: "465 (SSL)" },
              { label: "From", value: "info@freight-dna.com" },
              { label: "Password", value: "•••••••• (Replit Secret)" },
            ].map(({ label, value }) => (
              <div key={label} className="bg-background border rounded-lg p-3">
                <p className="text-muted-foreground mb-0.5">{label}</p>
                <p className="font-mono font-medium truncate">{value}</p>
              </div>
            ))}
          </div>

          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 text-xs space-y-1.5">
            <p className="font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> Setup checklist
            </p>
            <ol className="text-amber-700 dark:text-amber-400 space-y-1 ml-5 list-decimal">
              <li>In Replit, open <strong>Secrets</strong> and set <strong>SMTP_PASSWORD</strong> to the GoDaddy email password for <em>info@freight-dna.com</em></li>
              <li>Click <strong>Test Connection</strong> below — a green message means emails are ready to send</li>
              <li>Use the <strong>Email Report</strong> button on any rep's report card to send a manual test email</li>
            </ol>
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setSmtpResult(null); smtpTestMutation.mutate(); }}
              disabled={smtpTestMutation.isPending}
              data-testid="button-smtp-test"
              className="gap-1.5"
            >
              {smtpTestMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
              Test Connection
            </Button>
            {smtpResult && (
              <span className={`flex items-center gap-1.5 text-sm font-medium ${smtpResult.ok ? "text-green-600" : "text-red-600"}`}>
                {smtpResult.ok
                  ? <><CheckCircle2 className="w-4 h-4" /> Connected — SMTP is working!</>
                  : <><XCircle className="w-4 h-4" /> {smtpResult.error}</>
                }
              </span>
            )}
          </div>
        </div>
      )}

      {(currentUser?.role === "admin" || currentUser?.role === "director") && (
        <ZoomInfoMappingPanel />
      )}

      {currentUser?.role === "admin" && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-5 space-y-4" data-testid="section-billing-wrapper">
          <div>
            <p className="font-semibold text-sm flex items-center gap-1.5 text-blue-800 dark:text-blue-300 mb-1">
              <CreditCard className="w-4 h-4" /> Billing &amp; Subscriptions
            </p>
            <p className="text-xs text-blue-700 dark:text-blue-400">Organization subscription status managed through Stripe.</p>
          </div>
          <BillingPanel />
        </div>
      )}

      {currentUser?.role === "admin" && (
        <DemoOrgTools />
      )}

      <AlertDialog open={!!userToDelete} onOpenChange={(open) => { if (!open) setUserToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {userToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{userToDelete?.name}</strong> and remove all of their data including touchpoints, callouts, and goals. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => { if (userToDelete) { deleteMutation.mutate(userToDelete.id); setUserToDelete(null); } }}
              data-testid="button-confirm-delete-user"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
