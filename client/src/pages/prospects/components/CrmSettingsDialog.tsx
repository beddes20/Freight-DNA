import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Settings, Plus, Trash2, ShieldCheck, Loader2,
  ToggleLeft, ToggleRight, ChevronUp, ChevronDown,
  GripVertical, CheckCircle, XCircle,
} from "lucide-react";
import type { EnrichedProspect } from "../types";

type CrmSettingsItem = { key: string; label: string; active?: boolean };
type CrmSettingsColorItem = { key: string; label: string; color: string };
type CrmSettings = {
  pipelineStages: CrmSettingsItem[];
  opportunityTypes: CrmSettingsItem[];
  accountStatusLabels: CrmSettingsColorItem[];
  leadSources: CrmSettingsItem[];
  ownershipMode: string;
  staleThresholdDays: number;
  requiredFields: Record<string, boolean>;
};

const SECTIONS = [
  { key: "pipeline", label: "Pipeline Stages" },
  { key: "opptypes", label: "Opportunity Types" },
  { key: "statuslabels", label: "Account Status Labels" },
  { key: "leadsources", label: "Lead Sources" },
  { key: "ownership", label: "Ownership Rules" },
  { key: "reqfields", label: "Required Fields" },
  { key: "queue", label: "Ownership Queue" },
];

const REQUIRED_FIELD_OPTIONS = [
  { key: "name", label: "Company Name" },
  { key: "stage", label: "Stage" },
  { key: "ownerId", label: "Owner" },
  { key: "primaryContactName", label: "Primary Contact Name" },
  { key: "primaryContactEmail", label: "Primary Contact Email" },
  { key: "leadSource", label: "Lead Source" },
  { key: "estimatedSpend", label: "Estimated Spend" },
  { key: "followUpDate", label: "Follow-up Date" },
  { key: "expectedCloseDate", label: "Expected Close Date" },
];

function OwnershipQueueInline() {
  const { toast } = useToast();
  const { data: requests = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ["/api/launchpad/ownership-requests"],
    queryFn: async () => {
      const res = await fetch("/api/launchpad/ownership-requests", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: allUsers = [] } = useQuery<any[]>({ queryKey: ["/api/users"] });
  const { data: allProspects = [] } = useQuery<EnrichedProspect[]>({ queryKey: ["/api/prospects"] });
  const userMap = useMemo(() => new Map(allUsers.map((u: any) => [u.id, u.name ?? u.username])), [allUsers]);
  const prospectMap = useMemo(() => new Map(allProspects.map(p => [p.id, p.name])), [allProspects]);
  const [denyDialogReqId, setDenyDialogReqId] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const reviewMutation = useMutation({
    mutationFn: ({ id, status, adminNote }: { id: number; status: string; adminNote?: string }) =>
      apiRequest("PATCH", `/api/launchpad/ownership-requests/${id}/review`, { status, adminNote }).then(r => r.json()),
    onSuccess: () => { refetch(); toast({ title: "Request reviewed" }); },
    onError: () => toast({ title: "Failed", variant: "destructive" }),
  });

  const pending = requests.filter(r => r.status === "pending");

  if (isLoading) return <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  if (pending.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
        <CheckCircle className="h-7 w-7 opacity-30" />
        <p className="text-sm">No pending requests</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {pending.map(r => (
          <div key={r.id} className="border rounded-lg p-3 space-y-2" data-testid={`inline-req-${r.id}`}>
            <div>
              <p className="font-semibold text-sm">{prospectMap.get(r.prospectId) ?? `Account #${r.prospectId}`}</p>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">{userMap.get(r.requesterId)}</span> → from <span className="font-medium">{userMap.get(r.currentOwnerId)}</span>
              </p>
              {r.reason && <p className="text-xs mt-1 italic text-foreground/70">"{r.reason}"</p>}
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white gap-1" onClick={() => reviewMutation.mutate({ id: r.id, status: "approved" })} data-testid={`inline-approve-${r.id}`}>
                <CheckCircle className="h-3 w-3" />Approve
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-red-600 border-red-300" onClick={() => { setDenyDialogReqId(r.id); setDenyReason(""); }} data-testid={`inline-deny-${r.id}`}>
                <XCircle className="h-3 w-3" />Deny
              </Button>
            </div>
          </div>
        ))}
      </div>
      {denyDialogReqId !== null && (
        <Dialog open onOpenChange={v => { if (!v) setDenyDialogReqId(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Deny Ownership Request</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">Provide a reason for denying this request.</p>
            <Textarea value={denyReason} onChange={e => setDenyReason(e.target.value)} placeholder="Reason for denial…" className="min-h-[80px]" data-testid="input-inline-deny-reason" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setDenyDialogReqId(null)}>Cancel</Button>
              <Button variant="destructive" disabled={!denyReason.trim() || reviewMutation.isPending} onClick={() => { reviewMutation.mutate({ id: denyDialogReqId, status: "denied", adminNote: denyReason.trim() }); setDenyDialogReqId(null); }} data-testid="button-inline-confirm-deny">
                Confirm Deny
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function CrmSettingsDialog({ onClose, openOwnershipQueue }: { onClose: () => void; openOwnershipQueue: () => void }) {
  const { toast } = useToast();
  const [activeSection, setActiveSection] = useState("pipeline");

  const { data: settings, isLoading } = useQuery<CrmSettings>({
    queryKey: ["/api/launchpad/crm-settings"],
    queryFn: async () => {
      const res = await fetch("/api/launchpad/crm-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const saveMutation = useMutation({
    mutationFn: (data: Partial<CrmSettings>) => apiRequest("PATCH", "/api/launchpad/crm-settings", data).then(r => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/launchpad/crm-settings"] }); toast({ title: "Settings saved" }); },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  const [stages, setStages] = useState<CrmSettingsItem[]>([]);
  const [oppTypes, setOppTypes] = useState<CrmSettingsItem[]>([]);
  const [statusLabels, setStatusLabels] = useState<CrmSettingsColorItem[]>([]);
  const [leadSources, setLeadSources] = useState<CrmSettingsItem[]>([]);
  const [ownershipMode, setOwnershipMode] = useState("approval_required");
  const [staleThreshold, setStaleThreshold] = useState(14);
  const [requiredFields, setRequiredFields] = useState<Record<string, boolean>>({});

  const synced = useRef(false);
  if (settings && !synced.current) {
    setStages(settings.pipelineStages ?? []);
    setOppTypes(settings.opportunityTypes ?? []);
    setStatusLabels(settings.accountStatusLabels ?? []);
    setLeadSources(settings.leadSources ?? []);
    setOwnershipMode(settings.ownershipMode ?? "approval_required");
    setStaleThreshold(settings.staleThresholdDays ?? 14);
    setRequiredFields(settings.requiredFields ?? {});
    synced.current = true;
  }

  const saveAll = () => {
    saveMutation.mutate({
      pipelineStages: stages,
      opportunityTypes: oppTypes,
      accountStatusLabels: statusLabels,
      leadSources,
      ownershipMode,
      staleThresholdDays: staleThreshold,
      requiredFields,
    });
  };

  const ListEditor = ({ items, setItems, placeholder }: { items: CrmSettingsItem[]; setItems: (v: CrmSettingsItem[]) => void; placeholder: string }) => {
    const [addLabel, setAddLabel] = useState("");
    const addItem = () => {
      if (!addLabel.trim()) return;
      const key = addLabel.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
      setItems([...items, { key, label: addLabel.trim(), active: true }]);
      setAddLabel("");
    };
    const moveItem = (i: number, dir: -1 | 1) => {
      const arr = [...items];
      const to = i + dir;
      if (to < 0 || to >= arr.length) return;
      [arr[i], arr[to]] = [arr[to], arr[i]];
      setItems(arr);
    };
    return (
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={item.key} className="flex items-center gap-2 border rounded-md px-3 py-1.5 bg-background" data-testid={`setting-item-${item.key}`}>
            <div className="flex flex-col shrink-0">
              <button onClick={() => moveItem(i, -1)} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30 leading-none" data-testid={`button-move-up-${item.key}`}><ChevronUp className="h-3 w-3" /></button>
              <button onClick={() => moveItem(i, 1)} disabled={i === items.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30 leading-none" data-testid={`button-move-down-${item.key}`}><ChevronDown className="h-3 w-3" /></button>
            </div>
            <input className="flex-1 text-sm bg-transparent outline-none" value={item.label} onChange={e => setItems(items.map((it, j) => j === i ? { ...it, label: e.target.value } : it))} data-testid={`input-item-label-${item.key}`} />
            <button onClick={() => setItems(items.map((it, j) => j === i ? { ...it, active: !it.active } : it))} className={`text-xs shrink-0 ${item.active ? "text-emerald-600" : "text-muted-foreground"}`} data-testid={`toggle-item-${item.key}`}>
              {item.active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
            </button>
            <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 shrink-0" data-testid={`button-delete-item-${item.key}`}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="flex gap-2 mt-2">
          <input className="flex-1 h-7 px-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring" placeholder={placeholder} value={addLabel} onChange={e => setAddLabel(e.target.value)} onKeyDown={e => e.key === "Enter" && addItem()} data-testid="input-new-item-label" />
          <Button size="sm" className="h-7 text-xs" onClick={addItem} disabled={!addLabel.trim()} data-testid="button-add-item"><Plus className="h-3 w-3 mr-1" /> Add</Button>
        </div>
      </div>
    );
  };

  const StatusLabelEditor = () => {
    const [addLabel, setAddLabel] = useState("");
    const [addColor, setAddColor] = useState("#3b82f6");
    const addItem = () => {
      if (!addLabel.trim()) return;
      const key = addLabel.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
      setStatusLabels([...statusLabels, { key, label: addLabel.trim(), color: addColor }]);
      setAddLabel("");
    };
    return (
      <div className="space-y-2">
        {statusLabels.map((item, i) => (
          <div key={item.key} className="flex items-center gap-2 border rounded-md px-3 py-1.5 bg-background" data-testid={`status-item-${item.key}`}>
            <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input type="color" className="w-6 h-6 rounded cursor-pointer border-0 shrink-0" value={item.color} onChange={e => setStatusLabels(statusLabels.map((it, j) => j === i ? { ...it, color: e.target.value } : it))} data-testid={`color-item-${item.key}`} />
            <input className="flex-1 text-sm bg-transparent outline-none" value={item.label} onChange={e => setStatusLabels(statusLabels.map((it, j) => j === i ? { ...it, label: e.target.value } : it))} data-testid={`input-status-label-${item.key}`} />
            <button onClick={() => setStatusLabels(statusLabels.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600 shrink-0" data-testid={`button-delete-status-${item.key}`}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="flex gap-2 mt-2">
          <input type="color" className="w-8 h-7 rounded cursor-pointer border border-border shrink-0" value={addColor} onChange={e => setAddColor(e.target.value)} />
          <input className="flex-1 h-7 px-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring" placeholder="New status label…" value={addLabel} onChange={e => setAddLabel(e.target.value)} onKeyDown={e => e.key === "Enter" && addItem()} data-testid="input-new-status-label" />
          <Button size="sm" className="h-7 text-xs" onClick={addItem} disabled={!addLabel.trim()} data-testid="button-add-status"><Plus className="h-3 w-3 mr-1" /> Add</Button>
        </div>
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle className="flex items-center gap-2"><Settings className="h-5 w-5" /> Advanced CRM Settings</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">Admin-only configuration for the Launchpad pipeline</p>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          <div className="w-44 shrink-0 border-r bg-muted/20 px-2 py-4 space-y-0.5">
            {SECTIONS.map(s => (
              <button key={s.key} onClick={() => setActiveSection(s.key)} className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium transition-colors ${activeSection === s.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`} data-testid={`nav-crm-${s.key}`}>
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (
              <>
                {activeSection === "pipeline" && (
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold mb-0.5">Pipeline Stages</h3>
                      <p className="text-xs text-muted-foreground mb-3">Rename, reorder, or toggle stages. Changes affect how accounts are categorized.</p>
                    </div>
                    <ListEditor items={stages} setItems={setStages} placeholder="New stage name…" />
                  </div>
                )}

                {activeSection === "opptypes" && (
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold mb-0.5">Opportunity Types</h3>
                      <p className="text-xs text-muted-foreground mb-3">Add or toggle opportunity record types used when logging opportunities.</p>
                    </div>
                    <ListEditor items={oppTypes} setItems={setOppTypes} placeholder="New opportunity type…" />
                  </div>
                )}

                {activeSection === "statuslabels" && (
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold mb-0.5">Account Status Labels</h3>
                      <p className="text-xs text-muted-foreground mb-3">Manage account status options with custom colors.</p>
                    </div>
                    <StatusLabelEditor />
                  </div>
                )}

                {activeSection === "leadsources" && (
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold mb-0.5">Lead Sources</h3>
                      <p className="text-xs text-muted-foreground mb-3">Configure lead source options available when creating accounts.</p>
                    </div>
                    <ListEditor items={leadSources} setItems={setLeadSources} placeholder="New lead source…" />
                  </div>
                )}

                {activeSection === "ownership" && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold mb-0.5">Ownership Rules</h3>
                      <p className="text-xs text-muted-foreground mb-3">Control how account ownership transfers work.</p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold">Ownership Request Mode</Label>
                      <div className="grid grid-cols-1 gap-2">
                        {[
                          { value: "approval_required", label: "Requires Admin Approval", desc: "Reps submit a request; admins approve or deny." },
                          { value: "self_assign", label: "Self-Assign (No Approval)", desc: "Reps can claim any unowned account directly." },
                        ].map(opt => (
                          <button key={opt.value} onClick={() => setOwnershipMode(opt.value)} className={`text-left p-3 rounded-md border text-sm transition-colors ${ownershipMode === opt.value ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`} data-testid={`ownership-mode-${opt.value}`}>
                            <p className="font-medium">{opt.label}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold">Stale Account Threshold (days)</Label>
                      <p className="text-xs text-muted-foreground">Accounts not updated in this many days are flagged as stale.</p>
                      <div className="flex items-center gap-2">
                        <Input type="number" min={1} max={90} value={staleThreshold} onChange={e => setStaleThreshold(parseInt(e.target.value) || 14)} className="h-8 w-24 text-sm" data-testid="input-stale-threshold" />
                        <span className="text-xs text-muted-foreground">days (default: 14)</span>
                      </div>
                    </div>
                    <div className="border-t pt-3">
                      <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => { onClose(); openOwnershipQueue(); }} data-testid="button-goto-ownership-queue">
                        <ShieldCheck className="h-3.5 w-3.5" /> View Ownership Request Queue
                      </Button>
                    </div>
                  </div>
                )}

                {activeSection === "reqfields" && (
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold mb-0.5">Required Fields</h3>
                      <p className="text-xs text-muted-foreground mb-3">Toggle which fields must be filled when creating or editing a prospect.</p>
                    </div>
                    <div className="space-y-2">
                      {REQUIRED_FIELD_OPTIONS.map(f => (
                        <div key={f.key} className="flex items-center justify-between py-1.5 border-b last:border-0" data-testid={`req-field-row-${f.key}`}>
                          <span className="text-sm">{f.label}</span>
                          <button onClick={() => setRequiredFields(rf => ({ ...rf, [f.key]: !rf[f.key] }))} className={`${requiredFields[f.key] ? "text-emerald-600" : "text-muted-foreground"}`} data-testid={`toggle-req-field-${f.key}`}>
                            {requiredFields[f.key] ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeSection === "queue" && (
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold mb-0.5">Ownership Request Queue</h3>
                      <p className="text-xs text-muted-foreground mb-3">Approve or deny pending account ownership transfer requests from reps.</p>
                    </div>
                    <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => { onClose(); openOwnershipQueue(); }} data-testid="button-open-ownership-queue">
                      <ShieldCheck className="h-3.5 w-3.5" /> Open Full Ownership Queue
                    </Button>
                    <OwnershipQueueInline />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="border-t px-6 py-3 flex justify-end gap-2 shrink-0 bg-background">
          <Button variant="outline" onClick={onClose} data-testid="button-crm-settings-cancel">Cancel</Button>
          <Button onClick={saveAll} disabled={saveMutation.isPending || activeSection === "queue"} data-testid="button-crm-settings-save">
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
