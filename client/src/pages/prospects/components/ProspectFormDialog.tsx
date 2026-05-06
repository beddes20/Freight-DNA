import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import {
  PROSPECT_STAGE_LABELS,
  PROSPECT_LEAD_SOURCES,
  PROSPECT_LEAD_SOURCE_LABELS,
} from "@shared/schema";
import type { ProspectStage } from "@shared/schema";
import { ACTIVE_STAGES } from "../types";
import type { EnrichedProspect } from "../types";

export function ProspectFormDialog({
  open, onClose, editing, currentUserId, users,
  activeStages: stagesOverride, stageLabels: stageLabelsOverride,
  leadSources: leadSourcesOverride,
  requiredFields: requiredFieldsOverride,
}: {
  open: boolean; onClose: () => void; editing?: EnrichedProspect | null;
  currentUserId: string; users: any[];
  activeStages?: ProspectStage[];
  stageLabels?: Record<string, string>;
  leadSources?: Array<{ key: string; label: string }>;
  requiredFields?: Record<string, boolean>;
}) {
  const resolvedActiveStages = stagesOverride ?? ACTIVE_STAGES;
  const resolvedStageLabels = stageLabelsOverride ?? PROSPECT_STAGE_LABELS;
  const resolvedLeadSources = leadSourcesOverride ?? PROSPECT_LEAD_SOURCES.map(k => ({ key: k, label: PROSPECT_LEAD_SOURCE_LABELS[k] ?? k }));
  const resolvedRequiredFields = requiredFieldsOverride ?? {};
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
    if (p.dealProbability !== "") p.dealProbability = parseInt(p.dealProbability);
    else p.dealProbability = null;
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
    const RF_CHECK: Array<{ key: string; label: string; value: string | undefined }> = [
      { key: "primaryContactName", label: "Primary Contact Name", value: values.primaryContactName },
      { key: "primaryContactEmail", label: "Primary Contact Email", value: values.primaryContactEmail },
      { key: "leadSource", label: "Lead Source", value: values.leadSource },
      { key: "estimatedSpend", label: "Est. Freight Spend", value: values.estimatedSpend },
    ];
    for (const f of RF_CHECK) {
      if (resolvedRequiredFields[f.key] && !f.value?.trim()) {
        return toast({ title: `${f.label} is required`, variant: "destructive" });
      }
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
                    {resolvedLeadSources.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
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
                    {resolvedActiveStages.map(s => <SelectItem key={s} value={s}>{resolvedStageLabels[s] ?? PROSPECT_STAGE_LABELS[s]}</SelectItem>)}
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
                <Label>Assigned To</Label>
                <Select value={values.ownerId} onValueChange={v => set("ownerId", v)}>
                  <SelectTrigger className="mt-1" data-testid="select-owner"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {users.map(u => <SelectItem key={u.id} value={u.id}>{u.name ?? u.username}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Follow-up Date</Label>
                <Input data-testid="input-follow-up-date" type="date" value={values.followUpDate} onChange={e => set("followUpDate", e.target.value)} className="mt-1" />
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
