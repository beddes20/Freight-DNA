import type { Express } from "express";
import { storage } from "../storage";
import { getCurrentUser } from "../auth";

export function registerMyProcurementRoutes(app: Express) {
  /**
   * GET /api/my-procurement
   *
   * Returns two buckets for the authenticated user:
   *   1. lwqLanes    — recurring_lanes where ownerUserId = me (LWQ assignments)
   *                    Excludes resolved lanes (resolved_at IS NOT NULL)
   *   2. awardTasks  — tasks where assignedTo = me AND type = "carrier_procurement"
   *                    Excludes closed tasks (status != 'open')
   *
   * Each award task includes `matchedLaneId` — the ID of the matching recurring_lane
   * found by case-insensitive origin/destination lookup — so the client can deep-link
   * directly to the LWQ procurement workspace for both source types.
   */
  app.get("/api/my-procurement", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // ── 1. Recurring lanes assigned to me ──────────────────────────────────
      const laneRows = await storage.pool.query<{
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
        assigned_at: string | null;
        carriers_contacted_count: number | null;
        is_manual: boolean;
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
           rl.assigned_at,
           rl.carriers_contacted_count,
           rl.is_manual
         FROM recurring_lanes rl
         LEFT JOIN companies c ON c.id = rl.company_id
         WHERE rl.owner_user_id = $1
           AND rl.org_id = $2
           AND rl.resolved_at IS NULL
         ORDER BY rl.assigned_at DESC NULLS LAST`,
        [user.id, user.organizationId]
      );

      const lwqLanes = laneRows.rows.map((r) => ({
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
        assignedAt: r.assigned_at,
        carriersContactedCount: r.carriers_contacted_count ?? 0,
        isManual: r.is_manual,
      }));

      // ── 2. Award carrier-procurement tasks assigned to me ──────────────────
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

      // Parse award task lane metadata from attachedLaneData JSONB
      type RawAwardTask = {
        taskId: string;
        title: string;
        status: string;
        dueDate: string | null;
        companyId: string | null;
        createdAt: string | null;
        lane: string | null;
        origin: string | null;
        destination: string | null;
        volume: number | null;
        awardId: string | null;
        awardTitle: string | null;
        customerName: string | null;
        matchedLaneId: string | null;
      };

      const rawTasks: RawAwardTask[] = taskRows.rows.map((r) => {
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
          lane: (proc["lane"] as string) ?? null,
          origin: (proc["origin"] as string) ?? null,
          destination: (proc["destination"] as string) ?? null,
          volume: (proc["volume"] as number) ?? null,
          awardId: (proc["awardId"] as string) ?? null,
          awardTitle: (proc["awardTitle"] as string) ?? null,
          customerName: (proc["customerName"] as string) ?? null,
          matchedLaneId: null,
        };
      });

      // ── 3. Lane ID lookup — match award task origins/destinations to recurring_lanes ─
      // Collect unique pairs that have both origin and destination
      const pairsToLookup = [
        ...new Map(
          rawTasks
            .filter((t) => t.origin && t.destination)
            .map((t) => [
              `${t.origin!.toLowerCase().trim()}|${t.destination!.toLowerCase().trim()}`,
              { origin: t.origin!, destination: t.destination! },
            ])
        ).values(),
      ];

      if (pairsToLookup.length > 0) {
        // Build a single query using UNNEST to do all lookups in one round-trip
        // Returns one row per (origin, destination) pair — picks the most recently assigned lane
        const lookupResult = await storage.pool.query<{
          id: string;
          origin_key: string;
          destination_key: string;
        }>(
          `SELECT DISTINCT ON (LOWER(TRIM(origin)), LOWER(TRIM(destination)))
             id,
             LOWER(TRIM(origin)) AS origin_key,
             LOWER(TRIM(destination)) AS destination_key
           FROM recurring_lanes
           WHERE org_id = $1
             AND (LOWER(TRIM(origin)), LOWER(TRIM(destination))) IN (${pairsToLookup
               .map((_, i) => `($${2 + i * 2}, $${3 + i * 2})`)
               .join(", ")})
           ORDER BY LOWER(TRIM(origin)), LOWER(TRIM(destination)), assigned_at DESC NULLS LAST`,
          [
            user.organizationId,
            ...pairsToLookup.flatMap((p) => [
              p.origin.toLowerCase().trim(),
              p.destination.toLowerCase().trim(),
            ]),
          ]
        );

        const laneByPair = new Map(
          lookupResult.rows.map((r) => [`${r.origin_key}|${r.destination_key}`, r.id])
        );

        for (const task of rawTasks) {
          if (task.origin && task.destination) {
            const key = `${task.origin.toLowerCase().trim()}|${task.destination.toLowerCase().trim()}`;
            task.matchedLaneId = laneByPair.get(key) ?? null;
          }
        }
      }

      return res.json({ lwqLanes, awardTasks: rawTasks });
    } catch (err) {
      console.error("[my-procurement]", err);
      return res.status(500).json({ error: "Failed to load procurement data" });
    }
  });

  /**
   * POST /api/my-procurement/lwq-lane/:laneId/resolve
   * Marks a recurring lane as resolved — removes it from My Procurement.
   * Sets resolved_at timestamp to NOW().
   */
  app.post("/api/my-procurement/lwq-lane/:laneId/resolve", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { laneId } = req.params;
      await storage.pool.query(
        `UPDATE recurring_lanes
         SET resolved_at = NOW()::text, updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2 AND org_id = $3`,
        [laneId, user.id, user.organizationId]
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error("[my-procurement/resolve]", err);
      return res.status(500).json({ error: "Failed to resolve lane" });
    }
  });

  /**
   * POST /api/my-procurement/award-task/:taskId/close
   * Closes an award procurement task — removes it from My Procurement.
   */
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
      return res.json({ ok: true });
    } catch (err) {
      console.error("[my-procurement/award-task/close]", err);
      return res.status(500).json({ error: "Failed to close task" });
    }
  });
}
