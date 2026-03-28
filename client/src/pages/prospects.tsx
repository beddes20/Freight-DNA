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
  Truck, Clock, Upload, Sparkles, RefreshCw, FileUp, CheckCircle, XCircle,
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
    // New qualifying fields
    leadSource: "", currentCarrier: "", estLoadsPerWeek: "",
    topLanes: "", commodity: "", painPoints: "",
    priority: "", expectedCloseDate: "", dealProbability: "",
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
            <p className="text-sm text-muted-foreground">Upload a CSV or Excel file exported from ZoomInfo, LinkedIn Sales Navigator, or any spreadsheet.</p>
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
            <Button onClick={handleClose} data-testid="button-import-done">Done</Button>
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

// ─── Prospect Detail Sheet ────────────────────────────────────────────────────
function ProspectDetailSheet({
  prospect, onClose, users, currentUser,
}: {
  prospect: EnrichedProspect; onClose: () => void; users: any[]; currentUser: any;
}) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [lostPendingStage, setLostPendingStage] = useState<"lost" | "disqualified" | null>(null);
  const [activityType, setActivityType] = useState("call");
  const [activityNotes, setActivityNotes] = useState("");

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/prospects"] }),
    onError: () => toast({ title: "Failed to update stage", variant: "destructive" }),
  });

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
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditOpen(true)} data-testid="button-prospect-edit"><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => { if (confirm(`Delete ${prospect.name}?`)) deleteMutation.mutate(); }} data-testid="button-prospect-delete"><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>

            <div className="mt-3">
              <Select value={prospect.stage} onValueChange={handleStageChange}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-detail-stage"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACTIVE_STAGES.map(s => <SelectItem key={s} value={s} className="text-xs">{PROSPECT_STAGE_LABELS[s]}</SelectItem>)}
                  <SelectItem value="lost" className="text-xs text-red-600">Mark as Lost…</SelectItem>
                  <SelectItem value="disqualified" className="text-xs text-red-600">Disqualify…</SelectItem>
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
            <TabsList className="w-full mb-4">
              <TabsTrigger value="overview" className="flex-1 text-xs">Overview</TabsTrigger>
              <TabsTrigger value="contacts" className="flex-1 text-xs" data-testid="tab-contacts">Contacts</TabsTrigger>
              <TabsTrigger value="activity" className="flex-1 text-xs" data-testid="tab-activity">Activity</TabsTrigger>
              <TabsTrigger value="intel" className="flex-1 text-xs gap-1" data-testid="tab-intel">
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

            {/* Contacts Tab */}
            <TabsContent value="contacts" className="mt-0">
              <ContactsTab prospectId={prospect.id} />
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
    </>
  );
}

// ─── Prospect Card ────────────────────────────────────────────────────────────
function ProspectCard({ prospect, onClick }: { prospect: EnrichedProspect; onClick: () => void }) {
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

      {/* Priority + probability */}
      <div className="flex items-center gap-1.5 flex-wrap">
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

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ProspectsPage() {
  const { user } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<EnrichedProspect | null>(null);
  const [lostOpen, setLostOpen] = useState(false);
  const [filterOwner, setFilterOwner] = useState("all");
  const [filterPriority, setFilterPriority] = useState("all");
  const [filterLeadSource, setFilterLeadSource] = useState("all");

  const { data: prospects = [], isLoading } = useQuery<EnrichedProspect[]>({
    queryKey: ["/api/prospects"],
  });

  const { data: allUsers = [] } = useQuery<any[]>({
    queryKey: ["/api/users"],
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
    return true;
  }), [prospects, filterOwner, filterPriority, filterLeadSource]);

  if (!user || !["admin", "sales", "sales_director"].includes(user.role ?? "")) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="font-semibold">Access Restricted</p>
        <p className="text-sm text-muted-foreground">The sales pipeline is only accessible to the sales team.</p>
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
          <h1 className="text-xl font-bold">Sales Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Prospects from first contact to first load
            {totalWeightedValue > 0 && <> · <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{formatCurrency(totalWeightedValue)} weighted</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)} className="gap-2" data-testid="button-import-prospects">
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button onClick={() => setAddOpen(true)} className="gap-2" data-testid="button-add-prospect">
            <Plus className="h-4 w-4" /> Add Prospect
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
        {(filterOwner !== "all" || filterPriority !== "all" || filterLeadSource !== "all") && (
          <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={() => { setFilterOwner("all"); setFilterPriority("all"); setFilterLeadSource("all"); }}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Kanban board */}
      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {ACTIVE_STAGES.map(s => (
            <div key={s} className="flex-shrink-0 w-64 space-y-2">
              <Skeleton className="h-6 w-32" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      ) : (
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
                    cards.map(p => <ProspectCard key={p.id} prospect={p} onClick={() => setSelected(p)} />)
                  )}
                </div>
              </div>
            );
          })}
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

      {/* Detail sheet */}
      {selected && <ProspectDetailSheet prospect={selected} onClose={() => setSelected(null)} users={allUsers} currentUser={user} />}
    </div>
  );
}
