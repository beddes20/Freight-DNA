// Task #950 — Context Notes data layer.
//
// We keep the SQL out of the IStorage god-object (server/storage.ts is already
// >11k lines) and isolate it here. Routes call these helpers; helpers call
// drizzle directly using the shared `db` instance.

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  contextNotes,
  contextNoteEvents,
  contextNoteMentions,
  contextNoteReplies,
  notifications,
  tasks,
  users,
  type ContextNote,
  type ContextNoteEvent,
  type ContextNoteEventType,
  type ContextNoteMention,
  type ContextNoteReply,
  type ContextNoteStatus,
  type InsertContextNote,
  type InsertContextNoteEvent,
  type InsertTask,
} from "@shared/schema";

// ── Reads ────────────────────────────────────────────────────────────────

export type ContextNoteWithExtras = ContextNote & {
  authorName: string | null;
  mentions: Array<{ userId: string; name: string | null; readAt: Date | null }>;
  replyCount: number;
};

export async function listNotesByAnchor(
  orgId: string,
  anchorType: string,
  anchorId: string,
): Promise<ContextNoteWithExtras[]> {
  const rows = await db
    .select({
      note: contextNotes,
      authorName: users.name,
    })
    .from(contextNotes)
    .leftJoin(users, eq(users.id, contextNotes.authorId))
    .where(and(
      eq(contextNotes.orgId, orgId),
      eq(contextNotes.anchorType, anchorType),
      eq(contextNotes.anchorId, anchorId),
    ))
    .orderBy(desc(contextNotes.createdAt));

  if (rows.length === 0) return [];
  const noteIds = rows.map(r => r.note.id);
  const [mentionRows, replyCounts] = await Promise.all([
    db.select({
        noteId: contextNoteMentions.noteId,
        userId: contextNoteMentions.userId,
        readAt: contextNoteMentions.readAt,
        name: users.name,
      })
      .from(contextNoteMentions)
      .leftJoin(users, eq(users.id, contextNoteMentions.userId))
      .where(inArray(contextNoteMentions.noteId, noteIds)),
    db.select({
        noteId: contextNoteReplies.noteId,
        c: sql<number>`count(*)::int`,
      })
      .from(contextNoteReplies)
      .where(inArray(contextNoteReplies.noteId, noteIds))
      .groupBy(contextNoteReplies.noteId),
  ]);
  const mentionsByNote = new Map<string, ContextNoteWithExtras["mentions"]>();
  for (const m of mentionRows) {
    const arr = mentionsByNote.get(m.noteId) ?? [];
    arr.push({ userId: m.userId, name: m.name, readAt: m.readAt });
    mentionsByNote.set(m.noteId, arr);
  }
  const replyCountByNote = new Map(replyCounts.map(r => [r.noteId, Number(r.c) || 0]));

  return rows.map(r => ({
    ...r.note,
    authorName: r.authorName,
    mentions: mentionsByNote.get(r.note.id) ?? [],
    replyCount: replyCountByNote.get(r.note.id) ?? 0,
  }));
}

export async function getNoteById(
  noteId: string,
): Promise<ContextNote | null> {
  const [row] = await db
    .select()
    .from(contextNotes)
    .where(eq(contextNotes.id, noteId))
    .limit(1);
  return row ?? null;
}

export async function getReplies(noteId: string): Promise<Array<ContextNoteReply & { authorName: string | null }>> {
  const rows = await db
    .select({
      reply: contextNoteReplies,
      authorName: users.name,
    })
    .from(contextNoteReplies)
    .leftJoin(users, eq(users.id, contextNoteReplies.authorId))
    .where(eq(contextNoteReplies.noteId, noteId))
    .orderBy(asc(contextNoteReplies.createdAt));
  return rows.map(r => ({ ...r.reply, authorName: r.authorName }));
}

export async function getEvents(noteId: string): Promise<Array<ContextNoteEvent & { actorName: string | null }>> {
  const rows = await db
    .select({
      event: contextNoteEvents,
      actorName: users.name,
    })
    .from(contextNoteEvents)
    .leftJoin(users, eq(users.id, contextNoteEvents.actorId))
    .where(eq(contextNoteEvents.noteId, noteId))
    .orderBy(asc(contextNoteEvents.createdAt));
  return rows.map(r => ({ ...r.event, actorName: r.actorName }));
}

/**
 * Per-anchor counts: { [anchorId]: { total, unreadForUser, openCount } }.
 * Used by surfaces to render the badge without loading the full thread.
 */
export async function countsByAnchor(
  orgId: string,
  anchorType: string,
  anchorIds: string[],
  userId: string,
): Promise<Record<string, { total: number; openCount: number; unreadMentions: number }>> {
  if (anchorIds.length === 0) return {};
  const noteRows = await db
    .select({
      id: contextNotes.id,
      anchorId: contextNotes.anchorId,
      status: contextNotes.status,
    })
    .from(contextNotes)
    .where(and(
      eq(contextNotes.orgId, orgId),
      eq(contextNotes.anchorType, anchorType),
      inArray(contextNotes.anchorId, anchorIds),
    ));
  if (noteRows.length === 0) {
    return Object.fromEntries(anchorIds.map(a => [a, { total: 0, openCount: 0, unreadMentions: 0 }]));
  }
  const noteIds = noteRows.map(n => n.id);
  const mentionRows = await db
    .select({
      noteId: contextNoteMentions.noteId,
      readAt: contextNoteMentions.readAt,
    })
    .from(contextNoteMentions)
    .where(and(
      inArray(contextNoteMentions.noteId, noteIds),
      eq(contextNoteMentions.userId, userId),
    ));
  const noteToAnchor = new Map(noteRows.map(n => [n.id, n.anchorId]));
  const out: Record<string, { total: number; openCount: number; unreadMentions: number }> =
    Object.fromEntries(anchorIds.map(a => [a, { total: 0, openCount: 0, unreadMentions: 0 }]));
  for (const n of noteRows) {
    const bucket = out[n.anchorId];
    bucket.total += 1;
    if (n.status === "open" || n.status === "acknowledged") bucket.openCount += 1;
  }
  for (const m of mentionRows) {
    if (m.readAt) continue;
    const anchorId = noteToAnchor.get(m.noteId);
    if (!anchorId) continue;
    out[anchorId].unreadMentions += 1;
  }
  return out;
}

/**
 * Personal inbox — every note where the viewer was mentioned, plus every note
 * they authored that is still open. Sorted newest-first.
 */
export async function getInboxForUser(
  userId: string,
  orgId: string,
  opts: { onlyUnread?: boolean; limit?: number } = {},
): Promise<Array<ContextNote & { authorName: string | null; mentionReadAt: Date | null; viewerIsMentioned: boolean }>> {
  const limit = Math.min(opts.limit ?? 100, 200);

  const mentionedRows = await db
    .select({
      note: contextNotes,
      authorName: users.name,
      mentionReadAt: contextNoteMentions.readAt,
    })
    .from(contextNoteMentions)
    .innerJoin(contextNotes, eq(contextNotes.id, contextNoteMentions.noteId))
    .leftJoin(users, eq(users.id, contextNotes.authorId))
    .where(and(
      eq(contextNoteMentions.userId, userId),
      eq(contextNotes.orgId, orgId),
      opts.onlyUnread ? isNull(contextNoteMentions.readAt) : sql`true`,
    ))
    .orderBy(desc(contextNotes.createdAt))
    .limit(limit);

  const mentionedIds = new Set(mentionedRows.map(r => r.note.id));

  const authoredRows = opts.onlyUnread
    ? []
    : await db
        .select({
          note: contextNotes,
          authorName: users.name,
        })
        .from(contextNotes)
        .leftJoin(users, eq(users.id, contextNotes.authorId))
        .where(and(
          eq(contextNotes.orgId, orgId),
          eq(contextNotes.authorId, userId),
          inArray(contextNotes.status, ["open", "acknowledged"]),
        ))
        .orderBy(desc(contextNotes.createdAt))
        .limit(limit);

  const merged: Array<ContextNote & { authorName: string | null; mentionReadAt: Date | null; viewerIsMentioned: boolean }> = [];
  for (const r of mentionedRows) {
    merged.push({ ...r.note, authorName: r.authorName, mentionReadAt: r.mentionReadAt, viewerIsMentioned: true });
  }
  for (const r of authoredRows) {
    if (mentionedIds.has(r.note.id)) continue;
    merged.push({ ...r.note, authorName: r.authorName, mentionReadAt: null, viewerIsMentioned: false });
  }
  merged.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return merged.slice(0, limit);
}

// ── Writes ───────────────────────────────────────────────────────────────

export async function insertNote(data: InsertContextNote): Promise<ContextNote> {
  const [row] = await db.insert(contextNotes).values(data).returning();
  return row;
}

export async function insertMentions(noteId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const unique = Array.from(new Set(userIds));
  await db.insert(contextNoteMentions)
    .values(unique.map(uid => ({ noteId, userId: uid })))
    .onConflictDoNothing();
}

export async function insertEvent(data: InsertContextNoteEvent): Promise<ContextNoteEvent> {
  const [row] = await db.insert(contextNoteEvents).values(data).returning();
  return row;
}

export async function insertReply(noteId: string, authorId: string, body: string): Promise<ContextNoteReply> {
  const [row] = await db.insert(contextNoteReplies)
    .values({ noteId, authorId, body })
    .returning();
  // bump updatedAt on the parent note so inbox sorting stays useful
  await db.update(contextNotes)
    .set({ updatedAt: new Date() })
    .where(eq(contextNotes.id, noteId));
  return row;
}

export async function transitionNote(
  noteId: string,
  to: ContextNoteStatus,
  actorId: string,
): Promise<ContextNote | null> {
  type NoteUpdate = Partial<typeof contextNotes.$inferInsert>;
  const patch: NoteUpdate = { status: to, updatedAt: new Date() };
  if (to === "resolved") {
    patch.resolvedAt = new Date();
    patch.resolvedBy = actorId;
  } else if (to === "open") {
    patch.resolvedAt = null;
    patch.resolvedBy = null;
  }
  const [row] = await db.update(contextNotes)
    .set(patch)
    .where(eq(contextNotes.id, noteId))
    .returning();
  return row ?? null;
}

export async function attachConvertedTask(noteId: string, taskId: string): Promise<void> {
  await db.update(contextNotes)
    .set({ convertedTaskId: taskId, status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(contextNotes.id, noteId));
}

export async function markMentionsRead(noteId: string, userId: string): Promise<void> {
  await db.update(contextNoteMentions)
    .set({ readAt: new Date() })
    .where(and(
      eq(contextNoteMentions.noteId, noteId),
      eq(contextNoteMentions.userId, userId),
      isNull(contextNoteMentions.readAt),
    ));
}

export async function markAllMentionsRead(userId: string): Promise<void> {
  await db.update(contextNoteMentions)
    .set({ readAt: new Date() })
    .where(and(
      eq(contextNoteMentions.userId, userId),
      isNull(contextNoteMentions.readAt),
    ));
}

// ── Notification fan-out ─────────────────────────────────────────────────

export type FanoutInput = {
  recipientIds: string[];
  type: "context_note_mention" | "context_note_reply";
  title: string;
  body: string;
  link: string | null;
  relatedId: string;
};

export async function fanoutNotifications(input: FanoutInput): Promise<void> {
  const targets = Array.from(new Set(input.recipientIds.filter(Boolean)));
  if (targets.length === 0) return;
  await db.insert(notifications).values(targets.map(userId => ({
    userId,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
    relatedId: input.relatedId,
  })));
}

// ── Existing-user check (cheap mention validation) ───────────────────────

export async function findUsersInOrg(userIds: string[], orgId: string): Promise<Array<{ id: string; name: string }>> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, orgId), inArray(users.id, userIds)));
  return rows;
}

export async function getMentionUserIds(noteId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: contextNoteMentions.userId })
    .from(contextNoteMentions)
    .where(eq(contextNoteMentions.noteId, noteId));
  return rows.map(r => r.userId);
}

// ── Convert-to-task helper ───────────────────────────────────────────────

export type ConvertToTaskInput = {
  note: ContextNote;
  actorId: string;
  assignedTo: string;
  title?: string;
  dueDate?: string | null;
  companyId?: string | null;
  opportunityId?: number | null;
  laneContext?: Record<string, unknown> | null;
  /**
   * Deep-link back to the source surface with the originating note pre-revealed.
   * Required so the assignee can jump from "Tasks" straight to the conversation
   * / lane / quote / customer that prompted the work — preserving the
   * task ↔ anchor backlink contract.
   */
  anchorDeepLink: string;
};

export async function createTaskFromNote(input: ConvertToTaskInput): Promise<{ id: string }> {
  const fallbackTitle = input.note.body.split("\n")[0].slice(0, 140);
  const anchorLabel = input.note.anchorLabel ?? `${input.note.anchorType}/${input.note.anchorId}`;
  // Description embeds the human-readable anchor label AND a deep link the
  // assignee can click straight from the task list to land on the source
  // surface with the note pre-revealed.
  const description = [
    `Created from context note · ${anchorLabel}`,
    `Open source: ${input.anchorDeepLink}`,
  ].join("\n");
  const values: InsertTask = {
    title: (input.title ?? fallbackTitle).trim() || "Context note follow-up",
    notes: input.note.body,
    description,
    status: "open",
    dueDate: input.dueDate ?? null,
    assignedTo: input.assignedTo,
    assignedBy: input.actorId,
    companyId: input.companyId ?? null,
    opportunityId: input.opportunityId ?? null,
    laneContext: input.laneContext ?? null,
    createdAt: new Date().toISOString(),
  };
  const [row] = await db.insert(tasks).values(values).returning({ id: tasks.id });
  return { id: row.id };
}
