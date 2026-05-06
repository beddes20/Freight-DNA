// Task #950 — Context Note composer.
//
// Single shared composer for every anchor surface. Drives:
//   - body (4000 char cap, mirrors server-side schema)
//   - actionType (FYI/Question/Please review/Please handle/Decision needed)
//   - mention picker (other reps in the same org, excluding self)

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { AtSign, Loader2, Send, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import type { ContextNoteActionType } from "@shared/schema";
import type { Anchor } from "./types";
import { useCreateContextNote } from "./useContextNotes";

type OrgUser = { id: string; name: string; role?: string };

const ACTION_OPTIONS: Array<{ value: ContextNoteActionType; label: string }> = [
  { value: "fyi",             label: "FYI" },
  { value: "question",        label: "Question" },
  { value: "please_review",   label: "Please review" },
  { value: "please_handle",   label: "Please handle" },
  { value: "decision_needed", label: "Decision needed" },
];

interface Props {
  anchor: Anchor;
  /** Render in a tighter footprint when embedded inside a row pop-out. */
  compact?: boolean;
  onCreated?: () => void;
}

export function ContextNoteComposer({ anchor, compact, onCreated }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [body, setBody] = useState("");
  const [actionType, setActionType] = useState<ContextNoteActionType>("fyi");
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");

  const { data: usersList = [] } = useQuery<OrgUser[]>({
    queryKey: ["/api/users"],
  });

  const candidates = useMemo(() => {
    const meId = user?.id;
    return usersList
      .filter(u => u.id !== meId)
      .filter(u => !mentionFilter || u.name.toLowerCase().includes(mentionFilter.toLowerCase()))
      .slice(0, 25);
  }, [usersList, user?.id, mentionFilter]);

  const mentionedUsers = useMemo(
    () => mentionIds.map(id => usersList.find(u => u.id === id)).filter(Boolean) as OrgUser[],
    [mentionIds, usersList],
  );

  const create = useCreateContextNote();

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) {
      toast({ title: "Note cannot be empty", variant: "destructive" });
      return;
    }
    try {
      await create.mutateAsync({
        anchor,
        body: trimmed,
        actionType,
        mentions: mentionIds,
      });
      setBody("");
      setMentionIds([]);
      setActionType("fyi");
      onCreated?.();
    } catch (e: any) {
      toast({ title: "Could not post note", description: e?.message ?? "", variant: "destructive" });
    }
  };

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <Textarea
        value={body}
        onChange={e => setBody(e.target.value.slice(0, 4000))}
        placeholder="Add a note for your team. @-mention to ping someone."
        rows={compact ? 2 : 3}
        className="resize-none"
        data-testid="textarea-context-note-body"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={actionType} onValueChange={(v) => setActionType(v as ContextNoteActionType)}>
          <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-context-note-action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTION_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" data-testid="button-context-note-mention">
              <AtSign className="h-3.5 w-3.5" />
              Mention
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <input
              autoFocus
              className="w-full rounded-md border px-2 py-1 text-sm"
              placeholder="Search teammates…"
              value={mentionFilter}
              onChange={e => setMentionFilter(e.target.value)}
              data-testid="input-context-note-mention-search"
            />
            <div className="mt-2 max-h-60 overflow-y-auto">
              {candidates.length === 0 && (
                <div className="text-xs text-muted-foreground px-2 py-3">No matches</div>
              )}
              {candidates.map(u => {
                const selected = mentionIds.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    className={`w-full text-left text-sm px-2 py-1.5 rounded-md hover:bg-muted ${selected ? "bg-muted" : ""}`}
                    onClick={() => {
                      setMentionIds(prev => prev.includes(u.id)
                        ? prev.filter(x => x !== u.id)
                        : [...prev, u.id]);
                    }}
                    data-testid={`option-context-note-mention-${u.id}`}
                  >
                    <span>{u.name}</span>
                    {selected && <span className="ml-2 text-xs text-primary">✓</span>}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex flex-wrap gap-1 flex-1 min-w-0">
          {mentionedUsers.map(u => (
            <Badge key={u.id} variant="secondary" className="gap-1 text-xs">
              @{u.name}
              <button
                type="button"
                className="ml-0.5 hover:text-destructive"
                onClick={() => setMentionIds(prev => prev.filter(x => x !== u.id))}
                aria-label={`Remove ${u.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>

        <Button
          size="sm"
          onClick={submit}
          disabled={create.isPending || !body.trim()}
          className="ml-auto h-8 gap-1"
          data-testid="button-context-note-submit"
        >
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Post
        </Button>
      </div>
    </div>
  );
}
