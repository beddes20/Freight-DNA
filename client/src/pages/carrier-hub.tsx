/**
 * Carrier Hub — central carrier intelligence layer.
 * /carrier-hub
 *
 * Left panel: searchable/filterable carrier list
 * Right side: expandable profile drawer with tabs
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Truck, Building2, Phone, Mail, MapPin, Search, Plus, X, ChevronRight,
  AlertTriangle, CheckCircle2, Star, User, Route, Activity, Settings,
  Globe, Loader2, Edit2, Trash2, Shield, History, Zap, ExternalLink,
} from "lucide-react";

// ── Constants ──────────────────────────────────────────────────────────────────

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

const EQUIPMENT_OPTIONS = [
  "Dry Van","Reefer","Flatbed","Step Deck","Power Only","Box Truck","Tanker","Lowboy","Other",
];

const CONTACT_ROLES = [
  { value: "dispatcher", label: "Dispatcher" },
  { value: "after_hours", label: "After Hours / Night Dispatch" },
  { value: "sales", label: "Sales Rep" },
  { value: "billing", label: "Billing / AP" },
  { value: "general", label: "General Contact" },
];

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.FC<{ className?: string }> }> = {
  active:      { label: "Active",      color: "text-green-400 border-green-500/30 bg-green-500/10",  icon: CheckCircle2 },
  inactive:    { label: "Inactive",    color: "text-gray-400 border-gray-500/30 bg-gray-500/10",    icon: X },
  flagged:     { label: "Flagged",     color: "text-amber-400 border-amber-500/30 bg-amber-500/10", icon: AlertTriangle },
  do_not_use:  { label: "Do Not Use", color: "text-red-400 border-red-500/30 bg-red-500/10",       icon: Shield },
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface CarrierRow {
  id: string;
  name: string;
  legal_name: string | null;
  mc_dot: string | null;
  dot_number: string | null;
  status: string;
  equipment_types: string[];
  states_served: string[];
  primary_email: string | null;
  backup_email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  notes: string | null;
  tags: string[];
  source_channel: string | null;
  proven_lane_count: string;
  total_loads: string;
  last_used: string | null;
  outreach_sent: string;
  contact_count: string;
  claimed_lane_count: string;
}

interface CarrierContact {
  id: string;
  carrierId: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  extension: string | null;
  preferredMethod: string | null;
  notes: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

interface CarrierClaimedLane {
  id: string;
  carrierId: string;
  originState: string | null;
  originCity: string | null;
  destState: string | null;
  destCity: string | null;
  equipment: string | null;
  laneType: string;
  notes: string | null;
}

interface ProvenLane {
  id: string;
  lane_id: string;
  carrier_name: string;
  fit_score: number;
  interest_status: string;
  source_type: string;
  updated_at: string;
  origin_city: string | null;
  origin_state: string | null;
  dest_city: string | null;
  dest_state: string | null;
  equipment_type: string | null;
  avg_loads_per_week: string | null;
  weeks_active: number | null;
  company_name: string | null;
  resolved_at: string | null;
}

interface CarrierDetail {
  carrier: {
    id: string; name: string; legalName: string | null; mcDot: string | null; dotNumber: string | null;
    status: string; phone: string | null; city: string | null; state: string | null;
    primaryEmail: string | null; backupEmail: string | null; notes: string | null;
    equipmentTypes: string[]; equipmentNotes: string | null; tags: string[];
    regions: string[]; statesServed: string[]; metroAreas: string[];
    sourceChannel: string | null; createdAt: string; updatedAt: string;
  };
  contacts: CarrierContact[];
  claimedLanes: CarrierClaimedLane[];
  provenHistory: ProvenLane[];
  outreachActivity: any[];
  stats: { provenLaneCount: number; outreachSentCount: number; positiveOutcomes: number; lastUsed: string | null; contactReadiness: string };
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.active;
  const Icon = cfg.icon;
  return (
    <Badge variant="outline" className={`text-[10px] gap-1 py-0 px-1.5 ${cfg.color}`} data-testid={`status-badge-${status}`}>
      <Icon className="w-2.5 h-2.5" />
      {cfg.label}
    </Badge>
  );
}

function ContactReadinessIcon({ email, phone }: { email: string | null; phone: string | null }) {
  if (email && phone) return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" title="Has email + phone" />;
  if (email || phone) return <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" title="Partial contact info" />;
  return <AlertTriangle className="w-3.5 h-3.5 text-red-400" title="No contact info" />;
}

function formatDate(dt: string | null | undefined) {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function laneLabel(l: { origin_city?: string | null; origin_state?: string | null; dest_city?: string | null; dest_state?: string | null; originCity?: string | null; originState?: string | null; destCity?: string | null; destState?: string | null }) {
  const orig = [l.origin_city ?? l.originCity, l.origin_state ?? l.originState].filter(Boolean).join(", ") || "?";
  const dest = [l.dest_city ?? l.destCity, l.dest_state ?? l.destState].filter(Boolean).join(", ") || "?";
  return `${orig} → ${dest}`;
}

// ── Chip selector for arrays ───────────────────────────────────────────────────

function ChipSelector({ label, value, options, onChange }: { label: string; value: string[]; options: string[]; onChange: (v: string[]) => void }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground mb-1.5 block">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => {
          const on = value.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(on ? value.filter(v => v !== opt) : [...value, opt])}
              className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${on ? "bg-amber-500/20 border-amber-500/40 text-amber-300" : "bg-muted/30 border-border text-muted-foreground hover:text-foreground"}`}
              data-testid={`chip-${label.toLowerCase().replace(/\s+/g,"-")}-${opt}`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Add Carrier Dialog ─────────────────────────────────────────────────────────

function AddCarrierDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", mcDot: "", phone: "", primaryEmail: "" });

  const create = useMutation({
    mutationFn: (data: typeof form) => apiRequest("POST", "/api/carrier-hub", data),
    onSuccess: async (res: Response) => {
      const carrier = await res.json();
      qc.invalidateQueries({ queryKey: ["/api/carrier-hub"] });
      toast({ title: "Carrier created" });
      setForm({ name: "", mcDot: "", phone: "", primaryEmail: "" });
      onCreated(carrier.id);
    },
    onError: () => toast({ title: "Failed to create carrier", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Carrier</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div>
            <Label className="text-xs">Carrier Name *</Label>
            <Input data-testid="input-carrier-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Swift Transportation" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">MC / DOT Number</Label>
            <Input data-testid="input-carrier-mc" value={form.mcDot} onChange={e => setForm(f => ({ ...f, mcDot: e.target.value }))} placeholder="MC-123456" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Dispatcher Phone</Label>
            <Input data-testid="input-carrier-phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 000-0000" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Dispatcher Email</Label>
            <Input data-testid="input-carrier-email" value={form.primaryEmail} onChange={e => setForm(f => ({ ...f, primaryEmail: e.target.value }))} placeholder="dispatch@carrier.com" className="mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            data-testid="btn-create-carrier"
            onClick={() => create.mutate(form)}
            disabled={!form.name.trim() || create.isPending}
            className="bg-amber-500 hover:bg-amber-600 text-black"
          >
            {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Add Carrier"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Contact Form ───────────────────────────────────────────────────────────────

function ContactForm({ carrierId, initial, onSave, onCancel }: {
  carrierId: string;
  initial?: Partial<CarrierContact>;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    role: initial?.role ?? "dispatcher",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
    extension: initial?.extension ?? "",
    preferredMethod: initial?.preferredMethod ?? "email",
    notes: initial?.notes ?? "",
    isPrimary: initial?.isPrimary ?? false,
    isActive: initial?.isActive ?? true,
  });

  const isEdit = !!initial?.id;

  const save = useMutation({
    mutationFn: (data: typeof form) =>
      isEdit
        ? apiRequest("PATCH", `/api/carrier-hub/${carrierId}/contacts/${initial!.id}`, data)
        : apiRequest("POST", `/api/carrier-hub/${carrierId}/contacts`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/carrier-hub", carrierId] });
      toast({ title: isEdit ? "Contact updated" : "Contact added" });
      onSave();
    },
    onError: () => toast({ title: "Failed to save contact", variant: "destructive" }),
  });

  return (
    <div className="bg-muted/20 border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Name *</Label>
          <Input data-testid="input-contact-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="John Smith" className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Role</Label>
          <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
            <SelectTrigger className="mt-1 h-8 text-sm" data-testid="select-contact-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_ROLES.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Email</Label>
          <Input data-testid="input-contact-email" value={form.email ?? ""} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="dispatch@co.com" className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Phone</Label>
          <Input data-testid="input-contact-phone" value={form.phone ?? ""} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 000-0000" className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Extension</Label>
          <Input data-testid="input-contact-ext" value={form.extension ?? ""} onChange={e => setForm(f => ({ ...f, extension: e.target.value }))} placeholder="x123" className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Preferred Method</Label>
          <Select value={form.preferredMethod ?? "email"} onValueChange={v => setForm(f => ({ ...f, preferredMethod: v }))}>
            <SelectTrigger className="mt-1 h-8 text-sm" data-testid="select-preferred-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="phone">Phone</SelectItem>
              <SelectItem value="text">Text</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label className="text-xs">Notes</Label>
        <Input value={form.notes ?? ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes..." className="mt-1 h-8 text-sm" />
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <Checkbox checked={form.isPrimary} onCheckedChange={v => setForm(f => ({ ...f, isPrimary: !!v }))} data-testid="checkbox-contact-primary" />
          Primary contact
        </label>
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <Checkbox checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: !!v }))} data-testid="checkbox-contact-active" />
          Active
        </label>
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={() => save.mutate(form)} disabled={!form.name.trim() || save.isPending} className="bg-amber-500 hover:bg-amber-600 text-black" data-testid="btn-save-contact">
          {save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : (isEdit ? "Save" : "Add Contact")}
        </Button>
      </div>
    </div>
  );
}

// ── Claimed Lane Form ──────────────────────────────────────────────────────────

function ClaimedLaneForm({ carrierId, onSave, onCancel }: { carrierId: string; onSave: () => void; onCancel: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ originState: "", originCity: "", destState: "", destCity: "", equipment: "__any__", laneType: "prefer", notes: "" });

  const save = useMutation({
    mutationFn: (data: typeof form) => apiRequest("POST", `/api/carrier-hub/${carrierId}/claimed-lanes`, { ...data, equipment: data.equipment === "__any__" ? "" : data.equipment }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/carrier-hub", carrierId] });
      toast({ title: "Lane preference added" });
      onSave();
    },
    onError: () => toast({ title: "Failed to add lane preference", variant: "destructive" }),
  });

  return (
    <div className="bg-muted/20 border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Origin City</Label>
          <Input data-testid="input-lane-origin-city" value={form.originCity} onChange={e => setForm(f => ({ ...f, originCity: e.target.value }))} placeholder="Chicago" className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Origin State</Label>
          <Select value={form.originState} onValueChange={v => setForm(f => ({ ...f, originState: v }))}>
            <SelectTrigger className="mt-1 h-8 text-sm" data-testid="select-lane-origin-state">
              <SelectValue placeholder="State" />
            </SelectTrigger>
            <SelectContent>
              {US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Dest City</Label>
          <Input data-testid="input-lane-dest-city" value={form.destCity} onChange={e => setForm(f => ({ ...f, destCity: e.target.value }))} placeholder="Dallas" className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Dest State</Label>
          <Select value={form.destState} onValueChange={v => setForm(f => ({ ...f, destState: v }))}>
            <SelectTrigger className="mt-1 h-8 text-sm" data-testid="select-lane-dest-state">
              <SelectValue placeholder="State" />
            </SelectTrigger>
            <SelectContent>
              {US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Equipment</Label>
          <Select value={form.equipment} onValueChange={v => setForm(f => ({ ...f, equipment: v }))}>
            <SelectTrigger className="mt-1 h-8 text-sm" data-testid="select-lane-equipment">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              {EQUIPMENT_OPTIONS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Type</Label>
          <Select value={form.laneType} onValueChange={v => setForm(f => ({ ...f, laneType: v }))}>
            <SelectTrigger className="mt-1 h-8 text-sm" data-testid="select-lane-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prefer">Preferred Lane</SelectItem>
              <SelectItem value="avoid">Lane to Avoid</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label className="text-xs">Notes</Label>
        <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional context..." className="mt-1 h-8 text-sm" />
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={() => save.mutate(form)} disabled={save.isPending} className="bg-amber-500 hover:bg-amber-600 text-black" data-testid="btn-save-claimed-lane">
          {save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Add Lane"}
        </Button>
      </div>
    </div>
  );
}

// ── Carrier Profile Drawer ─────────────────────────────────────────────────────

function CarrierDrawer({ carrierId, onClose }: { carrierId: string; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editingProfile, setEditingProfile] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [addingClaimedLane, setAddingClaimedLane] = useState(false);
  const [profileForm, setProfileForm] = useState<Partial<CarrierDetail["carrier"]>>({});
  const [activeTab, setActiveTab] = useState("overview");

  const { data, isLoading } = useQuery<CarrierDetail>({
    queryKey: ["/api/carrier-hub", carrierId],
    queryFn: () => fetch(`/api/carrier-hub/${carrierId}`).then(r => r.json()),
    enabled: !!carrierId,
  });

  interface BestLane {
    laneId: string;
    origin: string;
    originState: string | null;
    destination: string;
    destinationState: string | null;
    equipmentType: string | null;
    companyName: string | null;
    fitScore: number;
    whyThisLane: string;
    weeklyFrequency: number | null;
    laneScore: number | null;
  }

  const { data: bestLanesData } = useQuery<{ lanes: BestLane[] }>({
    queryKey: ["/api/carrier-hub", carrierId, "best-lanes"],
    queryFn: () => fetch(`/api/carrier-hub/${carrierId}/best-lanes`).then(r => r.json()),
    enabled: !!carrierId && activeTab === "lanes",
  });

  const updateCarrier = useMutation({
    mutationFn: (updates: Partial<CarrierDetail["carrier"]>) =>
      apiRequest("PATCH", `/api/carrier-hub/${carrierId}`, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/carrier-hub"] });
      qc.invalidateQueries({ queryKey: ["/api/carrier-hub", carrierId] });
      toast({ title: "Carrier updated" });
      setEditingProfile(false);
    },
    onError: () => toast({ title: "Failed to update carrier", variant: "destructive" }),
  });

  const deleteContact = useMutation({
    mutationFn: (contactId: string) => apiRequest("DELETE", `/api/carrier-hub/${carrierId}/contacts/${contactId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/carrier-hub", carrierId] }); toast({ title: "Contact removed" }); },
    onError: () => toast({ title: "Failed to remove contact", variant: "destructive" }),
  });

  const deleteClaimedLane = useMutation({
    mutationFn: (laneId: string) => apiRequest("DELETE", `/api/carrier-hub/${carrierId}/claimed-lanes/${laneId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/carrier-hub", carrierId] }); toast({ title: "Lane preference removed" }); },
    onError: () => toast({ title: "Failed to remove lane preference", variant: "destructive" }),
  });

  const carrier = data?.carrier;

  function startEdit() {
    if (!carrier) return;
    setProfileForm({ ...carrier });
    setEditingProfile(true);
  }

  if (isLoading || !carrier) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[carrier.status] ?? STATUS_CONFIG.active;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Drawer header */}
      <div className="px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-foreground truncate">{carrier.name}</h2>
              <StatusBadge status={carrier.status} />
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
              {carrier.mcDot && <span className="font-mono">{carrier.mcDot}</span>}
              {carrier.dotNumber && <span className="font-mono text-muted-foreground/60">DOT: {carrier.dotNumber}</span>}
              {carrier.city && carrier.state && <span><MapPin className="w-3 h-3 inline mr-0.5" />{carrier.city}, {carrier.state}</span>}
              {carrier.sourceChannel && <Badge variant="outline" className="text-[9px] py-0 px-1 text-muted-foreground/60">via {carrier.sourceChannel}</Badge>}
            </div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <Select value={carrier.status} onValueChange={v => updateCarrier.mutate({ status: v })}>
              <SelectTrigger className="h-7 text-xs w-32" data-testid="select-carrier-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="flagged">Flagged</SelectItem>
                <SelectItem value="do_not_use">Do Not Use</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={startEdit} data-testid="btn-edit-carrier-profile">
              <Edit2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-4 gap-2 mt-3">
          {[
            { label: "Proven Lanes", value: data!.stats.provenLaneCount, icon: Route, color: "text-blue-400" },
            { label: "Outreach Sent", value: data!.stats.outreachSentCount, icon: Mail, color: "text-amber-400" },
            { label: "Positive Replies", value: data!.stats.positiveOutcomes, icon: CheckCircle2, color: "text-green-400" },
            { label: "Contacts", value: data!.contacts.length, icon: User, color: "text-purple-400" },
          ].map(s => (
            <div key={s.label} className="bg-muted/30 rounded-lg p-2 text-center">
              <s.icon className={`w-4 h-4 mx-auto mb-1 ${s.color}`} />
              <div className="text-lg font-bold text-foreground leading-none">{s.value}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 overflow-hidden flex flex-col">
        <TabsList className="mx-6 mt-3 shrink-0 h-8 bg-muted/30">
          <TabsTrigger value="overview" className="text-xs h-7" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts" className="text-xs h-7" data-testid="tab-contacts">
            Contacts {data!.contacts.length > 0 && <Badge variant="secondary" className="ml-1 h-4 text-[9px] px-1">{data!.contacts.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="equipment" className="text-xs h-7" data-testid="tab-equipment">Equip & Geo</TabsTrigger>
          <TabsTrigger value="lanes" className="text-xs h-7" data-testid="tab-lanes">
            Lanes <Badge variant="secondary" className="ml-1 h-4 text-[9px] px-1">{data!.claimedLanes.length + data!.provenHistory.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="activity" className="text-xs h-7" data-testid="tab-activity">Activity</TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-y-auto px-6 py-4">

          {/* ── Overview Tab ── */}
          <TabsContent value="overview" className="mt-0 space-y-4">
            {editingProfile ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { key: "name", label: "Display Name *" },
                    { key: "legalName", label: "Legal Name" },
                    { key: "mcDot", label: "MC Number" },
                    { key: "dotNumber", label: "DOT Number" },
                    { key: "phone", label: "Main Phone" },
                    { key: "primaryEmail", label: "Primary Email" },
                    { key: "backupEmail", label: "Backup Email" },
                    { key: "city", label: "City" },
                  ].map(f => (
                    <div key={f.key}>
                      <Label className="text-xs">{f.label}</Label>
                      <Input
                        value={(profileForm as any)[f.key] ?? ""}
                        onChange={e => setProfileForm(p => ({ ...p, [f.key]: e.target.value }))}
                        className="mt-1 h-8 text-sm"
                        data-testid={`input-profile-${f.key}`}
                      />
                    </div>
                  ))}
                  <div>
                    <Label className="text-xs">State (HQ)</Label>
                    <Select value={profileForm.state ?? ""} onValueChange={v => setProfileForm(p => ({ ...p, state: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder="State" /></SelectTrigger>
                      <SelectContent>{US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Notes</Label>
                  <Textarea value={profileForm.notes ?? ""} onChange={e => setProfileForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 text-sm min-h-[80px]" />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setEditingProfile(false)}>Cancel</Button>
                  <Button size="sm" onClick={() => updateCarrier.mutate(profileForm)} disabled={updateCarrier.isPending} className="bg-amber-500 hover:bg-amber-600 text-black" data-testid="btn-save-profile">
                    {updateCarrier.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save Changes"}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Legal Name", val: carrier.legalName },
                    { label: "MC Number", val: carrier.mcDot },
                    { label: "DOT Number", val: carrier.dotNumber },
                    { label: "Main Phone", val: carrier.phone },
                    { label: "Primary Email", val: carrier.primaryEmail },
                    { label: "Backup Email", val: carrier.backupEmail },
                    { label: "HQ Location", val: [carrier.city, carrier.state].filter(Boolean).join(", ") || null },
                    { label: "Source", val: carrier.sourceChannel },
                  ].filter(f => f.val).map(f => (
                    <div key={f.label}>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{f.label}</div>
                      <div className="text-sm text-foreground mt-0.5">{f.val}</div>
                    </div>
                  ))}
                </div>
                {carrier.notes && (
                  <div className="bg-muted/20 rounded-lg p-3 border border-border">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Notes</div>
                    <p className="text-sm text-foreground whitespace-pre-wrap">{carrier.notes}</p>
                  </div>
                )}
                {carrier.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {carrier.tags.map(t => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
                  </div>
                )}
                {!carrier.legalName && !carrier.mcDot && !carrier.phone && !carrier.primaryEmail && !carrier.notes && (
                  <p className="text-sm text-muted-foreground italic">No profile details yet. Click the edit button to add information.</p>
                )}
              </>
            )}
          </TabsContent>

          {/* ── Contacts Tab ── */}
          <TabsContent value="contacts" className="mt-0 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Contacts</h3>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setAddingContact(true)} data-testid="btn-add-contact">
                <Plus className="w-3.5 h-3.5" /> Add Contact
              </Button>
            </div>

            {addingContact && (
              <ContactForm carrierId={carrierId} onSave={() => setAddingContact(false)} onCancel={() => setAddingContact(false)} />
            )}

            {data!.contacts.length === 0 && !addingContact && (
              <p className="text-sm text-muted-foreground italic py-4 text-center">No contacts yet. Add a dispatcher or contact to start outreach.</p>
            )}

            {data!.contacts.map(c => (
              <div key={c.id} data-testid={`contact-row-${c.id}`}>
                {editingContactId === c.id ? (
                  <ContactForm carrierId={carrierId} initial={c} onSave={() => setEditingContactId(null)} onCancel={() => setEditingContactId(null)} />
                ) : (
                  <div className={`rounded-lg border p-3 ${!c.isActive ? "opacity-50 border-border/50" : "border-border bg-card"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground">{c.name}</span>
                          <Badge variant="outline" className="text-[9px] py-0 px-1 text-muted-foreground">{CONTACT_ROLES.find(r => r.value === c.role)?.label ?? c.role}</Badge>
                          {c.isPrimary && <Badge variant="outline" className="text-[9px] py-0 px-1 border-amber-500/30 text-amber-400 bg-amber-500/10"><Star className="w-2.5 h-2.5 mr-0.5" />Primary</Badge>}
                          {!c.isActive && <Badge variant="outline" className="text-[9px] py-0 px-1 text-muted-foreground/50">Inactive</Badge>}
                        </div>
                        <div className="flex gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
                          {c.email && <span><Mail className="w-3 h-3 inline mr-0.5" />{c.email}</span>}
                          {c.phone && <span><Phone className="w-3 h-3 inline mr-0.5" />{c.phone}{c.extension ? ` x${c.extension}` : ""}</span>}
                          {c.preferredMethod && <span className="text-muted-foreground/50">Prefers {c.preferredMethod}</span>}
                        </div>
                        {c.notes && <p className="text-xs text-muted-foreground/60 mt-1">{c.notes}</p>}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingContactId(c.id)} data-testid={`btn-edit-contact-${c.id}`}><Edit2 className="w-3 h-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => deleteContact.mutate(c.id)} data-testid={`btn-delete-contact-${c.id}`}><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </TabsContent>

          {/* ── Equipment & Geography Tab ── */}
          <TabsContent value="equipment" className="mt-0 space-y-5">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold">Equipment Types</h3>
              </div>
              <ChipSelector
                label="Equipment"
                value={carrier.equipmentTypes ?? []}
                options={EQUIPMENT_OPTIONS}
                onChange={v => updateCarrier.mutate({ equipmentTypes: v })}
              />
              <div className="mt-3">
                <Label className="text-xs">Equipment Notes</Label>
                <Textarea
                  className="mt-1 text-sm min-h-[60px]"
                  placeholder="e.g. Team drivers available, hazmat certified, drop trailers..."
                  defaultValue={carrier.equipmentNotes ?? ""}
                  onBlur={e => updateCarrier.mutate({ equipmentNotes: e.target.value })}
                  data-testid="textarea-equipment-notes"
                />
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">States Served</h3>
              <ChipSelector
                label="States"
                value={carrier.statesServed ?? []}
                options={US_STATES}
                onChange={v => updateCarrier.mutate({ statesServed: v })}
              />
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">Regions</h3>
              <ChipSelector
                label="Regions"
                value={carrier.regions ?? []}
                options={["Southeast","Northeast","Midwest","Southwest","Northwest","West","Central","National"]}
                onChange={v => updateCarrier.mutate({ regions: v })}
              />
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">Metro Areas</h3>
              <Input
                placeholder="Add metro area and press Enter (e.g. Chicago, DFW)"
                className="text-sm"
                data-testid="input-metro-areas"
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) {
                      updateCarrier.mutate({ metroAreas: [...(carrier.metroAreas ?? []), val] });
                      (e.target as HTMLInputElement).value = "";
                    }
                  }
                }}
              />
              {carrier.metroAreas && carrier.metroAreas.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {carrier.metroAreas.map(m => (
                    <Badge key={m} variant="secondary" className="text-[11px] gap-1">
                      {m}
                      <button onClick={() => updateCarrier.mutate({ metroAreas: carrier.metroAreas!.filter(x => x !== m) })} className="hover:text-destructive">
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ── Lane Coverage Tab ── */}
          <TabsContent value="lanes" className="mt-0 space-y-5">
            {/* Claimed lanes */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-sm font-semibold">Claimed Lanes</h3>
                  <p className="text-[11px] text-muted-foreground">What this carrier says they run — user-maintained</p>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setAddingClaimedLane(true)} data-testid="btn-add-claimed-lane">
                  <Plus className="w-3.5 h-3.5" /> Add
                </Button>
              </div>

              {addingClaimedLane && (
                <ClaimedLaneForm carrierId={carrierId} onSave={() => setAddingClaimedLane(false)} onCancel={() => setAddingClaimedLane(false)} />
              )}

              {data!.claimedLanes.length === 0 && !addingClaimedLane && (
                <p className="text-xs text-muted-foreground italic">No claimed lanes. Add lanes the carrier says they prefer to run.</p>
              )}

              <div className="space-y-1.5">
                {data!.claimedLanes.map(l => (
                  <div key={l.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${l.laneType === "avoid" ? "border-red-500/20 bg-red-500/5" : "border-green-500/20 bg-green-500/5"}`} data-testid={`claimed-lane-${l.id}`}>
                    <Route className={`w-3.5 h-3.5 shrink-0 ${l.laneType === "avoid" ? "text-red-400" : "text-green-400"}`} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-foreground">{laneLabel(l)}</span>
                      {l.equipment && <span className="text-xs text-muted-foreground ml-2">· {l.equipment}</span>}
                    </div>
                    <Badge variant="outline" className={`text-[9px] py-0 px-1 shrink-0 ${l.laneType === "avoid" ? "border-red-500/30 text-red-400" : "border-green-500/30 text-green-400"}`}>
                      {l.laneType === "avoid" ? "Avoid" : "Prefers"}
                    </Badge>
                    <Button variant="ghost" size="icon" className="h-5 w-5 text-muted-foreground/50 hover:text-destructive shrink-0" onClick={() => deleteClaimedLane.mutate(l.id)} data-testid={`btn-delete-claimed-lane-${l.id}`}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* Proven lanes */}
            <div>
              <div className="mb-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  Proven History
                  <Badge variant="outline" className="text-[9px] py-0 px-1 border-blue-500/30 text-blue-400 bg-blue-500/10">System-derived · Read-only</Badge>
                </h3>
                <p className="text-[11px] text-muted-foreground">Lanes the system knows this carrier has actually run</p>
              </div>

              {data!.provenHistory.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No proven history yet. This populates automatically from financial upload data and lane activity.</p>
              )}

              <div className="space-y-1.5">
                {data!.provenHistory.map(l => (
                  <div key={l.id} className="flex items-center gap-2 rounded-lg border border-border bg-muted/10 px-3 py-2" data-testid={`proven-lane-${l.id}`}>
                    <History className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-foreground">{laneLabel(l)}</span>
                      {l.equipment_type && <span className="text-xs text-muted-foreground ml-2">· {l.equipment_type}</span>}
                      {l.company_name && <span className="text-xs text-muted-foreground ml-2">· {l.company_name}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-right">
                      {l.avg_loads_per_week && (
                        <span className="text-[11px] text-muted-foreground">{parseFloat(l.avg_loads_per_week).toFixed(1)}/wk</span>
                      )}
                      <span className="text-[11px] text-muted-foreground">{formatDate(l.updated_at)}</span>
                      {l.interest_status && (
                        <Badge variant="outline" className={`text-[9px] py-0 px-1 ${l.interest_status === "available" ? "border-green-500/30 text-green-400" : "text-muted-foreground"}`}>
                          {l.interest_status.replace(/_/g, " ")}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Best Lanes Right Now — recommended active lanes for this carrier */}
            <div>
              <div className="mb-2">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  Best Lanes Right Now
                </h3>
                <p className="text-[11px] text-muted-foreground">Active lanes where this carrier is a strong fit based on equipment, regions, and preferences</p>
              </div>

              {!bestLanesData && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading lane matches…
                </div>
              )}
              {bestLanesData && bestLanesData.lanes.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No matching active lanes found. Add equipment types, regions, or claimed lanes to improve matching.</p>
              )}
              {bestLanesData && bestLanesData.lanes.length > 0 && (
                <div className="space-y-1.5">
                  {bestLanesData.lanes.map(l => (
                    <div key={l.laneId} className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2" data-testid={`best-lane-${l.laneId}`}>
                      <Route className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-foreground font-medium">
                            {l.origin}{l.originState ? `, ${l.originState}` : ""} → {l.destination}{l.destinationState ? `, ${l.destinationState}` : ""}
                          </span>
                          {l.equipmentType && (
                            <Badge variant="outline" className="text-[9px] py-0 px-1 border-muted-foreground/30 text-muted-foreground">{l.equipmentType}</Badge>
                          )}
                          <Badge variant="outline" className={`text-[9px] py-0 px-1 ${l.fitScore >= 60 ? "border-emerald-500/30 text-emerald-400" : "border-amber-500/30 text-amber-400"}`}>
                            {l.fitScore}% fit
                          </Badge>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{l.whyThisLane}</p>
                        {l.companyName && (
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5">Customer: {l.companyName}</p>
                        )}
                        <a
                          href={`/lane-work-queue?laneId=${l.laneId}`}
                          className="inline-flex items-center gap-0.5 text-[9px] text-amber-400/80 hover:text-amber-300 mt-1 transition-colors"
                          data-testid={`link-open-lwq-${l.laneId}`}
                        >
                          <ExternalLink className="w-2.5 h-2.5" />
                          Open in Lane Work Queue
                        </a>
                      </div>
                      {l.weeklyFrequency && (
                        <span className="text-[10px] text-muted-foreground shrink-0">{l.weeklyFrequency.toFixed(1)}/wk</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* ── Activity Tab ── */}
          <TabsContent value="activity" className="mt-0">
            <h3 className="text-sm font-semibold mb-2">Outreach History</h3>
            {data!.outreachActivity.length === 0 && (
              <p className="text-sm text-muted-foreground italic">No outreach activity recorded yet.</p>
            )}
            <div className="space-y-2">
              {data!.outreachActivity.map((a: any) => (
                <div key={a.id} className="rounded-lg border border-border bg-muted/10 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{laneLabel(a)}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(a.timestamp)}</span>
                  </div>
                  {a.delivery_status && (
                    <Badge variant="outline" className="text-[9px] mt-1 py-0 px-1">{a.delivery_status}</Badge>
                  )}
                </div>
              ))}
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

// ── Carrier List Card ─────────────────────────────────────────────────────────

function CarrierCard({ carrier, selected, onClick }: { carrier: CarrierRow; selected: boolean; onClick: () => void }) {
  const provenCount = parseInt(carrier.proven_lane_count) || 0;
  const contactCount = parseInt(carrier.contact_count) || 0;
  const outreachCount = parseInt(carrier.outreach_sent) || 0;

  return (
    <button
      className={`w-full text-left rounded-lg border px-4 py-3 transition-colors cursor-pointer ${
        selected ? "border-amber-500/50 bg-amber-500/5" : "border-border bg-card hover:bg-muted/30"
      }`}
      onClick={onClick}
      data-testid={`carrier-card-${carrier.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground truncate">{carrier.name}</span>
            <StatusBadge status={carrier.status} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {carrier.mc_dot && <span className="font-mono">{carrier.mc_dot}</span>}
            {carrier.city && carrier.state && <span>{carrier.city}, {carrier.state}</span>}
            {carrier.equipment_types?.length > 0 && (
              <span>{carrier.equipment_types.slice(0, 2).join(" · ")}{carrier.equipment_types.length > 2 ? ` +${carrier.equipment_types.length - 2}` : ""}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <ContactReadinessIcon email={carrier.primary_email} phone={carrier.phone} />
          <ChevronRight className={`w-4 h-4 text-muted-foreground/30 transition-transform ${selected ? "rotate-90" : ""}`} />
        </div>
      </div>

      <div className="flex gap-4 mt-2 text-[11px] text-muted-foreground">
        {provenCount > 0 && <span className="text-blue-400"><Route className="w-3 h-3 inline mr-0.5" />{provenCount} proven lane{provenCount !== 1 ? "s" : ""}</span>}
        {outreachCount > 0 && <span><Mail className="w-3 h-3 inline mr-0.5" />{outreachCount} outreach</span>}
        {contactCount > 0 && <span><User className="w-3 h-3 inline mr-0.5" />{contactCount} contact{contactCount !== 1 ? "s" : ""}</span>}
        {carrier.last_used && <span className="ml-auto">Last: {formatDate(carrier.last_used)}</span>}
      </div>
    </button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function CarrierHub() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("__all__");
  const [equipFilter, setEquipFilter] = useState("__all__");
  const [hasEmail, setHasEmail] = useState(false);
  const [hasPhone, setHasPhone] = useState(false);
  const [hasProvenHistory, setHasProvenHistory] = useState(false);
  const [hasClaimedLanes, setHasClaimedLanes] = useState(false);
  const [sort, setSort] = useState("name");
  const [selectedCarrierId, setSelectedCarrierId] = useState<string | null>(null);
  const [addCarrierOpen, setAddCarrierOpen] = useState(false);

  // Auto-open a carrier profile when ?carrierId=... is in the URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cid = params.get("carrierId");
    if (cid) setSelectedCarrierId(cid);
  }, []);

  const statusFilterValue = statusFilter === "__all__" ? "" : statusFilter;
  const equipFilterValue = equipFilter === "__all__" ? "" : equipFilter;

  const queryParams = new URLSearchParams({
    ...(search && { q: search }),
    ...(statusFilterValue && { status: statusFilterValue }),
    ...(equipFilterValue && { equipment: equipFilterValue }),
    ...(hasEmail && { hasEmail: "true" }),
    ...(hasPhone && { hasPhone: "true" }),
    ...(hasProvenHistory && { hasProvenHistory: "true" }),
    ...(hasClaimedLanes && { hasClaimedLanes: "true" }),
    sort,
    limit: "500",
  });

  const { data, isLoading } = useQuery<{ carriers: CarrierRow[]; total: number }>({
    queryKey: ["/api/carrier-hub", queryParams.toString()],
    queryFn: () => fetch(`/api/carrier-hub?${queryParams}`).then(r => r.json()),
  });

  const carriers = data?.carriers ?? [];

  const activeFilters = [statusFilterValue, equipFilterValue, hasEmail, hasPhone, hasProvenHistory, hasClaimedLanes].filter(Boolean).length;

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Page header */}
      <div className="border-b border-border bg-background px-6 py-4 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Truck className="w-5 h-5 text-amber-400" />
              Carrier Hub
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Central carrier intelligence — contacts, lanes, equipment, and proven history
            </p>
          </div>
          <Button
            onClick={() => setAddCarrierOpen(true)}
            className="bg-amber-500 hover:bg-amber-600 text-black gap-2"
            data-testid="btn-open-add-carrier"
          >
            <Plus className="w-4 h-4" /> Add Carrier
          </Button>
        </div>

        {/* Search + filters bar */}
        <div className="flex items-center gap-3 mt-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-9 h-8 text-sm"
              placeholder="Search by name, MC/DOT, email, phone…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              data-testid="input-carrier-search"
            />
          </div>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 text-xs w-36" data-testid="select-filter-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="flagged">Flagged</SelectItem>
              <SelectItem value="do_not_use">Do Not Use</SelectItem>
            </SelectContent>
          </Select>

          <Select value={equipFilter} onValueChange={setEquipFilter}>
            <SelectTrigger className="h-8 text-xs w-36" data-testid="select-filter-equipment">
              <SelectValue placeholder="All equipment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All equipment</SelectItem>
              {EQUIPMENT_OPTIONS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger className="h-8 text-xs w-36" data-testid="select-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name A–Z</SelectItem>
              <SelectItem value="last_used">Recently Used</SelectItem>
              <SelectItem value="loads">Most Loads</SelectItem>
              <SelectItem value="outreach">Most Outreach</SelectItem>
              <SelectItem value="contact_readiness">Contact Readiness</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {[
              { label: "Has Email", val: hasEmail, set: setHasEmail },
              { label: "Has Phone", val: hasPhone, set: setHasPhone },
              { label: "Proven History", val: hasProvenHistory, set: setHasProvenHistory },
              { label: "Has Claimed Lanes", val: hasClaimedLanes, set: setHasClaimedLanes },
            ].map(f => (
              <label key={f.label} className="flex items-center gap-1.5 cursor-pointer">
                <Checkbox checked={f.val} onCheckedChange={v => f.set(!!v)} className="h-3.5 w-3.5" data-testid={`filter-${f.label.toLowerCase().replace(/\s+/g,"-")}`} />
                {f.label}
              </label>
            ))}
          </div>

          {activeFilters > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => { setStatusFilter("__all__"); setEquipFilter("__all__"); setHasEmail(false); setHasPhone(false); setHasProvenHistory(false); setHasClaimedLanes(false); }} data-testid="btn-clear-filters">
              Clear filters ({activeFilters})
            </Button>
          )}
        </div>
      </div>

      {/* Body: list + drawer */}
      <div className="flex flex-1 overflow-hidden">
        {/* Carrier list */}
        <div className={`flex flex-col overflow-hidden transition-all duration-200 ${selectedCarrierId ? "w-[420px] min-w-[420px]" : "flex-1"}`}>
          <div className="px-6 py-2 border-b border-border shrink-0 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {isLoading ? "Loading…" : `${carriers.length} carrier${carriers.length !== 1 ? "s" : ""}${data?.total !== carriers.length ? ` of ${data?.total}` : ""}`}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-3 flex flex-col gap-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : carriers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Truck className="w-10 h-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No carriers found</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  {search || activeFilters > 0 ? "Try adjusting your filters." : "Add carriers manually or import them via the Lane Work Queue."}
                </p>
                {!search && !activeFilters && (
                  <Button onClick={() => setAddCarrierOpen(true)} className="mt-4 bg-amber-500 hover:bg-amber-600 text-black gap-2 text-sm" data-testid="btn-empty-add-carrier">
                    <Plus className="w-4 h-4" /> Add Your First Carrier
                  </Button>
                )}
              </div>
            ) : (
              carriers.map(c => (
                <CarrierCard
                  key={c.id}
                  carrier={c}
                  selected={selectedCarrierId === c.id}
                  onClick={() => setSelectedCarrierId(prev => prev === c.id ? null : c.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Profile drawer — right side panel */}
        {selectedCarrierId && (
          <div className="flex-1 border-l border-border overflow-hidden flex flex-col bg-background">
            <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Carrier Profile</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedCarrierId(null)} data-testid="btn-close-carrier-drawer">
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-hidden">
              <CarrierDrawer carrierId={selectedCarrierId} onClose={() => setSelectedCarrierId(null)} />
            </div>
          </div>
        )}
      </div>

      {/* Add carrier dialog */}
      <AddCarrierDialog
        open={addCarrierOpen}
        onClose={() => setAddCarrierOpen(false)}
        onCreated={(id) => { setAddCarrierOpen(false); setSelectedCarrierId(id); }}
      />
    </div>
  );
}
