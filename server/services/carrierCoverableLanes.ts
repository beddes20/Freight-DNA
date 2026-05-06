// Cross-tab UX (option B) — "Find loads this carrier could cover".
//
// Given a carrierId, returns a predicate that decides whether a freight
// opportunity's lane is one the carrier "could cover", combining two
// signals from the Carrier Hub:
//
//   1. carrier_claimed_lanes — what the carrier explicitly says they run.
//      May omit city or equipment, so matching is loose: a missing field
//      on the claim means "any value matches" on that dimension.
//
//   2. load_fact — historical lanes the carrier has actually moved (text
//      `carrier_name` match against the carrier's name, since load_fact
//      does not carry a carrier FK). Matched as full lane signatures.
//
// Returns the Set<string> of full lane signatures derived from load_fact
// history AND a list of partial-match predicates for claimed lanes. The
// caller filters opportunities by `lookup.matches(opp)`.

import { and, eq } from "drizzle-orm";
import { db } from "../storage";
import { carrierClaimedLanes, carriers, loadFact } from "@shared/schema";
import { laneSig } from "../laneCrossLinkService";

export interface CoverableLaneOpp {
  origin: string | null | undefined;
  originState: string | null | undefined;
  destination: string | null | undefined;
  destinationState: string | null | undefined;
  equipmentType: string | null | undefined;
}

interface ClaimedPredicate {
  originCity?: string;
  originState?: string;
  destCity?: string;
  destState?: string;
  equipment?: string;
  laneType: string;
}

export interface CarrierCoverableLanes {
  /** Display name for the banner — empty string if the carrier was not found. */
  carrierName: string;
  /** True when the carrier exists but has no coverable lanes from either source. */
  isEmpty: boolean;
  /** Returns true if the opportunity's lane is one the carrier could cover. */
  matches(opp: CoverableLaneOpp): boolean;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export async function getCarrierCoverableLanes(
  orgId: string,
  carrierId: string,
): Promise<CarrierCoverableLanes | null> {
  // Look up the carrier (org-scoped) so we have the display name and the
  // text key used to match `load_fact.carrier_name`.
  const [carrier] = await db
    .select({ id: carriers.id, name: carriers.name })
    .from(carriers)
    .where(and(eq(carriers.orgId, orgId), eq(carriers.id, carrierId)))
    .limit(1);
  if (!carrier) return null;

  const claimedRows = await db
    .select({
      originCity: carrierClaimedLanes.originCity,
      originState: carrierClaimedLanes.originState,
      destCity: carrierClaimedLanes.destCity,
      destState: carrierClaimedLanes.destState,
      equipment: carrierClaimedLanes.equipment,
      laneType: carrierClaimedLanes.laneType,
    })
    .from(carrierClaimedLanes)
    .where(eq(carrierClaimedLanes.carrierId, carrierId));

  // Drop "avoid" lanes — those are explicit DO-NOT-OFFER signals.
  const claimedPredicates: ClaimedPredicate[] = claimedRows
    .filter(r => norm(r.laneType) !== "avoid")
    .map(r => ({
      originCity: norm(r.originCity) || undefined,
      originState: norm(r.originState) || undefined,
      destCity: norm(r.destCity) || undefined,
      destState: norm(r.destState) || undefined,
      equipment: norm(r.equipment) || undefined,
      laneType: norm(r.laneType) || "prefer",
    }));

  // Build the historical lane signature set from load_fact carrier_name match.
  const historyRows = await db
    .select({
      originCity: loadFact.originCity,
      originState: loadFact.originState,
      destCity: loadFact.destinationCity,
      destState: loadFact.destinationState,
      equipment: loadFact.equipmentType,
    })
    .from(loadFact)
    .where(and(eq(loadFact.orgId, orgId), eq(loadFact.carrierName, carrier.name)))
    .limit(2000);

  const historySigs = new Set<string>();
  // Also build looser sigs (state-only, equipment-agnostic) so historical
  // freight that never had a city/equipment captured still matches today's
  // opps with the same state-pair.
  const historyStatePairs = new Set<string>(); // `${oState}|${dState}`
  for (const h of historyRows) {
    const sig = laneSig(h.originCity, h.originState, h.destCity, h.destState, h.equipment);
    if (sig) historySigs.add(sig);
    const oState = norm(h.originState);
    const dState = norm(h.destState);
    if (oState && dState) historyStatePairs.add(`${oState}|${dState}`);
  }

  const isEmpty = claimedPredicates.length === 0 && historySigs.size === 0 && historyStatePairs.size === 0;

  function matches(opp: CoverableLaneOpp): boolean {
    const oCity = norm(opp.origin);
    const oState = norm(opp.originState);
    const dCity = norm(opp.destination);
    const dState = norm(opp.destinationState);
    const equip = norm(opp.equipmentType);

    // Full-sig history match.
    if (historySigs.size > 0) {
      const sig = laneSig(opp.origin, opp.originState, opp.destination, opp.destinationState, opp.equipmentType);
      if (sig && historySigs.has(sig)) return true;
    }

    // State-pair history fallback (handles loadFact rows that lack city/equipment).
    if (oState && dState && historyStatePairs.has(`${oState}|${dState}`)) return true;

    // Claimed-lane partial match — every populated field on the claim must
    // equal the opp's value; missing fields on the claim are wildcards.
    for (const c of claimedPredicates) {
      if (c.originCity && c.originCity !== oCity) continue;
      if (c.originState && c.originState !== oState) continue;
      if (c.destCity && c.destCity !== dCity) continue;
      if (c.destState && c.destState !== dState) continue;
      if (c.equipment && c.equipment !== equip) continue;
      return true;
    }

    return false;
  }

  return {
    carrierName: carrier.name,
    isEmpty,
    matches,
  };
}
