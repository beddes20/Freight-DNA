/**
 * Won Load Autopilot routes (Task #803)
 *
 * When a customer quote is auto-flipped to "won" (by the email pipeline)
 * or marked won manually, `customerQuotes.createFreightOpportunityFromWonQuote`
 * inserts a `freight_opportunities` row in status="pending_approval" linked
 * to the source quote. The NAM/AM that owns the quote then sees a global
 * popup driven by the endpoints below:
 *
 *   GET    /api/won-loads/pending-for-me        — un-snoozed pending rows for the popup queue
 *   POST   /api/freight-opportunities/:id/assign — assign to a direct-report LM (mandatory)
 *   POST   /api/freight-opportunities/:id/snooze — temporarily hide the popup
 *   PATCH  /api/freight-opportunities/:id/rate   — edit quotedRate / targetBuyRate (audited)
 *   GET    /api/team/my-direct-report-lms        — dropdown source for the LM picker
 *
 * Auth model: every route requires the caller to be the row's ownerUserId
 * (the NAM/AM the quote rep maps to) or admin. The LM picker is filtered to
 * `users.reportsToId = caller.id AND role = "logistics_manager"` per the
 * product requirement that NAMs only see THEIR direct LMs.
 */
import type { Express } from "express";
import { storage, db } from "../storage";
import { getCurrentUser } from "../auth";
import { pStr } from "../lib/req";
import { and, eq, isNull, or, sql, desc, asc, inArray } from "drizzle-orm";
import {
  freightOpportunities,
  freightOpportunityRateHistory,
  quoteOpportunities,
  quoteCustomers,
  companies,
  users,
} from "@shared/schema";
import { z } from "zod";
import { getErrorMessage } from "../lib/errors";
import { notifyFreightDelegated, notifyFreightApproved } from "../freightOpportunityNotifications";

// Narrowed update shape for freight_opportunities mutations driven by the
// assign endpoint. Mirrors the columns the route actually writes so we can
// keep the typed Drizzle inference instead of escaping to `any`.
type FreightOpportunityAssignUpdate = {
  delegatedToUserId: string;
  status: "ready_to_send";
  approvedAt?: Date;
  approvedById?: string;
  awaitingApprovalSince?: null;
};

const ADMIN_ROLES = new Set(["admin", "director"]);

function canOwnPopupFor(role: string | null | undefined): boolean {
  if (!role) return false;
  return role === "national_account_manager" || role === "account_manager"
      || role === "admin" || role === "director" || role === "sales_director";
}

export function registerWonLoadAutopilotRoutes(app: Express) {
  /**
   * GET /api/won-loads/pending-for-me
   *
   * Returns the popup queue for the caller. Includes ALL pending_approval
   * freight rows owned by them, ordered so already-snoozed rows fall to the
   * back. The client filters out snoozed-future rows for the popup but still
   * displays them in a "queued (snoozed)" hint, hence we return both buckets
   * and let the client decide what to render.
   */
  app.get("/api/won-loads/pending-for-me", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const rows = await db
        .select({
          id: freightOpportunities.id,
          orgId: freightOpportunities.orgId,
          companyId: freightOpportunities.companyId,
          companyName: companies.name,
          origin: freightOpportunities.origin,
          originState: freightOpportunities.originState,
          destination: freightOpportunities.destination,
          destinationState: freightOpportunities.destinationState,
          equipmentType: freightOpportunities.equipmentType,
          pickupWindowStart: freightOpportunities.pickupWindowStart,
          pickupWindowEnd: freightOpportunities.pickupWindowEnd,
          quotedRate: freightOpportunities.quotedRate,
          targetBuyRate: freightOpportunities.targetBuyRate,
          status: freightOpportunities.status,
          ownerUserId: freightOpportunities.ownerUserId,
          delegatedToUserId: freightOpportunities.delegatedToUserId,
          awaitingApprovalSince: freightOpportunities.awaitingApprovalSince,
          snoozedUntil: freightOpportunities.snoozedUntil,
          sourceQuoteId: freightOpportunities.sourceQuoteId,
          notes: freightOpportunities.notes,
        })
        .from(freightOpportunities)
        .leftJoin(companies, eq(companies.id, freightOpportunities.companyId))
        .where(and(
          eq(freightOpportunities.orgId, user.organizationId),
          eq(freightOpportunities.ownerUserId, user.id),
          eq(freightOpportunities.status, "pending_approval"),
        ))
        .orderBy(asc(freightOpportunities.snoozedUntil), asc(freightOpportunities.awaitingApprovalSince))
        .limit(50);

      const now = Date.now();
      const items = rows.map(r => ({
        ...r,
        isSnoozed: !!(r.snoozedUntil && new Date(r.snoozedUntil).getTime() > now),
      }));
      res.json({ items });
    } catch (err) {
      console.error("[won-loads] pending-for-me failed:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  /**
   * GET /api/team/my-direct-report-lms
   *
   * The LM picker in the popup is intentionally narrow per product:
   * direct-report Logistics Managers only. No skip-level, no sibling LMs.
   * Admins still see the full org LM list so they can rescue stuck rows.
   */
  app.get("/api/team/my-direct-report-lms", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const isAdmin = ADMIN_ROLES.has(user.role);
      const rows = await db
        .select({ id: users.id, name: users.name, username: users.username, role: users.role })
        .from(users)
        .where(and(
          eq(users.organizationId, user.organizationId),
          eq(users.role, "logistics_manager"),
          isAdmin ? sql`TRUE` : eq(users.managerId, user.id),
        ))
        .orderBy(asc(users.name));
      res.json({ items: rows });
    } catch (err) {
      console.error("[won-loads] my-direct-report-lms failed:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  /**
   * POST /api/freight-opportunities/:id/assign
   * Body: { assignedToId: string, approved?: boolean }
   *
   * Mandatory step out of pending_approval. Verifies:
   *   1. caller is owner OR admin
   *   2. assignedToId is in caller's direct-report LM list (admins exempt)
   * Then sets delegatedToUserId, status=ready_to_send, optional approval
   * stamp, and notifies the LM via notifyFreightDelegated/Approved.
   */
  const assignBody = z.object({
    assignedToId: z.string().min(1),
    approved: z.boolean().optional().default(true),
  });
  app.post("/api/freight-opportunities/:id/assign", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing id" });
      const parsed = assignBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      const { assignedToId, approved } = parsed.data;

      const [opp] = await db.select().from(freightOpportunities)
        .where(and(eq(freightOpportunities.id, id), eq(freightOpportunities.orgId, user.organizationId)))
        .limit(1);
      if (!opp) return res.status(404).json({ error: "Not found" });

      const isAdmin = ADMIN_ROLES.has(user.role);
      if (!isAdmin && opp.ownerUserId !== user.id) {
        return res.status(403).json({ error: "Only the load owner can assign" });
      }

      const [lm] = await db.select({ id: users.id, role: users.role, managerId: users.managerId, name: users.name })
        .from(users).where(and(eq(users.id, assignedToId), eq(users.organizationId, user.organizationId))).limit(1);
      if (!lm) return res.status(400).json({ error: "Assignee not found" });
      if (lm.role !== "logistics_manager") return res.status(400).json({ error: "Assignee must be a Logistics Manager" });
      if (!isAdmin && lm.managerId !== user.id) {
        return res.status(403).json({ error: "Assignee must be your direct report" });
      }

      const updates: FreightOpportunityAssignUpdate = {
        delegatedToUserId: assignedToId,
        status: "ready_to_send",
        ...(approved
          ? { approvedAt: new Date(), approvedById: user.id, awaitingApprovalSince: null }
          : {}),
      };
      await db.update(freightOpportunities).set(updates)
        .where(and(eq(freightOpportunities.id, id), eq(freightOpportunities.orgId, user.organizationId)));

      const [fresh] = await db.select().from(freightOpportunities).where(eq(freightOpportunities.id, id)).limit(1);
      if (fresh) {
        // Notify the new delegate (always) and emit the approved signal too
        // when applicable so the existing notification surfaces stay in sync.
        notifyFreightDelegated({
          storage, opportunity: fresh,
          newDelegateUserId: assignedToId,
          actorUserId: user.id,
          actorName: user.name,
        }).catch(() => {});
        if (approved) {
          notifyFreightApproved({
            storage, opportunity: fresh,
            approverUserId: user.id,
            approverName: user.name,
          }).catch(() => {});
        }
      }

      res.json({ ok: true, id, delegatedToUserId: assignedToId, approved });
    } catch (err) {
      console.error("[won-loads] assign failed:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  /**
   * POST /api/freight-opportunities/:id/snooze
   * Body: { minutes: number }  (1..1440)
   *
   * Temporarily hides the popup for the caller — the row stays in
   * pending_approval so the SLA clock continues. Default UI button is 30m.
   */
  const snoozeBody = z.object({ minutes: z.number().int().min(1).max(1440) });
  app.post("/api/freight-opportunities/:id/snooze", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing id" });
      const parsed = snoozeBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });

      const [opp] = await db.select().from(freightOpportunities)
        .where(and(eq(freightOpportunities.id, id), eq(freightOpportunities.orgId, user.organizationId))).limit(1);
      if (!opp) return res.status(404).json({ error: "Not found" });
      if (!ADMIN_ROLES.has(user.role) && opp.ownerUserId !== user.id) {
        return res.status(403).json({ error: "Only the load owner can snooze" });
      }

      const wakeAt = new Date(Date.now() + parsed.data.minutes * 60_000);
      await db.update(freightOpportunities).set({ snoozedUntil: wakeAt })
        .where(and(eq(freightOpportunities.id, id), eq(freightOpportunities.orgId, user.organizationId)));
      res.json({ ok: true, id, snoozedUntil: wakeAt.toISOString() });
    } catch (err) {
      console.error("[won-loads] snooze failed:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  /**
   * PATCH /api/freight-opportunities/:id/rate
   * Body: { field: "quotedRate"|"targetBuyRate", newRate: number, reason?: string }
   *
   * Audited rate edit. Owner, current delegate, or admin can call. Both the
   * old value and new value are written to freight_opportunity_rate_history
   * for traceability before the column is updated.
   */
  const rateBody = z.object({
    field: z.enum(["quotedRate", "targetBuyRate"]),
    newRate: z.number().nonnegative().finite(),
    reason: z.string().max(500).optional(),
  });
  app.patch("/api/freight-opportunities/:id/rate", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing id" });
      const parsed = rateBody.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      const { field, newRate, reason } = parsed.data;

      const [opp] = await db.select().from(freightOpportunities)
        .where(and(eq(freightOpportunities.id, id), eq(freightOpportunities.orgId, user.organizationId))).limit(1);
      if (!opp) return res.status(404).json({ error: "Not found" });

      const isAdmin = ADMIN_ROLES.has(user.role);
      const isOwner = opp.ownerUserId === user.id;
      const isDelegate = opp.delegatedToUserId === user.id;
      if (!isAdmin && !isOwner && !isDelegate) {
        return res.status(403).json({ error: "Only the owner or assigned LM can edit rate" });
      }

      const oldRate = field === "quotedRate" ? opp.quotedRate : opp.targetBuyRate;
      const newRateStr = newRate.toFixed(2);

      await db.transaction(async (tx) => {
        await tx.insert(freightOpportunityRateHistory).values({
          opportunityId: id,
          field,
          oldRate: oldRate ?? null,
          newRate: newRateStr,
          changedById: user.id,
          reason: reason ?? null,
        });
        await tx.update(freightOpportunities)
          .set(field === "quotedRate" ? { quotedRate: newRateStr } : { targetBuyRate: newRateStr })
          .where(and(eq(freightOpportunities.id, id), eq(freightOpportunities.orgId, user.organizationId)));
      });

      res.json({ ok: true, id, field, newRate: newRateStr });
    } catch (err) {
      console.error("[won-loads] rate edit failed:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
