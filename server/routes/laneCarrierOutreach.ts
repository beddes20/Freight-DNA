/**
 * Lane Carrier Outreach Routes — Task #148
 *
 * All endpoints for the recurring lane capacity + carrier outreach workflow.
 * Gated behind lane_carrier_outreach_v1 feature flag.
 *
 * ENDPOINT INTENT AUDIT (Task #200):
 *
 * GET /api/recurring-lanes/work-queue
 *   PURPOSE: Lean list for the Lane Work Queue page.
 *   RETURNS: Lane identity fields (id, origin, destination, equipment, scores, owner,
 *            carriersContactedCount, bench counts) plus replySummary.
 *   RENDERED: laneLabel, score badge, frequency badge, coverage badge, reply badge,
 *             owner name, contacted progress, assignment controls.
 *   NOT RETURNED: full carrier bench arrays, nested history objects, laneScoreFactors,
 *                 lastScoredAt, assignedByUserId (stripped in the route handler).
 *   PAGINATION: limit + cursor (keyset by laneScore DESC, laneId).
 *
 * GET /api/recurring-lanes/:id/detail
 *   PURPOSE: Full enriched lane detail, fetched only when CarrierOutreachPanel opens.
 *   RETURNS: replySummary (totalReplied, hotCount, topStatus, topCarrierName, needsAction),
 *            bench counts, matched award task info.
 *
 * GET /api/my-procurement
 *   PURPOSE: Personal procurement list — lean shape, no per-lane enrichment.
 *   RETURNS: lwqLanes (lean list fields, no replySummary) + awardTasks (lean subset only).
 *   PAGINATION: limit + cursor on both buckets.
 */

import type { Express, Response } from "express";
import multer from "multer";
import XLSX from "xlsx";
import { storage, db, CARRIER_DAILY_BUDGET_CONFIG } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { rankCarriersForLane, isHighFrequencyLane, buildHighFrequencyIndex, isHighFrequencyLaneFromIndex, HIGH_FREQUENCY_CONFIG } from "../carrierRankingService";
import { runRecurringLaneEngineForOrg, LANE_CONFIG } from "../recurringLaneCapacityEngine";
import { scoreAllEligibleLanes, scoreLane } from "../laneScoringService";
import { getLaneCoverageProfile, shouldUseIncumbentFirstFlow } from "../laneCoverageService";
import { insertCarrierSchema, insertLaneCarrierInterestSchema, carrierClaimedLanes, type InsertCarrier, type Carrier } from "@shared/schema";
import { formatLaneDisplay, formatWeeklyLoadRange, normalizeEquipmentType, buildFallbackEmail as buildFallbackEmailHelper } from "../laneOutreachEmailBuilder";
import { z } from "zod";
import { inArray, eq } from "drizzle-orm";
import { sendEmail } from "../emailService";
import { setEmailLiveMode, EMAIL_LIVE_MODE_FLAG } from "../emailGate";
import { sendOutlookEmail, outlookEnabled } from "../outlookService";
import { getGraphAccessToken } from "../graphService";
import { getReplyTrackingStatus } from "../graphSubscriptionService";
import { logOutboundCarrierEmail, logInboundCarrierEmail } from "../emailIntelligenceService";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * Module-level cache for the HF index. Keyed by "orgId:uploadFingerprint".
 * Each entry is built once from TMS rows and reused for 5 min — eliminating the
 * O(lanes × rows) per-request scan that was the #1 work-queue bottleneck.
 */
const _hfIndexCache = new Map<string, { index: Map<string, number>; expiresAt: number }>();
const HF_INDEX_TTL_MS = 5 * 60 * 1000;

function getHfIndex(orgId: string, uploads: import("@shared/schema").FinancialUpload[]): Map<string, number> {
  const fingerprint = uploads
    .slice()
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    .slice(0, 3)
    .map(u => u.id)
    .join(":");
  const cacheKey = `${orgId}:${fingerprint}`;
  const cached = _hfIndexCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.index;
  const index = buildHighFrequencyIndex(uploads);
  _hfIndexCache.set(cacheKey, { index, expiresAt: Date.now() + HF_INDEX_TTL_MS });
  return index;
}

async function isFeatureEnabled(orgId: string): Promise<boolean> {
  return storage.getFeatureFlag(orgId, "lane_carrier_outreach_v1");
}

/** Returns true if feature flag is on; sends 403 and returns false if off. */
async function assertFlagEnabled(orgId: string, res: Response): Promise<boolean> {
  const enabled = await isFeatureEnabled(orgId);
  if (!enabled) {
    res.status(403).json({ error: "Feature lane_carrier_outreach_v1 is not enabled for this organization" });
    return false;
  }
  return true;
}

const ADMIN_ROLES = ["admin", "director"];

/**
 * Fetches a lane, verifies org membership, and enforces lane-level ownership:
 * - Admins/Directors can access any lane in their org.
 * - Other users can only access lanes where they are owner or overseer.
 * Returns the lane on success; sends the error response and returns null on failure.
 */
async function getLaneWithAccessCheck(
  laneId: string,
  user: { id: string; role: string; organizationId: string },
  res: Response,
) {
  const lane = await storage.getRecurringLane(laneId);
  if (!lane || lane.orgId !== user.organizationId) {
    res.status(404).json({ error: "Lane not found" });
    return null;
  }
  if (
    !ADMIN_ROLES.includes(user.role) &&
    lane.ownerUserId !== user.id &&
    lane.overseerUserId !== user.id
  ) {
    res.status(403).json({ error: "Access denied: you are not the owner or overseer of this lane" });
    return null;
  }
  return lane;
}

/**
 * Read-only lane accessor: verifies the lane belongs to the user's org.
 * Does NOT enforce ownership — any authenticated org member can read lane data.
 * Use this for GET endpoints; use getLaneWithAccessCheck for write operations.
 */
async function getLaneForOrg(
  laneId: string,
  user: { id: string; organizationId: string },
  res: Response,
) {
  const lane = await storage.getRecurringLane(laneId);
  if (!lane || lane.orgId !== user.organizationId) {
    res.status(404).json({ error: "Lane not found" });
    return null;
  }
  return lane;
}

export function registerLaneCarrierOutreachRoutes(app: Express): void {

  // ── Feature Flag ───────────────────────────────────────────────────────────

  app.get("/api/feature-flags/:key", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const enabled = await storage.getFeatureFlag(user.organizationId, req.params.key);
    res.json({ key: req.params.key, enabled });
  });

  app.patch("/api/feature-flags/:key", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!ADMIN_ROLES.includes(user.role)) return res.status(403).json({ error: "Admin/Director only" });
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be boolean" });
    await storage.setFeatureFlag(user.organizationId, req.params.key, enabled, user.id);
    // Keep the in-memory email gate in sync whenever the live-mode flag is toggled.
    if (req.params.key === EMAIL_LIVE_MODE_FLAG) {
      setEmailLiveMode(enabled);
    }
    res.json({ success: true });
  });

  // ── Carrier Catalog ────────────────────────────────────────────────────────
  // Intentionally role-gated (admin/director) rather than flag-gated:
  // admins need to seed the carrier catalog *before* enabling the feature flag,
  // so gating it behind lane_carrier_outreach_v1 would create a pre-launch catch-22.

  app.get("/api/carriers", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!ADMIN_ROLES.includes(user.role)) {
      return res.status(403).json({ error: "Director/Admin only" });
    }
    const list = await storage.getCarriers(user.organizationId);
    res.json(list);
  });

  app.post("/api/carriers", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!ADMIN_ROLES.includes(user.role)) {
      return res.status(403).json({ error: "Director/Admin only" });
    }
    const parsed = insertCarrierSchema.safeParse({ ...req.body, orgId: user.organizationId });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const carrier = await storage.createCarrier(parsed.data);
    res.status(201).json(carrier);
  });

  // ── Phase 2: External Carrier Import + Sourcing Performance ──────────────

  /** GET /api/carriers/sourcing-performance — per-channel analytics */
  app.get("/api/carriers/sourcing-performance", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    try {
      const channels = await storage.getCarrierSourcingPerformance(user.organizationId);
      res.json(channels);
    } catch (err) {
      console.error("[sourcing-performance] error:", err);
      res.status(500).json({ error: "Failed to fetch sourcing performance" });
    }
  });

  /** POST /api/carriers/import — import carriers without lane context */
  app.post("/api/carriers/import", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const schema = z.object({
      carriers: z.array(z.object({
        name: z.string().min(1),
        email: z.string().email().optional().or(z.literal("")),
        phone: z.string().optional(),
        mcDot: z.string().optional(),
      })).min(1).max(200),
      source: z.string().min(1).max(64),
      rawInput: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const { batch, results } = await storage.importCarriersForLane(
        user.organizationId, null, user.id,
        parsed.data.carriers.map(c => ({ ...c, email: c.email || undefined })),
        parsed.data.source,
        parsed.data.rawInput
      );
      res.status(201).json({ batch, results });
    } catch (err) {
      console.error("[carriers/import] error:", err);
      res.status(500).json({ error: "Import failed" });
    }
  });

  /** GET /api/carriers/import-batches — list all org import batches */
  app.get("/api/carriers/import-batches", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const batches = await storage.getCarrierImportBatches(user.organizationId);
    res.json(batches);
  });

  app.patch("/api/carriers/:id", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!ADMIN_ROLES.includes(user.role)) {
      return res.status(403).json({ error: "Director/Admin only" });
    }
    // Tenant isolation: verify carrier belongs to this org before updating
    const existing = await storage.getCarrier(req.params.id);
    if (!existing || existing.orgId !== user.organizationId) {
      return res.status(404).json({ error: "Carrier not found" });
    }
    // Allowlist: only mutable fields — never allow orgId, id, or timestamps via body
    const { name, mcDot, regions, equipmentTypes, tags, primaryEmail, backupEmail, notes, lastEmailValidatedAt } = req.body;
    const allowedData: Record<string, unknown> = {};
    if (name !== undefined) allowedData.name = name;
    if (mcDot !== undefined) allowedData.mcDot = mcDot;
    if (regions !== undefined) allowedData.regions = regions;
    if (equipmentTypes !== undefined) allowedData.equipmentTypes = equipmentTypes;
    if (tags !== undefined) allowedData.tags = tags;
    if (primaryEmail !== undefined) allowedData.primaryEmail = primaryEmail;
    if (backupEmail !== undefined) allowedData.backupEmail = backupEmail;
    if (notes !== undefined) allowedData.notes = notes;
    if (lastEmailValidatedAt !== undefined) allowedData.lastEmailValidatedAt = lastEmailValidatedAt;
    const carrier = await storage.updateCarrier(req.params.id, user.organizationId, allowedData);
    if (!carrier) return res.status(404).json({ error: "Carrier not found" });
    res.json(carrier);
  });

  app.delete("/api/carriers/:id", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!["admin", "director"].includes(user.role)) {
      return res.status(403).json({ error: "Admin/Director only" });
    }
    // Tenant isolation: verify carrier belongs to this org before deleting
    const existing = await storage.getCarrier(req.params.id);
    if (!existing || existing.orgId !== user.organizationId) {
      return res.status(404).json({ error: "Carrier not found" });
    }
    const ok = await storage.deleteCarrier(req.params.id, user.organizationId);
    if (!ok) return res.status(404).json({ error: "Carrier not found" });
    res.json({ success: true });
  });

  // ── Bulk delete carriers ───────────────────────────────────────────────────
  app.delete("/api/carriers", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!ADMIN_ROLES.includes(user.role)) return res.status(403).json({ error: "Admin/Director only" });
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    if (ids.some(id => typeof id !== "string")) return res.status(400).json({ error: "All ids must be strings" });
    const deleted = await storage.bulkDeleteCarriers(ids, user.organizationId);
    res.json({ deleted });
  });

  // ── Carrier Excel Seed ─────────────────────────────────────────────────────

  app.post("/api/admin/carriers/seed-from-excel", upload.single("file"), async (req, res, next) => {
    try {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!ADMIN_ROLES.includes(user.role)) return res.status(403).json({ error: "Admin/Director only" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" }) as Record<string, unknown>[];

      if (rows.length === 0) return res.json({ mode: "empty", total: 0 });

      const originalKeys = Object.keys(rows[0]);
      const headers = originalKeys.map(h => h.toLowerCase().trim());

      /** Case-insensitive substring column finder. First keyword wins. */
      function findCol(keywords: string[]): string | null {
        for (const kw of keywords) {
          // Prefer exact match first, then substring
          const exact = headers.findIndex(h => h === kw);
          if (exact >= 0) return originalKeys[exact];
        }
        for (const kw of keywords) {
          const idx = headers.findIndex(h => h.includes(kw));
          if (idx >= 0) return originalKeys[idx];
        }
        return null;
      }

      function str(row: Record<string, unknown>, col: string | null): string {
        return col ? String(row[col] ?? "").trim() : "";
      }

      // ── File type detection ──────────────────────────────────────────────────
      //
      // FINANCIAL/TMS file:  has a "payee code" (or "payee") column alongside
      //   load-level context (customer + shipper/consignee/origin/dest).
      //   One row per load — many rows per carrier.
      //
      // CARRIER ROLODEX file: has a "payee code" column alongside carrier
      //   master-data columns (MC number, phone number, contact email) but
      //   NOT load-level customer/shipper columns.
      //
      // LEGACY DIRECTORY file: no payee code — name/company based, one row per carrier.

      const hasPayeeCol     = headers.some(h => h === "payee code" || h === "payee");
      const hasCustomerCol  = headers.some(h => h === "customer" || h.startsWith("customer "));
      const hasLoadContext  = headers.some(h =>
        h.includes("shipper") || h.includes("consignee") ||
        h.includes("origin city") || h.includes("dest city") || h.includes("delivery date"));
      const hasRolodexCols  = headers.some(h => h === "phone number" || h === "contact email" || h === "mc number");

      type FileMode = "financial" | "rolodex" | "directory";
      let mode: FileMode;
      if (hasPayeeCol && (hasCustomerCol || hasLoadContext)) {
        mode = "financial";
      } else if (hasPayeeCol && hasRolodexCols) {
        mode = "rolodex";
      } else {
        mode = "directory";
      }

      const orgId = user.organizationId;

      // ════════════════════════════════════════════════════════════════════════
      // MODE A — FINANCIAL / TMS FILE
      // ════════════════════════════════════════════════════════════════════════
      if (mode === "financial") {
        const payeeCol = findCol(["payee code", "payee"]);
        const nameCol  = findCol(["carrier name", "carrier", "payee name"]);
        const equipCol = findCol(["equipment type", "equip type", "trailer type", "equipment", "equip", "service type", "mode", "load mode"]);

        // Aggregate per payee code → collect name + equipment types across all rows (in-memory)
        type FinAgg = { name: string; equipTypes: Set<string> };
        const byPayee = new Map<string, FinAgg>();
        let blankRows = 0;

        for (const row of rows) {
          const payee = str(row, payeeCol);
          if (!payee) { blankRows++; continue; }
          const key = payee.toLowerCase();
          if (!byPayee.has(key)) {
            byPayee.set(key, { name: str(row, nameCol) || payee, equipTypes: new Set() });
          }
          const equip = str(row, equipCol);
          if (equip) byPayee.get(key)!.equipTypes.add(equip);
        }

        // Load all existing payee codes in ONE query — avoids N individual lookups
        const existingAll = await storage.getCarriers(orgId);
        const existingPayeeCodes = new Set(
          existingAll.filter(c => c.payeeCode).map(c => c.payeeCode!.toLowerCase())
        );

        let alreadyExisted = 0;
        const toCreate: InsertCarrier[] = [];

        for (const [payeeKey, agg] of byPayee) {
          if (existingPayeeCodes.has(payeeKey)) { alreadyExisted++; continue; }
          toCreate.push({
            orgId,
            name: agg.name,
            payeeCode: payeeKey,
            mcDot: null, phone: null, city: null, state: null,
            primaryEmail: null, backupEmail: null,
            regions: [],
            equipmentTypes: Array.from(agg.equipTypes),
            tags: [],
          });
        }

        const created = await storage.bulkCreateCarriers(toCreate);

        return res.json({
          mode: "financial",
          total: rows.length,
          blankRowsSkipped: blankRows,
          uniqueCarriers: byPayee.size,
          created,
          alreadyExisted,
        });
      }

      // ════════════════════════════════════════════════════════════════════════
      // MODE B — CARRIER ROLODEX FILE
      // ════════════════════════════════════════════════════════════════════════
      if (mode === "rolodex") {
        const payeeCol  = findCol(["payee code", "payee"]);
        const nameCol   = findCol(["name", "legal name", "carrier name", "company name", "company"]);
        const mcCol          = findCol(["mc number", "mc#", "mc num", "mc"]);
        const phoneCol       = findCol(["phone number", "phone", "tel"]);
        const emailCol       = findCol(["contact email", "email"]);
        const cityCol        = findCol(["city"]);
        const stateCol       = findCol(["state"]);
        // Extended fields — captured when present in the source file
        const legalNameCol   = findCol(["legal name"]);
        const dotCol         = findCol(["dot number", "dot#", "dot num"]);
        const equipCol       = findCol(["primary equip type", "equipment type", "equip type", "trailer type", "equipment", "equip"]);
        const statusCol      = findCol(["activity status", "status"]);

        /** Map a raw TMS status string to the canonical carrier status enum. */
        function mapCarrierStatus(raw: string): "active" | "inactive" | "do_not_use" | null {
          const v = raw.toLowerCase().trim();
          if (v === "active")                            return "active";
          if (v === "inactive" || v === "suspended")    return "inactive";
          if (v === "do not use" || v === "do_not_use") return "do_not_use";
          return null;
        }

        // Load ALL existing carriers once — avoids N individual lookups per row
        const allExisting = await storage.getCarriers(orgId);
        const byPayee  = new Map(allExisting.filter(c => c.payeeCode).map(c => [c.payeeCode!.toLowerCase(), c]));
        const byMcDot  = new Map(allExisting.filter(c => c.mcDot).map(c => [c.mcDot!.trim().toUpperCase(), c]));
        const byName   = new Map(allExisting.map(c => [c.name.toLowerCase().trim(), c]));

        let blankRows    = 0;
        let matchedPayee = 0;
        let matchedMc    = 0;
        let matchedName  = 0;
        let upToDate     = 0;
        const conflicts: string[] = [];
        const toCreate: InsertCarrier[] = [];
        const toUpdate: Array<{ existing: Carrier; patch: Partial<Omit<InsertCarrier, 'orgId'>> }> = [];
        const createdNames = new Set<string>();

        for (const row of rows) {
          const payeeCode = str(row, payeeCol);
          const rawName   = str(row, nameCol);

          if (!payeeCode && !rawName) { blankRows++; continue; }

          const mcNumber       = str(row, mcCol);
          const phone          = str(row, phoneCol) || null;
          const email          = str(row, emailCol) || null;
          const city           = str(row, cityCol)  || null;
          const state          = str(row, stateCol) || null;
          const legalName      = str(row, legalNameCol) || null;
          const dotNumber      = str(row, dotCol) || null;
          const rawEquip       = str(row, equipCol);
          const equipmentTypes = rawEquip ? [rawEquip] : [];
          const mappedStatus   = statusCol ? mapCarrierStatus(str(row, statusCol)) : null;

          // ── Match priority (in-memory) ───────────────────────────────────────
          let existing: Carrier | undefined;
          let matchHow = "payee";

          if (payeeCode) existing = byPayee.get(payeeCode.toLowerCase());
          if (!existing && mcNumber) {
            existing = byMcDot.get(mcNumber.trim().toUpperCase());
            matchHow = "mc";
          }
          if (!existing && rawName) {
            existing = byName.get(rawName.toLowerCase().trim());
            matchHow = "name";
          }

          // ── No match → create ───────────────────────────────────────────────
          if (!existing) {
            if (!rawName) { blankRows++; continue; }
            const nameKey = rawName.toLowerCase().trim();
            if (createdNames.has(nameKey)) continue; // duplicate in this import batch
            toCreate.push({
              orgId,
              name: rawName,
              legalName,
              payeeCode: payeeCode || null,
              mcDot: mcNumber || null,
              dotNumber,
              phone, city, state,
              primaryEmail: email,
              backupEmail: null,
              regions: [], equipmentTypes, tags: [],
              status: mappedStatus ?? "active",
            });
            createdNames.add(nameKey);
            // Update in-memory maps so subsequent rows don't create duplicates
            if (payeeCode) byPayee.set(payeeCode.toLowerCase(), { id: "__pending__", orgId } as Carrier);
            if (mcNumber)  byMcDot.set(mcNumber.trim().toUpperCase(), { id: "__pending__", orgId } as Carrier);
            byName.set(nameKey, { id: "__pending__", orgId } as Carrier);
            continue;
          }

          // ── Match found → enrich missing fields ─────────────────────────────
          if (matchHow === "payee") matchedPayee++;
          else if (matchHow === "mc") matchedMc++;
          else matchedName++;

          // MC number conflict detection
          if (mcNumber && existing.mcDot && existing.mcDot.trim().toUpperCase() !== mcNumber.trim().toUpperCase()) {
            conflicts.push(`${existing.name}: existing MC ${existing.mcDot} ≠ rolodex MC ${mcNumber}`);
          }

          // Prefer non-empty rolodex value; never overwrite existing non-empty with blank
          const patch: Partial<Omit<InsertCarrier, 'orgId'>> = {};
          if (!existing.payeeCode  && payeeCode)                    patch.payeeCode  = payeeCode;
          if (!existing.mcDot      && mcNumber && !conflicts.find(c => c.startsWith(existing!.name))) patch.mcDot = mcNumber;
          if (!existing.dotNumber  && dotNumber)                    patch.dotNumber  = dotNumber;
          if (!existing.legalName  && legalName)                    patch.legalName  = legalName;
          if (!existing.phone      && phone)                        patch.phone      = phone;
          if (!existing.primaryEmail && email)                      patch.primaryEmail = email;
          if (!existing.city       && city)                         patch.city       = city;
          if (!existing.state      && state)                        patch.state      = state;
          if ((!existing.equipmentTypes || existing.equipmentTypes.length === 0) && equipmentTypes.length > 0)
            patch.equipmentTypes = equipmentTypes;
          // Only update status if carrier is currently "active" and file says it's inactive/DNU
          if (mappedStatus && mappedStatus !== "active" && existing.status === "active")
            patch.status = mappedStatus;

          if (Object.keys(patch).length === 0) { upToDate++; continue; }
          toUpdate.push({ existing, patch });
        }

        // Batch create all new carriers in one round-trip (chunked)
        const created = await storage.bulkCreateCarriers(toCreate);

        // Apply enrichment updates sequentially (typically far fewer than creates)
        for (const { existing, patch } of toUpdate) {
          await storage.updateCarrier(existing.id, orgId, patch);
        }

        // ── Recurring-lane cross-reference ─────────────────────────────────────
        const allCarriers = await storage.getCarriers(orgId);
        const recurringCarriers = allCarriers.filter(c => c.payeeCode);
        const recurringEnriched = recurringCarriers.filter(c => c.primaryEmail || c.phone).length;
        const recurringMissingContact = recurringCarriers.filter(c => !c.primaryEmail && !c.phone).length;

        return res.json({
          mode: "rolodex",
          total: rows.length,
          blankRowsSkipped: blankRows,
          created,
          matchedPayee,
          matchedMc,
          matchedName,
          upToDate,
          conflicts,
          recurringLaneCarriers: recurringCarriers.length,
          recurringEnrichedWithContact: recurringEnriched,
          recurringMissingContact,
        });
      }

      // ════════════════════════════════════════════════════════════════════════
      // MODE C — LEGACY DIRECTORY FILE (no payee code column)
      // ════════════════════════════════════════════════════════════════════════
      {
        const nameCol        = findCol(["carrier name", "name", "company", "carrier"]);
        const mcCol          = findCol(["mc number", "mc#", "mc/dot", "dot number", "dot#", "dot", "mc"]);
        const emailCol       = findCol(["primary email", "contact email", "email"]);
        const backupEmailCol = findCol(["backup email", "secondary email", "alt email"]);
        const phoneCol       = findCol(["phone number", "phone"]);
        const cityCol        = findCol(["city"]);
        const stateCol       = findCol(["state"]);
        const equipCol       = findCol(["equipment type", "equip type", "trailer type", "equipment", "equip", "service type", "mode", "load mode"]);
        const regionCol      = findCol(["region", "regions", "territory"]);
        const tagsCol        = findCol(["tags", "specialties", "notes"]);

        // Load all existing carriers once (single DB query)
        const existingCarriers = await storage.getCarriers(orgId);
        const existingByMcDot  = new Map(existingCarriers.filter(c => c.mcDot).map(c => [c.mcDot!.trim().toUpperCase(), c]));
        const existingNameSet  = new Set(existingCarriers.map(c => c.name.toLowerCase().trim()));

        let skipped = 0;
        const toCreate: InsertCarrier[] = [];
        const newNames = new Set<string>(); // track names added in this batch (dedup within file)
        const newMcDots = new Set<string>();

        // Collect mcDot-based enrichment updates (existing carriers, typically few)
        const mcDotUpdates: Array<{ id: string; patch: Partial<Omit<InsertCarrier, 'orgId'>> }> = [];

        for (const row of rows) {
          const name = str(row, nameCol);
          if (!name) { skipped++; continue; }

          const mcDotRaw       = str(row, mcCol).trim().toUpperCase() || null;
          const primaryEmail   = str(row, emailCol) || null;
          const backupEmail    = str(row, backupEmailCol) || null;
          const phone          = str(row, phoneCol) || null;
          const city           = str(row, cityCol) || null;
          const state          = str(row, stateCol) || null;
          const regions        = regionCol ? str(row, regionCol).split(/[,;|]/).map((s: string) => s.trim()).filter(Boolean) : [];
          const equipmentTypes = equipCol  ? str(row, equipCol).split(/[,;|]/).map((s: string) => s.trim()).filter(Boolean)  : [];
          const tags           = tagsCol   ? str(row, tagsCol).split(/[,;|]/).map((s: string) => s.trim()).filter(Boolean)   : [];

          if (mcDotRaw) {
            const existing = existingByMcDot.get(mcDotRaw);
            if (existing) {
              // Existing carrier: enrich missing fields
              const patch: Partial<Omit<InsertCarrier, 'orgId'>> = {};
              if (!existing.phone && phone)               patch.phone = phone;
              if (!existing.city && city)                 patch.city = city;
              if (!existing.state && state)               patch.state = state;
              if (!existing.primaryEmail && primaryEmail) patch.primaryEmail = primaryEmail;
              if (!existing.backupEmail && backupEmail)   patch.backupEmail = backupEmail;
              if (Object.keys(patch).length > 0) mcDotUpdates.push({ id: existing.id, patch });
              else skipped++;
              continue;
            }
            // New carrier with mcDot — skip if already in this batch
            if (newMcDots.has(mcDotRaw) || existingNameSet.has(name.toLowerCase())) { skipped++; continue; }
            toCreate.push({ orgId, name, mcDot: mcDotRaw, phone, city, state, primaryEmail, backupEmail, regions, equipmentTypes, tags });
            newMcDots.add(mcDotRaw);
            newNames.add(name.toLowerCase());
          } else {
            const nameKey = name.toLowerCase().trim();
            if (existingNameSet.has(nameKey) || newNames.has(nameKey)) { skipped++; continue; }
            toCreate.push({ orgId, name, mcDot: null, phone, city, state, primaryEmail, backupEmail, regions, equipmentTypes, tags });
            newNames.add(nameKey);
          }
        }

        // Batch create all new carriers (chunked to avoid DB parameter limits)
        const created = await storage.bulkCreateCarriers(toCreate);

        // Apply enrichment updates to existing carriers (usually far fewer)
        for (const { id, patch } of mcDotUpdates) {
          await storage.updateCarrier(id, orgId, patch as any);
        }

        return res.json({
          mode: "directory",
          total: rows.length,
          created,
          skipped,
        });
      }
    } catch (err) {
      console.error("[carrier-seed]", err);
      return res.status(500).json({ error: "Failed to process file", details: (err as Error)?.message });
    }
  });

  app.use("/api/admin/carriers/seed-from-excel", (err: any, _req: any, res: any, next: any) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      console.error("[carrier-seed] file too large:", err.message);
      return res.status(400).json({ error: "File too large", details: err.message });
    }
    if (err) {
      console.error("[carrier-seed] multer error:", err);
      return res.status(400).json({ error: "File upload error", details: err.message });
    }
    next();
  });

  // ── Lane Outreach Config (client-readable, no flag gate) ──────────────────

  app.get("/api/lane-outreach-config", requireAuth, async (_req, res) => {
    res.json({
      completionCarriersContacted: LANE_CONFIG.completionCarriersContacted,
    });
  });

  // ── Recurring Lanes ────────────────────────────────────────────────────────

  app.get("/api/recurring-lanes", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const flagOn = await isFeatureEnabled(user.organizationId);
    if (!flagOn) return res.json([]);

    // Admins/directors see all org lanes; others see lanes they own OR oversee
    const isPortfolioRole = ADMIN_ROLES.includes(user.role);
    const lanes = await storage.getRecurringLanes(user.organizationId, isPortfolioRole ? undefined : user.id);
    res.json(lanes);
  });

  // ── Lane Work Queue (all authenticated users) — must be before /:id ────────

  app.get("/api/recurring-lanes/work-queue", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    try {
      // Pagination: keyset by (laneScore DESC, laneId). Default page size 50.
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const cursor = req.query.cursor as string | undefined; // format: "score:laneId"

      const { visibleUserIds, canSeeUnassigned, scopeLabel } = await storage.resolveVisibleUserIds(
        user.id, user.organizationId, user.role
      );

      // ── Try lean cache path first (O(1) per lane, no per-lane enrichment) ──
      // Falls back to full getLaneWorkQueue only when the scoring job has never run.
      const [leanQueue, orgUploads] = await Promise.all([
        storage.getLaneWorkQueueFromCache(user.organizationId, visibleUserIds, canSeeUnassigned),
        storage.getFinancialUploadsForOrg(user.organizationId),
      ]);

      // Build HF index once (O(rows)) and look up per-lane in O(1).
      const hfIndex = getHfIndex(user.organizationId, orgUploads);

      // ── Normalize into a common lean shape ─────────────────────────────────
      // When the cache is populated: items come from lane_summary_cache (lean — no replySummary).
      // When cache is empty (first run): fall back to getLaneWorkQueue and adapt to lean shape.
      type LeanItem = {
        laneId: string;
        laneScore: number | null;
        origin: string;
        originState: string | null;
        destination: string;
        destinationState: string | null;
        equipmentType: string | null;
        avgLoadsPerWeek: string | null;
        companyId: string | null;
        companyName: string | null;
        ownerUserId: string | null;
        ownerName: string | null;
        carriersContactedCount: number;
        contactableCount: number;
        totalBenchCount: number;
        historicalCount: number;
        missingContactCount: number;
        isHighFrequency: boolean;
        isManual: boolean;
      };

      type LeanBuckets = {
        unassigned: LeanItem[];
        noContactable: LeanItem[];
        assignedUntouched: LeanItem[];
        inProgress: LeanItem[];
      };

      let buckets: LeanBuckets;

      if (leanQueue) {
        // Cache hit — stamp HF flag and reshape
        const mapItems = (items: typeof leanQueue.unassigned): LeanItem[] =>
          items.map(item => ({
            ...item,
            isHighFrequency: isHighFrequencyLaneFromIndex(
              { origin: item.origin, originState: item.originState ?? undefined, destination: item.destination, destinationState: item.destinationState ?? undefined },
              hfIndex
            ),
          }));
        buckets = {
          unassigned: mapItems(leanQueue.unassigned),
          noContactable: mapItems(leanQueue.noContactable),
          assignedUntouched: mapItems(leanQueue.assignedUntouched),
          inProgress: mapItems(leanQueue.inProgress),
        };
      } else {
        // Cache miss — fall back to full query and project to lean shape (no replySummary)
        const fullQueue = await storage.getLaneWorkQueue(
          user.organizationId, LANE_CONFIG.completionCarriersContacted, visibleUserIds, canSeeUnassigned
        );
        const adaptItem = (item: (typeof fullQueue.unassigned)[number]): LeanItem => ({
          laneId: item.lane.id,
          laneScore: item.lane.laneScore ?? null,
          origin: item.lane.origin,
          originState: item.lane.originState ?? null,
          destination: item.lane.destination,
          destinationState: item.lane.destinationState ?? null,
          equipmentType: item.lane.equipmentType ?? null,
          avgLoadsPerWeek: item.lane.avgLoadsPerWeek ?? null,
          companyId: item.lane.companyId ?? null,
          companyName: item.lane.companyName ?? null,
          ownerUserId: item.lane.ownerUserId ?? null,
          ownerName: (item.lane as typeof item.lane & { ownerName?: string | null }).ownerName ?? null,
          carriersContactedCount: item.lane.carriersContactedCount ?? 0,
          contactableCount: item.contactableCount,
          totalBenchCount: item.totalBenchCount,
          historicalCount: item.historicalCount,
          missingContactCount: item.missingContactCount,
          isHighFrequency: isHighFrequencyLaneFromIndex(item.lane, hfIndex),
          isManual: item.lane.isManual ?? false,
        });
        buckets = {
          unassigned: fullQueue.unassigned.map(adaptItem),
          noContactable: fullQueue.noContactable.map(adaptItem),
          assignedUntouched: fullQueue.assignedUntouched.map(adaptItem),
          inProgress: fullQueue.inProgress.map(adaptItem),
        };
      }

      // Keyset pagination within each bucket (already sorted laneScore DESC, laneId by DB)
      function applyPagination(items: LeanItem[]): { items: LeanItem[]; nextCursor: string | null } {
        let startIdx = 0;
        if (cursor) {
          const [cursorScoreStr, cursorId] = cursor.split(":");
          const cursorScore = parseInt(cursorScoreStr, 10);
          startIdx = items.findIndex(item => {
            const score = item.laneScore ?? 0;
            if (score !== cursorScore) return score < cursorScore;
            return item.laneId > cursorId;
          });
          if (startIdx === -1) startIdx = items.length;
        }
        const page = items.slice(startIdx, startIdx + limit);
        const last = page[page.length - 1];
        const nextCursor = page.length === limit && last
          ? `${last.laneScore ?? 0}:${last.laneId}`
          : null;
        return { items: page, nextCursor };
      }

      const totals = {
        unassigned: buckets.unassigned.length,
        noContactable: buckets.noContactable.length,
        assignedUntouched: buckets.assignedUntouched.length,
        inProgress: buckets.inProgress.length,
        total: buckets.unassigned.length + buckets.noContactable.length + buckets.assignedUntouched.length + buckets.inProgress.length,
      };

      const allVisible = [...buckets.unassigned, ...buckets.noContactable, ...buckets.assignedUntouched, ...buckets.inProgress];
      const customers = [...new Set(
        allVisible.map(i => i.companyName).filter((n): n is string => !!n && n.trim() !== "")
      )].sort((a, b) => a.localeCompare(b));

      const uPaged = applyPagination(buckets.unassigned);
      const ncPaged = applyPagination(buckets.noContactable);
      const auPaged = applyPagination(buckets.assignedUntouched);
      const ipPaged = applyPagination(buckets.inProgress);

      const source = leanQueue ? "cache" : "full";
      console.log(`[work-queue] org=${user.organizationId} source=${source} scope=${scopeLabel} buckets=${JSON.stringify(totals)} limit=${limit} cursor=${cursor ?? "none"} requestedBy=${user.id}(${user.role})`);
      res.json({
        unassigned: uPaged.items,
        noContactable: ncPaged.items,
        assignedUntouched: auPaged.items,
        inProgress: ipPaged.items,
        scopeLabel,
        customers,
        pagination: {
          limit,
          nextCursors: {
            unassigned: uPaged.nextCursor,
            noContactable: ncPaged.nextCursor,
            assignedUntouched: auPaged.nextCursor,
            inProgress: ipPaged.nextCursor,
          },
          totals,
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message ?? "Failed to load work queue" });
    }
  });

  // ── Unactioned Hot Reply Count (for sidebar badge) ──────────────────────────

  app.get("/api/recurring-lanes/unactioned-reply-count", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    try {
      const { visibleUserIds, canSeeUnassigned } = await storage.resolveVisibleUserIds(
        user.id, user.organizationId, user.role
      );
      const count = await storage.getUnactionedHotReplyCount(
        user.organizationId, visibleUserIds, canSeeUnassigned
      );
      res.json({ count });
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message ?? "Failed to get reply count" });
    }
  });

  /** Read-only: returns the metadata from the last engine run for admin debug panel. */
  app.get("/api/recurring-lanes/engine-status", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    if (!["admin", "director"].includes(user.role)) return res.status(403).json({ error: "Admin/Director only" });
    try {
      const raw = await storage.getSetting(`lane_engine_last_run:${user.organizationId}`);
      const meta = raw ? JSON.parse(raw) : null;
      res.json({ meta });
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message ?? "Failed to load engine status" });
    }
  });

  // ── Manual Lane Creation ───────────────────────────────────────────────────

  app.post("/api/lanes/manual", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const schema = z.object({
      origin: z.string().min(1, "Origin city required"),
      originState: z.string().optional().or(z.literal("")),
      destination: z.string().min(1, "Destination city required"),
      destinationState: z.string().optional().or(z.literal("")),
      equipmentType: z.string().optional().or(z.literal("")),
      avgLoadsPerWeek: z.coerce.number().positive("Must be a positive number").optional(),
      companyName: z.string().optional().or(z.literal("")),
      notes: z.string().optional().or(z.literal("")),
      dropTrailerShipper: z.boolean().optional().default(false),
      dropTrailerReceiver: z.boolean().optional().default(false),
      ownerUserId: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { origin, originState, destination, destinationState, equipmentType, avgLoadsPerWeek, companyName, dropTrailerShipper, dropTrailerReceiver } = parsed.data;

    let assigneeUserId = user.id;
    let ownerName = user.name;
    if (parsed.data.ownerUserId && parsed.data.ownerUserId !== user.id) {
      const isPrivileged = ["admin", "director"].includes(user.role);
      if (!isPrivileged) {
        return res.status(403).json({ error: "Only admins and directors can assign lanes to other users" });
      }
      const assignee = await storage.getUser(parsed.data.ownerUserId);
      if (!assignee || assignee.organizationId !== user.organizationId) {
        return res.status(400).json({ error: "Invalid assignee: user not found in your organization" });
      }
      assigneeUserId = parsed.data.ownerUserId;
      ownerName = assignee.name;
    }

    try {
      const lane = await storage.createRecurringLane({
        orgId: user.organizationId,
        origin,
        originState: originState || null,
        destination,
        destinationState: destinationState || null,
        equipmentType: equipmentType || null,
        avgLoadsPerWeek: avgLoadsPerWeek != null ? String(avgLoadsPerWeek) : null,
        companyName: companyName || null,
        isEligible: true,
        eligibilityConfidence: "high",
        isManual: true,
        weeksActive: 0,
        lookbackWeeks: 4,
        hasPreferredCarrierProgram: false,
        carriersContactedCount: 0,
        dropTrailerShipper: dropTrailerShipper ?? false,
        dropTrailerReceiver: dropTrailerReceiver ?? false,
        ownerUserId: assigneeUserId,
        assignedAt: new Date().toISOString(),
        assignedByUserId: user.id,
      });

      await storage.upsertLaneSummaryCache({
        laneId: lane.id,
        laneScore: 0,
        priority: 0,
        origin: lane.origin,
        originState: lane.originState ?? null,
        destination: lane.destination,
        destinationState: lane.destinationState ?? null,
        equipmentType: lane.equipmentType ?? null,
        avgLoadsPerWeek: lane.avgLoadsPerWeek ?? null,
        companyId: lane.companyId ?? null,
        companyName: lane.companyName ?? null,
        ownerUserId: lane.ownerUserId ?? assigneeUserId,
        ownerName,
        carriersContactedCount: 0,
        contactableCount: 0,
        totalBenchCount: 0,
        historicalCount: 0,
        missingContactCount: 0,
        orgId: user.organizationId,
        isEligible: true,
        hasPreferredCarrierProgram: false,
        snoozedUntil: null,
        resolvedAt: null,
        dropTrailerShipper: dropTrailerShipper ?? false,
        dropTrailerReceiver: dropTrailerReceiver ?? false,
        isManual: true,
      });

      res.status(201).json({ ...lane, ownerName });
    } catch (err) {
      console.error("[lanes/manual] error:", err);
      res.status(500).json({ error: "Failed to create manual lane" });
    }
  });

  app.get("/api/recurring-lanes/:id", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneForOrg(req.params.id, user, res);
    if (!lane) return;
    res.json(lane);
  });

  /**
   * GET /api/recurring-lanes/:id/detail
   *
   * Lean lane detail — fetched only when the CarrierOutreachPanel opens for a specific lane.
   * Returns reply summary (totalReplied, hotCount, topStatus, topCarrierName, needsAction),
   * bench counts, and any matched award task info. NOT included in the LWQ list payload.
   */
  app.get("/api/recurring-lanes/:id/detail", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneForOrg(req.params.id, user, res);
    if (!lane) return;

    try {
      const { laneCarrierInterest: lciTable } = await import("@shared/schema");
      const benchEntries = await db.select({
        id: lciTable.id,
        carrierId: lciTable.carrierId,
        carrierName: lciTable.carrierName,
        interestStatus: lciTable.interestStatus,
        sourceType: lciTable.sourceType,
      }).from(lciTable).where(eq(lciTable.laneId, req.params.id));

      // Reply summary computation
      const HOT_STATUSES = new Set(["available_now", "available_next_week"]);
      const STATUS_PRIORITY: Record<string, number> = { available_now: 4, available_next_week: 3, future_interest: 2, not_fit: 1 };
      const replied = benchEntries.filter(b => b.interestStatus !== "needs_follow_up");
      let topEntry: (typeof benchEntries)[0] | null = null;
      let topPriority = -1;
      for (const b of replied) {
        const p = STATUS_PRIORITY[b.interestStatus] ?? 0;
        if (p > topPriority) { topPriority = p; topEntry = b; }
      }
      const hotCount = replied.filter(b => HOT_STATUSES.has(b.interestStatus)).length;

      // Check for open follow-up task for this lane
      const openTaskResult = await storage.pool.query<{ lane_id: string }>(
        `SELECT 1 FROM tasks
         WHERE org_id = $1
           AND status != 'closed'
           AND lane_context->>'type' = 'carrier_reply_follow_up'
           AND lane_context->>'laneId' = $2
         LIMIT 1`,
        [user.organizationId, req.params.id]
      );
      const hasOpenTask = openTaskResult.rows.length > 0;

      const replySummary = {
        totalReplied: replied.length,
        hotCount,
        topStatus: topEntry?.interestStatus ?? null,
        topCarrierName: topEntry?.carrierName ?? null,
        needsAction: hotCount > 0 && !hasOpenTask,
      };

      const totalBenchCount = benchEntries.length;
      const historicalCount = benchEntries.filter(b => b.sourceType === "historical").length;

      res.json({
        laneId: req.params.id,
        replySummary,
        totalBenchCount,
        historicalCount,
      });
    } catch (err) {
      console.error("[lane-detail]", err);
      res.status(500).json({ error: "Failed to load lane detail" });
    }
  });

  app.patch("/api/recurring-lanes/:id", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await storage.getRecurringLane(req.params.id);
    if (!lane || lane.orgId !== user.organizationId) return res.status(404).json({ error: "Lane not found" });

    const isManagerRole = ADMIN_ROLES.includes(user.role) ||
      ["national_account_manager", "logistics_manager"].includes(user.role);
    const isOwner = lane.ownerUserId === user.id;

    if (!isManagerRole && !isOwner) {
      return res.status(403).json({ error: "Only managers, admins, or the lane owner can edit a lane" });
    }

    // Admin/manager-only fields: ownership reassignment and system flags
    const ADMIN_MUTABLE_FIELDS = ["ownerUserId", "overseerUserId", "hasPreferredCarrierProgram"] as const;
    // Fields editable by managers and lane owners alike
    const OWNER_MUTABLE_FIELDS = ["origin", "originState", "destination", "destinationState", "equipmentType", "avgLoadsPerWeek", "companyName"] as const;

    const updates: Record<string, unknown> = {};

    // Owner-editable fields — available to managers and owners
    for (const field of OWNER_MUTABLE_FIELDS) {
      if (field in req.body) updates[field] = req.body[field] ?? null;
    }

    // Admin-only fields — silently ignored for non-managers
    if (isManagerRole) {
      for (const field of ADMIN_MUTABLE_FIELDS) {
        if (field in req.body) updates[field] = req.body[field];
      }
    }

    // Validate reassigned user IDs belong to the same org — prevent cross-tenant assignment
    if (updates.ownerUserId) {
      const owner = await storage.getUser(updates.ownerUserId as string);
      if (!owner || owner.organizationId !== user.organizationId) {
        return res.status(403).json({ error: "Owner user not found in your organization" });
      }
    }
    if (updates.overseerUserId) {
      const overseer = await storage.getUser(updates.overseerUserId as string);
      if (!overseer || overseer.organizationId !== user.organizationId) {
        return res.status(403).json({ error: "Overseer user not found in your organization" });
      }
    }

    // Auto-resolve lane when hasPreferredCarrierProgram is toggled true
    const preferredProgramToggled = updates.hasPreferredCarrierProgram === true && !lane.resolvedAt;
    if (preferredProgramToggled) {
      const now = new Date().toISOString();
      const snoozeUntil = new Date();
      snoozeUntil.setDate(snoozeUntil.getDate() + LANE_CONFIG.snoozeAfterResolveDays);
      updates.resolvedAt = now;
      updates.snoozedUntil = snoozeUntil.toISOString().split("T")[0];
    }

    const updated = await storage.updateRecurringLane(req.params.id, updates);

    // Resolve linked NBA cards so they leave users' dashboards
    if (preferredProgramToggled) {
      await storage.resolveNbaCardsForLane(req.params.id);
      // Auto-complete any open lane-procurement tasks so reps' task lists stay clean
      await storage.completeTasksForLane(req.params.id);
    }

    // Audit log: record any ownership reassignment
    const ownerChanged = req.body.ownerUserId && req.body.ownerUserId !== lane.ownerUserId;
    const overseerChanged = req.body.overseerUserId && req.body.overseerUserId !== lane.overseerUserId;
    if (ownerChanged || overseerChanged) {
      await storage.createCarrierOutreachLog({
        orgId: user.organizationId,
        laneId: req.params.id,
        companyId: lane.companyId ?? null,
        carrierIds: [],
        carrierNames: [],
        actorUserId: user.id,
        ownerUserId: updated?.ownerUserId ?? null,
        overseerUserId: updated?.overseerUserId ?? null,
        outreachMode: "reassignment",
        emailDrafts: [],
      });
    }

    res.json(updated);
  });

  // ── Lane Delete ────────────────────────────────────────────────────────────

  app.delete("/api/recurring-lanes/:id", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await storage.getRecurringLane(req.params.id);
    if (!lane || lane.orgId !== user.organizationId) {
      return res.status(404).json({ error: "Lane not found" });
    }

    const isManager = ADMIN_ROLES.includes(user.role) ||
      ["national_account_manager", "logistics_manager"].includes(user.role);
    const isOwner = lane.ownerUserId === user.id;

    if (!isManager && !isOwner) {
      return res.status(403).json({ error: "Only managers, admins, or the lane owner can delete a lane" });
    }

    const deleted = await storage.deleteRecurringLane(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Lane not found" });

    res.status(204).end();
  });

  // ── Lane Assignment ────────────────────────────────────────────────────────

  app.post("/api/recurring-lanes/:laneId/assign", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await storage.getRecurringLane(req.params.laneId);
    if (!lane || lane.orgId !== user.organizationId) return res.status(404).json({ error: "Lane not found" });

    const isManager = ["admin", "director", "national_account_manager", "logistics_manager"].includes(user.role);

    const { ownerUserId } = req.body as { ownerUserId: string | null };

    const isSelfUnassign = ownerUserId === null && lane.ownerUserId === user.id;
    const isLaneOwner = lane.ownerUserId === user.id;

    if (!isManager) {
      // Non-managers: allow self-assign (lane unassigned or they own it) OR self-unassign (they own it)
      if (ownerUserId === null) {
        // Unassign attempt — only allowed if user is the current owner
        if (!isLaneOwner) {
          return res.status(403).json({ error: "You can only unassign yourself from lanes you own" });
        }
      } else {
        // Assign attempt — can only assign to themselves, and only if lane is unassigned or they own it
        if (ownerUserId !== user.id) {
          return res.status(403).json({ error: "You can only assign a lane to yourself" });
        }
        if (lane.ownerUserId && lane.ownerUserId !== user.id) {
          return res.status(403).json({ error: "You can only assign lanes that are currently unassigned" });
        }
      }
    }

    // Validate the new owner belongs to this org
    if (ownerUserId) {
      const newOwner = await storage.getUser(ownerUserId);
      if (!newOwner || newOwner.organizationId !== user.organizationId) {
        return res.status(400).json({ error: "User not found in your organization" });
      }

      // Hierarchy scope check: non-admins may only assign within their visible user set
      if (user.role !== "admin") {
        const { visibleUserIds } = await storage.resolveVisibleUserIds(user.id, user.organizationId, user.role);
        if (!visibleUserIds.includes(ownerUserId)) {
          return res.status(403).json({ error: "Cannot assign lane to a user outside your hierarchy scope" });
        }
      }
    }

    try {
      const updated = await storage.assignLaneOwner(req.params.laneId, user.organizationId, ownerUserId ?? null, user.id);
      if (!updated) return res.status(404).json({ error: "Lane not found" });

      // Audit log
      await storage.createCarrierOutreachLog({
        orgId: user.organizationId,
        laneId: req.params.laneId,
        companyId: lane.companyId ?? null,
        carrierIds: [],
        carrierNames: [],
        actorUserId: user.id,
        ownerUserId: ownerUserId ?? null,
        overseerUserId: lane.overseerUserId ?? null,
        outreachMode: "assignment",
        emailDrafts: [],
      });

      // In-app notification — always notify the assignee (includes self-assign)
      if (ownerUserId) {
        const origin = lane.origin;
        const dest = lane.destination;
        const loadsWk = lane.avgLoadsPerWeek ? `${parseFloat(lane.avgLoadsPerWeek).toFixed(1)}/wk` : null;
        const equip = lane.equipmentType ?? null;
        const bodyParts = [
          loadsWk,
          equip ? `${equip} equipment` : null,
          "Open your Lane Work Queue to start carrier outreach.",
        ].filter(Boolean);
        await storage.createNotification({
          userId: ownerUserId,
          type: "lane_assigned",
          title: `Lane assigned to you — ${origin} → ${dest}`,
          body: bodyParts.join(" · "),
          link: "/lanes/work-queue",
          relatedId: req.params.laneId,
        });
      }

      // Create a task for the assignee (self-assign or manager-assign both get a task)
      // Dedup: skip if an open lane-procurement task already exists for this lane+user
      if (ownerUserId) {
        const existing = await storage.findOpenLaneProcurementTask(req.params.laneId, ownerUserId);
        if (!existing) {
          const customer = lane.companyName ?? "Unknown Customer";
          const origin = lane.origin;
          const dest = lane.destination;
          const loadsWk = lane.avgLoadsPerWeek ? `${parseFloat(lane.avgLoadsPerWeek).toFixed(1)}/wk` : null;
          const equip = lane.equipmentType ? ` · ${lane.equipmentType}` : "";
          const assignerUser = await storage.getUser(user.id);
          const assignerName = assignerUser ? (assignerUser.name ?? assignerUser.username) : "a manager";
          const today = new Date().toISOString().split("T")[0];
          const descLines = [
            `Assigned by: ${assignerName}`,
            loadsWk ? `Volume: ${loadsWk}${equip}` : equip ? `Equipment: ${lane.equipmentType}` : null,
            `Go to the Lane Work Queue to manage carrier outreach for this corridor.`,
          ].filter(Boolean).join("\n");
          await storage.createTask({
            title: `Work assigned lane: ${customer} — ${origin} → ${dest}`,
            description: descLines,
            status: "open",
            dueDate: today,
            assignedTo: ownerUserId,
            assignedBy: user.id,
            orgId: user.organizationId,
            companyId: lane.companyId ?? null,
            companyName: customer,
            lever: "Lane ID",
            laneContext: { type: "lane_procurement", laneId: req.params.laneId } as any,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }

      // Patch lane_summary_cache so list queries reflect new owner immediately
      const newOwnerForCache = ownerUserId ? await storage.getUser(ownerUserId) : null;
      await storage.patchLaneSummaryCache(req.params.laneId, {
        ownerUserId: ownerUserId ?? undefined,
        ownerName: newOwnerForCache?.name ?? null,
      }).catch(() => {});

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message ?? "Failed to assign lane" });
    }
  });

  // Run the recurring lane engine + scoring on demand (admin/director)
  app.post("/api/recurring-lanes/run-engine", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    if (!["admin", "director"].includes(user.role)) return res.status(403).json({ error: "Admin/Director only" });

    try {
      const result = await runRecurringLaneEngineForOrg(user.organizationId, storage);
      await scoreAllEligibleLanes(user.organizationId, storage);
      res.json({ ...result, message: "Engine + scoring complete" });
      // Persist last-run meta so the work queue debug panel can show it without re-running
      await storage.setSetting(`lane_engine_last_run:${user.organizationId}`, JSON.stringify(result.meta));
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message ?? "Engine error" });
    }
  });

  // ── Carrier Suggestions (AI-ranked) ───────────────────────────────────────

  const _rankingCache = new Map<string, { ranked: Awaited<ReturnType<typeof rankCarriersForLane>>; isHfLane: boolean; expiresAt: number }>();
  const RANKING_CACHE_TTL = 3 * 60 * 1000;
  const RANKING_TIMEOUT_MS = 25_000;

  app.get("/api/lanes/:laneId/carrier-suggestions", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await getLaneForOrg(req.params.laneId, user!, res);
    if (!lane) return;

    try {
      // ── Query parameter parsing ──────────────────────────────────────────
      const pageSize = parseInt(String(req.query.pageSize ?? "20"), 10);
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const sort = String(req.query.sort ?? "recommended");
      const exactOnly = req.query.exactOnly === "true";
      const hasEmail = req.query.hasEmail === "true";
      const notRecentlyContacted = req.query.notRecentlyContacted === "true";
      const activeOnly = req.query.activeOnly === "true";
      const includeNewProspects = req.query.includeNewProspects !== "false";
      const overrideRecentlyContacted = req.query.overrideRecentlyContacted === "true";
      const debugMode = req.query.debug === "true";
      const forceRefresh = req.query.refresh === "true";

      const cacheKey = `${req.params.laneId}::${user.organizationId}`;
      const cached = _rankingCache.get(cacheKey);
      let ranked: Awaited<ReturnType<typeof rankCarriersForLane>>;
      let isHfLane: boolean;

      if (cached && cached.expiresAt > Date.now() && !debugMode && !forceRefresh) {
        ranked = cached.ranked;
        isHfLane = cached.isHfLane;
      } else {
        const rankingStart = Date.now();
        const rankingPromise = (async () => {
          const [bench, suggUploads] = await Promise.all([
            storage.getLaneCarrierBench(req.params.laneId),
            storage.getFinancialUploadsForOrg(user.organizationId),
          ]);

          let coverageProfile = null;
          let coverageCarriers: import("@shared/schema").LaneCoverageProfileCarrier[] = [];
          try {
            const profileResult = await getLaneCoverageProfile(lane, storage);
            coverageProfile = profileResult.profile;
            if (!coverageProfile.broadenSearchActive) {
              coverageCarriers = profileResult.carriers;
            }
          } catch {
          }

          const r = await rankCarriersForLane(lane, storage, bench, coverageProfile, coverageCarriers, debugMode);
          const hf = isHighFrequencyLane(lane, suggUploads);
          return { ranked: r, isHfLane: hf };
        })();

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Carrier ranking timed out")), RANKING_TIMEOUT_MS)
        );

        const result = await Promise.race([rankingPromise, timeoutPromise]);
        ranked = result.ranked;
        isHfLane = result.isHfLane;
        console.log(`[carrier-suggestions] ranked ${ranked.length} carriers for lane ${req.params.laneId} in ${Date.now() - rankingStart}ms`);

        _rankingCache.set(cacheKey, { ranked, isHfLane, expiresAt: Date.now() + RANKING_CACHE_TTL });
      }

      // ── Hard-filter Do Not Use carriers (unconditional) ─────────────────
      ranked = ranked.filter(c => !c.isDoNotUse);

      // ── Filtering ────────────────────────────────────────────────────────
      if (exactOnly) {
        // Include "nearby" as well — carriers with loads within 100mi of both lane endpoints
        // are operationally proven on this corridor even if not the exact city pair.
        ranked = ranked.filter(c => c.historyMatch === "exact" || c.historyMatch === "nearby");
      }
      if (hasEmail) {
        ranked = ranked.filter(c => !!(c.primaryEmail || c.backupEmail));
      }
      if (notRecentlyContacted && !overrideRecentlyContacted) {
        ranked = ranked.filter(c =>
          !c.suppressionReasons.some(r => r.startsWith("Recently contacted"))
        );
      }
      if (activeOnly) {
        ranked = ranked.filter(c => {
          if (!c.lastUsedMonth) return false;
          const lastDate = new Date(c.lastUsedMonth + "-01");
          return Date.now() - lastDate.getTime() <= 90 * 24 * 60 * 60 * 1000;
        });
      }
      if (!includeNewProspects) {
        ranked = ranked.filter(c => !c.isNewProspect);
      }

      const totalCount = ranked.length;

      // ── Sorting ──────────────────────────────────────────────────────────
      if (sort === "loadsDesc") {
        ranked = [...ranked].sort((a, b) => b.loadsOnLane - a.loadsOnLane);
      } else if (sort === "recency") {
        ranked = [...ranked].sort((a, b) => {
          const aM = a.lastUsedMonth ?? "";
          const bM = b.lastUsedMonth ?? "";
          if (bM !== aM) return bM.localeCompare(aM);
          return b.fitScore - a.fitScore;
        });
      } else if (sort === "customerHistory") {
        ranked = [...ranked].sort((a, b) => {
          if (b.customerHistoryLoads !== a.customerHistoryLoads) return b.customerHistoryLoads - a.customerHistoryLoads;
          return b.fitScore - a.fitScore;
        });
      } else if (sort === "outreachReadiness") {
        ranked = [...ranked].sort((a, b) => {
          const aReady = (a.primaryEmail || a.backupEmail) ? 1 : 0;
          const bReady = (b.primaryEmail || b.backupEmail) ? 1 : 0;
          if (bReady !== aReady) return bReady - aReady;
          return b.fitScore - a.fitScore;
        });
      } else if (sort === "alpha") {
        ranked = [...ranked].sort((a, b) => a.carrierName.localeCompare(b.carrierName));
      }
      // "recommended" = default rule-based order (already sorted above)

      // ── Pagination ───────────────────────────────────────────────────────
      let paginated: typeof ranked;
      if (pageSize === 0) {
        // pageSize=0 means "all"
        paginated = ranked;
      } else {
        const offset = (page - 1) * pageSize;
        paginated = ranked.slice(offset, offset + pageSize);
      }

      // ── whyThisCarrier enrichment ─────────────────────────────────────────
      // Fetch claimed lanes for catalog carriers in this page (single batch query)
      const paginatedCarrierIds = paginated
        .map(c => c.carrierId)
        .filter((id): id is string => id !== null);

      let claimedLanesMap = new Map<string, Array<{ originState: string | null; destState: string | null; equipment: string | null }>>();
      if (paginatedCarrierIds.length > 0) {
        const clRows = await db
          .select({
            carrierId: carrierClaimedLanes.carrierId,
            originState: carrierClaimedLanes.originState,
            destState: carrierClaimedLanes.destState,
            equipment: carrierClaimedLanes.equipment,
            laneType: carrierClaimedLanes.laneType,
          })
          .from(carrierClaimedLanes)
          .where(inArray(carrierClaimedLanes.carrierId, paginatedCarrierIds));

        for (const row of clRows) {
          if (row.laneType === "avoid") continue;
          if (!claimedLanesMap.has(row.carrierId)) claimedLanesMap.set(row.carrierId, []);
          claimedLanesMap.get(row.carrierId)!.push({
            originState: row.originState,
            destState: row.destState,
            equipment: row.equipment,
          });
        }
      }

      function checkClaimedMatch(
        claimed: Array<{ originState: string | null; destState: string | null; equipment: string | null }>,
        l: typeof lane
      ): boolean {
        const lOrig = (l.originState ?? "").toLowerCase().trim();
        const lDest = (l.destinationState ?? "").toLowerCase().trim();
        const lEquip = (l.equipmentType ?? "").toLowerCase().trim();
        return claimed.some(cl => {
          const origOk = !cl.originState || cl.originState.toLowerCase().trim() === lOrig;
          const destOk = !cl.destState || cl.destState.toLowerCase().trim() === lDest;
          const equipOk = !cl.equipment || !lEquip ||
            cl.equipment.toLowerCase().includes(lEquip) ||
            lEquip.includes(cl.equipment.toLowerCase());
          return origOk && destOk && equipOk;
        });
      }

      const carriersWithWhy = paginated.map(c => {
        const claimed = c.carrierId ? (claimedLanesMap.get(c.carrierId) ?? []) : [];
        const claimedLaneMatch = claimed.length > 0 ? checkClaimedMatch(claimed, lane) : false;
        const fitBand =
          c.fitScore >= 80 ? "strong" :
          c.fitScore >= 60 ? "good" :
          c.fitScore >= 35 ? "moderate" : "low";
        const hasExactHistory = c.historyMatch === "exact";
        const hasNearbyHistory = c.historyMatch === "nearby";
        const hasStatePairHistory = c.historyMatch === "state_pair";
        const hasSimilarHistory = hasNearbyHistory || hasStatePairHistory;
        const hasCustomerHistory = c.customerHistoryLoads > 0;
        const recentlyContactedNote = c.suppressionReasons.find(r => r.startsWith("Recently contacted"));

        let primarySignal: string;
        if (hasExactHistory && c.loadsOnLane > 0) {
          primarySignal = `Ran this exact lane ${c.loadsOnLane}×`;
          if (c.lastUsedMonth) primarySignal += ` · last ${c.lastUsedMonth}`;
        } else if (hasNearbyHistory) {
          primarySignal = `Runs nearby corridors within 75mi of this lane (${c.nearbyLaneLoads ?? c.loadsOnLane} loads)`;
        } else if (claimedLaneMatch) {
          primarySignal = "Claims to prefer this lane corridor";
        } else if (hasStatePairHistory) {
          primarySignal = "Runs this state-pair corridor";
        } else if (hasCustomerHistory) {
          primarySignal = `Hauled for this customer (${c.customerHistoryLoads} loads)`;
        } else if (c.priorOutcomeBoost) {
          primarySignal = "Showed availability in prior outreach for this lane";
        } else {
          primarySignal = "Region & equipment profile matches lane";
        }

        return {
          ...c,
          whyThisCarrier: {
            primarySignal,
            fitBand,
            claimedLaneMatch,
            hasExactHistory,
            exactHistoryRuns: hasExactHistory ? c.loadsOnLane : undefined,
            hasNearbyHistory,
            nearbyHistoryRuns: hasNearbyHistory ? (c.nearbyLaneLoads ?? 0) : undefined,
            hasStatePairHistory,
            hasSimilarHistory,
            hasCustomerHistory,
            customerHistoryLoads: hasCustomerHistory ? c.customerHistoryLoads : undefined,
            priorPositiveOutreach: c.priorOutcomeBoost,
            recentlyContacted: !!recentlyContactedNote,
            recentlyContactedNote: recentlyContactedNote ?? undefined,
            finalScore: c.fitScore,
            historyMatchTier: c.historyMatch,
            lastUsedMonth: c.lastUsedMonth ?? null,
            regionMatch: c.regionMatch,
            equipmentMatch: c.equipmentMatch,
            isIncumbent: c.isIncumbent,
            suppressionReasons: c.suppressionReasons,
            hasMarketNbaBoost: c.hasMarketNbaBoost,
            // Accepted-intel signals (Task #196)
            acceptedIntelPhrases: c.acceptedIntelPhrases ?? undefined,
          },
          carrierFitExplanation: c.carrierFitExplanation ?? null,
          // Caution flags from accepted intelligence (backward-compatible optional field)
          cautionFlags: c.cautionFlags ?? undefined,
        // debug field: only present when ?debug=true; omitted entirely otherwise
        ...(debugMode && c.debugScores ? { debug: c.debugScores } : {}),
        };
      });

      res.json({
        carriers: carriersWithWhy,
        totalCount,
        page,
        pageSize: pageSize === 0 ? totalCount : pageSize,
        totalPages: pageSize === 0 ? 1 : Math.ceil(totalCount / pageSize),
        isHighFrequencyLane: isHfLane,
        highFrequencyConfig: isHfLane ? HIGH_FREQUENCY_CONFIG : undefined,
      });
    } catch (err) {
      const msg = (err as Error)?.message ?? "Failed to rank carriers";
      const isTimeout = msg.includes("timed out");
      console.error(`[carrier-suggestions] error for lane ${req.params.laneId}: ${msg}`);
      res.status(isTimeout ? 504 : 500).json({
        error: isTimeout
          ? "Carrier ranking took too long — please try again in a moment"
          : msg,
      });
    }
  });

  // ── Draft Outreach Emails ──────────────────────────────────────────────────

  app.post("/api/lanes/:laneId/draft-outreach-emails", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await getLaneWithAccessCheck(req.params.laneId, user!, res);
    if (!lane) return;

    const { carrierIds, outreachMode = "lane_building" } = req.body;
    let { carrierNames } = req.body as { carrierNames?: string[] };

    // Allow carrierIds-only requests — derive names from carrier records server-side
    if ((!Array.isArray(carrierNames) || carrierNames.length === 0) && Array.isArray(carrierIds) && carrierIds.length > 0) {
      const fetched = await Promise.all(
        (carrierIds as string[]).map(async (id) => {
          if (!id) return null;
          const c = await storage.getCarrier(id);
          return c && c.orgId === user!.organizationId ? c.name : null;
        })
      );
      if (fetched.some(n => n === null)) {
        return res.status(400).json({ error: "One or more carrierIds not found in your organization" });
      }
      carrierNames = fetched as string[];
    }

    if (!Array.isArray(carrierNames) || carrierNames.length === 0) {
      return res.status(400).json({ error: "carrierNames or carrierIds is required" });
    }

    try {
      const { callAI } = await import("../aiHelpers");
      const emails = await Promise.all(
        carrierNames.map(async (name: string, idx: number) => {
          const carrierId = Array.isArray(carrierIds) ? (carrierIds[idx] ?? null) : null;
          let carrierDetails = "";
          // hasVerifiedHistory = true ONLY when the carrier has appeared in TMS financial data
          // (payeeCode is set). Merely being in the carrier catalog does not imply prior business.
          let hasVerifiedHistory = false;
          if (carrierId) {
            const c = await storage.getCarrier(carrierId);
            // Org-scope guard: never leak another org's carrier data
            if (c && c.orgId === user!.organizationId) {
              hasVerifiedHistory = !!(c as any).payeeCode;
              if (c.regions?.length) carrierDetails += ` Preferred regions: ${c.regions.join(", ")}.`;
              if (c.equipmentTypes?.length) carrierDetails += ` Equipment: ${c.equipmentTypes.join(", ")}.`;
              if (c.notes) carrierDetails += ` Notes: ${c.notes}.`;
            }
          }

          const laneDisplay = formatLaneDisplay(lane.origin, lane.originState, lane.destination, lane.destinationState);
          const loadRange = formatWeeklyLoadRange(lane.avgLoadsPerWeek);
          const equipment = normalizeEquipmentType(lane.equipmentType);

          const immediateNote = outreachMode === "immediate_plus_lane"
            ? `There is also an immediate load on this lane that needs a truck now — mention this in one natural sentence.`
            : "";

          const relationshipNote = hasVerifiedHistory
            ? `You have hauled freight for us before — acknowledge the prior relationship briefly in one clause. Do NOT say "we've run freight together before" verbatim.`
            : `This is a new prospect — do NOT imply any prior business relationship. No need to introduce yourself or the company.`;

          const prompt = `You are a freight broker writing a short outreach email to a carrier about a recurring lane.

Carrier: ${name}
Lane: ${laneDisplay} (${equipment})
Weekly volume: ${loadRange}
${relationshipNote}${carrierDetails ? `\nCarrier context:${carrierDetails}` : ""}${immediateNote ? `\nUrgent: ${immediateNote}` : ""}

House style — follow every rule:
- Direct, conversational, freight-native. Sound like a broker, not a sales rep or account manager.
- 3–4 short sentences MAX. Under 100 words.
- Use the lane exactly as written above: "${laneDisplay}". Never shorten, alter, or add "corridor" after it.
- Use the volume phrase exactly as given: "${loadRange}". Never convert to a decimal.
- BANNED — never use any of these phrases:
  "carrier bench", "we value our relationship", "ongoing coverage",
  "reaching out about", "love to connect", "top of mind",
  "lane runs consistently", "this lane runs consistently",
  "keep you in mind", "would love to", "I'd love to"
- End with a direct operational ask: "Does that fit your network?" or "If that fits your network, I'd be glad to talk through it."
- If this week doesn't work, say "if this week's tight, no worries" — not "I'd still love to connect."
- Vary sentence structure. Do not copy examples verbatim.
- Output ONLY the email body. No subject line. No sign-off block. No placeholders like [Name].`.trim();

          let body = "";
          try {
            body = await callAI(prompt);
          } catch {
            body = buildFallbackEmailHelper(name, hasVerifiedHistory, laneDisplay, equipment, loadRange, outreachMode);
          }

          return {
            carrierId,
            carrierName: name,
            subject: `Capacity Check: ${laneDisplay} (${equipment})`,
            body,
            outreachMode,
          };
        })
      );

      res.json({ emails });
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message ?? "Email drafting failed" });
    }
  });

  // ── Carrier Interest / Bench ───────────────────────────────────────────────

  app.get("/api/lanes/:laneId/carrier-bench", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneForOrg(req.params.laneId, user!, res);
    if (!lane) return;
    const bench = await storage.getLaneCarrierBench(req.params.laneId);

    // Enrich each bench item with contactability info from the carrier catalog
    const carrierIds = bench.map(b => b.carrierId).filter(Boolean) as string[];
    let contactMap: Map<string, { phone: string | null; primaryEmail: string | null }> = new Map();
    if (carrierIds.length > 0) {
      const carrierDetails = await storage.getCarriersByIds(carrierIds, user.organizationId);
      for (const c of carrierDetails) {
        contactMap.set(c.id, { phone: c.phone ?? null, primaryEmail: c.primaryEmail ?? null });
      }
    }

    const enriched = bench.map(b => ({
      ...b,
      phone: b.carrierId ? (contactMap.get(b.carrierId)?.phone ?? null) : null,
      primaryEmail: b.carrierId ? (contactMap.get(b.carrierId)?.primaryEmail ?? null) : null,
      isContactable: b.carrierId
        ? !!(contactMap.get(b.carrierId)?.phone || contactMap.get(b.carrierId)?.primaryEmail)
        : false,
    }));

    res.json(enriched);
  });

  /**
   * Create a carrier follow-up task when a hot reply is classified.
   *
   * Trigger: available_now or available_next_week only (needs_follow_up excluded — too noisy).
   * Dedupe: skip if any open follow-up task already exists for this event key; allow new
   *   tasks after closure so later replies from the same carrier/lane get their own task.
   * Needs-Action clearing: creating this task marks the lane as actioned (hotCount clears).
   * Reply snippet is quoted in the task description so assignee can read it inline.
   *
   * Spec locked April 2026 — see replit.md "Inbound Reply Auto-Task Spec" before changing.
   */
  async function ensureHotFollowUpTask(
    laneId: string,
    carrierId: string,
    carrierName: string,
    status: string,
    actorUserId: string,
    orgId: string,
    opts?: { replySnippet?: string | null; eventId?: string | null },
  ): Promise<void> {
    const HOT = new Set(["available_now", "available_next_week"]);
    if (!HOT.has(status)) return;

    try {
      // Event-level deduplication: if we have an event/interest ID, prefer that key
      // so distinct reply events from the same carrier on the same lane each get one task.
      // Without an eventId, fall back to carrier+lane pair guard to avoid duplicate open tasks.
      const dedupeKey = opts?.eventId
        ? `carrier_hot_event:${opts.eventId}`
        : `carrier_hot:${laneId}:${carrierId}`;

      const exists = await storage.pool.query(
        `SELECT id FROM tasks WHERE org_id = $1 AND lane_context->>'dedupeKey' = $2 AND status != 'closed' LIMIT 1`,
        [orgId, dedupeKey]
      );
      if (exists.rows.length > 0) return;

      const lane = await storage.getRecurringLane(laneId);
      const carrier = await storage.getCarrier(carrierId);
      const carrierLabel = carrier?.name ?? carrierName;
      const laneLabel = lane
        ? `${lane.origin}${lane.originState ? `, ${lane.originState}` : ""} → ${lane.destination}${lane.destinationState ? `, ${lane.destinationState}` : ""}`
        : "Unknown lane";
      const assignedUserId = lane?.ownerUserId ?? actorUserId;
      const statusLabel = status === "available_now" ? "available NOW" : "available next week";
      const carrierHubPath = `/carrier-hub/${carrierId}`;
      const laneQueuePath = `/lanes/work-queue?laneId=${laneId}`;

      const snippet = opts?.replySnippet?.trim();
      const snippetSection = snippet
        ? `\n\nCarrier reply:\n"${snippet.length > 400 ? snippet.slice(0, 400) + "…" : snippet}"`
        : "";

      await storage.createTask({
        title: `Confirm carrier: ${carrierLabel} is ${statusLabel} — ${laneLabel}`,
        description: `${carrierLabel} replied and was classified as "${statusLabel}" for lane ${laneLabel}.${snippetSection}\n\nSecure the load and confirm booking details.\n\nLane queue: ${laneQueuePath}\nCarrier Hub: ${carrierHubPath}`,
        status: "open",
        assignedTo: assignedUserId,
        assignedBy: actorUserId,
        orgId,
        laneContext: {
          type: "carrier_reply_follow_up",
          dedupeKey,
          laneId,
          carrierId,
          carrierHubPath,
          laneQueuePath,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[ensureHotFollowUpTask] failed:", err instanceof Error ? err.message : err);
    }
  }

  app.post("/api/lanes/:laneId/carrier-interest", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneWithAccessCheck(req.params.laneId, user!, res);
    if (!lane) return;

    const { carrierId, carrierName, interestStatus, notes, fitScore, fitReason, replySnippet } = req.body;
    if (!carrierName) return res.status(400).json({ error: "carrierName required" });

    // Verify carrierId (if provided) belongs to caller's org — prevent cross-org associations
    if (carrierId) {
      const carrier = await storage.getCarrier(carrierId);
      if (!carrier || carrier.orgId !== user.organizationId) {
        return res.status(403).json({ error: "Carrier not found in your organization" });
      }
    }

    const record = await storage.upsertLaneCarrierInterest({
      laneId: req.params.laneId,
      carrierId: carrierId ?? null,
      carrierName,
      interestStatus: interestStatus ?? "needs_follow_up",
      notes: notes ?? null,
      fitScore: fitScore ?? null,
      fitReason: fitReason ?? null,
      replySnippet: replySnippet ?? null,
      lastReplySnippet: replySnippet ?? null,
    });

    // If a rep directly sets (or reclassifies) a carrier to a hot status, ensure
    // a follow-up task exists. Non-blocking — response is sent regardless.
    if (carrierId && interestStatus) {
      await ensureHotFollowUpTask(req.params.laneId, carrierId, carrierName, interestStatus, user.id, user.organizationId, {
        replySnippet: replySnippet ?? null,
        eventId: record.id ? `interest:${record.id}` : null,
      });
    }

    res.json(record);
  });

  // ── Reply Classification ───────────────────────────────────────────────────

  app.post("/api/lanes/:laneId/classify-reply", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneWithAccessCheck(req.params.laneId, user!, res);
    if (!lane) return;

    const { replyText, carrierId, carrierName, interestId } = req.body;
    if (!replyText || !carrierName) return res.status(400).json({ error: "replyText and carrierName required" });

    // Verify carrierId (if provided) belongs to caller's org — prevent cross-org data writes
    if (carrierId) {
      const carrier = await storage.getCarrier(carrierId);
      if (!carrier || carrier.orgId !== user.organizationId) {
        return res.status(403).json({ error: "Carrier not found in your organization" });
      }
    }

    const VALID_STATUSES = ["available_now", "available_next_week", "future_interest", "not_fit", "needs_follow_up"];

    function ruleFallback(text: string): string {
      const lower = text.toLowerCase();
      if (lower.includes("not interested") || lower.includes("pass") || lower.includes("no thanks")) return "not_fit";
      if (lower.includes("no ") || lower.startsWith("no,") || lower === "no") return "not_fit";
      if (lower.includes("next week") || lower.includes("following week")) return "available_next_week";
      if (lower.includes("available") || lower.includes("can do") || lower.includes("yes")) return "available_now";
      if (lower.includes("future") || lower.includes("later") || lower.includes("keep in mind")) return "future_interest";
      return "needs_follow_up";
    }

    let classification: string = "needs_follow_up";
    let confidence = "low";

    try {
      const { callAI } = await import("../aiHelpers");
      const prompt = `
Classify this carrier reply into one of these statuses:
- available_now: carrier can cover loads immediately
- available_next_week: carrier says they'll be available next week
- future_interest: carrier is interested in future freight but not immediately available
- not_fit: carrier declined or is not interested
- needs_follow_up: unclear, needs more information or follow-up

Carrier reply: "${replyText}"

Respond with ONLY the status label (one of the 5 above), nothing else.
`.trim();

      const raw = (await callAI(prompt)).trim().toLowerCase().replace(/[^a-z_]/g, "");
      if (VALID_STATUSES.includes(raw)) {
        classification = raw;
        confidence = "high";
      } else {
        // AI returned unrecognized text — fall back to rule-based heuristic
        classification = ruleFallback(replyText);
      }
    } catch {
      classification = ruleFallback(replyText);
    }

    // Upsert the interest record
    const now = new Date().toISOString();
    if (interestId) {
      // Cross-record safety: verify the interest record belongs to this lane before updating
      const existingInterest = await storage.getLaneCarrierInterestById(interestId);
      if (!existingInterest || existingInterest.laneId !== req.params.laneId) {
        return res.status(403).json({ error: "Interest record does not belong to this lane" });
      }
      await storage.updateLaneCarrierInterest(interestId, {
        interestStatus: classification,
        replySnippet: replyText.slice(0, 500),
        lastReplySnippet: replyText.slice(0, 500),
        classifiedAt: now,
      });
    } else {
      await storage.upsertLaneCarrierInterest({
        laneId: req.params.laneId,
        carrierId: carrierId ?? null,
        carrierName,
        interestStatus: classification,
        replySnippet: replyText.slice(0, 500),
        lastReplySnippet: replyText.slice(0, 500),
        classifiedAt: now,
      });
    }

    // If classified as hot and we have a resolved carrierId, ensure a follow-up task exists.
    // Pass the reply snippet and interestId for event-level deduplication so each distinct
    // classify-reply event produces its own task (rather than being suppressed while another open task exists).
    if (carrierId) {
      await ensureHotFollowUpTask(req.params.laneId, carrierId, carrierName, classification, user.id, user.organizationId, {
        replySnippet: replyText.slice(0, 500),
        eventId: interestId ? `interest:${interestId}` : null,
      });
    }

    res.json({ classification, confidence, replyText: replyText.slice(0, 500) });
  });

  // ── Follow-up Suggestions ─────────────────────────────────────────────────

  app.get("/api/lanes/:laneId/followup-suggestions", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneForOrg(req.params.laneId, user!, res);
    if (!lane) return;

    const bench = await storage.getLaneCarrierBench(req.params.laneId);
    const logs = await storage.getCarrierOutreachLogs(req.params.laneId);

    const suggestions: Array<{ type: string; priority: "high" | "medium" | "low"; message: string; carrierId?: string | null; carrierName?: string }> = [];
    const now = new Date();

    // 1. Follow up with "available_next_week" carriers whose window has arrived
    const nextWeekCarriers = bench.filter(b => b.interestStatus === "available_next_week");
    for (const c of nextWeekCarriers) {
      const outreachDate = c.outreachSentAt ? new Date(c.outreachSentAt) : null;
      const daysSinceOutreach = outreachDate ? Math.floor((now.getTime() - outreachDate.getTime()) / 86400000) : 8;
      if (daysSinceOutreach >= 7) {
        suggestions.push({
          type: "follow_up_next_week",
          priority: "high",
          message: `${c.carrierName} said they'd be available next week — follow up now.`,
          carrierId: c.carrierId,
          carrierName: c.carrierName,
        });
      }
    }

    // 2. High-fit carriers with no reply
    const noReplyHighFit = bench.filter(b =>
      b.interestStatus === "needs_follow_up" && (b.fitScore ?? 0) >= 60 && b.outreachSentAt
    );
    for (const c of noReplyHighFit.slice(0, 3)) {
      suggestions.push({
        type: "no_reply_high_fit",
        priority: "medium",
        message: `${c.carrierName} (fit score ${c.fitScore}) hasn't replied — consider a follow-up call.`,
        carrierId: c.carrierId,
        carrierName: c.carrierName,
      });
    }

    // 3. Repeated positive carriers — flag for preferred program
    const positiveCarriers = bench.filter(b =>
      b.interestStatus === "available_now" || b.interestStatus === "available_next_week"
    );
    for (const c of positiveCarriers) {
      if ((c.fitScore ?? 0) >= 75) {
        suggestions.push({
          type: "preferred_program_candidate",
          priority: "low",
          message: `${c.carrierName} is a strong fit — consider adding them to the preferred carrier program for this lane.`,
          carrierId: c.carrierId,
          carrierName: c.carrierName,
        });
      }
    }

    // 4. If no outreach yet — nudge to start
    if (logs.length === 0) {
      suggestions.push({
        type: "start_outreach",
        priority: "high",
        message: "No outreach sent yet — select carriers from the ranked list to begin.",
      });
    }

    try {
      const { callAI } = await import("../aiHelpers");
      const origin = `${lane.origin}${lane.originState ? ", " + lane.originState : ""}`;
      const dest = `${lane.destination}${lane.destinationState ? ", " + lane.destinationState : ""}`;
      const benchSummary = bench.map(b =>
        `${b.carrierName}: ${b.interestStatus}${b.lastReplySnippet ? ` ("${b.lastReplySnippet.slice(0, 80)}")` : ""}`
      ).join("\n");

      const prompt = `
You are a freight capacity advisor. Review the carrier bench status for this lane and suggest the top 2-3 next best actions in plain language (1 sentence each).

Lane: ${origin} → ${dest} | Avg ${lane.avgLoadsPerWeek ?? "?"} loads/week
Carrier bench:
${benchSummary || "No carriers contacted yet."}

Outreach logs: ${logs.length} total outreach sessions.

Rules for suggestions:
- Prioritize carriers who said "next week" if a week has passed.
- Flag high-fit no-reply carriers for phone follow-up.
- If 3+ carriers are interested, suggest closing the bench and flagging for preferred program review.
- Keep suggestions under 20 words each.
- Return as a JSON array: [{"type":"...", "priority":"high|medium|low", "message":"..."}]
`.trim();

      const raw = await callAI(prompt);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const aiSuggestions = JSON.parse(jsonMatch[0]);
        if (Array.isArray(aiSuggestions)) {
          for (const s of aiSuggestions.slice(0, 3)) {
            if (s.message) suggestions.unshift({ type: s.type ?? "ai", priority: s.priority ?? "medium", message: s.message });
          }
        }
      }
    } catch {
      // AI enrichment is additive — rule-based suggestions still returned
    }

    res.json({ suggestions: suggestions.slice(0, 6) });
  });

  // ── Send Outreach Emails (Phase 1) ────────────────────────────────────────
  // Sends emails via the configured provider (Resend → SMTP fallback),
  // creates an outreach log with send-tracking fields, and upserts bench entries.

  app.post("/api/lanes/:laneId/send-outreach-emails", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await getLaneWithAccessCheck(req.params.laneId, user!, res);
    if (!lane) return;

    interface SendDraft {
      carrierId: string | null;
      carrierName: string;
      subject: string;
      body: string;
      outreachMode?: string;
      recipientEmail?: string | null;
    }

    const { emailDrafts, outreachMode = "lane_building", capturedEmails = {} } = req.body as {
      emailDrafts: SendDraft[];
      outreachMode?: string;
      capturedEmails?: Record<string, string>;
    };

    if (!Array.isArray(emailDrafts) || emailDrafts.length === 0) {
      return res.status(400).json({ error: "emailDrafts array is required" });
    }

    // Org-guard: validate every carrierId belongs to caller's org
    for (const draft of emailDrafts) {
      if (!draft.carrierId) continue;
      const c = await storage.getCarrier(draft.carrierId);
      if (!c || c.orgId !== user.organizationId) {
        return res.status(403).json({ error: `Carrier ${draft.carrierId} not found in your organization` });
      }
    }

    // Persist ad-hoc captured emails to catalog before sending
    for (const draft of emailDrafts) {
      const key = draft.carrierId ?? draft.carrierName;
      const capturedEmail = typeof capturedEmails[key] === "string" ? capturedEmails[key].trim() : null;
      if (capturedEmail && draft.carrierId) {
        await storage.updateCarrier(draft.carrierId, user.organizationId, { primaryEmail: capturedEmail }).catch(() => {/*non-fatal*/});
      }
    }

    // ── Dedup guard ──────────────────────────────────────────────
    // For high-frequency lanes, block re-sending to a carrier that was already
    // SUCCESSFULLY contacted on this lane within outreachDedupWindowHours.
    // Uses carrierOutreachLogs (deliveryStatus=sent) not bench timestamps — ensures
    // transient provider failures do NOT trigger a 48h block.
    // Non-HF lanes skip this check to preserve existing behavior.
    const sendUploads = await storage.getFinancialUploadsForOrg(user.organizationId);
    const isHfLane = isHighFrequencyLane(lane, sendUploads);
    const dedupWindowMs = HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours * 60 * 60 * 1000;
    const dedupBlockedCarrierIds = new Set<string>();

    if (isHfLane) {
      // Fetch carrier IDs that were SUCCESSFULLY contacted within the dedup window
      const successfulIds = await storage.getRecentSuccessfulOutreachCarrierIds(
        req.params.laneId,
        dedupWindowMs,
      );
      for (const cid of successfulIds) {
        dedupBlockedCarrierIds.add(cid);
      }
    }

    // Build per-carrier recipients list by resolving email addresses
    type RecipientResult = {
      carrierId: string | null;
      carrierName: string;
      email: string | null;
      status: "sent" | "failed" | "no_email" | "dedup_skipped" | "throttled_daily_cap" | "throttled_too_soon";
      error?: string;
      internetMessageId?: string;
      dedupBlocked?: boolean;
      throttleReason?: "daily_cap" | "too_soon";
      throttleMessage?: string;
    };

    const results: RecipientResult[] = [];
    let sentCount = 0;
    let failedCount = 0;

    // Send from the logged-in user's own Outlook mailbox so the email looks native
    // (appears in their Sent Items, shows their name/address to the carrier).
    // If OUTLOOK_REPLY_EMAIL is configured, a Reply-To header funnels carrier replies
    // to that monitored mailbox so reply tracking works. When not configured, replies
    // go directly back to the sending rep's inbox.
    // username is the user's email address in this system
    const outlookFromEmail = user.username?.trim() ?? null;
    const outlookReplyTo = process.env.OUTLOOK_REPLY_EMAIL?.trim() || null;
    const useOutlook = outlookEnabled() && !!outlookFromEmail;

    for (const draft of emailDrafts) {
      // ── Dedup check: skip carriers successfully contacted within the dedup window ─────
      // Only triggers for HF lanes; only blocks on confirmed successful sends (not failures).
      if (isHfLane && dedupBlockedCarrierIds.size > 0 && draft.carrierId) {
        if (dedupBlockedCarrierIds.has(draft.carrierId)) {
          results.push({
            carrierId: draft.carrierId,
            carrierName: draft.carrierName,
            email: null,
            status: "dedup_skipped",
            error: `Carrier already successfully contacted within ${HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours}h dedup window`,
            dedupBlocked: true,
          });
          continue;
        }
      }

      // ── Daily budget check: cross-lane throttle per carrier per calendar day ──────────
      // Applies to ALL lanes (not just HF). Enforces: max 5 sends/day and 4h minimum gap.
      if (draft.carrierId) {
        const budgetCheck = await storage.checkCarrierDailyBudget(user.organizationId, draft.carrierId);
        if (!budgetCheck.allowed) {
          const throttleStatus = budgetCheck.reason === "daily_cap" ? "throttled_daily_cap" : "throttled_too_soon";
          results.push({
            carrierId: draft.carrierId,
            carrierName: draft.carrierName,
            email: null,
            status: throttleStatus,
            error: budgetCheck.message,
            throttleReason: budgetCheck.reason,
            throttleMessage: budgetCheck.message,
          });
          continue;
        }
      }

      // Resolve email: captured > catalog primary > catalog backup
      let email: string | null = null;
      const key = draft.carrierId ?? draft.carrierName;
      if (capturedEmails[key]?.trim()) {
        email = capturedEmails[key].trim();
      } else if (draft.recipientEmail) {
        email = draft.recipientEmail;
      } else if (draft.carrierId) {
        const c = await storage.getCarrier(draft.carrierId);
        if (c && c.orgId === user.organizationId) {
          email = c.primaryEmail ?? c.backupEmail ?? null;
        }
      }

      if (!email) {
        results.push({ carrierId: draft.carrierId, carrierName: draft.carrierName, email: null, status: "no_email", error: "No email address available" });
        continue;
      }

      // Build plain-text version by stripping any HTML
      const _fromName = user.name?.trim() || process.env.SMTP_FROM_NAME || "Value Truck · Freight DNA";
      const plainText = draft.body.replace(/<[^>]+>/g, "").trim();
      const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:600px;line-height:1.6">${draft.body.replace(/\n/g, "<br/>")}</div><br/><p style="color:#888;font-size:12px">— ${_fromName}</p>`;

      try {
        if (useOutlook && outlookFromEmail) {
          const result = await sendOutlookEmail({
            fromEmail: outlookFromEmail,
            toEmail: email,
            subject: draft.subject,
            body: htmlBody,
            isHtml: true,
            // Only set Reply-To when a monitored mailbox is configured
            replyToEmail: outlookReplyTo ?? undefined,
          });
          if (result.ok) {
            // Strip RFC 2822 angle brackets so stored IDs match inbound In-Reply-To headers
            const cleanMsgId = result.internetMessageId?.replace(/[<>]/g, "") ?? undefined;
            results.push({ carrierId: draft.carrierId, carrierName: draft.carrierName, email, status: "sent", internetMessageId: cleanMsgId });
            sentCount++;
          } else {
            results.push({ carrierId: draft.carrierId, carrierName: draft.carrierName, email, status: "failed", error: result.error ?? "Outlook send failed" });
            failedCount++;
          }
        } else {
          const ok = await sendEmail({ to: email, subject: draft.subject, html: htmlBody, text: plainText });
          if (ok) {
            results.push({ carrierId: draft.carrierId, carrierName: draft.carrierName, email, status: "sent" });
            sentCount++;
          } else {
            results.push({ carrierId: draft.carrierId, carrierName: draft.carrierName, email, status: "failed", error: "Email provider returned failure" });
            failedCount++;
          }
        }
      } catch (err: any) {
        results.push({ carrierId: draft.carrierId, carrierName: draft.carrierName, email, status: "failed", error: err?.message ?? "Send error" });
        failedCount++;
      }
    }

    const dedupSkippedCount = results.filter(r => r.status === "dedup_skipped").length;
    const throttledCount = results.filter(r => r.status === "throttled_daily_cap" || r.status === "throttled_too_soon").length;
    const effectiveTotalCount = emailDrafts.length - dedupSkippedCount - throttledCount;
    const overallStatus =
      sentCount === 0 && effectiveTotalCount === 0 ? "sent" : // all were dedup-skipped or throttled
      sentCount === effectiveTotalCount ? "sent" :
      sentCount === 0 ? "failed" :
      "partial";

    // Create one outreach log per carrier (bulk sends emit N per-carrier records so
    // each carrier's delivery status is independently queryable in the audit trail).
    const now = new Date();
    const fromAddr = process.env.SMTP_FROM || process.env.OUTLOOK_FROM_EMAIL || "noreply@freight-dna.com";
    const logs: Awaited<ReturnType<typeof storage.createCarrierOutreachLog>>[] = [];
    for (let i = 0; i < emailDrafts.length; i++) {
      const draft = emailDrafts[i];
      const result = results[i];
      if (!result) continue;
      const perCarrierStatus = result.status === "sent" ? "sent" :
        result.status === "dedup_skipped" ? "dedup_skipped" :
        result.status === "throttled_daily_cap" || result.status === "throttled_too_soon" ? "dedup_skipped" :
        result.status === "failed" ? "failed" : "draft";
      const internetMsgId = (result as { internetMessageId?: string }).internetMessageId ?? null;
      const log = await storage.createCarrierOutreachLog({
        orgId: user.organizationId,
        laneId: req.params.laneId,
        companyId: lane.companyId ?? null,
        carrierIds: draft.carrierId ? [draft.carrierId] : [],
        carrierNames: [draft.carrierName],
        actorUserId: user.id,
        ownerUserId: lane.ownerUserId ?? null,
        overseerUserId: lane.overseerUserId ?? null,
        outreachMode,
        emailDrafts: [JSON.parse(JSON.stringify(draft))],
        sentAt: result.status === "sent" ? now : null,
        deliveryStatus: perCarrierStatus,
        failureReason: result.error ?? null,
        recipients: [JSON.parse(JSON.stringify(result))],
        threadId: internetMsgId,
        direction: "outbound",
        fromEmail: fromAddr,
        toEmail: result.email ?? null,
        subject: draft.subject ?? null,
        bodyPreview: draft.body ? draft.body.replace(/<[^>]+>/g, "").slice(0, 255) : null,
      });
      logs.push(log);
    }

    // ── Email Intelligence: log outbound email messages ────────────────────────
    // Fire-and-forget per sent carrier to avoid blocking the response.
    const fallbackThreadId = results.find(r => r.internetMessageId)?.internetMessageId ?? null;
    for (let ri = 0; ri < results.length; ri++) {
      const r = results[ri];
      if (r.status !== "sent") continue;
      const draftForCarrier = emailDrafts.find(d =>
        (d.carrierId && d.carrierId === r.carrierId) ||
        (d.carrierName && d.carrierName === r.carrierName)
      );
      const matchedLog = logs[ri];
      logOutboundCarrierEmail({
        orgId: user.organizationId,
        threadId: r.internetMessageId ?? fallbackThreadId,
        fromEmail: fromAddr,
        toEmail: r.email,
        subject: draftForCarrier?.subject ?? emailDrafts[0]?.subject ?? null,
        body: draftForCarrier?.body ?? null,
        linkedCarrierId: r.carrierId ?? null,
        linkedLaneId: req.params.laneId,
        linkedOutreachLogId: matchedLog?.id ?? null,
      }).catch(err =>
        console.error("[emailIntelligence] outbound log error:", err)
      );
    }

    // Upsert bench entries for carriers that were contacted (sent or no_email still = attempt)
    const sentAt = now.toISOString();
    for (const r of results) {
      if (r.status === "no_email") continue; // don't mark as contacted if no email existed
      if (r.status === "dedup_skipped") continue; // dedup-blocked carriers are not re-marked
      if (r.status === "throttled_daily_cap" || r.status === "throttled_too_soon") continue; // throttled carriers are not re-marked
      await storage.upsertLaneCarrierInterest({
        laneId: req.params.laneId,
        carrierId: r.carrierId,
        carrierName: r.carrierName,
        interestStatus: "needs_follow_up",
        outreachSentAt: sentAt,
      });
    }

    // Update carriersContactedCount on the lane
    const updatedBench = await storage.getLaneCarrierBench(req.params.laneId);
    const contactedKeys = new Set<string>();
    for (const b of updatedBench) {
      if (!b.outreachSentAt) continue;
      contactedKeys.add(b.carrierId ?? b.carrierName.toLowerCase().trim());
    }
    const newCount = contactedKeys.size;
    await storage.updateRecurringLane(req.params.laneId, { carriersContactedCount: newCount });

    // Auto-resolve if threshold reached
    let resolved = false;
    let resolveNowSend: string | undefined;
    if (newCount >= LANE_CONFIG.completionCarriersContacted) {
      resolveNowSend = new Date().toISOString();
      const snoozeUntil = new Date();
      snoozeUntil.setDate(snoozeUntil.getDate() + LANE_CONFIG.snoozeAfterResolveDays);
      await storage.updateRecurringLane(req.params.laneId, {
        resolvedAt: resolveNowSend,
        snoozedUntil: snoozeUntil.toISOString().split("T")[0],
      });
      await storage.resolveNbaCardsForLane(req.params.laneId);
      resolved = true;
    }

    // Patch cache so LWQ list reflects updated contacted count + resolved state immediately
    await storage.patchLaneSummaryCache(req.params.laneId, {
      carriersContactedCount: newCount,
      ...(resolved && resolveNowSend ? { resolvedAt: resolveNowSend } : {}),
    }).catch(() => {});

    res.json({ logs, results, sentCount, failedCount, dedupSkippedCount, throttledCount, carriersContactedCount: newCount, resolved, overallStatus });
  });

  // ── Outreach Log & Card Completion ────────────────────────────────────────

  app.post("/api/lanes/:laneId/outreach-log", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneWithAccessCheck(req.params.laneId, user!, res);
    if (!lane) return;

    const { carrierIds, carrierNames, outreachMode, emailDrafts, ownerUserId, overseerUserId, capturedEmails } = req.body;
    if (!Array.isArray(carrierNames) || carrierNames.length === 0) {
      return res.status(400).json({ error: "carrierNames required" });
    }
    // Guard: if carrierIds is provided, it must be a parallel array of the same length.
    // Mismatched lengths would silently associate wrong carrier IDs with carrier names.
    if (Array.isArray(carrierIds) && carrierIds.length > 0 && carrierIds.length !== carrierNames.length) {
      return res.status(400).json({ error: "carrierIds and carrierNames must be the same length" });
    }

    // Persist ad-hoc captured emails back to carrier catalog (org-scoped)
    if (capturedEmails && typeof capturedEmails === "object") {
      for (let i = 0; i < carrierNames.length; i++) {
        const cId = carrierIds?.[i] ?? null;
        const key = cId ?? carrierNames[i];
        const email = typeof capturedEmails[key] === "string" ? (capturedEmails[key] as string).trim() : null;
        if (email && cId) {
          // Only persist if carrier belongs to this org (updateCarrier enforces org constraint)
          await storage.updateCarrier(cId, user.organizationId, { primaryEmail: email }).catch(() => {/* non-fatal */});
        }
      }
    }

    // Validate every non-null carrierId belongs to the caller's org before writing
    if (Array.isArray(carrierIds)) {
      for (const cId of carrierIds) {
        if (!cId) continue;
        const c = await storage.getCarrier(cId);
        if (!c || c.orgId !== user.organizationId) {
          return res.status(403).json({ error: `Carrier ${cId} not found in your organization` });
        }
      }
    }

    const log = await storage.createCarrierOutreachLog({
      orgId: user.organizationId,
      laneId: req.params.laneId,
      companyId: lane.companyId ?? null,
      carrierIds: carrierIds ?? carrierNames.map(() => null),
      carrierNames,
      actorUserId: user.id,
      ownerUserId: ownerUserId ?? lane.ownerUserId ?? null,
      overseerUserId: overseerUserId ?? lane.overseerUserId ?? null,
      outreachMode: outreachMode ?? "lane_building",
      emailDrafts: emailDrafts ?? [],
    });

    // First upsert bench entries so the count reflects real distinct carriers contacted
    const now = new Date().toISOString();
    for (let i = 0; i < carrierNames.length; i++) {
      const cId = carrierIds?.[i] ?? null;
      await storage.upsertLaneCarrierInterest({
        laneId: req.params.laneId,
        carrierId: cId,
        carrierName: carrierNames[i],
        interestStatus: "needs_follow_up",
        outreachSentAt: now,
      });
    }

    // Count distinct carriers in the bench that have been contacted.
    // Deduplicate: prefer carrierId when set; fall back to normalized carrierName.
    // This prevents inflated counts if the same carrier appears under different
    // carrierId / name-only entries for the same lane.
    const updatedBench = await storage.getLaneCarrierBench(req.params.laneId);
    const contactedKeys = new Set<string>();
    for (const b of updatedBench) {
      if (!b.outreachSentAt) continue;
      contactedKeys.add(b.carrierId ?? b.carrierName.toLowerCase().trim());
    }
    const newCount = contactedKeys.size;
    await storage.updateRecurringLane(req.params.laneId, { carriersContactedCount: newCount });

    // Check if completion threshold reached (from shared LANE_CONFIG)
    const THRESHOLD = LANE_CONFIG.completionCarriersContacted;
    let resolved = false;
    let resolvedAt: string | undefined;
    if (newCount >= THRESHOLD) {
      resolvedAt = new Date().toISOString();
      const snoozeUntil = new Date();
      snoozeUntil.setDate(snoozeUntil.getDate() + LANE_CONFIG.snoozeAfterResolveDays);
      await storage.updateRecurringLane(req.params.laneId, {
        resolvedAt,
        snoozedUntil: snoozeUntil.toISOString().split("T")[0],
      });
      // Resolve all active NBA cards tied to this lane so they leave the dashboard
      await storage.resolveNbaCardsForLane(req.params.laneId);
      resolved = true;
    }

    // Patch cache so LWQ list reflects updated contacted count + resolved state immediately
    await storage.patchLaneSummaryCache(req.params.laneId, {
      carriersContactedCount: newCount,
      ...(resolved && resolvedAt ? { resolvedAt } : {}),
    }).catch(() => {});

    res.json({ log, carriersContactedCount: newCount, resolved });
  });

  app.get("/api/lanes/:laneId/outreach-log", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const lane = await getLaneForOrg(req.params.laneId, user!, res);
    if (!lane) return;
    const logs = await storage.getCarrierOutreachLogs(req.params.laneId);
    res.json(logs);
  });

  // ── Phase 2: Lane-specific carrier import ─────────────────────────────────

  /** POST /api/lanes/:laneId/import-carriers — import external carriers for a lane */
  app.post("/api/lanes/:laneId/import-carriers", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const { laneId } = req.params;
    const lane = await storage.getRecurringLane(laneId);
    if (!lane || lane.orgId !== user.organizationId) {
      return res.status(404).json({ error: "Lane not found" });
    }

    const schema = z.object({
      carriers: z.array(z.object({
        name: z.string().min(1),
        email: z.string().email().optional().or(z.literal("")),
        phone: z.string().optional(),
        mcDot: z.string().optional(),
      })).min(1).max(200),
      source: z.string().min(1).max(64),
      rawInput: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const { batch, results } = await storage.importCarriersForLane(
        user.organizationId,
        laneId,
        user.id,
        parsed.data.carriers.map(c => ({ ...c, email: c.email || undefined })),
        parsed.data.source,
        parsed.data.rawInput
      );
      res.status(201).json({ batch, results });
    } catch (err) {
      console.error("[lanes/import-carriers] error:", err);
      res.status(500).json({ error: "Import failed" });
    }
  });

  /** GET /api/lanes/:laneId/import-batches — list import batches for a lane */
  app.get("/api/lanes/:laneId/import-batches", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;
    const batches = await storage.getCarrierImportBatches(user.organizationId, req.params.laneId);
    res.json(batches);
  });

  // ── Lane Coverage Profile ──────────────────────────────────────────────────

  /** GET /api/lanes/:laneId/coverage-profile — compute on demand and cache */
  app.get("/api/lanes/:laneId/coverage-profile", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await getLaneForOrg(req.params.laneId, user, res);
    if (!lane) return;

    try {
      const { profile, carriers } = await getLaneCoverageProfile(lane, storage);
      res.json({ profile, carriers });
    } catch (err) {
      console.error("[coverage-profile] error:", err);
      res.status(500).json({ error: "Failed to compute coverage profile" });
    }
  });

  /** POST /api/lanes/:laneId/coverage-profile/confirm — user confirms stable status */
  app.post("/api/lanes/:laneId/coverage-profile/confirm", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await getLaneWithAccessCheck(req.params.laneId, user, res);
    if (!lane) return;

    try {
      const existing = await storage.getLaneCoverageProfileByLaneId(lane.id);
      if (!existing) {
        return res.status(404).json({ error: "No coverage profile found for this lane" });
      }
      const updated = await storage.updateLaneCoverageProfile(existing.id, {
        manuallyConfirmedByUserId: user.id,
        manuallyConfirmedAt: new Date().toISOString(),
        manualOverrideStatus: "stable",
        manualOverrideReason: req.body?.reason ?? "User confirmed stable status",
      });
      res.json({ profile: updated });
    } catch (err) {
      console.error("[coverage-profile/confirm] error:", err);
      res.status(500).json({ error: "Failed to confirm coverage profile" });
    }
  });

  /** POST /api/lanes/:laneId/coverage-profile/override — set manual override status */
  app.post("/api/lanes/:laneId/coverage-profile/override", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await getLaneWithAccessCheck(req.params.laneId, user, res);
    if (!lane) return;

    const schema = z.object({
      status: z.enum(["stable", "watch", "unstable"]),
      reason: z.string().min(1).max(500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      let existing = await storage.getLaneCoverageProfileByLaneId(lane.id);
      if (!existing) {
        // Create a minimal profile if none exists
        const profile = await getLaneCoverageProfile(lane, storage);
        existing = profile.profile;
      }
      const updated = await storage.updateLaneCoverageProfile(existing.id, {
        manualOverrideStatus: parsed.data.status,
        manualOverrideReason: parsed.data.reason,
        manuallyConfirmedByUserId: user.id,
        manuallyConfirmedAt: new Date().toISOString(),
      });
      res.json({ profile: updated });
    } catch (err) {
      console.error("[coverage-profile/override] error:", err);
      res.status(500).json({ error: "Failed to override coverage profile" });
    }
  });

  /** POST /api/lanes/:laneId/coverage-profile/broaden — enable open procurement mode */
  app.post("/api/lanes/:laneId/coverage-profile/broaden", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!await assertFlagEnabled(user.organizationId, res)) return;

    const lane = await getLaneWithAccessCheck(req.params.laneId, user, res);
    if (!lane) return;

    const active = req.body?.active !== false; // default true

    try {
      let existing = await storage.getLaneCoverageProfileByLaneId(lane.id);
      if (!existing) {
        const profile = await getLaneCoverageProfile(lane, storage);
        existing = profile.profile;
      }
      const updated = await storage.updateLaneCoverageProfile(existing.id, {
        broadenSearchActive: active,
      });
      res.json({ profile: updated });
    } catch (err) {
      console.error("[coverage-profile/broaden] error:", err);
      res.status(500).json({ error: "Failed to update broaden search flag" });
    }
  });

  // ── Outlook Reply Webhook — Task #182 ─────────────────────────────────────
  // Handles Microsoft Graph change notification handshakes and inbound reply events.
  // No auth required (Graph calls this endpoint directly); validated by clientState secret.

  app.post("/api/webhooks/outlook-reply", async (req, res) => {
    // ── Graph validation handshake ──────────────────────────────────────────
    const validationToken = req.query.validationToken as string | undefined;
    if (validationToken) {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(validationToken);
    }

    try {
      const notifications = req.body?.value;
      if (!Array.isArray(notifications) || notifications.length === 0) {
        return res.status(200).json({ received: 0 });
      }

      // In production, OUTLOOK_WEBHOOK_SECRET must be set to a strong unique value.
      // Without it we refuse to process notifications to prevent unauthenticated replay.
      if (!process.env.OUTLOOK_WEBHOOK_SECRET && process.env.NODE_ENV === "production") {
        console.error("[outlook-webhook] OUTLOOK_WEBHOOK_SECRET is not set — refusing to process notifications in production. Set this secret to enable reply tracking.");
        return res.status(200).json({ skipped: "OUTLOOK_WEBHOOK_SECRET not configured" });
      }
      // In development a predictable fallback is allowed so the subscription validation
      // handshake and local testing can proceed without requiring a configured secret.
      const expectedSecret = process.env.OUTLOOK_WEBHOOK_SECRET ?? "freight-dna-reply-tracker";
      const replyMailbox = process.env.OUTLOOK_REPLY_EMAIL?.trim();
      if (!replyMailbox) {
        return res.status(200).json({ skipped: "OUTLOOK_REPLY_EMAIL not configured" });
      }

      // Resolve the org that owns this monitored mailbox for scoped subject matching
      const mailboxUser = await storage.getUserByUsername(replyMailbox);
      const replyMailboxOrgId = mailboxUser?.organizationId ?? null;

      let processed = 0;

      for (const notification of notifications) {
        if (notification.clientState !== expectedSecret) {
          console.warn("[outlook-webhook] clientState mismatch — skipping notification");
          continue;
        }

        const resourceId = notification.resourceData?.id as string | undefined;
        if (!resourceId) continue;

        try {
          const token = await getGraphAccessToken();
          const msgUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(replyMailbox)}/messages/${resourceId}?$select=id,internetMessageId,internetMessageHeaders,subject,bodyPreview,body,from,conversationId,toRecipients,receivedDateTime`;
          const msgRes = await fetch(msgUrl, {
            headers: { Authorization: `Bearer ${token}` },
          });

          if (!msgRes.ok) {
            console.warn(`[outlook-webhook] Failed to fetch message ${resourceId}: ${msgRes.status}`);
            continue;
          }

          const msg = await msgRes.json() as {
            id: string;
            internetMessageId?: string;
            internetMessageHeaders?: Array<{ name: string; value: string }>;
            subject?: string;
            bodyPreview?: string;
            body?: { content?: string; contentType?: string };
            conversationId?: string;
            receivedDateTime?: string;
            from?: { emailAddress?: { address?: string; name?: string } };
            toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
          };

          const msgHeaders = msg.internetMessageHeaders ?? [];
          const inReplyTo = msgHeaders.find(h => h.name.toLowerCase() === "in-reply-to")?.value?.trim();
          const references = msgHeaders.find(h => h.name.toLowerCase() === "references")?.value?.trim();

          const candidateIds: string[] = [];
          if (inReplyTo) candidateIds.push(inReplyTo.replace(/[<>]/g, ""));
          if (references) {
            references.split(/\s+/).forEach(ref => {
              const id = ref.replace(/[<>]/g, "").trim();
              if (id) candidateIds.push(id);
            });
          }

          let matchedLog = null;

          // Primary: match by thread/message IDs from email headers.
          // Deterministic order: prefer the exact In-Reply-To ID first (most direct
          // indicator of the message being replied to), then fall back to any Reference
          // chain IDs. Within each tier, prefer the most recently sent log.
          if (candidateIds.length > 0) {
            // Separate In-Reply-To (first candidate) from References (remaining)
            const inReplyToId = inReplyTo ? inReplyTo.replace(/[<>]/g, "") : null;
            const refIds = candidateIds.filter(id => id !== inReplyToId);

            const tryLookup = async (ids: string[]) => {
              if (!ids.length) return null;
              if (replyMailboxOrgId) {
                const matches = await storage.getCarrierOutreachLogsByOrgAndThreadIds(replyMailboxOrgId, ids);
                // Sort by most recently sent to pick the best match when multiple logs match
                return matches.sort((a, b) =>
                  new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime()
                )[0] ?? null;
              }
              for (const tid of ids) {
                const found = await storage.getCarrierOutreachLogByThreadId(tid);
                if (found) return found;
              }
              return null;
            };

            // Try In-Reply-To first, then References
            if (inReplyToId) matchedLog = await tryLookup([inReplyToId]);
            if (!matchedLog && refIds.length > 0) matchedLog = await tryLookup(refIds);
          }

          // Fallback: subject-line correlation — strip "Re: " prefix and search
          // within the last 30 days of outreach logs scoped to the mailbox owner's org.
          // Note: subject fallback is only attempted when replyMailboxOrgId is resolved
          // (i.e. OUTLOOK_REPLY_EMAIL maps to a platform user via getUserByUsername).
          // For shared mailboxes not registered as platform users, thread-ID matching
          // still works; only this secondary fallback is skipped.
          if (!matchedLog && msg.subject && replyMailboxOrgId) {
            const rawSubject = msg.subject.replace(/^(Re:\s*)+/i, "").trim().toLowerCase();
            if (rawSubject) {
              matchedLog = await storage.getCarrierOutreachLogBySubjectFallback(replyMailboxOrgId, rawSubject);
            }
          }

          if (!matchedLog || matchedLog.replyReceivedAt) {
            continue;
          }

          const snippet = (msg.bodyPreview ?? "").slice(0, 300);
          const receivedAt = msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date();

          await storage.recordOutreachReply(matchedLog.id, snippet, receivedAt);
          processed++;
          console.log(`[outlook-webhook] Reply recorded for outreach log ${matchedLog.id}`);

          // ── Email Intelligence: queue inbound reply for signal extraction ───
          // Use conversationId as threadId for consistent thread-level dedup;
          // fall back to In-Reply-To message ID when conversationId is absent.
          // Pass internetMessageId as providerMessageId for upsert idempotency
          // so replayed Graph notifications don't create duplicate rows.
          const emailThreadId = msg.conversationId
            ?? (inReplyTo ? inReplyTo.replace(/[<>]/g, "") : null);
          const providerMsgId = msg.internetMessageId
            ? msg.internetMessageId.replace(/[<>]/g, "")
            : null;
          const carrierIds: string[] = Array.isArray(matchedLog.carrierIds)
            ? (matchedLog.carrierIds as string[])
            : [];
          const firstCarrierId = carrierIds[0] ?? null;
          logInboundCarrierEmail({
            orgId: matchedLog.orgId,
            providerMessageId: providerMsgId,
            threadId: emailThreadId,
            fromEmail: msg.from?.emailAddress?.address ?? null,
            toEmail: msg.toRecipients?.[0]?.emailAddress?.address ?? null,
            subject: msg.subject ?? null,
            body: msg.body?.content ?? msg.bodyPreview ?? null,
            linkedCarrierId: firstCarrierId,
            linkedLaneId: matchedLog.laneId ?? null,
            linkedOutreachLogId: matchedLog.id,
          }).then(({ created }) => {
            if (!created) {
              console.log(`[emailIntelligence] skipped duplicate inbound message (providerMsgId=${providerMsgId})`);
            }
          }).catch(err =>
            console.error("[emailIntelligence] inbound log error:", err)
          );
        } catch (innerErr) {
          console.error(`[outlook-webhook] Error processing notification for resource ${resourceId}:`, innerErr);
        }
      }

      res.status(200).json({ received: notifications.length, processed });
    } catch (err) {
      console.error("[outlook-webhook] Unhandled error:", err);
      res.status(200).json({ error: "Internal error" });
    }
  });

  // ── Procurement Task Outreach Logs ────────────────────────────────────────
  // Returns carrier_outreach_logs records written by the procurement send flow
  // for a given task, so the procurement workspace can display reply status.
  app.get("/api/procurement/:taskId/outreach-logs", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const task = await storage.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    // Org-scope: the task must belong to the user's org (via task.orgId or linked user)
    let taskOrgId: string | null | undefined = task.orgId;
    if (!taskOrgId) {
      const taskUserId = task.assignedTo || task.assignedBy;
      if (taskUserId) {
        const taskUser = await storage.getUser(taskUserId);
        taskOrgId = taskUser?.organizationId;
      }
    }
    if (!taskOrgId || taskOrgId !== user.organizationId) {
      return res.status(403).json({ error: "Access denied" });
    }
    const logs = await storage.getCarrierOutreachLogsByProcurementTaskId(user.organizationId, req.params.taskId);
    return res.json(logs);
  });

  // ── Admin: Graph Reply Tracking Health Check ─────────────────────────────
  // Returns the current Mail.Read permission status and subscription state.
  // Accessible to any authenticated admin user. Does not expose secrets.
  app.get("/api/admin/graph-reply-status", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.role !== "admin" && user.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }
    const status = getReplyTrackingStatus();
    return res.json(status);
  });

  app.get("/api/webhooks/outlook-reply", (req, res) => {
    const validationToken = req.query.validationToken as string | undefined;
    if (validationToken) {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(validationToken);
    }
    res.status(200).json({ status: "ready" });
  });
}

