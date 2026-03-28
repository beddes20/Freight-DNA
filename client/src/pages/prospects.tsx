import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus, Phone, Mail, MessageSquare, Calendar, Building2, User, Globe,
  ChevronRight, Clock, ArrowRight, Trophy, Pencil, Trash2, PhoneCall,
  Send, NotebookPen, Users, AlertCircle, CheckCircle2, Loader2, X, Link as LinkIcon,
} from "lucide-react";
import type { Prospect, ProspectStage } from "@shared/schema";
import { PROSPECT_STAGE_LABELS, prospectStages } from "@shared/schema";
import { useLocation } from "wouter";

type EnrichedProspect = Prospect & { ownerName?: string | null; assignedNamName?: string | null };
type ActivityWithName = { id: number; type: string; notes: string; createdByName: string; createdAt: string };

const STAGE_COLORS: Record<ProspectStage, string> = {
  new_lead:          "border-t-slate-400",
  intro_scheduled:   "border-t-blue-400",
  intro_completed:   "border-t-indigo-400",
  follow_up:         "border-t-amber-400",
  opportunity_sent:  "border-t-orange-400",
  first_load_won:    "border-t-emerald-500",
};

const STAGE_BADGE: Record<ProspectStage, string> = {
  new_lead:          "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  intro_scheduled:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  intro_completed:   "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  follow_up:         "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  opportunity_sent:  "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  first_load_won:    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
};

const ACTIVITY_ICONS: Record<string, any> = {
  call: PhoneCall,
  email: Mail,
  text: MessageSquare,
  meeting: Users,
  note: NotebookPen,
};

function daysAgo(dateStr: string): number {
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

// ─── Add / Edit Prospect Dialog ───────────────────────────────────────────────
function ProspectFormDialog({
  open,
  onClose,
  editing,
  currentUserId,
  users,
}: {
  open: boolean;
  onClose: () => void;
  editing?: EnrichedProspect | null;
  currentUserId: string;
  users: any[];
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<Record<string, string>>({});
  const isEdit = !!editing;

  const initial = editing ? {
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
  } : {
    name: "", industry: "", website: "", estimatedSpend: "",
    primaryContactName: "", primaryContactTitle: "", primaryContactEmail: "",
    primaryContactPhone: "", primaryContactLinkedin: "",
    notes: "", nextSteps: "", followUpDate: "",
    stage: "new_lead", ownerId: currentUserId,
  };

  const [values, setValues] = useState(initial);

  const set = (k: string, v: string) => setValues(prev => ({ ...prev, [k]: v }));

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/prospects", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: "Prospect added!" });
      onClose();
    },
    onError: () => toast({ title: "Failed to add prospect", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", `/api/prospects/${editing!.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: "Prospect updated" });
      onClose();
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const handleSubmit = () => {
    if (!values.name.trim()) return toast({ title: "Company name is required", variant: "destructive" });
    const payload = { ...values };
    if (isEdit) updateMutation.mutate(payload);
    else createMutation.mutate(payload);
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Prospect" : "Add New Prospect"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
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

          <div className="col-span-2 border-t pt-3 mt-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Primary Contact</p>
          </div>
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

          <div className="col-span-2 border-t pt-3 mt-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Pipeline Details</p>
          </div>
          <div>
            <Label>Stage</Label>
            <Select value={values.stage} onValueChange={v => set("stage", v)}>
              <SelectTrigger className="mt-1" data-testid="select-prospect-stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {prospectStages.map(s => (
                  <SelectItem key={s} value={s}>{PROSPECT_STAGE_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Follow-up Date</Label>
            <Input data-testid="input-prospect-followup" type="date" value={values.followUpDate} onChange={e => set("followUpDate", e.target.value)} className="mt-1" />
          </div>
          <div className="col-span-2">
            <Label>Notes</Label>
            <Textarea data-testid="input-prospect-notes" value={values.notes} onChange={e => set("notes", e.target.value)} placeholder="Background on this prospect…" className="mt-1 min-h-[80px]" />
          </div>
          <div className="col-span-2">
            <Label>Next Steps</Label>
            <Textarea data-testid="input-prospect-nextsteps" value={values.nextSteps} onChange={e => set("nextSteps", e.target.value)} placeholder="Send intro email, schedule discovery call…" className="mt-1 min-h-[60px]" />
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
function ConvertDialog({
  prospect,
  onClose,
  users,
}: {
  prospect: EnrichedProspect;
  onClose: () => void;
  users: any[];
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [namId, setNamId] = useState("");

  const nams = users.filter(u => ["national_account_manager", "account_manager"].includes(u.role));

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/prospects/${prospect.id}/convert`, { assignedNamId: namId || null });
      return res.json();
    },
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
          <DialogTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-emerald-500" />
            Convert to Customer
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">{prospect.name}</strong> will become a full customer account in the CRM. All pipeline data will be archived.
          </p>
          <div>
            <Label>Assign NAM (optional)</Label>
            <Select value={namId} onValueChange={setNamId}>
              <SelectTrigger className="mt-1" data-testid="select-convert-nam">
                <SelectValue placeholder="Select a NAM or AM…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No assignment yet</SelectItem>
                {nams.map(u => (
                  <SelectItem key={u.id} value={u.id}>{u.name} ({u.role.replace(/_/g, " ")})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-convert-cancel">Cancel</Button>
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            data-testid="button-convert-confirm"
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trophy className="h-4 w-4 mr-2" />}
            Convert to Customer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Prospect Detail Sheet ────────────────────────────────────────────────────
function ProspectDetailSheet({
  prospect,
  onClose,
  users,
  currentUser,
}: {
  prospect: EnrichedProspect;
  onClose: () => void;
  users: any[];
  currentUser: any;
}) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [activityType, setActivityType] = useState("call");
  const [activityNotes, setActivityNotes] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const { data: activities = [], isLoading: activitiesLoading } = useQuery<ActivityWithName[]>({
    queryKey: ["/api/prospects", prospect.id, "activities"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospect.id}/activities`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch activities");
      return res.json();
    },
  });

  const logMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/prospects/${prospect.id}/activities`, { type: activityType, notes: activityNotes });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospect.id, "activities"] });
      setActivityNotes("");
      toast({ title: "Activity logged" });
    },
    onError: () => toast({ title: "Failed to log activity", variant: "destructive" }),
  });

  const stageMutation = useMutation({
    mutationFn: async (stage: string) => {
      const res = await apiRequest("PATCH", `/api/prospects/${prospect.id}`, { stage });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/prospects"] }),
    onError: () => toast({ title: "Failed to update stage", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/prospects/${prospect.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      toast({ title: "Prospect deleted" });
      onClose();
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const overdue = isOverdue(prospect.followUpDate);
  const dueToday = isDueToday(prospect.followUpDate);

  return (
    <>
      <Sheet open onOpenChange={v => { if (!v) onClose(); }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto" data-testid="sheet-prospect-detail">
          <SheetHeader className="pb-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-lg leading-tight">{prospect.name}</SheetTitle>
                {prospect.industry && (
                  <p className="text-sm text-muted-foreground mt-0.5">{prospect.industry}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditOpen(true)} data-testid="button-prospect-edit">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon" variant="ghost"
                  className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                  onClick={() => { if (confirm(`Delete ${prospect.name}?`)) deleteMutation.mutate(); }}
                  data-testid="button-prospect-delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Stage selector */}
            <div className="mt-3">
              <Select value={prospect.stage} onValueChange={v => stageMutation.mutate(v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-detail-stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {prospectStages.map(s => (
                    <SelectItem key={s} value={s} className="text-xs">{PROSPECT_STAGE_LABELS[s as ProspectStage]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Convert to Customer */}
            {prospect.stage === "first_load_won" && !prospect.convertedToCompanyId && (
              <Button
                className="w-full mt-2 bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                onClick={() => setConvertOpen(true)}
                data-testid="button-convert-to-customer"
              >
                <Trophy className="h-4 w-4" /> Convert to Customer
              </Button>
            )}
            {prospect.convertedToCompanyId && (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 mt-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-md px-3 py-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Converted to customer account</span>
              </div>
            )}
          </SheetHeader>

          <div className="space-y-5">
            {/* Follow-up */}
            {prospect.followUpDate && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm ${overdue ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400" : dueToday ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"}`} data-testid="text-prospect-followup">
                <Calendar className="h-4 w-4 shrink-0" />
                <span>Follow-up: {prospect.followUpDate}{overdue ? " — Overdue" : dueToday ? " — Today" : ""}</span>
              </div>
            )}

            {/* Owner */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4 shrink-0" />
              <span>{prospect.ownerName ?? "Unassigned"}</span>
            </div>

            {/* Contact info */}
            {(prospect.primaryContactName || prospect.primaryContactEmail || prospect.primaryContactPhone) && (
              <div className="border rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Primary Contact</p>
                {prospect.primaryContactName && (
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span data-testid="text-prospect-contact-name">{prospect.primaryContactName}{prospect.primaryContactTitle ? ` · ${prospect.primaryContactTitle}` : ""}</span>
                  </div>
                )}
                {prospect.primaryContactEmail && (
                  <a href={`mailto:${prospect.primaryContactEmail}`} className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-email">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    {prospect.primaryContactEmail}
                  </a>
                )}
                {prospect.primaryContactPhone && (
                  <a href={`tel:${prospect.primaryContactPhone}`} className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-phone">
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    {prospect.primaryContactPhone}
                  </a>
                )}
                {prospect.primaryContactLinkedin && (
                  <a href={prospect.primaryContactLinkedin} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-linkedin">
                    <LinkIcon className="h-3.5 w-3.5 shrink-0" />
                    LinkedIn Profile
                  </a>
                )}
              </div>
            )}

            {/* Est. spend + website */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {prospect.estimatedSpend && (
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Est. Freight Spend</p>
                  <p className="font-semibold" data-testid="text-prospect-spend">{prospect.estimatedSpend}</p>
                </div>
              )}
              {prospect.website && (
                <div className="border rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Website</p>
                  <a href={prospect.website} target="_blank" rel="noreferrer" className="font-medium text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 truncate" data-testid="link-prospect-website">
                    <Globe className="h-3 w-3 shrink-0" />
                    <span className="truncate">{prospect.website.replace(/^https?:\/\//, "")}</span>
                  </a>
                </div>
              )}
            </div>

            {/* Notes */}
            {prospect.notes && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Notes</p>
                <p className="text-sm whitespace-pre-wrap text-foreground/80" data-testid="text-prospect-notes">{prospect.notes}</p>
              </div>
            )}

            {/* Next Steps */}
            {prospect.nextSteps && (
              <div className="border-l-4 border-l-amber-400 pl-3 py-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Next Steps</p>
                <p className="text-sm whitespace-pre-wrap" data-testid="text-prospect-nextsteps">{prospect.nextSteps}</p>
              </div>
            )}

            {/* Activity Log */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Activity Log</p>

              {/* Log activity form */}
              <div className="border rounded-lg p-3 space-y-2 mb-4 bg-muted/30">
                <div className="flex gap-2">
                  <Select value={activityType} onValueChange={setActivityType}>
                    <SelectTrigger className="h-8 w-32 text-xs" data-testid="select-activity-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="call">Call</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="meeting">Meeting</SelectItem>
                      <SelectItem value="note">Note</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea
                  value={activityNotes}
                  onChange={e => setActivityNotes(e.target.value)}
                  placeholder="What happened? What was discussed?"
                  className="text-sm min-h-[60px]"
                  data-testid="input-activity-notes"
                />
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => { if (activityNotes.trim()) logMutation.mutate(); }}
                  disabled={!activityNotes.trim() || logMutation.isPending}
                  data-testid="button-log-activity"
                >
                  {logMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Log
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
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5">
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
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
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {editOpen && (
        <ProspectFormDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          editing={prospect}
          currentUserId={currentUser.id}
          users={users}
        />
      )}
      {convertOpen && (
        <ConvertDialog
          prospect={prospect}
          onClose={() => setConvertOpen(false)}
          users={users}
        />
      )}
    </>
  );
}

// ─── Prospect Card ────────────────────────────────────────────────────────────
function ProspectCard({ prospect, onClick }: { prospect: EnrichedProspect; onClick: () => void }) {
  const stage = prospect.stage as ProspectStage;
  const overdue = isOverdue(prospect.followUpDate);
  const dueToday = isDueToday(prospect.followUpDate);
  const daysSince = daysAgo(prospect.createdAt as unknown as string);

  return (
    <div
      className={`bg-card border border-border border-t-4 ${STAGE_COLORS[stage] ?? "border-t-slate-400"} rounded-lg p-3 cursor-pointer hover:shadow-md transition-shadow space-y-2`}
      onClick={onClick}
      data-testid={`prospect-card-${prospect.id}`}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="font-semibold text-sm leading-tight">{prospect.name}</p>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
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

      <div className="flex items-center justify-between pt-1 gap-2">
        <span className="text-[10px] text-muted-foreground">{daysSince === 0 ? "Added today" : `${daysSince}d in pipeline`}</span>
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
  const [selected, setSelected] = useState<EnrichedProspect | null>(null);

  const { data: prospects = [], isLoading } = useQuery<EnrichedProspect[]>({
    queryKey: ["/api/prospects"],
  });

  const { data: allUsers = [] } = useQuery<any[]>({
    queryKey: ["/api/users"],
  });

  if (!user || !["admin", "sales", "sales_director"].includes(user.role ?? "")) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="font-semibold">Access Restricted</p>
        <p className="text-sm text-muted-foreground">The sales pipeline is only accessible to the sales team.</p>
      </div>
    );
  }

  const byStage = (stage: ProspectStage) => prospects.filter(p => p.stage === stage && !p.convertedToCompanyId);
  const totalActive = prospects.filter(p => !p.convertedToCompanyId).length;
  const overdueCount = prospects.filter(p => !p.convertedToCompanyId && isOverdue(p.followUpDate)).length;
  const dueTodayCount = prospects.filter(p => !p.convertedToCompanyId && isDueToday(p.followUpDate)).length;
  const wonCount = prospects.filter(p => p.stage === "first_load_won").length;

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-6 h-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold">Sales Pipeline</h1>
          <p className="text-sm text-muted-foreground">Prospects from first contact to first load</p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="gap-2" data-testid="button-add-prospect">
          <Plus className="h-4 w-4" /> Add Prospect
        </Button>
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

      {/* Kanban board */}
      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {prospectStages.map(s => (
            <div key={s} className="flex-shrink-0 w-64 space-y-2">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-6 flex-1 min-h-0">
          {prospectStages.map(stage => {
            const cards = byStage(stage as ProspectStage);
            const stageLabel = PROSPECT_STAGE_LABELS[stage as ProspectStage];
            const isWon = stage === "first_load_won";
            return (
              <div key={stage} className="flex-shrink-0 w-64 flex flex-col gap-2" data-testid={`kanban-column-${stage}`}>
                {/* Column header */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    {isWon && <Trophy className="h-3.5 w-3.5 text-emerald-500" />}
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{stageLabel}</span>
                  </div>
                  {cards.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] font-semibold h-4 px-1.5">{cards.length}</Badge>
                  )}
                </div>

                {/* Cards */}
                <div className="flex flex-col gap-2 flex-1 min-h-[120px] bg-muted/20 rounded-lg p-2">
                  {cards.length === 0 ? (
                    <div className="flex items-center justify-center h-16 text-xs text-muted-foreground/50">
                      Empty
                    </div>
                  ) : (
                    cards.map(p => (
                      <ProspectCard key={p.id} prospect={p} onClick={() => setSelected(p)} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add dialog */}
      {addOpen && (
        <ProspectFormDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          currentUserId={user.id}
          users={allUsers}
        />
      )}

      {/* Detail sheet */}
      {selected && (
        <ProspectDetailSheet
          prospect={selected}
          onClose={() => setSelected(null)}
          users={allUsers}
          currentUser={user}
        />
      )}
    </div>
  );
}
