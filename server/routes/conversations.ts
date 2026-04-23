/**
 * Conversations Routes (Task #202, #223)
 *
 * Org-scoped CRUD for email_conversation_threads — ownership, waiting state, priority.
 *
 * GET  /api/internal/conversations
 * GET  /api/internal/conversations/my-count
 * GET  /api/internal/conversations/my-waiting
 * GET  /api/internal/conversations/team-overdue
 * GET  /api/internal/conversations/account-summary
 * POST /api/internal/conversations/:id/owner
 * POST /api/internal/conversations/:id/waiting-state
 * GET  /api/internal/conversations/:id/messages
 * POST /api/internal/conversations/:id/priority
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { inArray, and, eq, asc, sql, gte, isNull, desc } from "drizzle-orm";
import { storage, db } from "../storage";
import {
  emailMessages,
  emailSignals,
  emailConversationThreads,
  monitoredMailboxes,
  users,
  InsertEmailConversationThread,
} from "@shared/schema";
import { requireAuth, getCurrentUser } from "../auth";
import { setWaitingState, setPriority } from "../services/conversationWaitingStateService";
import { assignOwner } from "../services/conversationOwnershipService";
import {
  backfillMissingConversationThreads,
  materializeConversationThreadIfMissing,
} from "../services/conversationThreadBackfillService";
import {
  selfHealConversationThread,
  selfHealStuckThreads,
  getThreadCaptureAuditHistory,
  listThreadStoredProviderMessageIds,
  getMailboxSentItemsHealth,
} from "../services/conversationReplyCaptureService";

export function registerConversationsRoutes(app: Express): void {

  // ── GET /api/internal/conversations/my-count ─────────────────────────────────
  app.get("/api/internal/conversations/my-count", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const result = await storage.listEmailConversationThreads(user.organizationId, {
        ownerUserId: user.id,
        waitingState: "waiting_on_us",
        limit: 1,
      });
      res.json({ count: result.totalCount });
    } catch (err) {
      console.error("[conversations] GET /conversations/my-count error:", err);
      res.status(500).json({ error: "Failed to fetch count" });
    }
  });

  // ── GET /api/internal/conversations/my-waiting (Task #223) ─────────────────
  // Returns threads owned by the current user with waiting_state = waiting_on_us,
  // sorted by overdue first then wait duration. Used by the dashboard portlet.
  app.get("/api/internal/conversations/my-waiting", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const result = await storage.listEmailConversationThreads(user.organizationId, {
        ownerUserId: user.id,
        waitingState: "waiting_on_us",
        limit: 50,
      });
      const threads = result.threads;

      const companyIds = [...new Set(threads.map(t => t.linkedAccountId).filter(Boolean) as string[])];
      const carrierIds = [...new Set(threads.map(t => t.linkedCarrierId).filter(Boolean) as string[])];
      const companyMap = new Map<string, string>();
      const carrierMap = new Map<string, string>();
      if (companyIds.length > 0) {
        const companies = await storage.getCompaniesByIds(companyIds, user.organizationId);
        for (const c of companies) companyMap.set(c.id, c.name);
      }
      if (carrierIds.length > 0) {
        const carriers = await storage.getCarriersByIds(carrierIds, user.organizationId);
        for (const c of carriers) carrierMap.set(c.id, c.name);
      }

      const messageIds = threads.map(t => t.lastMessageId).filter(Boolean) as string[];
      const subjectMap = new Map<string, string>();
      if (messageIds.length > 0) {
        const msgs = await db.select({ id: emailMessages.id, subject: emailMessages.subject })
          .from(emailMessages)
          .where(inArray(emailMessages.id, messageIds));
        for (const m of msgs) {
          if (m.subject) subjectMap.set(m.id, m.subject);
        }
      }

      const enriched = threads.map(t => ({
        id: t.id,
        threadId: t.threadId,
        linkedAccountId: t.linkedAccountId,
        linkedCarrierId: t.linkedCarrierId,
        accountName: t.linkedAccountId ? (companyMap.get(t.linkedAccountId) ?? null) : (t.linkedCarrierId ? (carrierMap.get(t.linkedCarrierId) ?? null) : null),
        subject: t.lastMessageId ? (subjectMap.get(t.lastMessageId) ?? null) : null,
        responsePriority: t.responsePriority,
        waitingSinceAt: t.waitingSinceAt,
        overdueAt: t.overdueAt,
        updatedAt: t.updatedAt,
      }));

      const now = new Date();
      enriched.sort((a, b) => {
        const aOverdue = !!(a.overdueAt && a.overdueAt <= now);
        const bOverdue = !!(b.overdueAt && b.overdueAt <= now);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        if (a.waitingSinceAt && b.waitingSinceAt) {
          return new Date(a.waitingSinceAt).getTime() - new Date(b.waitingSinceAt).getTime();
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });

      res.json({ count: enriched.length, threads: enriched });
    } catch (err) {
      console.error("[conversations] GET /conversations/my-waiting error:", err);
      res.status(500).json({ error: "Failed to fetch waiting threads" });
    }
  });

  // ── GET /api/internal/conversations/team-overdue (Task #223) ───────────────
  // Returns a summary of overdue conversations grouped by owner for the
  // requesting user's team. Used by Director and NAM dashboard portlets.
  app.get("/api/internal/conversations/team-overdue", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const teamMemberIds = await storage.getTeamMemberIds(user.id, user.organizationId);

      const overdueResult = await storage.listEmailConversationThreads(user.organizationId, {
        waitingState: "waiting_on_us",
        overdue: true,
        limit: 200,
      });

      const teamThreads = overdueResult.threads.filter(t => t.ownerUserId && teamMemberIds.includes(t.ownerUserId));

      const ownerIds = [...new Set(teamThreads.map(t => t.ownerUserId).filter(Boolean) as string[])];
      const ownerMap = new Map<string, string>();
      await Promise.all(ownerIds.map(async id => {
        const u = await storage.getUser(id);
        if (u) ownerMap.set(id, u.name);
      }));

      const companyIds = [...new Set(teamThreads.map(t => t.linkedAccountId).filter(Boolean) as string[])];
      const companyMap = new Map<string, string>();
      if (companyIds.length > 0) {
        const companies = await storage.getCompaniesByIds(companyIds, user.organizationId);
        for (const c of companies) companyMap.set(c.id, c.name);
      }

      const byOwner: Record<string, { ownerName: string; threads: Array<{ id: string; threadId: string; accountName: string | null; responsePriority: string; overdueAt: string | null; waitingSinceAt: string | null }> }> = {};
      for (const t of teamThreads) {
        const ownerId = t.ownerUserId!;
        if (!byOwner[ownerId]) {
          byOwner[ownerId] = { ownerName: ownerMap.get(ownerId) ?? "Unknown", threads: [] };
        }
        byOwner[ownerId].threads.push({
          id: t.id,
          threadId: t.threadId,
          accountName: t.linkedAccountId ? (companyMap.get(t.linkedAccountId) ?? null) : null,
          responsePriority: t.responsePriority,
          overdueAt: t.overdueAt?.toISOString() ?? null,
          waitingSinceAt: t.waitingSinceAt?.toISOString() ?? null,
        });
      }

      res.json({ totalOverdue: teamThreads.length, byOwner });
    } catch (err) {
      console.error("[conversations] GET /conversations/team-overdue error:", err);
      res.status(500).json({ error: "Failed to fetch team overdue conversations" });
    }
  });

  // ── GET /api/internal/conversations/account-summary (Task #223) ────────────
  // Returns thread counts by waiting state for a specific account.
  // Query param: accountId (required)
  app.get("/api/internal/conversations/account-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { accountId } = req.query;
      if (!accountId) return res.status(400).json({ error: "accountId is required" });

      const result = await storage.listEmailConversationThreads(user.organizationId, {
        linkedAccountId: accountId as string,
        limit: 200,
        excludeArchived: false,
      });
      const threads = result.threads;

      let waitingOnUs = 0;
      let waitingOnThem = 0;
      let resolved = 0;
      let overdue = 0;

      let archived = 0;

      for (const t of threads) {
        if (t.waitingState === "waiting_on_us") {
          waitingOnUs++;
          if (t.overdueAt && t.overdueAt <= new Date()) overdue++;
        } else if (t.waitingState === "waiting_on_them") {
          waitingOnThem++;
        } else if (t.waitingState === "archived") {
          archived++;
        } else {
          resolved++;
        }
      }

      res.json({ total: threads.length, waitingOnUs, waitingOnThem, resolved, overdue, archived });
    } catch (err) {
      console.error("[conversations] GET /conversations/account-summary error:", err);
      res.status(500).json({ error: "Failed to fetch account summary" });
    }
  });

  // ── GET /api/internal/conversations ─────────────────────────────────────────
  // Query filters: accountId, carrierId, ownerUserId, waitingState,
  // responsePriority, overdue=true|false, unowned=true, archived=true,
  // cursor, limit, search, dateFrom, dateTo
  app.get("/api/internal/conversations", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const orgId = user.organizationId;
      const { accountId, carrierId, ownerUserId, unowned, waitingState, responsePriority, overdue, threadId, archived, cursor, limit, search, dateFrom, dateTo, signal } = req.query;

      const filters: Parameters<typeof storage.listEmailConversationThreads>[1] = {};

      if (accountId) filters.linkedAccountId = accountId as string;
      if (carrierId) filters.linkedCarrierId = carrierId as string;
      if (threadId) filters.threadId = threadId as string;
      if (unowned === "true") {
        filters.unowned = true;
      } else if (ownerUserId) {
        filters.ownerUserId = ownerUserId as string;
      }
      if (waitingState) filters.waitingState = waitingState as string;
      if (responsePriority) filters.responsePriority = responsePriority as string;
      if (overdue === "true") filters.overdue = true;

      if (archived === "true") {
        filters.archivedOnly = true;
      }

      if (cursor) filters.cursor = cursor as string;
      if (limit) filters.limit = Math.min(parseInt(limit as string, 10) || 50, 100);
      if (search) filters.search = search as string;
      if (dateFrom) filters.dateFrom = dateFrom as string;
      if (dateTo) filters.dateTo = dateTo as string;

      // Optional `team=<userId>` filter: returns threads owned by the given
      // manager + every descendant in their managerId chain. Lets the UI
      // show e.g. "Team Danny" / "Team Sam" without enforcing permissions.
      const team = typeof req.query.team === "string" ? req.query.team.trim() : "";
      if (team) {
        const teamMemberIds = await storage.getTeamMemberIds(team, orgId);
        const allowedOwnerIds = Array.from(new Set([team, ...teamMemberIds]));
        // Also pull in accounts whose salesperson is on the team so unowned
        // threads routed to those accounts still appear under the team view.
        // Without this, teams with auto-synced inbound mail show zero results
        // because auto-sync creates threads without stamping an owner.
        const allCompanies = await storage.getCompanies(orgId);
        const teamAccountIds = allCompanies
          .filter(c => c.salesPersonId && allowedOwnerIds.includes(c.salesPersonId))
          .map(c => c.id);
        // If the caller is also filtering by ownerUserId, intersect with team
        // (owner outside the team -> empty page, otherwise just that owner).
        if (filters.ownerUserId) {
          if (!allowedOwnerIds.includes(filters.ownerUserId)) {
            return res.json({ count: 0, threads: [], nextCursor: null });
          }
        } else {
          filters.ownerUserIdIn = allowedOwnerIds;
          if (teamAccountIds.length > 0) {
            filters.teamAccountIdsIn = teamAccountIds;
          }
        }
      }

      // Signal-based pre-filter: e.g. signal=quote_request narrows the thread set
      // to threads whose messages have a pricing_request OR quote_request signal.
      // Synonyms: "quote_request" and "pricing_request" both map to the
      // pricing/quote intent family.
      const signalParam = typeof signal === "string" ? signal.trim() : "";
      if (signalParam) {
        const intentTypes =
          signalParam === "quote_request" || signalParam === "pricing_request"
            ? ["pricing_request", "quote_request"]
            : [signalParam];
        const matchingThreadRows = await db
          .selectDistinct({ threadId: emailMessages.threadId })
          .from(emailSignals)
          .innerJoin(emailMessages, eq(emailMessages.id, emailSignals.messageId))
          .where(
            and(
              eq(emailMessages.orgId, orgId),
              inArray(emailSignals.intentType, intentTypes),
            ),
          );
        filters.threadIdsIn = matchingThreadRows
          .map(r => r.threadId)
          .filter((id): id is string => !!id);
      }

      const result = await storage.listEmailConversationThreads(orgId, filters);
      const threads = result.threads;

      const ownerIds = [...new Set(threads.map(t => t.ownerUserId).filter(Boolean) as string[])];
      const ownerMap = new Map<string, string>();
      await Promise.all(ownerIds.map(async id => {
        const u = await storage.getUser(id);
        if (u) ownerMap.set(id, u.name);
      }));

      // Enrich each thread with the unique set of intent_types found across its
      // messages so the UI can render badges like "Quote", "Urgent", etc.
      const threadKeys = threads.map(t => t.threadId).filter(Boolean) as string[];
      const signalsByThread = new Map<string, Set<string>>();
      if (threadKeys.length > 0) {
        const sigRows = await db
          .select({
            threadId: emailMessages.threadId,
            intentType: emailSignals.intentType,
          })
          .from(emailSignals)
          .innerJoin(emailMessages, eq(emailMessages.id, emailSignals.messageId))
          .where(
            and(
              eq(emailMessages.orgId, orgId),
              inArray(emailMessages.threadId, threadKeys),
            ),
          );
        for (const row of sigRows) {
          if (!row.threadId || !row.intentType) continue;
          if (!signalsByThread.has(row.threadId)) {
            signalsByThread.set(row.threadId, new Set());
          }
          signalsByThread.get(row.threadId)!.add(row.intentType);
        }
      }

      const enriched = threads.map(t => ({
        ...t,
        ownerName: t.ownerUserId ? (ownerMap.get(t.ownerUserId) ?? null) : null,
        signals: t.threadId && signalsByThread.has(t.threadId)
          ? Array.from(signalsByThread.get(t.threadId)!)
          : [],
      }));

      res.json({ count: result.totalCount, threads: enriched, nextCursor: result.nextCursor });
    } catch (err) {
      console.error("[conversations] GET /conversations error:", err);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  // ── POST /api/internal/conversations/:id/archive ──────────────────────────
  app.post("/api/internal/conversations/:id/archive", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const thread = await storage.getEmailConversationThreadById(req.params.id);
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      if (thread.waitingState !== "resolved") {
        return res.status(400).json({ error: "Only resolved conversations can be archived" });
      }

      const archiveUpdate: Partial<InsertEmailConversationThread> = {
        waitingState: "archived",
        archivedAt: new Date(),
        waitingSinceAt: null,
        overdueAt: null,
      };
      const updated = await storage.updateEmailConversationThread(req.params.id, user.organizationId, archiveUpdate);

      res.json({ thread: updated });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/archive error:", err);
      res.status(500).json({ error: "Failed to archive conversation" });
    }
  });

  // ── POST /api/internal/conversations/:id/owner ───────────────────────────────
  app.post("/api/internal/conversations/:id/owner", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ ownerUserId: z.string().nullable() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      await assignOwner(req.params.id, parsed.data.ownerUserId, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(req.params.id);
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      res.json({ thread });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/owner error:", err);
      res.status(500).json({ error: "Failed to update owner" });
    }
  });

  // ── POST /api/internal/conversations/:id/waiting-state ──────────────────────
  app.post("/api/internal/conversations/:id/waiting-state", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ waitingState: z.enum(["waiting_on_us", "waiting_on_them", "resolved", "archived"]) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      await setWaitingState(req.params.id, parsed.data.waitingState, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(req.params.id);
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      res.json({ thread });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/waiting-state error:", err);
      res.status(500).json({ error: "Failed to update waiting state" });
    }
  });

  // ── GET /api/internal/conversations/:id/messages ────────────────────────────
  app.get("/api/internal/conversations/:id/messages", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // Support an "orphan" lookup by raw thread_id when no conversation
      // record has been materialized yet (drilldowns can surface threads with
      // signals that never produced an email_conversation_threads row).
      let threadIdForMessages: string | null = null;
      const idParam = String(req.params.id);

      if (idParam.startsWith("thread:")) {
        threadIdForMessages = idParam.slice("thread:".length);
        // Task #285: opening an orphan upgrades it to a real conversation row
        // so the rep can immediately assign owner / waiting state / priority.
        // Failure here never blocks message reads — viewing always works.
        try {
          await materializeConversationThreadIfMissing(user.organizationId, threadIdForMessages);
        } catch (matErr) {
          console.error("[conversations] thread materialise error:", matErr);
        }
      } else {
        const thread = await storage.getEmailConversationThreadById(idParam);
        if (thread && thread.orgId === user.organizationId) {
          threadIdForMessages = thread.threadId;
        }
      }

      if (!threadIdForMessages) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const messages = await db.select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.threadId, threadIdForMessages),
            eq(emailMessages.orgId, user.organizationId),
          )
        )
        // Task #435: order by provider sent time so self-heal recoveries
        // (which can land minutes/hours after the true send time) display
        // in the correct chronological position.
        .orderBy(asc(sql`COALESCE(${emailMessages.providerSentAt}, ${emailMessages.createdAt})`));

      res.json({ messages });
    } catch (err) {
      console.error("[conversations] GET /conversations/:id/messages error:", err);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // ── POST /api/internal/conversations/:id/priority ───────────────────────────
  app.post("/api/internal/conversations/:id/priority", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ responsePriority: z.enum(["high", "normal", "low"]) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      await setPriority(req.params.id, parsed.data.responsePriority, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(req.params.id);
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      res.json({ thread });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/priority error:", err);
      res.status(500).json({ error: "Failed to update priority" });
    }
  });

  // ── GET /api/internal/admin/conversations/diagnostic ─────────────────────────
  // Admin-only diagnostic that reports on conversation/email pipeline health.
  // Helps debug "why is my badge empty?" in production.
  app.get("/api/internal/admin/conversations/diagnostic", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const orgId = user.organizationId;
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const mailboxes = await db
        .select({
          id: monitoredMailboxes.id,
          email: monitoredMailboxes.email,
          enabled: monitoredMailboxes.enabled,
          syncStatus: monitoredMailboxes.syncStatus,
          syncError: monitoredMailboxes.syncError,
          lastSyncAt: monitoredMailboxes.lastSyncAt,
          subscriptionExpiresAt: monitoredMailboxes.subscriptionExpiresAt,
          userName: users.name,
          userId: users.id,
        })
        .from(monitoredMailboxes)
        .leftJoin(users, eq(users.id, monitoredMailboxes.userId))
        .where(eq(monitoredMailboxes.orgId, orgId));

      const [inboundCountRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.orgId, orgId),
            eq(emailMessages.direction, "inbound"),
            gte(emailMessages.createdAt, sevenDaysAgo),
          ),
        );

      const [outboundCountRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.orgId, orgId),
            eq(emailMessages.direction, "outbound"),
            gte(emailMessages.createdAt, sevenDaysAgo),
          ),
        );

      const [threadsCreatedRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(emailConversationThreads)
        .where(
          and(
            eq(emailConversationThreads.orgId, orgId),
            gte(emailConversationThreads.createdAt, sevenDaysAgo),
          ),
        );

      const ownerBreakdown = await db
        .select({
          ownerUserId: emailConversationThreads.ownerUserId,
          ownerName: users.name,
          waitingState: emailConversationThreads.waitingState,
          c: sql<number>`count(*)::int`,
        })
        .from(emailConversationThreads)
        .leftJoin(users, eq(users.id, emailConversationThreads.ownerUserId))
        .where(
          and(
            eq(emailConversationThreads.orgId, orgId),
            isNull(emailConversationThreads.archivedAt),
          ),
        )
        .groupBy(emailConversationThreads.ownerUserId, users.name, emailConversationThreads.waitingState)
        .orderBy(desc(sql`count(*)`));

      const recentThreads = await db
        .select({
          id: emailConversationThreads.id,
          threadId: emailConversationThreads.threadId,
          ownerUserId: emailConversationThreads.ownerUserId,
          ownerName: users.name,
          waitingState: emailConversationThreads.waitingState,
          createdAt: emailConversationThreads.createdAt,
          lastIncomingAt: emailConversationThreads.lastIncomingAt,
          archivedAt: emailConversationThreads.archivedAt,
        })
        .from(emailConversationThreads)
        .leftJoin(users, eq(users.id, emailConversationThreads.ownerUserId))
        .where(eq(emailConversationThreads.orgId, orgId))
        .orderBy(desc(emailConversationThreads.createdAt))
        .limit(10);

      res.json({
        currentUser: { id: user.id, name: user.name, organizationId: orgId },
        monitoredMailboxes: mailboxes,
        last7Days: {
          inboundEmails: inboundCountRow?.c ?? 0,
          outboundEmails: outboundCountRow?.c ?? 0,
          threadsCreated: threadsCreatedRow?.c ?? 0,
        },
        activeThreadsByOwner: ownerBreakdown,
        recentThreads,
      });
    } catch (err) {
      console.error("[conversations] GET /admin/conversations/diagnostic error:", err);
      res.status(500).json({ error: "Failed to fetch diagnostic" });
    }
  });

  // ── POST /api/internal/admin/conversations/backfill-missing-threads (Task #285) ──
  // Materialises an email_conversation_threads row for every (org_id, thread_id)
  // that has email_messages but no thread record. Idempotent — re-running it
  // after the initial backfill is a no-op.
  app.post(
    "/api/internal/admin/conversations/backfill-missing-threads",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        if (!["admin", "director", "sales_director"].includes(user.role)) {
          return res.status(403).json({ error: "Admin access required" });
        }

        const scopeAllOrgs = req.body?.allOrgs === true && user.role === "admin";
        const result = await backfillMissingConversationThreads({
          orgId: scopeAllOrgs ? undefined : user.organizationId,
        });
        res.json({ ok: true, scope: scopeAllOrgs ? "all_orgs" : "current_org", ...result });
      } catch (err) {
        console.error("[conversations] POST /admin/conversations/backfill-missing-threads error:", err);
        res.status(500).json({ error: "Failed to run backfill" });
      }
    },
  );

  // ── Reply Capture Audit endpoints (Task #435) ────────────────────────────
  // GET .../capture-audit — recent audit history + current SentItems health
  // POST .../recheck       — on-demand self-heal pass for a single thread
  // POST .../self-heal-sweep — admin-only org-wide sweep
  // Helper: only the thread owner OR a manager (admin / director /
  // sales_director / direct manager of the owner) may view or trigger
  // capture audits — Task #435 access-control requirement.
  const canManageThread = async (
    requester: { id: string; role: string; organizationId: string },
    thread: { ownerUserId: string | null; orgId: string },
  ): Promise<boolean> => {
    if (thread.orgId !== requester.organizationId) return false;
    if (["admin", "director", "sales_director", "logistics_manager"].includes(requester.role)) return true;
    if (thread.ownerUserId && thread.ownerUserId === requester.id) return true;
    if (thread.ownerUserId) {
      const owner = await storage.getUser(thread.ownerUserId);
      if (owner && (owner as { managerId?: string | null }).managerId === requester.id) return true;
    }
    return false;
  };

  app.get(
    "/api/internal/conversations/:id/capture-audit",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const threadIdParam = req.params.id;

        // :id is an Outlook conversationId (used by other GET endpoints
        // such as /messages). Verify the thread is org-scoped.
        const thread = await storage.getEmailConversationThreadByThreadId(user.organizationId, threadIdParam);
        if (!thread) return res.status(404).json({ error: "Thread not found" });
        if (!(await canManageThread(user, thread))) {
          return res.status(403).json({ error: "Only the thread owner or a manager can view the capture audit" });
        }

        const [history, storedMessageIds] = await Promise.all([
          getThreadCaptureAuditHistory(user.organizationId, threadIdParam, 5),
          listThreadStoredProviderMessageIds(user.organizationId, threadIdParam),
        ]);

        let mailboxHealth = null as ReturnType<typeof getMailboxSentItemsHealth> | null;
        if (thread.ownerUserId) {
          const ownerMailboxes = await db.select().from(monitoredMailboxes)
            .where(and(
              eq(monitoredMailboxes.orgId, user.organizationId),
              eq(monitoredMailboxes.userId, thread.ownerUserId),
            ));
          if (ownerMailboxes[0]) mailboxHealth = getMailboxSentItemsHealth(ownerMailboxes[0]);
        }

        res.json({
          ok: true,
          threadId: threadIdParam,
          ownerUserId: thread.ownerUserId,
          waitingState: thread.waitingState,
          mailboxHealth,
          storedMessageCount: storedMessageIds.length,
          // Surface as string[] of provider message IDs only — the UI
          // shows them verbatim so reps can correlate against Outlook.
          storedMessages: storedMessageIds.map(r => r.providerMessageId),
          history,
        });
      } catch (err) {
        console.error("[conversations] GET /capture-audit error:", err);
        res.status(500).json({ error: "Failed to load capture audit" });
      }
    },
  );

  app.post(
    "/api/internal/conversations/:id/recheck",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const threadIdParam = req.params.id;

        const thread = await storage.getEmailConversationThreadByThreadId(user.organizationId, threadIdParam);
        if (!thread) return res.status(404).json({ error: "Thread not found" });
        if (!(await canManageThread(user, thread))) {
          return res.status(403).json({ error: "Only the thread owner or a manager can trigger a recheck" });
        }

        const result = await selfHealConversationThread({
          orgId: user.organizationId,
          threadId: threadIdParam,
          triggeredBy: "manual",
          triggeredByUserId: user.id,
        });

        res.json({
          ok: true,
          recovered: result.audit.messagesPersisted,
          rootCause: result.audit.rootCauseLabel,
          messagesFoundUpstream: result.audit.messagesFoundUpstream,
          mailboxHealth: result.mailboxHealth,
          audit: result.audit,
        });
      } catch (err) {
        console.error("[conversations] POST /recheck error:", err);
        res.status(500).json({ error: err instanceof Error ? err.message : "Recheck failed" });
      }
    },
  );

  app.post(
    "/api/internal/admin/conversations/self-heal-sweep",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        if (!["admin", "director", "sales_director"].includes(user.role)) {
          return res.status(403).json({ error: "Admin access required" });
        }
        const scopeAllOrgs = req.body?.allOrgs === true && user.role === "admin";
        const minStuckMs = typeof req.body?.minStuckMinutes === "number"
          ? Math.max(0, req.body.minStuckMinutes) * 60 * 1000
          : undefined;
        const result = await selfHealStuckThreads({
          orgId: scopeAllOrgs ? undefined : user.organizationId,
          triggeredBy: "manual",
          minStuckMs,
        });
        res.json({ ok: true, scope: scopeAllOrgs ? "all_orgs" : "current_org", ...result });
      } catch (err) {
        console.error("[conversations] POST /admin/self-heal-sweep error:", err);
        res.status(500).json({ error: "Self-heal sweep failed" });
      }
    },
  );
}
