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
  carrierMarketNbas,
  marketSignals,
  insertCarrierSchema,
  insertCarrierContactSchema,
  insertCarrierClaimedLaneSchema,
} from "@shared/schema";
import { eq, and, desc, asc, inArray } from "drizzle-orm";

// ── helpers ────────────────────────────────────────────────────────────────────

function orgId(req: Express.Request): string {
  // Session-based auth: organizationId is stored in req.session, not req.user
  return (req as any).session?.organizationId as string;
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
          ${equipFilter ? `AND EXISTS (SELECT 1 FROM unnest(c.equipment_types) et WHERE et ILIKE '%${equipFilter.replace(/'/g, "''")}%')` : ""}
        GROUP BY c.id
        HAVING 1=1
          ${hasProvenHistory === "true" ? `AND COUNT(DISTINCT lci.id) FILTER (WHERE lci.carrier_id = c.id) > 0` : ""}
          ${hasClaimedLanes === "true" ? `AND COUNT(DISTINCT ccl.id) > 0` : ""}
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

      const rows = result.rows;

      // Get total count — use identical filters as the main list query
      const countResult = await storage.pool.query(
        `
        SELECT COUNT(*) FROM (
          SELECT c.id
          FROM carriers c
          LEFT JOIN lane_carrier_interest lci ON lci.carrier_id = c.id
          LEFT JOIN carrier_contacts cc ON cc.carrier_id = c.id AND cc.is_active = true
          LEFT JOIN carrier_claimed_lanes ccl ON ccl.carrier_id = c.id
          WHERE c.org_id = $1
            ${q ? `AND (c.name ILIKE $2 OR c.mc_dot ILIKE $2 OR c.dot_number ILIKE $2 OR c.primary_email ILIKE $2 OR c.phone ILIKE $2)` : ""}
            ${statusFilter ? `AND c.status = '${statusFilter.replace(/'/g, "''")}'` : ""}
            ${hasEmail === "true" ? `AND c.primary_email IS NOT NULL` : ""}
            ${hasPhone === "true" ? `AND c.phone IS NOT NULL` : ""}
            ${equipFilter ? `AND EXISTS (SELECT 1 FROM unnest(c.equipment_types) et WHERE et ILIKE '%${equipFilter.replace(/'/g, "''")}%')` : ""}
          GROUP BY c.id
          HAVING 1=1
            ${hasProvenHistory === "true" ? `AND COUNT(DISTINCT lci.id) FILTER (WHERE lci.carrier_id = c.id) > 0` : ""}
            ${hasClaimedLanes === "true" ? `AND COUNT(DISTINCT ccl.id) > 0` : ""}
        ) subq
        `,
        q ? [org, `%${q}%`] : [org]
      );
      const total = parseInt(countResult.rows[0].count);

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
  // Fast path: base profile + contacts + claimed lanes only
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

      const contactReadiness = contacts.length > 0 && contacts.some(c => c.email || c.phone)
        ? "ready"
        : carrier.primaryEmail || carrier.phone
        ? "partial"
        : "missing";

      res.json({
        carrier,
        contacts,
        claimedLanes,
        // Include empty arrays so the frontend doesn't need to guard against undefined
        provenHistory: [],
        outreachActivity: [],
        stats: {
          provenLaneCount: 0,
          outreachSentCount: 0,
          positiveOutcomes: 0,
          lastUsed: null,
          contactReadiness,
        },
      });
    } catch (err) {
      console.error("[carrier-hub] detail error:", err);
      res.status(500).json({ error: "Failed to load carrier detail" });
    }
  });

  // ── ACTIVITY (lazy) ───────────────────────────────────────────────────────
  // Heavy sub-queries loaded on demand: proven history + outreach logs
  app.get("/api/carrier-hub/:id/activity", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id } = req.params;

      // Get full carrier record (need name + payeeCode for TMS history lookup)
      const [c] = await db
        .select({ id: carriers.id, name: carriers.name, payeeCode: carriers.payeeCode })
        .from(carriers)
        .where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!c) return res.status(404).json({ error: "Carrier not found" });

      // Proven lane history from lane_carrier_interest (read-only, system-derived)
      const [provenHistory, outreachActivity] = await Promise.all([
        storage.pool.query(
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
        ),
        // Outreach activity — can be slow on large carrier_outreach_logs tables
        storage.pool.query(
          `
          SELECT
            col.id, col.lane_id, col.timestamp, col.delivery_status,
            col.sent_at, col.recipients, col.thread_id,
            rl.origin_city, rl.origin_state, rl.dest_city, rl.dest_state,
            rl.company_name
          FROM carrier_outreach_logs col
          JOIN recurring_lanes rl ON rl.id = col.lane_id
          WHERE $1 = ANY(col.carrier_ids)
          ORDER BY col.timestamp DESC
          LIMIT 30
          `,
          [id]
        ),
      ]);

      // TMS history: pull from financial uploads for this carrier by payee code or name.
      // This surfaces historical load data that predates the Carrier Hub catalog.
      const tmsLaneSummary = await buildCarrierTmsHistory(org, c.payeeCode, c.name);

      const stats = {
        provenLaneCount: provenHistory.rows.length,
        outreachSentCount: outreachActivity.rows.length,
        positiveOutcomes: provenHistory.rows.filter(
          r => r.interest_status === "available" || r.interest_status === "available_next_week"
        ).length,
        lastUsed: provenHistory.rows[0]?.updated_at ?? null,
        tmsLaneCount: tmsLaneSummary.length,
        tmsTotalLoads: tmsLaneSummary.reduce((sum, l) => sum + l.loads, 0),
      };

      res.json({
        provenHistory: provenHistory.rows,
        outreachActivity: outreachActivity.rows,
        tmsHistory: tmsLaneSummary,
        stats,
      });
    } catch (err) {
      console.error("[carrier-hub] activity error:", err);
      res.status(500).json({ error: "Failed to load carrier activity" });
    }
  });

  /**
   * Aggregate TMS lane history for a carrier from financial uploads.
   * Matches by payee code (most reliable) or carrier name (fallback).
   * Returns top lanes sorted by load count descending.
   */
  async function buildCarrierTmsHistory(
    orgId: string,
    payeeCode: string | null,
    carrierName: string,
  ): Promise<Array<{
    origin: string;
    destination: string;
    originState: string;
    destState: string;
    loads: number;
    lastMonth: string | null;
  }>> {
    try {
      const uploads = await storage.getFinancialUploadsForOrg(orgId);
      if (!uploads.length) return [];

      const normStr = (s: string) => (s ?? "").trim().toLowerCase();
      const carrierNorm = normStr(carrierName);
      const payeeNorm = payeeCode ? payeeCode.toLowerCase() : null;

      /** Parse clean carrier name from "PAYCODE - NAME" TMS format */
      function parseName(raw: string): string {
        const match = raw.trim().match(/^[A-Z0-9]{2,12}\s+-\s+(.+)$/i);
        return match ? match[1].trim() : raw.trim();
      }
      /** Extract payee code from "PAYCODE - NAME" TMS format */
      function parsePayee(raw: string): string | null {
        const match = raw.trim().match(/^([A-Z0-9]{2,12})\s+-\s+.+$/i);
        return match ? match[1].toUpperCase() : null;
      }
      /** Normalize month "2026 M03" → "2026-03" */
      function normMonth(raw: string): string {
        const m = raw.trim().match(/^(\d{4})\s+M(\d{1,2})$/i);
        if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
        if (/^\d{4}-\d{2}/.test(raw)) return raw.slice(0, 7);
        return raw.slice(0, 7);
      }
      /** Extract city from "CITY, ST" format */
      function extractCity(raw: string): string {
        const ci = raw.lastIndexOf(",");
        return ci > 0 ? raw.slice(0, ci).trim() : raw.trim();
      }
      function readField(row: Record<string, unknown>, ...keys: string[]): string {
        for (const k of keys) {
          const v = row[k];
          if (v !== undefined && v !== null && v !== "") return String(v);
        }
        return "";
      }

      const laneSummary = new Map<string, { origin: string; destination: string; originState: string; destState: string; loads: number; lastMonth: string | null }>();

      const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
      for (const upload of sorted.slice(0, 3)) {
        const rows = (upload.rows as Record<string, unknown>[]) ?? [];
        for (const row of rows) {
          const rawCarrier = readField(row, "carrier", "carrierName", "carrier_name", "Carrier", "Carrier name");
          if (!rawCarrier) continue;

          // Match by payee code (preferred) or by normalized carrier name (fallback)
          const rowPayee = parsePayee(rawCarrier);
          const rowNameNorm = normStr(parseName(rawCarrier));
          const matches = (payeeNorm && rowPayee && rowPayee.toLowerCase() === payeeNorm) ||
                          rowNameNorm === carrierNorm;
          if (!matches) continue;

          const rawOriginCity = readField(row, "shipperCity", "originCity", "Shipper city", "Origin city");
          const rawOriginFull = readField(row, "origin", "Origin");
          const origin = extractCity(rawOriginCity || rawOriginFull).toUpperCase() || "(unknown)";
          const originState = readField(row, "shipperState", "originState", "Shipper state", "Origin state").toUpperCase();

          const rawDestCity = readField(row, "consigneeCity", "destinationCity", "Consignee city", "Destination city");
          const rawDestFull = readField(row, "destination", "Destination");
          const dest = extractCity(rawDestCity || rawDestFull).toUpperCase() || "(unknown)";
          const destState = readField(row, "consigneeState", "destinationState", "destState", "Consignee state", "Destination state").toUpperCase();

          const month = normMonth(readField(row, "month", "Month"));
          const laneKey = `${origin}|${originState}|${dest}|${destState}`;

          const existing = laneSummary.get(laneKey);
          if (existing) {
            existing.loads++;
            if (month > (existing.lastMonth ?? "")) existing.lastMonth = month;
          } else {
            laneSummary.set(laneKey, { origin, destination: dest, originState, destState, loads: 1, lastMonth: month || null });
          }
        }
      }

      return Array.from(laneSummary.values())
        .sort((a, b) => b.loads - a.loads)
        .slice(0, 50);
    } catch {
      return [];
    }
  }

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

  // ── INTELLIGENCE SUMMARY ──────────────────────────────────────────────────
  // GET /api/carrier-hub/:id/intelligence
  // Returns carrier basics, lane history snapshot, declared preferences,
  // active market NBAs, and suggestions split by status.
  app.get("/api/carrier-hub/:id/intelligence", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { id } = req.params;

      const [carrier] = await db
        .select()
        .from(carriers)
        .where(and(eq(carriers.id, id), eq(carriers.orgId, org)));
      if (!carrier) return res.status(404).json({ error: "Carrier not found" });

      const [claimedLanes, allSuggestions] = await Promise.all([
        db.select().from(carrierClaimedLanes)
          .where(eq(carrierClaimedLanes.carrierId, id))
          .orderBy(asc(carrierClaimedLanes.laneType), asc(carrierClaimedLanes.originState)),
        storage.getSuggestionsForCarrier(id),
      ]);

      // Build lane history snapshot from lane_carrier_interest + carrier profile
      const historyResult = await storage.pool.query<{
        top_origin: string | null;
        top_dest: string | null;
        equipment: string | null;
        load_count: string;
      }>(
        `SELECT
          rl.origin_state AS top_origin,
          rl.dest_state AS top_dest,
          rl.equipment_type AS equipment,
          COUNT(*) AS load_count
        FROM lane_carrier_interest lci
        JOIN recurring_lanes rl ON rl.id = lci.lane_id
        WHERE lci.carrier_id = $1
        GROUP BY rl.origin_state, rl.dest_state, rl.equipment_type
        ORDER BY load_count DESC
        LIMIT 10`,
        [id]
      );

      // Active market NBAs for this carrier (joined with signals for labels)
      const activeNbas = await db
        .select({
          id: carrierMarketNbas.id,
          recommendationType: carrierMarketNbas.recommendationType,
          status: carrierMarketNbas.status,
          urgencyScore: carrierMarketNbas.urgencyScore,
          explanation: carrierMarketNbas.explanation,
          createdAt: carrierMarketNbas.createdAt,
          signalType: marketSignals.signalType,
          signalScopeKey: marketSignals.scopeKey,
          signalEquipmentType: marketSignals.equipmentType,
          signalSeverity: marketSignals.severity,
        })
        .from(carrierMarketNbas)
        .leftJoin(marketSignals, eq(marketSignals.id, carrierMarketNbas.marketSignalId))
        .where(and(
          eq(carrierMarketNbas.carrierId, id),
          inArray(carrierMarketNbas.status, ["pending", "in_progress"])
        ))
        .orderBy(desc(carrierMarketNbas.urgencyScore))
        .limit(10);

      const pending = allSuggestions.filter(s => s.status === "pending");
      const accepted = allSuggestions.filter(s => s.status === "accepted" || s.status === "auto_accepted");
      const rejected = allSuggestions.filter(s => s.status === "rejected");

      res.json({
        carrier: {
          id: carrier.id,
          name: carrier.name,
          mcDot: carrier.mcDot,
          status: carrier.status,
        },
        historySnapshot: {
          topLanes: historyResult.rows.map(r => ({
            origin: r.top_origin,
            destination: r.top_dest,
            equipment: r.equipment,
            loadCount: parseInt(r.load_count),
          })),
          equipmentTypes: carrier.equipmentTypes ?? [],
          regions: carrier.regions ?? [],
          statesServed: carrier.statesServed ?? [],
        },
        declaredPreferences: claimedLanes,
        activeMarketNbas: activeNbas,
        suggestions: { pending, accepted, rejected },
      });
    } catch (err) {
      console.error("[carrier-hub] intelligence error:", err);
      res.status(500).json({ error: "Failed to load carrier intelligence" });
    }
  });

  // ── SUGGESTIONS: ACCEPT / REJECT ─────────────────────────────────────────
  // PATCH /api/carrier-hub/suggestions/:suggestionId/accept
  app.patch("/api/carrier-hub/suggestions/:suggestionId/accept", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { suggestionId } = req.params;
      const { comment } = req.body ?? {};
      const userId = (req as any).session?.userId as string | undefined;

      const suggestion = await storage.getSuggestionById(suggestionId);
      if (!suggestion) return res.status(404).json({ error: "Suggestion not found" });

      // Org scope check via carrier
      const [carrier] = await db.select({ id: carriers.id })
        .from(carriers)
        .where(and(eq(carriers.id, suggestion.carrierId), eq(carriers.orgId, org)));
      if (!carrier) return res.status(403).json({ error: "Forbidden" });

      const updated = await storage.updateSuggestionStatus(suggestionId, "accepted", {
        userId,
        comment: typeof comment === "string" ? comment : undefined,
      });
      res.json(updated);
    } catch (err) {
      console.error("[carrier-hub] accept suggestion error:", err);
      res.status(500).json({ error: "Failed to accept suggestion" });
    }
  });

  // PATCH /api/carrier-hub/suggestions/:suggestionId/reject
  app.patch("/api/carrier-hub/suggestions/:suggestionId/reject", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { suggestionId } = req.params;
      const { comment } = req.body ?? {};
      const userId = (req as any).session?.userId as string | undefined;

      const suggestion = await storage.getSuggestionById(suggestionId);
      if (!suggestion) return res.status(404).json({ error: "Suggestion not found" });

      const [carrier] = await db.select({ id: carriers.id })
        .from(carriers)
        .where(and(eq(carriers.id, suggestion.carrierId), eq(carriers.orgId, org)));
      if (!carrier) return res.status(403).json({ error: "Forbidden" });

      const updated = await storage.updateSuggestionStatus(suggestionId, "rejected", {
        userId,
        comment: typeof comment === "string" ? comment : undefined,
      });
      res.json(updated);
    } catch (err) {
      console.error("[carrier-hub] reject suggestion error:", err);
      res.status(500).json({ error: "Failed to reject suggestion" });
    }
  });
}
