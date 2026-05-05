/**
 * Task #1051 — Unified ReplitDailyUpload fact writer.
 *
 * Single normalizer for every row that comes off the daily Excel workbook.
 * Called from the `POST /api/financials/upload` route handler so Financials,
 * Available Freight, and the Lane Work Queue all share the same canonical
 * row set + the same "last upload at" timestamp.
 *
 * See docs/unified-replit-daily-upload.md for the architecture contract.
 */

import crypto from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../storage";
import { cleanCustomerLabel } from "@shared/laneFormatters";
import type { InsertFreightDailyUploadFact } from "@shared/schema";

// ── "moved" classifier ──────────────────────────────────────────────────────
//
// Centralized so AVL rows and TXN rows share one rule. POD/DEL/TRANSIT/BOOKED/
// COVERED are the operational states the TMS uses for "this load actually went
// on a truck"; AVL/QUOTE/OPEN/CANCELLED indicate the load never moved.
const MOVED_STATUSES = new Set([
  "pod", "delivered", "del",
  "in transit", "transit",
  "booked", "covered",
  "completed", "complete",
]);
const NOT_MOVED_STATUSES = new Set([
  "avl", "available",
  "quote", "quoted",
  "open",
  "cancelled", "canceled", "void", "voided",
]);

export function isMovedBrokerageStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return false;
  if (NOT_MOVED_STATUSES.has(s)) return false;
  if (MOVED_STATUSES.has(s)) return true;
  // Default: any explicit non-empty status that does not look "open/quote-y"
  // is treated as moved. This matches the TMS convention where blank/AVL
  // means "not yet moved" and anything that has progressed (even custom
  // codes like "DLVD") counts as a real load.
  return true;
}

// ── Sheet helpers ───────────────────────────────────────────────────────────

interface AnyRow { [k: string]: unknown }

function pickStr(row: AnyRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

function pickNum(row: AnyRow, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
    if (!isNaN(n)) return n;
  }
  return null;
}

function lc(s: string): string { return s.toLowerCase().trim(); }

function fingerprint(parts: string[]): string {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * Normalize one raw workbook row (from either the transaction sheet or the
 * AVL sheet) into a freight_daily_upload_fact insert payload.
 *
 * `forceMoved` lets callers tell the normalizer "this row came from a sheet
 * we know is operational (not AVL)" without having to plumb the brokerage
 * status into every row source.
 */
export function normalizeRowToFact(
  row: AnyRow,
  ctx: { orgId: string; uploadId: string; forceMoved?: boolean | null }
): InsertFreightDailyUploadFact | null {
  const originCity = lc(pickStr(row,
    "Origin", "shipperCity", "originCity", "origin", "shipper_city",
  ));
  const originState = lc(pickStr(row,
    "Origin state", "shipperState", "originState", "origin_state",
  ));
  const destCity = lc(pickStr(row,
    "Destination", "consigneeCity", "destinationCity", "destination", "consignee_city",
  ));
  const destState = lc(pickStr(row,
    "Destination state", "consigneeState", "destinationState", "destination_state",
  ));
  const equipment = lc(pickStr(row,
    "Trailer type", "equipmentType", "equipment_type", "mode", "trailer",
  ));
  const customer = pickStr(row,
    "Customer", "customerName", "customer_name", "customer", "account",
  );
  const shipDate = pickStr(row,
    "Delivery date", "shipDate", "ship_date", "Pickup Date", "pickup_date", "pickupDate", "date", "Date",
  );
  const deliveryDate = pickStr(row,
    "Delivery date", "Delivery Date", "delivery_date", "Drop Date", "drop_date",
  );
  const brokerageStatus = pickStr(row,
    "Brokerage Status", "brokerageStatus", "brokerage_status",
    "Status", "status", "Order Status",
  );
  const orderType = pickStr(row,
    "Order Type", "orderType", "order_type",
  );
  const carrierField = pickStr(row, "Carrier", "carrier", "carrierName", "carrier_name");
  const dashIdx = carrierField.indexOf(" - ");
  const carrierPayeeCode = pickStr(row, "payeeCode", "payee_code", "payee") ||
    (dashIdx > 0 ? carrierField.slice(0, dashIdx).trim() : "");
  const carrierName = (dashIdx > 0 ? carrierField.slice(dashIdx + 3) : carrierField).trim();
  const totalRevenue = pickNum(row,
    "Total Revenue", "totalRevenue", "total_revenue", "Revenue", "revenue",
  );
  const carrierTotal = pickNum(row,
    "Carrier Total", "carrierTotal", "carrier_total", "Carrier Pay", "carrierPay",
  );
  const marginPct = pickNum(row,
    "Margin %", "marginPct", "margin_pct", "Margin Pct",
  );
  const loadedMiles = pickNum(row,
    "Loaded Miles", "loadedMiles", "loaded_miles", "Miles", "miles",
  );

  // We require enough geography to anchor the row to a lane. Rows with no
  // origin/destination/customer are dropped (they cannot feed any of the
  // three downstream surfaces).
  if (!originCity && !destCity && !customer) return null;

  const explicitId = pickStr(row,
    "Order", "loadId", "load_id", "orderId", "order_id", "loadNumber", "load_number",
  );
  const loadKey = explicitId || fingerprint([
    originCity, originState, destCity, destState, equipment,
    shipDate.slice(0, 10), customer.toLowerCase(), carrierField.toLowerCase(),
  ]);

  const moved = ctx.forceMoved != null
    ? ctx.forceMoved
    : isMovedBrokerageStatus(brokerageStatus);

  return {
    orgId: ctx.orgId,
    uploadId: ctx.uploadId,
    loadKey,
    customer: customer ? cleanCustomerLabel(customer) : null,
    originCity: originCity || null,
    originState: originState || null,
    destCity: destCity || null,
    destState: destState || null,
    equipment: equipment || null,
    carrierName: carrierName || null,
    carrierPayeeCode: carrierPayeeCode || null,
    shipDate: shipDate || null,
    deliveryDate: deliveryDate || null,
    brokerageStatus: brokerageStatus || null,
    orderType: orderType || null,
    moved,
    totalRevenue: totalRevenue != null ? String(totalRevenue) : null,
    carrierTotal: carrierTotal != null ? String(carrierTotal) : null,
    marginPct: marginPct != null ? String(marginPct) : null,
    loadedMiles: loadedMiles != null ? Math.round(loadedMiles) : null,
  };
}

/**
 * Persist a batch of normalized fact rows. Idempotent on
 * (orgId, uploadId, loadKey) so re-runs of the same upload do not duplicate.
 */
export async function writeFactRows(rows: InsertFreightDailyUploadFact[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Insert in chunks to keep the parameter count bounded.
  const CHUNK = 250;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = slice.map(r => sql`(
      ${r.orgId}, ${r.uploadId}, ${r.loadKey}, ${r.customer},
      ${r.originCity}, ${r.originState}, ${r.destCity}, ${r.destState},
      ${r.equipment}, ${r.carrierName}, ${r.carrierPayeeCode},
      ${r.shipDate}, ${r.deliveryDate}, ${r.brokerageStatus}, ${r.orderType},
      ${r.moved}, ${r.totalRevenue}, ${r.carrierTotal}, ${r.marginPct}, ${r.loadedMiles}
    )`);
    const result = await db.execute(sql`
      INSERT INTO freight_daily_upload_fact
        (org_id, upload_id, load_key, customer,
         origin_city, origin_state, dest_city, dest_state,
         equipment, carrier_name, carrier_payee_code,
         ship_date, delivery_date, brokerage_status, order_type,
         moved, total_revenue, carrier_total, margin_pct, loaded_miles)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (org_id, upload_id, load_key) DO NOTHING
    `);
    written += result.rowCount ?? slice.length;
  }
  return written;
}

/**
 * Single entry point for the upload route. Normalizes every row from the
 * workbook and persists fact rows. Both transaction-sheet rows (`txnRows`)
 * and AVL/Available-Freight-sheet rows (`avlRows`) flow through the same
 * writer; AVL rows are forced to `moved=false` so the LWQ engine never
 * mistakes a quote for a real move.
 */
export async function ingestUploadIntoFact(args: {
  orgId: string;
  uploadId: string;
  txnRows: AnyRow[];
  avlRows?: AnyRow[];
}): Promise<{ inserted: number; moved: number; total: number }> {
  const facts: InsertFreightDailyUploadFact[] = [];
  for (const row of args.txnRows) {
    const f = normalizeRowToFact(row, { orgId: args.orgId, uploadId: args.uploadId });
    if (f) facts.push(f);
  }
  for (const row of args.avlRows ?? []) {
    const f = normalizeRowToFact(row, {
      orgId: args.orgId, uploadId: args.uploadId, forceMoved: false,
    });
    if (f) facts.push(f);
  }
  const inserted = await writeFactRows(facts);
  const moved = facts.filter(f => f.moved).length;
  return { inserted, moved, total: facts.length };
}

/**
 * Rolling-30-day eligibility query. Returns one summary per
 * (origin, dest, equipment) lane with the enrichment fields the LWQ row UI
 * reads off `recurring_lanes`.
 *
 * Anchored to the latest `shipDate` seen in moved rows (capped to "today" if
 * the freshest data is more than 60 days old). Matches the historical
 * behaviour of `recurringLaneCapacityEngine.ts` so a stale upload still
 * produces consistent eligibility.
 */
export interface LaneFactSummary {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  movesLast30Days: number;
  lastMovedAt: string;
  qualificationReason: string;
  supportingCustomers: Array<{ name: string; count: number }>;
  recentCarriers: Array<{ name: string; payeeCode: string | null; lastMovedAt: string; count: number }>;
}

const MOVES_THRESHOLD = 6;
const ROLLING_DAYS = 30;

export async function summarizeEligibleLanesFromFact(
  orgId: string,
): Promise<{ lanes: LaneFactSummary[]; anchorDate: string }> {
  // Find anchor date — latest moved shipDate.
  const anchorRes = await db.execute<{ anchor: string | null }>(sql`
    SELECT max(ship_date) AS anchor
      FROM freight_daily_upload_fact
     WHERE org_id = ${orgId} AND moved = true AND ship_date IS NOT NULL
  `);
  const rawAnchor = anchorRes.rows[0]?.anchor ?? null;
  const today = new Date();
  const sixtyDaysAgo = new Date(today.getTime() - 60 * 86400_000);
  let anchor: Date;
  if (rawAnchor) {
    const d = new Date(String(rawAnchor).slice(0, 10) + "T12:00:00Z");
    anchor = isNaN(d.getTime()) || d < sixtyDaysAgo ? today : d;
  } else {
    anchor = today;
  }
  const cutoff = new Date(anchor.getTime() - ROLLING_DAYS * 86400_000);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const anchorIso = anchor.toISOString().slice(0, 10);

  const rowsRes = await db.execute<{
    origin_city: string; origin_state: string | null;
    dest_city: string; dest_state: string | null;
    equipment: string | null;
    customer: string | null;
    carrier_name: string | null;
    carrier_payee_code: string | null;
    ship_date: string;
  }>(sql`
    SELECT origin_city, origin_state, dest_city, dest_state, equipment,
           customer, carrier_name, carrier_payee_code, ship_date
      FROM freight_daily_upload_fact
     WHERE org_id = ${orgId}
       AND moved = true
       AND ship_date IS NOT NULL
       AND substring(ship_date, 1, 10) >= ${cutoffIso}
       AND substring(ship_date, 1, 10) <= ${anchorIso}
  `);

  interface Bucket {
    originCity: string; originState: string;
    destCity: string; destState: string;
    equipment: string;
    moves: number;
    lastMovedAt: string;
    customers: Map<string, number>;
    carriers: Map<string, { name: string; payeeCode: string | null; lastMovedAt: string; count: number }>;
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rowsRes.rows) {
    const originCity = (r.origin_city ?? "").trim().toLowerCase();
    const destCity = (r.dest_city ?? "").trim().toLowerCase();
    if (!originCity || !destCity) continue;
    const equipment = (r.equipment ?? "").trim().toLowerCase();
    const key = `${originCity}|${(r.origin_state ?? "").trim().toLowerCase()}|${destCity}|${(r.dest_state ?? "").trim().toLowerCase()}|${equipment}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        originCity, originState: (r.origin_state ?? "").trim().toLowerCase(),
        destCity, destState: (r.dest_state ?? "").trim().toLowerCase(),
        equipment,
        moves: 0,
        lastMovedAt: "",
        customers: new Map(),
        carriers: new Map(),
      };
      buckets.set(key, b);
    }
    b.moves++;
    const ship = String(r.ship_date).slice(0, 10);
    if (ship > b.lastMovedAt) b.lastMovedAt = ship;
    if (r.customer) b.customers.set(r.customer, (b.customers.get(r.customer) ?? 0) + 1);
    if (r.carrier_name) {
      const ck = `${r.carrier_payee_code ?? ""}|${r.carrier_name}`;
      const existing = b.carriers.get(ck);
      if (existing) {
        existing.count++;
        if (ship > existing.lastMovedAt) existing.lastMovedAt = ship;
      } else {
        b.carriers.set(ck, {
          name: r.carrier_name,
          payeeCode: r.carrier_payee_code,
          lastMovedAt: ship,
          count: 1,
        });
      }
    }
  }

  const lanes: LaneFactSummary[] = [];
  for (const b of buckets.values()) {
    if (b.moves < MOVES_THRESHOLD) continue;
    const supportingCustomers = Array.from(b.customers.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    const recentCarriers = Array.from(b.carriers.values())
      .sort((a, b) => b.lastMovedAt.localeCompare(a.lastMovedAt) || b.count - a.count)
      .slice(0, 5);
    const qualificationReason = `${b.moves} moved loads in last ${ROLLING_DAYS} days` +
      (recentCarriers.length > 0 ? ` — ${recentCarriers.length} carrier${recentCarriers.length === 1 ? "" : "s"}` : "");
    lanes.push({
      originCity: b.originCity, originState: b.originState,
      destCity: b.destCity, destState: b.destState,
      equipment: b.equipment,
      movesLast30Days: b.moves,
      lastMovedAt: b.lastMovedAt,
      qualificationReason,
      supportingCustomers,
      recentCarriers,
    });
  }
  return { lanes, anchorDate: anchorIso };
}

export const LWQ_MOVES_THRESHOLD = MOVES_THRESHOLD;
export const LWQ_ROLLING_DAYS = ROLLING_DAYS;
export const LWQ_GRACE_DAYS = 7;
