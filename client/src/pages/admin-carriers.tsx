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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Filter,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  Send,
  BellOff,
} from "lucide-react";
import { InfoTooltip } from "@/components/info-tooltip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const LWQ_SOURCES = ["dat", "loadsmart", "csv_paste", "manual", "other"];
const LWQ_SOURCE_LABELS: Record<string, string> = {
  dat: "DAT Load Board",
  loadsmart: "Loadsmart",
  csv_paste: "CSV Paste",
  manual: "Manual Entry",
  other: "Other Platform",
};

function getSourceInfo(channel: string | null): { label: string; category: "lwq" | "catalog" | "engine" | "no_source" } {
  if (!channel) return { label: "Manual Add", category: "no_source" };
  if (LWQ_SOURCES.includes(channel)) return { label: `Lane Upload · ${LWQ_SOURCE_LABELS[channel] ?? channel}`, category: "lwq" };
  if (["excel_seed", "import_paste", "import_csv"].includes(channel)) return { label: "Catalog Import", category: "catalog" };
  if (channel === "engine") return { label: "Engine Discovery", category: "engine" };
  return { label: channel, category: "no_source" };
}

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
  sourceChannel: string | null;
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
  const [sourceFilter, setSourceFilter] = useState<"__all__" | "lwq" | "catalog" | "engine" | "no_source">("__all__");
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

  const { data: emailFlagData } = useQuery<{ key: string; enabled: boolean }>({
    queryKey: ["/api/feature-flags/email_live_mode"],
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
        const b = body as { error?: string; message?: string; details?: string };
        const msg = b.error ?? b.message ?? `Import failed (${res.status})`;
        const detail = b.details ? `: ${b.details}` : "";
        throw new Error(`${msg}${detail}`);
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

  const emailFlagMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("PATCH", "/api/feature-flags/email_live_mode", { enabled }),
    onSuccess: (_, enabled) => {
      queryClient.invalidateQueries({ queryKey: ["/api/feature-flags/email_live_mode"] });
      toast({
        title: enabled ? "Email Sending LIVE" : "Email Sending SUPPRESSED",
        description: enabled
          ? "Outbound emails will now reach recipients."
          : "All outbound emails are now blocked — safe to develop.",
      });
    },
    onError: () => toast({ title: "Failed to update email setting", variant: "destructive" }),
  });

  if (user && !ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 py-24 text-center">
        <p className="text-muted-foreground text-sm">You don&apos;t have permission to access this page.</p>
      </div>
    );
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const filtered = carriers.filter(c => {
    if (search) {
      const q = search.toLowerCase();
      const matchesText = c.name.toLowerCase().includes(q) ||
        (c.payeeCode ?? "").toLowerCase().includes(q) ||
        (c.mcDot ?? "").includes(q) ||
        (c.primaryEmail ?? "").toLowerCase().includes(q) ||
        (c.phone ?? "").includes(q);
      if (!matchesText) return false;
    }
    if (sourceFilter !== "__all__") {
      const { category } = getSourceInfo(c.sourceChannel);
      if (category !== sourceFilter) return false;
    }
    return true;
  });

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
  const emailLiveMode = emailFlagData?.enabled ?? false;
  const selectedCount = selected.size;

  return (
    <div className="min-h-screen bg-background text-foreground p-6">

      {/* ── Email Sending Control Banner ── */}
      <div className={`rounded-xl border-2 p-4 mb-6 flex items-start justify-between gap-4 flex-wrap transition-colors ${
        emailLiveMode
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-amber-500/50 bg-amber-500/10"
      }`}>
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
            emailLiveMode ? "bg-emerald-500/15" : "bg-amber-500/15"
          }`}>
            {emailLiveMode
              ? <Send className="w-5 h-5 text-emerald-400" />
              : <BellOff className="w-5 h-5 text-amber-400" />
            }
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-sm font-bold ${emailLiveMode ? "text-emerald-400" : "text-amber-400"}`}>
                Email Sending — {emailLiveMode ? "LIVE" : "SUPPRESSED"}
              </span>
              {emailLiveMode
                ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                : <AlertTriangle className="w-4 h-4 text-amber-400" />
              }
              <InfoTooltip
                title="Email Sending Control"
                text="This is a master kill switch for all outbound emails from the system."
                items={[
                  "SUPPRESSED (default) — every email call is blocked and logged. No emails reach anyone — carriers, reps, or scheduled digests.",
                  "LIVE — all outbound emails are dispatched normally, including carrier outreach, weekly reports, RFP reminders, and 1:1 recaps.",
                  "This setting persists across server restarts. Always suppress before developing new email features.",
                ]}
                side="right"
                wide
              />
            </div>
            <p className="text-xs text-muted-foreground max-w-xl">
              {emailLiveMode
                ? "Outbound emails are active. Carrier outreach, automated reports, and all scheduled digests are reaching recipients."
                : "All outbound emails are blocked — safe for development and testing. No emails are reaching anyone right now."
              }
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant={emailLiveMode ? "outline" : "default"}
          className={`shrink-0 ${emailLiveMode
            ? "border-destructive/50 text-destructive hover:bg-destructive/10 text-xs"
            : "bg-emerald-600 hover:bg-emerald-500 text-white text-xs"
          }`}
          onClick={() => emailFlagMutation.mutate(!emailLiveMode)}
          disabled={emailFlagMutation.isPending}
          data-testid="btn-email-live-mode-toggle"
        >
          {emailFlagMutation.isPending
            ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
            : emailLiveMode
              ? <BellOff className="w-3 h-3 mr-1.5" />
              : <Send className="w-3 h-3 mr-1.5" />
          }
          {emailLiveMode ? "Suppress Email Sending" : "Enable Live Email Sending"}
        </Button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center">
            <Truck className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Carrier Catalog</h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              The master list of carriers available for lane outreach and procurement.
              <InfoTooltip
                title="How the Carrier Catalog works"
                items={[
                  "Upload your TMS/freight file to auto-discover carriers by payee code.",
                  "Upload a carrier rolodex to enrich them with MC#, phone, email, and city/state.",
                  "The HQ location (city/state) powers the proximity ranking — carriers based near a lane's origin or destination rank higher.",
                  "Carriers must have an email or phone to receive outreach.",
                ]}
                side="bottom"
                wide
              />
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Feature flag toggle */}
          <div className="flex items-center gap-2 border border-border rounded-lg px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Outreach Feature</span>
            <InfoTooltip
              title="Lane Carrier Outreach"
              text="When enabled, reps can open the Outreach Panel on any recurring lane to select and contact carriers directly from the Lane Work Queue."
              items={[
                "The system ranks carriers by TMS load history, equipment match, geographic proximity, and prior outreach outcomes.",
                "Reps draft AI-assisted lane-building emails and send or log them in one step.",
                "Contacted carriers move to the lane's 'Bench' — a tracked list per lane.",
                "The goal is to secure 3+ committed carriers per lane.",
              ]}
              side="bottom"
              wide
            />
            <button
              onClick={() => flagMutation.mutate(!flagEnabled)}
              disabled={flagMutation.isPending}
              className={`transition-colors ${flagEnabled ? "text-emerald-500" : "text-muted-foreground/40"}`}
              data-testid="feature-flag-toggle"
            >
              {flagEnabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
            </button>
          </div>

          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => engineMutation.mutate()} disabled={engineMutation.isPending} className="text-xs" data-testid="btn-run-engine">
              {engineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              Run Lane Engine
            </Button>
            <InfoTooltip
              title="Lane Capacity Engine"
              text="Scans all recurring lanes and auto-creates any missing Lane Work Queue entries based on freight history."
              items={[
                "Run this after uploading new TMS financial data to keep the LWQ current.",
                "The engine identifies which lanes need carrier procurement and assigns them to reps.",
              ]}
            />
          </div>

          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileChange} data-testid="file-input-seed" />
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={seedMutation.isPending} className="text-xs" data-testid="btn-seed-excel">
              {seedMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
              Import File
            </Button>
            <InfoTooltip
              title="Import Carriers from File"
              text="Upload an Excel or CSV file. The system auto-detects the format:"
              items={[
                "TMS / Financial file — has a Payee Code column + load-level data. Creates one carrier per unique payee code.",
                "Carrier Rolodex — has Payee Code + MC#, phone, email. Enriches existing carriers with contact info.",
                "Carrier Directory — one row per carrier with name-based deduplication. Captures MC#, email, city/state, equipment type.",
              ]}
              side="bottom"
              wide
            />
          </div>

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
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-muted-foreground" />
          <InfoTooltip
            title="Filter by Source"
            items={[
              "Lane Upload — carrier was brought in via a DAT/Loadsmart import while working a lane.",
              "Catalog Import — added via bulk Excel/CSV upload on this page.",
              "Engine Discovery — auto-surfaced by the lane capacity engine.",
              "Manual Add — added by hand through the Add Carrier form.",
            ]}
          />
          <Select value={sourceFilter} onValueChange={v => setSourceFilter(v as typeof sourceFilter)} data-testid="select-source-filter">
            <SelectTrigger className="h-9 text-xs w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Sources</SelectItem>
              <SelectItem value="lwq">Lane Work Queue Upload</SelectItem>
              <SelectItem value="catalog">Catalog Import</SelectItem>
              <SelectItem value="engine">Engine Discovery</SelectItem>
              <SelectItem value="no_source">Manual Add</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {selectedCount > 0 && (
          <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-1.5">
            <span className="text-xs text-destructive font-medium">
              {selectedCount} selected
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowBulkConfirm(true)}
              disabled={bulkDeleteMutation.isPending}
              className="h-6 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
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
          {search || sourceFilter !== "__all__" ? "No carriers match your filters" : "No carriers yet — import your freight file or add one manually"}
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden bg-card overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
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
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                  <span className="flex items-center gap-1">
                    Carrier
                    <InfoTooltip
                      title="Carrier Identity"
                      items={[
                        "Name — the carrier's trading name as stored in your TMS.",
                        "Payee code — links this carrier to TMS load history and financial data.",
                        "MC# — FMCSA authority number, used for compliance and identity matching.",
                        "Source badge — shows how this carrier was added (TMS upload, catalog import, or engine discovery).",
                      ]}
                      side="bottom"
                      wide
                    />
                  </span>
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">
                  <span className="flex items-center gap-1">
                    Contact
                    <InfoTooltip
                      title="Contact Info"
                      text="Email and phone used for lane outreach. Carriers without either show a 'No contact' warning and cannot receive outreach emails."
                      side="bottom"
                    />
                  </span>
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">
                  <span className="flex items-center gap-1">
                    HQ Location
                    <InfoTooltip
                      title="Carrier Home Base"
                      text="The carrier's headquarters city and state. Used by the proximity ranking engine — carriers based within 75 miles of a lane's origin or destination receive a score boost in the Lane Work Queue."
                      side="bottom"
                      wide
                    />
                  </span>
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">
                  <span className="flex items-center gap-1">
                    Equipment
                    <InfoTooltip
                      title="Equipment Types"
                      text="Trailer types this carrier operates. When a lane specifies equipment (e.g. Dry Van, Reefer, Flatbed), only carriers with a matching type are promoted to the top of the ranked list."
                      side="bottom"
                      wide
                    />
                  </span>
                </th>
                <th className="px-4 py-2.5 w-20" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const isChecked = selected.has(c.id);
                const hasContact = c.primaryEmail || c.phone;
                return (
                  <tr key={c.id} className={`border-b border-border transition-colors bg-card ${isChecked ? "bg-amber-500/10" : "hover:bg-muted/40"}`} data-testid={`carrier-row-${c.id}`}>
                    <td className="px-4 py-3">
                      <Checkbox checked={isChecked} onCheckedChange={() => toggleOne(c.id)} className="border-border" data-testid={`checkbox-carrier-${c.id}`} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{c.name}</div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {c.payeeCode && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 cursor-help">Payee: {c.payeeCode}</span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-[220px]">
                              TMS payee code — links this carrier to all load history in your financial uploads.
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {c.mcDot && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-[10px] text-muted-foreground cursor-help">MC: {c.mcDot}</span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-[220px]">
                              FMCSA Motor Carrier authority number. Used for DOT compliance verification.
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {!hasContact && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-[10px] text-destructive cursor-help">No contact</span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-[240px]">
                              No email or phone on file. This carrier cannot receive outreach until contact info is added. Import a carrier rolodex file with their details to fill in the gap.
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {(() => {
                          const { label, category } = getSourceInfo(c.sourceChannel);
                          if (category === "lwq") return (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="text-[9px] py-0 px-1 border-sky-500/40 text-sky-600 dark:text-sky-400 cursor-help">{label}</Badge>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs max-w-[240px]">
                                Discovered via the Lane Work Queue — a rep imported this carrier from a load board (DAT, Loadsmart, etc.) while working a specific lane.
                              </TooltipContent>
                            </Tooltip>
                          );
                          if (category === "catalog") return (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="text-[9px] py-0 px-1 border-green-500/40 text-green-600 dark:text-green-400 cursor-help">{label}</Badge>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs max-w-[240px]">
                                Added via a bulk Excel/CSV upload through this Carrier Catalog page. Includes carriers from rolodex files, directory imports, and TMS financial data.
                              </TooltipContent>
                            </Tooltip>
                          );
                          if (category === "engine") return (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="text-[9px] py-0 px-1 border-purple-500/40 text-purple-600 dark:text-purple-400 cursor-help">{label}</Badge>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs max-w-[240px]">
                                Surfaced automatically by the lane capacity engine based on regional freight history and equipment match. Not yet in the rolodex.
                              </TooltipContent>
                            </Tooltip>
                          );
                          if (c.sourceChannel) return (
                            <Badge variant="outline" className="text-[9px] py-0 px-1 text-muted-foreground/50">{label}</Badge>
                          );
                          return null;
                        })()}
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
                        <a
                          href={`/carrier-hub?carrierId=${c.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors inline-flex items-center"
                          data-testid={`link-hub-carrier-${c.id}`}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                        <button
                          onClick={() => openEdit(c)}
                          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          data-testid={`btn-edit-carrier-${c.id}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button onClick={() => setDeleteTarget(c)} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors" data-testid={`btn-delete-carrier-${c.id}`}>
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
          {sourceFilter !== "__all__" && ` · filtered by ${sourceFilter === "lwq" ? "Lane Work Queue" : sourceFilter === "catalog" ? "Catalog Import" : sourceFilter === "engine" ? "Engine Discovery" : "Manual Add"}`}
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
