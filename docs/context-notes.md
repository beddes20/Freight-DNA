# Context Notes v1 (Task #950)

> **Status:** ADR-accepted, shipped May 2026.
> **Owners:** Workflow Platform team.

## TL;DR

A **Context Note** is a short, anchored, in-platform note that a rep can attach
to any first-class workflow object (a quote request, a conversation thread, a
lane, a load, a customer, a carrier, an item in Available Freight) so a
teammate can pick the work up where they left it, weigh in on a decision, or
take over a step — without leaving the surface.

Compared to ad-hoc Slack messages or rep-to-rep emails, every context note:

1. Lives **on** the object it talks about (anchor‐first design).
2. Has a structured **action type** (FYI, Question, Please review, Please
   handle, Decision needed) and a **status** (open / acknowledged / resolved).
3. Drives @-mention notifications through the existing notifications table so
   the bell badge and `/notifications` work without a parallel inbox.
4. Can be **converted into a real task** with one click when it crosses from
   "let's talk" to "owned, due, tracked".

## Schema

Four tables in `shared/schema.ts`:

| table                       | purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `context_notes`             | the anchored note itself                                |
| `context_note_mentions`     | per-user @mention targets, with read state              |
| `context_note_replies`      | threaded replies                                        |
| `context_note_events`       | audit log: created, acknowledged, resolved, converted   |

Indexes are picked for the read shapes we care about:

- `(anchor_type, anchor_id)` — list notes for a surface
- `(author_id, created_at)`  — "notes I wrote" inbox
- mentions `(user_id, created_at)` and unique `(note_id, user_id)`
- events `(note_id, created_at)`

## Anchor registry

Every anchor type is registered in `server/contextNotes/anchors.ts` with three
hooks:

- `canAccess(user, anchorId)` — permission delegation. Context notes do **not**
  introduce a parallel ACL — they reuse the anchor object's existing access
  check (e.g. `canAccessCompany`, `getVisibleRepUserIds`).
- `label(anchorId)` — human-readable label snapshot ("Quote Q-1234",
  "Lane DAL→ATL"); cached on each note so inbox rows survive renames.
- `deepLink(anchorId)` — URL the bell + inbox use to reveal the surface with
  the note open. Surfaces honor a `?contextNote=<id>` query param to scroll
  into and pop the panel automatically.

Registered anchors in v1:

| anchor type         | surface                                | deep link                                |
| ------------------- | -------------------------------------- | ---------------------------------------- |
| `quote_request`     | Quote Requests page                    | `/quote-requests?quote=:id`              |
| `conversation`      | Conversations                          | `/conversations?thread=:id`              |
| `available_freight` | Available Freight cockpit              | `/available-freight?lane=:id`            |
| `lane_work_queue`   | Lane Work Queue                        | `/lane-work-queue?lane=:id`              |
| `customer`          | Customer detail                        | `/companies/:id`                         |
| `carrier`           | Carrier detail                         | `/carriers/:id`                          |
| `load`              | Load detail (deferred to v1.1)         | n/a — recorded but not deep-linked yet   |

## REST surface

All routes live under `/api/context-notes` and are registered in
`server/routes/contextNotes.ts`:

```
GET    /api/context-notes/by-anchor/:anchorType/:anchorId
GET    /api/context-notes/inbox
GET    /api/context-notes/counts/by-anchor?anchorType=…&anchorIds=a,b,c
GET    /api/context-notes/:id

POST   /api/context-notes
POST   /api/context-notes/:id/replies
POST   /api/context-notes/:id/transition         body: { to: 'acknowledged' | 'resolved' | 'open' }
POST   /api/context-notes/:id/convert-to-task    body: { assignedTo, dueDate?, title? }
POST   /api/context-notes/:id/mentions/read      mark mentions as read for current user
```

Every read goes through the anchor registry so a rep cannot list notes on an
anchor they cannot otherwise see. Every write checks the same predicate **and**
re-validates that all mentioned user IDs are inside the same organization.

## Notifications

Notifications are written to the existing `notifications` table with two new
types:

- `context_note_mention` — sent to each mentioned user on note creation.
- `context_note_reply`   — sent to the author + everyone previously mentioned
  when a reply lands (de-duped against the actor).

The notification `link` field is the anchor deep link with `?contextNote=:id`
appended, so clicking the bell takes the rep straight to the panel with the
note open. The notification bell file (`client/src/components/notification-bell.tsx`)
maps both types into a "Mentions" filter chip so reps can triage.

## Client primitives

Shared, reusable components live under `client/src/components/context-notes/`:

- `useContextNotes(anchor)` — query + mutate hook backed by TanStack Query.
- `<ContextNoteComposer />`  — body, action type, mention picker.
- `<ContextNoteThread />`    — list of notes + replies for an anchor.
- `<ContextNoteBadge />`     — inline count chip ("3 notes · 1 unread").
- `<ContextNotePanel />`     — collapsible side/popover panel that wraps badge
                              + thread + composer; this is the canonical entry
                              point for surfaces.

A guardrail script (`scripts/check-context-notes-imports.ts`) prevents pages
from importing context-note primitives outside of `client/src/components/context-notes/`,
so we don't fork the UI per-surface.

## Convert-to-task

Inside the thread, a note in `please_handle` or `decision_needed` shows a
"Convert to task" affordance. It opens a small dialog (assignee, due date,
optional title override defaulting to the note body's first line) and:

1. Creates a `tasks` row with `companyId`/`opportunityId`/`laneContext`
   inferred from the anchor (e.g. lane anchors → laneContext, quote anchors →
   opportunityId).
2. Stamps `convertedTaskId` on the note and writes a `converted_to_task`
   event.
3. Auto-resolves the note (`status='resolved'`).

The thread renders a "Converted to task → Txxx" link from then on.

## Deep-link reveal contract

Surfaces opt-in by reading `?contextNote=<id>` from the URL on mount. The
`<ContextNotePanel />` exported helper `useRevealOnDeepLink(anchor)` handles:

- popping the panel open
- scrolling the note into view
- calling `POST /api/context-notes/:id/mentions/read` on mount

Surfaces wired in v1:

- Quote Requests (`client/src/pages/quote-requests.tsx`)
- Conversations (`client/src/pages/conversations.tsx`)
- Available Freight (`client/src/pages/available-freight.tsx`)
- Lane Work Queue (`client/src/pages/lane-work-queue.tsx`)
- Customer detail (`client/src/pages/company-detail.tsx`)
- Carrier detail (`client/src/pages/carrier-detail.tsx`)

## What's deferred to v1.1

- **Load anchor reveal.** We accept and persist `anchor_type='load'` notes (so
  the API surface is complete and back-fillable later) but no surface deep-
  links to them yet, because there is no canonical load detail route.
- **Email-out fan-out.** All v1 fan-out is in-app; no SMTP push. Reps already
  drown in email; making notes promote-by-default to email would erase the
  whole reason this exists.
- **Per-org templates** for the action types.
- **@team / @role mentions.** Only direct user mentions in v1.

## Usage recipe — adding context-notes to a new surface

1. **Pick or register an anchor type.** If your surface targets one of the
   existing anchor types (`quote_request`, `conversation`, `available_freight`,
   `lane_work_queue`, `customer`, `carrier`, `load`), reuse it. Otherwise add
   a new entry to `server/contextNotes/anchors.ts` with `canAccess`, `label`,
   and `deepLink` implementations.

2. **Render the panel** at the spot in the surface where collaboration belongs
   (usually next to the activity timeline, header, or right pane):

   ```tsx
   import { ContextNotePanel } from "@/components/context-notes";

   <ContextNotePanel
     anchor={{ type: "quote_request", id: opp.id }}
     title="Team notes"
   />
   ```

3. **Optional row badge** — for list rows, drop a `<ContextNoteBadge />`
   instead so reps can see a count without opening the row:

   ```tsx
   import { ContextNoteBadge } from "@/components/context-notes";

   <ContextNoteBadge anchorType="lane_work_queue" anchorId={lane.id} />
   ```

4. **Deep-link reveal is automatic.** `<ContextNotePanel />` calls
   `useRevealOnDeepLink(anchor)` internally; clicking a notification with
   `?contextNote=<id>` will pop the panel, scroll the note into view, and
   mark mentions as read.

5. **Always import from the barrel.** `scripts/check-context-notes-imports.ts`
   blocks deep imports like `@/components/context-notes/ContextNoteThread`
   from outside the module — only `@/components/context-notes` is public.

## Tests + guardrail

- `tests/context-notes.test.ts` — server-layer integration tests covering
  permission delegation (cross-org isolation), notification fan-out
  (mention + reply with dedupe), status transitions (open ↔ acknowledged ↔
  resolved), and convert-to-task. Run with
  `npx tsx tests/context-notes.test.ts`.
- `scripts/check-context-notes-imports.ts` — fails if any client file outside
  `client/src/components/context-notes/` imports a deeper path than the
  barrel. Run with `npx tsx scripts/check-context-notes-imports.ts`.

## Why not just use Tasks?

Tasks are owned, due, and personal. Context notes are **conversational and
anchored**. A task answers "what am I doing today?" — a note answers "why did
this number drop?" or "Nick, can you take this over?". The convert-to-task
flow is the bridge: when the conversation produces ownership, you promote it.
