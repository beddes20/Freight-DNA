import { useState, useRef } from "react";
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
import { Loader2, Plus, Pencil, Trash2, Users, Shield, ShieldCheck, UserCircle, Crown, Clock, LogIn, Upload, CheckCircle2, SkipForward, List, Network } from "lucide-react";
import type { User } from "@shared/schema";

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

function OrgChartNode({ user, allUsers }: { user: SafeUser; allUsers: SafeUser[] }) {
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
        className="bg-card border border-border rounded-lg p-2.5 shadow-sm hover:shadow-md transition-shadow flex-shrink-0"
        style={{ width: NODE_W }}
        data-testid={`org-node-${user.id}`}
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
              <OrgChartNode key={child.id} user={child} allUsers={allUsers} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SALES_ROLES = new Set(["sales", "sales_director"]);

function OrgChartView({ users }: { users: SafeUser[] }) {
  const chartUsers = users.filter(u => !SALES_ROLES.has(u.role));
  const roots = chartUsers.filter(u => !u.managerId).sort((a, b) => a.name.localeCompare(b.name));

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
              <OrgChartNode key={root.id} user={root} allUsers={chartUsers} />
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
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user?.role || "account_manager");
  const [managerId, setManagerId] = useState(user?.managerId || "none");
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
    const data: any = { name, username, role, managerId: managerId === "none" ? null : managerId };
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
        <Label>Email</Label>
        <Input data-testid="input-user-email" type="email" value={username} onChange={(e) => setUsername(e.target.value)} required />
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
        </>
      )}
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
            <p className="text-sm text-muted-foreground">
              Upload an Excel file with columns: <strong>display_name</strong>, <strong>Email</strong>, <strong>title</strong>. Roles are mapped automatically from the title column.
            </p>
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
              className="w-full bg-gradient-to-r from-blue-600 to-green-600 hover:from-blue-700 hover:to-green-700"
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const { data: users = [], isLoading } = useQuery<SafeUser[]>({ queryKey: ["/api/users"] });
  const [editUser, setEditUser] = useState<SafeUser | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<SafeUser | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "org">("list");
  const { toast } = useToast();

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

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-admin-title">
            <Users className="w-6 h-6 text-blue-600" />
            User Management
          </h1>
          <p className="text-muted-foreground mt-1">{users.length} users</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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

          {currentUser?.role === "admin" && <BulkImportDialog />}
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditUser(undefined); }}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-to-r from-blue-600 to-green-600 hover:from-blue-700 hover:to-green-700" data-testid="button-add-user">
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
        <OrgChartView users={users} />
      ) : (
        <div className="grid gap-4">
          {users.slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => {
            const RoleIcon = ROLE_ICONS[u.role] || UserCircle;
            const manager = getManager(u.managerId);
            return (
              <Card key={u.id} data-testid={`card-user-${u.id}`}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900 dark:to-green-900 flex items-center justify-center">
                      <RoleIcon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
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
