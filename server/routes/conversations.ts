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
import { pStr, qStr, qOptStr } from "../lib/req";
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
  type User,
} from "@shared/schema";
import { requireAuth, getCurrentUser, canSeeRepUser, getVisibleRepUserIds } from "../auth";
import { setWaitingState, setPriority, snoozeThread } from "../services/conversationWaitingStateService";
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
  getCaptureAuditHealthForUsers,
  type CaptureAuditHealthSnapshot,
} from "../services/conversationReplyCaptureService";
import { notifyOnInboxUnhealthy } from "../services/conversationsInboxAlerter";
import {
  recordThreadEvent,
  listThreadEvents,
  type ThreadEventType,
} from "../services/conversationThreadEventsService";
import { getOrGenerateThreadSummary } from "../services/conversationThreadSummaryService";
import {
  getOrComputeThreadSuggestion,
  dismissSuggestion,
  recordSuggestionFeedback,
} from "../services/conversationThreadSuggestionService";
import { getErrorMessage } from "../lib/errors";
import {
  renewUserMailboxSubscriptions,
  renewExpiringSoonSubscriptions,
  renewSingleMailboxSubscription,
} from "../graphSubscriptionService";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — "Stop lying about freshness."
// Computes a source-of-truth `lastEmailAt` per thread by reading
// MAX(email_messages.provider_sent_at) per thread_id in a single batched
// query. The Conversations UI MUST consume this (or lastIncomingAt /
// lastOutgoingAt) for every freshness label — never `updatedAt`, which is
// bumped by background workers (archive sweep, denormalization sweeps,
// signal rewrites) and lands days off the actual conversation activity.
//
// The denormalized `lastIncomingAt` / `lastOutgoingAt` columns on the
// thread row are a defensive fallback for threads where the message-row
// query returns nothing (extremely rare; the runMigrations backfill keeps
// them in sync). Cost is one batched aggregate per page (≤100 threads).
// ─────────────────────────────────────────────────────────────────────────────
async function computeLastEmailAtMap(
  orgId: string,
  threads: Array<{ threadId: string | null; lastIncomingAt: Date | null; lastOutgoingAt: Date | null }>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(threads.map(t => t.threadId).filter((id): id is string => !!id))];
  if (ids.length === 0) return out;
  try {
    const rows = await db
      .select({
        threadId: emailMessages.threadId,
        maxSent: sql<Date | null>`MAX(${emailMessages.providerSentAt})`,
      })
      .from(emailMessages)
      .where(and(eq(emailMessages.orgId, orgId), inArray(emailMessages.threadId, ids)))
      .groupBy(emailMessages.threadId);
    for (const r of rows) {
      if (r.threadId && r.maxSent) {
        out.set(r.threadId, new Date(r.maxSent).toISOString());
      }
    }
  } catch (err) {
    // A failure here must not 500 the inbox — just leave lastEmailAt null
    // for affected rows and let the UI fall back to lastIncomingAt /
    // lastOutgoingAt (still real email events, just less complete).
    console.error("[conversations] computeLastEmailAtMap failed:", err);
  }
  // Defensive fallback for threads with no email_messages.provider_sent_at
  // row — derive from the denormalized columns so the row UI still shows
  // *something* anchored to a real email event.
  for (const t of threads) {
    if (!t.threadId || out.has(t.threadId)) continue;
    const inc = t.lastIncomingAt ? new Date(t.lastIncomingAt).getTime() : 0;
    const outgoing = t.lastOutgoingAt ? new Date(t.lastOutgoingAt).getTime() : 0;
    const max = Math.max(inc, outgoing);
    out.set(t.threadId, max > 0 ? new Date(max).toISOString() : null);
  }
  return out;
}

export function registerConversationsRoutes(app: Express): void {

  // ── GET /api/internal/conversations/my-count ─────────────────────────────────
  app.get("/api/internal/conversations/my-count", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // Honour the audience toggle so the sidebar count matches what the
      // rep is currently viewing (Customers vs Carriers vs both).
      const rawAudience = qStr(req.query.audience);
      const audience: "customers" | "carriers" | undefined =
        rawAudience === "customers" ? "customers" : rawAudience === "carriers" ? "carriers" : undefined;

      const result = await storage.listEmailConversationThreads(user.organizationId, {
        ownerUserId: user.id,
        waitingState: "waiting_on_us",
        limit: 1,
        ...(audience ? { audience } : {}),
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

      // Phase 1 — surface the source-of-truth email-activity timestamp so
      // the dashboard portlet stops showing stale "Updated" labels.
      const lastEmailAtMap = await computeLastEmailAtMap(user.organizationId, threads);

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
        lastIncomingAt: t.lastIncomingAt,
        lastOutgoingAt: t.lastOutgoingAt,
        lastEmailAt: t.threadId ? (lastEmailAtMap.get(t.threadId) ?? null) : null,
        updatedAt: t.updatedAt,
      }));

      const now = new Date();
      const recencyTs = (x: { lastEmailAt: string | null; lastIncomingAt: Date | null; lastOutgoingAt: Date | null; updatedAt: Date }): number => {
        const ts = x.lastEmailAt ?? x.lastIncomingAt ?? x.lastOutgoingAt ?? x.updatedAt;
        return ts ? new Date(ts).getTime() : 0;
      };
      enriched.sort((a, b) => {
        const aOverdue = !!(a.overdueAt && a.overdueAt <= now);
        const bOverdue = !!(b.overdueAt && b.overdueAt <= now);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        if (a.waitingSinceAt && b.waitingSinceAt) {
          return new Date(a.waitingSinceAt).getTime() - new Date(b.waitingSinceAt).getTime();
        }
        // Phase 1 — sort by REAL email activity, not row-touched-at.
        return recencyTs(b) - recencyTs(a);
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
      const { accountId, carrierId, ownerUserId, unowned, waitingState, responsePriority, overdue, threadId, archived, snoozed, cursor, limit, search, dateFrom, dateTo, signal, sort, audience } = req.query;

      const filters: Parameters<typeof storage.listEmailConversationThreads>[1] = {};

      if (accountId) filters.linkedAccountId = accountId as string;
      if (carrierId) filters.linkedCarrierId = carrierId as string;
      // Audience toggle (customers / carriers / both). Anything other than
      // the two known values is ignored so a typo or stale link doesn't
      // accidentally hide every thread in the inbox.
      if (audience === "customers" || audience === "carriers") {
        filters.audience = audience;
      }
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
      // Task #533: snoozed bucket. snoozed=true → only currently-snoozed
      // threads (the new "Snoozed" sidebar bucket).
      if (snoozed === "true") {
        filters.snoozedOnly = true;
      }

      if (cursor) filters.cursor = cursor as string;
      if (limit) filters.limit = Math.min(parseInt(limit as string, 10) || 50, 100);
      if (search) filters.search = search as string;
      if (dateFrom) filters.dateFrom = dateFrom as string;
      if (dateTo) filters.dateTo = dateTo as string;
      if (sort === "recency" || sort === "priority") filters.sort = sort;

      // Optional `team=<userId>` filter: returns threads owned by the given
      // manager + every descendant in their managerId chain. Used by the UI
      // to show e.g. "Team Danny" / "Team Sam".
      // Task #525: a Director used to be able to pivot to *any* manager's
      // team via this query (e.g. `?team=<other_director_id>`) and see the
      // other team's conversations. Enforce that the requested team's root
      // is inside the caller's reporting tree (admin / sales_director keep
      // org-wide access; the caller can always look at their own team).
      const team = qStr(req.query.team).trim();
      if (team) {
        if (
          user.role !== "admin"
          && user.role !== "sales_director"
          && team !== user.id
          && !(await canSeeRepUser(user, team))
        ) {
          return res.status(403).json({ error: "Team is outside your reporting tree" });
        }
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
      } else if (user.role !== "admin" && user.role !== "sales_director") {
        // Default-scope conversations for every non-manager role to the
        // caller's reporting tree (themselves + every direct/indirect
        // report). Without this, a regular sales rep loading the inbox
        // sees every email thread in the organization — including emails
        // that belong to other reps and other reps' accounts.
        //
        // Admin and Sales Director keep org-wide visibility for oversight
        // (matches the Task #525 visibility model). Director, NAM, sales,
        // logistics_manager, and any other role get scoped to their own
        // reporting tree via `getVisibleRepUserIds`. For an individual
        // contributor with no reports, that tree is just `[user.id]`.
        const visibleIds = await getVisibleRepUserIds(user);
        // `getVisibleRepUserIds` returns null only for admin (excluded
        // above), so this is always a non-null array of user ids.
        const allowedOwnerIds = visibleIds ?? [user.id];
        if (filters.ownerUserId) {
          if (!allowedOwnerIds.includes(filters.ownerUserId)) {
            return res.json({ count: 0, threads: [], nextCursor: null });
          }
        } else {
          // Also surface unowned threads on accounts whose salesperson is
          // inside the visible set — auto-synced inbound mail often lands
          // without an owner stamped, and the rep needs to see it.
          const allCompanies = await storage.getCompanies(orgId);
          const teamAccountIds = allCompanies
            .filter(c => c.salesPersonId && allowedOwnerIds.includes(c.salesPersonId))
            .map(c => c.id);
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

      // Task #575: every per-thread enrichment below (owner/account/carrier
      // names, signal badges, per-user read state) is best-effort. A failure
      // in any one of them used to bubble up and 500 the whole endpoint,
      // which made the entire inbox UI go red ("Couldn't load conversations.")
      // even though the core thread list was fine. Each helper now isolates
      // its own errors: it logs the failure and returns an empty map so the
      // affected fields come back as null/[], and the rest of the page still
      // renders.

      const ownerIds = [...new Set(threads.map(t => t.ownerUserId).filter(Boolean) as string[])];
      const ownerMap = new Map<string, string>();
      try {
        await Promise.all(ownerIds.map(async id => {
          try {
            const u = await storage.getUser(id);
            if (u) ownerMap.set(id, u.name);
          } catch (innerErr) {
            // One bad user lookup shouldn't poison the whole batch — that
            // user just shows up unowned in the UI.
            console.error("[conversations] owner lookup failed for", id, innerErr);
          }
        }));
      } catch (err) {
        console.error("[conversations] owner enrichment failed:", err);
      }

      // Task #535: enrich each thread with the linked account/carrier name so
      // the client can group rows by account or carrier without doing a
      // round-trip per row. Without these names a "Group by Account" list
      // would only show opaque UUIDs.
      const accountIds = [...new Set(threads.map(t => t.linkedAccountId).filter(Boolean) as string[])];
      const carrierIds = [...new Set(threads.map(t => t.linkedCarrierId).filter(Boolean) as string[])];
      const accountNameMap = new Map<string, string>();
      const carrierNameMap = new Map<string, string>();
      if (accountIds.length > 0) {
        try {
          const companies = await storage.getCompaniesByIds(accountIds, orgId);
          for (const c of companies) accountNameMap.set(c.id, c.name);
        } catch (err) {
          console.error("[conversations] account name enrichment failed:", err);
        }
      }
      if (carrierIds.length > 0) {
        try {
          const carriers = await storage.getCarriersByIds(carrierIds, orgId);
          for (const c of carriers) carrierNameMap.set(c.id, c.name);
        } catch (err) {
          console.error("[conversations] carrier name enrichment failed:", err);
        }
      }

      // Enrich each thread with the unique set of intent_types found across its
      // messages so the UI can render badges like "Quote", "Urgent", etc.
      const threadKeys = threads.map(t => t.threadId).filter(Boolean) as string[];
      const signalsByThread = new Map<string, Set<string>>();
      if (threadKeys.length > 0) {
        try {
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
        } catch (err) {
          // Missing column / missing table on email_signals shouldn't take
          // out the whole inbox — the UI will just render rows without
          // intent badges.
          console.error("[conversations] signal enrichment failed:", err);
        }
      }

      // Task #532: enrich each thread with the current user's read state so
      // the UI can show unread vs read styling consistently across sessions.
      // A thread is unread when it has an inbound message newer than the
      // user's lastReadAt (or the user has never marked it read).
      const threadIdStrings = threads.map(t => t.threadId).filter(Boolean) as string[];
      let readStates: Map<string, Date | null> = new Map();
      try {
        readStates = await storage.getEmailConversationReadStates(user.id, threadIdStrings);
      } catch (err) {
        // If the read-state table is missing/broken, default everyone to
        // "never read" so unread styling still shows for incoming mail —
        // worst case we over-highlight, but the inbox still loads.
        console.error("[conversations] read-state enrichment failed:", err);
      }

      // Phase 1 — "Stop lying about freshness."
      // Compute the real email-activity timestamp (MAX provider_sent_at
      // per thread) once for the whole page so the row UI can show
      // "Customer replied <time>" / "You replied <time>" anchored to
      // actual emails instead of `thread.updatedAt` (which is bumped by
      // background workers and is routinely days off).
      const lastEmailAtMap = await computeLastEmailAtMap(orgId, threads);

      const enriched = threads.map(t => {
        const lastReadAt = t.threadId ? readStates.get(t.threadId) ?? null : null;
        const lastIncoming = t.lastIncomingAt ? new Date(t.lastIncomingAt) : null;
        const unread = !!lastIncoming && (!lastReadAt || lastReadAt < lastIncoming);
        return {
          ...t,
          ownerName: t.ownerUserId ? (ownerMap.get(t.ownerUserId) ?? null) : null,
          accountName: t.linkedAccountId ? (accountNameMap.get(t.linkedAccountId) ?? null) : null,
          carrierName: t.linkedCarrierId ? (carrierNameMap.get(t.linkedCarrierId) ?? null) : null,
          signals: t.threadId && signalsByThread.has(t.threadId)
            ? Array.from(signalsByThread.get(t.threadId)!)
            : [],
          lastReadAt: lastReadAt ? lastReadAt.toISOString() : null,
          // Source-of-truth freshness — see computeLastEmailAtMap above.
          lastEmailAt: t.threadId ? (lastEmailAtMap.get(t.threadId) ?? null) : null,
          unread,
        };
      });

      res.json({ count: result.totalCount, threads: enriched, nextCursor: result.nextCursor });
    } catch (err) {
      console.error("[conversations] GET /conversations error:", err);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  // Returns true when the caller may read the thread or act on it. Used by
  // the per-thread GET/POST endpoints below so a rep can't bypass the list
  // scoping by guessing a conversation UUID. Mirrors the visibility model
  // applied to the inbox listing:
  //   - admin / sales_director: org-wide oversight
  //   - thread owner: always
  //   - manager whose reporting tree contains the owner: always
  //   - unowned thread on an account whose salesperson is in the caller's
  //     reporting tree (covers auto-synced inbound that hasn't been claimed)
  const canAccessThread = async (
    requester: User,
    thread: { ownerUserId: string | null; orgId: string; linkedAccountId: string | null },
  ): Promise<boolean> => {
    if (thread.orgId !== requester.organizationId) return false;
    if (requester.role === "admin" || requester.role === "sales_director") return true;
    if (thread.ownerUserId && thread.ownerUserId === requester.id) return true;
    if (thread.ownerUserId && (await canSeeRepUser(requester, thread.ownerUserId))) return true;
    if (!thread.ownerUserId && thread.linkedAccountId) {
      const company = await storage.getCompany(thread.linkedAccountId);
      if (company?.salesPersonId && (await canSeeRepUser(requester, company.salesPersonId))) {
        return true;
      }
    }
    return false;
  };

  // ── POST /api/internal/conversations/:id/archive ──────────────────────────
  app.post("/api/internal/conversations/:id/archive", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const thread = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!(await canAccessThread(user, thread))) {
        return res.status(403).json({ error: "You do not have access to this conversation" });
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
      const updated = await storage.updateEmailConversationThread(pStr(req.params.id), user.organizationId, archiveUpdate);

      // Audit: record archive on the thread timeline (Task #534).
      await recordThreadEvent({
        orgId: user.organizationId,
        threadId: thread.threadId,
        eventType: "archived",
        description: `${user.name || user.username} archived this conversation`,
        actorUserId: user.id,
        actorName: user.name || user.username || null,
      });

      res.json({ thread: updated });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/archive error:", err);
      res.status(500).json({ error: "Failed to archive conversation" });
    }
  });

  // ── POST /api/internal/conversations/:id/snooze (Task #533) ────────────────
  // Snooze a thread until a specific wake time. Cleared by /unsnooze, by the
  // wake scheduler when snoozed_until passes, or by an inbound message
  // (handled in conversationWaitingStateService.applyMessageToThread —
  // archived-thread reopen logic; snooze waking on inbound is intentionally
  // left to the cron sweep so notifications fire reliably).
  app.post("/api/internal/conversations/:id/snooze", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ snoozedUntil: z.string().datetime() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const until = new Date(parsed.data.snoozedUntil);
      if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
        return res.status(400).json({ error: "snoozedUntil must be a future timestamp" });
      }

      const thread = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!(await canAccessThread(user, thread))) {
        return res.status(403).json({ error: "You do not have access to this conversation" });
      }
      if (thread.waitingState === "archived") {
        return res.status(400).json({ error: "Archived conversations cannot be snoozed" });
      }

      await snoozeThread(pStr(req.params.id), until, user.id, user.organizationId, storage);
      const updated = await storage.getEmailConversationThreadById(pStr(req.params.id));
      res.json({ thread: updated });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/snooze error:", err);
      res.status(500).json({ error: "Failed to snooze conversation" });
    }
  });

  // ── POST /api/internal/conversations/:id/unsnooze (Task #533) ──────────────
  // Wake a snoozed thread back to its prior state immediately. No-op for
  // threads that aren't currently snoozed.
  app.post("/api/internal/conversations/:id/unsnooze", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const thread = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!(await canAccessThread(user, thread))) {
        return res.status(403).json({ error: "You do not have access to this conversation" });
      }

      const { wakeSnoozedThread } = await import("../services/conversationWaitingStateService");
      await wakeSnoozedThread(pStr(req.params.id), user.organizationId, storage);
      const updated = await storage.getEmailConversationThreadById(pStr(req.params.id));
      res.json({ thread: updated });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/unsnooze error:", err);
      res.status(500).json({ error: "Failed to unsnooze conversation" });
    }
  });

  // ── POST /api/internal/conversations/bulk (Task #533) ──────────────────────
  // Apply a single action to many threads in one request and return per-id
  // success/failure so the client can surface granular feedback. Each thread
  // goes through the same access check the per-thread endpoints use, so a
  // rep can't bulk-mutate threads outside their visible reporting tree.
  //
  // Supported actions: resolve, reopen, archive, assign, snooze, unsnooze.
  app.post("/api/internal/conversations/bulk", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({
        action: z.enum(["resolve", "reopen", "archive", "assign", "snooze", "unsnooze"]),
        threadIds: z.array(z.string().min(1)).min(1).max(200),
        ownerUserId: z.string().nullable().optional(),
        snoozedUntil: z.string().datetime().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { action, threadIds } = parsed.data;

      // Validate action-specific params up front so a malformed call fails
      // fast instead of half-applying.
      let snoozeUntilDate: Date | null = null;
      if (action === "snooze") {
        if (!parsed.data.snoozedUntil) {
          return res.status(400).json({ error: "snoozedUntil is required for snooze" });
        }
        snoozeUntilDate = new Date(parsed.data.snoozedUntil);
        if (Number.isNaN(snoozeUntilDate.getTime()) || snoozeUntilDate.getTime() <= Date.now()) {
          return res.status(400).json({ error: "snoozedUntil must be a future timestamp" });
        }
      }
      if (action === "assign" && parsed.data.ownerUserId === undefined) {
        return res.status(400).json({ error: "ownerUserId is required for assign (use null to unassign)" });
      }

      const { wakeSnoozedThread } = await import("../services/conversationWaitingStateService");
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];

      // Process sequentially so a single failing thread doesn't break
      // updates to the others. The bulk size cap (200) keeps this safe.
      for (const id of threadIds) {
        try {
          const thread = await storage.getEmailConversationThreadById(id);
          if (!thread || thread.orgId !== user.organizationId) {
            results.push({ id, ok: false, error: "Conversation not found" });
            continue;
          }
          if (!(await canAccessThread(user, thread))) {
            results.push({ id, ok: false, error: "Access denied" });
            continue;
          }

          switch (action) {
            case "resolve":
              await setWaitingState(id, "resolved", user.organizationId, storage);
              break;
            case "reopen":
              await setWaitingState(id, "waiting_on_us", user.organizationId, storage);
              break;
            case "archive": {
              if (thread.waitingState !== "resolved") {
                // Mirror the per-thread archive endpoint: archive only after
                // the thread has been resolved. The bulk caller can chain
                // resolve + archive if they want both.
                results.push({ id, ok: false, error: "Only resolved conversations can be archived" });
                continue;
              }
              const archiveUpdate: Partial<InsertEmailConversationThread> = {
                waitingState: "archived",
                archivedAt: new Date(),
                waitingSinceAt: null,
                overdueAt: null,
              };
              await storage.updateEmailConversationThread(id, user.organizationId, archiveUpdate);
              break;
            }
            case "assign":
              await assignOwner(id, parsed.data.ownerUserId ?? null, user.organizationId, storage);
              break;
            case "snooze":
              if (thread.waitingState === "archived") {
                results.push({ id, ok: false, error: "Archived conversations cannot be snoozed" });
                continue;
              }
              await snoozeThread(id, snoozeUntilDate!, user.id, user.organizationId, storage);
              break;
            case "unsnooze":
              await wakeSnoozedThread(id, user.organizationId, storage);
              break;
          }
          results.push({ id, ok: true });
        } catch (err) {
          results.push({
            id,
            ok: false,
            error: getErrorMessage(err),
          });
        }
      }

      const succeeded = results.filter(r => r.ok).length;
      res.json({ action, total: results.length, succeeded, failed: results.length - succeeded, results });
    } catch (err) {
      console.error("[conversations] POST /conversations/bulk error:", err);
      res.status(500).json({ error: "Bulk action failed" });
    }
  });

  // ── Saved Views (Task #533) ────────────────────────────────────────────────
  // Per-user saved combinations of (bucket + filters). All endpoints are
  // implicitly scoped to the requesting user — no view sharing in v1.

  app.get("/api/internal/conversations/saved-views", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const views = await storage.listConversationSavedViews(user.id);
      res.json({ views });
    } catch (err) {
      console.error("[conversations] GET /conversations/saved-views error:", err);
      res.status(500).json({ error: "Failed to fetch saved views" });
    }
  });

  app.post("/api/internal/conversations/saved-views", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({
        name: z.string().trim().min(1).max(80),
        bucket: z.string().trim().min(1).max(40),
        filters: z.record(z.any()).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const view = await storage.createConversationSavedView({
        orgId: user.organizationId,
        userId: user.id,
        name: parsed.data.name,
        bucket: parsed.data.bucket,
        filters: parsed.data.filters ?? {},
      });
      res.status(201).json({ view });
    } catch (err) {
      console.error("[conversations] POST /conversations/saved-views error:", err);
      res.status(500).json({ error: "Failed to create saved view" });
    }
  });

  app.patch("/api/internal/conversations/saved-views/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({
        name: z.string().trim().min(1).max(80).optional(),
        bucket: z.string().trim().min(1).max(40).optional(),
        filters: z.record(z.any()).optional(),
        sortOrder: z.number().int().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const view = await storage.updateConversationSavedView(pStr(req.params.id), user.id, parsed.data);
      if (!view) return res.status(404).json({ error: "Saved view not found" });
      res.json({ view });
    } catch (err) {
      console.error("[conversations] PATCH /conversations/saved-views/:id error:", err);
      res.status(500).json({ error: "Failed to update saved view" });
    }
  });

  app.delete("/api/internal/conversations/saved-views/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const ok = await storage.deleteConversationSavedView(pStr(req.params.id), user.id);
      if (!ok) return res.status(404).json({ error: "Saved view not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[conversations] DELETE /conversations/saved-views/:id error:", err);
      res.status(500).json({ error: "Failed to delete saved view" });
    }
  });

  app.post("/api/internal/conversations/saved-views/reorder", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({ orderedIds: z.array(z.string().min(1)).min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      await storage.reorderConversationSavedViews(user.id, parsed.data.orderedIds);
      const views = await storage.listConversationSavedViews(user.id);
      res.json({ views });
    } catch (err) {
      console.error("[conversations] POST /conversations/saved-views/reorder error:", err);
      res.status(500).json({ error: "Failed to reorder saved views" });
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

      // Check access on the existing thread BEFORE the assignment so a rep
      // can't reassign threads outside their visible set (and can't probe
      // for thread existence by issuing reassign requests).
      const existing = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!(await canAccessThread(user, existing))) {
        return res.status(403).json({ error: "You do not have access to this conversation" });
      }

      const previousOwnerId = existing.ownerUserId;
      await assignOwner(pStr(req.params.id), parsed.data.ownerUserId, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Audit: assigned / reassigned / unassigned (Task #534). Look up the
      // new owner's display name once so the timeline survives user deletes.
      try {
        const newOwnerId = parsed.data.ownerUserId;
        let eventType: ThreadEventType;
        let description: string;
        if (!newOwnerId) {
          eventType = "unassigned";
          description = `${user.name || user.username} cleared the owner`;
        } else {
          const [target] = await db.select({ name: users.name, username: users.username })
            .from(users).where(eq(users.id, newOwnerId)).limit(1);
          const targetName = target?.name || target?.username || "(unknown)";
          if (previousOwnerId && previousOwnerId !== newOwnerId) {
            eventType = "reassigned";
            description = `${user.name || user.username} reassigned to ${targetName}`;
          } else {
            eventType = "assigned";
            description = newOwnerId === user.id
              ? `${user.name || user.username} claimed this conversation`
              : `${user.name || user.username} assigned ${targetName}`;
          }
        }
        await recordThreadEvent({
          orgId: user.organizationId,
          threadId: thread.threadId,
          eventType,
          description,
          actorUserId: user.id,
          actorName: user.name || user.username || null,
          details: { previousOwnerId, newOwnerId: parsed.data.ownerUserId },
        });
      } catch (auditErr) {
        console.error("[conversations] owner audit error:", auditErr);
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

      const existing = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!(await canAccessThread(user, existing))) {
        return res.status(403).json({ error: "You do not have access to this conversation" });
      }

      const previousState = existing.waitingState;
      await setWaitingState(pStr(req.params.id), parsed.data.waitingState, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Audit: emit semantic state-change events (Task #534). Only log
      // transitions that actually changed the state; idempotent re-saves
      // shouldn't pollute the timeline.
      if (previousState !== parsed.data.waitingState) {
        try {
          let eventType: ThreadEventType | null = null;
          let description = "";
          const actor = user.name || user.username || "";
          if (parsed.data.waitingState === "resolved") {
            eventType = "resolved";
            description = `${actor} marked this conversation resolved`;
          } else if (parsed.data.waitingState === "archived") {
            eventType = "archived";
            description = `${actor} archived this conversation`;
          } else if (previousState === "resolved" || previousState === "archived") {
            eventType = previousState === "archived" ? "unarchived" : "reopened";
            description = `${actor} reopened this conversation`;
          }
          if (eventType) {
            await recordThreadEvent({
              orgId: user.organizationId,
              threadId: thread.threadId,
              eventType,
              description,
              actorUserId: user.id,
              actorName: user.name || user.username || null,
              details: { previousState, newState: parsed.data.waitingState },
            });
          }
        } catch (auditErr) {
          console.error("[conversations] waiting-state audit error:", auditErr);
        }
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
      const idParam = pStr(req.params.id);

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
      } else if (idParam.startsWith("message:")) {
        // Task #809: resolve by email_messages row id so callers that only
        // know the source message id (Customer Quotes drawer / flip context
        // payloads) can open the surrounding thread without having to chase
        // the providerThreadId on the client first.
        const msgId = idParam.slice("message:".length);
        if (msgId) {
          const [msg] = await db.select()
            .from(emailMessages)
            .where(and(
              eq(emailMessages.id, msgId),
              eq(emailMessages.orgId, user.organizationId),
            ))
            .limit(1);
          if (msg?.threadId) {
            threadIdForMessages = msg.threadId;
            try {
              await materializeConversationThreadIfMissing(user.organizationId, msg.threadId);
            } catch (matErr) {
              console.error("[conversations] thread materialise error:", matErr);
            }
          } else if (msg) {
            // Standalone message with no thread row — return just this
            // single message so the modal can still render the body the
            // rep clicked through to. Auth is already enforced via the
            // org-scoped lookup above (we'd never reach here for another
            // tenant's message).
            return res.json({ messages: [msg] });
          }
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

      // Authorize against the conversation thread row (the listing handler
      // scopes by reporting tree; without this gate, a rep could bypass the
      // list scoping by guessing or sharing a thread UUID and reading the
      // full email body for any thread in their org). Look up the thread by
      // its provider threadId so the orphan-materialise path also gets
      // checked. If no thread row exists yet (e.g. materialise failed and
      // the thread is truly empty), fail closed.
      const threadRow = await storage.getEmailConversationThreadByThreadId(
        user.organizationId,
        threadIdForMessages,
      );
      if (!threadRow) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!(await canAccessThread(user, threadRow))) {
        return res.status(403).json({ error: "You do not have access to this conversation" });
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

  // ── Resolve & authorize a thread reference for read/unread (Task #532) ───
  // Both endpoints accept either a real thread record id OR a synthetic
  // "thread:<outlookConversationId>" key (parity with the messages endpoint
  // for orphan threads — incoming messages whose thread row hasn't been
  // backfilled yet). We:
  //   1. Try to resolve to a real thread row first; if found, run the same
  //      `canAccessThread` check as the other thread mutations so a rep
  //      can't flip read state on threads outside their visible set or
  //      probe for thread existence.
  //   2. For the orphan "thread:<id>" form, require that the org owns at
  //      least one persisted email_message in that conversation BEFORE
  //      writing read state. This prevents a tenant from creating read
  //      markers against arbitrary conversation IDs they don't own.
  const resolveAndAuthorizeReadTarget = async (
    user: User,
    idParam: string,
  ): Promise<
    | { ok: true; conversationId: string }
    | { ok: false; status: number; error: string }
  > => {
    let conversationId: string | null = null;

    if (idParam.startsWith("thread:")) {
      conversationId = idParam.slice("thread:".length) || null;
      if (!conversationId) {
        return { ok: false, status: 400, error: "Invalid thread id" };
      }
      // Materialise an orphan thread row before authorising so the standard
      // canAccessThread check has something to inspect (parity with the
      // GET /messages handler). Failures here never block — we still
      // authorise against whatever thread row actually exists.
      try {
        await materializeConversationThreadIfMissing(user.organizationId, conversationId);
      } catch (matErr) {
        console.error("[conversations] read-state thread materialise error:", matErr);
      }
    } else {
      const thread = await storage.getEmailConversationThreadById(idParam);
      if (!thread || thread.orgId !== user.organizationId) {
        return { ok: false, status: 404, error: "Conversation not found" };
      }
      conversationId = thread.threadId;
    }

    // Resolve the org-scoped thread row by its provider conversation id and
    // run the same access gate every other thread mutation uses. Fail closed
    // when no thread row exists for this org so a tenant can't write read
    // markers for arbitrary conversation ids they don't own.
    const threadRow = await storage.getEmailConversationThreadByThreadId(
      user.organizationId,
      conversationId,
    );
    if (!threadRow) {
      return { ok: false, status: 404, error: "Conversation not found" };
    }
    if (!(await canAccessThread(user, threadRow))) {
      return {
        ok: false,
        status: 403,
        error: "You do not have access to this conversation",
      };
    }
    return { ok: true, conversationId };
  };

  // ── POST /api/internal/conversations/:id/read (Task #532) ──────────────────
  app.post("/api/internal/conversations/:id/read", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const resolved = await resolveAndAuthorizeReadTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      await storage.markEmailConversationThreadRead(user.organizationId, user.id, resolved.conversationId);
      res.json({ ok: true, threadId: resolved.conversationId, lastReadAt: new Date().toISOString() });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/read error:", err);
      res.status(500).json({ error: "Failed to mark thread read" });
    }
  });

  // ── POST /api/internal/conversations/:id/unread (Task #532) ────────────────
  app.post("/api/internal/conversations/:id/unread", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const resolved = await resolveAndAuthorizeReadTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      await storage.markEmailConversationThreadUnread(user.organizationId, user.id, resolved.conversationId);
      res.json({ ok: true, threadId: resolved.conversationId });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/unread error:", err);
      res.status(500).json({ error: "Failed to mark thread unread" });
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

      const existing = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (!(await canAccessThread(user, existing))) {
        return res.status(403).json({ error: "You do not have access to this conversation" });
      }

      const previousPriority = existing.responsePriority;
      await setPriority(pStr(req.params.id), parsed.data.responsePriority, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(pStr(req.params.id));
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Audit: priority change (Task #534). Skip no-op writes.
      if (previousPriority !== parsed.data.responsePriority) {
        await recordThreadEvent({
          orgId: user.organizationId,
          threadId: thread.threadId,
          eventType: "priority_changed",
          description: `${user.name || user.username} changed priority to ${parsed.data.responsePriority}`,
          actorUserId: user.id,
          actorName: user.name || user.username || null,
          details: { previousPriority, newPriority: parsed.data.responsePriority },
        });
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
        const threadIdParam = pStr(req.params.id);

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
        const threadIdParam = pStr(req.params.id);

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
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // ── Conversations-page capture audit status pill (Task #536) ─────────────
  // GET .../capture-audit-health   — aggregated status pill snapshot
  // POST .../capture-audit-health/run-now — manual sweep across visible threads
  //
  // Scope mirrors the Conversations list visibility model:
  //   - admin / sales_director: org-wide
  //   - everyone else: their reporting tree (`getVisibleRepUserIds`)
  //
  // The pill polls this endpoint quietly so reps see "All synced ✓" /
  // "N pending recovery" / "Webhook unhealthy" without refreshing.
  app.get(
    "/api/internal/conversations/capture-audit-health",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const visibleUserIds =
          user.role === "admin" || user.role === "sales_director"
            ? null
            : (await getVisibleRepUserIds(user)) ?? [user.id];

        const snapshot = await getCaptureAuditHealthForUsers({
          orgId: user.organizationId,
          visibleUserIds,
        });

        // Enrich affected threads with account name + owner name so the
        // panel's list is rep-friendly (no opaque thread IDs only). Cheap
        // because the list is capped at 25.
        const enrichedAffected = await Promise.all(
          snapshot.affectedThreads.map(async a => {
            const thread = await storage.getEmailConversationThreadByThreadId(
              user.organizationId,
              a.threadId,
            );
            let accountName: string | null = null;
            let ownerName: string | null = null;
            let recordId: string | null = null;
            if (thread) {
              recordId = thread.id;
              if (thread.linkedAccountId) {
                const company = await storage.getCompany(thread.linkedAccountId);
                accountName = company?.name ?? null;
              }
              if (thread.ownerUserId) {
                const owner = await storage.getUser(thread.ownerUserId);
                ownerName = owner?.name ?? null;
              }
            }
            return { ...a, accountName, ownerName, recordId };
          }),
        );

        res.json({
          ok: true,
          ...snapshot,
          affectedThreads: enrichedAffected,
        } satisfies { ok: boolean } & CaptureAuditHealthSnapshot & {
          affectedThreads: Array<typeof enrichedAffected[number]>;
        });

        // Fire-and-forget alert hook. The previous "Webhook unhealthy"
        // recurrence hid for five iterations because nothing alerted admins
        // — only the on-page pill changed color. notifyOnInboxUnhealthy
        // throttles to once per org per 24h and no-ops when status !==
        // "unhealthy", so this is safe to call on every poll. Detached
        // intentionally (`void`) — alerting must not block the pill response.
        //
        // Gated on user.role === "admin" so non-admin pill polls (the same
        // endpoint powers the per-rep inbox badge) cannot drive alerter
        // traffic. Admins are the only audience for the resulting in-app
        // notification + email; restricting the trigger keeps work off the
        // critical path for regular reps and removes any opportunity for a
        // curious rep to spam the throttle.
        if (snapshot.status === "unhealthy" && user.role === "admin") {
          const firstUnhealthy = snapshot.mailboxes.find(
            m => m.sentItemsHealth === "expired" || m.sentItemsHealth === "missing",
          );
          void notifyOnInboxUnhealthy({
            organizationId: user.organizationId,
            status: snapshot.status,
            webhookFailureCount: snapshot.webhookFailureCount,
            pendingRecoveryThreadCount: snapshot.pendingRecoveryThreadCount,
            totalMailboxes: snapshot.scope.mailboxes,
            detail: firstUnhealthy?.reason ?? null,
          }).catch(err => {
            console.warn("[conversations] inbox-unhealthy alert dispatch failed:", getErrorMessage(err));
          });
        }
      } catch (err) {
        console.error("[conversations] GET /capture-audit-health error:", err);
        res.status(500).json({ error: "Failed to load capture audit health" });
      }
    },
  );

  app.post(
    "/api/internal/conversations/capture-audit-health/run-now",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        // Reuse the same scoping rules as the GET so a rep can never trigger
        // a self-heal sweep against threads outside their reporting tree.
        const visibleUserIds =
          user.role === "admin" || user.role === "sales_director"
            ? null
            : (await getVisibleRepUserIds(user)) ?? [user.id];

        const snapshot = await getCaptureAuditHealthForUsers({
          orgId: user.organizationId,
          visibleUserIds,
          // Run-now should bias toward "anything we currently flag" rather
          // than only 24h-old issues — widen the lookback so the panel and
          // the sweep agree on what's affected.
          lookbackMs: 7 * 24 * 60 * 60 * 1000,
          affectedThreadsLimit: 50,
        });

        let recovered = 0;
        let scanned = 0;
        let errors = 0;
        for (const a of snapshot.affectedThreads) {
          scanned++;
          try {
            const r = await selfHealConversationThread({
              orgId: user.organizationId,
              threadId: a.threadId,
              triggeredBy: "manual",
              triggeredByUserId: user.id,
            });
            recovered += r.audit.messagesPersisted;
          } catch (e) {
            errors++;
            console.error(`[capture-audit-health] run-now thread=${a.threadId}:`, e);
          }
        }

        res.json({ ok: true, scanned, recovered, errors });
      } catch (err) {
        console.error("[conversations] POST /capture-audit-health/run-now error:", err);
        res.status(500).json({ error: "Run-now failed" });
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

  // ── POST /api/internal/admin/conversations/sync-mailboxes-now ─────────────
  // Admin-triggered manual delta-sync cycle. The cron runs every 5 minutes;
  // this gives an admin (or the "Sync now" button on the Capture Audit pill)
  // an immediate pass without waiting for the next tick. Fire-and-forget —
  // returns as soon as the cycle is queued so the HTTP response isn't held
  // open for a multi-mailbox sweep.
  app.post(
    "/api/internal/admin/conversations/sync-mailboxes-now",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        if (!["admin", "director", "sales_director"].includes(user.role)) {
          return res.status(403).json({ error: "Admin access required" });
        }
        const { triggerImmediateDeltaSyncCycle } = await import(
          "../services/mailboxDeltaSyncService"
        );
        const result = triggerImmediateDeltaSyncCycle();
        res.json({ ok: true, ...result });
      } catch (err) {
        console.error("[conversations] POST /admin/sync-mailboxes-now error:", err);
        res.status(500).json({ error: "Sync trigger failed" });
      }
    },
  );

  // ── POST /api/internal/admin/conversations/run-ai-batch-now ────────────────
  // Admin-triggered manual run of the email_intelligence_batch cron. The cron
  // runs every 2 minutes; this gives an admin (or the "Run AI batch now"
  // button on the Capture Audit pill) an immediate pass without waiting for
  // the next tick or a workflow restart. This is the recovery escape hatch
  // for a stuck batch — paired with the new stuck-running staleness check in
  // getStaleCronHeartbeats so the pill goes red within ≤6 min of a stall
  // (was previously invisible, allowing 3h silent outages).
  app.post(
    "/api/internal/admin/conversations/run-ai-batch-now",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        if (!["admin", "director", "sales_director"].includes(user.role)) {
          return res.status(403).json({ error: "Admin access required" });
        }
        const { triggerImmediateEmailIntelligenceBatch } = await import(
          "../emailIntelligenceScheduler"
        );
        // Scope to the caller's org so a director in org A can't drain
        // org B's queue (mirrors the renew-mailbox-subscriptions scope).
        const result = triggerImmediateEmailIntelligenceBatch({
          orgId: user.organizationId,
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        console.error("[conversations] POST /admin/run-ai-batch-now error:", err);
        res.status(500).json({ error: "AI batch trigger failed" });
      }
    },
  );

  // ── POST /api/internal/admin/conversations/renew-mailbox-subscriptions ────
  // Admin-only manual trigger for the Graph mailbox subscription renewer.
  // The periodic cron runs every 6h, but when the Webhook health pill goes
  // red an admin can press this to recover instantly without waiting for
  // the next tick.
  //
  // Scope rules (mirror /admin/self-heal-sweep above):
  //   - default: only the caller's org's mailboxes are touched
  //   - admin role + body.allOrgs === true: org-wide pass
  // This prevents a director in org A from triggering Microsoft Graph
  // re-registrations on org B's mailboxes.
  app.post(
    "/api/internal/admin/conversations/renew-mailbox-subscriptions",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        if (!["admin", "director", "sales_director"].includes(user.role)) {
          return res.status(403).json({ error: "Admin access required" });
        }
        const scopeAllOrgs = req.body?.allOrgs === true && user.role === "admin";
        const targetOrgId = scopeAllOrgs ? undefined : user.organizationId;
        const summary = await renewUserMailboxSubscriptions(targetOrgId);
        const expiringPass = await renewExpiringSoonSubscriptions(undefined, targetOrgId);
        res.json({
          ok: true,
          scope: scopeAllOrgs ? "all_orgs" : "current_org",
          summary,
          expiringPass,
        });
      } catch (err) {
        console.error("[conversations] POST /admin/renew-mailbox-subscriptions error:", err);
        res.status(500).json({ error: "Renewal failed" });
      }
    },
  );

  // ── POST /admin/conversations/renew-mailbox-subscriptions/:mailboxId ──────
  // Task #794 — Per-mailbox retry path used by the "Retry this mailbox"
  // button on the capture-audit pill. Re-registers (or renews) just the one
  // mailbox's Graph subscriptions and auto-runs delta-sync + per-thread
  // self-heal so missed mail is pulled in immediately. Org-scoped so a
  // director in org A can never trigger Graph work on org B's mailboxes.
  app.post(
    "/api/internal/admin/conversations/renew-mailbox-subscriptions/:mailboxId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        if (!["admin", "director", "sales_director"].includes(user.role)) {
          return res.status(403).json({ error: "Admin access required" });
        }
        const mailboxId = pStr(req.params.mailboxId);
        if (!mailboxId) {
          return res.status(400).json({ error: "mailboxId is required" });
        }
        const mailbox = await storage.getMonitoredMailbox(mailboxId);
        if (!mailbox) {
          return res.status(404).json({ error: "Mailbox not found" });
        }
        // Org gate — admins on the same tenant can act, but a director in
        // another org cannot poke this mailbox even with a guessed UUID.
        if (mailbox.orgId !== user.organizationId && user.role !== "admin") {
          return res.status(403).json({ error: "Cross-org renewal is not permitted" });
        }
        const result = await renewSingleMailboxSubscription(mailboxId);
        res.json({ ok: true, mailboxId, email: mailbox.email, result });
      } catch (err) {
        console.error("[conversations] POST /admin/renew-mailbox-subscriptions/:mailboxId error:", err);
        res.status(500).json({ error: "Single-mailbox renewal failed" });
      }
    },
  );

  // ─── Smarter Conversations detail pane (Task #534) ───────────────────────
  // Resolves the request's :id param to (canonical record id, outlook
  // threadId) and runs the standard canAccessThread gate. Mirrors the
  // pattern used by the messages endpoint so smart-pane endpoints are safe
  // for orphan threads too.
  const resolveSmartPaneTarget = async (
    user: User,
    idParam: string,
  ): Promise<
    | { ok: true; threadId: string; recordId: string | null }
    | { ok: false; status: number; error: string }
  > => {
    let threadId: string | null = null;
    let recordId: string | null = null;

    if (idParam.startsWith("thread:")) {
      threadId = idParam.slice("thread:".length) || null;
      if (!threadId) return { ok: false, status: 400, error: "Invalid thread id" };
      try {
        await materializeConversationThreadIfMissing(user.organizationId, threadId);
      } catch (err) {
        console.error("[conversations] smart-pane materialise error:", err);
      }
    } else {
      const thread = await storage.getEmailConversationThreadById(idParam);
      if (!thread || thread.orgId !== user.organizationId) {
        return { ok: false, status: 404, error: "Conversation not found" };
      }
      threadId = thread.threadId;
      recordId = thread.id;
    }

    const threadRow = await storage.getEmailConversationThreadByThreadId(user.organizationId, threadId);
    if (!threadRow) {
      return { ok: false, status: 404, error: "Conversation not found" };
    }
    if (!(await canAccessThread(user, threadRow))) {
      return { ok: false, status: 403, error: "You do not have access to this conversation" };
    }
    return { ok: true, threadId, recordId: recordId ?? threadRow.id };
  };

  // GET /api/internal/conversations/:id/summary — return cached or freshly
  // generated AI summary. The hash check inside the service makes this
  // cheap when nothing has changed; first views may take a second or two
  // because we call OpenAI synchronously.
  app.get("/api/internal/conversations/:id/summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const resolved = await resolveSmartPaneTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      const summary = await getOrGenerateThreadSummary({
        orgId: user.organizationId,
        threadId: resolved.threadId,
      });
      if (!summary) return res.json({ summary: null });
      res.json({ summary });
    } catch (err) {
      console.error("[conversations] GET /conversations/:id/summary error:", err);
      res.status(500).json({ error: "Failed to load summary" });
    }
  });

  // POST /api/internal/conversations/:id/summary/regenerate — explicit
  // refresh from the UI. Bypasses the contentHash short-circuit.
  app.post("/api/internal/conversations/:id/summary/regenerate", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const resolved = await resolveSmartPaneTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      const summary = await getOrGenerateThreadSummary({
        orgId: user.organizationId,
        threadId: resolved.threadId,
        force: true,
      });
      if (!summary) return res.json({ summary: null });
      res.json({ summary });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/summary/regenerate error:", err);
      res.status(500).json({ error: "Failed to regenerate summary" });
    }
  });

  // GET /api/internal/conversations/:id/suggestion — cached suggested next
  // action plus dismiss/feedback flags (so the UI knows to hide the card).
  app.get("/api/internal/conversations/:id/suggestion", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const resolved = await resolveSmartPaneTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      const suggestion = await getOrComputeThreadSuggestion({
        orgId: user.organizationId,
        threadId: resolved.threadId,
      });
      res.json({ suggestion });
    } catch (err) {
      console.error("[conversations] GET /conversations/:id/suggestion error:", err);
      res.status(500).json({ error: "Failed to load suggestion" });
    }
  });

  // POST /api/internal/conversations/:id/suggestion/dismiss — soft-hide
  // the card until the next message arrives.
  app.post("/api/internal/conversations/:id/suggestion/dismiss", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const resolved = await resolveSmartPaneTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      const ok = await dismissSuggestion({
        orgId: user.organizationId,
        threadId: resolved.threadId,
        userId: user.id,
      });
      res.json({ ok });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/suggestion/dismiss error:", err);
      res.status(500).json({ error: "Failed to dismiss suggestion" });
    }
  });

  // POST /api/internal/conversations/:id/suggestion/feedback — record
  // "wrong"/"good" rating (with optional notes) so we can analyse model
  // accuracy. A "wrong" rating implicitly hides the card.
  app.post("/api/internal/conversations/:id/suggestion/feedback", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({
        kind: z.enum(["wrong", "good"]),
        notes: z.string().max(500).optional().nullable(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      const resolved = await resolveSmartPaneTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      const ok = await recordSuggestionFeedback({
        orgId: user.organizationId,
        threadId: resolved.threadId,
        userId: user.id,
        kind: parsed.data.kind,
        notes: parsed.data.notes ?? null,
      });
      res.json({ ok });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/suggestion/feedback error:", err);
      res.status(500).json({ error: "Failed to record feedback" });
    }
  });

  // GET /api/internal/conversations/:id/events — full audit timeline for
  // the right-hand pane. Most-recent-first, cap at 100 rows (the UI is a
  // collapsible scrolled list, not a full report).
  app.get("/api/internal/conversations/:id/events", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const resolved = await resolveSmartPaneTarget(user, pStr(req.params.id));
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      const events = await listThreadEvents(user.organizationId, resolved.threadId, 100);
      res.json({ events });
    } catch (err) {
      console.error("[conversations] GET /conversations/:id/events error:", err);
      res.status(500).json({ error: "Failed to load events" });
    }
  });
}
