import { useState } from "react";
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
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Users,
  TrendingUp,
  Route,
  Star,
  UserPlus,
  Check,
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
}

interface CarrierEntry {
  name: string;
  mcNumber?: string | null;
  loads: number;
  pct: number;
  avgCarrierPay: number | null;
  lastUsed: string | null;
}

interface CorridorResult {
  corridorLabel: string;
  originLabel: string;
  destLabel: string;
  avgLoadsPerMonth: number;
  totalLoads: number;
  carriers: CarrierEntry[];
}

interface SuggestedCarriersResponse {
  corridors: CorridorResult[];
}

const STATUS_CONFIG = {
  contacted: {
    label: "Contacted",
    icon: Clock,
    color: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
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
}

function CarrierRow({ carrier, taskId, awardId }: CarrierRowProps) {
  const { toast } = useToast();
  const [editingStatus, setEditingStatus] = useState(false);

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

  return (
    <div className="flex items-start gap-3 p-2.5 rounded-md border bg-background hover:bg-muted/30 transition-colors group" data-testid={`row-carrier-${carrier.id}`}>
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
      </div>
      <button
        type="button"
        onClick={() => deleteMutation.mutate()}
        disabled={deleteMutation.isPending}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
        data-testid={`button-delete-carrier-${carrier.id}`}
      >
        {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </button>
    </div>
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
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedLmId, setSelectedLmId] = useState<string>("");
  const [assignedLmName, setAssignedLmName] = useState<string | null>(null);

  const taskId = laneInfo.taskId ?? fallbackTaskId ?? "";

  const { data: carriers = [], isLoading } = useQuery<LaneCarrier[]>({
    queryKey: ["/api/tasks", taskId, "lane-carriers"],
    enabled: !!taskId,
  });

  const laneScopedCarriers = carriers.filter(c => c.lane === laneInfo.lane);
  const activeCarrierCount = laneScopedCarriers.filter(c => c.status !== "declined").length;
  const coverage = getCoverageTier(activeCarrierCount);

  const { data: suggestedData, isLoading: suggestLoading } = useQuery<SuggestedCarriersResponse>({
    queryKey: ["/api/carriers/lane-search", laneInfo.origin, laneInfo.destination],
    queryFn: async () => {
      const params = new URLSearchParams({
        origin: laneInfo.origin,
        destination: laneInfo.destination,
        radius: "50",
        minLoadsPerMonth: "2",
      });
      const res = await fetch(`/api/carriers/lane-search?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!(laneInfo.origin && laneInfo.destination),
    staleTime: 5 * 60 * 1000,
  });

  // Fetch org users for the LM picker
  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    staleTime: 5 * 60 * 1000,
  });
  const lmUsers = allUsers.filter(u =>
    u.role === "logistics_manager" || u.role === "logistics_coordinator"
  );

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

  const suggestedCarriers = suggestedData?.corridors.flatMap(c => c.carriers) ?? [];
  const uniqueSuggested = suggestedCarriers
    .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i)
    .sort((a, b) => b.loads - a.loads)
    .slice(0, 10)
    .map(c => {
      const known = awardKnownCarriers.find(k => k.carrierName.toLowerCase() === c.name.toLowerCase());
      return { ...c, mcNumber: known?.mcNumber ?? (c.mcNumber ?? undefined) } as CarrierEntry;
    });

  const directAddMutation = useMutation({
    mutationFn: async (carrier: CarrierEntry) => {
      await apiRequest("POST", "/api/lane-carriers", {
        taskId,
        awardId: laneInfo.awardId,
        lane: laneInfo.lane,
        carrierName: carrier.name,
        mcNumber: carrier.mcNumber ?? null,
        status: "contacted",
        createdAt: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks", taskId, "lane-carriers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/awards", laneInfo.awardId, "lane-carriers"] });
      setSuggestOpen(false);
      toast({ title: "Carrier added" });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const alreadyLogged = msg.includes("409");
      toast({ title: alreadyLogged ? "Carrier already logged for this lane" : "Failed to add carrier", variant: alreadyLogged ? "default" : "destructive" });
    },
  });

  function handleAddSuggested(carrier: CarrierEntry) {
    directAddMutation.mutate(carrier);
  }

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
            variant="outline"
            onClick={() => { setSuggestOpen(!suggestOpen); }}
            className="h-7 text-xs"
            data-testid="button-suggest-carriers"
          >
            <Star className="h-3 w-3 mr-1" />
            Suggest
          </Button>
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
          <div className="flex items-center gap-2">
            <Select value={selectedLmId} onValueChange={setSelectedLmId}>
              <SelectTrigger className="h-8 text-xs flex-1" data-testid="select-assign-lm">
                <SelectValue placeholder="Select a Logistics Manager…" />
              </SelectTrigger>
              <SelectContent>
                {lmUsers.length === 0 ? (
                  <SelectItem value="_none" disabled>No LMs found in your org</SelectItem>
                ) : (
                  lmUsers.map(u => (
                    <SelectItem key={u.id} value={u.id} data-testid={`option-lm-${u.id}`}>
                      {u.name}
                      {u.role === "logistics_coordinator" && (
                        <span className="ml-1 text-muted-foreground">(LC)</span>
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

      {/* Suggest panel — carrier suggestions only */}
      {suggestOpen && (
        <div className="border rounded-lg p-3 bg-blue-50/50 dark:bg-blue-950/20 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-800 dark:text-blue-300">
            <TrendingUp className="h-4 w-4" />
            Carriers from your data on this lane
            <span className="text-xs font-normal text-blue-600 dark:text-blue-400">(within 50 mi)</span>
          </div>
          {suggestLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading...
            </div>
          ) : uniqueSuggested.length === 0 ? (
            <p className="text-xs text-muted-foreground">No carrier data found for this lane in your freight history.</p>
          ) : (
            <div className="space-y-1">
              {uniqueSuggested.map((c, i) => {
                const alreadyAdded = laneScopedCarriers.some(
                  lc => lc.carrierName.toLowerCase() === c.name.toLowerCase()
                );
                return (
                  <div key={i} className="flex items-center justify-between text-xs py-1" data-testid={`row-suggested-carrier-${i}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-muted-foreground">{c.loads} loads</span>
                      {c.avgCarrierPay != null && (
                        <span className="text-muted-foreground">${c.avgCarrierPay.toFixed(0)} avg</span>
                      )}
                    </div>
                    {alreadyAdded ? (
                      <Badge variant="secondary" className="text-xs">Added</Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-5 text-xs px-2"
                        onClick={() => handleAddSuggested(c)}
                        disabled={directAddMutation.isPending}
                        data-testid={`button-use-suggested-${i}`}
                      >
                        {directAddMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading carriers...
        </div>
      ) : laneScopedCarriers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-4 text-center border-2 border-dashed rounded-lg">
          <Users className="h-6 w-6 text-muted-foreground/50 mb-1" />
          <p className="text-xs text-muted-foreground">No carriers logged yet for this lane.</p>
          <p className="text-xs text-muted-foreground">Target: 5–10 contacts</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {laneScopedCarriers.map(carrier => (
            <CarrierRow
              key={carrier.id}
              carrier={carrier}
              taskId={taskId}
              awardId={laneInfo.awardId}
            />
          ))}
        </div>
      )}
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

  return (
    <div className="space-y-3">
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
