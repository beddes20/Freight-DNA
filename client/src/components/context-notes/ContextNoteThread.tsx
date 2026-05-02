// Task #950 — Threaded view for an anchor's context notes.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2, ListTodo, MessageCircle, Reply, RotateCcw, Loader2, AtSign, Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import type { ContextNoteActionType, ContextNoteStatus } from "@shared/schema";
import type { Anchor, ContextNoteWithExtras } from "./types";
import {
  useContextNotes,
  useReplyToContextNote,
  useTransitionContextNote,
  useConvertContextNoteToTask,
} from "./useContextNotes";

const ACTION_LABEL: Record<ContextNoteActionType, string> = {
  fyi:             "FYI",
  question:        "Question",
  please_review:   "Please review",
  please_handle:   "Please handle",
  decision_needed: "Decision needed",
};

const ACTION_COLOR: Record<ContextNoteActionType, string> = {
  fyi:             "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  question:        "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  please_review:   "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  please_handle:   "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  decision_needed: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
};

const STATUS_COLOR: Record<ContextNoteStatus, string> = {
  open:         "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300",
  acknowledged: "border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300",
  resolved:     "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300",
};

interface Props {
  anchor: Anchor;
  highlightNoteId?: string | null;
}

export function ContextNoteThread({ anchor, highlightNoteId }: Props) {
  const { data: notes = [], isLoading } = useContextNotes(anchor);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading notes…
      </div>
    );
  }
  if (notes.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-3" data-testid="text-context-notes-empty">
        No notes yet. Post one above to share context with your team.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {notes.map(n => (
        <NoteCard
          key={n.id}
          note={n}
          anchor={anchor}
          highlight={highlightNoteId === n.id}
        />
      ))}
    </div>
  );
}

function NoteCard({ note, anchor, highlight }: { note: ContextNoteWithExtras; anchor: Anchor; highlight: boolean }) {
  const { user } = useAuth();
  const isAuthor = user?.id === note.authorId;
  const isMentioned = note.mentions.some(m => m.userId === user?.id);
  const canTransition = isAuthor || isMentioned;
  const transition = useTransitionContextNote(note.id, anchor);
  const [showReplies, setShowReplies] = useState<boolean>(highlight || false);
  const [showConvert, setShowConvert] = useState(false);

  return (
    <div
      id={`context-note-${note.id}`}
      className={cn(
        "rounded-lg border p-3 space-y-2",
        highlight && "border-amber-400 ring-2 ring-amber-200/60 dark:ring-amber-800/50",
      )}
      data-testid={`card-context-note-${note.id}`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground" data-testid={`text-context-note-author-${note.id}`}>
              {note.authorName ?? "Unknown"}
            </span>
            <Badge variant="secondary" className={cn("text-[10px] px-1.5", ACTION_COLOR[note.actionType as ContextNoteActionType])}>
              {ACTION_LABEL[note.actionType as ContextNoteActionType] ?? note.actionType}
            </Badge>
            <Badge variant="outline" className={cn("text-[10px] px-1.5", STATUS_COLOR[note.status as ContextNoteStatus])}>
              {note.status}
            </Badge>
            <span>·</span>
            <span title={new Date(note.createdAt as unknown as string).toLocaleString()}>
              {formatDistanceToNow(new Date(note.createdAt as unknown as string), { addSuffix: true })}
            </span>
          </div>
          <p className="text-sm whitespace-pre-wrap">{note.body}</p>
          {note.mentions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-1">
              <AtSign className="h-3 w-3 text-muted-foreground" />
              {note.mentions.map(m => (
                <span key={m.userId} className="text-xs text-muted-foreground">
                  {m.name ?? "—"}
                  {m === note.mentions[note.mentions.length - 1] ? "" : ","}
                </span>
              ))}
            </div>
          )}
          {note.convertedTaskId && (
            <div className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1 pt-1">
              <ListTodo className="h-3 w-3" /> Converted to task
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 pt-1">
        <Button
          size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1"
          onClick={() => setShowReplies(v => !v)}
          data-testid={`button-context-note-toggle-replies-${note.id}`}
        >
          <Reply className="h-3 w-3" />
          {note.replyCount > 0 ? `${note.replyCount} replies` : "Reply"}
        </Button>
        {canTransition && note.status === "open" && (
          <Button
            size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1"
            onClick={() => transition.mutate("acknowledged")}
            disabled={transition.isPending}
            data-testid={`button-context-note-acknowledge-${note.id}`}
          >
            <Eye className="h-3 w-3" /> Acknowledge
          </Button>
        )}
        {canTransition && note.status !== "resolved" && (
          <Button
            size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1"
            onClick={() => transition.mutate("resolved")}
            disabled={transition.isPending}
            data-testid={`button-context-note-resolve-${note.id}`}
          >
            <CheckCircle2 className="h-3 w-3" /> Resolve
          </Button>
        )}
        {canTransition && note.status === "resolved" && (
          <Button
            size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1"
            onClick={() => transition.mutate("open")}
            disabled={transition.isPending}
            data-testid={`button-context-note-reopen-${note.id}`}
          >
            <RotateCcw className="h-3 w-3" /> Reopen
          </Button>
        )}
        {canTransition && !note.convertedTaskId && (
          <Button
            size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1"
            onClick={() => setShowConvert(true)}
            data-testid={`button-context-note-convert-${note.id}`}
          >
            <ListTodo className="h-3 w-3" /> Convert to task
          </Button>
        )}
      </div>

      {showReplies && <RepliesArea noteId={note.id} anchor={anchor} />}

      {showConvert && (
        <ConvertDialog
          open={showConvert}
          onOpenChange={setShowConvert}
          noteId={note.id}
          noteBody={note.body}
          anchor={anchor}
        />
      )}
    </div>
  );
}

function RepliesArea({ noteId, anchor }: { noteId: string; anchor: Anchor }) {
  const { toast } = useToast();
  const { data } = useQuery<{ replies: Array<{ id: string; body: string; authorName: string | null; createdAt: string }> }>({
    queryKey: ["/api/context-notes", noteId],
  });
  const reply = useReplyToContextNote(noteId, anchor);
  const [draft, setDraft] = useState("");
  const replies = data?.replies ?? [];

  const submit = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    try {
      await reply.mutateAsync(trimmed);
      setDraft("");
    } catch (e: any) {
      toast({ title: "Could not reply", description: e?.message ?? "", variant: "destructive" });
    }
  };

  return (
    <div className="ml-4 mt-2 border-l pl-3 space-y-2">
      {replies.map(r => (
        <div key={r.id} className="text-sm" data-testid={`text-context-note-reply-${r.id}`}>
          <span className="font-medium">{r.authorName ?? "Unknown"}</span>
          <span className="text-xs text-muted-foreground ml-1">
            · {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
          </span>
          <p className="whitespace-pre-wrap text-sm">{r.body}</p>
        </div>
      ))}
      <div className="flex gap-2">
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value.slice(0, 4000))}
          rows={2}
          placeholder="Reply…"
          className="text-sm resize-none"
          data-testid={`textarea-context-note-reply-${noteId}`}
        />
        <Button
          size="sm"
          onClick={submit}
          disabled={reply.isPending || !draft.trim()}
          data-testid={`button-context-note-reply-submit-${noteId}`}
        >
          {reply.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Send"}
        </Button>
      </div>
    </div>
  );
}

function ConvertDialog({
  open, onOpenChange, noteId, noteBody, anchor,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  noteId: string;
  noteBody: string;
  anchor: Anchor;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: usersList = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/users"],
  });
  const convert = useConvertContextNoteToTask(noteId, anchor);
  const [assignee, setAssignee] = useState<string>(user?.id ?? "");
  const [title, setTitle] = useState<string>(noteBody.split("\n")[0].slice(0, 140));
  const [dueDate, setDueDate] = useState<string>("");

  const submit = async () => {
    if (!assignee) return;
    try {
      await convert.mutateAsync({
        assignedTo: assignee,
        title: title || undefined,
        dueDate: dueDate || null,
      });
      toast({ title: "Converted to task" });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Could not convert", description: e?.message ?? "", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Convert note to task</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs text-muted-foreground">Title</label>
            <Input value={title} onChange={e => setTitle(e.target.value)} data-testid="input-convert-title" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Assignee</label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger data-testid="select-convert-assignee"><SelectValue placeholder="Pick…" /></SelectTrigger>
              <SelectContent>
                {usersList.map(u => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Due date (optional)</label>
            <Input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              data-testid="input-convert-due-date"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={convert.isPending || !assignee} data-testid="button-convert-submit">
            {convert.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
