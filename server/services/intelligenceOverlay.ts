/**
 * Task #912 — Intelligence Overlay.
 *
 * Gathers the auxiliary CRM context the Fit & Intelligence Card reasoner
 * needs, *on top of* the typed extraction (slice 2) and resolved entity
 * links. The reasoner is a deterministic transform; this module is where
 * "look at recurring lanes, freshness, leak signals, capture failures,
 * carrier scorecard, customer signals" actually happens.
 *
 * Every overlay datum carries the `source` chip the reasoner can hand
 * straight to the IntelligenceCardClaim — no claim should be assembled
 * from data that wasn't returned by this overlay.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../storage";
import {
  recurringLanes,
  freightOpportunities,
  freightOpportunityCaptureFailures,
  carriers,
  companies,
  type RecurringLane,
  type Carrier,
  type Company,
  type FreightOpportunity,
  type FreightOpportunityCaptureFailure,
  type IntelligenceCardSource,
  type DocumentEntityLink,
  type DocumentExtractionFinding,
} from "@shared/schema";
import { laneSig } from "../laneCrossLinkService";
import { computeFreightFreshnessSignal } from "./freightFreshness";
import { laneHealthFromVolatility } from "../leakConsoleService";

export interface OverlayLane {
  lane: RecurringLane;
  health: "healthy" | "warming" | "leaking" | "stable" | "hot" | "volatile" | "unknown";
  source: IntelligenceCardSource;
}

export interface OverlayCarrierSnapshot {
  carrier: Carrier;
  servesOriginState: boolean;
  servesDestState: boolean;
  equipmentMatch: boolean;
  source: IntelligenceCardSource;
}

export interface OverlayCustomerSnapshot {
  company: Company;
  source: IntelligenceCardSource;
}

export interface OverlayCaptureFailure {
  failure: FreightOpportunityCaptureFailure;
  source: IntelligenceCardSource;
}

export interface OverlayOpportunity {
  opportunity: FreightOpportunity;
  source: IntelligenceCardSource;
}

export interface IntelligenceOverlay {
  /** Full canonical lane signature for the extracted lane (null if origin or
   *  destination city is missing — the reasoner falls back to an unanchored
   *  card in that case). */
  laneSignature: string | null;
  /** Recurring lanes in this org whose signature matches the extraction. */
  recurringLanes: OverlayLane[];
  /** Lane volatility / freshness — null when no recurring lane row exists. */
  freshness: { freshnessMinutes: number | null; source: IntelligenceCardSource } | null;
  /** Open freight opportunities for the same canonical lane. */
  openOpportunities: OverlayOpportunity[];
  /** Resolved carrier from entity links (null when no `isPrimary` carrier). */
  carrier: OverlayCarrierSnapshot | null;
  /** Resolved customer (null when no `isPrimary` customer link). */
  customer: OverlayCustomerSnapshot | null;
  /** Open capture failures on the customer (open = resolvedAt is null). */
  captureFailures: OverlayCaptureFailure[];
  /** Slice 2 inconsistency findings — mirrored verbatim with chips. */
  findings: Array<{ finding: DocumentExtractionFinding; source: IntelligenceCardSource }>;
  /** Lightweight enumerated tags the play matcher reads. */
  tags: string[];
}

interface ExtractionLeaves {
  originCity: string | null;
  originState: string | null;
  destinationCity: string | null;
  destinationState: string | null;
  equipmentType: string | null;
  carrierMcNumber: string | null;
  carrierDotNumber: string | null;
}

function readLeaf<T = string>(
  payload: Record<string, unknown> | null,
  key: string,
): T | null {
  if (!payload) return null;
  const f = payload[key] as { value?: T } | undefined;
  return f?.value ?? null;
}

export function readExtractionLeaves(
  payload: Record<string, unknown> | null,
): ExtractionLeaves {
  return {
    originCity: readLeaf<string>(payload, "originCity"),
    originState: readLeaf<string>(payload, "originState"),
    destinationCity: readLeaf<string>(payload, "destinationCity"),
    destinationState: readLeaf<string>(payload, "destinationState"),
    equipmentType: readLeaf<string>(payload, "equipmentType"),
    carrierMcNumber: readLeaf<string>(payload, "carrierMcNumber"),
    carrierDotNumber: readLeaf<string>(payload, "carrierDotNumber"),
  };
}

function safeLaneSig(leaves: ExtractionLeaves): string | null {
  if (!leaves.originCity || !leaves.destinationCity) return null;
  return laneSig(
    leaves.originCity,
    leaves.originState ?? "",
    leaves.destinationCity,
    leaves.destinationState ?? "",
    leaves.equipmentType ?? "",
  );
}

function laneHrefFor(sig: string): string {
  return `/lanes/story/${encodeURIComponent(sig)}`;
}

export interface BuildIntelligenceOverlayArgs {
  organizationId: string;
  payload: Record<string, unknown> | null;
  links: DocumentEntityLink[];
  findings: DocumentExtractionFinding[];
}

/**
 * Stitch every overlay datum the reasoner will need. Best-effort: a missing
 * piece (e.g. customer not resolved) becomes `null` rather than throwing,
 * so the card can still degrade gracefully into a "needs review" state.
 */
export async function buildIntelligenceOverlay(
  args: BuildIntelligenceOverlayArgs,
): Promise<IntelligenceOverlay> {
  const leaves = readExtractionLeaves(args.payload);
  const signature = safeLaneSig(leaves);
  const tags: string[] = [];

  const primaryLinks = args.links.filter((l) => l.isPrimary);
  const carrierLink = primaryLinks.find((l) => l.kind === "carrier" && l.targetTable === "carriers");
  const customerLink = primaryLinks.find((l) => l.kind === "customer" && l.targetTable === "companies");
  const ambiguousKinds = Array.from(new Set(
    args.links.filter((l) => !l.isPrimary).map((l) => l.kind)
      .filter((k) => !primaryLinks.some((p) => p.kind === k)),
  ));
  for (const k of ambiguousKinds) tags.push(`ambiguous_${k}`);
  if (!carrierLink) tags.push("unknown_carrier");
  if (!customerLink) tags.push("unknown_customer");

  // Recurring lanes — all rows for this org+signature.
  let overlayLanes: OverlayLane[] = [];
  if (signature) {
    const allLanes = await db.select().from(recurringLanes)
      .where(eq(recurringLanes.orgId, args.organizationId)).catch(() => []);
    const matches = (allLanes as RecurringLane[]).filter((l) =>
      laneSig(l.origin, l.originState ?? "", l.destination, l.destinationState ?? "", l.equipmentType ?? "") === signature,
    );
    overlayLanes = matches.map((l) => {
      const factors = (l.laneScoreFactors ?? null) as { volatilityPenalty?: number } | null;
      const vol = typeof factors?.volatilityPenalty === "number" ? factors.volatilityPenalty : null;
      const health = laneHealthFromVolatility(vol);
      return {
        lane: l,
        health,
        source: {
          kind: "recurring_lane" as const,
          ref: l.id,
          label: `Recurring lane: ${l.origin} → ${l.destination}`,
          href: laneHrefFor(signature),
          updatedAt: l.updatedAt ? new Date(l.updatedAt as Date).toISOString() : null,
        },
      };
    });
    if (overlayLanes.length > 0) tags.push("recurring_lane");
  }

  // Freshness signal — best-effort; freshness service is org-wide, not
  // lane-scoped, but its output gives us a freshness chip for the header.
  let freshness: IntelligenceOverlay["freshness"] = null;
  try {
    const sig = await computeFreightFreshnessSignal(args.organizationId);
    const minutes = (sig as { freshnessMinutes?: number | null }).freshnessMinutes ?? null;
    freshness = {
      freshnessMinutes: typeof minutes === "number" ? minutes : null,
      source: {
        kind: "freshness",
        ref: `freshness:${args.organizationId}`,
        label: "Freight freshness signal",
        href: null,
        updatedAt: new Date().toISOString(),
      },
    };
    if (freshness.freshnessMinutes != null && freshness.freshnessMinutes > 4 * 60) tags.push("freight_stale");
  } catch {
    freshness = null;
  }

  // Open freight opportunities on this lane — proves coverage attention.
  const OPEN_STATUSES = [
    "new", "ready_to_send", "sent", "awaiting_carrier_reply",
    "awaiting_customer_confirm", "partially_covered",
  ];
  let openOpportunities: OverlayOpportunity[] = [];
  if (signature) {
    const openOpps = await db.select().from(freightOpportunities)
      .where(and(
        eq(freightOpportunities.orgId, args.organizationId),
        inArray(freightOpportunities.status, OPEN_STATUSES as string[]),
      )).catch(() => []);
    openOpportunities = (openOpps as FreightOpportunity[]).filter((o) =>
      laneSig(o.origin, o.originState ?? "", o.destination, o.destinationState ?? "", o.equipmentType ?? "") === signature,
    ).map((o) => ({
      opportunity: o,
      source: {
        kind: "opportunity" as const,
        ref: o.id,
        label: `Open opportunity ${o.origin} → ${o.destination}`,
        href: `/freight-opportunities/${o.id}`,
        updatedAt: o.generatedAt ? new Date(o.generatedAt as Date).toISOString() : null,
      },
    }));
    if (openOpportunities.length > 0) tags.push("open_opportunity_overlap");
  }

  // Carrier snapshot — if carrier is resolved, pull the row + check
  // claimed coverage vs the extracted lane.
  let carrierSnapshot: OverlayCarrierSnapshot | null = null;
  if (carrierLink) {
    const [carrier] = await db.select().from(carriers)
      .where(and(
        eq(carriers.id, carrierLink.targetId),
        eq(carriers.orgId, args.organizationId),
      )).limit(1).catch(() => [] as Carrier[]);
    if (carrier) {
      const states = (carrier.statesServed ?? []) as string[];
      const equip = (carrier.equipmentTypes ?? []) as string[];
      const oState = (leaves.originState ?? "").toUpperCase();
      const dState = (leaves.destinationState ?? "").toUpperCase();
      const equipUpper = (leaves.equipmentType ?? "").toLowerCase();
      const servesOriginState = oState ? states.map((s) => s.toUpperCase()).includes(oState) : false;
      const servesDestState = dState ? states.map((s) => s.toUpperCase()).includes(dState) : false;
      const equipmentMatch = equipUpper
        ? equip.map((e) => e.toLowerCase()).some((e) => equipUpper.includes(e) || e.includes(equipUpper))
        : false;
      carrierSnapshot = {
        carrier,
        servesOriginState,
        servesDestState,
        equipmentMatch,
        source: {
          kind: "carrier_history",
          ref: carrier.id,
          label: `Carrier: ${carrier.name}`,
          href: `/carriers/${carrier.id}`,
          updatedAt: carrier.updatedAt ? new Date(carrier.updatedAt as Date).toISOString() : null,
        },
      };
      if (!servesOriginState || !servesDestState) tags.push("carrier_lane_mismatch");
      if (!equipmentMatch && (carrier.equipmentTypes ?? []).length > 0 && leaves.equipmentType)
        tags.push("carrier_equipment_mismatch");
      if (carrier.status === "do_not_use" || carrier.status === "flagged")
        tags.push(`carrier_${carrier.status}`);
    }
  }

  // Customer snapshot — pull the company row and any open capture failures.
  let customerSnapshot: OverlayCustomerSnapshot | null = null;
  let captureFailures: OverlayCaptureFailure[] = [];
  if (customerLink) {
    const [company] = await db.select().from(companies)
      .where(and(
        eq(companies.id, customerLink.targetId),
        eq(companies.organizationId, args.organizationId),
      )).limit(1).catch(() => [] as Company[]);
    if (company) {
      customerSnapshot = {
        company,
        source: {
          kind: "entity_link",
          ref: company.id,
          label: `Customer: ${company.name}`,
          href: `/companies/${company.id}`,
          // Companies table has no updatedAt column — leave null.
          updatedAt: null,
        },
      };
      const failures = await db.select().from(freightOpportunityCaptureFailures)
        .where(and(
          eq(freightOpportunityCaptureFailures.orgId, args.organizationId),
        ))
        .orderBy(desc(freightOpportunityCaptureFailures.attemptedAt))
        .limit(20)
        .catch(() => [] as FreightOpportunityCaptureFailure[]);
      captureFailures = (failures as FreightOpportunityCaptureFailure[])
        .filter((f) => f.resolvedAt == null)
        .map((f) => ({
          failure: f,
          source: {
            kind: "capture_failure" as const,
            ref: f.id,
            label: `Won-quote capture failure: ${f.reason}`,
            href: null,
            updatedAt: f.attemptedAt ? new Date(f.attemptedAt as Date).toISOString() : null,
          },
        }));
      if (captureFailures.length > 0) tags.push("open_capture_failure");
    }
  }

  // Findings — slice 2 inconsistency rules. Anything block-severity is a
  // hard risk; warn-severity is a soft risk; info is informational.
  const findingsOverlay = args.findings.map((f) => ({
    finding: f,
    source: {
      kind: "finding" as const,
      ref: `finding:${f.ruleCode}`,
      label: f.message,
      href: null,
      updatedAt: null,
    },
  }));
  if (args.findings.some((f) => f.severity === "block")) tags.push("block_finding");
  if (args.findings.some((f) => f.severity === "warn")) tags.push("warn_finding");

  return {
    laneSignature: signature,
    recurringLanes: overlayLanes,
    freshness,
    openOpportunities,
    carrier: carrierSnapshot,
    customer: customerSnapshot,
    captureFailures,
    findings: findingsOverlay,
    tags,
  };
}
