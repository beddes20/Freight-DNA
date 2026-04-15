/**
 * ForcedFocusDialog — manager/director Forced Focus assignment dialog.
 * Opens with optional pre-filled context (account, lever, action text).
 * Role-gated: only director/NAM/sales_director/admin can open.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Crown } from "lucide-react";
import { LEVERS } from "@/pages/dashboard/commitTypes";

interface User {
  id: string;
  name: string;
  role: string;
}

export interface ForcedFocusDialogProps {
  open: boolean;
  onClose: () => void;
  /** When provided, switches dialog to PATCH/edit mode for this FF id */
  editId?: string;
  prefill?: {
    assignedToUserId?: string;
    companyId?: string;
    companyName?: string;
    contactId?: string;
    contactName?: string;
    lever?: string;
    actionText?: string;
    contextReason?: string;
    dueDate?: string;
  };
}

export function ForcedFocusDialog({ open, onClose, editId, prefill }: ForcedFocusDialogProps) {
  const { toast } = useToast();
  const isEditMode = !!editId;

  const [assignedToUserId, setAssignedToUserId] = useState(prefill?.assignedToUserId ?? "");
  const [companyName, setCompanyName] = useState(prefill?.companyName ?? "");
  const [lever, setLever] = useState(prefill?.lever ?? "");
  const [actionText, setActionText] = useState(prefill?.actionText ?? "");
  const [contextReason, setContextReason] = useState(prefill?.contextReason ?? "");
  const [dueDate, setDueDate] = useState(prefill?.dueDate ?? "");

  useEffect(() => {
    if (open) {
      setAssignedToUserId(prefill?.assignedToUserId ?? "");
      setCompanyName(prefill?.companyName ?? "");
      setLever(prefill?.lever ?? "");
      setActionText(prefill?.actionText ?? "");
      setContextReason(prefill?.contextReason ?? "");
      setDueDate(prefill?.dueDate ?? "");
    }
  }, [open, prefill]);

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    enabled: open,
  });

  const reps = allUsers.filter(u =>
    u.role === "account_manager" ||
    u.role === "logistics_manager" ||
    u.role === "logistics_coordinator" ||
    u.role === "national_account_manager" ||
    u.role === "sales"
  ).sort((a, b) => a.name.localeCompare(b.name));

  const invalidateForcedFocusQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/forced-focus"] });
    queryClient.invalidateQueries({ queryKey: ["/api/forced-focus/my"] });
    queryClient.invalidateQueries({ queryKey: ["/api/forced-focus/team"] });
  };

  const createMutation = useMutation({
    mutationFn: (body: object) => apiRequest("POST", "/api/forced-focus", body),
    onSuccess: () => {
      invalidateForcedFocusQueries();
      toast({ title: "Leadership Priority assigned", description: actionText });
      handleClose();
    },
    onError: () => toast({ title: "Failed to assign", variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: (body: object) => apiRequest("PATCH", `/api/forced-focus/${editId}`, body),
    onSuccess: () => {
      invalidateForcedFocusQueries();
      toast({ title: "Leadership Priority updated" });
      handleClose();
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const mutation = isEditMode ? editMutation : createMutation;

  function handleClose() {
    onClose();
  }

  function handleSubmit() {
    if (!actionText.trim()) return;
    if (!isEditMode && !assignedToUserId) return;
    if (isEditMode) {
      editMutation.mutate({
        lever: lever === "none" || !lever ? null : lever,
        actionText: actionText.trim(),
        contextReason: contextReason.trim() || null,
        dueDate: dueDate || null,
        companyName: companyName || null,
      });
    } else {
      createMutation.mutate({
        assignedToUserId,
        companyId: prefill?.companyId || null,
        companyName: companyName || null,
        contactId: prefill?.contactId || null,
        contactName: prefill?.contactName || null,
        lever: lever === "none" || !lever ? null : lever,
        actionText: actionText.trim(),
        contextReason: contextReason.trim() || null,
        dueDate: dueDate || null,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-md" data-testid="forced-focus-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Crown className="h-4 w-4 text-purple-500" />
            {isEditMode ? "Edit Leadership Priority" : "Assign Leadership Priority"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {!isEditMode && (
            <div className="flex flex-col gap-1">
              <Label className="text-xs font-medium">Assign to *</Label>
              <Select value={assignedToUserId} onValueChange={setAssignedToUserId}>
                <SelectTrigger className="h-9 text-sm" data-testid="select-ff-assignee">
                  <SelectValue placeholder="Select rep…" />
                </SelectTrigger>
                <SelectContent>
                  {reps.map(u => (
                    <SelectItem key={u.id} value={u.id} data-testid={`ff-assignee-${u.id}`}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!prefill?.companyId && (
            <div className="flex flex-col gap-1">
              <Label className="text-xs font-medium">Account (optional)</Label>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Conagra"
                className="h-9 text-sm"
                data-testid="input-ff-company"
              />
            </div>
          )}

          {prefill?.companyName && (
            <div className="rounded-md bg-muted px-3 py-1.5">
              <p className="text-xs text-muted-foreground">Account: <span className="font-medium text-foreground">{prefill.companyName}</span></p>
              {prefill.contactName && <p className="text-xs text-muted-foreground">Contact: <span className="font-medium text-foreground">{prefill.contactName}</span></p>}
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label className="text-xs font-medium">Growth lever (optional)</Label>
            <Select value={lever} onValueChange={setLever}>
              <SelectTrigger className="h-9 text-sm" data-testid="select-ff-lever">
                <SelectValue placeholder="Select lever…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {LEVERS.map(l => (
                  <SelectItem key={l} value={l} data-testid={`ff-lever-${l}`}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs font-medium">Priority action *</Label>
            <Textarea
              value={actionText}
              onChange={(e) => setActionText(e.target.value)}
              placeholder="e.g. Pitch DAL→ATL contract with Conagra this week"
              rows={3}
              className="resize-none text-sm"
              data-testid="input-ff-action-text"
              autoFocus
            />
            <p className="text-[10px] text-muted-foreground">
              Be specific — account, action, and what you need them to do.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs font-medium">Context / reason (optional)</Label>
            <Textarea
              value={contextReason}
              onChange={(e) => setContextReason(e.target.value)}
              placeholder="Why is this a priority? What does the rep need to know?"
              rows={2}
              className="resize-none text-sm"
              data-testid="input-ff-context"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs font-medium">Due date (optional)</Label>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="h-9 text-sm"
              data-testid="input-ff-due-date"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose} data-testid="button-ff-cancel">
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-purple-600 hover:bg-purple-700 text-white"
            disabled={(!isEditMode && !assignedToUserId) || !actionText.trim() || mutation.isPending}
            onClick={handleSubmit}
            data-testid="button-ff-submit"
          >
            {mutation.isPending
              ? (isEditMode ? "Saving…" : "Assigning…")
              : (isEditMode ? "Save Changes" : "Assign Priority")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
