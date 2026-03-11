import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Pencil, Trash2, Users, Shield, ShieldCheck, UserCircle } from "lucide-react";
import type { User } from "@shared/schema";

type SafeUser = Omit<User, "password">;

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  national_account_manager: "National Account Manager",
  account_manager: "Account Manager",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  national_account_manager: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  account_manager: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
};

const ROLE_ICONS: Record<string, any> = {
  admin: Shield,
  national_account_manager: ShieldCheck,
  account_manager: UserCircle,
};

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

  const managers = users.filter(u => u.role === "admin" || u.role === "national_account_manager");

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
                <SelectItem value="national_account_manager">National Account Manager</SelectItem>
                <SelectItem value="account_manager">Account Manager</SelectItem>
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
                {managers.filter(m => m.id !== user?.id).map(m => (
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

export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const { data: users = [], isLoading } = useQuery<SafeUser[]>({ queryKey: ["/api/users"] });
  const [editUser, setEditUser] = useState<SafeUser | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "User deleted" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const isNAM = currentUser?.role === "national_account_manager";

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
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-admin-title">
            <Users className="w-6 h-6 text-blue-600" />
            User Management
          </h1>
          <p className="text-muted-foreground mt-1">{users.length} users</p>
        </div>
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

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-4">
          {users.map(u => {
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
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={ROLE_COLORS[u.role]} data-testid={`badge-user-role-${u.id}`}>
                      {ROLE_LABELS[u.role] || u.role}
                    </Badge>
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
                        onClick={() => deleteMutation.mutate(u.id)}
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
    </div>
  );
}
