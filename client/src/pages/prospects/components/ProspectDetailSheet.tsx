import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Mail, User, Globe, Calendar, TrendingUp, Truck, Clock, Loader2, LinkIcon,
  Send, NotebookPen, CheckCircle2, AlertCircle, PhoneCall, MessageSquare, Phone,
  Pencil, Trash2, ServerCog, Sparkles, Unlock, Trophy,
} from "lucide-react";
import type { ProspectStage } from "@shared/schema";
import {
  PROSPECT_STAGE_LABELS, PROSPECT_LEAD_SOURCE_LABELS, PROSPECT_LOST_REASON_LABELS,
  accountStatuses,
} from "@shared/schema";
import { isOverdue, isDueToday, isStale, daysAgo } from "../utils";
import { ACTIVE_STAGES, CLOSED_STAGES, ACCOUNT_STATUS_DOT, ACTIVITY_ICONS, type EnrichedProspect, type ActivityWithName } from "../types";
import { PriorityBadge } from "./PriorityBadge";
import { LostReasonDialog } from "./LostReasonDialog";
import { ProspectFormDialog } from "./ProspectFormDialog";
import { ConvertDialog } from "./ConvertDialog";
import { OwnershipRequestDialog } from "./OwnershipRequestDialog";
import { AdminReassignOwnerSection } from "./AdminReassignOwnerSection";
import { OpportunitiesTab } from "./OpportunitiesTab";
import { ContactsTab } from "./ContactsTab";
import { AccountHistoryTab } from "./AccountHistoryTab";
import { SalesIntelTab } from "./SalesIntelTab";

export function ProspectDetailSheet({
  prospect, onClose, users, currentUser,
  activeStages: stagesOverride, stageLabels: stageLabelsOverride,
  leadSources: leadSourcesOverride, staleThreshold, requiredFields: requiredFieldsOverride,
}: {
  prospect: EnrichedProspect; onClose: () => void; users: any[]; currentUser: any;
  activeStages?: ProspectStage[];
  stageLabels?: Record<string, string>;
  leadSources?: Array<{ key: string; label: string }>;
  staleThreshold?: number;
  requiredFields?: Record<string, boolean>;
}) {
  const resolvedActiveStages = stagesOverride ?? ACTIVE_STAGES;
  const resolvedStageLabels: Record<string, string> = stageLabelsOverride ?? (PROSPECT_STAGE_LABELS as Record<string, string>);
  const resolvedRequiredFields = requiredFieldsOverride ?? {};
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [lostPendingStage, setLostPendingStage] = useState<"lost" | "disqualified" | null>(null);
  const [ownershipOpen, setOwnershipOpen] = useState(false);
  const [activityType, setActivityType] = useState("call");
  const [activityNotes, setActivityNotes] = useState("");
  const [suggestActiveCustomer, setSuggestActiveCustomer] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailTo, setEmailTo] = useState("");

  const { data: activities = [], isLoading: activitiesLoading } = useQuery<ActivityWithName[]>({
    queryKey: ["/api/prospects", prospect.id, "activities"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospect.id}/activities`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const logMutation = useMutation({
    mutationFn: async () => {
      let notes = activityNotes;
      if (activityType === "email") {
        const parts: string[] = [];
        if (emailSubject.trim()) parts.push(`Subject: ${emailSubject.trim()}`);
        if (emailTo.trim()) parts.push(`To: ${emailTo.trim()}`);
        if (activityNotes.trim()) parts.push(`\n${activityNotes.trim()}`);
        notes = parts.join("\n");
      }
      return (await apiRequest("POST", `/api/prospects/${prospect.id}/activities`, { type: activityType, notes })).json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospect.id, "activities"] });
      setActivityNotes(""); setEmailSubject(""); setEmailTo("");
      toast({ title: "Activity logged" });
    },
    onError: () => toast({ title: "Failed to log activity", variant: "destructive" }),
  });

  const stageMutation = useMutation({
    mutationFn: async (payload: { stage: string; lostReason?: string }) =>
      (await apiRequest("PATCH", `/api/prospects/${prospect.id}`, payload)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      if (!prospect.intelBrief) {
        apiRequest("POST", `/api/prospects/${prospect.id}/intel`, { force: false }).catch(() => {});
      }
    },
    onError: () => toast({ title: "Failed to update stage", variant: "destructive" }),
  });

  const accountStatusMutation = useMutation({
    mutationFn: async (accountStatus: string) =>
      (await apiRequest("PATCH", `/api/prospects/${prospect.id}`, { accountStatus })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/prospects"] }); toast({ title: "Account status updated" }); },
    onError: () => toast({ title: "Failed to update account status", variant: "destructive" }),
  });

  const handleClosedWon = () => {
    if (prospect.accountStatus !== "active_customer") setSuggestActiveCustomer(true);
  };

  const deleteMutation = useMutation({
    mutationFn: async () => { await apiRequest("DELETE", `/api/prospects/${prospect.id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/prospects"] }); toast({ title: "Prospect deleted" }); onClose(); },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const handleStageChange = (stage: string) => {
    if (stage === "lost" || stage === "disqualified") setLostPendingStage(stage as "lost" | "disqualified");
    else stageMutation.mutate({ stage });
  };

  const overdue = isOverdue(prospect.followUpDate);
  const dueToday = isDueToday(prospect.followUpDate);
  const stale = isStale(prospect, staleThreshold);
  const daysSinceTouch = daysAgo(prospect.updatedAt as unknown as string);
  const isAdmin = currentUser.role === "admin" || currentUser.role === "sales_director";

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
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-semibold">{prospect.dealProbability}% likely</span>
                  )}
                  {stale && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 font-semibold flex items-center gap-0.5">
                      <Clock className="h-2.5 w-2.5" /> Stale {daysSinceTouch}d
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {prospect.ownerId !== currentUser.id && !isAdmin && (
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
                  {resolvedActiveStages.map(s => <SelectItem key={s} value={s} className="text-xs">{resolvedStageLabels[s] ?? PROSPECT_STAGE_LABELS[s]}</SelectItem>)}
                  <SelectItem value="lost" className="text-xs text-red-600">Mark as Lost…</SelectItem>
                  <SelectItem value="disqualified" className="text-xs text-red-600">Disqualify…</SelectItem>
                </SelectContent>
              </Select>
              <Select value={prospect.accountStatus ?? "prospecting"} onValueChange={v => accountStatusMutation.mutate(v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-account-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {accountStatuses.map(s => (
                    <SelectItem key={s} value={s} className="text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${ACCOUNT_STATUS_DOT[s] ?? "bg-slate-400"}`} />
                        {s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
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
                <span>{resolvedStageLabels[prospect.stage] || prospect.stage}{prospect.lostReason ? ` — ${PROSPECT_LOST_REASON_LABELS[prospect.lostReason as keyof typeof PROSPECT_LOST_REASON_LABELS] ?? prospect.lostReason}` : ""}</span>
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
              <TabsTrigger value="intel" className="flex-1 text-xs gap-1 min-w-fit" data-testid="tab-intel"><Sparkles className="h-3 w-3" />Intel</TabsTrigger>
            </TabsList>

            {/* Overview Tab */}
            <TabsContent value="overview" className="space-y-4 mt-0">
              <div className="grid grid-cols-2 gap-2">
                {prospect.followUpDate && (
                  <div className={`flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs ${prospect.expectedCloseDate ? "" : "col-span-2"} ${overdue ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400" : dueToday ? "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground"}`} data-testid="text-prospect-followup">
                    <Calendar className="h-3.5 w-3.5 shrink-0" />
                    <span>Follow-up: {prospect.followUpDate}{overdue ? " ⚠" : dueToday ? " — Today" : ""}</span>
                  </div>
                )}
                {prospect.expectedCloseDate && (
                  <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-md text-xs bg-muted text-muted-foreground">
                    <TrendingUp className="h-3.5 w-3.5 shrink-0" /><span>Close: {prospect.expectedCloseDate}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <div className="flex items-center gap-1.5"><User className="h-4 w-4 shrink-0" /><span>{prospect.ownerName ?? "Unassigned"}</span></div>
                {prospect.leadSource && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                    {PROSPECT_LEAD_SOURCE_LABELS[prospect.leadSource as keyof typeof PROSPECT_LEAD_SOURCE_LABELS] ?? prospect.leadSource}
                  </span>
                )}
              </div>

              <AdminReassignOwnerSection prospect={prospect} users={users} currentUser={currentUser} />

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

              {prospect.website && (
                <a href={prospect.website} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline" data-testid="link-prospect-website">
                  <Globe className="h-3.5 w-3.5 shrink-0" />{prospect.website.replace(/^https?:\/\//, "")}
                </a>
              )}

              {prospect.notes && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Notes</p>
                  <p className="text-sm whitespace-pre-wrap text-foreground/80" data-testid="text-prospect-notes">{prospect.notes}</p>
                </div>
              )}

              {prospect.painPoints && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Pain Points</p>
                  <p className="text-sm whitespace-pre-wrap text-foreground/80">{prospect.painPoints}</p>
                </div>
              )}

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
                {([
                  { label: "TMS Website", value: prospect.tmsWebsite, type: "link" },
                  { label: "TMS Email", value: prospect.tmsEmail, type: "email" },
                  { label: "Scheduling Website", value: prospect.schedulingWebsite, type: "link" },
                  { label: "Scheduling Email", value: prospect.schedulingEmail, type: "email" },
                  { label: "TMS Username", value: prospect.tmsUsername, type: "text" },
                  { label: "TMS Password", value: prospect.tmsPassword, type: "password" },
                  { label: "Phone", value: prospect.phone, type: "tel" },
                  { label: "Billing Address", value: prospect.billingAddress, type: "text" },
                ] as const).filter(f => f.value).map(f => (
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
              <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
                <div className="flex gap-2">
                  <Select value={activityType} onValueChange={v => { setActivityType(v); setEmailSubject(""); setEmailTo(""); }}>
                    <SelectTrigger className="h-8 w-32 text-xs" data-testid="select-activity-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="call">Call</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="meeting">Meeting</SelectItem>
                      <SelectItem value="note">Note</SelectItem>
                      <SelectItem value="text">Text</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {activityType === "email" && (
                  <div className="space-y-1.5">
                    <Input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} placeholder="Subject (optional)" className="h-7 text-xs" data-testid="input-email-subject" />
                    <Input value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="To: recipient@company.com (optional)" className="h-7 text-xs" data-testid="input-email-to" />
                  </div>
                )}
                <Textarea value={activityNotes} onChange={e => setActivityNotes(e.target.value)} placeholder={activityType === "email" ? "Email body / summary…" : "What happened? What was discussed?"} className="text-sm min-h-[60px]" data-testid="input-activity-notes" />
                <Button size="sm" className="h-7 text-xs gap-1.5" onClick={() => {
                  const hasContent = activityType === "email"
                    ? (emailSubject.trim() || emailTo.trim() || activityNotes.trim())
                    : activityNotes.trim();
                  if (hasContent) logMutation.mutate();
                }} disabled={!(activityType === "email" ? (emailSubject.trim() || emailTo.trim() || activityNotes.trim()) : activityNotes.trim()) || logMutation.isPending} data-testid="button-log-activity">
                  {logMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}Log
                </Button>
              </div>

              {activitiesLoading ? (
                <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
              ) : activities.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No activity logged yet.</p>
              ) : (
                <div className="space-y-2">
                  {[...activities].reverse().map(a => {
                    const Icon = ACTIVITY_ICONS[a.type] ?? NotebookPen;
                    const isEmail = a.type === "email";
                    let emailSubjectLine = "";
                    let emailToLine = "";
                    let emailBody = a.notes || "";
                    if (isEmail && a.notes) {
                      const lines = a.notes.split("\n");
                      const subjectLine = lines.find(l => l.startsWith("Subject: "));
                      const toLine = lines.find(l => l.startsWith("To: "));
                      if (subjectLine) emailSubjectLine = subjectLine.replace("Subject: ", "");
                      if (toLine) emailToLine = toLine.replace("To: ", "");
                      const bodyStart = lines.findIndex((l, i) => i > 0 && !l.startsWith("Subject: ") && !l.startsWith("To: ") && l.trim() !== "");
                      emailBody = bodyStart !== -1 ? lines.slice(bodyStart).join("\n").trim() : "";
                    }
                    return (
                      <div key={a.id} className={`flex gap-2.5 text-sm rounded-lg p-2 ${isEmail ? "bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40" : ""}`} data-testid={`activity-row-${a.id}`}>
                        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full mt-0.5 ${isEmail ? "bg-blue-100 dark:bg-blue-900/40" : "bg-muted"}`}>
                          <Icon className={`h-3.5 w-3.5 ${isEmail ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {isEmail && emailSubjectLine ? (
                              <span className="font-semibold text-xs text-blue-800 dark:text-blue-200 truncate max-w-[200px]">{emailSubjectLine}</span>
                            ) : (
                              <span className="font-medium capitalize text-xs">{a.type}</span>
                            )}
                            <span className="text-xs text-muted-foreground">· {a.createdByName} · {daysAgo(a.createdAt) === 0 ? "Today" : `${daysAgo(a.createdAt)}d ago`}</span>
                          </div>
                          {isEmail && emailToLine && (
                            <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-0.5 flex items-center gap-1"><Mail className="h-2.5 w-2.5 shrink-0" />To: {emailToLine}</p>
                          )}
                          {emailBody && <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap">{emailBody}</p>}
                          {!isEmail && a.notes && <p className="text-xs text-foreground/80 mt-0.5 whitespace-pre-wrap">{a.notes}</p>}
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
          onConfirm={reason => { stageMutation.mutate({ stage: lostPendingStage, lostReason: reason }); setLostPendingStage(null); }}
          onCancel={() => setLostPendingStage(null)}
        />
      )}
      {editOpen && <ProspectFormDialog open={editOpen} onClose={() => setEditOpen(false)} editing={prospect} currentUserId={currentUser.id} users={users} activeStages={resolvedActiveStages} stageLabels={resolvedStageLabels} leadSources={leadSourcesOverride} requiredFields={resolvedRequiredFields} />}
      {convertOpen && <ConvertDialog prospect={prospect} onClose={() => setConvertOpen(false)} users={users} />}
      {ownershipOpen && <OwnershipRequestDialog prospectId={prospect.id} onClose={() => setOwnershipOpen(false)} />}

      {suggestActiveCustomer && (
        <Dialog open onOpenChange={v => { if (!v) setSuggestActiveCustomer(false); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-500" />Closed Won — Upgrade Account Status?</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">You have a Closed Won opportunity. Would you like to mark <strong>{prospect.name}</strong> as an <strong>Active Customer</strong>?</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSuggestActiveCustomer(false)}>Not now</Button>
              <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => { accountStatusMutation.mutate("active_customer"); setSuggestActiveCustomer(false); }} data-testid="button-confirm-active-customer">
                Yes, Mark Active Customer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
