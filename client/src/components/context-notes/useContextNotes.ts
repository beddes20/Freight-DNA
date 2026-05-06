// Task #950 — Context Notes shared TanStack hooks.
//
// Surfaces import these instead of issuing fetches themselves so cache keys
// stay aligned and the guardrail script can detect rogue UI forks.

import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { apiRequest, queryClient, STALE_1MIN } from "@/lib/queryClient";
import type { ContextNoteAnchorType, ContextNoteStatus } from "@shared/schema";
import type {
  Anchor,
  AnchorCounts,
  ContextNoteDetail,
  ContextNoteWithExtras,
  InboxRow,
} from "./types";

export type InboxRole = "all" | "mentioned" | "authored";

const KEY_BY_ANCHOR = (a: Anchor) => ["/api/context-notes/by-anchor", a.type, a.id];
const KEY_DETAIL    = (id: string) => ["/api/context-notes", id];
const KEY_INBOX     = (onlyUnread: boolean, role: InboxRole, status: string) =>
  ["/api/context-notes/inbox", onlyUnread ? "unread" : "all", role, status];
const KEY_COUNTS    = (anchorType: ContextNoteAnchorType, anchorIds: string[]) =>
  ["/api/context-notes/counts/by-anchor", anchorType, anchorIds.slice().sort().join(",")];

// ── List by anchor ─────────────────────────────────────────────────────────

export function useContextNotes(anchor: Anchor | null) {
  return useQuery<ContextNoteWithExtras[]>({
    queryKey: anchor ? KEY_BY_ANCHOR(anchor) : ["/api/context-notes/by-anchor", "_disabled"],
    enabled: !!anchor,
    staleTime: STALE_1MIN,
  });
}

// ── Counts (badge mode) ────────────────────────────────────────────────────

export function useContextNoteCounts(
  anchorType: ContextNoteAnchorType | null,
  anchorIds: string[],
) {
  const enabled = !!anchorType && anchorIds.length > 0;
  return useQuery<Record<string, AnchorCounts>>({
    queryKey: enabled ? KEY_COUNTS(anchorType!, anchorIds) : ["/api/context-notes/counts/by-anchor", "_disabled"],
    enabled,
    queryFn: async () => {
      const url = `/api/context-notes/counts/by-anchor?anchorType=${encodeURIComponent(anchorType!)}&anchorIds=${encodeURIComponent(anchorIds.join(","))}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch counts");
      return res.json();
    },
    staleTime: STALE_1MIN,
  });
}

// ── Inbox ──────────────────────────────────────────────────────────────────

export function useContextNotesInbox(
  opts: { onlyUnread?: boolean; role?: InboxRole; status?: ContextNoteStatus | "all" } = {},
) {
  const onlyUnread = !!opts.onlyUnread;
  const role: InboxRole = opts.role ?? "all";
  const status = opts.status ?? "all";
  return useQuery<InboxRow[]>({
    queryKey: KEY_INBOX(onlyUnread, role, status),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (onlyUnread) params.set("onlyUnread", "1");
      if (role !== "all") params.set("role", role);
      if (status !== "all") params.set("status", status);
      const qs = params.toString();
      const res = await fetch(`/api/context-notes/inbox${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch inbox");
      return res.json();
    },
    staleTime: STALE_1MIN,
  });
}

// ── Note detail ────────────────────────────────────────────────────────────

export function useContextNoteDetail(id: string | null) {
  return useQuery<ContextNoteDetail>({
    queryKey: id ? KEY_DETAIL(id) : ["/api/context-notes", "_disabled"],
    enabled: !!id,
    staleTime: STALE_1MIN,
  });
}

// ── Mutations ──────────────────────────────────────────────────────────────

function invalidateForAnchor(anchor: Anchor) {
  queryClient.invalidateQueries({ queryKey: KEY_BY_ANCHOR(anchor) });
  queryClient.invalidateQueries({ queryKey: ["/api/context-notes/inbox"] });
  queryClient.invalidateQueries({ queryKey: ["/api/context-notes/counts/by-anchor", anchor.type] });
  queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
}

export type CreateNoteInput = {
  anchor: Anchor;
  body: string;
  actionType: "fyi" | "question" | "please_review" | "please_handle" | "decision_needed";
  status?: ContextNoteStatus;
  mentions?: string[];
};

export function useCreateContextNote() {
  return useMutation({
    mutationFn: async (input: CreateNoteInput) => {
      const res = await apiRequest("POST", "/api/context-notes", {
        anchorType: input.anchor.type,
        anchorId: input.anchor.id,
        body: input.body,
        actionType: input.actionType,
        status: input.status ?? "open",
        mentions: input.mentions ?? [],
      });
      return res.json();
    },
    onSuccess: (_d, input) => invalidateForAnchor(input.anchor),
  });
}

export function useReplyToContextNote(noteId: string, anchor: Anchor) {
  return useMutation({
    mutationFn: async (body: string) => {
      const res = await apiRequest("POST", `/api/context-notes/${noteId}/replies`, { body });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY_DETAIL(noteId) });
      invalidateForAnchor(anchor);
    },
  });
}

export function useTransitionContextNote(noteId: string, anchor: Anchor) {
  return useMutation({
    mutationFn: async (to: ContextNoteStatus) => {
      const res = await apiRequest("POST", `/api/context-notes/${noteId}/transition`, { to });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY_DETAIL(noteId) });
      invalidateForAnchor(anchor);
    },
  });
}

export type ConvertToTaskInput = {
  assignedTo: string;
  title?: string;
  dueDate?: string | null;
};

export function useConvertContextNoteToTask(noteId: string, anchor: Anchor) {
  return useMutation({
    mutationFn: async (input: ConvertToTaskInput) => {
      const res = await apiRequest("POST", `/api/context-notes/${noteId}/convert-to-task`, input);
      return res.json() as Promise<{ ok: boolean; taskId: string }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY_DETAIL(noteId) });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      invalidateForAnchor(anchor);
    },
  });
}

export function useMarkMentionsRead(noteId: string | null) {
  return useMutation({
    mutationFn: async () => {
      if (!noteId) return null;
      const res = await apiRequest("POST", `/api/context-notes/${noteId}/mentions/read`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/context-notes/inbox"] });
      queryClient.invalidateQueries({ queryKey: ["/api/context-notes/counts/by-anchor"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
  });
}

// ── Deep-link reveal helper ────────────────────────────────────────────────
//
// Surfaces opt-in by calling `useRevealOnDeepLink(anchor)` near the top of
// their page component. When the URL contains `?contextNote=<id>` we:
//   1. emit the id so the page can pop the panel/scroll to the note
//   2. flush the unread mention so the bell badge clears
//   3. strip `contextNote=` from the URL on next user navigation

export function useRevealOnDeepLink(): { revealId: string | null } {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const revealId = params.get("contextNote");
  const markRead = useMarkMentionsRead(revealId);
  useEffect(() => {
    if (revealId) markRead.mutate();
    // markRead is a stable react-query mutation handle; do not include it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealId]);
  return { revealId };
}

export function useNavigateToContextNote() {
  const [, navigate] = useLocation();
  return (deepLink: string) => navigate(deepLink);
}

// ── Per-surface row reveal ─────────────────────────────────────────────────
//
// Surfaces that render a list/grid of anchors (Available Freight rows, Lane
// Work Queue lanes) opt-in by calling `useRevealContextNoteRow` once near
// the top of their page. When the URL contains `?contextNote=<id>` we:
//
//   1. fetch the note's anchor (via `/api/context-notes/<id>`)
//   2. confirm it's the surface this hook was scoped to
//   3. call `getRowEl(anchorId)` and, if present, scroll it into view and
//      flash an amber ring around it for ~2.5s so the user can see exactly
//      which row owns the linked thread
//   4. if the row is not currently rendered (filtered out, paginated away,
//      etc.) we surface a fallback toast pointing the user back to the
//      Notifications inbox so the deep-link is never silently dropped.
//
// This is the per-surface complement to `useRevealOnDeepLink`, which only
// handles the panel/popover scroll-and-highlight inside a single anchor.

export function useRevealContextNoteRow(opts: {
  surface: ContextNoteAnchorType;
  getRowEl: (anchorId: string) => HTMLElement | null;
  fallbackToast?: (note: { id: string; anchorId: string }) => void;
}) {
  const { revealId } = useRevealOnDeepLink();
  useEffect(() => {
    if (!revealId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/context-notes/${encodeURIComponent(revealId)}`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const detail = (await res.json()) as { id: string; anchorType: string; anchorId: string };
        if (cancelled) return;
        if (detail.anchorType !== opts.surface) return;
        // Defer one frame so the row has time to render after deep-link nav.
        requestAnimationFrame(() => {
          const el = opts.getRowEl(detail.anchorId);
          if (!el) {
            opts.fallbackToast?.({ id: detail.id, anchorId: detail.anchorId });
            return;
          }
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add(
            "ring-2", "ring-amber-400", "ring-offset-1",
            "transition-shadow", "duration-500",
          );
          window.setTimeout(() => {
            el.classList.remove(
              "ring-2", "ring-amber-400", "ring-offset-1",
              "transition-shadow", "duration-500",
            );
          }, 2500);
        });
      } catch {
        // Network/permission errors are already user-visible elsewhere.
      }
    })();
    return () => { cancelled = true; };
    // `opts.getRowEl` and `opts.fallbackToast` are inline closures from the
    // caller; we intentionally only re-run when the deep-link id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealId, opts.surface]);
}
