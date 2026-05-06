// Cross-tab UX (option E) — unified Lane Inbox feed.
//
// Read-only union of recent events across the four cross-linked surfaces:
//   - Available Freight   → freight_opportunity_audit (status_changed, approved,
//                            response_recorded, sla_*, expired, cancelled)
//   - Lane Work Queue     → carrier_outreach_logs (reassignment + sent waves)
//   - Customer Quotes     → quote_events (won/lost outcome flips)
//   - Carrier Hub         → carrier_outreach_logs with reply_received_at
//
// All four sub-queries share the same row shape so the client can render a
// single ordered feed. Org-scoped on every query — never trust query params
// for orgId. Optional `?scope=mine` filters to events tied to lanes/opps the
// signed-in user owns or is delegated to.
//
// We intentionally cap each sub-query at 50 rows BEFORE merging so a hot
// surface (e.g. a customer's auto-flip storm) can't crowd out the others.

import type { Express } from "express";
import { qStr } from "../lib/req";
import { requireAuth, getCurrentUser } from "../auth";
import { db } from "../storage";
import {
  freightOpportunityAudit,
  freightOpportunities,
  carrierOutreachLogs,
  recurringLanes,
  quoteEvents,
  quoteOpportunities,
  quoteCustomers,
  quoteReps,
  users,
} from "@shared/schema";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { laneSig } from "../laneCrossLinkService";
import { groupLaneInboxBySig, type FlatInboxRowLike } from "../services/laneStory";

/** Surface tag — drives both the deep-link target and the filter chips. */
type Surface = "available_freight" | "lane_work_queue" | "customer_quotes" | "carrier_hub";

export interface LaneInboxRow {
  id: string;
  surface: Surface;
  /** Short event verb the UI badges (e.g. "approved", "won", "reply"). */
  kind: string;
  title: string;
  /** One-line context (lane label, customer name, carrier name…). */
  subtitle: string;
  occurredAt: string;
  /** App-internal route the row deep-links to. */
  deepLink: string;
  /** Lane label "Origin, ST → Dest, ST" when known — used for grouping/hover. */
  lane: string | null;
  /** Optional row id used by the client to dedupe / track keys. */
  refId: string | null;
  // Task #873 — raw geography lets the client (and the group-by-lane mode)
  // compute the canonical lane signature without re-querying.
  origin: string | null;
  originState: string | null;
  destination: string | null;
  destinationState: string | null;
  equipmentType: string | null;
  /** Canonical lane signature (origin|state|dest|state|equip lowercased). */
  laneSignature: string | null;
}

const PER_SURFACE_LIMIT = 50;
const RESPONSE_LIMIT = 80;

const formatLane = (
  oCity: string | null,
  oState: string | null,
  dCity: string | null,
  dState: string | null,
): string | null => {
  const o = [oCity, oState].filter(Boolean).join(", ");
  const d = [dCity, dState].filter(Boolean).join(", ");
  if (!o && !d) return null;
  return `${o || "?"} → ${d || "?"}`;
};

export function registerLaneInboxRoutes(app: Express): void {
  app.get("/api/lane-inbox", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const orgId = user.organizationId;
      if (!orgId) return res.status(403).json({ error: "No organization" });

      const scope = (qStr(req.query.scope) || "all"); // "all" | "mine"
      const surfaceFilter = (qStr(req.query.surface) || "");
      const validSurfaces: Surface[] = [
        "available_freight",
        "lane_work_queue",
        "customer_quotes",
        "carrier_hub",
      ];
      const surfaceWanted: Surface | null = (validSurfaces as string[]).includes(surfaceFilter)
        ? (surfaceFilter as Surface)
        : null;

      const rows: LaneInboxRow[] = [];

      // ── 1) Available Freight — opportunity audit events ──────────────────
      // Surface only the high-signal events; skip noisy internal ones like
      // `outreach_queued` so the inbox doesn't drown in middleware chatter.
      if (!surfaceWanted || surfaceWanted === "available_freight") {
        const meaningfulEvents = [
          "approved",
          "status_changed",
          "response_recorded",
          "sla_escalated",
          "expired",
          "cancelled",
        ];
        const ownerCondition = scope === "mine"
          ? or(
              eq(freightOpportunities.ownerUserId, user.id),
              eq(freightOpportunities.delegatedToUserId, user.id),
            )
          : undefined;

        const afRows = await db
          .select({
            id: freightOpportunityAudit.id,
            eventType: freightOpportunityAudit.eventType,
            createdAt: freightOpportunityAudit.createdAt,
            opportunityId: freightOpportunityAudit.opportunityId,
            origin: freightOpportunities.origin,
            originState: freightOpportunities.originState,
            destination: freightOpportunities.destination,
            destinationState: freightOpportunities.destinationState,
            equipmentType: freightOpportunities.equipmentType,
            status: freightOpportunities.status,
            payload: freightOpportunityAudit.payload,
          })
          .from(freightOpportunityAudit)
          .innerJoin(
            freightOpportunities,
            eq(freightOpportunityAudit.opportunityId, freightOpportunities.id),
          )
          .where(
            and(
              eq(freightOpportunities.orgId, orgId),
              inArray(freightOpportunityAudit.eventType, meaningfulEvents),
              ...(ownerCondition ? [ownerCondition] : []),
            ),
          )
          .orderBy(desc(freightOpportunityAudit.createdAt))
          .limit(PER_SURFACE_LIMIT);

        for (const r of afRows) {
          const lane = formatLane(r.origin, r.originState, r.destination, r.destinationState);
          rows.push({
            id: `af:${r.id}`,
            surface: "available_freight",
            kind: r.eventType,
            title: `Opportunity ${r.eventType.replace(/_/g, " ")}`,
            subtitle: lane ?? `Opportunity ${r.opportunityId.slice(0, 8)}`,
            occurredAt: (r.createdAt as Date).toISOString(),
            // Keep the deep link generic — opening the cockpit is enough for
            // MVP. We can switch to /available-freight?openOpp=<id> once the
            // detail drawer supports a deep-link param.
            deepLink: "/available-freight",
            lane,
            refId: r.opportunityId,
            origin: r.origin ?? null,
            originState: r.originState ?? null,
            destination: r.destination ?? null,
            destinationState: r.destinationState ?? null,
            equipmentType: r.equipmentType ?? null,
            laneSignature: laneSig(r.origin, r.originState, r.destination, r.destinationState, r.equipmentType),
          });
        }
      }

      // ── 2) LWQ + Carrier Hub — outreach + replies ────────────────────────
      // One query covers both surfaces — we tag each row with the right
      // surface based on whether it's an inbound reply or an outbound send.
      if (
        !surfaceWanted ||
        surfaceWanted === "lane_work_queue" ||
        surfaceWanted === "carrier_hub"
      ) {
        const outreachOwnerCondition = scope === "mine"
          ? or(
              eq(carrierOutreachLogs.ownerUserId, user.id),
              eq(carrierOutreachLogs.actorUserId, user.id),
            )
          : undefined;

        const outreachRows = await db
          .select({
            id: carrierOutreachLogs.id,
            laneId: carrierOutreachLogs.laneId,
            timestamp: carrierOutreachLogs.timestamp,
            outreachMode: carrierOutreachLogs.outreachMode,
            sentAt: carrierOutreachLogs.sentAt,
            replyReceivedAt: carrierOutreachLogs.replyReceivedAt,
            direction: carrierOutreachLogs.direction,
            carrierNames: carrierOutreachLogs.carrierNames,
            matchedCarrierId: carrierOutreachLogs.matchedCarrierId,
            origin: recurringLanes.origin,
            originState: recurringLanes.originState,
            destination: recurringLanes.destination,
            destinationState: recurringLanes.destinationState,
            equipmentType: recurringLanes.equipmentType,
          })
          .from(carrierOutreachLogs)
          .leftJoin(recurringLanes, eq(carrierOutreachLogs.laneId, recurringLanes.id))
          .where(
            and(
              eq(carrierOutreachLogs.orgId, orgId),
              // Only surface either a sent wave, an inbound reply, or an
              // ownership reassignment — these are the moments other reps
              // care about. Plain drafts are noise.
              or(
                isNotNull(carrierOutreachLogs.sentAt),
                isNotNull(carrierOutreachLogs.replyReceivedAt),
                eq(carrierOutreachLogs.outreachMode, "reassignment"),
              ),
              ...(outreachOwnerCondition ? [outreachOwnerCondition] : []),
            ),
          )
          .orderBy(desc(carrierOutreachLogs.timestamp))
          .limit(PER_SURFACE_LIMIT);

        for (const r of outreachRows) {
          const isReply = !!r.replyReceivedAt || r.direction === "inbound";
          const surface: Surface = isReply ? "carrier_hub" : "lane_work_queue";
          if (surfaceWanted && surface !== surfaceWanted) continue;

          const lane = formatLane(r.origin, r.originState, r.destination, r.destinationState);
          const carrierLabel = (r.carrierNames ?? []).slice(0, 2).join(", ") || "Carrier";

          let kind: string;
          let title: string;
          if (isReply) {
            kind = "reply";
            title = `${carrierLabel} replied`;
          } else if (r.outreachMode === "reassignment") {
            kind = "reassigned";
            title = "Lane reassigned";
          } else {
            kind = "outreach_sent";
            title = `Outreach sent to ${carrierLabel}`;
          }

          rows.push({
            id: `outreach:${r.id}`,
            surface,
            kind,
            title,
            subtitle: lane ?? carrierLabel,
            occurredAt: ((r.replyReceivedAt ?? r.sentAt ?? r.timestamp) as Date).toISOString(),
            // Router uses `/lanes/work-queue` (plural). Keep this in sync
            // with the App.tsx route — the inbox link is dead otherwise.
            deepLink: isReply
              ? r.matchedCarrierId
                ? `/carrier-hub?carrier=${r.matchedCarrierId}`
                : "/carrier-hub"
              : "/lanes/work-queue",
            lane,
            refId: r.laneId,
            origin: r.origin ?? null,
            originState: r.originState ?? null,
            destination: r.destination ?? null,
            destinationState: r.destinationState ?? null,
            equipmentType: r.equipmentType ?? null,
            laneSignature: laneSig(r.origin, r.originState, r.destination, r.destinationState, r.equipmentType),
          });
        }
      }

      // ── 3) Customer Quotes — outcome flips ───────────────────────────────
      if (!surfaceWanted || surfaceWanted === "customer_quotes") {
        const meaningfulQuoteEvents = ["won", "lost", "outcome_changed", "ignored"];
        // scope=mine: quote_opportunities.repId is a quote_reps.id; quote_reps
        // has a userId pointing at the auth user. Resolve current user's rep
        // ids in this org and filter the join on those. If the user has no
        // rep row, mine returns nothing — that's the honest answer rather
        // than silently widening to the whole org.
        let quoteOwnerCondition;
        if (scope === "mine") {
          const repRows = await db
            .select({ id: quoteReps.id })
            .from(quoteReps)
            .where(and(eq(quoteReps.organizationId, orgId), eq(quoteReps.userId, user.id)));
          const repIds = repRows.map((r) => r.id);
          quoteOwnerCondition = repIds.length
            ? inArray(quoteOpportunities.repId, repIds)
            : sql`false`;
        }

        const quoteRows = await db
          .select({
            id: quoteEvents.id,
            quoteId: quoteEvents.quoteId,
            eventType: quoteEvents.eventType,
            occurredAt: quoteEvents.occurredAt,
            payload: quoteEvents.payload,
            originCity: quoteOpportunities.originCity,
            originState: quoteOpportunities.originState,
            destCity: quoteOpportunities.destCity,
            destState: quoteOpportunities.destState,
            equipment: quoteOpportunities.equipment,
            outcomeStatus: quoteOpportunities.outcomeStatus,
            customerName: quoteCustomers.name,
          })
          .from(quoteEvents)
          .innerJoin(quoteOpportunities, eq(quoteEvents.quoteId, quoteOpportunities.id))
          .leftJoin(quoteCustomers, eq(quoteOpportunities.customerId, quoteCustomers.id))
          .where(
            and(
              eq(quoteOpportunities.organizationId, orgId),
              inArray(quoteEvents.eventType, meaningfulQuoteEvents),
              ...(quoteOwnerCondition ? [quoteOwnerCondition] : []),
            ),
          )
          .orderBy(desc(quoteEvents.occurredAt))
          .limit(PER_SURFACE_LIMIT);

        for (const r of quoteRows) {
          const lane = formatLane(r.originCity, r.originState, r.destCity, r.destState);
          rows.push({
            id: `quote:${r.id}`,
            surface: "customer_quotes",
            kind: r.eventType,
            title: `Quote ${r.eventType.replace(/_/g, " ")}`,
            subtitle: r.customerName ? `${r.customerName} — ${lane ?? ""}`.trim().replace(/—\s*$/, "").trim() : (lane ?? "Quote"),
            occurredAt: (r.occurredAt as Date).toISOString(),
            deepLink: "/customer-quotes",
            lane,
            refId: r.quoteId,
            origin: r.originCity ?? null,
            originState: r.originState ?? null,
            destination: r.destCity ?? null,
            destinationState: r.destState ?? null,
            equipmentType: r.equipment ?? null,
            laneSignature: laneSig(r.originCity, r.originState, r.destCity, r.destState, r.equipment),
          });
        }
      }

      // Final merge: newest-first across surfaces, capped at RESPONSE_LIMIT.
      rows.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
      const trimmed = rows.slice(0, RESPONSE_LIMIT);

      // Task #873 — `?group=lane` mode collapses the flat feed into one row
      // per canonical lane signature, keeping only the last 3 events per
      // lane. Rows that lack lane parts are dropped (no story home).
      const groupMode = qStr(req.query.group);
      if (groupMode === "lane") {
        // Hydrate per-signature lane meta (companyName, ownerName) from
        // recurring_lanes for the lanes that show up in this batch.
        const sigSet = new Set<string>();
        for (const r of trimmed) {
          if (r.laneSignature) sigSet.add(r.laneSignature);
        }
        const laneMeta = new Map<string, { laneId: string | null; companyName: string | null; ownerName: string | null }>();
        if (sigSet.size > 0) {
          const laneRows = await db
            .select({
              id: recurringLanes.id,
              origin: recurringLanes.origin,
              originState: recurringLanes.originState,
              destination: recurringLanes.destination,
              destinationState: recurringLanes.destinationState,
              equipmentType: recurringLanes.equipmentType,
              companyName: recurringLanes.companyName,
              ownerUserId: recurringLanes.ownerUserId,
              ownerName: users.name,
            })
            .from(recurringLanes)
            .leftJoin(users, eq(recurringLanes.ownerUserId, users.id))
            .where(eq(recurringLanes.orgId, orgId));
          for (const l of laneRows as any[]) {
            const sig = laneSig(l.origin, l.originState, l.destination, l.destinationState, l.equipmentType);
            if (!sigSet.has(sig)) continue;
            // First match wins — duplicate signatures are rare.
            if (!laneMeta.has(sig)) {
              laneMeta.set(sig, {
                laneId: l.id,
                companyName: l.companyName ?? null,
                ownerName: l.ownerName ?? null,
              });
            }
          }
        }
        const flat: FlatInboxRowLike[] = trimmed.map((r) => ({
          id: r.id,
          surface: r.surface,
          kind: r.kind,
          title: r.title,
          subtitle: r.subtitle,
          occurredAt: r.occurredAt,
          deepLink: r.deepLink,
          lane: r.lane,
          refId: r.refId,
          origin: r.origin,
          originState: r.originState,
          destination: r.destination,
          destinationState: r.destinationState,
          equipmentType: r.equipmentType,
        }));
        const groups = groupLaneInboxBySig(flat, laneMeta, 3);
        return res.json({ groups, scope, surface: surfaceWanted ?? null, group: "lane" });
      }

      res.json({ rows: trimmed, scope, surface: surfaceWanted ?? null });
    } catch (err) {
      console.error("[lane-inbox] error:", err);
      res.status(500).json({ error: "Failed to load lane inbox" });
    }
  });
}

// Suppress unused-import warnings for `sql` — kept on the import list because
// we may need raw fragments if we add saved-filters or full-text scoring.
void sql;
