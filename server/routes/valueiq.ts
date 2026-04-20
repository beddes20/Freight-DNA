/**
 * ValueIQ workspace API surface.
 *
 * Routes (all `requireAuth`, all org-scoped to the caller):
 *   GET    /api/valueiq/agents                — list available agents for me
 *   GET    /api/valueiq/projects              — list my projects
 *   POST   /api/valueiq/projects              — create
 *   PATCH  /api/valueiq/projects/:id          — rename / pinned context
 *   DELETE /api/valueiq/projects/:id
 *   GET    /api/valueiq/threads               — list (?archived=true)
 *   POST   /api/valueiq/threads               — create
 *   PATCH  /api/valueiq/threads/:id           — title/pinned/archive/project
 *   DELETE /api/valueiq/threads/:id
 *   GET    /api/valueiq/threads/:id/messages  — full history
 *   POST   /api/valueiq/threads/:id/messages  — append + stream agent reply (SSE)
 *   PATCH  /api/valueiq/messages/:id          — rate
 *   POST   /api/valueiq/messages/:id/save     — save as task/touchpoint/library
 *   POST   /api/valueiq/threads/:id/attach    — multipart file upload
 *   GET    /api/valueiq/library               — list my library
 *   POST   /api/valueiq/library               — add memory/fact
 *   DELETE /api/valueiq/library/:id
 *
 * Streaming uses the same `data: …` SSE envelope as /api/chatbot so the
 * existing client SSE consumer can be reused.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import { db, storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  agents as agentsTable,
  agentUserAccess,
  threads as threadsTable,
  threadMessages,
  threadProjects,
  threadAttachments,
  type Thread,
} from "@shared/schema";
import { runAgentTurn } from "../agent/core";
import { ensureDefaultAgent } from "../agent/persona";
import { addLibraryItem, listLibraryItems, deleteLibraryItem } from "../agent/libraryIndexer";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Extract plain text from an uploaded file. Supports text/json/csv/markdown
 * (utf-8), Excel (.xlsx/.xls via SheetJS → CSV per sheet), and PDF (via
 * pdf-parse). Unsupported types return null so the file is stored as binary.
 * Output is capped at 100k characters to keep prompt size bounded.
 */
async function extractTextFromUpload(file: Express.Multer.File): Promise<string | null> {
  const name = file.originalname || "";
  const mime = file.mimetype || "";
  const isTextLike = mime.startsWith("text/") || mime === "application/json"
    || /\.(md|txt|csv|json|html?|log|tsv)$/i.test(name);
  try {
    if (isTextLike) return file.buffer.toString("utf-8").slice(0, 100_000);
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      const pdfParse = (await import("pdf-parse")).default;
      const result = await pdfParse(file.buffer);
      return (result.text ?? "").slice(0, 100_000);
    }
    if (
      mime.includes("spreadsheetml") || mime.includes("ms-excel")
      || /\.(xlsx?|xlsm)$/i.test(name)
    ) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(file.buffer, { type: "buffer" });
      const blocks: string[] = [];
      for (const sheetName of wb.SheetNames.slice(0, 10)) {
        const ws = wb.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(ws);
        if (csv.trim()) blocks.push(`--- sheet: ${sheetName} ---\n${csv}`);
      }
      return blocks.join("\n\n").slice(0, 100_000) || null;
    }
  } catch (err) {
    console.warn("[valueiq] file parse failed:", err);
  }
  return null;
}

async function loadThread(threadId: string, userId: string): Promise<Thread | null> {
  const [row] = await db.select().from(threadsTable)
    .where(and(eq(threadsTable.id, threadId), eq(threadsTable.userId, userId))).limit(1);
  return row ?? null;
}

/**
 * Verify the requested agent is callable by this user. Enforces:
 *  - same organization
 *  - status published OR is_default
 *  - access scope: everyone | roles (user role in allow list) | specific_users
 *    (explicit row in agent_user_access with enabled=true)
 */
async function assertAgentEligible(
  agentId: string,
  user: { id: string; organizationId: string; role: string },
): Promise<{ ok: true; agentId: string } | { ok: false; reason: string }> {
  const [agent] = await db.select().from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.organizationId, user.organizationId)))
    .limit(1);
  if (!agent) return { ok: false, reason: "Agent not found" };
  if (agent.status !== "published" && !agent.isDefault) {
    return { ok: false, reason: "Agent is not published" };
  }
  const scope = (agent.accessScope as string | null) ?? "everyone";
  if (scope === "everyone") return { ok: true, agentId: agent.id };
  if (scope === "roles") {
    const roles = Array.isArray(agent.allowedRoles) ? agent.allowedRoles : [];
    if (!roles.includes(user.role)) return { ok: false, reason: "Not authorized for this agent" };
    return { ok: true, agentId: agent.id };
  }
  if (scope === "specific_users") {
    const [acc] = await db.select().from(agentUserAccess)
      .where(and(eq(agentUserAccess.agentId, agent.id), eq(agentUserAccess.userId, user.id)))
      .limit(1);
    if (!acc || acc.enabled === false) return { ok: false, reason: "Not authorized for this agent" };
    return { ok: true, agentId: agent.id };
  }
  return { ok: true, agentId: agent.id };
}

export function registerValueIQRoutes(app: Express) {
  // ─── Agents available to this user ────────────────────────────────────────
  app.get("/api/valueiq/agents", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const all = await db.select().from(agentsTable)
        .where(and(eq(agentsTable.organizationId, user.organizationId), eq(agentsTable.status, "published")))
        .orderBy(desc(agentsTable.isDefault), agentsTable.name);
      const allowedRows = await db.select().from(agentUserAccess).where(eq(agentUserAccess.userId, user.id));
      const allowedMap = new Map(allowedRows.map((r) => [r.agentId, r.enabled]));
      const filtered = all.filter((a) => {
        if (a.accessScope === "everyone") return true;
        if (a.accessScope === "roles") return Array.isArray(a.allowedRoles) && a.allowedRoles.includes(user.role as string);
        if (a.accessScope === "specific_users") return allowedMap.get(a.id) === true;
        return true;
      });
      res.json(filtered.map((a) => ({
        id: a.id, slug: a.slug, name: a.name, description: a.description,
        avatarUrl: a.avatarUrl, isDefault: a.isDefault, model: a.model || "gpt-4o",
      })));
    } catch (err) {
      console.error("[valueiq] list agents:", err);
      res.status(500).json({ error: "Failed to load agents" });
    }
  });

  // ─── Projects ─────────────────────────────────────────────────────────────
  app.get("/api/valueiq/projects", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const rows = await db.select().from(threadProjects)
      .where(eq(threadProjects.userId, user.id))
      .orderBy(desc(threadProjects.createdAt));
    res.json(rows);
  });
  const projectSchema = z.object({
    name: z.string().min(1).max(120),
    pinnedContext: z.string().max(8000).optional().nullable(),
  });
  app.post("/api/valueiq/projects", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const body = projectSchema.parse(req.body);
      const [row] = await db.insert(threadProjects).values({
        organizationId: user.organizationId, userId: user.id,
        name: body.name, pinnedContext: body.pinnedContext ?? null,
      }).returning();
      res.json(row);
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? "Invalid project" });
    }
  });
  app.patch("/api/valueiq/projects/:id", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const body = projectSchema.partial().parse(req.body);
    const [row] = await db.update(threadProjects).set({ ...body, updatedAt: new Date() })
      .where(and(eq(threadProjects.id, req.params.id), eq(threadProjects.userId, user.id))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });
  app.delete("/api/valueiq/projects/:id", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    await db.update(threadsTable).set({ projectId: null })
      .where(and(eq(threadsTable.userId, user.id), eq(threadsTable.projectId, req.params.id)));
    await db.delete(threadProjects).where(and(eq(threadProjects.id, req.params.id), eq(threadProjects.userId, user.id)));
    res.json({ ok: true });
  });

  // ─── Threads ──────────────────────────────────────────────────────────────
  app.get("/api/valueiq/threads", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const archived = req.query.archived === "true";
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const conds = [eq(threadsTable.userId, user.id)];
    if (archived) {
      // archived rows only when ?archived=true
    } else {
      conds.push(isNull(threadsTable.archivedAt));
    }
    if (projectId) conds.push(eq(threadsTable.projectId, projectId));
    const rows = await db.select().from(threadsTable)
      .where(and(...conds))
      .orderBy(desc(threadsTable.pinned), desc(sql`COALESCE(${threadsTable.lastMessageAt}, ${threadsTable.createdAt})`))
      .limit(200);
    res.json(rows);
  });

  const createThreadSchema = z.object({
    title: z.string().max(200).optional(),
    projectId: z.string().nullable().optional(),
    defaultAgentId: z.string().nullable().optional(),
    surface: z.string().optional(),
  });
  app.post("/api/valueiq/threads", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const body = createThreadSchema.parse(req.body ?? {});
      const defaultAgentId = body.defaultAgentId ?? (await ensureDefaultAgent(user.organizationId));
      const [row] = await db.insert(threadsTable).values({
        organizationId: user.organizationId,
        userId: user.id,
        title: body.title ?? "New thread",
        projectId: body.projectId ?? null,
        defaultAgentId,
        surface: body.surface ?? "valueiq",
      }).returning();
      res.json(row);
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? "Invalid thread" });
    }
  });

  const patchThreadSchema = z.object({
    title: z.string().max(200).optional(),
    pinned: z.boolean().optional(),
    projectId: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    defaultAgentId: z.string().nullable().optional(),
  });
  app.patch("/api/valueiq/threads/:id", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const body = patchThreadSchema.parse(req.body ?? {});
    const patch: any = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.pinned !== undefined) patch.pinned = body.pinned;
    if (body.projectId !== undefined) patch.projectId = body.projectId;
    if (body.defaultAgentId !== undefined) patch.defaultAgentId = body.defaultAgentId;
    if (body.archived !== undefined) patch.archivedAt = body.archived ? new Date() : null;
    const [row] = await db.update(threadsTable).set(patch)
      .where(and(eq(threadsTable.id, req.params.id), eq(threadsTable.userId, user.id))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });

  app.delete("/api/valueiq/threads/:id", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    await db.delete(threadsTable).where(and(eq(threadsTable.id, req.params.id), eq(threadsTable.userId, user.id)));
    res.json({ ok: true });
  });

  // ─── Thread messages ──────────────────────────────────────────────────────
  app.get("/api/valueiq/threads/:id/messages", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const thread = await loadThread(req.params.id, user.id);
    if (!thread) return res.status(404).json({ error: "Not found" });
    const rows = await db.select().from(threadMessages)
      .where(eq(threadMessages.threadId, thread.id))
      .orderBy(threadMessages.createdAt).limit(500);
    res.json(rows);
  });

  const sendSchema = z.object({
    content: z.string().min(1).max(8000),
    agentId: z.string().optional(),
    attachmentIds: z.array(z.string()).optional(),
  });

  app.post("/api/valueiq/threads/:id/messages", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const thread = await loadThread(req.params.id, user.id);
    if (!thread) return res.status(404).json({ error: "Not found" });
    let body: z.infer<typeof sendSchema>;
    try { body = sendSchema.parse(req.body); }
    catch (err: any) { return res.status(400).json({ error: err.message }); }

    const requestedAgentId = body.agentId ?? thread.defaultAgentId ?? (await ensureDefaultAgent(user.organizationId));
    // Enforce eligibility: agent must be in the user's org, published (or
    // default), and accessible to this user (allow_all OR specific assignment).
    const eligible = await assertAgentEligible(requestedAgentId, user);
    if (!eligible.ok) {
      return res.status(403).json({ error: eligible.reason });
    }
    const agentId = eligible.agentId;

    // Resolve attachment text (parsed at upload time) and inline as context.
    let userContent = body.content;
    if (body.attachmentIds?.length) {
      const atts = await db.select().from(threadAttachments)
        .where(and(eq(threadAttachments.threadId, thread.id), inArray(threadAttachments.id, body.attachmentIds)));
      const blocks = atts
        .filter((a) => a.parsedText && a.parsedText.length > 0)
        .map((a) => `\n\n--- attached file: ${a.fileName} ---\n${(a.parsedText ?? "").slice(0, 6000)}`);
      if (blocks.length) userContent = userContent + "\n" + blocks.join("");
    }

    // Persist user message
    const [userMsg] = await db.insert(threadMessages).values({
      threadId: thread.id, role: "user", content: body.content,
      attachments: body.attachmentIds?.length ? body.attachmentIds : null,
    }).returning();

    // Stream agent reply via SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Build short history (last 20)
    const history = await db.select().from(threadMessages)
      .where(eq(threadMessages.threadId, thread.id))
      .orderBy(threadMessages.createdAt).limit(50);
    const historyForLLM = history
      .filter((m) => m.id !== userMsg.id)
      .slice(-20)
      .map((m) => ({
        role: (m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user") as "user" | "assistant" | "system",
        content: m.content,
      }));

    const ctx = {
      rep: user as any,
      organizationId: user.organizationId,
      channel: "in_app" as const,
      conversationRef: thread.id,
      scope: "everyone" as const,
    };

    let assembled = "";
    let finalAgentName: string | null = null;
    try {
      const result = await runAgentTurn({
        ctx,
        history: historyForLLM,
        userMessage: userContent,
        agentId,
        projectId: thread.projectId ?? null,
        emit: (event) => {
          if ("content" in event && typeof event.content === "string") assembled += event.content;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
      // Look up agent name once for storage.
      const [agentRow] = await db.select({ name: agentsTable.name }).from(agentsTable).where(eq(agentsTable.id, result.agentId)).limit(1);
      finalAgentName = agentRow?.name ?? null;
      await db.insert(threadMessages).values({
        threadId: thread.id, role: "assistant", agentId: result.agentId,
        agentName: finalAgentName, content: assembled || "(no response)",
        metadata: result.hadError ? { hadError: true } : null,
      });
      // bump thread last_message_at + auto-title first turn
      const newTitle = thread.title === "New thread" && body.content.length > 0
        ? body.content.slice(0, 60)
        : thread.title;
      await db.update(threadsTable).set({
        lastMessageAt: new Date(), updatedAt: new Date(), title: newTitle,
      }).where(eq(threadsTable.id, thread.id));
    } catch (err) {
      console.error("[valueiq] runAgentTurn error:", err);
      res.write(`data: ${JSON.stringify({ error: "Agent failed. Please try again." })}\n\n`);
    } finally {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  });

  app.patch("/api/valueiq/messages/:id", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const rating = Number(req.body?.rating);
    if (![1, -1, 0].includes(rating)) return res.status(400).json({ error: "Invalid rating" });
    // Verify message belongs to a thread the user owns
    const [msg] = await db.select({ id: threadMessages.id, threadId: threadMessages.threadId })
      .from(threadMessages).where(eq(threadMessages.id, req.params.id)).limit(1);
    if (!msg) return res.status(404).json({ error: "Not found" });
    const thread = await loadThread(msg.threadId, user.id);
    if (!thread) return res.status(404).json({ error: "Not found" });
    await db.update(threadMessages).set({ rating: rating === 0 ? null : rating })
      .where(eq(threadMessages.id, req.params.id));
    res.json({ ok: true });
  });

  // ─── Save-as actions (library/task/touchpoint) ────────────────────────────
  const saveSchema = z.object({
    target: z.enum(["library", "task", "touchpoint"]),
    title: z.string().max(200).optional(),
    companyId: z.string().optional(),
  });
  app.post("/api/valueiq/messages/:id/save", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const body = saveSchema.parse(req.body ?? {});
    const [msg] = await db.select().from(threadMessages).where(eq(threadMessages.id, req.params.id)).limit(1);
    if (!msg) return res.status(404).json({ error: "Not found" });
    const thread = await loadThread(msg.threadId, user.id);
    if (!thread) return res.status(404).json({ error: "Not found" });

    if (body.target === "library") {
      const id = await addLibraryItem({
        organizationId: user.organizationId, userId: user.id, kind: "memory",
        title: body.title ?? `Saved from ${thread.title}`, body: msg.content,
        sourceId: msg.id, metadata: { threadId: thread.id },
      });
      return res.json({ id });
    }
    if (body.target === "task") {
      const t = await storage.createTask({
        organizationId: user.organizationId,
        title: body.title ?? `From ValueIQ: ${thread.title}`.slice(0, 200),
        description: msg.content.slice(0, 2000),
        assignedTo: user.id,
        createdBy: user.id,
        companyId: body.companyId ?? null,
        status: "pending",
      } as any);
      return res.json({ id: t.id });
    }
    if (body.target === "touchpoint" && body.companyId) {
      const t = await storage.createTouchpoint({
        organizationId: user.organizationId,
        companyId: body.companyId,
        userId: user.id,
        type: "note",
        notes: msg.content.slice(0, 4000),
      } as any);
      return res.json({ id: t.id });
    }
    res.status(400).json({ error: "Missing companyId for touchpoint" });
  });

  // ─── Attachments ──────────────────────────────────────────────────────────
  app.post("/api/valueiq/threads/:id/attach", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const thread = await loadThread(req.params.id, user.id);
    if (!thread) return res.status(404).json({ error: "Not found" });
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return res.status(400).json({ error: "No file" });
    const parsedText = await extractTextFromUpload(file);
    const [row] = await db.insert(threadAttachments).values({
      threadId: thread.id, userId: user.id, kind: parsedText ? "text" : "binary",
      fileName: file.originalname, mimeType: file.mimetype, byteSize: file.size,
      parsedText,
    }).returning();
    res.json({ id: row.id, fileName: row.fileName, parsed: !!parsedText });
  });

  // ─── Library ──────────────────────────────────────────────────────────────
  app.get("/api/valueiq/library", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    res.json(await listLibraryItems(user.id));
  });
  const libSchema = z.object({
    kind: z.enum(["memory", "fact", "file", "thread"]).default("memory"),
    title: z.string().min(1).max(200),
    body: z.string().max(20000).optional().nullable(),
  });
  app.post("/api/valueiq/library", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const body = libSchema.parse(req.body);
      const id = await addLibraryItem({
        organizationId: user.organizationId, userId: user.id,
        kind: body.kind, title: body.title, body: body.body ?? null,
      });
      res.json({ id });
    } catch (err: any) {
      res.status(400).json({ error: err.message ?? "Invalid item" });
    }
  });
  app.delete("/api/valueiq/library/:id", requireAuth, async (req: Request, res: Response) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const ok = await deleteLibraryItem(user.id, req.params.id);
    res.json({ ok });
  });

  // Upload a file directly into the personal library (parsed text becomes
  // the body so it is embedded + searchable like a note). Same parser as
  // thread attachments — supports text/CSV/JSON/Markdown, PDF, Excel.
  app.post("/api/valueiq/library/upload", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ error: "No file" });
      const parsedText = await extractTextFromUpload(file);
      if (!parsedText) {
        return res.status(415).json({ error: "Unsupported file type. Use PDF, CSV, Excel, or text." });
      }
      const id = await addLibraryItem({
        organizationId: user.organizationId, userId: user.id,
        kind: "file", title: file.originalname || "Uploaded file", body: parsedText,
      });
      res.json({ id, fileName: file.originalname, chars: parsedText.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Upload failed" });
    }
  });
}
