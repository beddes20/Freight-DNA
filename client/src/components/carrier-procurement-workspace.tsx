import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Truck,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Phone,
  Mail,
  MailOpen,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Users,
  TrendingUp,
  Route,
  UserPlus,
  Check,
  Building,
  Trophy,
  Send,
  AlertCircle,
  History,
  ChevronUp,
  Zap,
} from "lucide-react";
import type { LaneCarrier, User } from "@shared/schema";

export interface ProcurementLaneInfo {
  type: "carrier_procurement";
  lane: string;
  origin: string;
  destination: string;
  volume: number;
  awardId: string;
  taskId?: string;
  awardTitle?: string;
  customerName?: string;
  rate?: string;
  equipmentType?: string | null;
  matchedLaneId?: string | null;
}

interface RankedBenchCarrier {
  carrierId: string | null;
  carrierName: string;
  mcDot: string | null;
  primaryEmail: string | null;
  backupEmail: string | null;
  phone: string | null;
  regions: string[];
  equipmentTypes: string[];
  fitScore: number;
  fitReason: string;
  historyMatch: "exact" | "nearby" | "state_pair" | "region" | "none";
  loadsOnLane: number;
  lastUsedMonth: string | null;
  isNewProspect: boolean;
  equipmentMatch: boolean;
  regionMatch: boolean;
  suppressionReasons: string[];
  missingContactInfo: boolean;
  tier: 1 | 2 | 3 | 4;
}

interface EmailDraft {
  carrierId: string | null;
  carrierName: string;
  laneCarrierId?: string | null;
  subject: string;
  body: string;
  recipientEmail?: string | null;
}

interface OutreachLogEntry {
  sentAt: string;
  subject: string;
  bodyPreview: string;
  email: string | null;
  status: "sent" | "failed" | "no_email";
}

interface ProcurementOutreachLog {
  id: string;
  carrierNames: string[];
  procurementLane: string | null;
  replyReceivedAt: string | null;
  replySnippet: string | null;
}

const STATUS_CONFIG = {
  contacted: {
    label: "Contacted",
    icon: Clock,
    color: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  },
  emailed: {
    label: "Emailed",
    icon: Mail,
    color: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  committed: {
    label: "Committed",
    icon: CheckCircle2,
    color: "bg-green-500/10 text-green-700 dark:text-green-400",
  },
  declined: {
    label: "Declined",
    icon: XCircle,
    color: "bg-red-500/10 text-red-700 dark:text-red-400",
  },
};

const TIER_COLORS: Record<number, string> = {
  1: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800",
  2: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  3: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800",
  4: "bg-muted/40 text-muted-foreground border-border",
};

function getCoverageTier(count: number): { label: string; color: string } {
  if (count === 0) return { label: "Uncovered", color: "bg-red-500/10 text-red-700 dark:text-red-400" };
  if (count < 5) return { label: `Building (${count})`, color: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400" };
  return { label: `Covered (${count})`, color: "bg-green-500/10 text-green-700 dark:text-green-400" };
}

interface AddCarrierFormProps {
  taskId: string;
  awardId: string;
  lane: string;
  onAdded: () => void;
  prefillName?: string;
  prefillMcNumber?: string;
}

function AddCarrierForm({ taskId, awardId, lane, onAdded, prefillName, prefillMcNumber }: AddCarrierFormProps) {
  const { toast } = useToast();
  const [carrierName, setCarrierName] = useState(prefillName || "");
  const [mcNumber, setMcNumber] = useState(prefillMcNumber || "");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [rate, setRate] = useState("");
  const [capacityPerWeek, setCapacityPerWeek] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("contacted");

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/lane-carriers", {
        taskId,
        awardId,
        lane,
        carrierName: carrierName.trim(),
        mcNumber: mcNumber.trim() || null,
        contactName: contactName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        rate: rate.trim() || null,
        capacityPerWeek: capacityPerWeek ? parseInt(capacityPerWeek) : null,
        notes: notes.trim() || null,
        status,
        createdAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", taskId, "lane-carriers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/awards", awardId, "lane-carriers"] });
      onAdded();
      toast({ title: "Carrier added" });
      setCarrierName("");
      setMcNumber("");
      setContactName("");
      setPhone("");
      setEmail("");
      setRate("");
      setCapacityPerWeek("");
      setNotes("");
      setStatus("contacted");
    },
    onError: () => toast({ title: "Failed to add carrier", variant: "destructive" }),
  });

  return (
    <div className="border rounded-lg p-3 space-y-3 bg-muted/20">
      <p className="text-sm font-medium text-muted-foreground">Add Carrier Contact</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Carrier Name *</Label>
          <Input
            value={carrierName}
            onChange={e => setCarrierName(e.target.value)}
            placeholder="e.g. Swift Logistics"
            className="h-8 text-sm"
            data-testid="input-carrier-name"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">MC# (optional)</Label>
          <Input
            value={mcNumber}
            onChange={e => setMcNumber(e.target.value)}
            placeholder="MC123456"
            className="h-8 text-sm"
            data-testid="input-carrier-mc"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Contact Name</Label>
          <Input
            value={contactName}
            onChange={e => setContactName(e.target.value)}
            placeholder="Contact person"
            className="h-8 text-sm"
            data-testid="input-carrier-contact-name"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 text-sm" data-testid="select-carrier-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="contacted">Contacted</SelectItem>
              <SelectItem value="emailed">Emailed</SelectItem>
              <SelectItem value="committed">Committed</SelectItem>
              <SelectItem value="declined">Declined</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Phone</Label>
          <Input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="555-555-5555"
            className="h-8 text-sm"
            data-testid="input-carrier-phone"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Email</Label>
          <Input
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="dispatch@carrier.com"
            className="h-8 text-sm"
            data-testid="input-carrier-email"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Rate ($/mi or flat)</Label>
          <Input
            value={rate}
            onChange={e => setRate(e.target.value)}
            placeholder="2.50/mi or $1,800 flat"
            className="h-8 text-sm"
            data-testid="input-carrier-rate"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Capacity/Week</Label>
          <Input
            type="number"
            value={capacityPerWeek}
            onChange={e => setCapacityPerWeek(e.target.value)}
            placeholder="e.g. 3"
            className="h-8 text-sm"
            data-testid="input-carrier-capacity"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Notes</Label>
        <Textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Preferred equipment, regional notes, rate flexibility..."
          rows={2}
          className="text-sm resize-none"
          data-testid="textarea-carrier-notes"
        />
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => createMutation.mutate()}
          disabled={!carrierName.trim() || createMutation.isPending}
          data-testid="button-add-carrier"
        >
          {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
          Add Carrier
        </Button>
      </div>
    </div>
  );
}

interface CarrierRowProps {
  carrier: LaneCarrier;
  taskId: string;
  awardId: string;
  onEmail: (carrier: LaneCarrier) => void;
  replyInfo?: { replyReceivedAt: string; replySnippet: string | null } | null;
}

function CarrierRow({ carrier, taskId, awardId, onEmail, replyInfo }: CarrierRowProps) {
  const { toast } = useToast();
  const [editingStatus, setEditingStatus] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/lane-carriers/${carrier.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", taskId, "lane-carriers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/awards", awardId, "lane-carriers"] });
      toast({ title: "Carrier removed" });
    },
    onError: () => toast({ title: "Failed to remove carrier", variant: "destructive" }),
  });

  const updateStatusMutation = useMutation({
    mutationFn: async (status: string) => {
      await apiRequest("PATCH", `/api/lane-carriers/${carrier.id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", taskId, "lane-carriers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/awards", awardId, "lane-carriers"] });
      setEditingStatus(false);
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const cfg = STATUS_CONFIG[carrier.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.contacted;
  const StatusIcon = cfg.icon;

  const outreachLog: OutreachLogEntry[] = Array.isArray(carrier.outreachLog)
    ? (carrier.outreachLog as OutreachLogEntry[])
    : [];
  const lastEmail = outreachLog.length > 0 ? outreachLog[outreachLog.length - 1] : null;

  return (
    <div className="flex flex-col gap-0 rounded-md border bg-background hover:bg-muted/20 transition-colors" data-testid={`row-carrier-${carrier.id}`}>
      <div className="flex items-start gap-3 p-2.5 group">
        <div className="mt-0.5 flex-shrink-0">
          <Truck className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{carrier.carrierName}</span>
            {carrier.mcNumber && (
              <span className="text-xs text-muted-foreground font-mono">{carrier.mcNumber}</span>
            )}
            {editingStatus ? (
              <Select
                defaultValue={carrier.status}
                onValueChange={(v) => updateStatusMutation.mutate(v)}
                open
                onOpenChange={(open) => { if (!open) setEditingStatus(false); }}
              >
                <SelectTrigger className="h-6 text-xs w-28" data-testid={`select-status-${carrier.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="contacted">Contacted</SelectItem>
                  <SelectItem value="emailed">Emailed</SelectItem>
                  <SelectItem value="committed">Committed</SelectItem>
                  <SelectItem value="declined">Declined</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <button
                type="button"
                onClick={() => setEditingStatus(true)}
                data-testid={`badge-status-${carrier.id}`}
              >
                <Badge className={`text-xs cursor-pointer hover:opacity-80 ${cfg.color}`}>
                  <StatusIcon className="h-3 w-3 mr-1" />
                  {cfg.label}
                </Badge>
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {carrier.contactName && <span>{carrier.contactName}</span>}
            {carrier.phone && (
              <a href={`tel:${carrier.phone}`} className="flex items-center gap-1 hover:text-foreground" data-testid={`link-phone-${carrier.id}`}>
                <Phone className="h-3 w-3" /> {carrier.phone}
              </a>
            )}
            {carrier.email && (
              <a href={`mailto:${carrier.email}`} className="flex items-center gap-1 hover:text-foreground truncate" data-testid={`link-email-${carrier.id}`}>
                <Mail className="h-3 w-3" /> {carrier.email}
              </a>
            )}
            {carrier.rate && <span className="font-mono">{carrier.rate}</span>}
            {carrier.capacityPerWeek && <span>{carrier.capacityPerWeek} loads/wk</span>}
          </div>
          {carrier.notes && (
            <p className="text-xs text-muted-foreground mt-1 italic">{carrier.notes}</p>
          )}
          {replyInfo && (
            <div className="flex items-center gap-1.5 mt-1" data-testid={`badge-reply-received-${carrier.id}`}>
              <Badge className="text-xs bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 gap-1">
                <MailOpen className="h-3 w-3" />
                Reply Received
              </Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(replyInfo.replyReceivedAt).toLocaleString()}
              </span>
            </div>
          )}
          {replyInfo?.replySnippet && (
            <p className="text-xs text-muted-foreground mt-0.5 italic line-clamp-2" data-testid={`text-reply-snippet-${carrier.id}`}>
              "{replyInfo.replySnippet}"
            </p>
          )}
          {lastEmail && (
            <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
              <History className="h-3 w-3" />
              <span>
                {lastEmail.status === "sent"
                  ? `Last emailed ${new Date(lastEmail.sentAt).toLocaleDateString()}`
                  : lastEmail.status === "no_email"
                  ? `Outreach attempted ${new Date(lastEmail.sentAt).toLocaleDateString()} (no email on file)`
                  : `Send failed ${new Date(lastEmail.sentAt).toLocaleDateString()}`}
              </span>
              {outreachLog.length > 1 && (
                <button
                  type="button"
                  className="text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
                  onClick={() => setShowLog(!showLog)}
                  data-testid={`button-toggle-log-${carrier.id}`}
                >
                  {outreachLog.length} attempts
                  {showLog ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity text-blue-600 dark:text-blue-400 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30"
            onClick={() => onEmail(carrier)}
            data-testid={`button-email-carrier-${carrier.id}`}
          >
            <Mail className="h-3 w-3 mr-1" />
            Email
          </Button>
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
            data-testid={`button-delete-carrier-${carrier.id}`}
          >
            {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Outreach log entries */}
      {showLog && outreachLog.length > 0 && (
        <div className="border-t px-3 py-2 space-y-1.5 bg-muted/20">
          {outreachLog.map((entry, i) => (
            <div key={i} className="text-xs space-y-0.5" data-testid={`log-entry-${carrier.id}-${i}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground truncate">{entry.subject}</span>
                <span className="text-muted-foreground shrink-0 flex items-center gap-1">
                  {entry.status !== "sent" && (
                    <span className={entry.status === "no_email" ? "text-orange-500" : "text-red-500"}>
                      {entry.status === "no_email" ? "no email" : "failed"}
                    </span>
                  )}
                  {new Date(entry.sentAt).toLocaleDateString()}
                </span>
              </div>
              {entry.email && (
                <p className="text-muted-foreground">To: {entry.email}</p>
              )}
              {entry.bodyPreview && (
                <p className="text-muted-foreground line-clamp-2 italic">{entry.bodyPreview}</p>
              )}
            </div>
          ))}
        </div>
      )}
      {!showLog && lastEmail && outreachLog.length === 1 && (
        <div className="border-t px-3 py-1.5 bg-muted/20">
          <div className="text-xs space-y-0.5" data-testid={`log-entry-${carrier.id}-0`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground truncate">{lastEmail.subject}</span>
              <span className="text-muted-foreground shrink-0">{new Date(lastEmail.sentAt).toLocaleDateString()}</span>
            </div>
            {lastEmail.bodyPreview && (
              <p className="text-muted-foreground line-clamp-1 italic text-xs">{lastEmail.bodyPreview}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface BenchCarrierRowProps {
  carrier: RankedBenchCarrier;
  alreadyAdded: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onQuickAdd: () => void;
  onEmailDirectly: () => void;
  isPending: boolean;
}

function BenchCarrierRow({ carrier, alreadyAdded, selected, onToggleSelect, onQuickAdd, onEmailDirectly, isPending }: BenchCarrierRowProps) {
  const historyLabel: Record<string, string> = {
    exact: "Ran this lane",
    nearby: "Nearby lanes",
    state_pair: "Same state pair",
    region: "Region match",
    none: "",
  };

  return (
    <div
      className={`flex items-center gap-2 px-2.5 py-2 rounded-md border text-xs transition-colors cursor-pointer ${
        alreadyAdded
          ? "opacity-50 bg-muted/30"
          : selected
          ? "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800"
          : "bg-background hover:bg-muted/30"
      }`}
      onClick={!alreadyAdded ? onToggleSelect : undefined}
      data-testid={`row-bench-carrier-${carrier.carrierId ?? carrier.carrierName}`}
    >
      <div className={`w-5 h-5 rounded shrink-0 flex items-center justify-center text-xs font-bold border ${TIER_COLORS[carrier.tier]}`}>
        {carrier.tier}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium text-foreground">{carrier.carrierName}</span>
          {carrier.mcDot && <span className="text-muted-foreground font-mono">{carrier.mcDot}</span>}
          {carrier.missingContactInfo && (
            <span className="text-orange-500 dark:text-orange-400 flex items-center gap-0.5">
              <AlertCircle className="h-3 w-3" />
              <span>No email</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground mt-0.5 flex-wrap">
          {carrier.historyMatch !== "none" && (
            <span className="flex items-center gap-0.5">
              <Zap className="h-2.5 w-2.5 text-amber-500" />
              {historyLabel[carrier.historyMatch]}
              {carrier.loadsOnLane > 0 && ` (${carrier.loadsOnLane} loads)`}
            </span>
          )}
          {carrier.fitScore > 0 && (
            <span className="text-muted-foreground/70">Score: {carrier.fitScore}</span>
          )}
          {(carrier.primaryEmail || carrier.backupEmail) && (
            <span className="text-green-600 dark:text-green-400 flex items-center gap-0.5">
              <Mail className="h-2.5 w-2.5" />
              {carrier.primaryEmail || carrier.backupEmail}
            </span>
          )}
        </div>
      </div>
      {alreadyAdded ? (
        <Badge variant="secondary" className="text-xs shrink-0">Added</Badge>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={(e) => { e.stopPropagation(); onEmailDirectly(); }}
            disabled={isPending}
            title="Draft & send email"
            data-testid={`button-bench-email-${carrier.carrierId ?? carrier.carrierName}`}
          >
            <Mail className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={(e) => { e.stopPropagation(); onQuickAdd(); }}
            disabled={isPending}
            title="Add to carrier list"
            data-testid={`button-bench-add-${carrier.carrierId ?? carrier.carrierName}`}
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </Button>
        </div>
      )}
    </div>
  );
}

interface EmailDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafts: EmailDraft[];
  onDraftsChange: (drafts: EmailDraft[]) => void;
  onSend: (drafts: EmailDraft[], capturedEmails: Record<string, string>) => void;
  isSending: boolean;
  laneCarriers: LaneCarrier[];
}

function EmailDraftDialog({ open, onOpenChange, drafts, onDraftsChange, onSend, isSending, laneCarriers }: EmailDraftDialogProps) {
  const [capturedEmails, setCapturedEmails] = useState<Record<string, string>>({});
  const [activeDraftIdx, setActiveDraftIdx] = useState(0);

  // Reset local state each time the dialog is opened so stale data from a prior session is cleared
  useEffect(() => {
    if (open) {
      setActiveDraftIdx(0);
      setCapturedEmails({});
    }
  }, [open]);

  const activeDraft = drafts[activeDraftIdx];

  const updateDraft = (idx: number, field: keyof EmailDraft, value: string) => {
    const updated = drafts.map((d, i) => i === idx ? { ...d, [field]: value } : d);
    onDraftsChange(updated);
  };

  const getEmail = (draft: EmailDraft): string => {
    const key = draft.carrierId ?? draft.carrierName;
    if (capturedEmails[key]) return capturedEmails[key];
    if (draft.recipientEmail) return draft.recipientEmail;
    const lc = draft.laneCarrierId
      ? laneCarriers.find(c => c.id === draft.laneCarrierId)
      : laneCarriers.find(c => c.carrierName.toLowerCase() === draft.carrierName.toLowerCase());
    return lc?.email ?? "";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Review & Send Outreach Emails
            <Badge variant="secondary">{drafts.length} carrier{drafts.length !== 1 ? "s" : ""}</Badge>
          </DialogTitle>
        </DialogHeader>

        {drafts.length > 1 && (
          <div className="flex gap-1 flex-wrap">
            {drafts.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActiveDraftIdx(i)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  i === activeDraftIdx
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80 text-muted-foreground"
                }`}
                data-testid={`tab-draft-${i}`}
              >
                {d.carrierName}
              </button>
            ))}
          </div>
        )}

        {activeDraft && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs font-medium">To (email address)</Label>
              <Input
                value={getEmail(activeDraft)}
                onChange={e => {
                  const key = activeDraft.carrierId ?? activeDraft.carrierName;
                  setCapturedEmails(prev => ({ ...prev, [key]: e.target.value }));
                }}
                placeholder="dispatch@carrier.com"
                className="h-8 text-sm"
                data-testid={`input-email-to-${activeDraftIdx}`}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Subject</Label>
              <Input
                value={activeDraft.subject}
                onChange={e => updateDraft(activeDraftIdx, "subject", e.target.value)}
                className="h-8 text-sm"
                data-testid={`input-email-subject-${activeDraftIdx}`}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Email Body</Label>
              <Textarea
                value={activeDraft.body}
                onChange={e => updateDraft(activeDraftIdx, "body", e.target.value)}
                rows={8}
                className="text-sm resize-none font-mono text-xs"
                data-testid={`textarea-email-body-${activeDraftIdx}`}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {getEmail(activeDraft) ? "" : (
                <span className="text-orange-500 dark:text-orange-400 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  No email address — enter one above to send, or we'll mark as contacted without sending.
                </span>
              )}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
            data-testid="button-cancel-send"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onSend(drafts, capturedEmails)}
            disabled={isSending}
            data-testid="button-confirm-send"
          >
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Send {drafts.length > 1 ? `All (${drafts.length})` : "Email"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface LanePanelProps {
  laneInfo: ProcurementLaneInfo;
  fallbackTaskId?: string;
}

function LanePanel({ laneInfo, fallbackTaskId }: LanePanelProps) {
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const [addingCarrier, setAddingCarrier] = useState(false);
  const [benchOpen, setBenchOpen] = useState(true);
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedLmId, setSelectedLmId] = useState<string>("");
  const [assignedLmName, setAssignedLmName] = useState<string | null>(null);
  const [selectedBenchIds, setSelectedBenchIds] = useState<Set<string>>(new Set());
  const [emailDrafts, setEmailDrafts] = useState<EmailDraft[]>([]);
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);

  const taskId = laneInfo.taskId ?? fallbackTaskId ?? "";

  const { data: carriers = [], isLoading } = useQuery<LaneCarrier[]>({
    queryKey: ["/api/tasks", taskId, "lane-carriers"],
    enabled: !!taskId,
  });

  const { data: procurementOutreachLogs = [] } = useQuery<ProcurementOutreachLog[]>({
    queryKey: ["/api/procurement", taskId, "outreach-logs"],
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });

  // Build a lookup from carrier name (lowercase) → most recent reply info.
  // Filter to this specific lane so the same carrier on another lane doesn't
  // show a false-positive "Reply Received" badge here.
  const replyByCarrierName = new Map<string, { replyReceivedAt: string; replySnippet: string | null }>();
  for (const log of procurementOutreachLogs) {
    if (!log.replyReceivedAt) continue;
    if (log.procurementLane && log.procurementLane !== laneInfo.lane) continue;
    for (const name of log.carrierNames) {
      const key = name.toLowerCase();
      if (!replyByCarrierName.has(key)) {
        replyByCarrierName.set(key, { replyReceivedAt: log.replyReceivedAt, replySnippet: log.replySnippet });
      }
    }
  }

  const laneScopedCarriers = carriers.filter(c => c.lane === laneInfo.lane);

  const emailedOrBetter = laneScopedCarriers.filter(c =>
    c.status === "emailed" || c.status === "committed"
  ).length;
  const coverage = getCoverageTier(emailedOrBetter);

  // Fetch ranked carrier bench
  const { data: benchData, isLoading: benchLoading } = useQuery<{ carriers: RankedBenchCarrier[] }>({
    queryKey: ["/api/procurement/carrier-bench", laneInfo.origin, laneInfo.destination, laneInfo.volume, laneInfo.equipmentType ?? null, laneInfo.customerName ?? null],
    queryFn: async () => {
      const params = new URLSearchParams({
        origin: laneInfo.origin,
        destination: laneInfo.destination,
        volume: String(laneInfo.volume ?? 0),
        ...(laneInfo.customerName ? { customerName: laneInfo.customerName } : {}),
        ...(laneInfo.equipmentType ? { equipmentType: laneInfo.equipmentType } : {}),
      });
      const res = await fetch(`/api/procurement/carrier-bench?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load bench");
      return res.json();
    },
    enabled: !!(laneInfo.origin && laneInfo.destination),
    staleTime: 5 * 60 * 1000,
  });

  const rankedBench = benchData?.carriers ?? [];

  // Fetch org users for the LM picker
  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    staleTime: 5 * 60 * 1000,
  });
  const lmUsers = allUsers.filter(u =>
    u.role === "logistics_manager" || u.role === "logistics_coordinator" ||
    u.role === "national_account_manager" || u.role === "account_manager"
  ).sort((a, b) => a.name.localeCompare(b.name));

  const assignLmMutation = useMutation({
    mutationFn: async ({ lane, assignToUserId }: { lane: string; assignToUserId: string }) => {
      const res = await apiRequest("POST", `/api/awards/${laneInfo.awardId}/lanes/assign-lm`, {
        lane,
        assignToUserId,
      });
      return res.json() as Promise<{ taskId: string; created: boolean; assigneeName: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      setAssignedLmName(data.assigneeName);
      setAssignOpen(false);
      setSelectedLmId("");
      toast({
        title: `Lane assigned to ${data.assigneeName}`,
        description: data.created ? "New procurement task created on their board." : "Existing task reassigned.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to assign lane", description: err.message, variant: "destructive" });
    },
  });

  const { data: awardKnownCarriers = [] } = useQuery<LaneCarrier[]>({
    queryKey: ["/api/awards", laneInfo.awardId, "lane-carriers"],
    staleTime: 5 * 60 * 1000,
  });

  const directAddMutation = useMutation({
    mutationFn: async (carrier: RankedBenchCarrier) => {
      await apiRequest("POST", "/api/lane-carriers", {
        taskId,
        awardId: laneInfo.awardId,
        lane: laneInfo.lane,
        carrierName: carrier.carrierName,
        mcNumber: carrier.mcDot ?? null,
        email: carrier.primaryEmail ?? carrier.backupEmail ?? null,
        phone: carrier.phone ?? null,
        status: "contacted",
        createdAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", taskId, "lane-carriers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/awards", laneInfo.awardId, "lane-carriers"] });
      toast({ title: "Carrier added" });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const alreadyLogged = msg.includes("409");
      toast({ title: alreadyLogged ? "Carrier already logged for this lane" : "Failed to add carrier", variant: alreadyLogged ? "default" : "destructive" });
    },
  });

  const sendEmailsMutation = useMutation({
    mutationFn: async ({ drafts, capturedEmails }: { drafts: EmailDraft[]; capturedEmails: Record<string, string> }) => {
      const res = await apiRequest("POST", "/api/procurement/send-outreach-emails", {
        taskId,
        awardId: laneInfo.awardId,
        lane: laneInfo.lane,
        origin: laneInfo.origin,
        destination: laneInfo.destination,
        matchedLaneId: laneInfo.matchedLaneId ?? null,
        emailDrafts: drafts,
        capturedEmails,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", taskId, "lane-carriers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/awards", laneInfo.awardId, "lane-carriers"] });
      setDraftDialogOpen(false);
      setEmailDrafts([]);
      setSelectedBenchIds(new Set());
      const { sentCount, failedCount } = data;
      if (sentCount > 0 && failedCount === 0) {
        toast({ title: `${sentCount} email${sentCount !== 1 ? "s" : ""} sent` });
      } else if (sentCount > 0) {
        toast({ title: `${sentCount} sent, ${failedCount} failed`, variant: "default" });
      } else {
        toast({ title: "No emails sent — check addresses", variant: "destructive" });
      }
    },
    onError: () => toast({ title: "Failed to send emails", variant: "destructive" }),
  });

  const handleEmailCarrier = async (carrier: LaneCarrier) => {
    setIsDrafting(true);
    try {
      const res = await apiRequest("POST", "/api/procurement/draft-outreach-emails", {
        origin: laneInfo.origin,
        destination: laneInfo.destination,
        volume: laneInfo.volume ?? 0,
        customerName: laneInfo.customerName ?? null,
        equipmentType: laneInfo.equipmentType ?? null,
        carriers: [{
          carrierId: null,
          carrierName: carrier.carrierName,
        }],
      });
      const data = await res.json();
      setEmailDrafts(data.emails.map((e: EmailDraft) => ({
        ...e,
        laneCarrierId: carrier.id,
        recipientEmail: carrier.email ?? null,
      })));
      setDraftDialogOpen(true);
    } catch {
      toast({ title: "Failed to draft email", variant: "destructive" });
    } finally {
      setIsDrafting(false);
    }
  };

  const handleEmailSelected = async () => {
    const selectedCarriers = rankedBench.filter(c =>
      selectedBenchIds.has(c.carrierId ?? c.carrierName)
    );
    if (selectedCarriers.length === 0) return;

    setIsDrafting(true);
    try {
      const res = await apiRequest("POST", "/api/procurement/draft-outreach-emails", {
        origin: laneInfo.origin,
        destination: laneInfo.destination,
        volume: laneInfo.volume ?? 0,
        customerName: laneInfo.customerName ?? null,
        equipmentType: laneInfo.equipmentType ?? null,
        carriers: selectedCarriers.map(c => ({
          carrierId: c.carrierId,
          carrierName: c.carrierName,
        })),
      });
      const data = await res.json();

      // Enrich drafts with laneCarrierId if carrier was already added
      const draftsEnriched: EmailDraft[] = data.emails.map((e: EmailDraft) => {
        const lc = laneScopedCarriers.find(
          lc => lc.carrierName.toLowerCase() === e.carrierName.toLowerCase()
        );
        const benchC = selectedCarriers.find(c => c.carrierName === e.carrierName);
        return {
          ...e,
          laneCarrierId: lc?.id ?? null,
          recipientEmail: benchC?.primaryEmail ?? benchC?.backupEmail ?? lc?.email ?? null,
        };
      });

      setEmailDrafts(draftsEnriched);
      setDraftDialogOpen(true);
    } catch {
      toast({ title: "Failed to draft emails", variant: "destructive" });
    } finally {
      setIsDrafting(false);
    }
  };

  const handleEmailBenchDirect = async (carrier: RankedBenchCarrier) => {
    setIsDrafting(true);
    try {
      const res = await apiRequest("POST", "/api/procurement/draft-outreach-emails", {
        origin: laneInfo.origin,
        destination: laneInfo.destination,
        volume: laneInfo.volume ?? 0,
        customerName: laneInfo.customerName ?? null,
        equipmentType: laneInfo.equipmentType ?? null,
        carriers: [{ carrierId: carrier.carrierId, carrierName: carrier.carrierName }],
      });
      const data = await res.json();
      const lc = laneScopedCarriers.find(lc => lc.carrierName.toLowerCase() === carrier.carrierName.toLowerCase());
      setEmailDrafts(data.emails.map((e: EmailDraft) => ({
        ...e,
        laneCarrierId: lc?.id ?? null,
        recipientEmail: carrier.primaryEmail ?? carrier.backupEmail ?? lc?.email ?? null,
      })));
      setDraftDialogOpen(true);
    } catch {
      toast({ title: "Failed to draft email", variant: "destructive" });
    } finally {
      setIsDrafting(false);
    }
  };

  const toggleBenchSelect = (carrier: RankedBenchCarrier) => {
    const key = carrier.carrierId ?? carrier.carrierName;
    setSelectedBenchIds(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!taskId) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        No task assigned to this lane yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Lane header row */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className={`text-xs ${coverage.color}`}>
            {coverage.label}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {laneInfo.volume.toLocaleString()} loads/yr · {laneInfo.origin} → {laneInfo.destination}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Assign LM — always visible in header */}
          {assignedLmName && !assignOpen ? (
            <div className="flex items-center gap-1">
              <Badge variant="secondary" className="text-xs gap-1 h-7 px-2">
                <Check className="h-3 w-3 text-green-600" />
                {assignedLmName}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => setAssignOpen(true)}
                data-testid="button-reassign-lm"
              >
                Reassign
              </Button>
            </div>
          ) : !assignOpen ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setAssignOpen(true)}
              data-testid="button-open-assign-lm"
            >
              <UserPlus className="h-3 w-3 mr-1" />
              Assign LM
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={() => setAddingCarrier(!addingCarrier)}
            className="h-7 text-xs"
            data-testid="button-add-carrier-toggle"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Carrier
          </Button>
        </div>
      </div>

      {/* Assign LM picker — shown inline when open */}
      {assignOpen && (
        <div className="border rounded-lg p-3 bg-muted/40 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserPlus className="h-4 w-4 text-primary" />
            {assignedLmName ? `Reassign lane — currently ${assignedLmName}` : "Assign lane to a Logistics Manager"}
          </div>
          {currentUser && (currentUser.role === "national_account_manager" || currentUser.role === "account_manager") && (
            <div className="pb-1">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 text-xs w-full"
                disabled={assignLmMutation.isPending}
                onClick={() => assignLmMutation.mutate({ lane: laneInfo.lane, assignToUserId: currentUser.id })}
                data-testid="button-assign-to-me"
              >
                {assignLmMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                Assign to me
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Select value={selectedLmId} onValueChange={setSelectedLmId}>
              <SelectTrigger className="h-8 text-xs flex-1" data-testid="select-assign-lm">
                <SelectValue placeholder="Select a user…" />
              </SelectTrigger>
              <SelectContent>
                {lmUsers.length === 0 ? (
                  <SelectItem value="_none" disabled>No eligible users found in your org</SelectItem>
                ) : (
                  lmUsers.map(u => (
                    <SelectItem key={u.id} value={u.id} data-testid={`option-lm-${u.id}`}>
                      {u.name}
                      {u.role === "logistics_coordinator" && (
                        <span className="ml-1 text-muted-foreground">(LC)</span>
                      )}
                      {u.role === "account_manager" && (
                        <span className="ml-1 text-muted-foreground">(AM)</span>
                      )}
                      {u.role === "national_account_manager" && (
                        <span className="ml-1 text-muted-foreground">(NAM)</span>
                      )}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs shrink-0"
              disabled={!selectedLmId || assignLmMutation.isPending}
              onClick={() => assignLmMutation.mutate({ lane: laneInfo.lane, assignToUserId: selectedLmId })}
              data-testid="button-confirm-assign-lm"
            >
              {assignLmMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Assign"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs shrink-0"
              onClick={() => { setAssignOpen(false); setSelectedLmId(""); }}
              data-testid="button-cancel-assign-lm"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {addingCarrier && (
        <AddCarrierForm
          taskId={taskId}
          awardId={laneInfo.awardId}
          lane={laneInfo.lane}
          onAdded={() => setAddingCarrier(false)}
        />
      )}

      {/* Ranked carrier bench */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
          onClick={() => setBenchOpen(!benchOpen)}
          data-testid="button-toggle-bench"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="h-4 w-4 text-primary" />
            Carrier Bench
            <span className="text-xs text-muted-foreground font-normal">
              {rankedBench.length > 0 ? `${rankedBench.length} ranked` : "Loading..."}
            </span>
            {selectedBenchIds.size > 0 && (
              <Badge className="text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400">
                {selectedBenchIds.size} selected
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedBenchIds.size > 0 && (
              <Button
                type="button"
                size="sm"
                className="h-6 text-xs px-2"
                disabled={isDrafting}
                onClick={(e) => { e.stopPropagation(); handleEmailSelected(); }}
                data-testid="button-email-selected"
              >
                {isDrafting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Mail className="h-3 w-3 mr-1" />}
                Email Selected
              </Button>
            )}
            {benchOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </button>
        {benchOpen && (
          <div className="p-2 space-y-1">
            {benchLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 px-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Ranking carriers...
              </div>
            ) : rankedBench.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2 px-1">
                No carriers found in your catalog for this lane. Add carriers from your catalog to see suggestions here.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground px-1 pb-1">
                  Click a row to select · Tier 1 = strongest fit · <span className="text-orange-500 dark:text-orange-400">⚠ No email</span> = missing contact info
                </p>
                {rankedBench.map(c => {
                  const key = c.carrierId ?? c.carrierName;
                  const alreadyAdded = laneScopedCarriers.some(
                    lc => lc.carrierName.toLowerCase() === c.carrierName.toLowerCase()
                  );
                  return (
                    <BenchCarrierRow
                      key={key}
                      carrier={c}
                      alreadyAdded={alreadyAdded}
                      selected={selectedBenchIds.has(key)}
                      onToggleSelect={() => toggleBenchSelect(c)}
                      onQuickAdd={() => directAddMutation.mutate(c)}
                      onEmailDirectly={() => handleEmailBenchDirect(c)}
                      isPending={directAddMutation.isPending}
                    />
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* Added carriers list */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading carriers...
        </div>
      ) : laneScopedCarriers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-4 text-center border-2 border-dashed rounded-lg">
          <Users className="h-6 w-6 text-muted-foreground/50 mb-1" />
          <p className="text-xs text-muted-foreground">No carriers logged yet for this lane.</p>
          <p className="text-xs text-muted-foreground">Select from the bench above or add manually.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {laneScopedCarriers.map(carrier => (
            <CarrierRow
              key={carrier.id}
              carrier={carrier}
              taskId={taskId}
              awardId={laneInfo.awardId}
              onEmail={handleEmailCarrier}
              replyInfo={replyByCarrierName.get(carrier.carrierName.toLowerCase()) ?? null}
            />
          ))}
        </div>
      )}

      {isDrafting && !draftDialogOpen && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Loader2 className="h-3 w-3 animate-spin" /> Drafting AI emails...
        </div>
      )}

      <EmailDraftDialog
        open={draftDialogOpen}
        onOpenChange={setDraftDialogOpen}
        drafts={emailDrafts}
        onDraftsChange={setEmailDrafts}
        onSend={(drafts, captured) => sendEmailsMutation.mutate({ drafts, capturedEmails: captured })}
        isSending={sendEmailsMutation.isPending}
        laneCarriers={laneScopedCarriers}
      />
    </div>
  );
}

interface CarrierProcurementWorkspaceProps {
  lanes: ProcurementLaneInfo[];
  fallbackTaskId?: string;
}

export function CarrierProcurementWorkspace({ lanes, fallbackTaskId }: CarrierProcurementWorkspaceProps) {
  const [openLanes, setOpenLanes] = useState<Set<string>>(new Set(lanes.map(l => l.lane)));

  const toggleLane = (lane: string) => {
    setOpenLanes(prev => {
      const next = new Set(prev);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  };

  if (lanes.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        No procurement lanes attached to this task.
      </div>
    );
  }

  const firstLane = lanes[0];
  const sharedAwardTitle = firstLane?.awardTitle;
  const sharedCustomerName = firstLane?.customerName;

  return (
    <div className="space-y-3">
      {/* Workspace context header — customer, award, lane summary */}
      {(sharedCustomerName || sharedAwardTitle) && (
        <div className="rounded-lg border bg-primary/5 dark:bg-primary/10 px-3 py-2.5 space-y-0.5" data-testid="section-workspace-context">
          {sharedCustomerName && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
              <Building className="h-3 w-3" />
              <span data-testid="text-workspace-customer">{sharedCustomerName}</span>
            </div>
          )}
          {sharedAwardTitle && (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Trophy className="h-3 w-3 text-amber-500" />
              <span data-testid="text-workspace-award">{sharedAwardTitle}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
            <Route className="h-3 w-3" />
            {lanes.length === 1 ? (
              <span data-testid="text-workspace-lane">{lanes[0].origin} → {lanes[0].destination}</span>
            ) : (
              <span data-testid="text-workspace-lanes">{lanes.length} procurement lanes · target 5–10 carriers each</span>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Route className="h-4 w-4 text-primary" />
        Carrier Procurement Workspace
        <Badge variant="secondary" className="ml-1">{lanes.length} lane{lanes.length !== 1 ? "s" : ""}</Badge>
      </div>
      <Separator />
      {lanes.map((laneInfo) => (
        <Collapsible
          key={laneInfo.lane}
          open={openLanes.has(laneInfo.lane)}
          onOpenChange={() => toggleLane(laneInfo.lane)}
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center justify-between p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 transition-colors text-left"
              data-testid={`button-lane-collapse-${laneInfo.lane}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Truck className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium truncate">{laneInfo.lane}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {laneInfo.volume.toLocaleString()} loads/yr
                </span>
              </div>
              {openLanes.has(laneInfo.lane) ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="p-3 border border-t-0 rounded-b-lg space-y-3">
              <LanePanel laneInfo={laneInfo} fallbackTaskId={fallbackTaskId} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

interface AwardRolodexDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  awardTitle: string;
  awardId: string;
  lanes: ProcurementLaneInfo[];
}

export function AwardRolodexDialog({
  open,
  onOpenChange,
  awardTitle,
  awardId,
  lanes,
}: AwardRolodexDialogProps) {
  const { toast } = useToast();

  const { data: carriers = [], isLoading } = useQuery<LaneCarrier[]>({
    queryKey: ["/api/awards", awardId, "lane-carriers"],
    enabled: open,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/lane-carriers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/awards", awardId, "lane-carriers"] });
      toast({ title: "Carrier removed" });
    },
    onError: () => toast({ title: "Failed to remove carrier", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            Carrier Rolodex — {awardTitle}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading carriers...
          </div>
        ) : lanes.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground text-center">
            No qualifying lanes found for this award (need 50+ loads/yr).
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Showing all logged carrier contacts across {lanes.length} qualifying lane{lanes.length !== 1 ? "s" : ""}. Open a procurement task to add new carriers.
            </p>
            {lanes.map(lane => {
              const laneCarriers = carriers.filter(c => c.lane === lane.lane);
              const coverage = getCoverageTier(laneCarriers.filter(c => c.status !== "declined").length);
              return (
                <div key={lane.lane} className="border rounded-lg">
                  <div className="flex items-center justify-between p-3 border-b bg-muted/20">
                    <div className="flex items-center gap-2 min-w-0">
                      <Truck className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">{lane.lane}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground">{lane.volume.toLocaleString()} loads/yr</span>
                      <Badge className={`text-xs ${coverage.color}`}>{coverage.label}</Badge>
                    </div>
                  </div>
                  <div className="p-2 space-y-1">
                    {laneCarriers.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-3">No carriers logged yet for this lane.</p>
                    ) : (
                      laneCarriers.map(carrier => {
                        const cfg = STATUS_CONFIG[carrier.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.contacted;
                        const StatusIcon = cfg.icon;
                        return (
                          <div key={carrier.id} className="flex items-center justify-between p-2 rounded-md hover:bg-muted/30 group" data-testid={`row-rolodex-carrier-${carrier.id}`}>
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <span className="text-sm font-medium truncate">{carrier.carrierName}</span>
                              {carrier.mcNumber && <span className="text-xs text-muted-foreground font-mono">{carrier.mcNumber}</span>}
                              <Badge className={`text-xs ${cfg.color} shrink-0`}>
                                <StatusIcon className="h-3 w-3 mr-1" />
                                {cfg.label}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                              {carrier.contactName && <span>{carrier.contactName}</span>}
                              {carrier.phone && (
                                <a href={`tel:${carrier.phone}`} className="hover:text-foreground" data-testid={`link-rolodex-phone-${carrier.id}`}>
                                  <Phone className="h-3 w-3" />
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => deleteMutation.mutate(carrier.id)}
                                disabled={deleteMutation.isPending}
                                className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
                                data-testid={`button-rolodex-delete-${carrier.id}`}
                              >
                                {deleteMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ProcurementTaskLauncherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  lanes: ProcurementLaneInfo[];
}

export function ProcurementTaskLauncherDialog({
  open,
  onOpenChange,
  title,
  lanes,
}: ProcurementTaskLauncherDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-primary" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <CarrierProcurementWorkspace lanes={lanes} />
      </DialogContent>
    </Dialog>
  );
}
