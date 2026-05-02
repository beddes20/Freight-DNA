// Task #950 — Public surface for context-note primitives.
// Surfaces should import from `@/components/context-notes`. The guardrail
// script verifies that no page imports from a deeper path.

export { ContextNoteBadge } from "./ContextNoteBadge";
export { ContextNoteComposer } from "./ContextNoteComposer";
export { ContextNoteThread } from "./ContextNoteThread";
export { ContextNotePanel } from "./ContextNotePanel";
export { ContextNotePopover } from "./ContextNotePopover";
export { ContextNotesInbox } from "./ContextNotesInbox";
export {
  useContextNotes,
  useContextNoteCounts,
  useContextNoteDetail,
  useContextNotesInbox,
  useCreateContextNote,
  useReplyToContextNote,
  useTransitionContextNote,
  useConvertContextNoteToTask,
  useMarkMentionsRead,
  useRevealOnDeepLink,
  useRevealContextNoteRow,
  useNavigateToContextNote,
} from "./useContextNotes";
export type {
  Anchor,
  AnchorCounts,
  ContextNoteWithExtras,
  ContextNoteDetail,
  InboxRow,
} from "./types";
