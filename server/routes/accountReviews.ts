/**
 * Account Reviews routes — list per company, list per rep (manager view),
 * generate-on-demand, follow-up thread comments, and thumbs-up/down feedback
 * (which writes to the existing draft_feedback table).
 *
 * Authorization model
 * - Read by company: caller must be allowed to view the company.
 * - Read by rep: admin, the rep themselves, or anyone in the rep's manager
 *   chain (incl. role-based shortcuts: director / sales_director /
 *   national_account_manager).
 * - Mutate (rate / follow-up / generate-now for self): the owning rep, or
 *   admin acting on their behalf. Managers are read-only.
 * - Run-batch: admin only.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { sql, and, eq } from "drizzle-orm";
import { requireAuth, getCurrentUser, canAccessCompany } from "../auth";
import { db, storage } from "../storage";
import { generateAccountReviewNow, runWeeklyAccountReviews } from "../weeklyAccountReviewScheduler";
import { weekOfFor } from "../services/accountReviewComposer";
import { threads as threadsTable, threadMessages, type AccountReview, type User } from "@shared/schema";
import { ensureDefaultAgent } from "../agent/persona";
import { runAgentTurn } from "../agent/core";
import type { AgentContext } from "../agent/tools";

/** Roles with implicit cross-rep visibility (still org-scoped). */
const MANAGER_ROLES = new Set(["admin", "director", "sales_director", "national_account_manager"]);

/** True if `viewer` may read review artifacts owned by `repUserId`. */
async function canViewRepReviews(viewer: User, repUserId: string): Promise<boolean> {
  if (viewer.id === repUserId) return true;
  if (MANAGER_ROLES.has(viewer.role)) return true;
  // Direct or transitive manager.
  const chain = await storage.getManagerChainIds(repUserId, viewer.organizationId);
  return chain.includes(viewer.id);
}

/** True if `viewer` may rate / append follow-ups to `review`. Managers are read-only. */
function canModifyReview(viewer: User, review: AccountReview): boolean {
  if (viewer.organizationId !== review.organizationId) return false;
  if (viewer.role === "admin") return true;
  return viewer.id === review.repUserId;
}

/**
 * Ensure a follow-up thread exists for this review. Creates one lazily and
 * stamps the review row so subsequent follow-ups land in the same thread.
 * The thread is owned by the rep (review.repUserId) so it shows up alongside
 * their other ValueIQ work; surface=`account-review` keeps it filterable.
 */
async function ensureFollowUpThread(review: AccountReview): Promise<string> {
  if (review.followUpThreadId) return review.followUpThreadId;

  const company = await storage.getCompany(review.companyId);
  const defaultAgentId = await ensureDefaultAgent(review.organizationId).catch(() => null);
  const [thread] = await db.insert(threadsTable).values({
    organizationId: review.organizationId,
    userId: review.repUserId,
    title: `Account Review — ${company?.name ?? "Account"} (week of ${review.weekOf})`,
    surface: "account-review",
    defaultAgentId: defaultAgentId ?? null,
  }).returning();

  // Seed the thread with the review body as initial assistant context, so
  // any follow-up agent run has the full review available.
  await db.insert(threadMessages).values({
    threadId: thread.id,
    role: "assistant",
    agentName: "Account Review",
    content: review.body,
    metadata: {
      kind: "account-review",
      accountReviewId: review.id,
      companyId: review.companyId,
      weekOf: review.weekOf,
    },
  });

  await db.execute(sql`
    UPDATE account_reviews SET follow_up_thread_id = ${thread.id} WHERE id = ${review.id}
  `);
  return thread.id;
}

export function registerAccountReviewRoutes(app: Express): void {
  // List the rolling 8 most recent reviews for a company (any rep).
  app.get("/api/account-reviews/company/:companyId", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const companyId = String(req.params.companyId);
      if (!(await canAccessCompany(user, companyId))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "8"), 10)));
      const rows = await storage.getAccountReviewsByCompany(companyId, user.organizationId, limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: (err instanceof Error ? err.message : null) || "Failed to load account reviews" });
    }
  });

  // Manager view — every review for a given rep, optionally filtered by week.
  app.get("/api/account-reviews/rep/:repUserId", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const repUserId = String(req.params.repUserId);

      // Verify the target rep exists in the same org before any further work.
      const targetRep = await storage.getUser(repUserId);
      if (!targetRep || targetRep.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Rep not found" });
      }
      if (!(await canViewRepReviews(user, repUserId))) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const weekOf = req.query.weekOf ? String(req.query.weekOf) : undefined;
      const rows = await storage.getAccountReviewsByRep(repUserId, user.organizationId, weekOf, 100);

      // Hydrate company name for the manager UI.
      const ids = Array.from(new Set(rows.map(r => r.companyId)));
      const companies = await Promise.all(ids.map(id => storage.getCompany(id).catch(() => undefined)));
      const nameById = new Map<string, string>();
      for (const c of companies) if (c) nameById.set(c.id, c.name);

      res.json(rows.map(r => ({ ...r, companyName: nameById.get(r.companyId) || null })));
    } catch (err) {
      res.status(500).json({ error: (err instanceof Error ? err.message : null) || "Failed to load account reviews" });
    }
  });

  // Generate-now — queue a single review for the caller + a company. Admins
  // may target a different rep; everyone else can only generate for themselves.
  app.post("/api/account-reviews/generate", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const body = z.object({
        companyId: z.string().min(1),
        repUserId: z.string().optional(),
        weekOf: z.string().optional(),
      }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Invalid body", details: body.error.issues });

      let repUserId = body.data.repUserId || user.id;
      let repName = user.name;
      if (repUserId !== user.id) {
        if (user.role !== "admin") {
          return res.status(403).json({ error: "Only admins can generate reviews on behalf of another rep." });
        }
        const target = await storage.getUser(repUserId);
        if (!target || target.organizationId !== user.organizationId) {
          return res.status(404).json({ error: "Target rep not found in your organization." });
        }
        repName = target.name;
      }

      if (!(await canAccessCompany(user, body.data.companyId))) {
        return res.status(403).json({ error: "You do not have access to that company." });
      }

      const review = await generateAccountReviewNow({
        organizationId: user.organizationId,
        repUserId,
        repName,
        companyId: body.data.companyId,
        weekOf: body.data.weekOf,
      });
      if (!review) return res.status(404).json({ error: "Company not found or could not be summarized." });
      res.json(review);
    } catch (err) {
      res.status(500).json({ error: (err instanceof Error ? err.message : null) || "Failed to generate review" });
    }
  });

  // Admin-only — kick off the full Friday batch immediately. Useful for QA.
  app.post("/api/account-reviews/run-batch", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user || user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
      const weekOf = typeof req.body?.weekOf === "string" ? req.body.weekOf : weekOfFor(new Date());
      const totals = await runWeeklyAccountReviews(weekOf);
      res.json({ weekOf, ...totals });
    } catch (err) {
      res.status(500).json({ error: (err instanceof Error ? err.message : null) || "Failed to run batch" });
    }
  });

  // Thumbs up/down feedback. Persists to draft_feedback (existing loop) and
  // mirrors the rating onto the account_reviews row for quick display.
  // Only the owning rep (or admin) may rate — managers are read-only.
  app.post("/api/account-reviews/:id/rate", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const body = z.object({
        rating: z.enum(["up", "down"]),
        notes: z.string().max(2000).optional(),
      }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Invalid body" });

      const review = await storage.getAccountReviewById(String(req.params.id), user.organizationId);
      if (!review) return res.status(404).json({ error: "Account review not found" });
      if (!canModifyReview(user, review)) {
        return res.status(403).json({ error: "Only the owning rep can rate this review." });
      }
      const company = await storage.getCompany(review.companyId);

      await db.execute(sql`
        INSERT INTO draft_feedback (org_id, user_id, user_name, rating, notes, draft_text, play_type, play_label, account_id, account_name)
        VALUES (
          ${user.organizationId}, ${user.id}, ${user.name},
          ${body.data.rating}, ${body.data.notes ?? null},
          ${review.body}, ${"account-review"}, ${`Week of ${review.weekOf}`},
          ${review.companyId}, ${company?.name ?? null}
        )
      `);

      const numericRating = body.data.rating === "up" ? 1 : -1;
      await storage.rateAccountReview(review.id, user.organizationId, numericRating);
      res.json({ ok: true, rating: body.data.rating });
    } catch (err) {
      res.status(500).json({ error: (err instanceof Error ? err.message : null) || "Failed to rate review" });
    }
  });

  // Follow-up thread — append a message to the review's ValueIQ thread.
  // Lazily creates the thread (seeded with the review body) on first message.
  // Only the owning rep (or admin) may post — managers are read-only.
  app.post("/api/account-reviews/:id/follow-up", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const body = z.object({ message: z.string().min(1).max(4000) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Invalid body" });

      const review = await storage.getAccountReviewById(String(req.params.id), user.organizationId);
      if (!review) return res.status(404).json({ error: "Account review not found" });
      if (!canModifyReview(user, review)) {
        return res.status(403).json({ error: "Only the owning rep can post follow-ups." });
      }

      const threadId = await ensureFollowUpThread(review);
      const [userMsg] = await db.insert(threadMessages).values({
        threadId,
        role: "user",
        content: body.data.message,
        metadata: {
          accountReviewId: review.id,
          authorUserId: user.id,
          authorName: user.name,
        },
      }).returning();

      // Build short history from the thread (oldest first, capped to 20).
      const priorRows = await db.select().from(threadMessages)
        .where(eq(threadMessages.threadId, threadId));
      const priorSorted = priorRows
        .slice()
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .filter(m => m.id !== userMsg.id)
        .slice(-20)
        .map(m => ({
          role: (m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user") as "user" | "assistant" | "system",
          content: m.content,
        }));

      const ctx: AgentContext = {
        rep: user,
        organizationId: user.organizationId,
        channel: "in_app",
        conversationRef: threadId,
        scope: "everyone",
      };

      let assistantText = "";
      let hadError = false;
      let agentIdUsed: string | null = null;
      try {
        const result = await runAgentTurn({
          ctx,
          history: priorSorted,
          userMessage: body.data.message,
          emit: (event) => {
            if ("content" in event && typeof event.content === "string") assistantText += event.content;
          },
        });
        hadError = result.hadError;
        agentIdUsed = result.agentId;
      } catch (agentErr) {
        hadError = true;
        console.error("[account-review] follow-up agent error:", agentErr);
      }

      const [assistantMsg] = await db.insert(threadMessages).values({
        threadId,
        role: "assistant",
        agentId: agentIdUsed,
        content: assistantText || "I wasn't able to produce a response. Please try again.",
        metadata: hadError ? { hadError: true, accountReviewId: review.id } : { accountReviewId: review.id },
      }).returning();
      await db.update(threadsTable).set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(threadsTable.id, threadId));

      res.json({ threadId, userMessage: userMsg, assistantMessage: assistantMsg });
    } catch (err) {
      res.status(500).json({ error: (err instanceof Error ? err.message : null) || "Failed to add follow-up" });
    }
  });

  // List follow-up thread messages for a review (owner + permitted managers).
  app.get("/api/account-reviews/:id/follow-up", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const review = await storage.getAccountReviewById(String(req.params.id), user.organizationId);
      if (!review) return res.status(404).json({ error: "Account review not found" });
      if (!(await canViewRepReviews(user, review.repUserId))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!review.followUpThreadId) return res.json({ threadId: null, messages: [] });
      const rows = await db.select().from(threadMessages)
        .where(and(eq(threadMessages.threadId, review.followUpThreadId)));
      res.json({ threadId: review.followUpThreadId, messages: rows });
    } catch (err) {
      res.status(500).json({ error: (err instanceof Error ? err.message : null) || "Failed to load follow-ups" });
    }
  });
}
