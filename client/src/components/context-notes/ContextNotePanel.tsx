// Task #950 — Canonical entry point: a collapsible panel that bundles the
// badge + thread + composer for a single anchor. This is what surfaces should
// import (instead of forking their own UI).

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ContextNoteBadge } from "./ContextNoteBadge";
import { ContextNoteComposer } from "./ContextNoteComposer";
import { ContextNoteThread } from "./ContextNoteThread";
import { useContextNotes, useRevealOnDeepLink } from "./useContextNotes";
import type { Anchor } from "./types";

interface Props {
  anchor: Anchor;
  /** Override label rendered in the toggle header. */
  title?: string;
  /** Render flat (no border, no toggle) — useful inside slide-overs. */
  flat?: boolean;
  /** Force-open by default. */
  defaultOpen?: boolean;
  className?: string;
}

export function ContextNotePanel({ anchor, title = "Team notes", flat, defaultOpen, className }: Props) {
  const { revealId } = useRevealOnDeepLink();
  const { data: notes = [] } = useContextNotes(anchor);
  const isRevealHere = revealId && notes.some(n => n.id === revealId);
  const [open, setOpen] = useState<boolean>(defaultOpen || flat || !!isRevealHere);

  useEffect(() => {
    if (isRevealHere) setOpen(true);
  }, [isRevealHere]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isRevealHere || !revealId) return;
    const el = document.getElementById(`context-note-${revealId}`);
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    }
  }, [isRevealHere, revealId, notes.length]);

  if (flat) {
    return (
      <div ref={containerRef} className={cn("space-y-3", className)} data-testid={`panel-context-notes-${anchor.type}-${anchor.id}`}>
        <ContextNoteComposer anchor={anchor} />
        <ContextNoteThread anchor={anchor} highlightNoteId={revealId} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn("border rounded-lg bg-card", className)} data-testid={`panel-context-notes-${anchor.type}-${anchor.id}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/40"
        data-testid={`button-context-notes-toggle-${anchor.type}-${anchor.id}`}
      >
        <span className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          {title}
          <ContextNoteBadge anchorType={anchor.type} anchorId={anchor.id} />
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t">
          <ContextNoteComposer anchor={anchor} compact />
          <ContextNoteThread anchor={anchor} highlightNoteId={revealId} />
        </div>
      )}
    </div>
  );
}
