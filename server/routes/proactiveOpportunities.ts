/**
 * Proactive Available Freight Outreach Engine — read-only routes (Phase 2).
 *
 * GET   /api/freight-opportunities                         list with filters
 * GET   /api/freight-opportunities/:id                     detail + ranked carriers + audit
 * GET   /api/companies/:id/outreach-policy                 fetch (or default) policy
 * PATCH /api/companies/:id/outreach-policy                 upsert policy
 *
 * No send/queue endpoints in Phase 2.
 */

import type { Express } from "express";
import multer from "multer";
import XLSX from "xlsx";
import { requireAuth, getCurrentUser } from "../auth";
import { storage, db } from "../storage";
import { freightOpportunityCarriers } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { runImportFromWorkbook as runAvailableFreightImportFromWorkbook } from "../availableFreightImporter";
import { loadEffectivePolicy, ensureShortlistRanked } from "../proactiveOpportunityService";
import {
  buildOpportunityDraft,
  cancelPendingWaves,
  feedbackToCarrierIntel,
  getOrSeedTemplate,
  sendOpportunityWave,
  type SendWaveOpts,
} from "../freightOpportunityOutreachService";
import { recordCarrierLaneOutcome } from "../services/carrierLaneOutcomes";
import { recordCarrierOverride } from "../services/carrierOverrides";
import { laneSig } from "../laneCrossLinkService";
import {
  FREIGHT_OPPORTUNITY_MODES,
  FREIGHT_OPPORTUNITY_RESPONSE_OUTCOMES,
  FREIGHT_OPPORTUNITY_STATUSES,
  FREIGHT_OUTREACH_TEMPLATE_KINDS,
  type FreightOutreachTemplateKind,
  type InsertCompanyOutreachPolicy,
} from "@shared/schema";

function orgId(req: Express.Request): string {
  return (req as any).session?.organizationId as string;
}
function userId(req: Express.Request): string | null {
  return (req as any).session?.userId ?? null;
}

// In-flight rank coordination. Concurrent detail requests for the same
// opportunity share the same in-flight Promise instead of each kicking off
// their own rank (which previously caused the server to hammer the ranker
// every 3s while the frontend polled).
const RANK_TIMEOUT_MS = 25_000;
const inflightRanks = new Map<string, Promise<{ ranked: boolean; carriers: any[]; error?: string }>>();
function runOrJoinRank(opp: import("@shared/schema").FreightOpportunity) {
  const existing = inflightRanks.get(opp.id);
  if (existing) return existing;
  const started = Date.now();
  const p = (async () => {
    try {
      const result = await Promise.race([
        ensureShortlistRanked(storage, opp),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Carrier ranking timed out")), RANK_TIMEOUT_MS),
        ),
      ]);
      console.log(
        `[freight-opps] inline rank ${opp.id} done in ${Date.now() - started}ms ` +
        `ranked=${result.ranked} carriers=${result.carriers.length}`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[freight-opps] inline rank ${opp.id} failed after ${Date.now() - started}ms:`, message);
      return { ranked: false, carriers: [] as any[], error: message };
    } finally {
      inflightRanks.delete(opp.id);
    }
  })();
  inflightRanks.set(opp.id, p);
  return p;
}

const carrierPatchSchema = z.object({
  excludedReason: z.union([z.enum([
    "recent_contact", "daily_cap", "not_approved", "do_not_use",
    "opted_out", "rep_override", "customer_carrier_blocked",
  ]), z.null()]).optional(),
  bucket: z.enum(["proven", "strong_fit_underused", "exploratory", "rep_added"]).optional(),
  rank: z.number().int().min(0).max(10000).optional(),
});

const policyPatchSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(FREIGHT_OPPORTUNITY_MODES).optional(),
  approvalRequired: z.boolean().optional(),
  maxCarriersPerOpportunity: z.number().int().min(1).max(100).optional(),
  leadTimeMinDays: z.number().int().min(0).max(60).optional(),
  leadTimeMaxDays: z.number().int().min(0).max(180).optional(),
  approvedCarrierOnly: z.boolean().optional(),
  approvedCarrierIds: z.array(z.string()).optional(),
  doNotAutomate: z.boolean().optional(),
  specialNotes: z.string().nullable().optional(),
  autoSendEnabled: z.boolean().optional(),
  autoSendHourCt: z.number().int().min(0).max(23).optional(),
  autoSendTopN: z.number().int().min(1).max(10).optional(),
  autoSendMaxPerDay: z.number().int().min(1).max(100).optional(),
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function registerProactiveOpportunityRoutes(app: Express) {
  // ── UPLOAD ────────────────────────────────────────────────────────────────
  // Direct file-upload entry to the Available Freight importer. Lets users
  // populate freight_opportunities (and load_fact mirror) without OneDrive.
  app.post("/api/freight-opportunities/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const org = orgId(req);
      if (!org) return res.status(400).json({ error: "No organization" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const summary = await runAvailableFreightImportFromWorkbook(
        workbook,
        req.file.originalname,
        org,
        user.id,
        "manual",
      );
      res.json(summary);
    } catch (err) {
      console.error("[freight-opps] upload error:", err);
      const message = err instanceof Error ? err.message : "Failed to import available freight";
      res.status(500).json({ error: message });
    }
  });

  // ── LIST ──────────────────────────────────────────────────────────────────
  app.get("/api/freight-opportunities", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const { companyId, status, limit = "50", offset = "0" } = req.query as Record<string, string>;
      const statusList = (status ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .filter((s): s is typeof FREIGHT_OPPORTUNITY_STATUSES[number] =>
          (FREIGHT_OPPORTUNITY_STATUSES as readonly string[]).includes(s));
      const rows = await storage.listFreightOpportunities(org, {
        companyId: companyId || undefined,
        status: statusList.length ? statusList : undefined,
        limit: Math.min(500, parseInt(limit) || 50),
        offset: Math.max(0, parseInt(offset) || 0),
      });
      // Augment each opportunity with included/total recommended-carrier counts
      // so the queue can show shortlist size without a follow-up request per row.
      const counts = await Promise.all(
        rows.map(r => storage.listFreightOpportunityCarriers(r.id)),
      );
      const items = rows.map((r, i) => {
        const carriers = counts[i];
        const includedCarrierCount = carriers.filter(c => !c.excludedReason).length;
        return {
          ...r,
          recommendedCarrierCount: carriers.length,
          includedCarrierCount,
        };
      });
      res.json({ items });
    } catch (err) {
      console.error("[freight-opps] list error:", err);
      res.status(500).json({ error: "Failed to list freight opportunities" });
    }
  });

  // ── DETAIL ────────────────────────────────────────────────────────────────
  app.get("/api/freight-opportunities/:id", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      // Backfill: rows imported via the Available Freight workbook never went
      // through generateOpportunitiesForCompany, so they may have no carrier
      // shortlist persisted. Kick off the rank in the background and return
      // immediately with `rankingInFlight: true` — the client polls every 3s
      // (refetchInterval in available-freight-detail.tsx) and picks up the
      // shortlist as soon as the rank lands. Awaiting inline previously
      // blocked the response for up to 25s and made the page appear frozen
      // after a click. `runOrJoinRank` already dedupes concurrent kickoffs
      // per opportunity, so polling does not stack up rank work.
      let rankingInFlight = false;
      if (carriers.length === 0) {
        rankingInFlight = true;
        // Fire-and-forget; errors are logged inside runOrJoinRank.
        void runOrJoinRank(opp);
      }
      const audit = await storage.listFreightOpportunityAudit(opp.id);
      // Phase 4: hydrate per-carrier response history so the UI can show
      // outcomes (last + count) without N follow-up calls.
      const responsesByRow = await Promise.all(
        carriers.map(c => storage.listFreightOpportunityResponses(c.id)),
      );
      const carriersWithResponses = carriers.map((c, i) => ({
        ...c,
        responses: responsesByRow[i],
        lastResponse: responsesByRow[i][0] ?? null,
      }));
      res.json({
        opportunity: opp,
        carriers: carriersWithResponses,
        audit,
        rankingInFlight,
        rankAttempted: rankingInFlight,
        rankError: null,
      });
    } catch (err) {
      console.error("[freight-opps] detail error:", err);
      res.status(500).json({ error: "Failed to fetch freight opportunity" });
    }
  });

  // ── FORCE RERANK ─────────────────────────────────────────────────────────
  // Used by the detail page's "Try ranking again" button. Wipes the existing
  // shortlist and re-runs scoring inside a transaction so a failed rerank
  // never leaves the opportunity worse off than it started.
  app.post("/api/freight-opportunities/:id/rerank", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      // Snapshot-and-restore (rather than a DB transaction) because
      // ensureShortlistRanked uses the global storage/db pool and would not
      // see uncommitted deletes from a wrapping tx (PG MVCC) — making a tx
      // wrapper a footgun. Snapshot in app memory, attempt rerank, and if it
      // fails or comes back empty when we previously had real rows, restore
      // the prior shortlist so we never leave the opp worse off.
      const priorRows = await storage.listFreightOpportunityCarriers(opp.id);
      const restorePayload = (): any[] => priorRows.map((r) => {
        const { id: _id, createdAt: _ca, ...rest } = r as any;
        return rest;
      });
      try {
        await db.delete(freightOpportunityCarriers).where(eq(freightOpportunityCarriers.opportunityId, opp.id));
        await ensureShortlistRanked(storage, opp);
      } catch (e) {
        console.warn(`[freight-opps] force rerank failed for ${opp.id}, restoring prior shortlist:`, e);
        if (priorRows.length > 0) {
          await storage.insertFreightOpportunityCarriers(restorePayload());
        }
        return res.status(500).json({ error: "Re-ranking failed; previous shortlist preserved." });
      }
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      // If rerank silently produced nothing but we did have a prior list,
      // restore it rather than leaving the opp blank — the rep can still see
      // who was previously suggested.
      if (carriers.length === 0 && priorRows.length > 0) {
        await storage.insertFreightOpportunityCarriers(restorePayload());
        return res.status(409).json({ error: "Re-ranking returned no candidates; previous shortlist preserved." });
      }
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "generated",
        actorUserId: userId(req),
        payload: { kind: "manual_force_rerank", shortlistSize: carriers.length },
      });
      res.json({ ranked: true, count: carriers.length });
    } catch (err) {
      console.error("[freight-opps] rerank error:", err);
      res.status(500).json({ error: "Failed to re-rank shortlist" });
    }
  });

  // ── SUGGESTED CARRIER POOL (beyond shortlist) ─────────────────────────────
  // Returns ~28 catalog carriers NOT already in the shortlist, lightly scored
  // by region/equipment match so the rep can cast a wider net (LWQ-style).
  app.get("/api/freight-opportunities/:id/carrier-pool", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      const [shortlistRows, allCarriers] = await Promise.all([
        storage.listFreightOpportunityCarriers(opp.id),
        storage.getCarriers(org),
      ]);
      const shortlistIds = new Set(shortlistRows.map(r => r.carrierId));

      // ── Enrichment: prior_quote (90d), customer_history (any prior row for
      // this companyId), and lastRate (latest quoted_rate for this carrier on
      // this lane). All bounded to org via the join on freight_opportunities.
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const [priorQuoteRows, customerHistRows, lastRateRows] = await Promise.all([
        // prior_quote: carrier actually quoted us in the last 90d (quoted_rate present),
        // not merely "was on a shortlist". Sourced from responses, not FOC rows.
        db.execute<{ carrier_id: string }>(sql`
          SELECT DISTINCT foc.carrier_id
          FROM freight_opportunity_responses fr
          JOIN freight_opportunity_carriers foc ON foc.id = fr.opportunity_carrier_id
          JOIN freight_opportunities fo ON fo.id = foc.opportunity_id
          WHERE fo.org_id = ${org}
            AND fr.quoted_rate IS NOT NULL
            AND fr.created_at > ${ninetyDaysAgo.toISOString()}
            AND foc.opportunity_id <> ${opp.id}
        `),
        // customer_history: bound to 1y so this stays cheap on long-tenured tenants.
        opp.companyId ? db.execute<{ carrier_id: string }>(sql`
          SELECT DISTINCT foc.carrier_id
          FROM freight_opportunity_carriers foc
          JOIN freight_opportunities fo ON fo.id = foc.opportunity_id
          WHERE fo.org_id = ${org}
            AND fo.company_id = ${opp.companyId}
            AND foc.created_at > ${oneYearAgo.toISOString()}
            AND foc.opportunity_id <> ${opp.id}
        `) : Promise.resolve({ rows: [] as Array<{ carrier_id: string }> }),
        // lastRate: latest quoted rate per carrier on this exact lane within last year.
        db.execute<{ carrier_id: string; quoted_rate: string | null; created_at: Date }>(sql`
          SELECT DISTINCT ON (foc.carrier_id)
            foc.carrier_id, fr.quoted_rate, fr.created_at
          FROM freight_opportunity_responses fr
          JOIN freight_opportunity_carriers foc ON foc.id = fr.opportunity_carrier_id
          JOIN freight_opportunities fo ON fo.id = foc.opportunity_id
          WHERE fo.org_id = ${org}
            AND fr.quoted_rate IS NOT NULL
            AND fr.created_at > ${oneYearAgo.toISOString()}
            AND lower(fo.origin) = lower(${opp.origin})
            AND lower(fo.destination) = lower(${opp.destination})
          ORDER BY foc.carrier_id, fr.created_at DESC
        `),
      ]);
      const priorQuoteSet = new Set((priorQuoteRows.rows ?? []).map(r => r.carrier_id));
      const customerHistSet = new Set((customerHistRows.rows ?? []).map(r => r.carrier_id));
      const lastRateMap = new Map<string, number>();
      for (const r of (lastRateRows.rows ?? [])) {
        if (r.quoted_rate != null) {
          const n = Number(r.quoted_rate);
          if (!isNaN(n)) lastRateMap.set(r.carrier_id, n);
        }
      }

      const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
      const oState = norm(opp.originState);
      const dState = norm(opp.destinationState);
      const oCity = norm(opp.origin);
      const dCity = norm(opp.destination);
      const equip = norm(opp.equipmentType);

      type PoolEntry = {
        id: string;
        carrierId: string;
        name: string;
        mc: string | null;
        region: string;
        fitScore: number;
        lastRate: number | null;
        tag: "in_region" | "prior_quote" | "new_prospect" | "lactalis_history";
        email: string | null;
        phone: string | null;
      };

      const scored: PoolEntry[] = [];
      for (const c of allCarriers) {
        if (shortlistIds.has(c.id)) continue;
        if (c.status === "do_not_use" || c.status === "inactive") continue;
        const cState = norm(c.state);
        const cCity = norm(c.city);
        const states: string[] = (c.statesServed ?? []).map(s => norm(s));
        const equips: string[] = (c.equipmentTypes ?? []).map(e => norm(e));

        let score = 30; // baseline
        let inRegion = false;
        if (cState && (cState === oState || cState === dState)) { score += 30; inRegion = true; }
        else if (states.length && (states.includes(oState) || states.includes(dState))) { score += 22; inRegion = true; }
        if (cCity && (cCity === oCity || cCity === dCity)) score += 12;
        if (equip && equips.length && equips.includes(equip)) score += 14;
        if (c.primaryEmail) score += 5;
        if (c.phone) score += 3;
        if (c.status === "flagged") score -= 10;

        const region = c.city && c.state ? `${c.city}, ${c.state.toUpperCase()}`
          : c.state ? c.state.toUpperCase()
          : (states[0] ?? "—");

        const hasCustomerHistory = customerHistSet.has(c.id);
        const hasPriorQuote = priorQuoteSet.has(c.id);
        if (hasCustomerHistory) score += 18;
        else if (hasPriorQuote) score += 10;

        const tag: "lactalis_history" | "prior_quote" | "in_region" | "new_prospect" =
          hasCustomerHistory ? "lactalis_history"
          : hasPriorQuote ? "prior_quote"
          : inRegion ? "in_region"
          : "new_prospect";

        scored.push({
          id: `pool_${c.id}`,
          carrierId: c.id,
          name: c.name,
          mc: c.mcDot,
          region,
          fitScore: Math.max(0, Math.min(99, Math.round(score))),
          lastRate: lastRateMap.get(c.id) ?? null,
          tag,
          email: c.primaryEmail,
          phone: c.phone,
        });
      }

      scored.sort((a, b) => b.fitScore - a.fitScore);
      const top = scored.slice(0, 28);
      res.json({ pool: top, total: scored.length });
    } catch (err) {
      console.error("[freight-opps] carrier-pool error:", err);
      res.status(500).json({ error: "Failed to load carrier pool" });
    }
  });

  // ── PROMOTE POOL CARRIERS TO SHORTLIST ────────────────────────────────────
  // Materializes pool selections as freight_opportunity_carriers rows (bucket
  // `rep_added`). Returns the new row IDs so the client can include them in a
  // send-wave call alongside any existing shortlist selections.
  const fromPoolSchema = z.object({
    carrierIds: z.array(z.string().min(1)).min(1).max(100),
  });
  app.post("/api/freight-opportunities/:id/carriers/from-pool", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.id));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const parsed = fromPoolSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      }

      const [existing, allCarriers] = await Promise.all([
        storage.listFreightOpportunityCarriers(opp.id),
        storage.getCarriers(org),
      ]);
      const existingByCarrier = new Map(existing.map(r => [r.carrierId, r]));
      const carrierById = new Map(allCarriers.map(c => [c.id, c]));
      const maxRank = existing.reduce((m, r) => Math.max(m, r.rank ?? 0), 0);

      const toInsert: import("@shared/schema").InsertFreightOpportunityCarrier[] = [];
      const reused: { carrierId: string; rowId: string }[] = [];
      let nextRank = maxRank;
      // Dedupe input so a payload with repeated IDs can't insert twice.
      const seenInPayload = new Set<string>();
      for (const carrierId of parsed.data.carrierIds) {
        if (seenInPayload.has(carrierId)) continue;
        seenInPayload.add(carrierId);
        const carrier = carrierById.get(carrierId);
        if (!carrier) continue;
        const dup = existingByCarrier.get(carrierId);
        if (dup) {
          reused.push({ carrierId, rowId: dup.id });
          continue;
        }
        nextRank += 1;
        toInsert.push({
          opportunityId: opp.id,
          carrierId,
          rank: nextRank,
          bucket: "rep_added",
          fitScore: 50,
          historyMatch: "none",
          explanation: "Manually added from suggested pool",
          explanationStructured: { source: "rep_added_from_pool" } as any,
          responsivenessSnapshot: null,
          excludedReason: null,
        });
      }

      const inserted = toInsert.length > 0
        ? await storage.insertFreightOpportunityCarriers(toInsert)
        : [];

      try {
        await storage.appendFreightOpportunityAudit({
          opportunityId: opp.id,
          eventType: "carrier_included_override",
          actorUserId: userId(req),
          payload: { source: "pool_promotion", added: inserted.length, reused: reused.length },
        });
      } catch { /* audit best-effort */ }

      const allRowsForCarriers = new Map<string, string>();
      reused.forEach(r => allRowsForCarriers.set(r.carrierId, r.rowId));
      inserted.forEach(r => allRowsForCarriers.set(r.carrierId, r.id));
      res.json({
        added: inserted.length,
        reused: reused.length,
        rowIdsByCarrierId: Object.fromEntries(allRowsForCarriers),
      });
    } catch (err) {
      console.error("[freight-opps] from-pool error:", err);
      res.status(500).json({ error: "Failed to promote pool carriers" });
    }
  });

  // ── CARRIER REORDER (atomic swap) ─────────────────────────────────────────
  app.post("/api/freight-opportunities/:oppId/carriers/:carrierRowId/swap", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const otherRowId = String((req.body ?? {}).otherRowId ?? "");
      if (!otherRowId) return res.status(400).json({ error: "otherRowId is required" });
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const a = carriers.find(c => c.id === String(req.params.carrierRowId));
      const b = carriers.find(c => c.id === otherRowId);
      if (!a || !b) return res.status(404).json({ error: "One or both carrier rows not found on this opportunity" });
      if (a.bucket !== b.bucket) {
        return res.status(400).json({ error: "Cannot reorder across buckets" });
      }
      // True swap: each row gets the other's prior rank, deterministic.
      const aRank = a.rank ?? 0;
      const bRank = b.rank ?? 0;
      const [updatedA, updatedB] = await Promise.all([
        storage.updateFreightOpportunityCarrier(a.id, { rank: bRank }),
        storage.updateFreightOpportunityCarrier(b.id, { rank: aRank }),
      ]);
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "carrier_reordered",
        actorUserId: userId(req),
        payload: { swapped: [a.carrierId, b.carrierId], from: [aRank, bRank], to: [bRank, aRank] },
      });
      res.json({ carriers: [updatedA, updatedB] });
    } catch (err) {
      console.error("[freight-opps] carrier swap error:", err);
      res.status(500).json({ error: "Failed to reorder carrier" });
    }
  });

  // ── CARRIER OVERRIDE (include/exclude, pin, reorder) ──────────────────────
  app.patch("/api/freight-opportunities/:oppId/carriers/:carrierRowId", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const parsed = carrierPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid carrier patch", details: parsed.error.flatten() });
      }
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const target = carriers.find(c => c.id === String(req.params.carrierRowId));
      if (!target) return res.status(404).json({ error: "Carrier row not found on this opportunity" });
      const updated = await storage.updateFreightOpportunityCarrier(target.id, parsed.data);
      // Audit overrides so reviewers can see who changed what.
      if (parsed.data.excludedReason !== undefined) {
        await storage.appendFreightOpportunityAudit({
          opportunityId: opp.id,
          eventType: parsed.data.excludedReason === null ? "carrier_included_override" : "carrier_excluded",
          actorUserId: userId(req),
          payload: { carrierId: target.carrierId, reason: parsed.data.excludedReason ?? "rep_included" },
        });
      }
      res.json({ carrier: updated });
    } catch (err) {
      console.error("[freight-opps] carrier patch error:", err);
      res.status(500).json({ error: "Failed to update carrier" });
    }
  });

  // Tenant-isolation guard: the policy tables' FKs only reference companies(id),
  // so we must verify here that the company belongs to the caller's org before
  // reading or writing. Without this, a caller could read or create a policy
  // row pointing at any company id across the global tenant space.
  async function assertCompanyBelongsToOrg(companyId: string, org: string): Promise<true | "not_found" | "forbidden"> {
    const company = await storage.getCompany(companyId);
    if (!company) return "not_found";
    if (company.organizationId && company.organizationId !== org) return "forbidden";
    return true;
  }

  // ── COMPANY OUTREACH POLICY ───────────────────────────────────────────────
  app.get("/api/companies/:id/outreach-policy", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const companyId = String(req.params.id);
      const check = await assertCompanyBelongsToOrg(companyId, org);
      if (check === "not_found") return res.status(404).json({ error: "Company not found" });
      if (check === "forbidden") return res.status(403).json({ error: "Company does not belong to your organization" });
      // Return the synthesized effective policy — persisted row if present,
      // otherwise PAFOE defaults bound to this org+company. Callers always
      // receive a usable policy object (never null).
      const policy = await loadEffectivePolicy(storage, org, companyId);
      res.json({ policy });
    } catch (err) {
      console.error("[freight-opps] policy get error:", err);
      res.status(500).json({ error: "Failed to fetch outreach policy" });
    }
  });

  // ── PHASE 4: TEMPLATES ────────────────────────────────────────────────────
  // Org-scoped editable templates with safe defaults seeded on first read.
  app.get("/api/freight-outreach-templates", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const items = await Promise.all(
        FREIGHT_OUTREACH_TEMPLATE_KINDS.map(k => getOrSeedTemplate(storage, org, k)),
      );
      res.json({ items });
    } catch (err) {
      console.error("[freight-opps] templates list error:", err);
      res.status(500).json({ error: "Failed to load templates" });
    }
  });

  const templatePutSchema = z.object({
    subject: z.string().min(1).max(500),
    body: z.string().min(1).max(20_000),
  });
  app.put("/api/freight-outreach-templates/:kind", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      // Admin-only: outreach templates are org-wide configuration; reps must
      // not be able to mutate what every other rep on the team will send.
      const actor = uid ? await storage.getUser(uid) : null;
      if (!actor || actor.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const kind = String(req.params.kind);
      if (!(FREIGHT_OUTREACH_TEMPLATE_KINDS as readonly string[]).includes(kind)) {
        return res.status(400).json({ error: "Invalid template kind" });
      }
      const parsed = templatePutSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid template payload", details: parsed.error.flatten() });
      }
      const tmpl = await storage.upsertFreightOutreachTemplate({
        orgId: org,
        kind: kind as FreightOutreachTemplateKind,
        subject: parsed.data.subject,
        body: parsed.data.body,
        updatedById: uid,
      });
      res.json({ template: tmpl });
    } catch (err) {
      console.error("[freight-opps] template upsert error:", err);
      res.status(500).json({ error: "Failed to save template" });
    }
  });

  // ── PHASE 4: PER-CARRIER DRAFT PREVIEW (used by the Send modal) ───────────
  app.get("/api/freight-opportunities/:oppId/carriers/:carrierRowId/draft", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const row = carriers.find(c => c.id === String(req.params.carrierRowId));
      if (!row) return res.status(404).json({ error: "Carrier row not found" });
      const uid = userId(req);
      const rep = uid ? await storage.getUser(uid) : null;
      if (!rep) return res.status(401).json({ error: "Not authenticated" });
      const draft = await buildOpportunityDraft(storage, opp, row, rep);
      res.json({ draft });
    } catch (err) {
      console.error("[freight-opps] draft error:", err);
      res.status(500).json({ error: "Failed to build draft" });
    }
  });

  // ── PHASE 4: SEND or SCHEDULE A WAVE ──────────────────────────────────────
  const sendWaveSchema = z.object({
    carrierRowIds: z.array(z.string().min(1)).min(1).max(100),
    scheduleAt: z.string().datetime().nullable().optional(),
    wave: z.number().int().min(1).max(10).optional(),
    overrides: z.record(z.object({
      subject: z.string().max(500).optional(),
      body: z.string().max(20_000).optional(),
    })).optional(),
    // Task #631 — accept the source path so a single-carrier UX (sending to
    // exactly one carrier from a non-AF surface) can carry true attribution
    // through to the outreach log instead of being mis-tagged as af_wave.
    sourceModule: z.enum(["af_wave", "single_carrier"]).optional(),
  });
  app.post("/api/freight-opportunities/:oppId/send", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      if (!uid) return res.status(401).json({ error: "Not authenticated" });
      const rep = await storage.getUser(uid);
      if (!rep) return res.status(401).json({ error: "Rep not found" });
      const parsed = sendWaveSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid send payload", details: parsed.error.flatten() });
      }
      // Task #631 — when the rep sends to a single carrier and the client did
      // not specify a source, infer "single_carrier" so suppression chips on
      // other surfaces show the correct attribution.
      const inferredSource: SendWaveOpts["sourceModule"] =
        parsed.data.sourceModule
        ?? (parsed.data.carrierRowIds.length === 1 ? "single_carrier" : "af_wave");
      const out = await sendOpportunityWave(storage, org, String(req.params.oppId), rep, {
        ...parsed.data,
        sourceModule: inferredSource,
      });
      res.json(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[freight-opps] send error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  // ── PHASE 4: MANUAL OUTCOME OVERRIDE (Phase 3 UI button) ──────────────────
  const outcomePostSchema = z.object({
    outcome: z.enum(FREIGHT_OPPORTUNITY_RESPONSE_OUTCOMES),
    notes: z.string().max(2000).nullable().optional(),
    quotedRate: z.string().max(50).nullable().optional(),
  });
  app.post("/api/freight-opportunities/:oppId/carriers/:carrierRowId/response", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const carriers = await storage.listFreightOpportunityCarriers(opp.id);
      const row = carriers.find(c => c.id === String(req.params.carrierRowId));
      if (!row) return res.status(404).json({ error: "Carrier row not found" });
      const parsed = outcomePostSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid outcome payload", details: parsed.error.flatten() });
      }
      const uid = userId(req);
      const response = await storage.createFreightOpportunityResponse({
        opportunityCarrierId: row.id,
        outcome: parsed.data.outcome,
        replySource: "manual_log",
        emailMessageId: null,
        notes: parsed.data.notes ?? null,
        recordedById: uid,
        quotedRate: parsed.data.quotedRate ?? null,
      });
      await storage.updateFreightOpportunityCarrier(row.id, { lastResponseId: response.id });
      // If the rep logged a positive outcome, halt any pending automated waves.
      if (["interested_now","interested_few_days","interested_next_week","interested_future","booked"].includes(parsed.data.outcome)) {
        await cancelPendingWaves(storage, opp.id, "positive_response_manual").catch(() => undefined);
      }
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "response_recorded",
        actorUserId: uid,
        payload: { carrierId: row.carrierId, outcome: parsed.data.outcome, source: "manual" },
      });

      // Task #637 — mirror the email-classifier wiring: every manual outcome
      // bumps reply_count; positive bumps yes_count; negatives bump
      // loss_count; "no_response" stays out (rep would not pick that here).
      const POSITIVE_OUTCOMES = new Set(["interested_now","interested_few_days","interested_next_week","interested_future","booked"]);
      const NEGATIVE_OUTCOMES = new Set(["declined","not_qualified","do_not_contact_lane"]);
      if (row.carrierId && parsed.data.outcome !== "no_response") {
        const sig = laneSig(opp.origin, opp.originState, opp.destination, opp.destinationState, opp.equipmentType);
        const laneParts = {
          origin: opp.origin,
          originState: opp.originState,
          destination: opp.destination,
          destinationState: opp.destinationState,
          equipmentType: opp.equipmentType,
        };
        // Tag every event with response.id so re-submissions of the same
        // manual outcome (double-click, retry) cannot double-count.
        const k = (kind: string) => `manual-outcome:${response.id}:${kind}`;
        await recordCarrierLaneOutcome({ orgId: org, carrierId: row.carrierId, laneSignature: sig, ...laneParts, event: "reply", eventKey: k("reply") });
        if (POSITIVE_OUTCOMES.has(parsed.data.outcome)) {
          await recordCarrierLaneOutcome({ orgId: org, carrierId: row.carrierId, laneSignature: sig, ...laneParts, event: "yes", eventKey: k("yes") });
        } else if (NEGATIVE_OUTCOMES.has(parsed.data.outcome)) {
          await recordCarrierLaneOutcome({ orgId: org, carrierId: row.carrierId, laneSignature: sig, ...laneParts, event: "loss", eventKey: k("loss") });
        }
        // Quote captured manually — record once.
        if (parsed.data.quotedRate) {
          await recordCarrierLaneOutcome({ orgId: org, carrierId: row.carrierId, laneSignature: sig, ...laneParts, event: "quote", eventKey: k("quote") });
        }
      }

      // Feed the signal back into ranking (additive, no master-data overwrite)
      await feedbackToCarrierIntel(storage, {
        orgId: org,
        carrierId: row.carrierId,
        opportunity: opp,
        outcome: parsed.data.outcome,
        confidence: 95,
        sourceNote: parsed.data.notes ?? "Rep-logged outcome",
        actorUserId: uid,
      });
      res.json({ response });
    } catch (err) {
      console.error("[freight-opps] response error:", err);
      res.status(500).json({ error: "Failed to record response" });
    }
  });

  /**
   * POST /api/freight-opportunities/:oppId/cover
   * Task #366 — Mark a freight opportunity as covered and emit a coaching/
   * rate-positioning row to load_fact. This is what closes the loop between
   * the My Procurement work surface and the Coaching/Rate Intelligence
   * pipeline: every covered load contributes a real rep + carrier + paid
   * rate + customer rate datapoint that downstream features can learn from.
   *
   * Body: { carrierId: string, paidRate: number, customerRate: number,
   *         carrierName?: string, notes?: string }
   *
   * carrierId is a carriers.id reference (the source carrier of truth).
   * carrierName is optional and overrides the looked-up name (useful when
   * the rep covered with a brand-new carrier that hasn't been catalogued
   * yet). paidRate is what we pay the carrier; customerRate is what the
   * customer pays us. revenue/cost/margin are computed as rate × loadCount
   * so a small lane-building sweep contributes correctly.
   */
  const coverSchema = z.object({
    carrierId: z.string().min(1).optional(),
    carrierName: z.string().min(1).max(200).optional(),
    paidRate: z.number().positive().max(999999),
    customerRate: z.number().positive().max(999999),
    notes: z.string().max(2000).nullable().optional(),
    // Task #636 — per-cover opt-out flags for the three downstream
    // capture loops (bench, lane rate band, recurring-lane suggestion).
    applyToBench: z.boolean().optional(),
    applyToRateBand: z.boolean().optional(),
    offerRecurringLane: z.boolean().optional(),
  }).refine(d => d.carrierId || d.carrierName, {
    message: "carrierId or carrierName is required",
  });
  app.post("/api/freight-opportunities/:oppId/cover", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      if (!uid) return res.status(401).json({ error: "Not authenticated" });
      const opp = await storage.getFreightOpportunity(org, String(req.params.oppId));
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      // Anyone with line-of-sight to the opp may close it: owner, delegate,
      // or a manager (managers may close on behalf of an out-of-office rep).
      const rep = await storage.getUser(uid);
      if (!rep) return res.status(401).json({ error: "Rep not found" });
      const isOwner = opp.ownerUserId === uid || opp.delegatedToUserId === uid;
      const isManager = ["admin", "director", "national_account_manager", "sales_director", "logistics_manager"].includes(rep.role);
      if (!isOwner && !isManager) {
        return res.status(403).json({ error: "Only the owner, delegate, or a manager can mark covered" });
      }
      const parsed = coverSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid cover payload", details: parsed.error.flatten() });
      }
      const { coverFreightOpportunity } = await import("../services/coverFreightOpportunity");
      const outcome = await coverFreightOpportunity({
        org,
        rep,
        opp,
        payload: {
          carrierId: parsed.data.carrierId ?? null,
          carrierName: parsed.data.carrierName ?? null,
          paidRate: parsed.data.paidRate,
          customerRate: parsed.data.customerRate,
          notes: parsed.data.notes ?? null,
          loops: {
            applyToBench: parsed.data.applyToBench ?? true,
            applyToRateBand: parsed.data.applyToRateBand ?? true,
            offerRecurringLane: parsed.data.offerRecurringLane ?? true,
          },
        },
      });
      if (!outcome.ok) {
        return res.status(outcome.status).json({ error: outcome.error });
      }
      return res.json({
        opportunity: outcome.opportunity,
        loadFact: outcome.loadFact,
        loops: outcome.loops,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[freight-opps] cover failed:", msg);
      return res.status(500).json({ error: "Failed to cover opportunity" });
    }
  });

  app.patch("/api/companies/:id/outreach-policy", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const companyId = String(req.params.id);
      const check = await assertCompanyBelongsToOrg(companyId, org);
      if (check === "not_found") return res.status(404).json({ error: "Company not found" });
      if (check === "forbidden") return res.status(403).json({ error: "Company does not belong to your organization" });
      const parsed = policyPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid policy payload", details: parsed.error.flatten() });
      }
      const existing = await storage.getCompanyOutreachPolicy(org, companyId);
      const merged: InsertCompanyOutreachPolicy = {
        orgId: org,
        companyId,
        enabled: parsed.data.enabled ?? existing?.enabled ?? false,
        mode: (parsed.data.mode ?? existing?.mode ?? "exact_load") as InsertCompanyOutreachPolicy["mode"],
        approvalRequired: parsed.data.approvalRequired ?? existing?.approvalRequired ?? true,
        maxCarriersPerOpportunity: parsed.data.maxCarriersPerOpportunity ?? existing?.maxCarriersPerOpportunity ?? 25,
        leadTimeMinDays: parsed.data.leadTimeMinDays ?? existing?.leadTimeMinDays ?? 2,
        leadTimeMaxDays: parsed.data.leadTimeMaxDays ?? existing?.leadTimeMaxDays ?? 7,
        approvedCarrierOnly: parsed.data.approvedCarrierOnly ?? existing?.approvedCarrierOnly ?? false,
        approvedCarrierIds: parsed.data.approvedCarrierIds ?? existing?.approvedCarrierIds ?? [],
        doNotAutomate: parsed.data.doNotAutomate ?? existing?.doNotAutomate ?? false,
        specialNotes: parsed.data.specialNotes ?? existing?.specialNotes ?? null,
        autoSendEnabled: parsed.data.autoSendEnabled ?? existing?.autoSendEnabled ?? false,
        autoSendHourCt: parsed.data.autoSendHourCt ?? existing?.autoSendHourCt ?? 8,
        autoSendTopN: parsed.data.autoSendTopN ?? existing?.autoSendTopN ?? 3,
        autoSendMaxPerDay: parsed.data.autoSendMaxPerDay ?? existing?.autoSendMaxPerDay ?? 10,
        updatedById: userId(req),
      };
      const policy = await storage.upsertCompanyOutreachPolicy(merged);
      res.json({ policy });
    } catch (err) {
      console.error("[freight-opps] policy patch error:", err);
      res.status(500).json({ error: "Failed to update outreach policy" });
    }
  });

  // Task #638 — Rep carrier override write. Idempotent per UTC day.
  // Accepts any (action, reasonCode) combo; reasonCode=null = explicit dismiss.
  app.post("/api/carrier-overrides", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const repId = userId(req);
      if (!repId) return res.status(401).json({ error: "Unauthorized" });

      const overrideSchema = z.object({
        carrierId: z.string().min(1),
        action: z.enum(["deselect_top3", "added_outside_topn"]),
        reasonCode: z.enum(["bad_service", "out_of_equipment", "wont_run_lane", "better_fit", "other"])
          .nullable().optional().transform(v => v ?? null),
        origin: z.string().nullable().optional(),
        originState: z.string().nullable().optional(),
        destination: z.string().nullable().optional(),
        destinationState: z.string().nullable().optional(),
        equipmentType: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      });

      const parsed = overrideSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      }
      const body = parsed.data;
      if (!body.origin && !body.destination) {
        return res.status(400).json({ error: "origin or destination required to derive laneSignature" });
      }

      const result = await recordCarrierOverride({
        orgId: org,
        carrierId: body.carrierId,
        repId,
        origin: body.origin ?? null,
        originState: body.originState ?? null,
        destination: body.destination ?? null,
        destinationState: body.destinationState ?? null,
        equipmentType: body.equipmentType ?? null,
        reasonCode: body.reasonCode,
        action: body.action,
        notes: body.notes ?? null,
      });
      res.json(result);
    } catch (err) {
      console.error("[carrier-overrides] write error:", err);
      res.status(500).json({ error: "Failed to record carrier override" });
    }
  });
}
