/**
 * CommitDialog — lightweight commitment capture from any Phase 2 portlet row.
 * Pre-fills text, lever, and company context. User can adjust before saving.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Zap } from "lucide-react";

export const LEVERS = [
  "Recovery",
  "Contact Mapping",
  "Lane ID",
  "Spot-to-Contract",
  "Referral",
  "Relationship Advance",
] as const;

export type Lever = typeof LEVERS[number];

export interface CommitPayload {
  companyId?: string;
  companyName?: string;
  contactId?: string;
  contactName?: string;
  defaultText: string;
  defaultLever: Lever;
  source: string;
}

interface Props {
  payload: CommitPayload | null;
  onClose: () => void;
}

export function CommitDialog({ payload, onClose }: Props) {
  const { toast } = useToast();
  const [text, setText] = useState(payload?.defaultText ?? "");
  const [lever, setLever] = useState<Lever>(payload?.defaultLever ?? "Recovery");

  // Reset state when payload changes
  const open = payload !== null;

  const mutation = useMutation({
    mutationFn: (body: object) => apiRequest("POST", "/api/weekly-commitments", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/weekly-commitments"] });
      toast({ title: "Committed for this week!", description: text });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to save commitment", variant: "destructive" });
    },
  });

  function handleSubmit() {
    if (!payload || !text.trim()) return;
    mutation.mutate({
      companyId: payload.companyId,
      companyName: payload.companyName,
      contactId: payload.contactId,
      contactName: payload.contactName,
      commitmentText: text.trim(),
      lever,
      source: payload.source,
    });
  }

  // Keep local state in sync with incoming payload
  if (payload && text === "" && payload.defaultText) {
    setText(payload.defaultText);
    setLever(payload.defaultLever);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) { onClose(); setText(""); }
      }}
    >
      <DialogContent className="max-w-md" data-testid="commit-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-amber-500" />
            Commit to this week
          </DialogTitle>
        </DialogHeader>

        {payload?.companyName && (
          <div className="flex items-center gap-1.5 flex-wrap -mt-1 mb-0.5">
            <span className="text-xs text-muted-foreground">Account:</span>
            <Badge variant="secondary" className="text-xs font-medium">{payload.companyName}</Badge>
            {payload.contactName && (
              <>
                <span className="text-xs text-muted-foreground">· Contact:</span>
                <Badge variant="outline" className="text-xs">{payload.contactName}</Badge>
              </>
            )}
          </div>
        )}

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What will you do this week?"
          rows={3}
          className="resize-none text-sm"
          data-testid="input-commit-text"
          autoFocus
        />

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground font-medium">Category / Lever</span>
          <Select value={lever} onValueChange={(v) => setLever(v as Lever)}>
            <SelectTrigger className="h-8 text-sm" data-testid="select-commit-lever">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVERS.map((l) => (
                <SelectItem key={l} value={l} data-testid={`lever-option-${l}`}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-[10px] text-muted-foreground -mt-1">
          Due: end of this week (Friday). You can mark it complete from your Commitments panel.
        </p>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { onClose(); setText(""); }} data-testid="button-commit-cancel">
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!text.trim() || mutation.isPending}
            onClick={handleSubmit}
            data-testid="button-commit-save"
            className="bg-amber-500 hover:bg-amber-600 text-white"
          >
            {mutation.isPending ? "Saving…" : "Commit this week"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
