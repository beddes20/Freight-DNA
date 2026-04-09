/**
 * Carrier Hub API — central carrier intelligence layer.
 *
 * GET  /api/carrier-hub              list with search/filter/sort + aggregated stats
 * GET  /api/carrier-hub/:id          full profile (contacts, claimed lanes, proven history)
 * POST /api/carrier-hub              create a new carrier manually
 * PATCH /api/carrier-hub/:id         update carrier profile
 * POST  /api/carrier-hub/:id/contacts
 * PATCH /api/carrier-hub/:id/contacts/:contactId
 * DELETE /api/carrier-hub/:id/contacts/:contactId
 * POST   /api/carrier-hub/:id/claimed-lanes
 * DELETE /api/carrier-hub/:id/claimed-lanes/:laneId
 */

import type { Express } from "express";
import { requireAuth } from "../auth";
import { storage, db } from "../storage";
import {
  carriers,
  carrierContacts,
  carrierClaimedLanes,
  insertCarrierSchema,
  insertCarrierContactSchema,
  insertCarrierClaimedLaneSchema,
} from "@shared/schema";
import { eq, and, desc, asc, inArray } from "drizzle-orm";

// ── helpers ────────────────────────────────────────────────────────────────────

function orgId(req: Express.Request): string {
  return (req as any).user?.orgId as string;
}

// ── register routes ─────────────────────────────────────────────────────────

export function registerCarrierHubRoutes(app: Express) {
  // ── LIST ──────────────────────────────────────────────────────────────────
  app.get("/api/carrier-hub", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const {
        q = "",
        status: statusFilter = "",
        equipment: equipFilter = "",
        hasEmail = "",
        hasPhone = "",
        hasProvenHistory = "",
        hasClaimedLanes = "",
        sort = "name",
        page = "1",
        limit = "100",
      } = req.query as Record<string, string>;

      const pageNum = Math.max(1, parseInt(page) || 1);
      const limitNum = Math.min(500, parseInt(limit) || 100);
      const offset = (pageNum - 1) * limitNum;

      // Pull carriers + aggregate proven stats from lane_carrier_interest
      const result = await storage.pool.query<{
        id: string;
        name: string;
        legal_name: string | null;
        mc_dot: string | null;
        dot_number: string | null;
        status: string;
        equipment_types: string[];
        states_served: string[];
        primary_email: string | null;
        backup_email: string | null;
        phone: string | null;
        city: string | null;
        state: string | null;
        notes: string | null;
        tags: string[];
        source_channel: string | null;
        created_at: string;
        updated_at: string;
        proven_lane_count: string;
        total_loads: string;
        last_used: string | null;
        outreach_sent: string;
        contact_count: string;
        claimed_lane_count: string;
      }>(
        `
        SELECT
          c.id, c.name, c.legal_name, c.mc_dot, c.dot_number, c.status,
          c.equipment_types, c.states_served, c.primary_email, c.backup_email,
          c.phone, c.city, c.state, c.notes, c.tags, c.source_channel,
          c.created_at, c.updated_at,
          COUNT(DISTINCT lci.id) FILTER (WHERE lci.carrier_id = c.id) AS proven_lane_count,
          COALESCE(SUM(lci.fit_score) FILTER (WHERE lci.carrier_id = c.id), 0) AS total_loads,
          MAX(lci.updated_at) FILTER (WHERE lci.carrier_id = c.id) AS last_used,
          COUNT(DISTINCT col.id) FILTER (WHERE c.id = ANY(col.carrier_ids)) AS outreach_sent,
          COUNT(DISTINCT cc.id) AS contact_count,
          COUNT(DISTINCT ccl.id) AS claimed_lane_count
        FROM carriers c
        LEFT JOIN lane_carrier_interest lci ON lci.carrier_id = c.id
        LEFT JOIN carrier_outreach_logs col ON c.id = ANY(col.carrier_ids)
        LEFT JOIN carrier_contacts cc ON cc.carrier_id = c.id AND cc.is_active = true
        LEFT JOIN carrier_claimed_lanes ccl ON ccl.carrier_id = c.id
        WHERE c.org_id = $1
          ${q ? `AND (c.name ILIKE $2 OR c.mc_dot ILIKE $2 OR c.dot_number ILIKE $2 OR c.primary_email ILIKE $2 OR c.phone ILIKE $2)` : ""}
          ${statusFilter ? `AND c.status = '${statusFilter.replace(/'/g, "''")}'` : ""}
          ${hasEmail === "true" ? `AND c.primary_email IS NOT NULL` : ""}
          ${hasPhone === "true" ? `AND c.phone IS NOT NULL` : ""}
        GROUP BY c.id
        ${hasProvenHistory === "true" ? `HAVING COUNT(DISTINCT lci.id) FILTER (WHERE lci.carrier_id = c.id) > 0` : ""}
        ORDER BY ${
          sort === "loads" ? "total_loads DESC, c.name ASC" :
          sort === "last_used" ? "last_used DESC NULLS LAST, c.name ASC" :
          sort === "outreach" ? "outreach_sent DESC, c.name ASC" :
          sort === "contact_readiness" ? "(CASE WHEN c.primary_email IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN c.phone IS NOT NULL THEN 1 ELSE 0 END) DESC, c.name ASC" :
          "c.name ASC"
        }
        LIMIT $${q ? "3" : "2"} OFFSET $${q ? "4" : "3"}
        `,
        q ? [org, `%${q}%`, limitNum, offset] : [org, limitNum, offset]
      );

      // Filter by equipment client-side after (simpler than PG array contains)
      let rows = result.rows;
      if (equipFilter) {
        rows = rows.filter(r =>
          r.equipment_types?.some(e => e.toLowerCase().includes(equipFilter.toLowerCase()))
        );
      }
      if (hasClaimedLanes === "true") {
        rows = rows.filter(r => parseInt(r.claimed_lane_count) > 0);
      }

      // Get total count for pagination
      const totalResult = await storage.pool.query(
        `SELECT COUNT(*) FROM carriers WHERE org_id = $1 ${q ? "AND (name ILIKE $2 OR mc_dot ILIKE $2 OR primary_email ILIKE $2)" : ""}`,
        q ? [org, `%${q}%`] : [org]
      );
      const total = parseInt(totalResult.rows[0].count);

      res.json({
        carriers: rows,
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      });
    } catch (err) {
      console.error("[carrier-hub] list error:", err);
      res.status(500).json({ error: "Failed to load carriers" });
    }
  });

  // ── BEST LANES FOR CARRIER ────────────────────────────────────────────────
  app.get("/api/carrier-hub/:id/best-lanes", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id } = req.params;

      const [carrier] = await db
        .select()
        .from(carriers)
        .where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!carrier) return res.status(404).json({ error: "Carrier not found" });

      // Get all recurring lanes for this org
      const lanes = await storage.getRecurringLanes(org);

      // Get carrier's preferred claimed lanes (not avoids)
      const preferredClaimed = await db
        .select()
        .from(carrierClaimedLanes)
        .where(and(eq(carrierClaimedLanes.carrierId, id)));
      const preferredOnly = preferredClaimed.filter(cl => cl.laneType !== "avoid");

      // Get lanes where this carrier showed positive interest
      const positiveRows = await storage.pool.query(
        `SELECT lane_id FROM lane_carrier_interest
         WHERE carrier_id = $1
           AND interest_status IN ('available', 'available_next_week')
         LIMIT 100`,
        [id]
      );
      const positiveLaneIds = new Set<string>(positiveRows.rows.map((r: any) => r.lane_id as string));

      function normLow(s: string | null | undefined): string {
        return (s ?? "").toLowerCase().trim();
      }

      function checkClaimedMatchForLane(
        lane: { originState: string | null; destinationState: string | null; equipmentType: string | null }
      ): boolean {
        const lOrig = normLow(lane.originState);
        const lDest = normLow(lane.destinationState);
        const lEquip = normLow(lane.equipmentType);
        return preferredOnly.some(cl => {
          const origOk = !cl.originState || normLow(cl.originState) === lOrig;
          const destOk = !cl.destState || normLow(cl.destState) === lDest;
          const equipOk = !cl.equipment || !lEquip ||
            normLow(cl.equipment).includes(lEquip) || lEquip.includes(normLow(cl.equipment));
          return origOk && destOk && equipOk;
        });
      }

      const carrierRegions = (carrier.regions ?? []).map(normLow);
      const carrierStates = (carrier.statesServed ?? []).map(normLow);
      const allGeoTerms = [...carrierRegions, ...carrierStates];
      const carrierEquip = (carrier.equipmentTypes ?? []).map(normLow);

      function geoMatch(laneState: string | null): boolean {
        if (!laneState || allGeoTerms.length === 0) return false;
        const ls = normLow(laneState);
        return allGeoTerms.some(g => g.includes(ls) || ls.includes(g));
      }

      function equipMatch(laneEquip: string | null): boolean {
        if (!laneEquip || carrierEquip.length === 0) return true; // no filter = assume general fit
        const le = normLow(laneEquip);
        return carrierEquip.some(e => e.includes(le) || le.includes(e));
      }

      const scored = lanes
        .map(lane => {
          let score = 0;
          const signals: string[] = [];

          if (positiveLaneIds.has(lane.id)) {
            score += 35;
            signals.push("Showed availability when contacted for this lane");
          }

          const claimed = checkClaimedMatchForLane(lane);
          if (claimed) {
            score += 35;
            signals.push("Claimed lane preference matches");
          }

          const equip = equipMatch(lane.equipmentType);
          const originGeo = geoMatch(lane.originState);
          const destGeo = geoMatch(lane.destinationState);

          if (equip && lane.equipmentType) { score += 20; signals.push(`Equipment match: ${lane.equipmentType}`); }
          else if (equip && !lane.equipmentType) { score += 8; }

          if (originGeo || destGeo) {
            score += 15;
            signals.push("Operates in this region");
          }

          if (score === 0) return null;

          const whyThisLane = signals.length > 0
            ? signals[0] + (signals.length > 1 ? ` · ${signals.slice(1).join(" · ")}` : "")
            : "Potential match based on catalog profile";

          return {
            laneId: lane.id,
            origin: lane.origin,
            originState: lane.originState,
            destination: lane.destination,
            destinationState: lane.destinationState,
            equipmentType: lane.equipmentType,
            companyName: lane.companyName,
            fitScore: Math.min(100, score),
            whyThisLane,
            weeklyFrequency: lane.avgLoadsPerWeek ? parseFloat(String(lane.avgLoadsPerWeek)) : null,
            laneScore: lane.laneScore,
          };
        })
        .filter((l): l is NonNullable<typeof l> => l !== null)
        .sort((a, b) => b.fitScore - a.fitScore)
        .slice(0, 10);

      res.json({ lanes: scored });
    } catch (err) {
      console.error("[carrier-hub] best-lanes error:", err);
      res.status(500).json({ error: "Failed to compute best lanes" });
    }
  });

  // ── DETAIL ────────────────────────────────────────────────────────────────
  app.get("/api/carrier-hub/:id", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id } = req.params;

      // Base carrier record
      const [carrier] = await db
        .select()
        .from(carriers)
        .where(and(eq(carriers.id, id), eq(carriers.orgId, org)));

      if (!carrier) return res.status(404).json({ error: "Carrier not found" });

      // Contacts
      const contacts = await db
        .select()
        .from(carrierContacts)
        .where(eq(carrierContacts.carrierId, id))
        .orderBy(desc(carrierContacts.isPrimary), asc(carrierContacts.name));

      // Claimed lanes
      const claimedLanes = await db
        .select()
        .from(carrierClaimedLanes)
        .where(eq(carrierClaimedLanes.carrierId, id))
        .orderBy(asc(carrierClaimedLanes.laneType), asc(carrierClaimedLanes.originState));

      // Proven lane history from lane_carrier_interest (read-only, system-derived)
      const provenHistory = await storage.pool.query(
        `
        SELECT
          lci.id,
          lci.lane_id,
          lci.carrier_name,
          lci.fit_score,
          lci.interest_status,
          lci.source_type,
          lci.updated_at,
          rl.origin_city, rl.origin_state, rl.dest_city, rl.dest_state,
          rl.equipment_type, rl.avg_loads_per_week, rl.weeks_active,
          rl.company_name,
          rl.resolved_at
        FROM lane_carrier_interest lci
        JOIN recurring_lanes rl ON rl.id = lci.lane_id
        WHERE lci.carrier_id = $1
        ORDER BY lci.updated_at DESC
        LIMIT 50
        `,
        [id]
      );

      // Outreach activity
      const outreachActivity = await storage.pool.query(
        `
        SELECT
          col.id, col.lane_id, col.timestamp, col.delivery_status,
          col.sent_at, col.recipients,
          rl.origin_city, rl.origin_state, rl.dest_city, rl.dest_state,
          rl.company_name
        FROM carrier_outreach_logs col
        JOIN recurring_lanes rl ON rl.id = col.lane_id
        WHERE $1 = ANY(col.carrier_ids)
        ORDER BY col.timestamp DESC
        LIMIT 30
        `,
        [id]
      );

      // Aggregate stats
      const stats = {
        provenLaneCount: provenHistory.rows.length,
        outreachSentCount: outreachActivity.rows.length,
        positiveOutcomes: provenHistory.rows.filter(r => r.interest_status === "available" || r.interest_status === "available_next_week").length,
        lastUsed: provenHistory.rows[0]?.updated_at ?? null,
        contactReadiness: contacts.length > 0 && contacts.some(c => c.email || c.phone) ? "ready" : carrier.primaryEmail || carrier.phone ? "partial" : "missing",
      };

      res.json({
        carrier,
        contacts,
        claimedLanes,
        provenHistory: provenHistory.rows,
        outreachActivity: outreachActivity.rows,
        stats,
      });
    } catch (err) {
      console.error("[carrier-hub] detail error:", err);
      res.status(500).json({ error: "Failed to load carrier detail" });
    }
  });

  // ── CREATE ────────────────────────────────────────────────────────────────
  app.post("/api/carrier-hub", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const parsed = insertCarrierSchema.safeParse({ ...req.body, orgId: org });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const [created] = await db.insert(carriers).values(parsed.data).returning();
      res.status(201).json(created);
    } catch (err) {
      console.error("[carrier-hub] create error:", err);
      res.status(500).json({ error: "Failed to create carrier" });
    }
  });

  // ── UPDATE CARRIER PROFILE ────────────────────────────────────────────────
  app.patch("/api/carrier-hub/:id", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id } = req.params;
      const allowedFields = [
        "name", "legalName", "mcDot", "dotNumber", "status", "phone",
        "city", "state", "primaryEmail", "backupEmail", "notes",
        "equipmentTypes", "equipmentNotes", "tags", "regions",
        "statesServed", "metroAreas",
      ] as const;
      const updates: Record<string, unknown> = {};
      for (const f of allowedFields) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      }
      updates.updatedAt = new Date();
      const [updated] = await db
        .update(carriers)
        .set(updates as any)
        .where(and(eq(carriers.id, id), eq(carriers.orgId, org)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Carrier not found" });
      res.json(updated);
    } catch (err) {
      console.error("[carrier-hub] update error:", err);
      res.status(500).json({ error: "Failed to update carrier" });
    }
  });

  // ── CONTACTS ──────────────────────────────────────────────────────────────
  app.post("/api/carrier-hub/:id/contacts", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id } = req.params;
      // Verify org ownership
      const [c] = await db.select({ id: carriers.id }).from(carriers).where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!c) return res.status(404).json({ error: "Carrier not found" });
      const parsed = insertCarrierContactSchema.safeParse({ ...req.body, carrierId: id });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      // If isPrimary, demote others
      if (parsed.data.isPrimary) {
        await db.update(carrierContacts).set({ isPrimary: false }).where(eq(carrierContacts.carrierId, id));
      }
      const [created] = await db.insert(carrierContacts).values(parsed.data).returning();
      res.status(201).json(created);
    } catch (err) {
      console.error("[carrier-hub] add contact error:", err);
      res.status(500).json({ error: "Failed to add contact" });
    }
  });

  app.patch("/api/carrier-hub/:id/contacts/:contactId", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id, contactId } = req.params;
      const [c] = await db.select({ id: carriers.id }).from(carriers).where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!c) return res.status(404).json({ error: "Carrier not found" });
      const allowedFields = ["name", "role", "email", "phone", "extension", "preferredMethod", "notes", "isPrimary", "isActive"] as const;
      const updates: Record<string, unknown> = {};
      for (const f of allowedFields) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
      }
      if (updates.isPrimary) {
        await db.update(carrierContacts).set({ isPrimary: false }).where(eq(carrierContacts.carrierId, id));
      }
      updates.updatedAt = new Date();
      const [updated] = await db
        .update(carrierContacts)
        .set(updates as any)
        .where(and(eq(carrierContacts.id, contactId), eq(carrierContacts.carrierId, id)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Contact not found" });
      res.json(updated);
    } catch (err) {
      console.error("[carrier-hub] update contact error:", err);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/carrier-hub/:id/contacts/:contactId", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id, contactId } = req.params;
      const [c] = await db.select({ id: carriers.id }).from(carriers).where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!c) return res.status(404).json({ error: "Carrier not found" });
      await db.delete(carrierContacts).where(and(eq(carrierContacts.id, contactId), eq(carrierContacts.carrierId, id)));
      res.json({ success: true });
    } catch (err) {
      console.error("[carrier-hub] delete contact error:", err);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  // ── CLAIMED LANES ─────────────────────────────────────────────────────────
  app.post("/api/carrier-hub/:id/claimed-lanes", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id } = req.params;
      const [c] = await db.select({ id: carriers.id }).from(carriers).where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!c) return res.status(404).json({ error: "Carrier not found" });
      const parsed = insertCarrierClaimedLaneSchema.safeParse({ ...req.body, carrierId: id });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      const [created] = await db.insert(carrierClaimedLanes).values(parsed.data).returning();
      res.status(201).json(created);
    } catch (err) {
      console.error("[carrier-hub] add claimed lane error:", err);
      res.status(500).json({ error: "Failed to add claimed lane" });
    }
  });

  app.delete("/api/carrier-hub/:id/claimed-lanes/:laneId", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id, laneId } = req.params;
      const [c] = await db.select({ id: carriers.id }).from(carriers).where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!c) return res.status(404).json({ error: "Carrier not found" });
      await db.delete(carrierClaimedLanes).where(and(eq(carrierClaimedLanes.id, laneId), eq(carrierClaimedLanes.carrierId, id)));
      res.json({ success: true });
    } catch (err) {
      console.error("[carrier-hub] delete claimed lane error:", err);
      res.status(500).json({ error: "Failed to delete claimed lane" });
    }
  });
}
