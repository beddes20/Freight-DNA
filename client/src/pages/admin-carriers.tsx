/**
 * Admin — Carriers
 *
 * Manages the carrier rolodex for lane-carrier outreach.
 * Supports financial file import (creates carriers by Payee code),
 * rolodex import (enriches carriers with MC#, phone, email, city/state),
 * and legacy directory import (name-based, one row per carrier).
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
import { Checkbox } from "@/components/ui/checkbox";
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
  Phone,
  Mail,
  MapPin,
} from "lucide-react";

interface Carrier {
  id: string;
  name: string;
  payeeCode: string | null;
  mcDot: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  regions: string[];
  equipmentTypes: string[];
  tags: string[];
  primaryEmail: string | null;
  backupEmail: string | null;
  notes: string | null;
}

interface CarrierFormData {
  name: string;
  payeeCode: string;
  mcDot: string;
  phone: string;
  city: string;
  state: string;
  primaryEmail: string;
  backupEmail: string;
  regions: string;
  equipmentTypes: string;
  tags: string;
  notes: string;
}

const EMPTY_FORM: CarrierFormData = {
  name: "", payeeCode: "", mcDot: "", phone: "", city: "", state: "",
  primaryEmail: "", backupEmail: "", regions: "", equipmentTypes: "", tags: "", notes: "",
};

function carrierToForm(c: Carrier): CarrierFormData {
  return {
    name: c.name,
    payeeCode: c.payeeCode ?? "",
    mcDot: c.mcDot ?? "",
    phone: c.phone ?? "",
    city: c.city ?? "",
    state: c.state ?? "",
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
    payeeCode: f.payeeCode.trim() || null,
    mcDot: f.mcDot.trim() || null,
    phone: f.phone.trim() || null,
    city: f.city.trim() || null,
    state: f.state.trim() || null,
    primaryEmail: f.primaryEmail.trim() || null,
    backupEmail: f.backupEmail.trim() || null,
    regions: f.regions.split(",").map(s => s.trim()).filter(Boolean),
    equipmentTypes: f.equipmentTypes.split(",").map(s => s.trim()).filter(Boolean),
    tags: f.tags.split(",").map(s => s.trim()).filter(Boolean),
    notes: f.notes.trim() || null,
  };
}

const ADMIN_ROLES = ["admin", "director"];

// ── Seed response types ───────────────────────────────────────────────────────

interface SeedResponseFinancial {
  mode: "financial";
  total: number;
  blankRowsSkipped: number;
  uniqueCarriers: number;
  created: number;
  alreadyExisted: number;
}

interface SeedResponseRolodex {
  mode: "rolodex";
  total: number;
  blankRowsSkipped: number;
  created: number;
  matchedPayee: number;
  matchedMc: number;
  matchedName: number;
  upToDate: number;
  conflicts: string[];
  recurringLaneCarriers: number;
  recurringEnrichedWithContact: number;
  recurringMissingContact: number;
}

interface SeedResponseDirectory {
  mode: "directory";
  total: number;
  created: number;
  skipped: number;
}

type SeedResponse = SeedResponseFinancial | SeedResponseRolodex | SeedResponseDirectory | { mode: "empty"; total: number };

function seedToast(data: SeedResponse): { title: string; description: string } {
  if (data.mode === "financial") {
    return {
      title: `${data.created} carrier${data.created !== 1 ? "s" : ""} created from freight file`,
      description: `Scanned ${data.total.toLocaleString()} load rows → ${data.uniqueCarriers} unique Payee codes found. ${data.alreadyExisted} already in catalog. Upload your carrier rolodex next to enrich these with MC#, phone, and email.`,
    };
  }
  if (data.mode === "rolodex") {
    const enriched = data.matchedPayee + data.matchedMc + data.matchedName;
    const conflictNote = data.conflicts.length > 0 ? ` · ${data.conflicts.length} MC# conflict${data.conflicts.length !== 1 ? "s" : ""} logged.` : "";
    return {
      title: `Rolodex import complete — ${enriched} enriched, ${data.created} new`,
      description: `Matched by Payee: ${data.matchedPayee} · MC#: ${data.matchedMc} · Name: ${data.matchedName} · Already up-to-date: ${data.upToDate}${conflictNote}  Freight-file carriers: ${data.recurringEnrichedWithContact} have contact info, ${data.recurringMissingContact} still missing phone/email.`,
    };
  }
  if (data.mode === "directory") {
    return {
      title: `${data.created} carrier${data.created !== 1 ? "s" : ""} imported`,
      description: `${data.skipped} duplicate${data.skipped !== 1 ? "s" : ""} skipped out of ${data.total.toLocaleString()} rows.`,
    };
  }
  return { title: "File was empty", description: "No rows found in the uploaded file." };
}

export default function AdminCarriers() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editTarget, setEditTarget] = useState<Carrier | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Carrier | null>(null);
  const [form, setForm] = useState<CarrierFormData>(EMPTY_FORM);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);

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
    mutationFn: (data: ReturnType<typeof formToPayload>) => apiRequest("POST", "/api/carriers", data),
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

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      apiRequest("DELETE", "/api/carriers", { ids }).then(r => r.json()) as Promise<{ deleted: number }>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] });
      setSelected(new Set());
      setShowBulkConfirm(false);
      toast({ title: `${data.deleted} carrier${data.deleted !== 1 ? "s" : ""} deleted` });
    },
    onError: () => toast({ title: "Bulk delete failed", variant: "destructive" }),
  });

  const seedMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/carriers/seed-from-excel", { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Import failed (${res.status})`);
      }
      return res.json() as Promise<SeedResponse>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/carriers"] });
      const { title, description } = seedToast(data);
      toast({ title, description });
    },
    onError: (err: Error) => toast({ title: "Import failed", description: err.message, variant: "destructive" }),
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

  if (user && !ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 py-24 text-center">
        <p className="text-muted-foreground text-sm">You don&apos;t have permission to access this page.</p>
      </div>
    );
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const filtered = carriers.filter(c =>
    !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.payeeCode ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (c.mcDot ?? "").includes(search) ||
    (c.primaryEmail ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (c.phone ?? "").includes(search)
  );

  const allFilteredSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id));
  const someFilteredSelected = filtered.some(c => selected.has(c.id));

  function toggleAll() {
    if (allFilteredSelected) {
      setSelected(prev => { const n = new Set(prev); filtered.forEach(c => n.delete(c.id)); return n; });
    } else {
      setSelected(prev => { const n = new Set(prev); filtered.forEach(c => n.add(c.id)); return n; });
    }
  }

  function toggleOne(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) seedMutation.mutate(file);
    e.target.value = "";
  }

  function openEdit(c: Carrier) { setEditTarget(c); setForm(carrierToForm(c)); }

  const flagEnabled = flagData?.enabled ?? false;
  const selectedCount = selected.size;

  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))] p-6">

      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center">
            <Truck className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Carrier Catalog</h1>
            <p className="text-xs text-muted-foreground">
              Upload your <strong>freight file</strong> first to discover carriers, then upload your <strong>carrier rolodex</strong> to enrich them with MC#, phone, and email.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Feature flag toggle */}
          <div className="flex items-center gap-2 border border-border rounded-lg px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Outreach Feature</span>
            <button
              onClick={() => flagMutation.mutate(!flagEnabled)}
              disabled={flagMutation.isPending}
              className={`transition-colors ${flagEnabled ? "text-emerald-500" : "text-muted-foreground/40"}`}
              data-testid="feature-flag-toggle"
            >
              {flagEnabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
            </button>
          </div>

          <Button variant="outline" size="sm" onClick={() => engineMutation.mutate()} disabled={engineMutation.isPending} className="text-xs" data-testid="btn-run-engine">
            {engineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
            Run Lane Engine
          </Button>

          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileChange} data-testid="file-input-seed" />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={seedMutation.isPending} className="text-xs" data-testid="btn-seed-excel">
            {seedMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
            Import File
          </Button>

          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={() => setForm(EMPTY_FORM)} className="text-xs bg-amber-500 hover:bg-amber-400 text-black" data-testid="btn-add-carrier">
                <Plus className="w-3 h-3 mr-1" />Add Carrier
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle className="text-sm">Add Carrier</DialogTitle></DialogHeader>
              <CarrierForm form={form} onChange={setForm} onSubmit={() => createMutation.mutate(formToPayload(form))} isPending={createMutation.isPending} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Search + bulk bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input placeholder="Search carriers…" value={search} onChange={e => setSearch(e.target.value)} className="pl-8 text-sm h-9" data-testid="input-search-carriers" />
        </div>

        {selectedCount > 0 && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-1.5">
            <span className="text-xs text-red-600 font-medium">
              {selectedCount} selected
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowBulkConfirm(true)}
              disabled={bulkDeleteMutation.isPending}
              className="h-6 px-2 text-xs text-red-500 hover:text-red-600 hover:bg-red-500/10"
              data-testid="btn-bulk-delete"
            >
              {bulkDeleteMutation.isPending
                ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                : <Trash2 className="w-3 h-3 mr-1" />}
              Delete Selected
            </Button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              data-testid="btn-clear-selection"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8"><Loader2 className="w-4 h-4 animate-spin" />Loading carriers…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          {search ? "No carriers match your search" : "No carriers yet — import your freight file or add one manually"}
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted border-b border-border">
              <tr>
                <th className="px-4 py-2.5 w-8">
                  <Checkbox
                    checked={allFilteredSelected}
                    onCheckedChange={toggleAll}
                    className="border-border"
                    data-testid="checkbox-select-all"
                    aria-label="Select all"
                    ref={(el) => {
                      if (el) (el as HTMLButtonElement).dataset.indeterminate = String(someFilteredSelected && !allFilteredSelected);
                    }}
                  />
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Carrier</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Contact</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Location</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Equipment</th>
                <th className="px-4 py-2.5 w-20" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const isChecked = selected.has(c.id);
                const hasContact = c.primaryEmail || c.phone;
                return (
                  <tr key={c.id} className={`border-b border-border transition-colors ${isChecked ? "bg-amber-500/5" : "hover:bg-muted/50"}`} data-testid={`carrier-row-${c.id}`}>
                    <td className="px-4 py-3">
                      <Checkbox checked={isChecked} onCheckedChange={() => toggleOne(c.id)} className="border-border" data-testid={`checkbox-carrier-${c.id}`} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{c.name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {c.payeeCode && <span className="text-[10px] text-amber-400/70">Payee: {c.payeeCode}</span>}
                        {c.mcDot && <span className="text-[10px] text-muted-foreground">MC: {c.mcDot}</span>}
                        {!hasContact && <span className="text-[10px] text-red-400/70">No contact</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <div className="flex flex-col gap-0.5">
                        {c.primaryEmail && (
                          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Mail className="w-2.5 h-2.5 shrink-0" />{c.primaryEmail}
                          </div>
                        )}
                        {c.phone && (
                          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Phone className="w-2.5 h-2.5 shrink-0" />{c.phone}
                          </div>
                        )}
                        {!c.primaryEmail && !c.phone && <span className="text-[10px] text-muted-foreground/40">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {(c.city || c.state) ? (
                        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <MapPin className="w-2.5 h-2.5 shrink-0" />
                          {[c.city, c.state].filter(Boolean).join(", ")}
                        </div>
                      ) : <span className="text-[10px] text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(c.equipmentTypes ?? []).slice(0, 2).map(e => (
                          <Badge key={e} variant="outline" className="text-[9px] py-0 px-1 border-amber-500/40 text-amber-700 dark:text-amber-400">{e}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => openEdit(c)}
                          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          data-testid={`btn-edit-carrier-${c.id}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button onClick={() => setDeleteTarget(c)} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors" data-testid={`btn-delete-carrier-${c.id}`}>
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Stats footer */}
      {carriers.length > 0 && (
        <p className="text-xs text-muted-foreground mt-3">
          {filtered.length} of {carriers.length} carrier{carriers.length !== 1 ? "s" : ""}
          {search && ` matching "${search}"`}
          {selectedCount > 0 && ` · ${selectedCount} selected`}
        </p>
      )}

      {/* Edit Dialog */}
      {editTarget && (
        <Dialog open={!!editTarget} onOpenChange={v => { if (!v) setEditTarget(null); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle className="text-sm">Edit Carrier</DialogTitle></DialogHeader>
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

      {/* Single delete confirmation */}
      {deleteTarget && (
        <AlertDialog open onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-sm">Delete Carrier</AlertDialogTitle>
              <AlertDialogDescription className="text-xs text-muted-foreground">
                Remove <strong>{deleteTarget.name}</strong> from the catalog? This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-8 text-xs" onClick={() => setDeleteTarget(null)}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate(deleteTarget.id)} className="h-8 text-xs bg-red-500 hover:bg-red-400" disabled={deleteMutation.isPending} data-testid="btn-confirm-delete-carrier">
                {deleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Bulk delete confirmation */}
      <AlertDialog open={showBulkConfirm} onOpenChange={v => { if (!v) setShowBulkConfirm(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete {selectedCount} Carrier{selectedCount !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              Permanently removes {selectedCount} carrier{selectedCount !== 1 ? "s" : ""} and any linked outreach history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs" onClick={() => setShowBulkConfirm(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => bulkDeleteMutation.mutate(Array.from(selected))} className="h-8 text-xs bg-red-500 hover:bg-red-400" disabled={bulkDeleteMutation.isPending} data-testid="btn-confirm-bulk-delete">
              {bulkDeleteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : `Delete ${selectedCount}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Carrier Form ──────────────────────────────────────────────────────────────

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
    <div className="flex flex-col gap-3 max-h-[70vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Carrier Name *</Label>
          <Input value={form.name} onChange={field("name")} placeholder="ACME Trucking" className="h-8 text-xs mt-1" data-testid="input-carrier-name" />
        </div>
        <div>
          <Label className="text-xs">Payee Code</Label>
          <Input value={form.payeeCode} onChange={field("payeeCode")} placeholder="ACME01" className="h-8 text-xs mt-1" data-testid="input-carrier-payee" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">MC/DOT</Label>
          <Input value={form.mcDot} onChange={field("mcDot")} placeholder="MC-123456" className="h-8 text-xs mt-1" data-testid="input-carrier-mc" />
        </div>
        <div>
          <Label className="text-xs">Phone</Label>
          <Input value={form.phone} onChange={field("phone")} placeholder="555-123-4567" className="h-8 text-xs mt-1" data-testid="input-carrier-phone" />
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
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">City</Label>
          <Input value={form.city} onChange={field("city")} placeholder="Dallas" className="h-8 text-xs mt-1" data-testid="input-carrier-city" />
        </div>
        <div>
          <Label className="text-xs">State</Label>
          <Input value={form.state} onChange={field("state")} placeholder="TX" className="h-8 text-xs mt-1" data-testid="input-carrier-state" />
        </div>
      </div>
      <div>
        <Label className="text-xs">Regions <span className="text-muted-foreground">(comma-separated)</span></Label>
        <Input value={form.regions} onChange={field("regions")} placeholder="TX, LA, MS, OK" className="h-8 text-xs mt-1" data-testid="input-carrier-regions" />
      </div>
      <div>
        <Label className="text-xs">Equipment Types <span className="text-muted-foreground">(comma-separated)</span></Label>
        <Input value={form.equipmentTypes} onChange={field("equipmentTypes")} placeholder="Dry Van, Flatbed, Reefer" className="h-8 text-xs mt-1" data-testid="input-carrier-equipment" />
      </div>
      <div>
        <Label className="text-xs">Tags <span className="text-muted-foreground">(comma-separated)</span></Label>
        <Input value={form.tags} onChange={field("tags")} placeholder="preferred, hazmat" className="h-8 text-xs mt-1" />
      </div>
      <div>
        <Label className="text-xs">Notes</Label>
        <Textarea value={form.notes} onChange={field("notes")} placeholder="Any context about this carrier…" className="text-xs mt-1 resize-none min-h-[60px]" />
      </div>
      <Button onClick={onSubmit} disabled={!form.name.trim() || isPending} className="bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs h-8" data-testid="btn-submit-carrier-form">
        {isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
        {submitLabel}
      </Button>
    </div>
  );
}
