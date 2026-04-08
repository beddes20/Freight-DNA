/**
 * Admin — Carriers
 *
 * Manage the carrier rolodex for lane-carrier outreach.
 * Supports:
 *   - Browse / search carrier list
 *   - Add single carrier via form
 *   - Bulk seed from Excel upload
 *   - Edit / delete carriers
 *   - Run recurring lane engine + scoring
 *   - Toggle lane_carrier_outreach_v1 feature flag
 */

import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Upload,
  RefreshCw,
  Truck,
  ToggleLeft,
  ToggleRight,
  Search,
  MapPin,
  Mail,
  ChevronRight,
} from "lucide-react";

interface Carrier {
  id: string;
  name: string;
  mcDot: string | null;
  regions: string[];
  equipmentTypes: string[];
  tags: string[];
  primaryEmail: string | null;
  backupEmail: string | null;
  notes: string | null;
}

interface CarrierFormData {
  name: string;
  mcDot: string;
  primaryEmail: string;
  backupEmail: string;
  regions: string;
  equipmentTypes: string;
  tags: string;
  notes: string;
}

const EMPTY_FORM: CarrierFormData = {
  name: "", mcDot: "", primaryEmail: "", backupEmail: "",
  regions: "", equipmentTypes: "", tags: "", notes: "",
};

function carrierToForm(c: Carrier): CarrierFormData {
  return {
    name: c.name,
    mcDot: c.mcDot ?? "",
    primaryEmail: c.primaryEmail ?? "",
    backupEmail: c.backupEmail ?? "",
    regions: (c.regions ?? []).join(", "),
    equipmentTypes: (c.equipmentTypes ?? []).join(", "),
    tags: (c.tags ?? []).join(", "),
    notes: c.notes ?? "",
  };
}

function formToPayload(f: CarrierFormData) {
  return {
    name: f.name.trim(),
    mcDot: f.mcDot.trim() || null,
    primaryEmail: f.primaryEmail.trim() || null,
    backupEmail: f.backupEmail.trim() || null,
    regions: f.regions.split(",").map(s => s.trim()).filter(Boolean),
    equipmentTypes: f.equipmentTypes.split(",").map(s => s.trim()).filter(Boolean),
    tags: f.tags.split(",").map(s => s.trim()).filter(Boolean),
    notes: f.notes.trim() || null,
  };
}

const ADMIN_ROLES = ["admin", "director"];

export default function AdminCarriers() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editTarget, setEditTarget] = useState<Carrier | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Carrier | null>(null);
  const [form, setForm] = useState<CarrierFormData>(EMPTY_FORM);

  // ── Data ──────────────────────────────────────────────────────────────────

  // Only enable queries once the user is resolved AND confirmed admin/director
  const isAdmin = !!user && ADMIN_ROLES.includes(user.role);

  const { data: carriers = [], isLoading } = useQuery<Carrier[]>({
    queryKey: ["/api/carriers"],
    enabled: isAdmin,
  });

  const { data: flagData } = useQuery<{ key: string; enabled: boolean }>({
    queryKey: ["/api/feature-flags/lane_carrier_outreach_v1"],
    enabled: isAdmin,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (data: ReturnType<typeof formToPayload>) =>
      apiRequest("POST", "/api/carriers", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] });
      setShowAddDialog(false);
      setForm(EMPTY_FORM);
      toast({ title: "Carrier added" });
    },
    onError: () => toast({ title: "Failed to add carrier", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ReturnType<typeof formToPayload> }) =>
      apiRequest("PATCH", `/api/carriers/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] });
      setEditTarget(null);
      toast({ title: "Carrier updated" });
    },
    onError: () => toast({ title: "Failed to update carrier", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/carriers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] });
      setDeleteTarget(null);
      toast({ title: "Carrier deleted" });
    },
    onError: () => toast({ title: "Failed to delete carrier", variant: "destructive" }),
  });

  const seedMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/carriers/seed-from-excel", { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Seed failed (${res.status})`);
      }
      return res.json() as Promise<{ seeded: number; skipped: number; total: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] });
      toast({ title: `Seeded ${data.seeded} carriers (${data.skipped} skipped)` });
    },
    onError: (err: Error) => toast({ title: "Seed failed", description: err.message, variant: "destructive" }),
  });

  const engineMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/recurring-lanes/run-engine", {}).then(r => r.json()) as Promise<{ upserted: number; message: string }>,
    onSuccess: (data) => {
      toast({ title: `Engine complete — ${data.upserted} lanes processed`, description: data.message });
    },
    onError: () => toast({ title: "Engine run failed", variant: "destructive" }),
  });

  const flagMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("PATCH", "/api/feature-flags/lane_carrier_outreach_v1", { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feature-flags/lane_carrier_outreach_v1"] });
    },
    onError: () => toast({ title: "Failed to toggle flag", variant: "destructive" }),
  });

  // Role guard — after all hooks
  if (user && !ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 py-24 text-center">
        <p className="text-muted-foreground text-sm">You don&apos;t have permission to access this page.</p>
      </div>
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const filtered = carriers.filter(c =>
    !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.mcDot ?? "").includes(search) ||
    (c.primaryEmail ?? "").toLowerCase().includes(search.toLowerCase())
  );

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) seedMutation.mutate(file);
    e.target.value = "";
  }

  function openEdit(c: Carrier) {
    setEditTarget(c);
    setForm(carrierToForm(c));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const flagEnabled = flagData?.enabled ?? false;

  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))] p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center">
            <Truck className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Carrier Catalog</h1>
            <p className="text-xs text-muted-foreground">Manage your carrier rolodex for lane capacity outreach</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Feature flag toggle */}
          <div className="flex items-center gap-2 border border-white/10 rounded-lg px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Outreach Feature</span>
            <button
              onClick={() => flagMutation.mutate(!flagEnabled)}
              disabled={flagMutation.isPending}
              className={`transition-colors ${flagEnabled ? "text-emerald-400" : "text-white/30"}`}
              data-testid="feature-flag-toggle"
            >
              {flagEnabled
                ? <ToggleRight className="w-5 h-5" />
                : <ToggleLeft className="w-5 h-5" />}
            </button>
          </div>

          {/* Run engine */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => engineMutation.mutate()}
            disabled={engineMutation.isPending}
            className="text-xs"
            data-testid="btn-run-engine"
          >
            {engineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Run Lane Engine
          </Button>

          {/* Excel seed */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleFileChange}
            data-testid="file-input-seed"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={seedMutation.isPending}
            className="text-xs"
            data-testid="btn-seed-excel"
          >
            {seedMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
            Seed from Excel
          </Button>

          {/* Add carrier */}
          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                onClick={() => setForm(EMPTY_FORM)}
                className="text-xs bg-amber-500 hover:bg-amber-400 text-black"
                data-testid="btn-add-carrier"
              >
                <Plus className="w-3 h-3 mr-1" />
                Add Carrier
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-slate-900 border-white/10 text-white">
              <DialogHeader>
                <DialogTitle className="text-sm">Add Carrier</DialogTitle>
              </DialogHeader>
              <CarrierForm
                form={form}
                onChange={setForm}
                onSubmit={() => createMutation.mutate(formToPayload(form))}
                isPending={createMutation.isPending}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Search carriers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 text-sm h-9"
          data-testid="input-search-carriers"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading carriers…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          {search ? "No carriers match your search" : "No carriers yet — add one or seed from Excel"}
        </div>
      ) : (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/4 border-b border-white/8">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Carrier</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Regions</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Equipment</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Email</th>
                <th className="px-4 py-2.5 w-20" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b border-white/4 hover:bg-white/2 transition-colors" data-testid={`carrier-row-${c.id}`}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{c.name}</div>
                    {c.mcDot && <div className="text-[10px] text-muted-foreground">MC/DOT: {c.mcDot}</div>}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(c.regions ?? []).slice(0, 3).map(r => (
                        <Badge key={r} variant="outline" className="text-[9px] py-0 px-1 border-white/15 text-white/50">{r}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(c.equipmentTypes ?? []).slice(0, 2).map(e => (
                        <Badge key={e} variant="outline" className="text-[9px] py-0 px-1 border-amber-500/25 text-amber-300/70">{e}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                    {c.primaryEmail ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => openEdit(c)}
                        className="p-1.5 rounded hover:bg-white/8 text-muted-foreground hover:text-white transition-colors"
                        data-testid={`btn-edit-carrier-${c.id}`}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(c)}
                        className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                        data-testid={`btn-delete-carrier-${c.id}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Stats footer */}
      {carriers.length > 0 && (
        <p className="text-xs text-muted-foreground mt-3">
          {filtered.length} of {carriers.length} carrier{carriers.length !== 1 ? "s" : ""}
          {search && ` matching "${search}"`}
        </p>
      )}

      {/* Edit Dialog */}
      {editTarget && (
        <Dialog open={!!editTarget} onOpenChange={v => { if (!v) setEditTarget(null); }}>
          <DialogContent className="bg-slate-900 border-white/10 text-white">
            <DialogHeader>
              <DialogTitle className="text-sm">Edit Carrier</DialogTitle>
            </DialogHeader>
            <CarrierForm
              form={form}
              onChange={setForm}
              onSubmit={() => updateMutation.mutate({ id: editTarget.id, data: formToPayload(form) })}
              isPending={updateMutation.isPending}
              submitLabel="Save Changes"
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <AlertDialog open onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
          <AlertDialogContent className="bg-slate-900 border-white/10 text-white">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-sm">Delete Carrier</AlertDialogTitle>
              <AlertDialogDescription className="text-xs text-muted-foreground">
                Remove <strong>{deleteTarget.name}</strong> from the carrier catalog? This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-8 text-xs" onClick={() => setDeleteTarget(null)}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
                className="h-8 text-xs bg-red-500 hover:bg-red-400"
                disabled={deleteMutation.isPending}
                data-testid="btn-confirm-delete-carrier"
              >
                {deleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

// ── Carrier Form ─────────────────────────────────────────────────────────────

function CarrierForm({
  form,
  onChange,
  onSubmit,
  isPending,
  submitLabel = "Add Carrier",
}: {
  form: CarrierFormData;
  onChange: (f: CarrierFormData) => void;
  onSubmit: () => void;
  isPending: boolean;
  submitLabel?: string;
}) {
  function field(key: keyof CarrierFormData) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({ ...form, [key]: e.target.value });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Carrier Name *</Label>
          <Input value={form.name} onChange={field("name")} placeholder="ACME Trucking" className="h-8 text-xs mt-1" data-testid="input-carrier-name" />
        </div>
        <div>
          <Label className="text-xs">MC/DOT</Label>
          <Input value={form.mcDot} onChange={field("mcDot")} placeholder="MC-123456" className="h-8 text-xs mt-1" data-testid="input-carrier-mc" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Primary Email</Label>
          <Input value={form.primaryEmail} onChange={field("primaryEmail")} placeholder="dispatch@acme.com" className="h-8 text-xs mt-1" data-testid="input-carrier-email" />
        </div>
        <div>
          <Label className="text-xs">Backup Email</Label>
          <Input value={form.backupEmail} onChange={field("backupEmail")} placeholder="backup@acme.com" className="h-8 text-xs mt-1" />
        </div>
      </div>
      <div>
        <Label className="text-xs">Regions <span className="text-white/30">(comma-separated)</span></Label>
        <Input value={form.regions} onChange={field("regions")} placeholder="TX, LA, MS, OK" className="h-8 text-xs mt-1" data-testid="input-carrier-regions" />
      </div>
      <div>
        <Label className="text-xs">Equipment Types <span className="text-white/30">(comma-separated)</span></Label>
        <Input value={form.equipmentTypes} onChange={field("equipmentTypes")} placeholder="Dry Van, Flatbed, Reefer" className="h-8 text-xs mt-1" data-testid="input-carrier-equipment" />
      </div>
      <div>
        <Label className="text-xs">Tags <span className="text-white/30">(comma-separated)</span></Label>
        <Input value={form.tags} onChange={field("tags")} placeholder="preferred, hazmat" className="h-8 text-xs mt-1" />
      </div>
      <div>
        <Label className="text-xs">Notes</Label>
        <Textarea value={form.notes} onChange={field("notes")} placeholder="Any context about this carrier…" className="text-xs mt-1 resize-none min-h-[60px]" />
      </div>
      <Button
        onClick={onSubmit}
        disabled={!form.name.trim() || isPending}
        className="bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs h-8"
        data-testid="btn-submit-carrier-form"
      >
        {isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
        {submitLabel}
      </Button>
    </div>
  );
}
