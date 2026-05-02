// Task #950 — Personal inbox view for context notes the viewer is mentioned
// in (or authored). Filterable by status (Open / Acknowledged / Resolved /
// All) and renders one click-through row per note that takes the rep
// straight to the source surface with the panel open and the note
// highlighted.

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { AtSign, Loader2, MessageCircle, Inbox, PenSquare, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ContextNoteStatus } from "@shared/schema";
import { useContextNotesInbox, type InboxRole } from "./useContextNotes";
import type { InboxRow } from "./types";

const ROLE_TABS: Array<{ key: InboxRole; label: string; icon: React.ReactNode }> = [
  { key: "all",       label: "All",          icon: <Users     className="h-3.5 w-3.5" /> },
  { key: "mentioned", label: "Mentioned me", icon: <AtSign    className="h-3.5 w-3.5" /> },
  { key: "authored",  label: "I authored",   icon: <PenSquare className="h-3.5 w-3.5" /> },
];

const STATUS_TABS: Array<{ key: "all" | ContextNoteStatus; label: string }> = [
  { key: "all",          label: "All" },
  { key: "open",         label: "Open" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "resolved",     label: "Resolved" },
];

const STATUS_COLOR: Record<ContextNoteStatus, string> = {
  open:         "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300",
  acknowledged: "border-blue-300  text-blue-700  dark:border-blue-700  dark:text-blue-300",
  resolved:     "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300",
};

const ANCHOR_LABEL: Record<string, string> = {
  quote_request:     "Quote",
  conversation:      "Conversation",
  available_freight: "Available Freight",
  lane_work_queue:   "Lane",
  customer:          "Customer",
  carrier:           "Carrier",
  load:              "Load",
};

function deepLinkFor(row: InboxRow): string {
  const id = encodeURIComponent(row.anchorId);
  const reveal = `contextNote=${encodeURIComponent(row.id)}`;
  switch (row.anchorType) {
    case "quote_request":     return `/quote-requests?quote=${id}&${reveal}`;
    case "conversation":      return `/conversations?thread=${id}&${reveal}`;
    case "available_freight": return `/available-freight?lane=${id}&${reveal}`;
    case "lane_work_queue":   return `/lanes/work-queue?laneId=${id}&${reveal}`;
    case "customer":          return `/companies/${id}?${reveal}`;
    case "carrier":           return `/carrier-hub?carrierId=${id}&${reveal}`;
    default:                  return `#`;
  }
}

export function ContextNotesInbox() {
  const [, navigate] = useLocation();
  const [role, setRole] = useState<InboxRole>("all");
  const [statusTab, setStatusTab] = useState<"all" | ContextNoteStatus>("all");

  // Server-side role filter so the row count is authoritative; status tab
  // filters client-side because we already have all rows the user can see.
  const { data: rows = [], isLoading } = useContextNotesInbox({ role });

  const filtered = useMemo(() => {
    if (statusTab === "all") return rows;
    return rows.filter(r => r.status === statusTab);
  }, [rows, statusTab]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length, open: 0, acknowledged: 0, resolved: 0 };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div className="space-y-3" data-testid="context-notes-inbox">
      {/* Who: notes the viewer is mentioned in vs notes they authored. */}
      <div className="flex flex-wrap gap-1.5">
        {ROLE_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setRole(t.key)}
            data-testid={`tab-context-notes-role-${t.key}`}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              role === t.key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* What state: open / acknowledged / resolved. */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setStatusTab(t.key)}
            data-testid={`tab-context-notes-status-${t.key}`}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              statusTab === t.key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
            }`}
          >
            {t.label} <span className="opacity-70">({statusCounts[t.key] ?? 0})</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading notes…
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Inbox className="h-8 w-8 opacity-30" />
            <p className="text-sm" data-testid="text-context-notes-inbox-empty">
              {statusTab === "all" && role === "all"
                ? "No team notes for you yet."
                : statusTab === "all"
                  ? `No notes in "${role}" yet.`
                  : `No ${statusTab} notes.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(row => {
            const isUnread = row.viewerIsMentioned && !row.mentionReadAt;
            return (
              <button
                key={row.id}
                onClick={() => navigate(deepLinkFor(row))}
                data-testid={`row-context-note-${row.id}`}
                className={`w-full text-left flex items-start gap-3 p-3 rounded-lg border transition-colors hover:bg-accent ${
                  isUnread ? "bg-amber-50/40 border-amber-200 dark:bg-amber-950/10 dark:border-amber-900/40" : "bg-background border-border"
                }`}
              >
                <div className="mt-0.5 shrink-0 text-amber-500">
                  {row.viewerIsMentioned ? <AtSign className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground" data-testid={`text-context-note-anchor-${row.id}`}>
                      {ANCHOR_LABEL[row.anchorType] ?? row.anchorType}
                    </span>
                    {row.anchorLabel && <span>· {row.anchorLabel}</span>}
                    <Badge variant="outline" className={`text-[10px] px-1.5 ${STATUS_COLOR[row.status as ContextNoteStatus] ?? ""}`}>
                      {row.status}
                    </Badge>
                    <span>·</span>
                    <span title={new Date(row.createdAt as unknown as string).toLocaleString()}>
                      {formatDistanceToNow(new Date(row.createdAt as unknown as string), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-sm mt-0.5 line-clamp-2" data-testid={`text-context-note-body-${row.id}`}>
                    {row.body}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    by {row.authorName ?? "Unknown"}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
