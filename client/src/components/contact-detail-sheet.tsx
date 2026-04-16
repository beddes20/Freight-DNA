import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Phone, Mail, MapPin, Route, DollarSign, FileText, PhoneCall, Copy, Check,
  MessageSquare, Laptop, Building2, Plus, Trash2, Clock, CalendarDays, ListTodo, X, History, Send, Star,
  ChevronDown, ChevronUp, Globe,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateAfterTouchpoint } from "@/lib/invalidations";
import { useToast } from "@/hooks/use-toast";
import type { Contact, Touchpoint } from "@shared/schema";
import { FileAttachmentUpload, FileAttachmentList, uploadPendingFiles, type PendingFile } from "@/components/file-attachment";
import { ContactLaneManager } from "@/components/relationship-freight-portlet";
import { OutlookComposeDialog } from "@/components/outlook-compose-dialog";
import { useWebexStatus, useWebexPresenceBatch, getPresenceStyle } from "@/hooks/use-webex";
import { WebexDisabledHint } from "@/components/webex-disabled-hint";
import { Video } from "lucide-react";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TYPE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  call:       { label: "Call",       icon: PhoneCall,    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  email:      { label: "Email",      icon: Mail,         color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
  text:       { label: "Text",       icon: MessageSquare, color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  site_visit: { label: "Site Visit", icon: Building2,    color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
};

function touchRecency(tps: Touchpoint[]) {
  if (tps.length === 0) return null;
  const latest = tps.reduce((a, b) => a.date > b.date ? a : b);
  const today = new Date();
  const d = new Date(latest.date + "T00:00:00");
  const diff = Math.floor((today.getTime() - d.getTime()) / 86400000);
  return { diff, type: latest.type, date: latest.date };
}

function recencyBadge(tps: Touchpoint[]) {
  const r = touchRecency(tps);
  if (!r) return <span className="text-xs text-muted-foreground">No touchpoints yet</span>;
  const cfg = TYPE_CONFIG[r.type] ?? { label: r.type, color: "bg-muted text-muted-foreground" };
  let color = "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (r.diff > 30) color = "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  else if (r.diff > 7) color = "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  const label = r.diff === 0 ? "Today" : r.diff === 1 ? "Yesterday" : `${r.diff}d ago`;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>
      {cfg.label} · {label}
    </span>
  );
}

function countThisWeek(tps: Touchpoint[]) {
  const start = new Date();
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  const startStr = start.toISOString().split("T")[0];
  return tps.filter(t => t.date >= startStr).length;
}

function countThisMonth(tps: Touchpoint[]) {
  const now = new Date();
  const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return tps.filter(t => t.date >= startStr).length;
}

interface ContactDetailSheetProps {
  contact: Contact | null;
  open: boolean;
  onClose: () => void;
  onEdit?: (c: Contact) => void;
  onDeleted?: () => void;
}

export function ContactDetailSheet({ contact, open, onClose, onEdit, onDeleted }: ContactDetailSheetProps) {
  const { toast } = useToast();
  const [logType, setLogType] = useState("call");
  const [logNotes, setLogNotes] = useState("");
  const [logMeaningful, setLogMeaningful] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showDeleteContactConfirm, setShowDeleteContactConfirm] = useState(false);
  const [tpPendingFiles, setTpPendingFiles] = useState<PendingFile[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const webexConfigured = useWebexStatus();
  const contactPhones = contact?.phone ? [contact.phone] : [];
  const presenceMap = useWebexPresenceBatch(contactPhones, webexConfigured && !!contact?.phone);

  function copyToClipboard(value: string, field: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    });
  }

  const { data: touchpoints = [], isLoading } = useQuery<Touchpoint[]>({
    queryKey: ["/api/contacts", contact?.id, "touchpoints"],
    enabled: !!contact?.id && open,
  });

  const { data: baseHistory = [] } = useQuery<{ id: number; fromBase: string | null; toBase: string; changedAt: string; changedByName: string | null }[]>({
    queryKey: ["/api/contacts", contact?.id, "base-history"],
    queryFn: () => fetch(`/api/contacts/${contact!.id}/base-history`, { credentials: "include" }).then(r => r.json()),
    enabled: !!contact?.id && open,
  });

  const logMutation = useMutation({
    mutationFn: async () => {
      const today = new Date().toISOString().split("T")[0];
      const res = await apiRequest("POST", `/api/contacts/${contact!.id}/touchpoints`, {
        type: logType,
        date: today,
        notes: logNotes.trim() || null,
        isMeaningful: logMeaningful,
      });
      const tp = await res.json();
      if (tpPendingFiles.length > 0) {
        try {
          await uploadPendingFiles(tpPendingFiles, "touchpoint", tp.id);
        } catch {
          toast({ title: "Touchpoint logged but some files failed to upload", variant: "destructive" });
        }
      }
      return tp;
    },
    onSuccess: () => {
      invalidateAfterTouchpoint(contact?.companyId);
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contact?.id, "touchpoints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/cold-contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      setLogNotes("");
      setLogMeaningful(false);
      setTpPendingFiles([]);
      toast({ title: "Touchpoint logged" });
    },
    onError: () => toast({ title: "Failed to log touchpoint", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/touchpoints/${id}`),
    onSuccess: () => {
      invalidateAfterTouchpoint(contact?.companyId);
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contact?.id, "touchpoints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/cold-contacts"] });
      setDeleteTarget(null);
      toast({ title: "Touchpoint deleted" });
    },
  });

  const deleteContactMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/contacts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", contact?.companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact deleted" });
      setShowDeleteContactConfirm(false);
      onDeleted?.();
      onClose();
    },
    onError: () => toast({ title: "Failed to delete contact", variant: "destructive" }),
  });

  const toggleMeaningfulMutation = useMutation({
    mutationFn: async ({ id, isMeaningful }: { id: string; isMeaningful: boolean }) => {
      const res = await apiRequest("PATCH", `/api/touchpoints/${id}`, { isMeaningful });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts", contact?.id, "touchpoints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companies", contact?.companyId, "touchpoints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/cold-contacts"] });
    },
    onError: () => toast({ title: "Failed to update touchpoint", variant: "destructive" }),
  });

  if (!contact) return null;

  const initials = contact.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  const weekCount = countThisWeek(touchpoints);
  const monthCount = countThisMonth(touchpoints);

  const baseConfig: Record<string, { label: string; className: string }> = {
    "1st":     { label: "1st Base", className: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400" },
    "2nd":     { label: "2nd Base", className: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400" },
    "3rd":     { label: "3rd Base", className: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400" },
    "homerun": { label: "Home Run", className: "bg-green-700 text-white dark:bg-green-800 dark:text-green-100" },
  };
  const baseKey = contact.relationshipBase
    ? Object.keys(baseConfig).find(k => contact.relationshipBase?.toLowerCase().startsWith(k))
    : null;
  const base = baseKey ? baseConfig[baseKey] : null;

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto" data-testid="contact-detail-sheet">
          <SheetHeader className="pb-4">
            <div className="flex items-center justify-between">
              <SheetTitle>Contact Detail</SheetTitle>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} data-testid="button-close-contact-sheet" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </SheetHeader>

          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <Avatar className="h-14 w-14 shrink-0">
                <AvatarFallback className="bg-primary/10 text-primary text-lg font-semibold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold" data-testid="text-detail-contact-name">{contact.name}</h2>
                  {base && <Badge className={`text-[10px] px-1.5 py-0 ${base.className}`}>{base.label}</Badge>}
                </div>
                {contact.title && <p className="text-sm text-muted-foreground">{contact.title}</p>}
                <div className="mt-1">{recencyBadge(touchpoints)}</div>
              </div>
              <div className="flex items-center gap-2">
                {onEdit && (
                  <Button size="sm" variant="outline" onClick={() => { onEdit(contact); onClose(); }} data-testid="button-edit-contact-sheet">
                    Edit
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-destructive hover:bg-destructive/10"
                  onClick={() => setShowDeleteContactConfirm(true)}
                  title="Delete contact"
                  data-testid="button-delete-contact-sheet"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-2xl font-bold">{weekCount}</p>
                <p className="text-xs text-muted-foreground mt-0.5">This Week</p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 text-center">
                <p className="text-2xl font-bold">{monthCount}</p>
                <p className="text-xs text-muted-foreground mt-0.5">This Month</p>
              </div>
            </div>

            {(contact.email || contact.phone) && (
              <div className="space-y-2">
                {contact.email && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 group">
                      <a href={`mailto:${contact.email}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground flex-1 min-w-0">
                        <Mail className="h-4 w-4 shrink-0" />
                        <span className="truncate">{contact.email}</span>
                      </a>
                      <button
                        onClick={() => copyToClipboard(contact.email!, "email")}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                        title="Copy email"
                        data-testid="button-copy-email"
                      >
                        {copiedField === "email" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full gap-2 text-blue-600 border-blue-200 hover:bg-blue-50 hover:border-blue-400 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-950/40"
                      onClick={() => setComposeOpen(true)}
                      data-testid="button-send-outlook-email"
                    >
                      <Send className="h-3.5 w-3.5" />
                      Send Email
                    </Button>
                  </div>
                )}
                {contact.phone && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 group">
                      <a href={`tel:${contact.phone}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground flex-1 min-w-0">
                        <Phone className="h-4 w-4 shrink-0" />
                        <span>{contact.phone}</span>
                      </a>
                      {webexConfigured && (() => {
                        const ps = getPresenceStyle(presenceMap[contact.phone!] ?? "unknown");
                        return (
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full ${ps.dot}`}
                            title={`Webex: ${ps.label}`}
                            data-testid="presence-dot-detail"
                          />
                        );
                      })()}
                      <button
                        onClick={() => copyToClipboard(contact.phone!, "phone")}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                        title="Copy phone"
                        data-testid="button-copy-phone"
                      >
                        {copiedField === "phone" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {webexConfigured && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full gap-2 text-green-600 border-green-200 hover:bg-green-50 hover:border-green-400 dark:text-green-400 dark:border-green-800 dark:hover:bg-green-950/40"
                        onClick={() => window.open(`webextel://${contact.phone!.replace(/[^0-9+]/g, "")}`, "_self")}
                        data-testid="button-webex-call-detail"
                      >
                        <Video className="h-3.5 w-3.5" />
                        Call via Webex
                      </Button>
                    )}
                    {!webexConfigured && (
                      <WebexDisabledHint className="px-1" testId="hint-webex-disabled-detail" />
                    )}
                  </div>
                )}
              </div>
            )}

            {contact.regions && contact.regions.length > 0 && (
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex flex-wrap gap-1">
                  {contact.regions.map((r, i) => <Badge key={i} variant="secondary" className="text-xs">{r}</Badge>)}
                </div>
              </div>
            )}

            {contact.lanes && contact.lanes.length > 0 && (
              <div className="flex items-start gap-2">
                <Route className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex flex-wrap gap-1">
                  {contact.lanes.map((l, i) => <Badge key={i} variant="outline" className="text-xs">{l}</Badge>)}
                </div>
              </div>
            )}

            {contact.freightSpend && (
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">${Number(contact.freightSpend).toLocaleString()}</span>
                <span className="text-xs text-muted-foreground">annual freight spend</span>
              </div>
            )}

            {contact.spotBiddingProcess && (
              <div className="flex items-start gap-2">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">{contact.spotBiddingProcess}</p>
              </div>
            )}

            {contact.nextSteps && (
              <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 flex items-start gap-2">
                <ListTodo className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 mb-0.5">Next Steps</p>
                  <p className="text-sm text-amber-800 dark:text-amber-200">{contact.nextSteps}</p>
                </div>
              </div>
            )}

            {contact.notes && (
              <div className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                {contact.notes}
              </div>
            )}

            <Separator />

            <GeographicLaneResponsibilities contactId={contact.id} />

            <Separator />

            <ContactLaneManager contactId={contact.id} />

            {baseHistory.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <h3 className="font-medium flex items-center gap-2 text-sm">
                    <History className="h-4 w-4 text-muted-foreground" />
                    Relationship Advancement History
                  </h3>
                  <div className="space-y-1">
                    {baseHistory.map((entry) => (
                      <div key={entry.id} className="flex items-center gap-2 text-xs" data-testid={`base-history-${entry.id}`}>
                        <span className="text-muted-foreground w-24 shrink-0">
                          {new Date(entry.changedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                        <span className="text-muted-foreground">{entry.fromBase ?? "Unset"}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-medium text-foreground">{entry.toBase}</span>
                        {entry.changedByName && (
                          <span className="text-muted-foreground ml-auto shrink-0">by {entry.changedByName}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <Separator />

            <div className="space-y-3">
              <h3 className="font-medium flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Log Touchpoint
              </h3>
              <div className="flex gap-2">
                <Select value={logType} onValueChange={setLogType}>
                  <SelectTrigger className="w-36" data-testid="select-touchpoint-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="call">Call</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="site_visit">Site Visit</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => logMutation.mutate()}
                  disabled={logMutation.isPending}
                  data-testid="button-log-touchpoint"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Log
                </Button>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
                <input
                  type="checkbox"
                  checked={logMeaningful}
                  onChange={e => setLogMeaningful(e.target.checked)}
                  className="rounded"
                  data-testid="checkbox-meaningful"
                />
                <span className="text-muted-foreground">Meaningful conversation?</span>
              </label>
              <Textarea
                placeholder="Optional note..."
                value={logNotes}
                onChange={e => setLogNotes(e.target.value)}
                className="text-sm resize-none"
                rows={2}
                data-testid="input-touchpoint-notes"
              />
              <FileAttachmentUpload
                pendingFiles={tpPendingFiles}
                onAdd={(files) => setTpPendingFiles(prev => [...prev, ...files])}
                onRemove={(i) => setTpPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                compact
              />
            </div>

            <Separator />

            <div className="space-y-3">
              <h3 className="font-medium flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                History
                {touchpoints.length > 0 && (
                  <Badge variant="secondary" className="ml-1 text-xs">{touchpoints.length}</Badge>
                )}
              </h3>

              {isLoading && (
                <div className="space-y-2">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
                  ))}
                </div>
              )}

              {!isLoading && touchpoints.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">No touchpoints yet. Log your first one above.</p>
              )}

              <div className="space-y-2">
                {touchpoints.map((tp) => {
                  const cfg = TYPE_CONFIG[tp.type] ?? { label: tp.type, icon: PhoneCall, color: "bg-muted text-muted-foreground" };
                  const Icon = cfg.icon;
                  const dateObj = new Date(tp.date + "T00:00:00");
                  const dateLabel = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  return (
                    <div key={tp.id} className="flex items-start gap-3 p-2 rounded-md hover:bg-muted/40 group" data-testid={`touchpoint-row-${tp.id}`}>
                      <span className={`mt-0.5 inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ${cfg.color}`}>
                        <Icon className="h-3 w-3" />
                        {cfg.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-muted-foreground">{dateLabel}</p>
                        {tp.notes && <p className="text-sm mt-0.5 whitespace-pre-line line-clamp-4">{stripHtml(tp.notes)}</p>}
                        <FileAttachmentList entityType="touchpoint" entityIds={[tp.id]} />
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => toggleMeaningfulMutation.mutate({ id: tp.id, isMeaningful: !tp.isMeaningful })}
                          title={tp.isMeaningful ? "Marked meaningful — click to unmark" : "Mark as meaningful conversation"}
                          className={`h-6 w-6 flex items-center justify-center rounded transition-colors ${tp.isMeaningful ? "text-amber-500 hover:text-amber-400" : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500"}`}
                          data-testid={`button-meaningful-tp-${tp.id}`}
                        >
                          <Star className={`h-3.5 w-3.5 ${tp.isMeaningful ? "fill-current" : ""}`} />
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
                          onClick={() => setDeleteTarget(tp.id)}
                          data-testid={`button-delete-tp-${tp.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete touchpoint?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showDeleteContactConfirm} onOpenChange={(v) => !v && setShowDeleteContactConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {contact?.name}? This will permanently remove the contact and all associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-contact-sheet">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => contact && deleteContactMutation.mutate(contact.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-contact-sheet"
            >
              {deleteContactMutation.isPending ? "Deleting..." : "Delete Contact"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <OutlookComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        toEmail={contact?.email || ""}
        toName={contact?.name || ""}
        companyName={(contact as any)?.companyName || ""}
        contactId={contact?.id}
        companyId={contact?.companyId ?? undefined}
      />
    </>
  );
}

// ─── Geographic Lane Responsibilities subcomponent ─────────────────────────────

interface GeoResponsibility {
  id: string;
  lanePatternId: string;
  status: string;
  confidenceScore: number;
  responsibilityType: string | null;
  evidenceCount: number;
  sourceTypes: string[] | null;
  firstSeenAt: string;
  lastSeenAt: string;
  pattern: {
    id: string;
    name: string;
    originRegion: string;
    destinationRegion: string;
    namedCorridor: string | null;
  } | null;
}

function confidenceBadge(score: number) {
  if (score >= 70) return <Badge className="text-xs bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">High</Badge>;
  if (score >= 40) return <Badge className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Medium</Badge>;
  return <Badge className="text-xs bg-muted text-muted-foreground">Low</Badge>;
}

function statusBadge(status: string) {
  if (status === "confirmed") return <Badge className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">Confirmed</Badge>;
  if (status === "dismissed") return <Badge variant="outline" className="text-xs text-muted-foreground">Dismissed</Badge>;
  return <Badge className="text-xs bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">Suggested</Badge>;
}

function GeographicLaneResponsibilities({ contactId }: { contactId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();

  const { data: responsibilities = [], isLoading } = useQuery<GeoResponsibility[]>({
    queryKey: ["/api/internal/contacts", contactId, "geographic-responsibilities"],
    queryFn: () => fetch(`/api/internal/contacts/${contactId}/geographic-responsibilities`, { credentials: "include" }).then(r => r.json()),
    enabled: expanded,
  });

  const confirmMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/internal/geographic-responsibilities/${id}/confirm`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/contacts", contactId, "geographic-responsibilities"] });
      toast({ title: "Responsibility confirmed" });
    },
    onError: () => toast({ title: "Failed to confirm", variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/internal/geographic-responsibilities/${id}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/contacts", contactId, "geographic-responsibilities"] });
      toast({ title: "Responsibility dismissed" });
    },
    onError: () => toast({ title: "Failed to dismiss", variant: "destructive" }),
  });

  const visible = responsibilities.filter(r => r.status !== "dismissed");

  return (
    <div className="space-y-2" data-testid="section-geographic-responsibilities">
      <button
        className="flex items-center gap-2 text-sm font-medium w-full text-left hover:text-foreground"
        onClick={() => setExpanded(v => !v)}
        data-testid="button-toggle-geo-responsibilities"
      >
        <Globe className="h-4 w-4 text-muted-foreground" />
        <span>Geographic Lane Responsibilities</span>
        {expanded ? <ChevronUp className="h-4 w-4 ml-auto text-muted-foreground" /> : <ChevronDown className="h-4 w-4 ml-auto text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="space-y-2 pl-6">
          {isLoading && (
            <div className="space-y-2">
              {[1, 2].map(i => <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />)}
            </div>
          )}

          {!isLoading && visible.length === 0 && (
            <p className="text-xs text-muted-foreground py-1">No geographic lane responsibilities detected yet.</p>
          )}

          {visible.map(r => {
            const days90Ago = new Date();
            days90Ago.setDate(days90Ago.getDate() - 90);
            const lastSeen = new Date(r.lastSeenAt);
            const daysSince = Math.round((Date.now() - lastSeen.getTime()) / 86400000);
            const sourceSummary = (r.sourceTypes ?? []).join(", ") || "unknown";
            const evidenceSummary = `${r.evidenceCount} event${r.evidenceCount !== 1 ? "s" : ""} via ${sourceSummary}${daysSince <= 90 ? ` (last: ${daysSince}d ago)` : ""}`;
            return (
              <div key={r.id} className="rounded-md border bg-muted/20 p-3 space-y-2" data-testid={`geo-responsibility-${r.id}`}>
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="text-sm font-medium flex-1 min-w-0">{r.pattern?.name ?? "Unknown pattern"}</span>
                  {confidenceBadge(r.confidenceScore)}
                  {statusBadge(r.status)}
                </div>
                {r.responsibilityType && (
                  <Badge variant="outline" className="text-xs capitalize">{r.responsibilityType.replace("_", " ")}</Badge>
                )}
                <p className="text-xs text-muted-foreground">{evidenceSummary}</p>
                {r.status === "suggested" && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs text-blue-600 border-blue-200 hover:bg-blue-50 dark:text-blue-400 dark:border-blue-800"
                      onClick={() => confirmMutation.mutate(r.id)}
                      disabled={confirmMutation.isPending}
                      data-testid={`button-confirm-geo-${r.id}`}
                    >
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => dismissMutation.mutate(r.id)}
                      disabled={dismissMutation.isPending}
                      data-testid={`button-dismiss-geo-${r.id}`}
                    >
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
