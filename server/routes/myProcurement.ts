/**
 * My Procurement Routes
 *
 * ENDPOINT INTENT AUDIT (Task #200):
 *
 * GET /api/my-procurement
 *   PURPOSE: Personal procurement work surface — lean list, no per-lane enrichment.
 *   RETURNS (lwqLanes): laneId, origin, destination, equipmentType, avgLoadsPerWeek,
 *     laneScore, companyId, companyName, ownerUserId, assignedAt, carriersContactedCount,
 *     isManual. NO replySummary, no bench arrays, no history objects.
 *   RETURNS (awardTasks): taskId, title, status, dueDate, companyId, customerName,
 *     awardTitle, matchedLaneId. NO full lane object, NO replySummary.
 *   PAGINATION: limit + cursor (keyset) on both buckets. Default page size 50.
 *
 * enriched replySummary / bench data is loaded lazily via:
 *   GET /api/recurring-lanes/:id/detail  (when panel opens)
 */

import type { Express } from "express";
import { storage, db } from "../storage";
import { getCurrentUser } from "../auth";
import { normalizeLaneLocation, normalizeEquipmentType } from "@shared/laneFormatters";
import { and, desc, eq, or, inArray, gte, isNull } from "drizzle-orm";
import { plays, playRuns, freightOpportunities } from "@shared/schema";
import { evaluatePlayTriggersForOrg } from "./playbook";
import { performAvailableFreightImport, listAvailableFreightImports, availableFreightSettingKey } from "../availableFreightImporter";
import { z } from "zod";

const APPROVER_ROLES = new Set([
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "logistics_manager",
]);

/**
 * SQL expression that applies the same normalization as normalizeLaneLocation() to a column.
 * Matches: lowercase, trimmed, single-space collapse, comma-space normalization.
 */
const SQL_NORM = (col: string) =>
  `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(${col}), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ', 'g'))`;

export function registerMyProcurementRoutes(app: Express) {
  /**
   * GET /api/my-procurement
   *
   * Returns two lean buckets for the authenticated user:
   *   1. lwqLanes   — recurring_lanes where ownerUserId = me, resolved_at IS NULL
   *                   Lean: no replySummary, no bench arrays
   *   2. awardTasks — tasks where assignedTo = me AND type = "carrier_procurement"
   *                   Lean: taskId, title, status, dueDate, customerName, awardTitle, matchedLaneId only
   *
   * Pagination: ?limit=50&cursor=<keyset> on both buckets (independent cursors).
   */
  app.get("/api/my-procurement", async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Unauthorized" });

      // Optional ?userId= lets privileged roles view another rep's queue (read-only).
      // Allowed roles: admin (any user in org), or
      //   director / sales_director / national_account_manager / logistics_manager
      //   restricted to users in their reporting chain.
      const requestedUserId = (req.query.userId as string | undefined) || null;
      let user = viewer;
      let viewing: { id: string; name: string; isOther: boolean } | null = null;
      if (requestedUserId && requestedUserId !== viewer.id) {
        const VIEWER_ROLES = new Set([
          "admin",
          "director",
          "sales_director",
          "national_account_manager",
          "logistics_manager",
        ]);
        if (!VIEWER_ROLES.has(viewer.role)) {
          return res.status(403).json({ error: "Not allowed to view another user's procurement" });
        }
        const target = await storage.getUser(requestedUserId);
        if (!target || target.organizationId !== viewer.organizationId) {
          return res.status(404).json({ error: "User not found" });
        }
        if (viewer.role !== "admin") {
          const teamIds = await storage.getTeamMemberIds(viewer.id, viewer.organizationId);
          if (!teamIds.includes(target.id)) {
            return res.status(403).json({ error: "Target user is not in your team" });
          }
        }
        user = target;
        viewing = { id: target.id, name: target.name ?? target.email ?? target.id, isOther: true };
      }

      // Pagination params — default page size 50, max 200
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const lanesCursor = req.query.lanesCursor as string | undefined;
      const tasksCursor = req.query.tasksCursor as string | undefined;

      // ── 1. My lanes — prefer lane_summary_cache (lean, pre-computed), fall back to recurring_lanes ──
      // Cache path: no joins, no per-lane bench enrichment — just the pre-scored fields.
      const cacheRows = await storage.pool.query<{
        lane_id: string;
        origin: string;
        origin_state: string | null;
        destination: string;
        destination_state: string | null;
        equipment_type: string | null;
        avg_loads_per_week: string | null;
        lane_score: number | null;
        company_id: string | null;
        company_name: string | null;
        owner_user_id: string | null;
        carriers_contacted_count: number;
        has_cache: boolean;
      }>(
        `SELECT
           lsc.lane_id,
           lsc.origin,
           lsc.origin_state,
           lsc.destination,
           lsc.destination_state,
           lsc.equipment_type,
           lsc.avg_loads_per_week::text,
           lsc.lane_score,
           lsc.company_id,
           lsc.company_name,
           lsc.owner_user_id,
           COALESCE(lsc.carriers_contacted_count, 0) AS carriers_contacted_count,
           true AS has_cache
         FROM lane_summary_cache lsc
         WHERE lsc.owner_user_id = $1
           AND lsc.org_id = $2
           AND lsc.resolved_at IS NULL
         ORDER BY lsc.lane_score DESC NULLS LAST, lsc.lane_id`,
        [user.id, user.organizationId]
      );

      let lwqLanesAll: Array<{
        laneId: string;
        origin: string;
        originState: string | null;
        destination: string;
        destinationState: string | null;
        equipmentType: string | null;
        avgLoadsPerWeek: string | null;
        laneScore: number | null;
        companyId: string | null;
        companyName: string | null;
        ownerUserId: string | null;
        carriersContactedCount: number;
      }>;

      if (cacheRows.rows.length > 0) {
        lwqLanesAll = cacheRows.rows.map((r) => ({
          laneId: r.lane_id,
          origin: r.origin,
          originState: r.origin_state,
          destination: r.destination,
          destinationState: r.destination_state,
          equipmentType: r.equipment_type,
          avgLoadsPerWeek: r.avg_loads_per_week,
          laneScore: r.lane_score,
          companyId: r.company_id,
          companyName: r.company_name,
          ownerUserId: r.owner_user_id,
          carriersContactedCount: r.carriers_contacted_count,
        }));
      } else {
        // Fall back to recurring_lanes when cache is empty (first run)
        const fallbackRows = await storage.pool.query<{
          id: string;
          origin: string;
          origin_state: string | null;
          destination: string;
          destination_state: string | null;
          equipment_type: string | null;
          avg_loads_per_week: string | null;
          lane_score: number | null;
          company_id: string | null;
          company_name: string | null;
          owner_user_id: string | null;
          carriers_contacted_count: number | null;
        }>(
          `SELECT
             rl.id,
             rl.origin,
             rl.origin_state,
             rl.destination,
             rl.destination_state,
             rl.equipment_type,
             rl.avg_loads_per_week,
             rl.lane_score,
             rl.company_id,
             COALESCE(rl.company_name, c.name) AS company_name,
             rl.owner_user_id,
             rl.carriers_contacted_count
           FROM recurring_lanes rl
           LEFT JOIN companies c ON c.id = rl.company_id
           WHERE rl.owner_user_id = $1
             AND rl.org_id = $2
             AND rl.resolved_at IS NULL
           ORDER BY rl.lane_score DESC NULLS LAST`,
          [user.id, user.organizationId]
        );
        lwqLanesAll = fallbackRows.rows.map((r) => ({
          laneId: r.id,
          origin: r.origin,
          originState: r.origin_state,
          destination: r.destination,
          destinationState: r.destination_state,
          equipmentType: r.equipment_type,
          avgLoadsPerWeek: r.avg_loads_per_week,
          laneScore: r.lane_score,
          companyId: r.company_id,
          companyName: r.company_name,
          ownerUserId: r.owner_user_id,
          carriersContactedCount: r.carriers_contacted_count ?? 0,
        }));
      }

      // Apply cursor pagination for lwqLanes (keyset by laneScore DESC, laneId)
      if (lanesCursor) {
        const [cursorScoreStr, cursorId] = lanesCursor.split(":");
        const cursorScore = parseInt(cursorScoreStr, 10);
        const cursorIdx = lwqLanesAll.findIndex(l => {
          const score = l.laneScore ?? 0;
          if (score !== cursorScore) return score < cursorScore;
          return l.laneId > cursorId;
        });
        if (cursorIdx !== -1) lwqLanesAll = lwqLanesAll.slice(cursorIdx);
      }
      const lwqLanes = lwqLanesAll.slice(0, limit);
      const lastLwqLane = lwqLanes[lwqLanes.length - 1];
      const lwqNextCursor = lwqLanes.length === limit && lastLwqLane
        ? `${lastLwqLane.laneScore ?? 0}:${lastLwqLane.laneId}`
        : null;

      // ── 2. Award carrier-procurement tasks assigned to me (lean) ──────────
      const taskRows = await storage.pool.query<{
        id: string;
        title: string;
        status: string;
        due_date: string | null;
        company_id: string | null;
        created_at: string | null;
        attached_lane_data: unknown;
      }>(
        `SELECT
           t.id,
           t.title,
           t.status,
           t.due_date,
           t.company_id,
           t.created_at,
           t.attached_lane_data
         FROM tasks t
         WHERE t.assigned_to = $1
           AND t.org_id = $2
           AND t.status = 'open'
           AND t.attached_lane_data IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(t.attached_lane_data::jsonb) AS elem
             WHERE elem->>'type' = 'carrier_procurement'
           )
         ORDER BY t.created_at DESC`,
        [user.id, user.organizationId]
      );

      // Parse award task metadata — lean shape only (no replySummary, no full lane object)
      type LeanAwardTask = {
        taskId: string;
        title: string;
        status: string;
        dueDate: string | null;
        companyId: string | null;
        createdAt: string | null;
        origin: string | null;
        destination: string | null;
        awardId: string | null;
        awardTitle: string | null;
        customerName: string | null;
        equipmentType: string | null;
        matchedLaneId: string | null;
      };

      const rawTasks: LeanAwardTask[] = taskRows.rows.map((r) => {
        const laneData: Array<Record<string, unknown>> = Array.isArray(r.attached_lane_data)
          ? (r.attached_lane_data as Array<Record<string, unknown>>)
          : [];
        const proc = laneData.find((e) => e["type"] === "carrier_procurement") ?? {};
        return {
          taskId: r.id,
          title: r.title,
          status: r.status,
          dueDate: r.due_date,
          companyId: r.company_id,
          createdAt: r.created_at,
          origin: (proc["origin"] as string) ?? null,
          destination: (proc["destination"] as string) ?? null,
          awardId: (proc["awardId"] as string) ?? null,
          awardTitle: (proc["awardTitle"] as string) ?? null,
          customerName: (proc["customerName"] as string) ?? null,
          equipmentType: (proc["equipmentType"] as string) ?? null,
          matchedLaneId: null,
        };
      });

      // ── 3. Lane ID lookup — match award tasks to recurring_lanes ─────────
      const tasksWithOD = rawTasks.filter((t) => t.origin && t.destination);

      if (tasksWithOD.length > 0) {
        const pairMap = new Map<string, { normOrigin: string; normDest: string }>();
        for (const t of tasksWithOD) {
          const no = normalizeLaneLocation(t.origin!);
          const nd = normalizeLaneLocation(t.destination!);
          pairMap.set(`${no}|${nd}`, { normOrigin: no, normDest: nd });
        }
        const uniquePairs = [...pairMap.values()];

        const lookupResult = await storage.pool.query<{
          id: string;
          origin_key: string;
          destination_key: string;
          equipment_type: string | null;
        }>(
          `SELECT
             id,
             ${SQL_NORM("origin")} AS origin_key,
             ${SQL_NORM("destination")} AS destination_key,
             equipment_type
           FROM recurring_lanes
           WHERE org_id = $1
             AND (${SQL_NORM("origin")}, ${SQL_NORM("destination")}) IN (${uniquePairs
               .map((_, i) => `($${2 + i * 2}, $${3 + i * 2})`)
               .join(", ")})
           ORDER BY assigned_at DESC NULLS LAST`,
          [
            user.organizationId,
            ...uniquePairs.flatMap((p) => [p.normOrigin, p.normDest]),
          ]
        );

        const lanesByPair = new Map<string, Array<{ id: string; equipment_type: string | null }>>();
        for (const row of lookupResult.rows) {
          const key = `${row.origin_key}|${row.destination_key}`;
          if (!lanesByPair.has(key)) lanesByPair.set(key, []);
          lanesByPair.get(key)!.push({ id: row.id, equipment_type: row.equipment_type });
        }

        for (const task of rawTasks) {
          if (!task.origin || !task.destination) continue;
          const no = normalizeLaneLocation(task.origin);
          const nd = normalizeLaneLocation(task.destination);
          const candidates = lanesByPair.get(`${no}|${nd}`) ?? [];
          if (candidates.length === 0) continue;

          if (task.equipmentType) {
            const targetEquip = normalizeEquipmentType(task.equipmentType);
            const match = candidates.find(
              (c) => normalizeEquipmentType(c.equipment_type) === targetEquip
            );
            task.matchedLaneId = match?.id ?? null;
          } else {
            task.matchedLaneId = candidates[0].id;
          }
        }
      }

      // Apply cursor pagination for awardTasks (keyset by createdAt DESC, id)
      let awardTasksAll = rawTasks;
      if (tasksCursor) {
        const [cursorDate, cursorId] = tasksCursor.split("|");
        const cursorIdx = awardTasksAll.findIndex(t => {
          if (!t.createdAt || t.createdAt < cursorDate) return true;
          if (t.createdAt === cursorDate) return t.taskId > cursorId;
          return false;
        });
        if (cursorIdx !== -1) awardTasksAll = awardTasksAll.slice(cursorIdx);
      }
      const awardTasks = awardTasksAll.slice(0, limit);
      const lastTask = awardTasks[awardTasks.length - 1];
      const tasksNextCursor = awardTasks.length === limit && lastTask
        ? `${lastTask.createdAt ?? ""}|${lastTask.taskId}`
        : null;

      // Triggered Plays bucket (Task #300) — surfaced as actionable items in the
      // rep's procurement queue. Best-effort: failures don't block the response.
      let triggeredPlays: Array<{
        runId: string;
        playId: string;
        playName: string;
        channel: string;
        audience: string;
        suggestedAt: string;
        signalType: string | null;
      }> = [];
      try {
        await evaluatePlayTriggersForOrg(user.organizationId).catch(() => {});
        const rows = await db.select({
          runId: playRuns.id,
          playId: plays.id,
          playName: plays.name,
          channel: plays.channel,
          audience: plays.audience,
          suggestedAt: playRuns.suggestedAt,
          signalType: plays.signalType,
          accountId: playRuns.accountId,
        })
          .from(playRuns)
          .innerJoin(plays, eq(plays.id, playRuns.playId))
          .where(and(
            eq(playRuns.orgId, user.organizationId),
            eq(playRuns.status, "suggested"),
          ))
          .orderBy(desc(playRuns.suggestedAt))
          .limit(20);
        // Rep-scope triggered plays: prefer runs whose accountId matches a
        // company already in the rep's lane work queue or award tasks. If
        // none of the rep's accounts match, fall back to org-wide so the rep
        // still sees newly fired triggers waiting for assignment.
        const repAccountIds = new Set<string>([
          ...lwqLanes.map(l => l.companyId).filter((x): x is string => !!x),
          ...awardTasks.map(t => t.companyId).filter((x): x is string => !!x),
        ]);
        const all = rows.map(r => ({
          runId: r.runId,
          playId: r.playId,
          playName: r.playName,
          channel: r.channel,
          audience: r.audience,
          suggestedAt: r.suggestedAt instanceof Date ? r.suggestedAt.toISOString() : String(r.suggestedAt),
          signalType: r.signalType ?? null,
          accountId: r.accountId ?? null,
        }));
        const scoped = all.filter(p => p.accountId && repAccountIds.has(p.accountId));
        triggeredPlays = (scoped.length > 0 ? scoped : all).map(({ accountId, ...rest }) => rest);
      } catch (pbErr) {
        console.error("[my-procurement] triggered plays warning:", pbErr);
      }

      // ── Available Freight bucket (task #354) ──────────────────────────────
      // Today's open freight opportunities owned by — or delegated to — this
      // rep, surfaced in the new "Available Freight" tab. "Today's open loads"
      // is defined as: status in (new, ready_to_send) AND the pickup window
      // hasn't already closed (pickupWindowEnd >= today, or null when the
      // spreadsheet didn't supply one).
      // pickupWindowEnd is a text column storing ISO date strings (YYYY-MM-DD),
      // so we compare against today's date as a string for correct lexical
      // ordering.
      const todayIso = new Date().toISOString().slice(0, 10);
      // Managers viewing their own queue also see imports that didn't match
      // any rep email (ownerUserId IS NULL AND delegatedToUserId IS NULL).
      // This is the "unassigned import queue" — they need a single place to
      // route those rows to a rep before they go stale.
      const isManagerSelfView = !viewing && APPROVER_ROLES.has(viewer.role);
      const ownershipFilter = isManagerSelfView
        ? or(
            eq(freightOpportunities.ownerUserId, user.id),
            eq(freightOpportunities.delegatedToUserId, user.id),
            and(
              isNull(freightOpportunities.ownerUserId),
              isNull(freightOpportunities.delegatedToUserId),
            ),
          )
        : or(
            eq(freightOpportunities.ownerUserId, user.id),
            eq(freightOpportunities.delegatedToUserId, user.id),
          );

      const freightOppRows = await db.select({
        id: freightOpportunities.id,
        companyId: freightOpportunities.companyId,
        origin: freightOpportunities.origin,
        originState: freightOpportunities.originState,
        destination: freightOpportunities.destination,
        destinationState: freightOpportunities.destinationState,
        equipmentType: freightOpportunities.equipmentType,
        pickupWindowStart: freightOpportunities.pickupWindowStart,
        pickupWindowEnd: freightOpportunities.pickupWindowEnd,
        loadCount: freightOpportunities.loadCount,
        status: freightOpportunities.status,
        urgencyScore: freightOpportunities.urgencyScore,
        ownerUserId: freightOpportunities.ownerUserId,
        delegatedToUserId: freightOpportunities.delegatedToUserId,
        approvedAt: freightOpportunities.approvedAt,
        approvedById: freightOpportunities.approvedById,
        templateOverrideSubject: freightOpportunities.templateOverrideSubject,
        templateOverrideBody: freightOpportunities.templateOverrideBody,
        sourceFileName: freightOpportunities.sourceFileName,
        generatedAt: freightOpportunities.generatedAt,
      })
        .from(freightOpportunities)
        .where(and(
          eq(freightOpportunities.orgId, user.organizationId),
          inArray(freightOpportunities.status, ["new", "ready_to_send"]),
          or(
            isNull(freightOpportunities.pickupWindowEnd),
            gte(freightOpportunities.pickupWindowEnd, todayIso),
          ),
          ownershipFilter,
        ))
        .orderBy(desc(freightOpportunities.urgencyScore), desc(freightOpportunities.generatedAt))
        .limit(200);

      const companyIds = Array.from(new Set(freightOppRows.map(r => r.companyId)));
      const companyMap = new Map<string, string>();
      if (companyIds.length > 0) {
        const cos = await storage.getCompaniesByIds(companyIds, user.organizationId);
        for (const c of cos) companyMap.set(c.id, c.name);
      }

      const availableFreight = freightOppRows.map(r => ({
        id: r.id,
        companyId: r.companyId,
        companyName: companyMap.get(r.companyId) ?? null,
        origin: r.origin,
        originState: r.originState,
        destination: r.destination,
        destinationState: r.destinationState,
        equipmentType: r.equipmentType,
        pickupWindowStart: r.pickupWindowStart,
        pickupWindowEnd: r.pickupWindowEnd,
        loadCount: r.loadCount,
        status: r.status,
        urgencyScore: r.urgencyScore,
        ownerUserId: r.ownerUserId,
        delegatedToUserId: r.delegatedToUserId,
        approvedAt: r.approvedAt instanceof Date ? r.approvedAt.toISOString() : (r.approvedAt as string | null),
        approvedById: r.approvedById,
        hasTemplateOverride: !!(r.templateOverrideSubject || r.templateOverrideBody),
        sourceFileName: r.sourceFileName,
        isDelegatedToMe: r.delegatedToUserId === user.id,
        needsApproval: !r.approvedAt && r.status === "ready_to_send",
        isUnassigned: !r.ownerUserId && !r.delegatedToUserId,
      }));

      return res.json({
        lwqLanes,
        awardTasks,
        availableFreight,
        triggeredPlays,
        viewing,
        pagination: {
          limit,
          lwqNextCursor,
          tasksNextCursor,
        },
      });
    } catch (err) {
      console.error("[my-procurement]", err);
      return res.status(500).json({ error: "Failed to load procurement data" });
    }
  });

  /**
   * POST /api/my-procurement/lwq-lane/:laneId/resolve
   * Marks a recurring lane as resolved — removes it from My Procurement.
   * Sets resolved_at timestamp to NOW().
   * Also patches lane_summary_cache so the cache stays current.
   */
  app.post("/api/my-procurement/lwq-lane/:laneId/resolve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { laneId } = req.params;
      const resolvedAt = new Date().toISOString();
      await storage.pool.query(
        `UPDATE recurring_lanes
         SET resolved_at = NOW()::text, updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2 AND org_id = $3`,
        [laneId, user.id, user.organizationId]
      );
      // Keep cache current — patch resolved_at so it disappears from list queries
      await storage.patchLaneSummaryCache(laneId, { resolvedAt }).catch(() => {});
      return res.json({ ok: true, laneId, resolvedAt });
    } catch (err) {
      console.error("[my-procurement/resolve]", err);
      return res.status(500).json({ error: "Failed to resolve lane" });
    }
  });

  // ── Available Freight tab actions (task #354) ─────────────────────────────

  /**
   * POST /api/my-procurement/freight-opp/:id/delegate
   * Owner (or manager) re-assigns the opportunity to another rep. Pass
   * `{ delegatedToUserId: null }` to clear the delegation.
   */
  const delegateSchema = z.object({
    delegatedToUserId: z.string().min(1).nullable(),
  });
  app.post("/api/my-procurement/freight-opp/:id/delegate", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      const isManager = APPROVER_ROLES.has(user.role);
      const isOwner = opp.ownerUserId === user.id;
      const isCurrentDelegate = opp.delegatedToUserId === user.id;
      if (!isManager && !isOwner && !isCurrentDelegate) {
        return res.status(403).json({ error: "Only the owner, current delegate, or a manager can delegate" });
      }

      const parsed = delegateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid delegate payload" });

      let target: { id: string; name: string | null } | null = null;
      if (parsed.data.delegatedToUserId) {
        const t = await storage.getUser(parsed.data.delegatedToUserId);
        if (!t || t.organizationId !== user.organizationId) {
          return res.status(404).json({ error: "Target user not found in this org" });
        }
        target = { id: t.id, name: t.name ?? t.email ?? null };
      }

      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, {
        delegatedToUserId: target?.id ?? null,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "status_changed",
        actorUserId: user.id,
        payload: {
          kind: "delegation",
          from: opp.delegatedToUserId,
          to: target?.id ?? null,
          targetName: target?.name ?? null,
        },
      });
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/delegate]", err);
      return res.status(500).json({ error: "Failed to delegate opportunity" });
    }
  });

  /**
   * POST /api/my-procurement/freight-opp/:id/assign
   * Manager-only. Routes an unassigned (or already owned) imported freight
   * row to a specific rep — used by the "Unassigned" filter in the My
   * Procurement Available Freight tab. Sets ownerUserId and clears any
   * existing delegate (the new owner can re-delegate themselves if they want).
   */
  const assignSchema = z.object({
    ownerUserId: z.string().min(1),
  });
  app.post("/api/my-procurement/freight-opp/:id/assign", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers can assign freight opportunities" });
      }
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      // Gate: this endpoint is purpose-built for routing import-sourced
      // opportunities (the "Unassigned" bucket on the Available Freight tab).
      // Reassignment of carrier-procurement / manual opportunities flows
      // through other surfaces, so reject those here to keep the API surface
      // honest with the UI intent.
      const sourceKind = (opp.sourceRef as { kind?: string } | null)?.kind;
      if (sourceKind !== "available_freight_import") {
        return res.status(400).json({ error: "Only imported freight opportunities can be assigned via this endpoint" });
      }

      const parsed = assignSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid assign payload" });

      const target = await storage.getUser(parsed.data.ownerUserId);
      if (!target || target.organizationId !== user.organizationId) {
        return res.status(404).json({ error: "Target user not found in this org" });
      }

      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, {
        ownerUserId: target.id,
        delegatedToUserId: null,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "status_changed",
        actorUserId: user.id,
        payload: {
          kind: "assigned",
          from: opp.ownerUserId,
          to: target.id,
          targetName: target.name ?? target.email ?? null,
          previousDelegate: opp.delegatedToUserId,
        },
      });
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/assign]", err);
      return res.status(500).json({ error: "Failed to assign opportunity" });
    }
  });

  /**
   * POST /api/my-procurement/freight-opp/:id/approve
   * Manager-only. Stamps approvedAt + approvedById, unblocking the existing
   * /api/freight-opportunities/:id/send flow. Pass `{ approve: false }` to
   * revoke a prior approval (only allowed if no carriers have been sent).
   */
  const approveSchema = z.object({
    approve: z.boolean().default(true),
    note: z.string().max(2000).optional(),
  });
  app.post("/api/my-procurement/freight-opp/:id/approve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers can approve freight opportunities" });
      }
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      const parsed = approveSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid approve payload" });
      const approving = parsed.data.approve;

      if (!approving) {
        const carriers = await storage.listFreightOpportunityCarriers(opp.id);
        if (carriers.some(c => c.sentAt)) {
          return res.status(400).json({ error: "Cannot revoke approval after a carrier has been sent" });
        }
      }

      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, {
        approvedAt: approving ? new Date() : null,
        approvedById: approving ? user.id : null,
      });
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "approved",
        actorUserId: user.id,
        payload: {
          approved: approving,
          note: parsed.data.note ?? null,
        },
      });
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/approve]", err);
      return res.status(500).json({ error: "Failed to approve opportunity" });
    }
  });

  /**
   * PATCH /api/my-procurement/freight-opp/:id/template-override
   * Per-opportunity template subject/body that overrides the org default at
   * send time. Reps editing AFTER approval is allowed (the manager approved
   * the freight, not the copy) but each edit is audited.
   */
  const overrideSchema = z.object({
    subject: z.string().max(500).nullable().optional(),
    body: z.string().max(20_000).nullable().optional(),
  });
  app.patch("/api/my-procurement/freight-opp/:id/template-override", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const opp = await storage.getFreightOpportunity(user.organizationId, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const isManager = APPROVER_ROLES.has(user.role);
      const isOwner = opp.ownerUserId === user.id;
      const isDelegate = opp.delegatedToUserId === user.id;
      if (!isManager && !isOwner && !isDelegate) {
        return res.status(403).json({ error: "Only the owner, delegate, or a manager can edit the template" });
      }
      const parsed = overrideSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid template override" });

      const patch: Record<string, unknown> = {};
      if (parsed.data.subject !== undefined) patch.templateOverrideSubject = parsed.data.subject;
      if (parsed.data.body !== undefined) patch.templateOverrideBody = parsed.data.body;

      const updated = await storage.updateFreightOpportunity(user.organizationId, opp.id, patch);
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "template_edited",
        actorUserId: user.id,
        payload: {
          subjectChanged: parsed.data.subject !== undefined,
          bodyChanged: parsed.data.body !== undefined,
          subjectLen: (parsed.data.subject ?? "").length,
          bodyLen: (parsed.data.body ?? "").length,
        },
      });
      return res.json({ opportunity: updated });
    } catch (err) {
      console.error("[my-procurement/freight-opp/template-override]", err);
      return res.status(500).json({ error: "Failed to update template override" });
    }
  });

  /**
   * POST /api/available-freight/import
   * Triggers a fresh OneDrive pull. Available to admins, managers, AND any
   * rep who owns or is delegated at least one Available Freight opportunity
   * (lets reps refresh their own queue from the My Procurement tab).
   */
  app.post("/api/available-freight/import", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      // Any authenticated rep within the org can trigger a manual refresh —
      // the importer itself is org-scoped and idempotent, and recovery from a
      // failed scheduled run shouldn't require having a row already assigned.
      const summary = await performAvailableFreightImport(user.organizationId, user.id, "manual");
      return res.json({ ok: true, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[available-freight/import]", msg);
      return res.status(400).json({ error: msg });
    }
  });

  /**
   * GET /api/available-freight/imports
   * Manager/admin only. Returns the most recent import-summary audit rows.
   */
  app.get("/api/available-freight/imports", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Manager access required" });
      }
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10) || 25));
      const imports = await listAvailableFreightImports(user.organizationId, limit);
      return res.json({ imports });
    } catch (err) {
      console.error("[available-freight/imports]", err);
      return res.status(500).json({ error: "Failed to list imports" });
    }
  });

  /**
   * POST /api/my-procurement/freight-opp/bulk-approve
   * Manager-only. Approves multiple opportunities in one shot — used by the
   * "Awaiting my approval" queue in the My Procurement tab.
   */
  const bulkApproveSchema = z.object({
    opportunityIds: z.array(z.string().min(1)).min(1).max(200),
  });
  app.post("/api/my-procurement/freight-opp/bulk-approve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!APPROVER_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers can approve freight opportunities" });
      }
      const parsed = bulkApproveSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

      const now = new Date();
      const approved: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const id of parsed.data.opportunityIds) {
        const opp = await storage.getFreightOpportunity(user.organizationId, id);
        if (!opp) { skipped.push({ id, reason: "not_found" }); continue; }
        if (opp.approvedAt) { skipped.push({ id, reason: "already_approved" }); continue; }
        if (opp.status !== "new" && opp.status !== "ready_to_send") {
          skipped.push({ id, reason: `not_open_status:${opp.status}` });
          continue;
        }
        await storage.updateFreightOpportunity(user.organizationId, opp.id, {
          approvedAt: now,
          approvedById: user.id,
        });
        await storage.appendFreightOpportunityAudit({
          opportunityId: opp.id,
          eventType: "approved",
          actorUserId: user.id,
          payload: { approved: true, kind: "bulk_approve" },
        });
        approved.push(opp.id);
      }
      return res.json({ approved, skipped });
    } catch (err) {
      console.error("[my-procurement/freight-opp/bulk-approve]", err);
      return res.status(500).json({ error: "Bulk approval failed" });
    }
  });

  /**
   * GET / PUT /api/available-freight/onedrive-url
   * Admin-only. Read or update the OneDrive path used by the importer.
   */
  app.get("/api/available-freight/onedrive-url", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const url = await storage.getSetting(availableFreightSettingKey(user.organizationId));
      const last = await storage.getSetting(`available_freight_last_import:${user.organizationId}`);
      let lastImport: unknown = null;
      if (last) { try { lastImport = JSON.parse(last); } catch { lastImport = last; } }
      return res.json({ url: url ?? null, lastImport });
    } catch (err) {
      console.error("[available-freight/onedrive-url GET]", err);
      return res.status(500).json({ error: "Failed to read setting" });
    }
  });
  app.put("/api/available-freight/onedrive-url", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      const url = String((req.body ?? {}).url ?? "").trim();
      if (!url) return res.status(400).json({ error: "url is required" });
      await storage.setSetting(availableFreightSettingKey(user.organizationId), url);
      return res.json({ ok: true, url });
    } catch (err) {
      console.error("[available-freight/onedrive-url PUT]", err);
      return res.status(500).json({ error: "Failed to update setting" });
    }
  });

  app.post("/api/my-procurement/award-task/:taskId/close", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { taskId } = req.params;
      await storage.pool.query(
        `UPDATE tasks
         SET status = 'closed', updated_at = NOW()::text
         WHERE id = $1 AND assigned_to = $2 AND org_id = $3`,
        [taskId, user.id, user.organizationId]
      );
      return res.json({ ok: true, taskId });
    } catch (err) {
      console.error("[my-procurement/award-task/close]", err);
      return res.status(500).json({ error: "Failed to close task" });
    }
  });
}
