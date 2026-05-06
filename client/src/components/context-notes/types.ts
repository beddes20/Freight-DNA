// Task #950 — Context Notes shared client types.

import type {
  ContextNote,
  ContextNoteAnchorType,
  ContextNoteEvent,
  ContextNoteReply,
} from "@shared/schema";

export type Anchor = {
  type: ContextNoteAnchorType;
  id: string;
};

export type ContextNoteWithExtras = ContextNote & {
  authorName: string | null;
  mentions: Array<{ userId: string; name: string | null; readAt: string | null }>;
  replyCount: number;
};

export type ContextNoteDetail = {
  note: ContextNote;
  replies: Array<ContextNoteReply & { authorName: string | null }>;
  events: Array<ContextNoteEvent & { actorName: string | null }>;
  mentionUserIds: string[];
};

export type AnchorCounts = {
  total: number;
  openCount: number;
  unreadMentions: number;
};

export type InboxRow = ContextNote & {
  authorName: string | null;
  mentionReadAt: string | null;
  viewerIsMentioned: boolean;
};
