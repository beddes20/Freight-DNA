// Task #950 — Context Notes REST surface.
//
// Mounted at /api/context-notes. All read endpoints delegate permission to the
// anchor registry; write endpoints additionally validate every mentioned user
// is in the actor's org. There is no separate ACL by design.

import type { Express } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import { pStr, qStr, qBool } from "../lib/req";
import {
  insertContextNoteSchema,
  insertContextNoteReplySchema,
  contextNoteStatuses,
  type ContextNoteStatus,
  contextNoteAnchorTypes,
} from "@shared/schema";
import {
  attachConvertedTask,
  countsByAnchor,
  createTaskFromNote,
  fanoutNotifications,
  findUsersInOrg,
  getEvents,
  getInboxForUser,
  getMentionUserIds,
  getNoteById,
  getReplies,
  insertEvent,
  insertMentions,
  insertNote,
  insertReply,
  listNotesByAnchor,
  markAllMentionsRead,
  markMentionsRead,
  transitionNote,
} from "../contextNotes/repo";
import {
  anchorDeepLinkWithReveal,
  buildTaskContextForAnchor,
  canUserAccessAnchor,
  snapshotAnchorLabel,
  snapshotAnchorRoutePayload,
} from "../contextNotes/anchors";
import { storage } from "../storage";
import type { User } from "@shared/schema";

const ANCHOR_PARAM = z.enum(contextNoteAnchorTypes);

const createBodySchema = insertContextNoteSchema
  .omit({ orgId: true, authorId: true, anchorLabel: true })
  .extend({
    mentions: z.array(z.string()).max(50).optional().default([]),
  });

const replyBodySchema = insertContextNoteReplySchema.pick({ body: true });

const transitionBodySchema = z.object({
  to: z.enum(contextNoteStatuses),
});

const convertBodySchema = z.object({
  assignedTo: z.string().min(1),
  title: z.string().max(200).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

export function registerContextNotesRoutes(app: Express): void {
  // ── List by anchor ────────────────────────────────────────────────────
  app.get("/api/context-notes/by-anchor/:anchorType/:anchorId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const anchorType = ANCHOR_PARAM.parse(pStr(req.params.anchorType));
      const anchorId = pStr(req.params.anchorId);
      if (!(await canUserAccessAnchor(user, anchorType, anchorId))) {
        return res.status(403).json({ error: "Not allowed for this anchor" });
      }
      const notes = await listNotesByAnchor(user.organizationId, anchorType, anchorId);
      res.json(notes);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid anchor", details: err.issues });
      console.error("[context-notes] by-anchor:", err);
      res.status(500).json({ error: "Failed to fetch notes" });
    }
  });

  // ── Counts by anchor (for badges) ─────────────────────────────────────
  app.get("/api/context-notes/counts/by-anchor", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const anchorType = ANCHOR_PARAM.parse(qStr(req.query.anchorType));
      const idsParam = qStr(req.query.anchorIds).trim();
      if (!idsParam) return res.json({});
      const requested = idsParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 200);
      // Per-anchor permission filter — never return counts for an anchor the
      // viewer cannot see (would leak that a note exists at all).
      const allowed = await filterAccessibleAnchors(user, anchorType, requested);
      if (allowed.length === 0) return res.json({});
      const counts = await countsByAnchor(user.organizationId, anchorType, allowed, user.id);
      res.json(counts);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid anchor", details: err.issues });
      console.error("[context-notes] counts:", err);
      res.status(500).json({ error: "Failed to fetch counts" });
    }
  });

  // ── Inbox ─────────────────────────────────────────────────────────────
  app.get("/api/context-notes/inbox", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const onlyUnread = qBool(req.query.onlyUnread);
      const statusParam = qStr(req.query.status).trim();
      const allowedStatuses = new Set(
        statusParam
          ? statusParam.split(",").map(s => s.trim()).filter(s => (contextNoteStatuses as readonly string[]).includes(s))
          : [],
      );
      // role= mentioned | authored | all (default). Lets the inbox UI render
      // separate "Mentioned to me" vs "I authored" tabs without two endpoints.
      const roleParam = qStr(req.query.role).trim().toLowerCase();
      const role: "mentioned" | "authored" | "all" =
        roleParam === "mentioned" || roleParam === "authored" ? roleParam : "all";

      const rows = await getInboxForUser(user.id, user.organizationId, { onlyUnread });
      // Re-check anchor visibility per row — defends against a note becoming
      // invisible (lane reassigned, conversation handed off, …) after a
      // mention was created.
      const visible: typeof rows = [];
      for (const row of rows) {
        if (allowedStatuses.size > 0 && !allowedStatuses.has(row.status)) continue;
        if (role === "mentioned" && !row.viewerIsMentioned) continue;
        if (role === "authored"  && row.authorId !== user.id) continue;
        if (await canUserAccessAnchor(user, row.anchorType, row.anchorId)) {
          visible.push(row);
        }
      }
      res.json(visible);
    } catch (err) {
      console.error("[context-notes] inbox:", err);
      res.status(500).json({ error: "Failed to fetch inbox" });
    }
  });

  // ── Note detail (with replies + events) ───────────────────────────────
  app.get("/api/context-notes/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const note = await getNoteById(pStr(req.params.id));
      if (!note || note.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Not found" });
      }
      if (!(await canUserAccessAnchor(user, note.anchorType, note.anchorId))) {
        return res.status(403).json({ error: "Not allowed for this anchor" });
      }
      const [replies, events, mentions] = await Promise.all([
        getReplies(note.id),
        getEvents(note.id),
        getMentionUserIds(note.id),
      ]);
      res.json({ note, replies, events, mentionUserIds: mentions });
    } catch (err) {
      console.error("[context-notes] detail:", err);
      res.status(500).json({ error: "Failed to fetch note" });
    }
  });

  // ── Create ────────────────────────────────────────────────────────────
  app.post("/api/context-notes", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const parsed = createBodySchema.parse(req.body);
      if (!(await canUserAccessAnchor(user, parsed.anchorType, parsed.anchorId))) {
        return res.status(403).json({ error: "Not allowed for this anchor" });
      }
      // Mentions must be (a) in the same org AND (b) able to see the anchor.
      // Filtering by anchor visibility prevents leaking that a record exists
      // (and its content via the notification body) to users who couldn't
      // otherwise see the underlying object.
      const sameOrgUsers = await findUsersInOrg(parsed.mentions, user.organizationId);
      const validMentions: string[] = [];
      for (const candidate of sameOrgUsers) {
        if (candidate.id === user.id) continue;
        const fullUser = await storage.getUser(candidate.id).catch(() => undefined);
        if (!fullUser) continue;
        if (!(await canUserAccessAnchor(fullUser, parsed.anchorType, parsed.anchorId))) continue;
        validMentions.push(candidate.id);
      }

      const [label, routePayload] = await Promise.all([
        snapshotAnchorLabel(parsed.anchorType, parsed.anchorId, user.organizationId),
        snapshotAnchorRoutePayload(parsed.anchorType, parsed.anchorId, user.organizationId),
      ]);

      const note = await insertNote({
        orgId: user.organizationId,
        authorId: user.id,
        anchorType: parsed.anchorType,
        anchorId: parsed.anchorId,
        anchorLabel: label,
        routePayload,
        body: parsed.body,
        actionType: parsed.actionType,
        status: parsed.status,
      });

      await insertEvent({ noteId: note.id, actorId: user.id, type: "created", detail: null });

      if (validMentions.length > 0) {
        await insertMentions(note.id, validMentions);
        await insertEvent({
          noteId: note.id,
          actorId: user.id,
          type: "mentioned",
          detail: { userIds: validMentions },
        });
        const link = anchorDeepLinkWithReveal(parsed.anchorType, parsed.anchorId, note.id);
        await fanoutNotifications({
          recipientIds: validMentions,
          type: "context_note_mention",
          title: `${user.name || "A teammate"} mentioned you`,
          body: snippet(parsed.body),
          link,
          relatedId: note.id,
        });
      }

      res.status(201).json(note);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
      console.error("[context-notes] create:", err);
      res.status(500).json({ error: "Failed to create note" });
    }
  });

  // ── Reply ─────────────────────────────────────────────────────────────
  app.post("/api/context-notes/:id/replies", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const parsed = replyBodySchema.parse(req.body);
      const note = await getNoteById(pStr(req.params.id));
      if (!note || note.orgId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      if (!(await canUserAccessAnchor(user, note.anchorType, note.anchorId))) {
        return res.status(403).json({ error: "Not allowed for this anchor" });
      }
      const reply = await insertReply(note.id, user.id, parsed.body);
      await insertEvent({ noteId: note.id, actorId: user.id, type: "replied", detail: null });

      const candidates = new Set<string>();
      if (note.authorId !== user.id) candidates.add(note.authorId);
      const mentioned = await getMentionUserIds(note.id);
      for (const m of mentioned) if (m !== user.id) candidates.add(m);

      // Re-validate anchor visibility for every recipient at fan-out time.
      // A user who could see the anchor when the note was created may have
      // since lost access (lane reassigned, conversation handed off, role
      // demoted, …). Filtering here prevents the reply body snippet from
      // leaking contextual detail to a now-unauthorized recipient.
      const allowedRecipients: string[] = [];
      for (const recipientId of candidates) {
        const recipientUser = await storage.getUser(recipientId).catch(() => undefined);
        if (!recipientUser) continue;
        if (await canUserAccessAnchor(recipientUser, note.anchorType, note.anchorId)) {
          allowedRecipients.push(recipientId);
        }
      }

      const link = anchorDeepLinkWithReveal(note.anchorType, note.anchorId, note.id);
      await fanoutNotifications({
        recipientIds: allowedRecipients,
        type: "context_note_reply",
        title: `${user.name || "A teammate"} replied to a note`,
        body: snippet(parsed.body),
        link,
        relatedId: note.id,
      });
      res.status(201).json(reply);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
      console.error("[context-notes] reply:", err);
      res.status(500).json({ error: "Failed to reply" });
    }
  });

  // ── Status transition ─────────────────────────────────────────────────
  // The canonical endpoint is `POST /:id/transition { to }`. Spec also
  // calls out three explicit aliases (acknowledge / resolve / reopen) so
  // callers can avoid embedding the target enum in URLs and so external
  // automation reads cleanly. All four routes share `runTransition` to
  // keep authz and event-emission identical.
  async function runTransition(
    req: import("express").Request,
    res: import("express").Response,
    target: ContextNoteStatus,
  ): Promise<void> {
    try {
      const user = await getCurrentUser(req);
      if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
      const note = await getNoteById(pStr(req.params.id));
      if (!note || note.orgId !== user.organizationId) {
        res.status(404).json({ error: "Not found" }); return;
      }
      if (!(await canUserAccessAnchor(user, note.anchorType, note.anchorId))) {
        res.status(403).json({ error: "Not allowed for this anchor" }); return;
      }
      // Only the author or a mentioned user can transition.
      const mentioned = await getMentionUserIds(note.id);
      if (note.authorId !== user.id && !mentioned.includes(user.id)) {
        res.status(403).json({ error: "Only the author or a mentioned user can change status" });
        return;
      }
      const updated = await transitionNote(note.id, target, user.id);
      const eventType =
        target === "acknowledged" ? "acknowledged" :
        target === "resolved" ? "resolved" : "reopened";
      await insertEvent({ noteId: note.id, actorId: user.id, type: eventType, detail: null });
      res.json(updated);
    } catch (err: unknown) {
      console.error(`[context-notes] transition→${target}:`, err);
      res.status(500).json({ error: "Failed to transition note" });
    }
  }

  app.post("/api/context-notes/:id/transition", requireAuth, async (req, res) => {
    try {
      const parsed = transitionBodySchema.parse(req.body);
      await runTransition(req, res, parsed.to);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
      console.error("[context-notes] transition:", err);
      res.status(500).json({ error: "Failed to transition note" });
    }
  });

  // Explicit aliases — keep contract surface aligned with the v1 spec.
  app.post("/api/context-notes/:id/acknowledge", requireAuth, (req, res) => runTransition(req, res, "acknowledged"));
  app.post("/api/context-notes/:id/resolve",     requireAuth, (req, res) => runTransition(req, res, "resolved"));
  app.post("/api/context-notes/:id/reopen",      requireAuth, (req, res) => runTransition(req, res, "open"));

  // ── Convert to task ───────────────────────────────────────────────────
  app.post("/api/context-notes/:id/convert-to-task", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const parsed = convertBodySchema.parse(req.body);
      const note = await getNoteById(pStr(req.params.id));
      if (!note || note.orgId !== user.organizationId) return res.status(404).json({ error: "Not found" });
      if (!(await canUserAccessAnchor(user, note.anchorType, note.anchorId))) {
        return res.status(403).json({ error: "Not allowed for this anchor" });
      }
      const assignee = await findUsersInOrg([parsed.assignedTo], user.organizationId);
      if (assignee.length === 0) return res.status(400).json({ error: "Assignee must be in your org" });

      const ctx = await buildTaskContextForAnchor(note.anchorType, note.anchorId, user.organizationId);
      // Backlink the assignee can click straight from "Tasks" to land back on
      // the source surface with the originating note pre-revealed. If the
      // anchor type has no deep link (shouldn't happen for any registered
      // type) we still embed a stable placeholder so the description format
      // is consistent.
      const anchorDeepLink =
        anchorDeepLinkWithReveal(note.anchorType, note.anchorId, note.id) ??
        `/context-notes/${encodeURIComponent(note.id)}`;
      const task = await createTaskFromNote({
        note,
        actorId: user.id,
        assignedTo: parsed.assignedTo,
        title: parsed.title,
        dueDate: parsed.dueDate ?? null,
        companyId: ctx.companyId ?? null,
        opportunityId: ctx.opportunityId ?? null,
        laneContext: ctx.laneContext ?? null,
        anchorDeepLink,
      });
      await attachConvertedTask(note.id, task.id);
      await insertEvent({
        noteId: note.id,
        actorId: user.id,
        type: "converted_to_task",
        detail: { taskId: task.id, assignedTo: parsed.assignedTo },
      });
      res.json({ ok: true, taskId: task.id });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
      console.error("[context-notes] convert-to-task:", err);
      res.status(500).json({ error: "Failed to convert" });
    }
  });

  // ── Mark mentions read ────────────────────────────────────────────────
  app.post("/api/context-notes/:id/mentions/read", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await markMentionsRead(pStr(req.params.id), user.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("[context-notes] mark-read:", err);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/context-notes/mentions/read-all", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await markAllMentionsRead(user.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("[context-notes] mark-read-all:", err);
      res.status(500).json({ error: "Failed" });
    }
  });
}

function snippet(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 137)}…` : oneLine;
}

/**
 * Returns the subset of `anchorIds` that the viewer can actually see, by
 * delegating to each anchor type's `canAccess` check. Used to gate
 * counts/inbox responses so a hidden record never leaks via "a note exists
 * here" telemetry.
 */
async function filterAccessibleAnchors(
  user: User,
  anchorType: string,
  anchorIds: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of anchorIds) {
    if (await canUserAccessAnchor(user, anchorType, id)) out.push(id);
  }
  return out;
}
