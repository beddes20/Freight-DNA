import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Target, Trophy, ChevronDown, ChevronUp, ClipboardList, Plus, Pencil, Check, X, Trash2,
} from "lucide-react";

type CrmOpportunity = {
  id: number;
  companyId: string | null;
  prospectId: number | null;
  organizationId: string;
  name: string;
  stage: string;
  amount: string | null;
  closeDate: string | null;
  probability: number | null;
  notes: string | null;
  lostReason: string | null;
  outcome: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};

const STAGES: { value: string; label: string }[] = [
  { value: "qualification", label: "Qualification" },
  { value: "proposal", label: "Proposal" },
  { value: "negotiation", label: "Negotiation" },
  { value: "closed_won", label: "Closed Won" },
  { value: "closed_lost", label: "Closed Lost" },
];

const STAGE_COLORS: Record<string, string> = {
  qualification:  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  proposal:       "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  negotiation:    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  closed_won:     "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  closed_lost:    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

const OUTCOME_COLORS: Record<string, string> = {
  closed_won:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  closed_lost: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

interface OpportunitiesTabProps {
  companyId: string;
  companyName: string;
  onCreateTask: (title: string, notes?: string, opportunityId?: number) => void;
}

interface NewOppForm {
  name: string;
  stage: string;
  amount: string;
  closeDate: string;
  notes: string;
}

const defaultNewForm: NewOppForm = {
  name: "",
  stage: "qualification",
  amount: "",
  closeDate: "",
  notes: "",
};

export function OpportunitiesTab({
  companyId,
  companyName,
  onCreateTask,
}: OpportunitiesTabProps) {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editStage, setEditStage] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewOppForm>(defaultNewForm);

  const queryKey = ["/api/companies", companyId, "opportunities"];

  const { data: opps = [], isLoading } = useQuery<CrmOpportunity[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/opportunities`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch opportunities");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (form: NewOppForm) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/opportunities`, {
        name: form.name.trim(),
        stage: form.stage,
        amount: form.amount.trim() || null,
        closeDate: form.closeDate || null,
        notes: form.notes.trim() || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setShowNewForm(false);
      setNewForm(defaultNewForm);
      toast({ title: "Opportunity added" });
    },
    onError: () => toast({ title: "Failed to add opportunity", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<CrmOpportunity> }) => {
      const res = await apiRequest("PATCH", `/api/companies/${companyId}/opportunities/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setEditingId(null);
      toast({ title: "Opportunity updated" });
    },
    onError: () => toast({ title: "Failed to update opportunity", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/companies/${companyId}/opportunities/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Opportunity deleted" });
    },
    onError: () => toast({ title: "Failed to delete opportunity", variant: "destructive" }),
  });

  const startEdit = (opp: CrmOpportunity) => {
    setEditingId(opp.id);
    setEditNotes(opp.notes ?? "");
    setEditStage(opp.stage);
    setExpandedId(opp.id);
  };

  const saveEdit = (opp: CrmOpportunity) => {
    updateMutation.mutate({ id: opp.id, data: { notes: editNotes || null, stage: editStage } });
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    try {
      return new Date(dateStr + (dateStr.includes("T") ? "" : "T00:00:00")).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
    } catch { return dateStr; }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }

  const openCount = opps.filter(o => !o.outcome).length;
  const wonCount  = opps.filter(o => o.outcome === "closed_won").length;
  const lostCount = opps.filter(o => o.outcome === "closed_lost").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          {openCount > 0 && (
            <span className="flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400">
              <Target className="h-3.5 w-3.5" />
              {openCount} Open
            </span>
          )}
          {wonCount > 0 && (
            <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              <Trophy className="h-3.5 w-3.5" />
              {wonCount} {wonCount === 1 ? "Win" : "Wins"}
            </span>
          )}
          {lostCount > 0 && (
            <span className="text-xs font-semibold text-red-500 dark:text-red-400">
              {lostCount} Lost
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 h-7 text-xs"
          onClick={() => { setShowNewForm(v => !v); setEditingId(null); }}
          data-testid="button-add-opportunity"
        >
          <Plus className="h-3 w-3" />
          Add Opportunity
        </Button>
      </div>

      {showNewForm && (
        <Card data-testid="card-new-opportunity-form">
          <CardContent className="p-4 space-y-3">
            <p className="text-sm font-semibold">New Opportunity</p>
            <Input
              placeholder="Opportunity name *"
              value={newForm.name}
              onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
              data-testid="input-new-opp-name"
            />
            <div className="grid grid-cols-2 gap-2">
              <Select value={newForm.stage} onValueChange={v => setNewForm(f => ({ ...f, stage: v }))}>
                <SelectTrigger data-testid="select-new-opp-stage">
                  <SelectValue placeholder="Stage" />
                </SelectTrigger>
                <SelectContent>
                  {STAGES.map(s => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Amount (e.g. 50000)"
                value={newForm.amount}
                onChange={e => setNewForm(f => ({ ...f, amount: e.target.value }))}
                data-testid="input-new-opp-amount"
              />
            </div>
            <Input
              type="date"
              placeholder="Expected close date"
              value={newForm.closeDate}
              onChange={e => setNewForm(f => ({ ...f, closeDate: e.target.value }))}
              data-testid="input-new-opp-close-date"
            />
            <Textarea
              placeholder="Notes (optional)"
              value={newForm.notes}
              onChange={e => setNewForm(f => ({ ...f, notes: e.target.value }))}
              className="min-h-[60px] text-sm"
              data-testid="textarea-new-opp-notes"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={createMutation.isPending || !newForm.name.trim()}
                onClick={() => createMutation.mutate(newForm)}
                data-testid="button-save-new-opp"
              >
                <Check className="h-3 w-3" />
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => { setShowNewForm(false); setNewForm(defaultNewForm); }}
                data-testid="button-cancel-new-opp"
              >
                <X className="h-3 w-3" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {opps.length === 0 && !showNewForm ? (
        <Card data-testid="card-no-opportunities">
          <CardContent className="py-10 text-center">
            <Target className="h-10 w-10 mx-auto mb-3 text-muted-foreground opacity-30" />
            <p className="text-sm font-medium text-muted-foreground">No opportunities yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">Track deals and wins for this account.</p>
            <Button size="sm" variant="outline" onClick={() => setShowNewForm(true)} data-testid="button-add-first-opp">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add First Opportunity
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {opps.map(opp => {
            const isExpanded = expandedId === opp.id;
            const isEditing  = editingId === opp.id;
            const stageLbl = STAGES.find(s => s.value === opp.stage)?.label ?? opp.stage;

            return (
              <Card key={opp.id} data-testid={`card-opportunity-${opp.id}`} className="transition-all">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${opp.outcome === "closed_won" ? OUTCOME_COLORS.closed_won : opp.outcome === "closed_lost" ? OUTCOME_COLORS.closed_lost : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"}`}>
                      {opp.outcome === "closed_won" ? <Trophy className="h-3.5 w-3.5" /> : <Target className="h-3.5 w-3.5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold" data-testid={`text-opp-name-${opp.id}`}>{opp.name}</p>
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 font-medium border-0 ${STAGE_COLORS[opp.stage] ?? ""}`} data-testid={`badge-opp-stage-${opp.id}`}>
                          {stageLbl}
                        </Badge>
                        {opp.outcome && (
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 font-medium border-0 ${OUTCOME_COLORS[opp.outcome] ?? ""}`} data-testid={`badge-opp-outcome-${opp.id}`}>
                            {opp.outcome === "closed_won" ? "Won" : "Lost"}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        {opp.closeDate && (
                          <span className="text-xs text-muted-foreground">Close: {formatDate(opp.closeDate)}</span>
                        )}
                        {opp.amount && (
                          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            ${parseFloat(opp.amount).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : opp.id)}
                      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5"
                      data-testid={`button-expand-opp-${opp.id}`}
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="mt-3 pl-10 space-y-3 border-t pt-3">
                      {isEditing ? (
                        <div className="space-y-2">
                          <Select value={editStage} onValueChange={setEditStage}>
                            <SelectTrigger className="h-8 text-xs" data-testid={`select-edit-stage-${opp.id}`}>
                              <SelectValue placeholder="Stage" />
                            </SelectTrigger>
                            <SelectContent>
                              {STAGES.map(s => (
                                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Textarea
                            value={editNotes}
                            onChange={e => setEditNotes(e.target.value)}
                            placeholder="Add notes about this opportunity…"
                            className="min-h-[80px] text-sm"
                            data-testid={`textarea-opp-notes-${opp.id}`}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="h-7 text-xs gap-1"
                              onClick={() => saveEdit(opp)}
                              disabled={updateMutation.isPending}
                              data-testid={`button-save-opp-edit-${opp.id}`}
                            >
                              <Check className="h-3 w-3" />
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1"
                              onClick={() => setEditingId(null)}
                              data-testid={`button-cancel-opp-edit-${opp.id}`}
                            >
                              <X className="h-3 w-3" />
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {opp.notes ? (
                            <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed" data-testid={`text-opp-notes-${opp.id}`}>
                              {opp.notes}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">No notes yet.</p>
                          )}
                          <div className="flex gap-2 mt-2 flex-wrap">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1"
                              onClick={() => startEdit(opp)}
                              data-testid={`button-edit-opp-${opp.id}`}
                            >
                              <Pencil className="h-3 w-3" />
                              {opp.notes ? "Edit" : "Add Notes"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs gap-1"
                              onClick={() => onCreateTask(
                                `Follow up: ${opp.name}`,
                                `Opportunity for ${companyName}${opp.notes ? `\n\n${opp.notes}` : ""}`,
                                opp.id
                              )}
                              data-testid={`button-create-task-from-opp-${opp.id}`}
                            >
                              <ClipboardList className="h-3 w-3" />
                              Create Task
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs gap-1 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20"
                              onClick={() => deleteMutation.mutate(opp.id)}
                              disabled={deleteMutation.isPending}
                              data-testid={`button-delete-opp-${opp.id}`}
                            >
                              <Trash2 className="h-3 w-3" />
                              Delete
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
