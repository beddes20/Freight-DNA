/**
 * Backfill (Task #637): seed `carrier_lane_outcomes` from legacy event
 * sources so the carrier ranker can read priors immediately, before any
 * new outreach event has fired.
 *
 * Sources (idempotent — additive INSERT ... ON CONFLICT DO UPDATE):
 *   1. carrier_outreach_logs (matched_carrier_id, lane_id → recurring_lanes)
 *      → sent_count + reply_count + open_count
 *      sent_at present       → sent
 *      reply_received_at     → reply (legacy direct-reply tracking)
 *   2. lane_carrier_interest (laneId → recurring_lanes, carrierId)
 *      interestStatus available_now/available_next_week → yes
 *      interestStatus not_fit                           → loss
 *   3. freight_opportunity_carriers + responses (opportunity → lane parts)
 *      response.outcome positive (interested_*, booked) → yes / quote when quotedRate set
 *      response.outcome negative (declined, not_qualified, do_not_contact_lane) → loss
 *   4. freight_opportunities.status = 'covered' (audit kind=covered) → cover
 *
 * Idempotence: the script first DELETEs every `carrier_lane_outcomes`
 * row in scope (single org if `--org-id=` is set, otherwise all orgs)
 * and then rebuilds those rows from the legacy sources. Running the
 * script N times produces the same final counters as running it once,
 * because each run starts from a known-zero baseline. Realtime writers
 * (recordCarrierLaneOutcome) continue to use atomic INSERT ... ON
 * CONFLICT DO UPDATE, so this script is safe to run while the app is
 * live — at worst, a small slice of in-flight events recorded between
 * the DELETE and the source SELECTs would need to be re-recorded by
 * the next outreach cycle.
 *
 * Usage:
 *   # default — backfill against the configured DATABASE_URL
 *   npx tsx scripts/backfillCarrierLaneOutcomes.ts
 *
 *   # one org only
 *   npx tsx scripts/backfillCarrierLaneOutcomes.ts \
 *     --org-id=da3ed822-8846-4435-bb13-3cc4bf26f71d
 *
 *   # against production
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npx tsx scripts/backfillCarrierLaneOutcomes.ts
 */

import { db } from "../server/storage";
import { sql } from "drizzle-orm";
import { recordCarrierLaneOutcome } from "../server/services/carrierLaneOutcomes";
import { laneSig } from "../server/laneCrossLinkService";

interface BackfillCounts {
  sent: number;
  reply: number;
  yes: number;
  quote: number;
  cover: number;
  loss: number;
}

const POSITIVE_OUTCOMES = new Set([
  "interested_now", "interested_few_days", "interested_next_week",
  "interested_future", "booked",
]);
const NEGATIVE_OUTCOMES = new Set([
  "declined", "not_qualified", "do_not_contact_lane",
]);

function parseOrgId(): string | null {
  const arg = process.argv.find(a => a.startsWith("--org-id="));
  return arg ? arg.slice("--org-id=".length).trim() || null : null;
}

async function backfillOutreachLogs(orgFilter: string | null, counts: BackfillCounts): Promise<void> {
  // Pull every (carrier, lane) outreach row that has a matched carrier and a
  // recurring lane we can read lane parts from. Direct lane-less sends are
  // skipped — we have no lane signature to attribute them to.
  const rows = await db.execute<{
    org_id: string;
    matched_carrier_id: string;
    origin: string | null;
    origin_state: string | null;
    destination: string | null;
    destination_state: string | null;
    equipment_type: string | null;
    sent_at: Date | null;
    reply_received_at: Date | null;
  }>(sql`
    SELECT
      l.org_id,
      l.matched_carrier_id,
      rl.origin,
      rl.origin_state,
      rl.destination,
      rl.destination_state,
      rl.equipment_type,
      l.sent_at,
      l.reply_received_at
    FROM carrier_outreach_logs l
    JOIN recurring_lanes rl ON rl.id = l.lane_id
    WHERE l.matched_carrier_id IS NOT NULL
      AND (${orgFilter}::text IS NULL OR l.org_id = ${orgFilter})
  `);
  const list = (rows as unknown as { rows?: any[] }).rows ?? (rows as unknown as any[]);
  for (const r of list ?? []) {
    const lane = {
      origin: r.origin,
      originState: r.origin_state,
      destination: r.destination,
      destinationState: r.destination_state,
      equipmentType: r.equipment_type,
    };
    if (r.sent_at) {
      await recordCarrierLaneOutcome({
        orgId: r.org_id,
        carrierId: r.matched_carrier_id,
        ...lane,
        event: "sent",
        eventAt: new Date(r.sent_at),
      });
      counts.sent++;
    }
    if (r.reply_received_at) {
      await recordCarrierLaneOutcome({
        orgId: r.org_id,
        carrierId: r.matched_carrier_id,
        ...lane,
        event: "reply",
        eventAt: new Date(r.reply_received_at),
      });
      counts.reply++;
    }
  }
}

async function backfillLaneCarrierInterest(orgFilter: string | null, counts: BackfillCounts): Promise<void> {
  const rows = await db.execute<{
    org_id: string;
    carrier_id: string;
    interest_status: string;
    classified_at: string | null;
    origin: string;
    origin_state: string | null;
    destination: string;
    destination_state: string | null;
    equipment_type: string | null;
  }>(sql`
    SELECT
      rl.org_id,
      lci.carrier_id,
      lci.interest_status,
      lci.classified_at,
      rl.origin,
      rl.origin_state,
      rl.destination,
      rl.destination_state,
      rl.equipment_type
    FROM lane_carrier_interest lci
    JOIN recurring_lanes rl ON rl.id = lci.lane_id
    WHERE lci.carrier_id IS NOT NULL
      AND (${orgFilter}::text IS NULL OR rl.org_id = ${orgFilter})
  `);
  const list = (rows as unknown as { rows?: any[] }).rows ?? (rows as unknown as any[]);
  for (const r of list ?? []) {
    const lane = {
      origin: r.origin,
      originState: r.origin_state,
      destination: r.destination,
      destinationState: r.destination_state,
      equipmentType: r.equipment_type,
    };
    const at = r.classified_at ? new Date(r.classified_at) : undefined;
    if (r.interest_status === "available_now" || r.interest_status === "available_next_week") {
      await recordCarrierLaneOutcome({ orgId: r.org_id, carrierId: r.carrier_id, ...lane, event: "yes", eventAt: at });
      counts.yes++;
    } else if (r.interest_status === "not_fit") {
      await recordCarrierLaneOutcome({ orgId: r.org_id, carrierId: r.carrier_id, ...lane, event: "loss", eventAt: at });
      counts.loss++;
    }
  }
}

async function backfillFreightOpportunityResponses(orgFilter: string | null, counts: BackfillCounts): Promise<void> {
  const rows = await db.execute<{
    org_id: string;
    carrier_id: string;
    outcome: string;
    quoted_rate: string | null;
    created_at: Date;
    origin: string;
    origin_state: string | null;
    destination: string;
    destination_state: string | null;
    equipment_type: string | null;
  }>(sql`
    SELECT
      fo.org_id,
      foc.carrier_id,
      r.outcome,
      r.quoted_rate,
      r.created_at,
      fo.origin,
      fo.origin_state,
      fo.destination,
      fo.destination_state,
      fo.equipment_type
    FROM freight_opportunity_responses r
    JOIN freight_opportunity_carriers foc ON foc.id = r.opportunity_carrier_id
    JOIN freight_opportunities fo ON fo.id = foc.opportunity_id
    WHERE (${orgFilter}::text IS NULL OR fo.org_id = ${orgFilter})
  `);
  const list = (rows as unknown as { rows?: any[] }).rows ?? (rows as unknown as any[]);
  for (const r of list ?? []) {
    const lane = {
      origin: r.origin,
      originState: r.origin_state,
      destination: r.destination,
      destinationState: r.destination_state,
      equipmentType: r.equipment_type,
    };
    const at = r.created_at ? new Date(r.created_at) : undefined;
    // Every substantive response also counts as a reply.
    if (r.outcome !== "no_response") {
      await recordCarrierLaneOutcome({ orgId: r.org_id, carrierId: r.carrier_id, ...lane, event: "reply", eventAt: at });
      counts.reply++;
    }
    if (POSITIVE_OUTCOMES.has(r.outcome)) {
      await recordCarrierLaneOutcome({ orgId: r.org_id, carrierId: r.carrier_id, ...lane, event: "yes", eventAt: at });
      counts.yes++;
    } else if (NEGATIVE_OUTCOMES.has(r.outcome)) {
      await recordCarrierLaneOutcome({ orgId: r.org_id, carrierId: r.carrier_id, ...lane, event: "loss", eventAt: at });
      counts.loss++;
    }
    if (r.quoted_rate !== null) {
      await recordCarrierLaneOutcome({ orgId: r.org_id, carrierId: r.carrier_id, ...lane, event: "quote", eventAt: at });
      counts.quote++;
    }
  }
}

async function backfillCovers(orgFilter: string | null, counts: BackfillCounts): Promise<void> {
  // Cover events live on the audit log (eventType=status_changed,
  // payload.kind='covered'). The carrierId is stored inside the JSON
  // payload; lane parts come from the parent freight_opportunity.
  const rows = await db.execute<{
    org_id: string;
    payload: any;
    created_at: Date;
    origin: string;
    origin_state: string | null;
    destination: string;
    destination_state: string | null;
    equipment_type: string | null;
  }>(sql`
    SELECT
      fo.org_id,
      a.payload,
      a.created_at,
      fo.origin,
      fo.origin_state,
      fo.destination,
      fo.destination_state,
      fo.equipment_type
    FROM freight_opportunity_audit a
    JOIN freight_opportunities fo ON fo.id = a.opportunity_id
    WHERE a.event_type = 'status_changed'
      AND a.payload->>'kind' = 'covered'
      AND (${orgFilter}::text IS NULL OR fo.org_id = ${orgFilter})
  `);
  const list = (rows as unknown as { rows?: any[] }).rows ?? (rows as unknown as any[]);
  for (const r of list ?? []) {
    const carrierId = r.payload?.carrierId;
    if (typeof carrierId !== "string" || !carrierId) continue;
    await recordCarrierLaneOutcome({
      orgId: r.org_id,
      carrierId,
      origin: r.origin,
      originState: r.origin_state,
      destination: r.destination,
      destinationState: r.destination_state,
      equipmentType: r.equipment_type,
      event: "cover",
      eventAt: r.created_at ? new Date(r.created_at) : undefined,
    });
    counts.cover++;
  }
}

async function clearScope(orgFilter: string | null): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    DELETE FROM carrier_lane_outcomes
    WHERE (${orgFilter}::text IS NULL OR org_id = ${orgFilter})
    RETURNING id
  `);
  const list = (result as unknown as { rows?: any[] }).rows ?? (result as unknown as any[]);
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Public orchestrator. Exported so tests (and other internal callers)
 * can invoke the backfill without spawning a child process. Returns
 * the per-event counts so callers can assert / log them.
 */
export async function runBackfill(orgFilter: string | null = null): Promise<BackfillCounts> {
  const counts: BackfillCounts = { sent: 0, reply: 0, yes: 0, quote: 0, cover: 0, loss: 0 };
  console.log(`[backfill-carrier-lane-outcomes] starting${orgFilter ? ` (org=${orgFilter})` : ""}`);

  // Idempotence: clear the in-scope rows first, then rebuild from sources.
  // Each rerun produces the same final counters as the first run.
  const cleared = await clearScope(orgFilter);
  console.log(`  → cleared ${cleared} existing carrier_lane_outcomes row(s) in scope`);

  console.log("  → carrier_outreach_logs …");
  await backfillOutreachLogs(orgFilter, counts);

  console.log("  → lane_carrier_interest …");
  await backfillLaneCarrierInterest(orgFilter, counts);

  console.log("  → freight_opportunity_responses …");
  await backfillFreightOpportunityResponses(orgFilter, counts);

  console.log("  → freight_opportunity_audit (covers) …");
  await backfillCovers(orgFilter, counts);

  console.log("[backfill-carrier-lane-outcomes] done", counts);
  // Touch laneSig to keep the import live in tree-shake checks. The helper
  // already calls it internally, but keeping a reference here documents the
  // dependency the script declares against the canonical signature builder.
  void laneSig;
  return counts;
}

// Auto-run only when invoked as a script (`tsx scripts/...`), not when
// imported by tests. process.argv[1] holds the entry-point path.
const isDirectInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("backfillCarrierLaneOutcomes");

if (isDirectInvocation) {
  runBackfill(parseOrgId())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill-carrier-lane-outcomes] failed:", err);
      process.exit(1);
    });
}
