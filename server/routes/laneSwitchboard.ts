// Global Lane Switchboard (Task #652)
//
// Single backend endpoint that fans out to the three high-traffic lane
// surfaces (LWQ recurring lanes, Available Freight cockpit, Customer
// Quotes spot-search) in parallel and returns the top 5 from each.
//
// Visibility / org scoping mirrors the existing endpoints exactly — we
// reuse `resolveVisibleUserIds` for LWQ, the same OPEN_OPP_STATUSES set
// freight-opportunity context uses, and `searchSpotQuote` for quotes.

import type { Express } from "express";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, getCurrentUser } from "../auth";
import { getErrorMessage } from "../lib/errors";
import { storage, db } from "../storage";
import {
  recurringLanes,
  freightOpportunities,
  carrierOutreachLogs,
  users,
  type RecurringLane,
  type FreightOpportunity,
} from "@shared/schema";
import { searchSpotQuote, type SpotSearchResult } from "../services/customerQuotes";

const OPEN_OPP_STATUSES = [
  "new",
  "ready_to_send",
  "sent",
  "awaiting_carrier_reply",
  "awaiting_customer_confirm",
  "partially_covered",
] as const;

const TOP_PER_COLUMN = 5;

// Equipment families surfaced on the LWQ/AF/CQ surfaces. The switchboard
// matches at family granularity so "van" matches "Dry Van" / "Box Truck"
// without forcing the rep to remember the exact TMS string.
function equipmentFamily(raw: string | null | undefined): string | null {
  const u = (raw ?? "").trim().toLowerCase();
  if (!u) return null;
  if (
    u === "van" || u === "dry van" || u === "dryvan" || u === "v" ||
    u === "box truck" || u === "box-truck" || u === "boxtruck" ||
    u.includes("dry van") || u.includes("box truck")
  ) return "van";
  if (
    u.includes("reefer") || u.includes("refrig") || u.includes("multi-temp") ||
    u.includes("multi temp") || u === "refr" || u === "r"
  ) return "reefer";
  // Flatbed / open-deck family — the parser collapses literal "open" /
  // "open deck" into this bucket too, since open-deck freight is the
  // operational umbrella for flatbed, step deck, RGN, and conestoga in
  // this org's TMS taxonomy.
  if (
    u.includes("flatbed") || u === "fb" || u === "f" ||
    u.includes("step deck") || u.includes("stepdeck") || u === "sd" ||
    u.includes("rgn") || u.includes("conestoga") ||
    u === "open" || u === "open deck" || u === "open-deck" ||
    u.includes("open deck")
  ) return "flatbed";
  return null;
}

function laneEquipMatches(rowEquip: string | null | undefined, queryFamily: string | null): boolean {
  if (!queryFamily) return true;
  const rowFamily = equipmentFamily(rowEquip);
  if (!rowFamily) return false;
  // Treat "open" / "flatbed" as the same family for switchboard matching
  // (the parser collapses both to "flatbed" today; this stays forgiving).
  return rowFamily === queryFamily;
}

function normCity(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function normState(s: string | null | undefined): string | null {
  const v = (s ?? "").trim().toUpperCase();
  return v.length === 2 ? v : null;
}

const inputSchema = z.object({
  originCity: z.string().min(1).max(80),
  originState: z.string().max(8).optional(),
  destCity: z.string().min(1).max(80),
  destState: z.string().max(8).optional(),
  equipment: z.string().max(40).optional(),
});

export interface SwitchboardRecurringRow {
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyName: string | null;
  ownerName: string | null;
  ownerUserId: string | null;
  carriersContactedCount: number | null;
  laneScore: number | null;
  // Most recent successful outreach timestamp on this lane (max sent_at
  // across carrier_outreach_logs). Surfaces "last touch" so a rep can
  // see at a glance whether the lane is being actively worked.
  lastTouchAt: string | null;
}

export interface SwitchboardLiveRow {
  opportunityId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  status: string;
  pickupWindowStart: string | null;
  loadCount: number | null;
  laneSignature: string;
}

export interface SwitchboardHistoricalRow {
  quoteId: string;
  customerName: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string | null;
  outcomeStatus: string | null;
  quotedAmount: number | null;
  requestDate: string;
}

export interface SwitchboardResponse {
  parsed: {
    originCity: string;
    originState: string | null;
    destCity: string;
    destState: string | null;
    equipment: string | null;
  };
  recurring: SwitchboardRecurringRow[];
  live: SwitchboardLiveRow[];
  historical: SwitchboardHistoricalRow[];
  totals: {
    recurring: number;
    live: number;
    historical: number;
  };
}

export function registerLaneSwitchboardRoutes(app: Express) {
  app.get("/api/lane-switchboard", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = inputSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
    }

    const originCityNorm = normCity(parsed.data.originCity);
    const destCityNorm = normCity(parsed.data.destCity);
    const originStateNorm = normState(parsed.data.originState);
    const destStateNorm = normState(parsed.data.destState);
    const equipmentFam = equipmentFamily(parsed.data.equipment ?? null);

    if (!originCityNorm || !destCityNorm) {
      return res.status(400).json({ error: "originCity and destCity are required" });
    }

    try {
      const [recurring, live, historical] = await Promise.all([
        fetchRecurring(user, originCityNorm, originStateNorm, destCityNorm, destStateNorm, equipmentFam),
        fetchLive(user.organizationId, originCityNorm, originStateNorm, destCityNorm, destStateNorm, equipmentFam),
        fetchHistorical(user.organizationId, parsed.data),
      ]);

      const response: SwitchboardResponse = {
        parsed: {
          originCity: parsed.data.originCity,
          originState: originStateNorm,
          destCity: parsed.data.destCity,
          destState: destStateNorm,
          equipment: equipmentFam,
        },
        recurring: recurring.slice(0, TOP_PER_COLUMN),
        live: live.slice(0, TOP_PER_COLUMN),
        historical: historical.slice(0, TOP_PER_COLUMN),
        totals: {
          recurring: recurring.length,
          live: live.length,
          historical: historical.length,
        },
      };
      res.json(response);
    } catch (err) {
      console.error("[lane-switchboard] error:", err);
      res.status(500).json({ error: getErrorMessage(err) ?? "Switchboard failed" });
    }
  });
}

// ── Recurring lanes (LWQ) ────────────────────────────────────────────────────

async function fetchRecurring(
  user: { id: string; organizationId: string; role: string },
  originCity: string,
  originState: string | null,
  destCity: string,
  destState: string | null,
  equipmentFam: string | null,
): Promise<SwitchboardRecurringRow[]> {
  const { visibleUserIds, canSeeUnassigned } = await storage.resolveVisibleUserIds(
    user.id, user.organizationId, user.role,
  );

  // The `origin` / `destination` columns historically store either "city"
  // or "city, state" (case-insensitive). We accept either form and ALSO
  // require origin_state / destination_state to match when a state was
  // supplied so that "Springfield, IL" doesn't match "Springfield, MO".
  // Equipment is filtered in application code so family rules stay
  // consistent with the rest of the app.
  const originPatterns = originState
    ? [originCity, `${originCity}, ${originState.toLowerCase()}`]
    : [originCity];
  const destPatterns = destState
    ? [destCity, `${destCity}, ${destState.toLowerCase()}`]
    : [destCity];

  const conds = [
    eq(recurringLanes.orgId, user.organizationId),
    sql`lower(trim(${recurringLanes.origin})) in (${sql.join(originPatterns.map(p => sql`${p}`), sql`, `)})`,
    sql`lower(trim(${recurringLanes.destination})) in (${sql.join(destPatterns.map(p => sql`${p}`), sql`, `)})`,
  ];
  if (originState) {
    conds.push(sql`lower(coalesce(${recurringLanes.originState}, '')) = ${originState.toLowerCase()}`);
  }
  if (destState) {
    conds.push(sql`lower(coalesce(${recurringLanes.destinationState}, '')) = ${destState.toLowerCase()}`);
  }

  const rows = await db.select().from(recurringLanes).where(and(...conds)) as RecurringLane[];

  const visibleSet = new Set(visibleUserIds);
  const visible = rows.filter(r => {
    if (r.ownerUserId) return visibleSet.has(r.ownerUserId);
    return canSeeUnassigned;
  });

  const filtered = visible.filter(r => laneEquipMatches(r.equipmentType, equipmentFam));

  // Resolve owner names lazily — only for the rows we'll actually return.
  const top = filtered
    .sort((a, b) => (b.laneScore ?? 0) - (a.laneScore ?? 0))
    .slice(0, TOP_PER_COLUMN * 2);

  const ownerIds = Array.from(new Set(top.map(r => r.ownerUserId).filter((x): x is string => !!x)));
  const ownerNameById = new Map<string, string>();
  if (ownerIds.length > 0) {
    const ownerRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ownerIds));
    for (const u of ownerRows) ownerNameById.set(u.id, u.name);
  }

  // Last-touch per lane — max(sent_at) across carrier_outreach_logs that
  // were actually sent (not draft/failed). This mirrors the LWQ context
  // signal and is what reps use to gauge whether a lane is being worked.
  const topLaneIds = top.map(r => r.id);
  const lastTouchByLane = new Map<string, string>();
  if (topLaneIds.length > 0) {
    const touches = await db
      .select({
        laneId: carrierOutreachLogs.laneId,
        lastSentAt: sql<Date | null>`max(${carrierOutreachLogs.sentAt})`,
      })
      .from(carrierOutreachLogs)
      .where(and(
        eq(carrierOutreachLogs.orgId, user.organizationId),
        inArray(carrierOutreachLogs.laneId, topLaneIds),
        inArray(carrierOutreachLogs.deliveryStatus, ["sent", "delivered", "opened"]),
      ))
      .groupBy(carrierOutreachLogs.laneId);
    for (const t of touches) {
      if (t.laneId && t.lastSentAt) {
        lastTouchByLane.set(
          t.laneId,
          typeof t.lastSentAt === "string" ? t.lastSentAt : new Date(t.lastSentAt).toISOString(),
        );
      }
    }
  }

  return top.map(r => ({
    laneId: r.id,
    origin: r.origin,
    originState: r.originState ?? null,
    destination: r.destination,
    destinationState: r.destinationState ?? null,
    equipmentType: r.equipmentType ?? null,
    companyName: r.companyName ?? null,
    ownerName: r.ownerUserId ? (ownerNameById.get(r.ownerUserId) ?? null) : null,
    ownerUserId: r.ownerUserId ?? null,
    carriersContactedCount: r.carriersContactedCount ?? 0,
    laneScore: r.laneScore ?? null,
    lastTouchAt: lastTouchByLane.get(r.id) ?? null,
  }));
}

// ── Live freight opportunities (AF) ──────────────────────────────────────────

async function fetchLive(
  orgId: string,
  originCity: string,
  originState: string | null,
  destCity: string,
  destState: string | null,
  equipmentFam: string | null,
): Promise<SwitchboardLiveRow[]> {
  // Same dual-form match as recurring lanes — see fetchRecurring for why.
  const originPatterns = originState
    ? [originCity, `${originCity}, ${originState.toLowerCase()}`]
    : [originCity];
  const destPatterns = destState
    ? [destCity, `${destCity}, ${destState.toLowerCase()}`]
    : [destCity];

  const conds = [
    eq(freightOpportunities.orgId, orgId),
    // Drizzle's inArray expects the literal union column type; widening to string[]
    // is safe because OPEN_OPP_STATUSES only contains valid status literals.
    inArray(freightOpportunities.status, OPEN_OPP_STATUSES as unknown as string[]),
    sql`lower(trim(${freightOpportunities.origin})) in (${sql.join(originPatterns.map(p => sql`${p}`), sql`, `)})`,
    sql`lower(trim(${freightOpportunities.destination})) in (${sql.join(destPatterns.map(p => sql`${p}`), sql`, `)})`,
    // Mirror the AF cockpit's snooze suppression contract — see
    // server/services/todayQueue.ts ("Hide rows the rep is currently
    // snoozing"). Without this, the switchboard would surface
    // opportunities the cockpit deliberately hides.
    sql`(${freightOpportunities.snoozedUntil} is null or ${freightOpportunities.snoozedUntil} <= now())`,
  ];
  if (originState) {
    conds.push(sql`lower(coalesce(${freightOpportunities.originState}, '')) = ${originState.toLowerCase()}`);
  }
  if (destState) {
    conds.push(sql`lower(coalesce(${freightOpportunities.destinationState}, '')) = ${destState.toLowerCase()}`);
  }

  const rows = await db.select().from(freightOpportunities).where(and(...conds)) as FreightOpportunity[];

  const filtered = rows.filter(r => laneEquipMatches(r.equipmentType, equipmentFam));

  // Earliest pickup first — most actionable; mirrors AF "pickup_soonest" sort.
  filtered.sort((a, b) => {
    const ta = a.pickupWindowStart ? new Date(a.pickupWindowStart).getTime() : Infinity;
    const tb = b.pickupWindowStart ? new Date(b.pickupWindowStart).getTime() : Infinity;
    return ta - tb;
  });

  return filtered.map(r => {
    const sig = [
      (r.origin ?? "").trim().toLowerCase(),
      (r.originState ?? "").trim().toLowerCase(),
      (r.destination ?? "").trim().toLowerCase(),
      (r.destinationState ?? "").trim().toLowerCase(),
      (r.equipmentType ?? "").trim().toLowerCase(),
    ].join("|");
    return {
      opportunityId: r.id,
      origin: r.origin,
      originState: r.originState ?? null,
      destination: r.destination,
      destinationState: r.destinationState ?? null,
      equipmentType: r.equipmentType ?? null,
      status: r.status,
      // Drizzle types the timestamp column as Date, but some query paths return
      // it as a string. Widening to string | number | Date lets new Date() handle
      // either form safely — the only use is toISOString() immediately after.
      pickupWindowStart: r.pickupWindowStart
        ? new Date(r.pickupWindowStart as unknown as string | number | Date).toISOString()
        : null,
      loadCount: r.loadCount ?? null,
      laneSignature: sig,
    };
  });
}

// ── Historical customer quotes ───────────────────────────────────────────────

async function fetchHistorical(
  orgId: string,
  q: { originCity: string; originState?: string; destCity: string; destState?: string; equipment?: string },
): Promise<SwitchboardHistoricalRow[]> {
  // searchSpotQuote requires non-empty pickupState/deliveryState; if the rep
  // didn't supply states the historical column degrades to empty (the UI
  // still shows the "what we parsed" hint so they can add a state).
  if (!q.originState || !q.destState) return [];

  let result: SpotSearchResult;
  try {
    result = await searchSpotQuote(orgId, {
      pickupCity: q.originCity,
      pickupState: q.originState,
      deliveryCity: q.destCity,
      deliveryState: q.destState,
      equipment: q.equipment ?? null,
      matchMode: "relaxed",
      includeSimilar: true,
    });
  } catch (err) {
    console.error("[lane-switchboard] spot-search error:", err);
    return [];
  }

  // Sort exact matches first, then similar, all in reverse-chronological
  // order so the most recent quotes win. EnrichedQuote already carries
  // customerName, so no extra lookup is needed.
  const exact = (result.exactMatches ?? []).map(r => ({ row: r, exactMatch: true }));
  const similar = (result.similarMatches ?? []).map(r => ({ row: r, exactMatch: false }));
  const all = [...exact, ...similar];
  all.sort((a, b) => {
    if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
    return new Date(b.row.requestDate).getTime() - new Date(a.row.requestDate).getTime();
  });

  return all.slice(0, TOP_PER_COLUMN).map(({ row }) => ({
    quoteId: row.id,
    customerName: row.customerName ?? "",
    originCity: row.originCity,
    originState: row.originState,
    destCity: row.destCity,
    destState: row.destState,
    equipment: row.equipment ?? null,
    outcomeStatus: row.outcomeStatus ?? null,
    quotedAmount: row.quotedAmount != null ? Number(row.quotedAmount) : null,
    requestDate: typeof row.requestDate === "string"
      ? row.requestDate
      : new Date(row.requestDate).toISOString(),
  }));
}
