// Task #950 — Row-level entry point for the full thread.
//
// Surfaces (Available Freight, Lane Work Queue, Conversations, …) drop this
// component next to a row label. It renders the count badge as the visible
// trigger; clicking it opens a popover hosting the full panel
// (composer + threaded view) so reps can read, reply, resolve, and convert
// without navigating away. This satisfies the v1 contract that every
// supported anchor surfaces a "small, consistent entry point + threaded view"
// rather than a badge-only chip.

import { forwardRef, useState } from "react";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { ContextNoteBadge } from "./ContextNoteBadge";
import { ContextNotePanel } from "./ContextNotePanel";
import { useRevealOnDeepLink, useContextNotes } from "./useContextNotes";
import type { Anchor } from "./types";

interface Props {
  anchor: Anchor;
  /** Header label shown inside the popover (e.g. "Lane notes"). */
  title?: string;
  /** Popover content alignment. */
  align?: "start" | "center" | "end";
  className?: string;
}

export const ContextNotePopover = forwardRef<HTMLDivElement, Props>(function ContextNotePopover(
  { anchor, title = "Team notes", align = "start", className }, _ref,
) {
  const [open, setOpen] = useState(false);
  // If a deep-link reveal targets one of *this* anchor's notes, force-open
  // the popover so the highlighted note is visible without an extra click.
  const { revealId } = useRevealOnDeepLink();
  const { data: notes = [] } = useContextNotes(anchor);
  const shouldAutoOpen = !!revealId && notes.some(n => n.id === revealId);
  if (shouldAutoOpen && !open) setOpen(true);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ContextNoteBadge
          anchorType={anchor.type}
          anchorId={anchor.id}
          showZero
          className={className}
          onClick={(e) => {
            // Surface rows are often themselves buttons (LWQ accordion
            // headers, AF row containers). Stop propagation so clicking the
            // badge doesn't toggle the row.
            e.stopPropagation();
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-[440px] p-3"
        align={align}
        onClick={(e) => e.stopPropagation()}
        data-testid={`popover-context-notes-${anchor.type}-${anchor.id}`}
      >
        <ContextNotePanel anchor={anchor} flat title={title} defaultOpen />
      </PopoverContent>
    </Popover>
  );
});
