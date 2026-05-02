// Task #950 — Inline counter chip used by row-level surfaces.

import { forwardRef } from "react";
import { MessageCircle, AtSign } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ContextNoteAnchorType } from "@shared/schema";
import { useContextNoteCounts } from "./useContextNotes";

interface Props {
  anchorType: ContextNoteAnchorType;
  anchorId: string;
  /** When true, render even at zero count (used by full panels / popover triggers). */
  showZero?: boolean;
  /** Variant size. */
  size?: "sm" | "md";
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

// `forwardRef` is required so this component can serve as the trigger for a
// Radix Popover (`<PopoverTrigger asChild>`) without losing its anchor ref.
export const ContextNoteBadge = forwardRef<HTMLButtonElement, Props>(function ContextNoteBadge(
  { anchorType, anchorId, showZero, size = "sm", className, onClick, ...rest },
  ref,
) {
  const { data } = useContextNoteCounts(anchorType, [anchorId]);
  const counts = data?.[anchorId];
  const total = counts?.total ?? 0;
  const unread = counts?.unreadMentions ?? 0;
  // When `showZero` is set we always render — needed when this badge is the
  // visible trigger for an empty thread popover (you still want the click
  // affordance so reps can post the first note).
  if (total === 0 && !showZero) return null;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border bg-background text-xs",
        size === "sm" ? "px-2 py-0.5" : "px-2.5 py-1",
        unread > 0 ? "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300" :
                     "border-border text-muted-foreground",
        "hover:bg-muted cursor-pointer",
        className,
      )}
      data-testid={`badge-context-notes-${anchorType}-${anchorId}`}
      {...rest}
    >
      {unread > 0 ? <AtSign className="h-3 w-3" /> : <MessageCircle className="h-3 w-3" />}
      <span data-testid={`text-context-notes-count-${anchorId}`}>{total}</span>
      {unread > 0 && (
        <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px] border-amber-400 text-amber-700 dark:text-amber-300">
          {unread}
        </Badge>
      )}
    </button>
  );
});
