import { useState } from "react";
import { Inbox, UserCircle2, AlertCircle, Mail, Archive, DollarSign, Clock, Bookmark, Pencil, Trash2, GripVertical, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { ConversationBucket, SavedView } from "./types";

interface BucketSidebarProps {
  bucket: ConversationBucket;
  onChange: (bucket: ConversationBucket) => void;
  counts: Partial<Record<ConversationBucket, number>>;
  // Optional companion counts so a bucket can render a split badge
  // ("X waiting · Y total"). Currently used by the Quote requests bucket
  // (Task #899) where reps want to see both the actionable subset and
  // the total at a glance without having to apply a manual filter.
  secondaryCounts?: Partial<Record<ConversationBucket, number>>;
  savedViews?: SavedView[];
  activeSavedViewId?: string | null;
  onSelectSavedView?: (view: SavedView) => void;
  onRenameSavedView?: (id: string, name: string) => void;
  onDeleteSavedView?: (id: string) => void;
  onMoveSavedView?: (id: string, direction: "up" | "down") => void;
}

const BUCKETS: { id: ConversationBucket; label: string; icon: typeof Inbox; description: string }[] = [
  { id: "mine", label: "Waiting on me", icon: UserCircle2, description: "Threads I own that need a reply" },
  { id: "unowned", label: "Unassigned", icon: Inbox, description: "Threads with no owner yet" },
  { id: "quote_requests", label: "Quote requests", icon: DollarSign, description: "Threads where the customer is asking for pricing" },
  { id: "high_priority", label: "High priority", icon: AlertCircle, description: "Urgent waiting on us" },
  { id: "all", label: "All open", icon: Mail, description: "Everything except archived" },
  { id: "snoozed", label: "Snoozed", icon: Clock, description: "Threads you snoozed for later" },
  { id: "archived", label: "Archived", icon: Archive, description: "Resolved & archived threads" },
];

export function BucketSidebar({
  bucket,
  onChange,
  counts,
  secondaryCounts,
  savedViews = [],
  activeSavedViewId = null,
  onSelectSavedView,
  onRenameSavedView,
  onDeleteSavedView,
  onMoveSavedView,
}: BucketSidebarProps) {
  return (
    <nav className="flex flex-col gap-0.5 p-2 overflow-y-auto" data-testid="bucket-sidebar">
      {BUCKETS.map(b => {
        const Icon = b.icon;
        const active = bucket === b.id && !activeSavedViewId;
        const count = counts[b.id];
        const secondary = secondaryCounts?.[b.id];
        // Render a split "primary · secondary" badge when both numbers are
        // available and they actually differ. This is the Quote requests
        // case (Task #899): primary is the actionable "waiting on us"
        // count and secondary is the total in the bucket. Falls back to
        // the original single-number badge for every other bucket and
        // whenever the two numbers happen to be equal (no extra info to
        // surface).
        const showSplit =
          typeof count === "number" &&
          typeof secondary === "number" &&
          count !== secondary;
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => onChange(b.id)}
            className={cn(
              "group flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors text-left w-full",
              active
                ? "bg-primary/10 text-primary font-medium"
                : "hover:bg-muted text-foreground"
            )}
            title={b.description}
            data-testid={`bucket-${b.id}`}
            aria-pressed={active}
          >
            <Icon className={cn("w-4 h-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
            <span className="flex-1 truncate">{b.label}</span>
            {showSplit ? (
              <span
                className={cn(
                  "text-xs px-1.5 py-0.5 rounded-full font-medium tabular-nums",
                  active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}
                title={`${count} waiting on us · ${secondary} total`}
                data-testid={`count-${b.id}`}
              >
                <span data-testid={`count-${b.id}-primary`}>{count}</span>
                <span className="opacity-60 mx-1" aria-hidden>·</span>
                <span className="opacity-70" data-testid={`count-${b.id}-secondary`}>{secondary}</span>
              </span>
            ) : (
              typeof count === "number" && count > 0 && (
                <span className={cn(
                  "text-xs px-1.5 py-0.5 rounded-full font-medium tabular-nums",
                  active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )} data-testid={`count-${b.id}`}>
                  {count}
                </span>
              )
            )}
          </button>
        );
      })}

      {savedViews.length > 0 && (
        <>
          <div className="mt-3 mb-1 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            My views
          </div>
          {savedViews.map((v, idx) => (
            <SavedViewRow
              key={v.id}
              view={v}
              active={activeSavedViewId === v.id}
              canMoveUp={idx > 0}
              canMoveDown={idx < savedViews.length - 1}
              onSelect={() => onSelectSavedView?.(v)}
              onRename={(name) => onRenameSavedView?.(v.id, name)}
              onDelete={() => onDeleteSavedView?.(v.id)}
              onMove={(dir) => onMoveSavedView?.(v.id, dir)}
            />
          ))}
        </>
      )}
    </nav>
  );
}

function SavedViewRow({
  view,
  active,
  canMoveUp,
  canMoveDown,
  onSelect,
  onRename,
  onDelete,
  onMove,
}: {
  view: SavedView;
  active: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.name);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.trim();
          if (trimmed && trimmed !== view.name) onRename(trimmed);
          setEditing(false);
        }}
        className="flex items-center gap-1 px-2 py-1"
        data-testid={`saved-view-edit-${view.id}`}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          onBlur={() => setEditing(false)}
          className="h-7 text-xs"
          data-testid={`input-saved-view-rename-${view.id}`}
        />
      </form>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-1 px-2 py-1.5 rounded-md text-sm transition-colors",
        active
          ? "bg-primary/10 text-primary font-medium"
          : "hover:bg-muted text-foreground"
      )}
      data-testid={`saved-view-${view.id}`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        data-testid={`button-saved-view-${view.id}`}
      >
        <Bookmark className={cn("w-3.5 h-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
        <span className="truncate">{view.name}</span>
      </button>
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onMove("up")}
          disabled={!canMoveUp}
          title="Move up"
          data-testid={`button-saved-view-up-${view.id}`}
        >
          <ChevronUp className="w-3 h-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onMove("down")}
          disabled={!canMoveDown}
          title="Move down"
          data-testid={`button-saved-view-down-${view.id}`}
        >
          <ChevronDown className="w-3 h-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => { setDraft(view.name); setEditing(true); }}
          title="Rename"
          data-testid={`button-saved-view-rename-${view.id}`}
        >
          <Pencil className="w-3 h-3" />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive"
              title="Delete"
              data-testid={`button-saved-view-delete-${view.id}`}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{view.name}"?</AlertDialogTitle>
              <AlertDialogDescription>
                This saved view will be removed. You can re-create it any time from the bucket toolbar.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid={`button-saved-view-delete-cancel-${view.id}`}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid={`button-saved-view-delete-confirm-${view.id}`}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
