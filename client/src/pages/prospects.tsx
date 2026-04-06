import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Plus, Phone, Mail, MessageSquare, Calendar, Building2, User, Globe,
  ChevronRight, Trophy, Pencil, Trash2, PhoneCall, Send, NotebookPen,
  Users, AlertCircle, CheckCircle2, Loader2, Link as LinkIcon, Flame,
  Thermometer, Snowflake, ChevronDown, ChevronUp, Filter, TrendingUp,
  Truck, Clock, Upload, Sparkles, RefreshCw, FileUp, CheckCircle, XCircle, Download,
  LayoutList, Kanban, Search, Lock, Unlock, DollarSign, History, KeyRound, ServerCog,
  ShieldCheck, Target, BarChart3, ArrowUpDown,
} from "lucide-react";
import type { Prospect, ProspectStage, ProspectContact } from "@shared/schema";
import {
  PROSPECT_STAGE_LABELS,
  PROSPECT_LEAD_SOURCES,
  PROSPECT_LEAD_SOURCE_LABELS,
  PROSPECT_LOST_REASONS,
  PROSPECT_LOST_REASON_LABELS,
  PROSPECT_PRIORITIES,
  PROSPECT_CONTACT_ROLES,
  ACCOUNT_STATUS_LABELS,
  ACCOUNT_STATUS_COLORS,
  accountStatuses,
  type AccountStatus,
  CRM_OPP_RECORD_TYPES,
  CRM_OPP_RECORD_TYPE_LABELS,
  CRM_OPP_RECORD_TYPE_DESCRIPTIONS,
  CRM_OPP_STAGES,
  CRM_OPP_STAGE_LABELS,
} from "@shared/schema";
import { useLocation } from "wouter";

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTIVE_STAGES: ProspectStage[] = [
  "new_lead", "intro_scheduled", "intro_completed",
  "follow_up", "opportunity_sent", "first_load_won",
];
const CLOSED_STAGES: ProspectStage[] = ["lost", "disqualified"];

const STAGE_BORDER: Record<string, string> = {
  new_lead:         "border-t-slate-400",
  intro_scheduled:  "border-t-blue-400",
  intro_completed:  "border-t-indigo-400",
  follow_up:        "border-t-amber-400",
  opportunity_sent: "border-t-orange-400",
  first_load_won:   "border-t-emerald-500",
};

const CONTACT_ROLE_LABELS: Record<string, string> = {
  champion: "Champion",
  decision_maker: "Decision Maker",
  gatekeeper: "Gatekeeper",
  influencer: "Influencer",
  other: "Other",
};

const CONTACT_ROLE_COLORS: Record<string, string> = {
  champion:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  decision_maker:"bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  gatekeeper:    "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  influencer:    "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  other:         "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

const ACTIVITY_ICONS: Record<string, any> = {
  call: PhoneCall, email: Mail, text: MessageSquare, meeting: Users, note: NotebookPen,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type EnrichedProspect = Prospect & { ownerName?: string | null; assignedNamName?: string | null };
type ActivityWithName = { id: number; type: string; notes: string; createdByName: string; createdAt: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(dateStr: string | Date): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function isOverdue(dateStr?: string | null): boolean {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date(new Date().toDateString());
}

function isDueToday(dateStr?: string | null): boolean {
  if (!dateStr) return false;
  return dateStr === new Date().toISOString().split("T")[0];
}

function isStale(prospect: EnrichedProspect): boolean {
  if (CLOSED_STAGES.includes(prospect.stage as ProspectStage)) return false;
  return daysAgo(prospect.updatedAt as unknown as string) >= 7;
}

function parseSpend(s?: string | null): number {
  if (!s) return 0;
  return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
}

function weightedValue(p: EnrichedProspect): number {
  const spend = parseSpend(p.estimatedSpend);
  const prob = p.dealProbability != null ? p.dealProbability / 100 : 0.5;
  return spend * prob;
}

function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ─── Priority Badge ───────────────────────────────────────────────────────────
function PriorityBadge({ priority }: { priority?: string | null }) {
  if (!priority) return null;
  if (priority === "hot") return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
      <Flame className="h-2.5 w-2.5" /> Hot
    </span>
  );
  if (priority === "warm") return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
      <Thermometer className="h-2.5 w-2.5" /> Warm
    </span>
  );
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
      <Snowflake className="h-2.5 w-2.5" /> Cold
    </span>
  );
}

// ─── Lost Reason Dialog ───────────────────────────────────────────────────────
function LostReasonDialog({
  stage,
  onConfirm,
  onCancel,
}: {
  stage: "lost" | "disqualified";
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={v => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {stage === "lost" ? "Mark as Lost" : "Disqualify Prospect"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Select the primary reason to help improve future pipeline quality.</p>
          <div className="grid grid-cols-1 gap-1.5">
            {PROSPECT_LOST_REASONS.map(r => (
              <button
                key={r}
                onClick={() => setReason(r)}
                className={`text-left text-sm px-3 py-2 rounded-md border transition-colors ${reason === r ? "border-primary bg-primary/5 text-foreground font-medium" : "border-border text-muted-foreground hover:border-primary/50"}`}
                data-testid={`button-lost-reason-${r}`}
              >
                {PROSPECT_LOST_REASON_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-testid="button-lost-cancel">Cancel</Button>
          <Button
            variant="destructive"
            disabled={!reason}
            onClick={() => onConfirm(reason)}
            data-testid="button-lost-confirm"
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Multi-Contact Manager ────────────────────────────────────────────────────
function ContactsTab({ prospectId }: { prospectId: number }) {
  const { toast } = useToast();
  const [addingContact, setAddingContact] = useState(false);
  const [editingContact, setEditingContact] = useState<ProspectContact | null>(null);
  const [contactForm, setContactForm] = useState({ name: "", title: "", email: "", phone: "", linkedin: "", role: "other", notes: "" });

  const { data: contacts = [], isLoading } = useQuery<ProspectContact[]>({
    queryKey: ["/api/prospects", prospectId, "contacts"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospectId}/contacts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const resetForm = () => setContactForm({ name: "", title: "", email: "", phone: "", linkedin: "", role: "other", notes: "" });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/prospects/${prospectId}/contacts`, contactForm);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospectId, "contacts"] });
      toast({ title: "Contact added" });
      setAddingContact(false);
      resetForm();
    },
    onError: () => toast({ title: "Failed to add contact", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/prospects/${prospectId}/contacts/${editingContact!.id}`, contactForm);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospectId, "contacts"] });
      toast({ title: "Contact updated" });
      setEditingContact(null);
      resetForm();
    },
    onError: () => toast({ title: "Failed to update contact", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/prospects/${prospectId}/contacts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospectId, "contacts"] });
      toast({ title: "Contact removed" });
    },
    onError: () => toast({ title: "Failed to remove contact", variant: "destructive" }),
  });

  const startEdit = (c: ProspectContact) => {
    setEditingContact(c);
    setContactForm({ name: c.name, title: c.title ?? "", email: c.email ?? "", phone: c.phone ?? "", linkedin: c.linkedin ?? "", role: c.role ?? "other", notes: c.notes ?? "" });
    setAddingContact(false);
  };

  const setField = (k: string, v: string) => setContactForm(prev => ({ ...prev, [k]: v }));

  const ContactForm = ({ onSave, onCancel, isPending }: { onSave: () => void; onCancel: () => void; isPending: boolean }) => (
    <div className="border rounded-lg p-3 space-y-2.5 bg-muted/20">
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <Label className="text-xs">Name *</Label>
          <Input value={contactForm.name} onChange={e => setField("name", e.target.value)} placeholder="Jane Smith" className="mt-1 h-8 text-sm" data-testid="input-contact-name" />
        </div>
        <div>
          <Label className="text-xs">Title</Label>
          <Input value={contactForm.title} onChange={e => setField("title", e.target.value)} placeholder="VP of Logistics" className="mt-1 h-8 text-sm" data-testid="input-contact-title" />
        </div>
        <div>
          <Label className="text-xs">Role</Label>
          <Select value={contactForm.role} onValueChange={v => setField("role", v)}>
            <SelectTrigger className="mt-1 h-8 text-xs" data-testid="select-contact-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROSPECT_CONTACT_ROLES.map(r => (
                <SelectItem key={r} value={r} className="text-xs">{CONTACT_ROLE_LABELS[r]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Email</Label>
          <Input type="email" value={contactForm.email} onChange={e => setField("email", e.target.value)} placeholder="jane@acme.com" className="mt-1 h-8 text-sm" data-testid="input-contact-email" />
        </div>
        <div>
          <Label className="text-xs">Phone</Label>
          <Input value={contactForm.phone} onChange={e => setField("phone", e.target.value)} placeholder="(555) 000-0000" className="mt-1 h-8 text-sm" data-testid="input-contact-phone" />
        </div>
        <div className="col-span-2">
          <Label className="text-xs">LinkedIn URL</Label>
          <Input value={contactForm.linkedin} onChange={e => setField("linkedin", e.target.value)} placeholder="https://linkedin.com/in/..." className="mt-1 h-8 text-sm" data-testid="input-contact-linkedin" />
        </div>
        <div className="col-span-2">
          <Label className="text-xs">Notes</Label>
          <Textarea value={contactForm.notes} onChange={e => setField("notes", e.target.value)} placeholder="Context about this contact…" className="mt-1 text-sm min-h-[50px]" data-testid="input-contact-notes" />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel} disabled={isPending}>Cancel</Button>
        <Button size="sm" className="h-7 text-xs" onClick={onSave} disabled={isPending || !contactForm.name.trim()} data-testid="button-contact-save">
          {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}Save
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="space-y-2">{[1,2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : contacts.length === 0 && !addingContact ? (
        <p className="text-sm text-muted-foreground text-center py-4">No stakeholders added yet.</p>
      ) : (
        <div className="space-y-2">
          {contacts.map(c => (
            editingContact?.id === c.id ? (
              <ContactForm key={c.id} onSave={() => updateMutation.mutate()} onCancel={() => { setEditingContact(null); resetForm(); }} isPending={updateMutation.isPending} />
            ) : (
              <div key={c.id} className="border rounded-lg p-3 space-y-1.5" data-testid={`contact-card-${c.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{c.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CONTACT_ROLE_COLORS[c.role ?? "other"]}`}>
                        {CONTACT_ROLE_LABELS[c.role ?? "other"]}
                      </span>
                    </div>
                    {c.title && <p className="text-xs text-muted-foreground mt-0.5">{c.title}</p>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => startEdit(c)} data-testid={`button-edit-contact-${c.id}`}><Pencil className="h-3 w-3" /></Button>
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-red-500 hover:text-red-600" onClick={() => { if (confirm(`Remove ${c.name}?`)) deleteMutation.mutate(c.id); }} data-testid={`button-delete-contact-${c.id}`}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {c.email && <a href={`mailto:${c.email}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><Mail className="h-2.5 w-2.5" />{c.email}</a>}
                  {c.phone && <a href={`tel:${c.phone}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{c.phone}</a>}
                  {c.linkedin && <a href={c.linkedin} target="_blank" rel="noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><LinkIcon className="h-2.5 w-2.5" />LinkedIn</a>}
                </div>
                {c.notes && <p className="text-xs text-muted-foreground">{c.notes}</p>}
              </div>
            )
          ))}
        </div>
      )}

      {addingContact ? (
        <ContactForm onSave={() => createMutation.mutate()} onCancel={() => { setAddingContact(false); resetForm(); }} isPending={createMutation.isPending} />
      ) : (
        <Button size="sm" variant="outline" className="w-full gap-1.5 h-8 text-xs" onClick={() => { setAddingContact(true); setEditingContact(null); }} data-testid="button-add-contact">
          <Plus className="h-3.5 w-3.5" /> Add Stakeholder
        </Button>
      )}
    </div>
  );
}

// ─── Prospect Form Dialog ─────────────────────────────────────────────────────
function ProspectFormDialog({
  open, onClose, editing, currentUserId, users,
}: {
  open: boolean; onClose: () => void; editing?: EnrichedProspect | null;
  currentUserId: string; users: any[];
}) {
  const { toast } = useToast();
  const isEdit = !!editing;

  const blank = {
    name: "", industry: "", website: "", estimatedSpend: "",
    primaryContactName: "", primaryContactTitle: "", primaryContactEmail: "",
    primaryContactPhone: "", primaryContactLinkedin: "",
    notes: "", nextSteps: "", followUpDate: "",
    stage: "new_lead", ownerId: currentUserId,
    leadSource: "", currentCarrier: "", estLoadsPerWeek: "",
    topLanes: "", commodity: "", painPoints: "",
    priority: "", expectedCloseDate: "", dealProbability: "",
    // TMS / Portal fields
    phone: "", billingAddress: "",
    tmsWebsite: "", tmsEmail: "", schedulingWebsite: "", schedulingEmail: "",
    tmsUsername: "", tmsPassword: "",
  };

  const toStr = (v: any) => (v == null ? "" : String(v));

  const [values, setValues] = useState(() => editing ? {
    name: editing.name ?? "",
    industry: editing.industry ?? "",
    website: editing.website ?? "",
    estimatedSpend: editing.estimatedSpend ?? "",
    primaryContactName: editing.primaryContactName ?? "",
    primaryContactTitle: editing.primaryContactTitle ?? "",
    primaryContactEmail: editing.primaryContactEmail ?? "",
    primaryContactPhone: editing.primaryContactPhone ?? "",
    primaryContactLinkedin: editing.primaryContactLinkedin ?? "",
    notes: editing.notes ?? "",
    nextSteps: editing.nextSteps ?? "",
    followUpDate: editing.followUpDate ?? "",
    stage: editing.stage ?? "new_lead",
    ownerId: editing.ownerId ?? currentUserId,
    leadSource: editing.leadSource ?? "",
    currentCarrier: editing.currentCarrier ?? "",
    estLoadsPerWeek: editing.estLoadsPerWeek ?? "",
    topLanes: editing.topLanes ?? "",
    commodity: editing.commodity ?? "",
    painPoints: editing.painPoints ?? "",
    priority: editing.priority ?? "",
    expectedCloseDate: editing.expectedCloseDate ?? "",
    dealProbability: toStr(editing.dealProbability),
    phone: editing.phone ?? "",
    billingAddress: editing.billingAddress ?? "",
    tmsWebsite: editing.tmsWebsite ?? "",
    tmsEmail: editing.tmsEmail ?? "",
    schedulingWebsite: editing.schedulingWebsite ?? "",
    schedulingEmail: editing.schedulingEmail ?? "",
    tmsUsername: editing.tmsUsername ?? "",
    tmsPassword: editing.tmsPassword ?? "",
  } : blank);

  const set = (k: string, v: string) => setValues(prev => ({ ...prev, [k]: v }));

  const buildPayload = () => {
    const p: any = { ...values };
    // Convert dealProbability to integer or null
    if (p.dealProbability !== "") p.dealProbability = parseInt(p.dealProbability);
    else p.dealProbability = null;
    // For optional text fields: send null instead of empty string so editing can clear values
    const optionalTextFields = [
      "industry", "website", "estimatedSpend", "primaryContactName", "primaryContactTitle",
      "primaryContactEmail", "primaryContactPhone", "primaryContactLinkedin",
      "notes", "nextSteps", "followUpDate", "leadSource", "currentCarrier",
      "estLoadsPerWeek", "topLanes", "commodity", "painPoints", "priority", "expectedCloseDate",
      "phone", "billingAddress", "tmsWebsite", "tmsEmail", "schedulingWebsite", "schedulingEmail",
      "tmsUsername", "tmsPassword",
    ];
    optionalTextFields.forEach(k => { if (p[k] === "") p[k] = null; });
    return p;
  };

  const createMutation = useMutation({
    mutationFn: async (data: any) => (await apiRequest("POST", "/api/prospects", data)).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/prospects"] }); toast({ title: "Prospect added!" }); onClose(); },
    onError: () => toast({ title: "Failed to add prospect", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async (data: any) => (await apiRequest("PATCH", `/api/prospects/${editing!.id}`, data)).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/prospects"] }); toast({ title: "Prospect updated" }); onClose(); },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const handleSubmit = () => {
    if (!values.name.trim()) return toast({ title: "Company name is required", variant: "destructive" });
    if (values.dealProbability !== "" && (isNaN(parseInt(values.dealProbability)) || parseInt(values.dealProbability) < 0 || parseInt(values.dealProbability) > 100)) {
      return toast({ title: "Deal probability must be 0–100", variant: "destructive" });
    }
    const payload = buildPayload();
    isEdit ? updateMutation.mutate(payload) : createMutation.mutate(payload);
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isEdit ? "Edit Prospect" : "Add New Prospect"}</DialogTitle></DialogHeader>
        <div className="space-y-6 py-2">
          {/* Company info */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Company Name *</Label>
              <Input data-testid="input-prospect-name" value={values.name} onChange={e => set("name", e.target.value)} placeholder="Acme Corp" className="mt-1" />
            </div>
            <div>
              <Label>Industry</Label>
              <Input data-testid="input-prospect-industry" value={values.industry} onChange={e => set("industry", e.target.value)} placeholder="Manufacturing, Retail…" className="mt-1" />
            </div>
            <div>
              <Label>Est. Freight Spend / Mo</Label>
              <Input data-testid="input-prospect-spend" value={values.estimatedSpend} onChange={e => set("estimatedSpend", e.target.value)} placeholder="$50,000" className="mt-1" />
            </div>
            <div className="col-span-2">
              <Label>Website</Label>
              <Input data-testid="input-prospect-website" value={values.website} onChange={e => set("website", e.target.value)} placeholder="https://acme.com" className="mt-1" />
            </div>
          </div>

          {/* Primary Contact */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 pb-1 border-b">Primary Contact</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Contact Name</Label>
                <Input data-testid="input-prospect-contact-name" value={values.primaryContactName} onChange={e => set("primaryContactName", e.target.value)} placeholder="Jane Smith" className="mt-1" />
              </div>
              <div>
                <Label>Title</Label>
                <Input data-testid="input-prospect-contact-title" value={values.primaryContactTitle} onChange={e => set("primaryContactTitle", e.target.value)} placeholder="VP of Logistics" className="mt-1" />
              </div>
              <div>
                <Label>Email</Label>
                <Input data-testid="input-prospect-contact-email" type="email" value={values.primaryContactEmail} onChange={e => set("primaryContactEmail", e.target.value)} placeholder="jane@acme.com" className="mt-1" />
              </div>
              <div>
                <Label>Phone</Label>
                <Input data-testid="input-prospect-contact-phone" value={values.primaryContactPhone} onChange={e => set("primaryContactPhone", e.target.value)} placeholder="(555) 000-0000" className="mt-1" />
              </div>
              <div className="col-span-2">
                <Label>LinkedIn URL</Label>
                <Input data-testid="input-prospect-contact-linkedin" value={values.primaryContactLinkedin} onChange={e => set("primaryContactLinkedin", e.target.value)} placeholder="https://linkedin.com/in/janesmith" className="mt-1" />
              </div>
            </div>
          </div>

          {/* Discovery Info */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 pb-1 border-b">Discovery Info</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Lead Source</Label>
                <Select value={values.leadSource || "none"} onValueChange={v => set("leadSource", v === "none" ? "" : v)}>
                  <SelectTrigger className="mt-1" data-testid="select-lead-source"><SelectValue placeholder="How did you find them?" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— Not set —</SelectItem>
                    {PROSPECT_LEAD_SOURCES.map(s => <SelectItem key={s} value={s}>{PROSPECT_LEAD_SOURCE_LABELS[s]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Current Carrier / Broker</Label>
                <Input data-testid="input-current-carrier" value={values.currentCarrier} onChange={e => set("currentCarrier", e.target.value)} placeholder="XPO, Echo, Werner…" className="mt-1" />
              </div>
              <div>
                <Label>Est. Loads / Week</Label>
                <Input data-testid="input-est-loads" value={values.estLoadsPerWeek} onChange={e => set("estLoadsPerWeek", e.target.value)} placeholder="50" className="mt-1" />
              </div>
              <div>
                <Label>Commodity</Label>
                <Input data-testid="input-commodity" value={values.commodity} onChange={e => set("commodity", e.target.value)} placeholder="Consumer goods, auto parts…" className="mt-1" />
              </div>
              <div className="col-span-2">
                <Label>Top Lanes</Label>
                <Input data-testid="input-top-lanes" value={values.topLanes} onChange={e => set("topLanes", e.target.value)} placeholder="Chicago → Dallas, LA → Phoenix…" className="mt-1" />
              </div>
              <div className="col-span-2">
                <Label>Pain Points</Label>
                <Textarea data-testid="input-pain-points" value={values.painPoints} onChange={e => set("painPoints", e.target.value)} placeholder="Service failures, capacity issues, pricing complaints…" className="mt-1 min-h-[60px]" />
              </div>
            </div>
          </div>

          {/* Deal Details */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 pb-1 border-b">Deal Details</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Stage</Label>
                <Select value={values.stage} onValueChange={v => set("stage", v)}>
                  <SelectTrigger className="mt-1" data-testid="select-prospect-stage"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACTIVE_STAGES.map(s => <SelectItem key={s} value={s}>{PROSPECT_STAGE_LABELS[s]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={values.priority || "none"} onValueChange={v => set("priority", v === "none" ? "" : v)}>
                  <SelectTrigger className="mt-1" data-testid="select-priority"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— Not set —</SelectItem>
                    <SelectItem value="hot">🔴 Hot</SelectItem>
                    <SelectItem value="warm">🟡 Warm</SelectItem>
                    <SelectItem value="cold">🔵 Cold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Follow-up Date</Label>
                <Input data-testid="input-prospect-followup" type="date" value={values.followUpDate} onChange={e => set("followUpDate", e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label>Expected Close Date</Label>
                <Input data-testid="input-expected-close" type="date" value={values.expectedCloseDate} onChange={e => set("expectedCloseDate", e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label>Deal Probability %</Label>
                <Input data-testid="input-deal-probability" type="number" min="0" max="100" value={values.dealProbability} onChange={e => set("dealProbability", e.target.value)} placeholder="0–100" className="mt-1" />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="grid grid-cols-1 gap-3">
            <div>
              <Label>Notes</Label>
              <Textarea data-testid="input-prospect-notes" value={values.notes} onChange={e => set("notes", e.target.value)} placeholder="Background on this prospect…" className="mt-1 min-h-[70px]" />
            </div>
            <div>
              <Label>Next Steps</Label>
              <Textarea data-testid="input-prospect-nextsteps" value={values.nextSteps} onChange={e => set("nextSteps", e.target.value)} placeholder="Send intro email, schedule discovery call…" className="mt-1 min-h-[50px]" />
            </div>
          </div>

          {/* TMS / Portal Access */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3 pb-1 border-b">TMS & Portal Access</p>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Phone</Label><Input data-testid="input-tms-phone" value={values.phone} onChange={e => set("phone", e.target.value)} placeholder="Main phone #" className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs">Billing Address</Label><Input data-testid="input-billing-address" value={values.billingAddress} onChange={e => set("billingAddress", e.target.value)} placeholder="123 Main St" className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs">TMS Website</Label><Input data-testid="input-tms-website" value={values.tmsWebsite} onChange={e => set("tmsWebsite", e.target.value)} placeholder="https://portal.example.com" className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs">TMS Email</Label><Input data-testid="input-tms-email" value={values.tmsEmail} onChange={e => set("tmsEmail", e.target.value)} placeholder="orders@example.com" className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs">Scheduling Website</Label><Input data-testid="input-scheduling-website" value={values.schedulingWebsite} onChange={e => set("schedulingWebsite", e.target.value)} placeholder="https://schedule.example.com" className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs">Scheduling Email</Label><Input data-testid="input-scheduling-email" value={values.schedulingEmail} onChange={e => set("schedulingEmail", e.target.value)} placeholder="dispatch@example.com" className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs">TMS Username</Label><Input data-testid="input-tms-username" value={values.tmsUsername} onChange={e => set("tmsUsername", e.target.value)} placeholder="username" className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs">TMS Password</Label><Input data-testid="input-tms-password" type="text" value={values.tmsPassword} onChange={e => set("tmsPassword", e.target.value)} placeholder="password" className="mt-1 h-8 text-sm font-mono" /></div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending} data-testid="button-prospect-form-cancel">Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending} data-testid="button-prospect-form-submit">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {isEdit ? "Save Changes" : "Add Prospect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Convert to Customer Dialog ───────────────────────────────────────────────
function ConvertDialog({ prospect, onClose, users }: { prospect: EnrichedProspect; onClose: () => void; users: any[] }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [namId, setNamId] = useState("");
  const nams = users.filter(u => ["national_account_manager", "account_manager"].includes(u.role));

  const mutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/prospects/${prospect.id}/convert`, { assignedNamId: namId || null })).json(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: `${prospect.name} converted to customer!` });
      onClose();
      if (data.company?.id) navigate(`/companies/${data.company.id}`);
    },
    onError: () => toast({ title: "Conversion failed", variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Trophy className="h-5 w-5 text-emerald-500" /> Convert to Customer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground"><strong className="text-foreground">{prospect.name}</strong> will become a full customer account in the CRM.</p>
          <div>
            <Label>Assign NAM (optional)</Label>
            <Select value={namId} onValueChange={setNamId}>
              <SelectTrigger className="mt-1" data-testid="select-convert-nam"><SelectValue placeholder="Select a NAM or AM…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No assignment yet</SelectItem>
                {nams.map(u => <SelectItem key={u.id} value={u.id}>{u.name} ({u.role.replace(/_/g, " ")})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-convert-cancel">Cancel</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => mutation.mutate()} disabled={mutation.isPending} data-testid="button-convert-confirm">
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trophy className="h-4 w-4 mr-2" />} Convert to Customer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Import Dialog ────────────────────────────────────────────────────────────

const IMPORT_FIELDS = [
  { key: "name",               label: "Company Name *",      required: true  },
  { key: "industry",           label: "Industry",            required: false },
  { key: "estimatedSpend",     label: "Est. Freight Spend",  required: false },
  { key: "primaryContactName", label: "Contact Name",        required: false },
  { key: "primaryContactTitle",label: "Contact Title",       required: false },
  { key: "primaryContactEmail",label: "Contact Email",       required: false },
  { key: "primaryContactPhone",label: "Contact Phone",       required: false },
  { key: "website",            label: "Website",             required: false },
  { key: "currentCarrier",     label: "Current Carrier",     required: false },
  { key: "topLanes",           label: "Top Lanes",           required: false },
  { key: "commodity",          label: "Commodity",           required: false },
  { key: "leadSource",         label: "Lead Source",         required: false },
  { key: "notes",              label: "Notes",               required: false },
] as const;

type ImportFieldKey = typeof IMPORT_FIELDS[number]["key"];

const HEADER_SYNONYMS: Record<ImportFieldKey, string[]> = {
  name:                ["company", "company name", "account", "organization", "business", "account name"],
  industry:            ["industry", "sector", "vertical", "market"],
  estimatedSpend:      ["spend", "freight spend", "monthly spend", "estimated spend", "budget", "est spend"],
  primaryContactName:  ["contact", "contact name", "primary contact", "name", "first name", "full name", "person"],
  primaryContactTitle: ["title", "contact title", "job title", "position", "role"],
  primaryContactEmail: ["email", "e-mail", "email address", "contact email"],
  primaryContactPhone: ["phone", "phone number", "telephone", "mobile", "contact phone", "cell"],
  website:             ["website", "url", "web", "site", "domain"],
  currentCarrier:      ["carrier", "current carrier", "incumbent", "current broker", "broker"],
  topLanes:            ["lanes", "top lanes", "routes", "corridors", "freight lanes"],
  commodity:           ["commodity", "product", "freight type", "product type", "goods", "cargo"],
  leadSource:          ["source", "lead source", "how found", "channel", "origin"],
  notes:               ["notes", "comments", "note", "description", "remarks"],
};

function autoDetectMapping(headers: string[]): Record<string, string> {
  const norm = headers.map(h => h.toLowerCase().trim());
  const mapping: Record<string, string> = {};
  IMPORT_FIELDS.forEach(f => {
    for (const syn of HEADER_SYNONYMS[f.key]) {
      const idx = norm.indexOf(syn);
      if (idx !== -1) { mapping[f.key] = headers[idx]; break; }
    }
  });
  return mapping;
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "result">("upload");
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<{ created: number; errors: { row: number; error: string }[] } | null>(null);

  // headerOriginalIndex[i] = original column index in the spreadsheet for rawHeaders[i]
  const [headerOriginalIndex, setHeaderOriginalIndex] = useState<number[]>([]);

  const handleFile = async (file: File) => {
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as string[][];
    if (!data || data.length < 2) {
      toast({ title: "File must have at least a header row and one data row.", variant: "destructive" });
      return;
    }
    // Build header list and keep track of original column indices so blank
    // header columns in between don't cause index shift when reading row values
    const hdrs: string[] = [];
    const origIdxs: number[] = [];
    data[0].forEach((h, i) => {
      const cleaned = String(h ?? "").trim();
      if (cleaned) { hdrs.push(cleaned); origIdxs.push(i); }
    });
    const rows = data.slice(1).filter(r => r.some(c => c != null && String(c).trim() !== ""));
    setRawHeaders(hdrs);
    setHeaderOriginalIndex(origIdxs);
    setRawRows(rows as string[][]);
    setMapping(autoDetectMapping(hdrs));
    setStep("map");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      const rows = rawRows.map(row => {
        const obj: Record<string, string> = {};
        IMPORT_FIELDS.forEach(f => {
          const col = mapping[f.key];
          if (col) {
            const hdrIdx = rawHeaders.indexOf(col);
            const origIdx = hdrIdx !== -1 ? headerOriginalIndex[hdrIdx] : -1;
            if (origIdx !== -1 && row[origIdx] != null) {
              obj[f.key] = String(row[origIdx]).trim();
            }
          }
        });
        return obj;
      });
      // Send all rows — backend validates and returns per-row errors
      const res = await apiRequest("POST", "/api/prospects/import", { rows });
      return res.json();
    },
    onSuccess: (data) => {
      setImportResult(data);
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
    },
    onError: () => toast({ title: "Import failed", variant: "destructive" }),
  });

  const previewRows = rawRows.slice(0, 5);
  const mappedFields = IMPORT_FIELDS.filter(f => mapping[f.key]);

  const handleClose = () => {
    setStep("upload");
    setRawHeaders([]);
    setRawRows([]);
    setMapping({});
    setImportResult(null);
    onClose();
  };

  const downloadTemplate = () => {
    const headers = IMPORT_FIELDS.map(f => f.label.replace(" *", ""));
    const exampleRow = ["Acme Logistics", "Manufacturing", "Chicago, IL", "TL, LTL", "500000", "Jane Smith", "VP of Logistics", "jane@acmelogistics.com", "312-555-0100", "Chicago-Dallas, Memphis-Atlanta"];
    const csv = [headers, exampleRow].map(row => row.map(v => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "freight-dna-prospect-import-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadFailedRows = () => {
    if (!importResult?.errors?.length || !rawRows.length) return;
    const headers = [...IMPORT_FIELDS.map(f => f.label.replace(" *", "")), "Import Error"];
    const rows = importResult.errors.map(e => {
      const row = rawRows[e.row - 1] ?? [];
      const values = IMPORT_FIELDS.map(f => {
        const hdrIdx = rawHeaders.indexOf(mapping[f.key] ?? "");
        const origIdx = hdrIdx !== -1 ? headerOriginalIndex[hdrIdx] : -1;
        return origIdx !== -1 ? (row[origIdx] ?? "") : "";
      });
      return [...values, e.error];
    });
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "freight-dna-import-failed-rows.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            {step === "upload" ? "Import Prospects" : step === "map" ? "Map Columns" : "Import Complete"}
          </DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">Upload a CSV or Excel file exported from ZoomInfo, LinkedIn Sales Navigator, or any spreadsheet.</p>
              <Button size="sm" variant="outline" className="shrink-0 gap-1.5 text-xs h-8" onClick={downloadTemplate} data-testid="button-download-template">
                <Download className="h-3.5 w-3.5" /> Template
              </Button>
            </div>
            <div
              className="border-2 border-dashed border-border rounded-xl p-10 text-center hover:border-primary/50 transition-colors cursor-pointer"
              onDrop={onDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              data-testid="import-dropzone"
            >
              <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium text-sm">Drag & drop or click to upload</p>
              <p className="text-xs text-muted-foreground mt-1">Supports .csv and .xlsx files</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                data-testid="input-import-file"
              />
            </div>
            <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Supported columns (auto-detected):</p>
              <p>{IMPORT_FIELDS.map(f => f.label.replace(" *", "")).join(" · ")}</p>
            </div>
          </div>
        )}

        {step === "map" && (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Match your spreadsheet columns to prospect fields. <span className="font-medium text-foreground">{rawRows.length} rows detected.</span>
            </p>

            {/* Mapping table */}
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Prospect Field</TableHead>
                    <TableHead className="text-xs">Your Column</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {IMPORT_FIELDS.map(f => (
                    <TableRow key={f.key}>
                      <TableCell className="text-xs py-1.5 font-medium">
                        {f.label}
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Select
                          value={mapping[f.key] ?? "__none__"}
                          onValueChange={v => setMapping(prev => {
                            const next = { ...prev };
                            if (v === "__none__") { delete next[f.key]; } else { next[f.key] = v; }
                            return next;
                          })}
                        >
                          <SelectTrigger className="h-7 text-xs" data-testid={`mapping-select-${f.key}`}>
                            <SelectValue placeholder="— skip —" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__" className="text-xs text-muted-foreground">— skip —</SelectItem>
                            {rawHeaders.map(h => (
                              <SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Preview */}
            {mappedFields.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Preview (first {Math.min(5, previewRows.length)} rows)</p>
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {mappedFields.map(f => (
                          <TableHead key={f.key} className="text-xs whitespace-nowrap">{f.label.replace(" *", "")}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, i) => (
                        <TableRow key={i}>
                          {mappedFields.map(f => {
                            const hdrIdx = rawHeaders.indexOf(mapping[f.key] ?? "");
                            const origIdx = hdrIdx !== -1 ? headerOriginalIndex[hdrIdx] : -1;
                            return (
                              <TableCell key={f.key} className="text-xs py-1.5 max-w-[140px] truncate">
                                {origIdx !== -1 ? (row[origIdx] ?? "") : ""}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        )}

        {step === "result" && importResult && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 p-4 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
              <CheckCircle className="h-8 w-8 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div>
                <p className="font-semibold text-emerald-700 dark:text-emerald-300">{importResult.created} prospect{importResult.created !== 1 ? "s" : ""} imported</p>
                {importResult.errors.length > 0 && (
                  <p className="text-sm text-muted-foreground">{importResult.errors.length} row{importResult.errors.length !== 1 ? "s" : ""} skipped due to errors</p>
                )}
              </div>
            </div>
            {importResult.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skipped Rows</p>
                {importResult.errors.map(e => (
                  <div key={e.row} className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                    <XCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>Row {e.row}: {e.error}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "upload" && (
            <Button variant="outline" onClick={handleClose} data-testid="button-import-cancel">Cancel</Button>
          )}
          {step === "map" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} data-testid="button-import-back">Back</Button>
              <Button
                onClick={() => importMutation.mutate()}
                disabled={!mapping["name"] || importMutation.isPending}
                data-testid="button-import-confirm"
              >
                {importMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Importing…</> : <>Import {rawRows.length} Prospects</>}
              </Button>
            </>
          )}
          {step === "result" && (
            <>
              {(importResult?.errors?.length ?? 0) > 0 && (
                <Button variant="outline" className="gap-1.5" onClick={downloadFailedRows} data-testid="button-download-failed-rows">
                  <Download className="h-4 w-4" /> Download Failed Rows
                </Button>
              )}
              <Button onClick={handleClose} data-testid="button-import-done">Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── AI Sales Intel Tab ───────────────────────────────────────────────────────
function SalesIntelTab({ prospect }: { prospect: EnrichedProspect }) {
  const { toast } = useToast();
  const [brief, setBrief] = useState<string>(prospect.intelBrief ?? "");
  const [loading, setLoading] = useState(false);

  const generate = async (force: boolean) => {
    setLoading(true);
    try {
      const res = await apiRequest("POST", `/api/prospects/${prospect.id}/intel`, { force });
      const data = await res.json();
      if (data.brief) {
        setBrief(data.brief);
        queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
        if (!force) toast({ title: "Sales Intel Brief generated!" });
        else toast({ title: "Brief regenerated" });
      }
    } catch {
      toast({ title: "Failed to generate brief", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // Parse brief into sections: split on lines starting with "## "
  const sections = brief
    ? brief.split(/\n(?=##\s)/).map(block => {
        const lines = block.trim().split("\n");
        const header = lines[0].replace(/^##\s+/, "").trim();
        const bullets = lines.slice(1).filter(l => l.trim()).map(l => l.replace(/^[-*]\s*/, "").trim());
        return { header, bullets };
      }).filter(s => s.header)
    : [];

  return (
    <div className="space-y-4">
      {/* Generate / Regenerate button */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">AI Sales Intel Brief</p>
          <p className="text-xs text-muted-foreground mt-0.5">GPT-4o-mini cross-references your customer network to surface overlap and talking points</p>
        </div>
        {brief ? (
          <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs shrink-0" onClick={() => generate(true)} disabled={loading} data-testid="button-intel-regenerate">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Regenerate
          </Button>
        ) : (
          <Button size="sm" className="gap-1.5 h-8 text-xs shrink-0 bg-violet-600 hover:bg-violet-700 text-white" onClick={() => generate(false)} disabled={loading} data-testid="button-intel-generate">
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            Generate Brief
          </Button>
        )}
      </div>

      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!loading && !brief && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Sparkles className="h-8 w-8 text-violet-400 mx-auto mb-2" />
          <p className="text-sm font-medium text-foreground">No brief yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
            Generate a brief to see network overlap, conversation starters, industry pain points, and competitive tips.
          </p>
        </div>
      )}

      {!loading && sections.length > 0 && (
        <div className="space-y-4">
          {sections.map((section, i) => (
            <div key={i} className="border rounded-lg p-3 space-y-2">
              <p className="text-sm font-semibold text-foreground">{section.header}</p>
              <ul className="space-y-1.5">
                {section.bullets.map((bullet, j) => (
                  <li key={j} className="flex gap-2 text-xs text-foreground/80">
                    <span className="text-violet-500 mt-0.5 shrink-0">•</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground text-right">Powered by GPT-4o-mini · Cached result</p>
        </div>
      )}

      {!loading && brief && sections.length === 0 && (
        <div className="text-sm text-foreground/80 whitespace-pre-wrap bg-muted/30 rounded-lg p-3">{brief}</div>
      )}
    </div>
  );
}

// ─── Account Status Colors ──────────────────────────────────────────────────

const ACCOUNT_STATUS_DOT: Record<string, string> = {
  prospecting: "bg-slate-400",
  intro_scheduled: "bg-blue-400",
  active_customer: "bg-emerald-500",
  dormant: "bg-amber-400",
  lost: "bg-red-400",
};

// ─── Opportunity Record Types / Stages ─────────────────────────────────────

const OPP_STAGE_COLORS: Record<string, string> = {
  qualification: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  discovery: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  proposal: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  negotiation: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  closed_won: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  closed_lost: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

const OPP_TYPE_COLORS: Record<string, string> = {
  single_multi_lane: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  private_hauling: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  rfp: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  trucking_opportunity: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
};

// ─── Opportunities Tab ──────────────────────────────────────────────────────

type CrmOpportunity = { id: number; prospectId: number; organizationId: string; name: string; recordType: string; stage: string; amount?: string | null; closeDate?: string | null; probability?: number | null; notes?: string | null; lostReason?: string | null; createdById: string; createdAt: string; updatedAt: string };

function parseAmount(s?: string | null): number {
  if (!s) return 0;
  return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
}

// Two-step New Opportunity dialog
function NewOpportunityDialog({
  prospectId,
  onClose,
  onCreated,
}: {
  prospectId: number;
  onClose: () => void;
  onCreated: (opp: CrmOpportunity) => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [recordType, setRecordType] = useState<string>("");
  const [form, setForm] = useState({ name: "", stage: "qualification", amount: "", closeDate: "", probability: "", notes: "" });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", `/api/prospects/${prospectId}/opportunities`, data).then(r => r.json()),
    onSuccess: (created) => { toast({ title: "Opportunity created" }); onCreated(created); onClose(); },
    onError: () => toast({ title: "Failed to create opportunity", variant: "destructive" }),
  });

  function handleSubmit() {
    if (!form.name.trim()) return toast({ title: "Name is required", variant: "destructive" });
    const payload = { ...form, recordType, probability: form.probability ? parseInt(form.probability) : null };
    createMutation.mutate(payload);
  }

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? "New Opportunity — Select Type" : "New Opportunity — Details"}
          </DialogTitle>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Choose the record type that best describes this opportunity.</p>
            <div className="grid gap-2">
              {CRM_OPP_RECORD_TYPES.map(rt => (
                <button
                  key={rt}
                  onClick={() => setRecordType(rt)}
                  className={`text-left p-3 rounded-lg border transition-all ${recordType === rt ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-primary/50 hover:bg-muted/40"}`}
                  data-testid={`opp-type-${rt}`}
                >
                  <p className={`font-semibold text-sm ${recordType === rt ? "text-primary" : "text-foreground"}`}>{CRM_OPP_RECORD_TYPE_LABELS[rt as keyof typeof CRM_OPP_RECORD_TYPE_LABELS]}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{CRM_OPP_RECORD_TYPE_DESCRIPTIONS[rt as keyof typeof CRM_OPP_RECORD_TYPE_DESCRIPTIONS]}</p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${OPP_TYPE_COLORS[recordType] ?? "bg-muted text-muted-foreground"}`}>
                {CRM_OPP_RECORD_TYPE_LABELS[recordType as keyof typeof CRM_OPP_RECORD_TYPE_LABELS]}
              </span>
            </div>

            <div className="grid gap-3">
              <div>
                <Label>Opportunity Name *</Label>
                <Input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Chicago → Dallas lanes (12 loads/wk)"
                  className="mt-1"
                  data-testid="input-opp-name"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Stage</Label>
                  <Select value={form.stage} onValueChange={v => setForm(f => ({ ...f, stage: v }))}>
                    <SelectTrigger className="mt-1" data-testid="select-opp-stage"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CRM_OPP_STAGES.map(s => <SelectItem key={s} value={s}>{CRM_OPP_STAGE_LABELS[s]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Probability %</Label>
                  <Input
                    type="number" min="0" max="100"
                    value={form.probability}
                    onChange={e => setForm(f => ({ ...f, probability: e.target.value }))}
                    placeholder="0–100"
                    className="mt-1"
                    data-testid="input-opp-prob"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Est. Revenue / Mo</Label>
                  <Input
                    value={form.amount}
                    onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="$50,000"
                    className="mt-1"
                    data-testid="input-opp-amount"
                  />
                </div>
                <div>
                  <Label>Est. Close Date</Label>
                  <Input
                    type="date"
                    value={form.closeDate}
                    onChange={e => setForm(f => ({ ...f, closeDate: e.target.value }))}
                    className="mt-1"
                    data-testid="input-opp-close"
                  />
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Key details, lane specifics, requirements…"
                  className="mt-1 min-h-[70px]"
                  data-testid="input-opp-notes"
                />
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={onClose} data-testid="button-opp-cancel">Cancel</Button>
              <Button
                onClick={() => setStep(2)}
                disabled={!recordType}
                data-testid="button-opp-next"
              >
                Next
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)} data-testid="button-opp-back">Back</Button>
              <Button
                onClick={handleSubmit}
                disabled={!form.name.trim() || createMutation.isPending}
                data-testid="button-opp-save"
              >
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Create Opportunity
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Edit Opportunity Dialog
function EditOpportunityDialog({
  opp,
  prospectId,
  onClose,
  onUpdated,
}: {
  opp: CrmOpportunity;
  prospectId: number;
  onClose: () => void;
  onUpdated: (updated: CrmOpportunity) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: opp.name,
    recordType: opp.recordType,
    stage: opp.stage,
    amount: opp.amount ?? "",
    closeDate: opp.closeDate ?? "",
    probability: opp.probability != null ? String(opp.probability) : "",
    notes: opp.notes ?? "",
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("PATCH", `/api/prospects/${prospectId}/opportunities/${opp.id}`, data).then(r => r.json()),
    onSuccess: (updated: CrmOpportunity) => { toast({ title: "Opportunity updated" }); onUpdated(updated); onClose(); },
    onError: () => toast({ title: "Failed to update opportunity", variant: "destructive" }),
  });

  function handleSubmit() {
    if (!form.name.trim()) return toast({ title: "Name is required", variant: "destructive" });
    const payload = { ...form, probability: form.probability ? parseInt(form.probability) : null };
    updateMutation.mutate(payload);
  }

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit Opportunity</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Opportunity Name *</Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1" data-testid="input-edit-opp-name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={form.recordType} onValueChange={v => setForm(f => ({ ...f, recordType: v }))}>
                <SelectTrigger className="mt-1" data-testid="select-edit-opp-type"><SelectValue /></SelectTrigger>
                <SelectContent>{CRM_OPP_RECORD_TYPES.map(rt => <SelectItem key={rt} value={rt}>{CRM_OPP_RECORD_TYPE_LABELS[rt]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Stage</Label>
              <Select value={form.stage} onValueChange={v => setForm(f => ({ ...f, stage: v }))}>
                <SelectTrigger className="mt-1" data-testid="select-edit-opp-stage"><SelectValue /></SelectTrigger>
                <SelectContent>{CRM_OPP_STAGES.map(s => <SelectItem key={s} value={s}>{CRM_OPP_STAGE_LABELS[s]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Est. Revenue / Mo</Label>
              <Input value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="$50,000" className="mt-1" data-testid="input-edit-opp-amount" />
            </div>
            <div>
              <Label>Probability %</Label>
              <Input type="number" min="0" max="100" value={form.probability} onChange={e => setForm(f => ({ ...f, probability: e.target.value }))} className="mt-1" data-testid="input-edit-opp-prob" />
            </div>
          </div>
          <div>
            <Label>Est. Close Date</Label>
            <Input type="date" value={form.closeDate} onChange={e => setForm(f => ({ ...f, closeDate: e.target.value }))} className="mt-1" data-testid="input-edit-opp-close" />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="mt-1 min-h-[60px]" data-testid="input-edit-opp-notes" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!form.name.trim() || updateMutation.isPending} data-testid="button-edit-opp-save">
            {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpportunitiesTab({ prospectId, orgId, userId, onClosedWon }: { prospectId: number; orgId: string; userId: string; onClosedWon?: () => void }) {
  const { toast } = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [editingOpp, setEditingOpp] = useState<CrmOpportunity | null>(null);

  const { data: opps = [], isLoading, refetch } = useQuery<CrmOpportunity[]>({
    queryKey: ["/api/prospects", prospectId, "opportunities"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospectId}/opportunities`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/prospects/${prospectId}/opportunities/${id}`).then(r => r.json()),
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/prospects/opportunities-summary"] }); toast({ title: "Deleted" }); },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const openOpps = opps.filter(o => o.stage !== "closed_won" && o.stage !== "closed_lost");
  const totalPipeline = openOpps.reduce((sum, o) => sum + parseAmount(o.amount), 0);

  const handleCreated = (created: CrmOpportunity) => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ["/api/prospects/opportunities-summary"] });
    // If a Closed Won opp was just created, notify the parent to prompt for status upgrade
    if (created.stage === "closed_won" && onClosedWon) onClosedWon();
  };

  const handleUpdated = (updated: CrmOpportunity) => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ["/api/prospects/opportunities-summary"] });
    // Use the freshly-returned updated opp to check for closed_won (not stale query state)
    if (updated.stage === "closed_won" && onClosedWon) onClosedWon();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Opportunities ({opps.length})
          </p>
          {totalPipeline > 0 && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold mt-0.5">
              {formatCurrency(totalPipeline)}/mo open pipeline
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setNewOpen(true)} data-testid="button-add-opportunity">
          <Plus className="h-3 w-3" />New
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : opps.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 py-6 text-center text-muted-foreground">
          <Target className="h-8 w-8 opacity-30" />
          <p className="text-sm">No opportunities yet</p>
          <p className="text-xs">Track lanes, bids, and deals</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left py-2 px-2 font-medium text-muted-foreground">Type</th>
                <th className="text-left py-2 px-2 font-medium text-muted-foreground">Stage</th>
                <th className="text-right py-2 px-2 font-medium text-muted-foreground">Amount</th>
                <th className="text-left py-2 px-2 font-medium text-muted-foreground">Close</th>
                <th className="text-right py-2 px-2 font-medium text-muted-foreground">Prob</th>
                <th className="py-2 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {opps.map(o => (
                <tr key={o.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors" data-testid={`opp-row-${o.id}`}>
                  <td className="py-2 px-3 font-medium max-w-[140px]">
                    <p className="truncate">{o.name}</p>
                    {o.notes && <p className="text-muted-foreground truncate text-[10px]">{o.notes}</p>}
                  </td>
                  <td className="py-2 px-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold whitespace-nowrap ${OPP_TYPE_COLORS[o.recordType] ?? "bg-muted text-muted-foreground"}`}>
                      {CRM_OPP_RECORD_TYPE_LABELS[o.recordType as keyof typeof CRM_OPP_RECORD_TYPE_LABELS] ?? o.recordType}
                    </span>
                  </td>
                  <td className="py-2 px-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold whitespace-nowrap ${OPP_STAGE_COLORS[o.stage] ?? "bg-muted text-muted-foreground"}`}>
                      {CRM_OPP_STAGE_LABELS[o.stage as keyof typeof CRM_OPP_STAGE_LABELS] ?? o.stage}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">
                    {o.amount ? <span className="font-medium">{o.amount}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">
                    {o.closeDate || "—"}
                  </td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">
                    {o.probability != null ? `${o.probability}%` : "—"}
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex gap-0.5 justify-end">
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditingOpp(o)} data-testid={`button-edit-opp-${o.id}`}><Pencil className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-red-500" onClick={() => { if (confirm("Delete opportunity?")) deleteMutation.mutate(o.id); }} data-testid={`button-delete-opp-${o.id}`}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {newOpen && <NewOpportunityDialog prospectId={prospectId} onClose={() => setNewOpen(false)} onCreated={handleCreated} />}
      {editingOpp && <EditOpportunityDialog opp={editingOpp} prospectId={prospectId} onClose={() => setEditingOpp(null)} onUpdated={handleUpdated} />}
    </div>
  );
}

// ─── Account History Tab ────────────────────────────────────────────────────

type CrmHistoryEntry = { id: number; prospectId: number; field: string; oldValue: string | null; newValue: string | null; changedById: string; createdAt: string };

const TRACKED_FIELD_LABELS: Record<string, string> = {
  stage: "Stage", ownerId: "Owner", priority: "Priority", estimatedSpend: "Est. Spend",
  dealProbability: "Win Probability", followUpDate: "Follow-up Date", expectedCloseDate: "Expected Close",
  name: "Name", industry: "Industry", website: "Website", notes: "Notes",
};

function AccountHistoryTab({ prospectId, users }: { prospectId: number; users: any[] }) {
  const userMap = useMemo(() => new Map(users.map((u: any) => [u.id, u.name ?? u.username])), [users]);

  const { data: history = [], isLoading } = useQuery<CrmHistoryEntry[]>({
    queryKey: ["/api/prospects", prospectId, "history"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospectId}/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  if (isLoading) return <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>;

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-6 text-center text-muted-foreground">
        <History className="h-8 w-8 opacity-30" />
        <p className="text-sm">No change history yet</p>
        <p className="text-xs">Field edits will be tracked here</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {[...history].reverse().map(h => (
        <div key={h.id} className="flex gap-2.5 text-xs" data-testid={`history-row-${h.id}`}>
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5">
            <History className="h-3 w-3 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 text-muted-foreground">
              <span className="font-medium text-foreground">{TRACKED_FIELD_LABELS[h.field] ?? h.field}</span>
              <span>changed by {userMap.get(h.changedById) ?? h.changedById}</span>
              <span>· {daysAgo(h.createdAt) === 0 ? "Today" : `${daysAgo(h.createdAt)}d ago`}</span>
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              {h.oldValue && <span className="line-through text-muted-foreground">{h.oldValue}</span>}
              {h.oldValue && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
              <span className="font-medium">{h.newValue ?? "(cleared)"}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Ownership Request Dialog ───────────────────────────────────────────────

function OwnershipRequestDialog({ prospectId, onClose }: { prospectId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const mutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/prospects/${prospectId}/ownership-request`, { reason }).then(r => r.json()),
    onSuccess: () => { toast({ title: "Ownership request submitted" }); onClose(); },
    onError: () => toast({ title: "Failed to submit request", variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Request Account Ownership</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Explain why you should be the owner of this account. An admin will review your request.</p>
        <Textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for transfer request…" className="min-h-[80px]" data-testid="input-ownership-reason" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!reason.trim() || mutation.isPending} data-testid="button-submit-ownership-request">
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProspectDetailSheet({
  prospect, onClose, users, currentUser,
}: {
  prospect: EnrichedProspect; onClose: () => void; users: any[]; currentUser: any;
}) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [lostPendingStage, setLostPendingStage] = useState<"lost" | "disqualified" | null>(null);
  const [ownershipOpen, setOwnershipOpen] = useState(false);
  const [activityType, setActivityType] = useState("call");
  const [activityNotes, setActivityNotes] = useState("");
  const [suggestActiveCustomer, setSuggestActiveCustomer] = useState(false);

  const { data: activities = [], isLoading: activitiesLoading } = useQuery<ActivityWithName[]>({
    queryKey: ["/api/prospects", prospect.id, "activities"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospect.id}/activities`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const logMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/prospects/${prospect.id}/activities`, { type: activityType, notes: activityNotes })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospect.id, "activities"] });
      setActivityNotes("");
      toast({ title: "Activity logged" });
    },
    onError: () => toast({ title: "Failed to log activity", variant: "destructive" }),
  });

  const stageMutation = useMutation({
    mutationFn: async (payload: { stage: string; lostReason?: string }) =>
      (await apiRequest("PATCH", `/api/prospects/${prospect.id}`, payload)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      // Silently generate intel brief if one doesn't exist yet (force: false = use cache)
      if (!prospect.intelBrief) {
        apiRequest("POST", `/api/prospects/${prospect.id}/intel`, { force: false }).catch(() => {});
      }
    },
    onError: () => toast({ title: "Failed to update stage", variant: "destructive" }),
  });

  const accountStatusMutation = useMutation({
    mutationFn: async (accountStatus: string) =>
      (await apiRequest("PATCH", `/api/prospects/${prospect.id}`, { accountStatus })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: "Account status updated" });
    },
    onError: () => toast({ title: "Failed to update account status", variant: "destructive" }),
  });

  // When Closed Won opp detected, prompt if status isn't already active_customer
  const handleClosedWon = () => {
    if (prospect.accountStatus !== "active_customer") {
      setSuggestActiveCustomer(true);
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async () => { await apiRequest("DELETE", `/api/prospects/${prospect.id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: "Prospect deleted" });
      onClose();
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const handleStageChange = (stage: string) => {
    if (stage === "lost" || stage === "disqualified") {
      setLostPendingStage(stage as "lost" | "disqualified");
    } else {
      stageMutation.mutate({ stage });
    }
  };

  const overdue = isOverdue(prospect.followUpDate);
  const dueToday = isDueToday(prospect.followUpDate);
  const stale = isStale(prospect);
  const daysSinceTouch = daysAgo(prospect.updatedAt as unknown as string);

  return (
    <>
      <Sheet open onOpenChange={v => { if (!v) onClose(); }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto" data-testid="sheet-prospect-detail">
          <SheetHeader className="pb-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-lg leading-tight">{prospect.name}</SheetTitle>
                {prospect.industry && <p className="text-sm text-muted-foreground mt-0.5">{prospect.industry}</p>}
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <PriorityBadge priority={prospect.priority} />
                  {prospect.dealProbability != null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-semibold">
                      {prospect.dealProbability}% likely
                    </span>
                  )}
                  {stale && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-semibold flex items-center gap-0.5">
                      <Clock className="h-2.5 w-2.5" /> Stale {daysSinceTouch}d
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {prospect.ownerId !== currentUser.id && (
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" title="Request Account Ownership" onClick={() => setOwnershipOpen(true)} data-testid="button-request-ownership"><Unlock className="h-3.5 w-3.5" /></Button>
                )}
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditOpen(true)} data-testid="button-prospect-edit"><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => { if (confirm(`Delete ${prospect.name}?`)) deleteMutation.mutate(); }} data-testid="button-prospect-delete"><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <Select value={prospect.stage} onValueChange={handleStageChange}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-detail-stage"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACTIVE_STAGES.map(s => <SelectItem key={s} value={s} className="text-xs">{PROSPECT_STAGE_LABELS[s]}</SelectItem>)}
                  <SelectItem value="lost" className="text-xs text-red-600">Mark as Lost…</SelectItem>
                  <SelectItem value="disqualified" className="text-xs text-red-600">Disqualify…</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={prospect.accountStatus ?? "prospecting"}
                onValueChange={v => accountStatusMutation.mutate(v)}
              >
                <SelectTrigger className="h-8 text-xs" data-testid="select-account-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accountStatuses.map(s => (
                    <SelectItem key={s} value={s} className="text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${ACCOUNT_STATUS_DOT[s] ?? "bg-slate-400"}`} />
                        {ACCOUNT_STATUS_LABELS[s]}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {prospect.stage === "first_load_won" && !prospect.convertedToCompanyId && (
              <Button className="w-full mt-2 bg-emerald-600 hover:bg-emerald-700 text-white gap-2" onClick={() => setConvertOpen(true)} data-testid="button-convert-to-customer">
                <Trophy className="h-4 w-4" /> Convert to Customer
              </Button>
            )}
            {prospect.convertedToCompanyId && (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 mt-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-md px-3 py-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" /><span>Converted to customer account</span>
              </div>
            )}
            {CLOSED_STAGES.includes(prospect.stage as ProspectStage) && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 mt-2 bg-red-50 dark:bg-red-900/20 rounded-md px-3 py-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{PROSPECT_STAGE_LABELS[prospect.stage as ProspectStage]}{prospect.lostReason ? ` — ${PROSPECT_LOST_REASON_LABELS[prospect.lostReason as keyof typeof PROSPECT_LOST_REASON_LABELS] ?? prospect.lostReason}` : ""}</span>
              </div>
            )}
          </SheetHeader>

          <Tabs defaultValue="overview">
            <TabsList className="w-full mb-4 flex flex-wrap h-auto gap-0.5">
              <TabsTrigger value="overview" className="flex-1 text-xs min-w-fit">Overview</TabsTrigger>
              <TabsTrigger value="opportunities" className="flex-1 text-xs min-w-fit" data-testid="tab-opportunities">Opps</TabsTrigger>
              <TabsTrigger value="contacts" className="flex-1 text-xs min-w-fit" data-testid="tab-contacts">Contacts</TabsTrigger>
              <TabsTrigger value="activity" className="flex-1 text-xs min-w-fit" data-testid="tab-activity">Activity</TabsTrigger>
              <TabsTrigger value="tms" className="flex-1 text-xs min-w-fit" data-testid="tab-tms">TMS</TabsTrigger>
              <TabsTrigger value="history" className="flex-1 text-xs min-w-fit" data-testid="tab-history">History</TabsTrigger>
              <TabsTrigger value="intel" className="flex-1 text-xs gap-1 min-w-fit" data-testid="tab-intel">
                <Sparkles className="h-3 w-3" />Intel
              </TabsTrigger>
            </TabsList>

            {/* Overview Tab */}
            <TabsContent value="overview" className="space-y-4 mt-0">
              {/* Dates */}
              <div className="grid grid-cols-2 gap-2">
                {prospect.followUpDate && (
                  <div className={`flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs col-span-${prospect.expectedCloseDate ? "1" : "2"} ${overdue ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400" : dueToday ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"}`} data-testid="text-prospect-followup">
                    <Calendar className="h-3.5 w-3.5 shrink-0" />
                    <span>Follow-up: {prospect.followUpDate}{overdue ? " ⚠" : dueToday ? " — Today" : ""}</span>
                  </div>
                )}
                {prospect.expectedCloseDate && (
                  <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs bg-muted text-muted-foreground">
                    <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                    <span>Close: {prospect.expectedCloseDate}</span>
                  </div>
                )}
              </div>

              {/* Owner + lead source */}
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <div className="flex items-center gap-1.5"><User className="h-4 w-4 shrink-0" /><span>{prospect.ownerName ?? "Unassigned"}</span></div>
                {prospect.leadSource && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                    {PROSPECT_LEAD_SOURCE_LABELS[prospect.leadSource as keyof typeof PROSPECT_LEAD_SOURCE_LABELS] ?? prospect.leadSource}
                  </span>
                )}
              </div>

              {/* Primary contact */}
              {(prospect.primaryContactName || prospect.primaryContactEmail || prospect.primaryContactPhone) && (
                <div className="border rounded-lg p-3 space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Primary Contact</p>
                  {prospect.primaryContactName && (
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span data-testid="text-prospect-contact-name">{prospect.primaryContactName}{prospect.primaryContactTitle ? ` · ${prospect.primaryContactTitle}` : ""}</span>
                    </div>
                  )}
                  {prospect.primaryContactEmail && <a href={`mailto:${prospect.primaryContactEmail}`} className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-email"><Mail className="h-3.5 w-3.5 shrink-0" />{prospect.primaryContactEmail}</a>}
                  {prospect.primaryContactPhone && <a href={`tel:${prospect.primaryContactPhone}`} className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-phone"><Phone className="h-3.5 w-3.5 shrink-0" />{prospect.primaryContactPhone}</a>}
                  {prospect.primaryContactLinkedin && <a href={prospect.primaryContactLinkedin} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-linkedin"><LinkIcon className="h-3.5 w-3.5 shrink-0" />LinkedIn Profile</a>}
                </div>
              )}

              {/* Discovery stats */}
              {(prospect.estimatedSpend || prospect.estLoadsPerWeek || prospect.currentCarrier || prospect.commodity || prospect.topLanes) && (
                <div className="border rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Discovery Intel</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {prospect.estimatedSpend && <div><span className="text-xs text-muted-foreground">Est. Spend</span><p className="font-semibold" data-testid="text-prospect-spend">{prospect.estimatedSpend}/mo</p></div>}
                    {prospect.estLoadsPerWeek && <div><span className="text-xs text-muted-foreground">Loads / Wk</span><p className="font-semibold">{prospect.estLoadsPerWeek}</p></div>}
                    {prospect.currentCarrier && <div className="col-span-2"><span className="text-xs text-muted-foreground">Current Carrier</span><p className="font-medium flex items-center gap-1"><Truck className="h-3 w-3 text-muted-foreground" />{prospect.currentCarrier}</p></div>}
                    {prospect.commodity && <div className="col-span-2"><span className="text-xs text-muted-foreground">Commodity</span><p className="font-medium">{prospect.commodity}</p></div>}
                    {prospect.topLanes && <div className="col-span-2"><span className="text-xs text-muted-foreground">Top Lanes</span><p className="font-medium">{prospect.topLanes}</p></div>}
                  </div>
                </div>
              )}

              {/* Website */}
              {prospect.website && (
                <a href={prospect.website} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-website">
                  <Globe className="h-3.5 w-3.5 shrink-0" />{prospect.website.replace(/^https?:\/\//, "")}
                </a>
              )}

              {/* Notes */}
              {prospect.notes && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Notes</p>
                  <p className="text-sm whitespace-pre-wrap text-foreground/80" data-testid="text-prospect-notes">{prospect.notes}</p>
                </div>
              )}

              {/* Pain points */}
              {prospect.painPoints && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Pain Points</p>
                  <p className="text-sm whitespace-pre-wrap text-foreground/80">{prospect.painPoints}</p>
                </div>
              )}

              {/* Next Steps */}
              {prospect.nextSteps && (
                <div className="border-l-4 border-l-amber-400 pl-3 py-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Next Steps</p>
                  <p className="text-sm whitespace-pre-wrap" data-testid="text-prospect-nextsteps">{prospect.nextSteps}</p>
                </div>
              )}
            </TabsContent>

            {/* Opportunities Tab */}
            <TabsContent value="opportunities" className="mt-0">
              <OpportunitiesTab prospectId={prospect.id} orgId={prospect.organizationId} userId={currentUser.id} onClosedWon={handleClosedWon} />
            </TabsContent>

            {/* Contacts Tab */}
            <TabsContent value="contacts" className="mt-0">
              <ContactsTab prospectId={prospect.id} />
            </TabsContent>

            {/* TMS / Portal Tab */}
            <TabsContent value="tms" className="mt-0 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">TMS / Portal Access</p>
              <div className="grid grid-cols-2 gap-3 text-sm">
                {[
                  { label: "TMS Website", value: prospect.tmsWebsite, type: "link" },
                  { label: "TMS Email", value: prospect.tmsEmail, type: "email" },
                  { label: "Scheduling Website", value: prospect.schedulingWebsite, type: "link" },
                  { label: "Scheduling Email", value: prospect.schedulingEmail, type: "email" },
                  { label: "TMS Username", value: prospect.tmsUsername, type: "text" },
                  { label: "TMS Password", value: prospect.tmsPassword, type: "password" },
                  { label: "Phone", value: prospect.phone, type: "tel" },
                  { label: "Billing Address", value: prospect.billingAddress, type: "text" },
                ].filter(f => f.value).map(f => (
                  <div key={f.label} className="col-span-2">
                    <p className="text-xs text-muted-foreground mb-0.5">{f.label}</p>
                    {f.type === "link" ? (
                      <a href={f.value!} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-xs break-all">{f.value}</a>
                    ) : f.type === "email" ? (
                      <a href={`mailto:${f.value}`} className="text-blue-600 dark:text-blue-400 hover:underline text-xs">{f.value}</a>
                    ) : f.type === "tel" ? (
                      <a href={`tel:${f.value}`} className="text-blue-600 dark:text-blue-400 hover:underline text-xs">{f.value}</a>
                    ) : f.type === "password" ? (
                      <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded select-all">{f.value}</span>
                    ) : (
                      <span className="text-xs">{f.value}</span>
                    )}
                  </div>
                ))}
              </div>
              {!prospect.tmsWebsite && !prospect.tmsEmail && !prospect.tmsUsername && !prospect.phone && (
                <div className="flex flex-col items-center gap-1.5 py-6 text-center text-muted-foreground">
                  <ServerCog className="h-8 w-8 opacity-30" />
                  <p className="text-sm">No portal details yet</p>
                  <p className="text-xs">Edit this account to add TMS / portal access info</p>
                </div>
              )}
            </TabsContent>

            {/* History Tab */}
            <TabsContent value="history" className="mt-0">
              <AccountHistoryTab prospectId={prospect.id} users={users} />
            </TabsContent>

            {/* Intel Tab */}
            <TabsContent value="intel" className="mt-0">
              <SalesIntelTab prospect={prospect} />
            </TabsContent>

            {/* Activity Tab */}
            <TabsContent value="activity" className="space-y-4 mt-0">
              {/* Log activity form */}
              <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
                <div className="flex gap-2">
                  <Select value={activityType} onValueChange={setActivityType}>
                    <SelectTrigger className="h-8 w-32 text-xs" data-testid="select-activity-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="call">Call</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="meeting">Meeting</SelectItem>
                      <SelectItem value="note">Note</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea value={activityNotes} onChange={e => setActivityNotes(e.target.value)} placeholder="What happened? What was discussed?" className="text-sm min-h-[60px]" data-testid="input-activity-notes" />
                <Button size="sm" className="h-7 text-xs gap-1.5" onClick={() => { if (activityNotes.trim()) logMutation.mutate(); }} disabled={!activityNotes.trim() || logMutation.isPending} data-testid="button-log-activity">
                  {logMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}Log
                </Button>
              </div>

              {activitiesLoading ? (
                <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
              ) : activities.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No activity logged yet.</p>
              ) : (
                <div className="space-y-2">
                  {[...activities].reverse().map(a => {
                    const Icon = ACTIVITY_ICONS[a.type] ?? NotebookPen;
                    return (
                      <div key={a.id} className="flex gap-2.5 text-sm" data-testid={`activity-row-${a.id}`}>
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5"><Icon className="h-3.5 w-3.5 text-muted-foreground" /></div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium capitalize text-xs">{a.type}</span>
                            <span className="text-xs text-muted-foreground">· {a.createdByName} · {daysAgo(a.createdAt) === 0 ? "Today" : `${daysAgo(a.createdAt)}d ago`}</span>
                          </div>
                          <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap">{a.notes}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>

      {lostPendingStage && (
        <LostReasonDialog
          stage={lostPendingStage}
          onConfirm={(reason) => {
            stageMutation.mutate({ stage: lostPendingStage, lostReason: reason });
            setLostPendingStage(null);
          }}
          onCancel={() => setLostPendingStage(null)}
        />
      )}
      {editOpen && <ProspectFormDialog open={editOpen} onClose={() => setEditOpen(false)} editing={prospect} currentUserId={currentUser.id} users={users} />}
      {convertOpen && <ConvertDialog prospect={prospect} onClose={() => setConvertOpen(false)} users={users} />}
      {ownershipOpen && <OwnershipRequestDialog prospectId={prospect.id} onClose={() => setOwnershipOpen(false)} />}

      {/* Suggest Active Customer after Closed Won opp */}
      {suggestActiveCustomer && (
        <Dialog open onOpenChange={v => { if (!v) setSuggestActiveCustomer(false); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                Closed Won — Upgrade Account Status?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              You have a Closed Won opportunity. Would you like to mark <strong>{prospect.name}</strong> as an <strong>Active Customer</strong>?
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSuggestActiveCustomer(false)}>Not now</Button>
              <Button
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => {
                  accountStatusMutation.mutate("active_customer");
                  setSuggestActiveCustomer(false);
                }}
                data-testid="button-confirm-active-customer"
              >
                Yes, Mark Active Customer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// ─── Account Status Badge ─────────────────────────────────────────────────────
const ACCOUNT_STATUS_STALE_DAYS = 14;

function AccountStatusBadge({ status, changedAt }: { status?: string | null; changedAt?: string | Date | null }) {
  const s = (status ?? "prospecting") as AccountStatus;
  const label = ACCOUNT_STATUS_LABELS[s] ?? s;
  const badge = ACCOUNT_STATUS_COLORS[s] ?? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  const dot = ACCOUNT_STATUS_DOT[s] ?? "bg-slate-400";
  const daysInStatus = changedAt
    ? Math.floor((Date.now() - new Date(changedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const isStaleStatus = daysInStatus != null && daysInStatus >= ACCOUNT_STATUS_STALE_DAYS;
  return (
    <span className="flex items-center gap-0.5 flex-wrap">
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-0.5 ${badge}`}
        data-testid="badge-account-status"
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
        {label}
      </span>
      {isStaleStatus && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 font-semibold" data-testid="badge-status-stale" title={`${daysInStatus} days in this status`}>
          {daysInStatus}d
        </span>
      )}
    </span>
  );
}

// ─── Prospect Card ────────────────────────────────────────────────────────────
function ProspectCard({ prospect, onClick, oppSummary }: { prospect: EnrichedProspect; onClick: () => void; oppSummary?: { openCount: number; closedWonCount: number; pipelineValue: number } }) {
  const stage = prospect.stage as ProspectStage;
  const overdue = isOverdue(prospect.followUpDate);
  const dueToday = isDueToday(prospect.followUpDate);
  const stale = isStale(prospect);
  const daysSinceTouch = daysAgo(prospect.updatedAt as unknown as string);

  return (
    <div
      className={`bg-card border border-border border-t-4 ${STAGE_BORDER[stage] ?? "border-t-slate-400"} ${stale ? "border-l-2 border-l-amber-400" : ""} rounded-lg p-3 cursor-pointer hover:shadow-md transition-shadow space-y-2`}
      onClick={onClick}
      data-testid={`prospect-card-${prospect.id}`}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="font-semibold text-sm leading-tight flex-1 min-w-0">{prospect.name}</p>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      </div>

      {/* Account status + priority + probability */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <AccountStatusBadge status={prospect.accountStatus} changedAt={prospect.accountStatusChangedAt} />
        <PriorityBadge priority={prospect.priority} />
        {prospect.dealProbability != null && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-semibold" data-testid={`prob-badge-${prospect.id}`}>
            {prospect.dealProbability}%
          </span>
        )}
      </div>

      {prospect.primaryContactName && (
        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
          <User className="h-3 w-3 shrink-0" />
          {prospect.primaryContactName}{prospect.primaryContactTitle ? ` · ${prospect.primaryContactTitle}` : ""}
        </p>
      )}

      {prospect.estimatedSpend && (
        <p className="text-xs text-muted-foreground">~{prospect.estimatedSpend}/mo</p>
      )}

      {/* Opportunity summary */}
      {oppSummary && (oppSummary.openCount > 0 || oppSummary.closedWonCount > 0) && (
        <div className="flex items-center gap-2 text-[10px]">
          {oppSummary.openCount > 0 && (
            <span className="text-blue-600 dark:text-blue-400 flex items-center gap-0.5" data-testid={`opp-count-${prospect.id}`}>
              <Target className="h-2.5 w-2.5" />{oppSummary.openCount} open
            </span>
          )}
          {oppSummary.pipelineValue > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold" data-testid={`pipeline-value-${prospect.id}`}>
              {formatCurrency(oppSummary.pipelineValue)}/mo
            </span>
          )}
          {oppSummary.closedWonCount > 0 && (
            <span className="text-emerald-700 dark:text-emerald-300 flex items-center gap-0.5">
              <CheckCircle2 className="h-2.5 w-2.5" />{oppSummary.closedWonCount} won
            </span>
          )}
        </div>
      )}

      {prospect.currentCarrier && (
        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
          <Truck className="h-3 w-3 shrink-0" /> vs {prospect.currentCarrier}
        </p>
      )}

      {prospect.expectedCloseDate && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-0.5" data-testid={`close-date-badge-${prospect.id}`}>
          <TrendingUp className="h-2.5 w-2.5 shrink-0" /> Close: {prospect.expectedCloseDate}
        </p>
      )}

      <div className="flex items-center justify-between pt-0.5 gap-2">
        {stale ? (
          <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5" data-testid={`stale-badge-${prospect.id}`}>
            <Clock className="h-2.5 w-2.5" /> {daysSinceTouch}d stale
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">{daysSinceTouch === 0 ? "Updated today" : `${daysSinceTouch}d ago`}</span>
        )}
        {prospect.followUpDate && (
          <span className={`text-[10px] flex items-center gap-0.5 ${overdue ? "text-red-500" : dueToday ? "text-amber-500" : "text-muted-foreground"}`} data-testid={`followup-badge-${prospect.id}`}>
            <Calendar className="h-2.5 w-2.5" />
            {overdue ? "Overdue" : dueToday ? "Due today" : prospect.followUpDate}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Admin: Ownership Requests Panel ─────────────────────────────────────────

type OwnershipRequest = { id: number; prospectId: number; requesterId: string; currentOwnerId: string; status: string; reason?: string | null; adminNote?: string | null; createdAt: string };

function OwnershipRequestsAdminPanel({ onClose, users, prospects: allProspects }: { onClose: () => void; users: any[]; prospects: EnrichedProspect[] }) {
  const { toast } = useToast();
  const userMap = useMemo(() => new Map(users.map((u: any) => [u.id, u.name ?? u.username])), [users]);
  const prospectMap = useMemo(() => new Map(allProspects.map(p => [p.id, p.name])), [allProspects]);
  const [adminNotes, setAdminNotes] = useState<Record<number, string>>({});

  const { data: requests = [], isLoading, refetch } = useQuery<OwnershipRequest[]>({
    queryKey: ["/api/launchpad/ownership-requests"],
    queryFn: async () => {
      const res = await fetch("/api/launchpad/ownership-requests", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const pending = requests.filter(r => r.status === "pending");

  const reviewMutation = useMutation({
    mutationFn: ({ id, status, adminNote }: { id: number; status: string; adminNote?: string }) =>
      apiRequest("PATCH", `/api/launchpad/ownership-requests/${id}/review`, { status, adminNote }).then(r => r.json()),
    onSuccess: () => { refetch(); toast({ title: "Request reviewed" }); },
    onError: () => toast({ title: "Failed to review request", variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Account Ownership Requests</DialogTitle></DialogHeader>

        {isLoading ? <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div> : pending.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <ShieldCheck className="h-8 w-8 opacity-30" />
            <p className="text-sm">No pending ownership requests</p>
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map(r => (
              <div key={r.id} className="border rounded-lg p-3 space-y-2" data-testid={`ownership-req-${r.id}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <p className="font-semibold text-sm">{prospectMap.get(r.prospectId) ?? `Account #${r.prospectId}`}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">{userMap.get(r.requesterId) ?? r.requesterId}</span> wants to take over from <span className="font-medium">{userMap.get(r.currentOwnerId) ?? r.currentOwnerId}</span>
                    </p>
                    {r.reason && <p className="text-xs mt-1 italic text-foreground/70">"{r.reason}"</p>}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{daysAgo(r.createdAt) === 0 ? "Today" : `${daysAgo(r.createdAt)}d ago`}</span>
                </div>
                <Input
                  placeholder="Admin note (optional)"
                  value={adminNotes[r.id] ?? ""}
                  onChange={e => setAdminNotes(n => ({ ...n, [r.id]: e.target.value }))}
                  className="h-7 text-xs"
                  data-testid={`input-admin-note-${r.id}`}
                />
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1" onClick={() => reviewMutation.mutate({ id: r.id, status: "approved", adminNote: adminNotes[r.id] })} data-testid={`button-approve-${r.id}`}>
                    <CheckCircle className="h-3 w-3" />Approve
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-600 border-red-300" onClick={() => reviewMutation.mutate({ id: r.id, status: "denied", adminNote: adminNotes[r.id] })} data-testid={`button-deny-${r.id}`}>
                    <XCircle className="h-3 w-3" />Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {requests.filter(r => r.status !== "pending").length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Reviewed</p>
            <div className="space-y-2">
              {requests.filter(r => r.status !== "pending").slice(-5).map(r => (
                <div key={r.id} className="flex items-center gap-2 text-xs text-muted-foreground p-2 rounded-md bg-muted/30">
                  {r.status === "approved" ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" /> : <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />}
                  <span><span className="font-medium text-foreground">{userMap.get(r.requesterId)}</span> → <span className="font-medium text-foreground">{prospectMap.get(r.prospectId) ?? "Account"}</span> — <span className="capitalize">{r.status}</span></span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const PROSPECTS_ALLOWED_ROLES = ["admin", "sales", "sales_director"];

export default function ProspectsPage() {
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<EnrichedProspect | null>(null);
  const [lostOpen, setLostOpen] = useState(false);
  const [adminOwnershipOpen, setAdminOwnershipOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"kanban" | "table">("kanban");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOwner, setFilterOwner] = useState("all");
  const [filterPriority, setFilterPriority] = useState("all");
  const [filterLeadSource, setFilterLeadSource] = useState("all");
  const [filterAccountStatus, setFilterAccountStatus] = useState("all");
  const [tableSortField, setTableSortField] = useState<"name" | "accountStatus" | "openOpps" | "pipeline" | "lastActivity">("name");
  const [tableSortDir, setTableSortDir] = useState<"asc" | "desc">("asc");

  const { data: prospects = [], isLoading } = useQuery<EnrichedProspect[]>({
    queryKey: ["/api/prospects"],
  });

  const { data: allUsers = [] } = useQuery<any[]>({
    queryKey: ["/api/users"],
  });

  const { data: oppsSummary = {} } = useQuery<Record<number, { openCount: number; closedWonCount: number; pipelineValue: number }>>({
    queryKey: ["/api/prospects/opportunities-summary"],
    queryFn: async () => {
      const res = await fetch("/api/prospects/opportunities-summary", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
  });

  const ownerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    prospects.forEach(p => { if (p.ownerId && p.ownerName) seen.set(p.ownerId, p.ownerName); });
    return Array.from(seen.entries());
  }, [prospects]);

  const filtered = useMemo(() => prospects.filter(p => {
    if (filterOwner !== "all" && p.ownerId !== filterOwner) return false;
    if (filterPriority !== "all" && p.priority !== filterPriority) return false;
    if (filterLeadSource !== "all" && p.leadSource !== filterLeadSource) return false;
    if (filterAccountStatus !== "all" && (p.accountStatus ?? "prospecting") !== filterAccountStatus) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!p.name.toLowerCase().includes(q) && !(p.industry ?? "").toLowerCase().includes(q) && !(p.primaryContactName ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [prospects, filterOwner, filterPriority, filterLeadSource, filterAccountStatus, searchQuery]);

  const tableSorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (tableSortField) {
        case "accountStatus": {
          const order = ["prospecting", "intro_scheduled", "active_customer", "dormant", "lost"];
          cmp = (order.indexOf(a.accountStatus ?? "prospecting")) - (order.indexOf(b.accountStatus ?? "prospecting"));
          break;
        }
        case "openOpps":
          cmp = (oppsSummary[a.id]?.openCount ?? 0) - (oppsSummary[b.id]?.openCount ?? 0);
          break;
        case "pipeline":
          cmp = (oppsSummary[a.id]?.pipelineValue ?? 0) - (oppsSummary[b.id]?.pipelineValue ?? 0);
          break;
        case "lastActivity":
          cmp = new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime();
          break;
        default:
          cmp = a.name.localeCompare(b.name);
      }
      return tableSortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, tableSortField, tableSortDir, oppsSummary]);

  if (!user || !PROSPECTS_ALLOWED_ROLES.includes(user.role ?? "")) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="font-semibold">Access Restricted</p>
        <p className="text-sm text-muted-foreground">The sales pipeline is only accessible to sales team members.</p>
      </div>
    );
  }

  const activeProspects = filtered.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && !p.convertedToCompanyId);
  const closedProspects = filtered.filter(p => CLOSED_STAGES.includes(p.stage as ProspectStage));

  const byStage = (stage: ProspectStage) => activeProspects.filter(p => p.stage === stage);

  const totalActive = prospects.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && !p.convertedToCompanyId).length;
  const overdueCount = prospects.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && isOverdue(p.followUpDate)).length;
  const dueTodayCount = prospects.filter(p => !CLOSED_STAGES.includes(p.stage as ProspectStage) && isDueToday(p.followUpDate)).length;
  const wonCount = prospects.filter(p => p.stage === "first_load_won").length;

  const totalWeightedValue = activeProspects.reduce((sum, p) => sum + weightedValue(p), 0);

  const isSalesDirectorOrAdmin = user.role === "admin" || user.role === "sales_director";

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-6 h-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold">Launchpad</h1>
          <p className="text-sm text-muted-foreground">
            Prospects from first contact to first load
            {totalWeightedValue > 0 && <> · <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{formatCurrency(totalWeightedValue)} weighted</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center border rounded-md overflow-hidden">
            <button
              className={`px-2 py-1.5 flex items-center gap-1 text-xs transition-colors ${viewMode === "kanban" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => setViewMode("kanban")}
              data-testid="button-view-kanban"
            >
              <Kanban className="h-3.5 w-3.5" />Board
            </button>
            <button
              className={`px-2 py-1.5 flex items-center gap-1 text-xs border-l transition-colors ${viewMode === "table" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => setViewMode("table")}
              data-testid="button-view-table"
            >
              <LayoutList className="h-3.5 w-3.5" />List
            </button>
          </div>
          {isSalesDirectorOrAdmin && (
            <Button variant="outline" onClick={() => setAdminOwnershipOpen(true)} className="gap-2 relative" data-testid="button-admin-ownership">
              <ShieldCheck className="h-4 w-4" /> Transfers
            </Button>
          )}
          <Button variant="outline" onClick={() => setImportOpen(true)} className="gap-2" data-testid="button-import-prospects">
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button onClick={() => setAddOpen(true)} className="gap-2" data-testid="button-add-prospect">
            <Plus className="h-4 w-4" /> Add Account
          </Button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Active Prospects", value: totalActive, icon: Building2, color: "text-blue-600 dark:text-blue-400" },
          { label: "Due Today", value: dueTodayCount, icon: Clock, color: "text-amber-600 dark:text-amber-400" },
          { label: "Overdue Follow-ups", value: overdueCount, icon: AlertCircle, color: "text-red-600 dark:text-red-400" },
          { label: "First Loads Won", value: wonCount, icon: Trophy, color: "text-emerald-600 dark:text-emerald-400" },
        ].map(stat => (
          <Card key={stat.label} className="p-3" data-testid={`stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <div className="flex items-center gap-2">
              <stat.icon className={`h-4 w-4 shrink-0 ${stat.color}`} />
              <div>
                <p className="text-lg font-bold leading-none">{stat.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search accounts…"
            className="h-7 pl-7 text-xs w-44"
            data-testid="input-search-prospects"
          />
        </div>
        <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {isSalesDirectorOrAdmin && (
          <Select value={filterOwner} onValueChange={setFilterOwner}>
            <SelectTrigger className="h-7 text-xs w-36" data-testid="filter-owner"><SelectValue placeholder="All reps" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reps</SelectItem>
              {ownerOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={filterPriority} onValueChange={setFilterPriority}>
          <SelectTrigger className="h-7 text-xs w-28" data-testid="filter-priority"><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            <SelectItem value="hot">🔴 Hot</SelectItem>
            <SelectItem value="warm">🟡 Warm</SelectItem>
            <SelectItem value="cold">🔵 Cold</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterLeadSource} onValueChange={setFilterLeadSource}>
          <SelectTrigger className="h-7 text-xs w-36" data-testid="filter-lead-source"><SelectValue placeholder="Lead source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {PROSPECT_LEAD_SOURCES.map(s => <SelectItem key={s} value={s}>{PROSPECT_LEAD_SOURCE_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterAccountStatus} onValueChange={setFilterAccountStatus}>
          <SelectTrigger className="h-7 text-xs w-36" data-testid="filter-account-status"><SelectValue placeholder="Account status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {accountStatuses.map(s => (
              <SelectItem key={s} value={s}>
                <span className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${ACCOUNT_STATUS_DOT[s] ?? "bg-slate-400"}`} />
                  {ACCOUNT_STATUS_LABELS[s]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(filterOwner !== "all" || filterPriority !== "all" || filterLeadSource !== "all" || filterAccountStatus !== "all") && (
          <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={() => { setFilterOwner("all"); setFilterPriority("all"); setFilterLeadSource("all"); setFilterAccountStatus("all"); }}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Board or List view */}
      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {ACTIVE_STAGES.map(s => (
            <div key={s} className="flex-shrink-0 w-64 space-y-2">
              <Skeleton className="h-6 w-32" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      ) : viewMode === "kanban" ? (
        <div className="flex gap-4 overflow-x-auto pb-4 flex-1 min-h-0">
          {ACTIVE_STAGES.map(stage => {
            const cards = byStage(stage as ProspectStage);
            const stageLabel = PROSPECT_STAGE_LABELS[stage as ProspectStage];
            const isWon = stage === "first_load_won";
            const colWeighted = cards.reduce((sum, p) => sum + weightedValue(p), 0);

            return (
              <div key={stage} className="flex-shrink-0 w-64 flex flex-col gap-2" data-testid={`kanban-column-${stage}`}>
                {/* Column header */}
                <div className="px-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {isWon && <Trophy className="h-3.5 w-3.5 text-emerald-500" />}
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{stageLabel}</span>
                    </div>
                    {cards.length > 0 && (
                      <Badge variant="secondary" className="text-[10px] font-semibold h-4 px-1.5">{cards.length}</Badge>
                    )}
                  </div>
                  {colWeighted > 0 && (
                    <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-0.5 font-medium">{formatCurrency(colWeighted)} weighted</p>
                  )}
                </div>

                {/* Cards */}
                <div className="flex flex-col gap-2 flex-1 min-h-[120px] bg-muted/20 rounded-lg p-2">
                  {cards.length === 0 ? (
                    <div className="flex items-center justify-center h-16 text-xs text-muted-foreground/50">Empty</div>
                  ) : (
                    cards.map(p => <ProspectCard key={p.id} prospect={p} onClick={() => setSelected(p)} oppSummary={oppsSummary[p.id]} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Table / List View */
        <div className="rounded-lg border overflow-hidden flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                {([
                  { key: "name", label: "Account" },
                  { key: "accountStatus", label: "Account Status" },
                  { key: "stage", label: "Stage" },
                  { key: "owner", label: "Owner" },
                  { key: "priority", label: "Priority" },
                  { key: "openOpps", label: "Open Opps" },
                  { key: "pipeline", label: "Pipeline" },
                  { key: "followUp", label: "Follow-up" },
                  { key: "lastActivity", label: "Last Activity" },
                ] as const).map(col => {
                  const sortable = ["name", "accountStatus", "openOpps", "pipeline", "lastActivity"].includes(col.key);
                  const isActive = tableSortField === col.key;
                  return (
                    <TableHead
                      key={col.key}
                      className={`text-xs py-2 ${sortable ? "cursor-pointer select-none hover:bg-muted/60" : ""}`}
                      onClick={sortable ? () => {
                        if (isActive) setTableSortDir(d => d === "asc" ? "desc" : "asc");
                        else { setTableSortField(col.key as typeof tableSortField); setTableSortDir("asc"); }
                      } : undefined}
                      data-testid={sortable ? `th-sort-${col.key}` : undefined}
                    >
                      <span className="flex items-center gap-1">
                        {col.label}
                        {isActive && <span className="text-[10px]">{tableSortDir === "asc" ? "↑" : "↓"}</span>}
                      </span>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableSorted.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground text-sm py-8">No accounts match your filters</TableCell></TableRow>
              )}
              {tableSorted.map(p => {
                const overdue = isOverdue(p.followUpDate);
                const dueToday = isDueToday(p.followUpDate);
                const summary = oppsSummary[p.id];
                return (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => setSelected(p)}
                    data-testid={`table-row-${p.id}`}
                  >
                    <TableCell className="py-2">
                      <div>
                        <p className="font-medium text-sm">{p.name}</p>
                        {p.industry && <p className="text-xs text-muted-foreground">{p.industry}</p>}
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <AccountStatusBadge status={p.accountStatus} changedAt={p.accountStatusChangedAt} />
                    </TableCell>
                    <TableCell className="py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${STAGE_BORDER[p.stage]?.replace("border-t-", "text-").replace("-400", "-600").replace("-500", "-600") ?? ""} bg-muted`}>
                        {PROSPECT_STAGE_LABELS[p.stage as ProspectStage]}
                      </span>
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">{p.ownerName ?? "—"}</TableCell>
                    <TableCell className="py-2">
                      {p.priority === "hot" && <span className="text-[10px] font-semibold text-red-600">🔴 Hot</span>}
                      {p.priority === "warm" && <span className="text-[10px] font-semibold text-amber-600">🟡 Warm</span>}
                      {p.priority === "cold" && <span className="text-[10px] font-semibold text-blue-600">🔵 Cold</span>}
                      {!p.priority && <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {summary?.openCount ? (
                        <span className="text-blue-600 font-medium" data-testid={`table-opp-count-${p.id}`}>{summary.openCount}</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {summary?.pipelineValue ? (
                        <span className="text-emerald-600 font-semibold" data-testid={`table-pipeline-${p.id}`}>{formatCurrency(summary.pipelineValue)}/mo</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {p.followUpDate ? (
                        <span className={overdue ? "text-red-600 font-medium" : dueToday ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                          {p.followUpDate}{overdue ? " ⚠" : dueToday ? " · Today" : ""}
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      {daysAgo(p.updatedAt as unknown as string)}d ago
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Lost / Disqualified accordion */}
      {closedProspects.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/40 hover:bg-muted/60 text-sm font-medium transition-colors"
            onClick={() => setLostOpen(v => !v)}
            data-testid="button-toggle-lost"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-500" />
              <span>Lost / Disqualified <span className="text-muted-foreground font-normal">({closedProspects.length})</span></span>
            </div>
            {lostOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
          {lostOpen && (
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 border-t bg-background">
              {closedProspects.map(p => (
                <div
                  key={p.id}
                  className="border rounded-lg p-3 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setSelected(p)}
                  data-testid={`lost-card-${p.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-sm text-muted-foreground">{p.name}</p>
                      {p.industry && <p className="text-xs text-muted-foreground">{p.industry}</p>}
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0 text-red-600 border-red-300 dark:text-red-400 dark:border-red-700">
                      {PROSPECT_STAGE_LABELS[p.stage as ProspectStage]}
                    </Badge>
                  </div>
                  {p.lostReason && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {PROSPECT_LOST_REASON_LABELS[p.lostReason as keyof typeof PROSPECT_LOST_REASON_LABELS] ?? p.lostReason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add dialog */}
      {addOpen && <ProspectFormDialog open={addOpen} onClose={() => setAddOpen(false)} currentUserId={user.id} users={allUsers} />}

      {/* Import dialog */}
      {importOpen && <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />}

      {/* Admin ownership requests panel */}
      {adminOwnershipOpen && <OwnershipRequestsAdminPanel onClose={() => setAdminOwnershipOpen(false)} users={allUsers} prospects={prospects} />}

      {/* Detail sheet */}
      {selected && <ProspectDetailSheet prospect={selected} onClose={() => setSelected(null)} users={allUsers} currentUser={user} />}
    </div>
  );
}
