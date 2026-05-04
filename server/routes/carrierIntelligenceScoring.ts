/**
 * Carrier Intelligence — Scoring & Pricing routes (Task #369).
 *
 *   GET  /api/carrier-intelligence/scorecard
 *   GET  /api/carrier-intelligence/carriers/:carrierId         (rolodex id OR carrier_name)
 *   GET  /api/carrier-intelligence/lane-pricing
 *          ?origin=&destination=&originState=&destinationState=&trailer=&customer=
 *   GET  /api/carrier-intelligence/available-loads
 *   GET  /api/carrier-intelligence/available-loads/:orderId/recommendations
 *
 *   GET  /api/admin/carrier-intelligence/scoring                blend + thresholds + counts
 *   PUT  /api/admin/carrier-intelligence/scoring                update blend/thresholds
 *   POST /api/admin/carrier-intelligence/recompute              trigger nightly rebuild
 */

import type { Express } from "express";
import { z } from "zod";
import { eq, and, desc, inArray, sql, or } from "drizzle-orm";
import { requireUser } from "../auth";
import { db, storage } from "../storage";
import {
  carrierScorecardFact,
  carrierRecommendation,
  carriers as carriersTbl,
  carrierContacts as carrierContactsTbl,
  loadFact,
} from "@shared/schema";
import {
  getBlendConfig, setBlendConfig,
  getThresholds, setThresholds,
  type ScoringThresholds,
} from "../carrierIntelligenceSettings";
import { listScorecards, getScorecardForCarrier } from "../carrierScorecardService";
import { getBlendedRate } from "../pricingBlendService";
import { recommendCarriersForLoad } from "../carrierRecommendationEngine";
import { recomputeCarrierIntelligence } from "../carrierIntelligenceRecompute";
import { getErrorMessage } from "../lib/errors";
import { pStr, qStr, qOptStr } from "../lib/req";
import { todayIsoInOrgTz } from "../lib/orgLocalDate";
import {
  computePickupFreshness,
  daysSincePickup,
  type PickupFreshness,
} from "@shared/pickupFreshness";
import {
  applyPickupScope,
  countHiddenStale,
  DEFAULT_PICKUP_SCOPE,
  isPickupScopeValue,
  type PickupScopeValue,
} from "@shared/workflowOs/actionability";
import {
  applyOwnerFilter,
  type OwnerFilterValue,
  type WorkflowOsRow,
  type WorkflowOsUser,
} from "@shared/workflowOs/ownership";

// Workflow OS — Task #918. Mirror of the LWQ helper. Owner filter is sent
// as a single `owner` URL param via `serializeFiltersToUrl`; anything else
// silently degrades to "all" so the cockpit never breaks on a malformed
// saved view.
function parseOwnerFilterParam(raw: unknown): OwnerFilterValue {
  if (typeof raw !== "string" || raw.length === 0) return "all";
  if (raw === "all" || raw === "me" || raw === "am_book" || raw === "unassigned") return raw;
  if (raw.startsWith("specific:")) {
    const id = raw.slice("specific:".length);
    if (id) return { specificUserId: id };
  }
  return "all";
}

function orgOf(req: any): string | null {
  return (req?.session?.organizationId as string) ?? null;
}

async function requireAdmin(req: any, res: any): Promise<{ orgId: string; userId: string } | null> {
  const user = req.user;
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (user.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return null; }
  return { orgId: user.organizationId, userId: user.id };
}

export function registerCarrierIntelligenceScoringRoutes(app: Express): void {
  // ── GET /api/carrier-intelligence/scorecard ──────────────────────────────
  app.get("/api/carrier-intelligence/scorecard", requireUser, async (req, res) => {
    try {
      const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
      const equipment = (qOptStr(req.query.equipment)) || "ALL";
      const tier = qOptStr(req.query.tier);
      const minLoads = qStr(req.query.minLoads) ? Number(qStr(req.query.minLoads)) : undefined;
      const limit = qStr(req.query.limit) ? Number(qStr(req.query.limit)) : undefined;
      const rows = await listScorecards(orgId, { equipment, tier, minLoads, limit });
      return res.json({ rows });
    } catch (err) {
      console.error("[carrier-intel/scorecard]", err);
      return res.status(500).json({ error: "Failed to fetch scorecard" });
    }
  });

  // ── GET /api/carrier-intelligence/carriers/:carrierId ────────────────────
  // Accepts a carrier UUID from the rolodex OR a raw carrier_name (urlencoded).
  app.get("/api/carrier-intelligence/carriers/:carrierId", requireUser, async (req, res) => {
    try {
      const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
      const ident = decodeURIComponent(pStr(req.params.carrierId));
      const isUuidish = /^[0-9a-f-]{20,}$/i.test(ident);
      let carrierName = ident;
      let carrierMeta: { id: string | null; name: string; status: string | null; tags: string[] } | null = null;
      if (isUuidish) {
        const [c] = await db.select().from(carriersTbl)
          .where(and(eq(carriersTbl.orgId, orgId), eq(carriersTbl.id, ident))).limit(1);
        if (!c) return res.status(404).json({ error: "Carrier not found in rolodex" });
        carrierName = c.name;
        carrierMeta = { id: c.id, name: c.name, status: c.status, tags: (c.tags ?? []) as string[] };
      } else {
        const [c] = await db.select().from(carriersTbl)
          .where(and(eq(carriersTbl.orgId, orgId), eq(carriersTbl.name, carrierName))).limit(1);
        carrierMeta = c
          ? { id: c.id, name: c.name, status: c.status, tags: (c.tags ?? []) as string[] }
          : { id: null, name: carrierName, status: null, tags: [] };
      }
      const splits = await getScorecardForCarrier(orgId, carrierName);
      if (splits.length === 0) {
        return res.status(404).json({ error: "Carrier not in scorecard yet", carrier: carrierMeta });
      }
      const all = splits.find(s => s.equipmentType === "ALL") ?? splits[0];

      // ── Per-carrier deep dive payload ────────────────────────────────────
      // moveStatus filter (comma list of: realized | active | available).
      // An explicit empty selection returns an empty load list — the UI
      // contract is "what you see in the chips is what gets queried", so we
      // do NOT silently expand an empty selection to all buckets. Omitting
      // the param entirely defaults to all three.
      const validBuckets = new Set(["realized", "active", "available"]);
      const rawMs = qOptStr(req.query.moveStatus);
      const buckets = rawMs === undefined
        ? ["realized", "active", "available"]
        : rawMs.split(",").map(s => s.trim().toLowerCase()).filter(s => validBuckets.has(s));

      const loadRows = buckets.length === 0
        ? []
        : await db.select().from(loadFact)
            .where(and(
              eq(loadFact.orgId, orgId),
              eq(loadFact.carrierName, carrierName),
              inArray(loadFact.bucket, buckets),
            ))
            .orderBy(desc(loadFact.pickupDate))
            .limit(500);

      const recentLoads = loadRows.slice(0, 25).map(l => ({
        id: l.id,
        orderId: l.orderId,
        bucket: l.bucket,
        moveStatus: l.moveStatus,
        customerName: l.customerName,
        equipmentType: l.equipmentType,
        originCity: l.originCity, originState: l.originState,
        destinationCity: l.destinationCity, destinationState: l.destinationState,
        pickupDate: l.pickupDate, deliveryDate: l.deliveryDate,
        revenue: l.revenue, margin: l.margin, marginPct: l.marginPct,
        totalMiles: l.totalMiles,
      }));

      // Lane mix (top lanes by load count within the bucket filter)
      const laneMap = new Map<string, { lane: string; loads: number; revenue: number; margin: number }>();
      for (const l of loadRows) {
        const o = `${l.originCity ?? "?"}, ${l.originState ?? "?"}`;
        const d = `${l.destinationCity ?? "?"}, ${l.destinationState ?? "?"}`;
        const lane = `${o} → ${d}`;
        const cur = laneMap.get(lane) ?? { lane, loads: 0, revenue: 0, margin: 0 };
        cur.loads += 1;
        cur.revenue += Number(l.revenue ?? 0);
        cur.margin += Number(l.margin ?? 0);
        laneMap.set(lane, cur);
      }
      const laneMix = Array.from(laneMap.values())
        .sort((a, b) => b.loads - a.loads)
        .slice(0, 8);

      // Trend (monthly buckets from realized loads only — margin% & on-time%)
      const trendRows = await db.execute<{
        month: string; loads: string; revenue: string; margin: string;
        on_time_loads: string; rated_loads: string;
      }>(sql`
        SELECT
          ${loadFact.month} AS month,
          COUNT(*)::text AS loads,
          COALESCE(SUM(${loadFact.revenue}),0)::text AS revenue,
          COALESCE(SUM(${loadFact.margin}),0)::text AS margin,
          SUM(CASE
            WHEN ${loadFact.arrivedAtDelivery} IS NOT NULL
             AND ${loadFact.deliveryApptEnd} IS NOT NULL
             AND ${loadFact.arrivedAtDelivery}::timestamp <= ${loadFact.deliveryApptEnd}::timestamp
            THEN 1 ELSE 0 END)::text AS on_time_loads,
          SUM(CASE
            WHEN ${loadFact.arrivedAtDelivery} IS NOT NULL
             AND ${loadFact.deliveryApptEnd} IS NOT NULL
            THEN 1 ELSE 0 END)::text AS rated_loads
        FROM ${loadFact}
        WHERE ${loadFact.orgId} = ${orgId}
          AND ${loadFact.carrierName} = ${carrierName}
          AND ${loadFact.bucket} = 'realized'
          AND ${loadFact.month} IS NOT NULL
        GROUP BY ${loadFact.month}
        ORDER BY ${loadFact.month} ASC
      `);
      const trend = trendRows.rows.slice(-12).map(r => {
        const revenue = Number(r.revenue);
        const margin = Number(r.margin);
        const onTime = Number(r.on_time_loads);
        const rated = Number(r.rated_loads);
        return {
          month: r.month,
          loads: Number(r.loads),
          revenue, margin,
          marginPct: revenue > 0 ? (margin / revenue) * 100 : null,
          onTimePct: rated > 0 ? (onTime / rated) * 100 : null,
        };
      });

      // Contacts (only when carrier resolves to a rolodex row)
      const contacts = carrierMeta?.id
        ? await db.select().from(carrierContactsTbl)
            .where(and(
              eq(carrierContactsTbl.carrierId, carrierMeta.id),
              eq(carrierContactsTbl.isActive, true),
            ))
            .orderBy(desc(carrierContactsTbl.isPrimary), carrierContactsTbl.name)
        : [];

      // Active recommendations across this carrier's open loads (top 8).
      const recs = await db.select().from(carrierRecommendation)
        .where(and(
          eq(carrierRecommendation.orgId, orgId),
          eq(carrierRecommendation.carrierName, carrierName),
        ))
        .orderBy(desc(carrierRecommendation.totalScore))
        .limit(8);

      return res.json({
        carrier: carrierMeta,
        scorecard: all,
        equipmentSplits: splits,
        moveStatus: buckets,
        recentLoads,
        laneMix,
        trend,
        contacts,
        recommendations: recs,
      });
    } catch (err) {
      console.error("[carrier-intel/carriers/:carrierId]", err);
      return res.status(500).json({ error: "Failed to fetch carrier scorecard" });
    }
  });

  // ── GET /api/carrier-intelligence/lane-pricing ───────────────────────────
  const lanePricingSchema = z.object({
    origin: z.string().min(1),
    destination: z.string().min(1),
    originState: z.string().length(2).optional(),
    destinationState: z.string().length(2).optional(),
    trailer: z.string().optional(),
    equipmentType: z.string().optional(), // alias accepted for backward compat
    customer: z.string().optional(),
  });
  app.get("/api/carrier-intelligence/lane-pricing", requireUser, async (req, res) => {
    try {
      const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
      const parsed = lanePricingSchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      const equip = parsed.data.trailer ?? parsed.data.equipmentType ?? null;
      const result = await getBlendedRate({
        orgId,
        origin: parsed.data.origin,
        destination: parsed.data.destination,
        originState: parsed.data.originState ?? null,
        destinationState: parsed.data.destinationState ?? null,
        equipmentType: equip,
        customerName: parsed.data.customer ?? null,
      });
      return res.json(result);
    } catch (err) {
      console.error("[carrier-intel/lane-pricing]", err);
      return res.status(500).json({ error: "Failed to compute lane pricing" });
    }
  });

  // ── GET /api/carrier-intelligence/available-loads ────────────────────────
  app.get("/api/carrier-intelligence/available-loads", requireUser, async (req, res) => {
    try {
      const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });

      // Lazy back-fill of legacy synthetic Order #s. Cheap when there are no
      // legacy rows or when OneDrive isn't configured (both no-op). Run
      // before the SELECT so the response includes the recovered Order #s
      // on first refresh after deploy. Per-org mutex + 60s cooldown lives
      // inside `recoverLegacyAvailableLoadOrderIds`. Failures are swallowed
      // — the board still renders with synthetic IDs as fallback.
      try {
        const { recoverLegacyAvailableLoadOrderIds } = await import("../availableFreightImporter");
        await recoverLegacyAvailableLoadOrderIds(orgId);
      } catch (recoverErr) {
        console.warn(
          "[carrier-intel/available-loads] legacy orderId recovery failed (non-fatal):",
          recoverErr instanceof Error ? recoverErr.message : String(recoverErr),
        );
      }

      const limit = Math.min(500, Math.max(1, Number(qStr(req.query.limit)) || 100));

      // Workflow OS — Task #918. Owner-filter + pickup-scope params, mirrored
      // from the LWQ contract (see docs/workflow-os-spec.md sections A & B).
      // Both round-trip via `serializeFiltersToUrl` and are normalized through
      // the shared `qOptStr` helper so dup/array param attempts collapse cleanly.
      const ownerFilterValue = parseOwnerFilterParam(qOptStr(req.query.owner));
      const pickupScopeRaw = qOptStr(req.query.pickupScope);
      const pickupScope: PickupScopeValue = isPickupScopeValue(pickupScopeRaw)
        ? pickupScopeRaw
        : DEFAULT_PICKUP_SCOPE;

      const loads = await db.select().from(loadFact)
        .where(and(eq(loadFact.orgId, orgId), sql`${loadFact.bucket} IN ('available','unknown')`))
        .orderBy(desc(loadFact.pickupDate))
        .limit(limit);
      const loadIds = loads.map(l => l.id);
      const recs = loadIds.length === 0 ? [] : await db.select().from(carrierRecommendation)
        .where(and(eq(carrierRecommendation.orgId, orgId), inArray(carrierRecommendation.loadFactId, loadIds)))
        .orderBy(carrierRecommendation.rank);
      const recsByLoad = new Map<string, typeof recs>();
      for (const r of recs) {
        const list = recsByLoad.get(r.loadFactId) ?? [];
        if (list.length < 3) list.push(r);
        recsByLoad.set(r.loadFactId, list);
      }
      // Surface freightOpportunityId separately from orderId so the UI's
      // "Open" link still resolves to the freight_opportunity detail page
      // even after a legacy synthetic orderId has been renamed to the real
      // TMS Order #. Source: rawRow.id (the FreightOpportunity object the
      // load_fact mirror was built from), with a fallback to parsing the
      // synthetic `freight_opp:<uuid>` prefix for rows that haven't been
      // re-mirrored yet.
      const extractFreightOppId = (l: typeof loads[number]): string | null => {
        const raw = l.rawRow as { id?: unknown } | null | undefined;
        if (raw && typeof raw.id === "string" && raw.id) return raw.id;
        if (typeof l.orderId === "string" && l.orderId.startsWith("freight_opp:")) {
          return l.orderId.slice("freight_opp:".length);
        }
        return null;
      };

      // ── Workflow OS — stamp pickup context + ownership envelope ─────────
      // Loads have a real `pickupDate` column, so pickup-freshness is
      // computed directly (no cross-link to freight_opportunity needed).
      // Owner mapping is by name: load_fact.accountManager is text, so we
      // resolve it through the org user roster. Loads whose accountManager
      // doesn't match any org user fall through with `legacyOwnerId = null`
      // — they remain visible under "all"/"unassigned" but not under "me".
      const todayIso = todayIsoInOrgTz(new Date());
      const orgUsers = await storage.getUsers(orgId);
      const sessionUser = req.user as WorkflowOsUser | undefined;
      const userByName = new Map<string, string>();
      for (const u of orgUsers) {
        const key = (u.name ?? "").toLowerCase().trim();
        if (key) userByName.set(key, u.id);
      }
      // Workflow OS contract — every row carries pickupWindowStart +
      // pickupFreshness + pickupDaysAgo + status so the shared
      // applyPickupScope / countHiddenStale predicates work uniformly.
      // `bucket` ("available" | "unknown") maps to the AL surface's
      // ACTIONABLE_OPEN_STATUSES (`["available", "pending"]`); we collapse
      // "unknown" to "available" so it isn't dropped by the actionable scope.
      type StampedLoad = (typeof loads)[number] & WorkflowOsRow & {
        freightOpportunityId: string | null;
        topRecommendations: (typeof recs);
        pickupWindowStart: string | null;
        pickupFreshness: PickupFreshness;
        pickupDaysAgo: number | null;
        status: string;
      };
      const stamped: StampedLoad[] = loads.map((l) => {
        const acctMgrKey = (l.accountManager ?? "").toLowerCase().trim();
        const legacyOwnerId = acctMgrKey ? userByName.get(acctMgrKey) ?? null : null;
        const status = l.bucket === "unknown" ? "available" : l.bucket;
        return {
          ...l,
          freightOpportunityId: extractFreightOppId(l),
          topRecommendations: recsByLoad.get(l.id) ?? [],
          pickupWindowStart: l.pickupDate,
          pickupFreshness: computePickupFreshness(l.pickupDate, todayIso),
          pickupDaysAgo: daysSincePickup(l.pickupDate, todayIso),
          status,
          ownership: null,
          legacyOwnerId,
          delegatedToUserId: null,
        };
      });

      // Customer dropdown is computed pre-filter so it doesn't shrink as the
      // rep changes owner/scope (mirrors the LWQ behaviour).
      const customers = [...new Set(
        stamped.map((l) => l.customerName).filter((n): n is string => !!n && n.trim() !== "")
      )].sort((a, b) => a.localeCompare(b));

      // ── Workflow OS — Owner filter (pre-pickup-scope) ───────────────────
      // load_fact stores customer as text (no FK to companies). To support
      // the canonical "am_book" mode (Task #930), we resolve the deduped
      // non-empty customer names against companies.name (case-insensitive,
      // trim-tolerant) and feed the resulting companyId → assignedTo map
      // into `applyOwnerFilter`. We map every stamped row to its resolved
      // companyId so isRowInUsersAmBook can match by `row.companyId` even
      // when load_fact.companyId itself is null (the common case here).
      // Other owner modes skip the lookup so they incur no extra cost.
      const companyAssignedToByCompanyId: Map<string, string | null> = new Map();
      if (ownerFilterValue === "am_book") {
        const customerNames = Array.from(new Set(
          stamped
            .map((l) => (l.customerName ?? "").trim())
            .filter((n) => n.length > 0),
        ));
        if (customerNames.length > 0) {
          const matchedCompanies = await storage.getCompaniesByNames(customerNames, orgId);
          const companyIdByNormalizedName = new Map<string, string>();
          for (const c of matchedCompanies) {
            companyAssignedToByCompanyId.set(c.id, c.assignedTo ?? null);
            const key = (c.name ?? "").trim().toLowerCase();
            if (key) companyIdByNormalizedName.set(key, c.id);
          }
          // Project the resolved companyId onto each row so the WorkflowOsRow
          // contract (`row.companyId → companies.assignedTo`) is satisfied
          // for am_book without relying on the (usually-null) load_fact.companyId.
          for (const row of stamped) {
            const key = (row.customerName ?? "").trim().toLowerCase();
            if (!key) continue;
            const resolvedCompanyId = companyIdByNormalizedName.get(key);
            if (resolvedCompanyId) row.companyId = resolvedCompanyId;
          }
        }
      }
      const ownerCtx = {
        user: (sessionUser ?? { id: "", organizationId: orgId, role: "rep", name: "" }) as WorkflowOsUser,
        orgUsers: orgUsers as WorkflowOsUser[],
        companyAssignedToByCompanyId,
      };
      const owned = applyOwnerFilter(stamped, ownerFilterValue, ownerCtx);

      // ── Workflow OS — pickup scope (post-owner, pre-response) ───────────
      // hiddenStale is counted on the owned set BEFORE the scope filter so
      // the Stale-N chip answers "how many of MY loads is actionable
      // currently hiding?". It's independent of the chosen scope value.
      const actionabilityCtx = { surface: "available_loads" as const, todayIso };
      const hiddenStale = countHiddenStale(owned, actionabilityCtx);
      const scoped = applyPickupScope(owned, pickupScope, actionabilityCtx);

      return res.json({
        loads: scoped.map((l) => {
          // Strip the WorkflowOsRow envelope from the response to keep the
          // wire shape lean — the client only needs the row + pickup +
          // status fields it renders. Owner state is inferred from the
          // chosen filter, not echoed back per row.
          const { ownership, legacyOwnerId, delegatedToUserId, ...rest } = l;
          void ownership; void legacyOwnerId; void delegatedToUserId;
          return rest;
        }),
        hiddenStale,
        pickupScope,
        customers,
      });
    } catch (err) {
      console.error("[carrier-intel/available-loads]", err);
      return res.status(500).json({ error: "Failed to list available loads" });
    }
  });

  // ── GET /api/carrier-intelligence/available-loads/:orderId/recommendations
  // The path uses orderId (the TMS-facing identifier) per the spec; we
  // resolve to load_fact.id internally.
  app.get("/api/carrier-intelligence/available-loads/:orderId/recommendations", requireUser, async (req, res) => {
    try {
      const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
      const limit = Math.min(15, Math.max(1, Number(qStr(req.query.limit)) || 5));
      const refresh = qStr(req.query.refresh) === "1";
      const orderId = decodeURIComponent(pStr(req.params.orderId));
      const [load] = await db.select().from(loadFact)
        .where(and(eq(loadFact.orgId, orgId), or(eq(loadFact.orderId, orderId), eq(loadFact.id, orderId))!))
        .limit(1);
      if (!load) return res.status(404).json({ error: `Load not found: ${orderId}` });

      if (refresh) {
        const fresh = await recommendCarriersForLoad(orgId, load.id, { limit });
        return res.json(fresh);
      }
      const cached = await db.select().from(carrierRecommendation)
        .where(and(eq(carrierRecommendation.orgId, orgId), eq(carrierRecommendation.loadFactId, load.id)))
        .orderBy(carrierRecommendation.rank)
        .limit(limit);
      if (cached.length > 0) {
        return res.json({
          loadFactId: load.id,
          orderId: load.orderId,
          origin: { city: load.originCity, state: load.originState },
          destination: { city: load.destinationCity, state: load.destinationState },
          equipmentType: load.equipmentType,
          customerName: load.customerName,
          candidates: cached,
          fromCache: true,
          generatedAt: cached[0]?.computedAt ?? null,
        });
      }
      const fresh = await recommendCarriersForLoad(orgId, load.id, { limit });
      return res.json(fresh);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[carrier-intel/available-loads/:orderId/recs]", msg);
      return res.status(500).json({ error: msg });
    }
  });

  // ── Admin: settings + recompute ──────────────────────────────────────────
  app.get("/api/admin/carrier-intelligence/scoring", requireUser, async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const [blend, thresholds] = await Promise.all([
        getBlendConfig(ctx.orgId),
        getThresholds(ctx.orgId),
      ]);
      const counts = await db.execute<{ scorecards: string; lanes: string; recs: string }>(sql`
        SELECT
          (SELECT COUNT(*)::text FROM carrier_scorecard_fact WHERE org_id = ${ctx.orgId}) AS scorecards,
          (SELECT COUNT(*)::text FROM lane_rate_history WHERE org_id = ${ctx.orgId}) AS lanes,
          (SELECT COUNT(*)::text FROM carrier_recommendation WHERE org_id = ${ctx.orgId}) AS recs
      `);
      const lastComputedRows = await db.select({ v: sql<string>`MAX(${carrierScorecardFact.computedAt})::text` })
        .from(carrierScorecardFact).where(eq(carrierScorecardFact.orgId, ctx.orgId));
      return res.json({
        blend, thresholds,
        counts: counts.rows[0] ?? { scorecards: "0", lanes: "0", recs: "0" },
        lastComputedAt: lastComputedRows[0]?.v ?? null,
      });
    } catch (err) {
      console.error("[admin/carrier-intel/scoring GET]", err);
      return res.status(500).json({ error: "Failed to read scoring settings" });
    }
  });

  const fallbackTierEnum = z.enum([
    "lane_customer_trailer", "lane_customer", "lane_trailer", "lane",
    "nearby_lane", "state_pair", "trailer_benchmark",
  ]);
  const perCustomerOverrideSchema = z.record(z.string(), z.object({
    sonarWeight: z.number().min(0).max(1).optional(),
    minHistoryLoads: z.number().min(0).max(100).optional(),
  }));
  const confidenceChipsSchema = z.object({
    greenMinLoads: z.number().min(0).max(100).optional(),
    greenMaxSpreadPct: z.number().min(0).max(100).optional(),
    yellowMinLoads: z.number().min(0).max(100).optional(),
  });
  const updateSchema = z.object({
    blend: z.object({
      sonarWeight: z.number().min(0).max(1).optional(),
      minHistoryLoads: z.number().min(0).max(100).optional(),
      highConfidenceSpreadPct: z.number().min(0).max(100).optional(),
      refreshIntervalHours: z.number().min(1).max(168).optional(),
      sparseHistoryMultiplier: z.number().min(1).max(10).optional(),
      sonarSparseBumpAmount: z.number().min(0).max(0.5).optional(),
      fallbackOrder: z.array(fallbackTierEnum).optional(),
      perCustomerOverrides: perCustomerOverrideSchema.optional(),
    }).optional(),
    thresholds: z.object({
      tierAMinScore: z.number().min(0).max(100).optional(),
      tierBMinScore: z.number().min(0).max(100).optional(),
      recencyDecayDays: z.number().min(1).max(365).optional(),
      refusalRateThreshold: z.number().min(0).max(1).optional(),
      refusalMinLoads: z.number().min(0).max(100).optional(),
      // Lane-first rebalance: org-tunable lane-fit floor below which a
      // carrier can only appear as a flagged fallback. Default 50.
      minLaneFitForTopRank: z.number().min(0).max(100).optional(),
      confidenceChips: confidenceChipsSchema.optional(),
    }).optional(),
  });
  app.put("/api/admin/carrier-intelligence/scoring", requireUser, async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      const [blend, thresholds] = await Promise.all([
        parsed.data.blend ? setBlendConfig(ctx.orgId, parsed.data.blend) : getBlendConfig(ctx.orgId),
        parsed.data.thresholds
          ? setThresholds(ctx.orgId, parsed.data.thresholds as Partial<ScoringThresholds>)
          : getThresholds(ctx.orgId),
      ]);
      return res.json({ ok: true, blend, thresholds });
    } catch (err) {
      console.error("[admin/carrier-intel/scoring PUT]", err);
      return res.status(500).json({ error: "Failed to update scoring settings" });
    }
  });

  app.post("/api/admin/carrier-intelligence/recompute", requireUser, async (req, res) => {
    const ctx = await requireAdmin(req, res); if (!ctx) return;
    try {
      const skipRecs = req.body?.skipRecommendations === true;
      const summary = await recomputeCarrierIntelligence(ctx.orgId, {
        skipRecommendations: skipRecs,
        maxRecommendationLoads: typeof req.body?.maxLoads === "number" ? req.body.maxLoads : undefined,
      });
      return res.json({ ok: true, summary });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[admin/carrier-intel/recompute]", msg);
      return res.status(500).json({ error: msg });
    }
  });
}
