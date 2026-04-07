/**
 * CommitDialog — lightweight freight growth commitment capture.
 * Opens from a Phase 2 portlet recommendation row.
 * Pre-fills account, contact, lever, and action text. Rep can refine before committing.
 */

import { useState, useEffect } from "react";
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
import { LEVERS } from "./commitTypes";
import type { Lever, CommitPayload } from "./commitTypes";

export type { Lever, CommitPayload };

interface Props {
  payload: CommitPayload | null;
  onClose: () => void;
}

export function CommitDialog({ payload, onClose }: Props) {
  const { toast } = useToast();
  const [text, setText] = useState(payload?.defaultText ?? "");
  const [lever, setLever] = useState<Lever>(payload?.defaultLever ?? "Recovery");

  useEffect(() => {
    if (payload) {
      setText(payload.defaultText);
      setLever(payload.defaultLever);
    }
  }, [payload]);

  const mutation = useMutation({
    mutationFn: (body: object) => apiRequest("POST", "/api/weekly-commitments", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/weekly-commitments"] });
      toast({ title: "Committed for this week!", description: text });
      handleClose();
    },
    onError: () => {
      toast({ title: "Could not save commitment", variant: "destructive" });
    },
  });

  function handleClose() {
    onClose();
    setText("");
  }

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

  return (
    <Dialog
      open={payload !== null}
      onOpenChange={(v) => { if (!v) handleClose(); }}
    >
      <DialogContent className="max-w-md" data-testid="commit-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-amber-500" />
            This week's growth commitment
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

        <div className="flex flex-col gap-1">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`e.g. Pitch DAL→ATL contract at ${payload?.companyName ?? "this account"} by Thursday`}
            rows={3}
            className="resize-none text-sm"
            data-testid="input-commit-text"
            autoFocus
          />
          <p className="text-[10px] text-muted-foreground leading-snug">
            Make it specific — account, action, and deadline. Avoid generic follow-ups.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground font-medium">Growth lever</span>
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
          By when? End of this week (Friday). Mark it done from your Commitments panel.
        </p>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose} data-testid="button-commit-cancel">
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!text.trim() || mutation.isPending}
            onClick={handleSubmit}
            data-testid="button-commit-save"
            className="bg-amber-500 hover:bg-amber-600 text-white"
          >
            {mutation.isPending ? "Saving…" : "Commit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
