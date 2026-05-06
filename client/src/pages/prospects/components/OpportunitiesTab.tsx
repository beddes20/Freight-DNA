import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Target, Pencil, Trash2, Loader2 } from "lucide-react";
import {
  CRM_OPP_RECORD_TYPES, CRM_OPP_STAGES,
  CRM_OPP_RECORD_TYPE_LABELS, CRM_OPP_STAGE_LABELS,
} from "@shared/schema";
import { formatCurrency } from "../utils";

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

type CrmOpportunity = {
  id: number; prospectId: number; organizationId: string; name: string; recordType: string;
  stage: string; amount?: string | null; closeDate?: string | null; probability?: number | null;
  notes?: string | null; lostReason?: string | null; createdById: string; createdAt: string; updatedAt: string;
};

function parseAmount(s?: string | null): number {
  if (!s) return 0;
  return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
}

function NewOpportunityDialog({ prospectId, onClose, onCreated }: { prospectId: number; onClose: () => void; onCreated: (opp: CrmOpportunity) => void }) {
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
          <DialogTitle>{step === 1 ? "New Opportunity — Select Type" : "New Opportunity — Details"}</DialogTitle>
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
                  <p className="font-medium text-sm">{CRM_OPP_RECORD_TYPE_LABELS[rt as keyof typeof CRM_OPP_RECORD_TYPE_LABELS]}</p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${OPP_TYPE_COLORS[recordType] ?? "bg-muted text-muted-foreground"}`}>
                {CRM_OPP_RECORD_TYPE_LABELS[recordType as keyof typeof CRM_OPP_RECORD_TYPE_LABELS]}
              </span>
            </div>
            <div className="grid gap-3">
              <div>
                <Label>Opportunity Name *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Chicago → Dallas lanes (12 loads/wk)" className="mt-1" data-testid="input-opp-name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Stage</Label>
                  <Select value={form.stage} onValueChange={v => setForm(f => ({ ...f, stage: v }))}>
                    <SelectTrigger className="mt-1" data-testid="select-opp-stage"><SelectValue /></SelectTrigger>
                    <SelectContent>{CRM_OPP_STAGES.map(s => <SelectItem key={s} value={s}>{CRM_OPP_STAGE_LABELS[s as keyof typeof CRM_OPP_STAGE_LABELS]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Probability %</Label>
                  <Input type="number" min="0" max="100" value={form.probability} onChange={e => setForm(f => ({ ...f, probability: e.target.value }))} placeholder="0–100" className="mt-1" data-testid="input-opp-prob" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Est. Revenue / Mo</Label>
                  <Input value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="$50,000" className="mt-1" data-testid="input-opp-amount" />
                </div>
                <div>
                  <Label>Est. Close Date</Label>
                  <Input type="date" value={form.closeDate} onChange={e => setForm(f => ({ ...f, closeDate: e.target.value }))} className="mt-1" data-testid="input-opp-close" />
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Key details, lane specifics, requirements…" className="mt-1 min-h-[70px]" data-testid="input-opp-notes" />
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={onClose} data-testid="button-opp-cancel">Cancel</Button>
              <Button onClick={() => setStep(2)} disabled={!recordType} data-testid="button-opp-next">Next</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)} data-testid="button-opp-back">Back</Button>
              <Button onClick={handleSubmit} disabled={!form.name.trim() || createMutation.isPending} data-testid="button-opp-save">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Create Opportunity
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOpportunityDialog({ opp, prospectId, onClose, onUpdated }: { opp: CrmOpportunity; prospectId: number; onClose: () => void; onUpdated: (updated: CrmOpportunity) => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: opp.name, recordType: opp.recordType, stage: opp.stage,
    amount: opp.amount ?? "", closeDate: opp.closeDate ?? "",
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
                <SelectContent>{CRM_OPP_RECORD_TYPES.map(rt => <SelectItem key={rt} value={rt}>{CRM_OPP_RECORD_TYPE_LABELS[rt as keyof typeof CRM_OPP_RECORD_TYPE_LABELS]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Stage</Label>
              <Select value={form.stage} onValueChange={v => setForm(f => ({ ...f, stage: v }))}>
                <SelectTrigger className="mt-1" data-testid="select-edit-opp-stage"><SelectValue /></SelectTrigger>
                <SelectContent>{CRM_OPP_STAGES.map(s => <SelectItem key={s} value={s}>{CRM_OPP_STAGE_LABELS[s as keyof typeof CRM_OPP_STAGE_LABELS]}</SelectItem>)}</SelectContent>
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

export function OpportunitiesTab({ prospectId, onClosedWon }: { prospectId: number; orgId?: string; userId?: string; onClosedWon?: () => void }) {
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
    if (created.stage === "closed_won" && onClosedWon) onClosedWon();
  };

  const handleUpdated = (updated: CrmOpportunity) => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ["/api/prospects/opportunities-summary"] });
    if (updated.stage === "closed_won" && onClosedWon) onClosedWon();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Opportunities ({opps.length})</p>
          {totalPipeline > 0 && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold mt-0.5">{formatCurrency(totalPipeline)}/mo open pipeline</p>
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
                  <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">{o.closeDate || "—"}</td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">{o.probability != null ? `${o.probability}%` : "—"}</td>
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
