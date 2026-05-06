import type { NbaCard, Contact, RecurringLane, User } from "@shared/schema";

/**
 * Canonical wire shape for NBA cards returned to the client.
 *
 * Historically the various `/api/nba/*` endpoints each enriched cards
 * inline (contact lookup, lane label formatting, owner/overseer name
 * resolution). That meant `/api/nba/cards` returned a richer object than
 * `/api/nba/company/:companyId/card`, and any new endpoint risked
 * drifting again.
 *
 * This module is the single source of truth for that projection. It is
 * intentionally pure — callers fetch the supporting rows (contact, lane,
 * users) and pass them in via `ProjectionContext`. That keeps the projector
 * trivially testable and lets callers batch-fetch when projecting many
 * cards at once.
 *
 * Phase 2 rollout plan:
 *   - This session: wire `/api/nba/company/:companyId/card` (the simplest
 *     endpoint and the one currently MISSING enrichment).
 *   - Next session: cut over `/api/nba/cards` (bulk, currently does the
 *     work inline) and the team-rollup endpoints.
 *   - Eventually: delete the inline enrichment in routes.ts entirely.
 */

export interface NbaCardWireDto extends NbaCard {
  primaryContactName: string | null;
  primaryContactRelationshipBase: string | null;
  primaryLaneLabel: string | null;
  laneOwnerName: string | null;
  laneOverseerName: string | null;
}

export interface ProjectionContext {
  /** Map of contactId -> Contact for any contacts referenced by the cards. */
  contacts: ReadonlyMap<string, Contact>;
  /** Map of laneId -> RecurringLane for any lanes referenced by the cards. */
  lanes: ReadonlyMap<string, RecurringLane>;
  /** Map of userId -> User for owner/overseer name resolution. */
  users: ReadonlyMap<string, User>;
}

/** Empty context — useful for callers that have no related rows to project against. */
export const EMPTY_PROJECTION_CONTEXT: ProjectionContext = {
  contacts: new Map(),
  lanes: new Map(),
  users: new Map(),
};

/** Format a recurring lane into the canonical "Origin, ST → Destination, ST" label. */
export function formatLaneLabel(lane: RecurringLane | undefined | null): string | null {
  if (!lane) return null;
  const o = `${lane.origin}${lane.originState ? ", " + lane.originState : ""}`;
  const d = `${lane.destination}${lane.destinationState ? ", " + lane.destinationState : ""}`;
  return `${o} → ${d}`;
}

/** Pick the user-visible display name for a user (trimmed name fallback to username). */
export function displayUserName(user: User | undefined | null): string | null {
  if (!user) return null;
  return user.name?.trim() || user.username;
}

/**
 * Project a single NBA card into its canonical wire shape. The function
 * NEVER throws — missing context entries become null fields, matching
 * the existing "show what we have" UI behavior.
 */
export function projectNbaCard(card: NbaCard, ctx: ProjectionContext): NbaCardWireDto {
  const pc = card.primaryContactId ? ctx.contacts.get(card.primaryContactId) : null;

  // Match the existing precedence in routes.ts: primaryLaneId wins, then
  // linkedLaneId. Keeping behavior identical is the whole point of this
  // module during the cutover window.
  const laneIdForLabel = card.primaryLaneId ?? card.linkedLaneId ?? null;
  const laneForLabel = laneIdForLabel ? ctx.lanes.get(laneIdForLabel) : null;

  // Owner/overseer enrichment historically only fires for the
  // recurring_lane_capacity rule type via linkedLaneId. Preserve that
  // narrow behavior so we don't start emitting names for other rule
  // types that the UI may not expect.
  let laneOwnerName: string | null = null;
  let laneOverseerName: string | null = null;
  if (card.ruleType === "recurring_lane_capacity" && card.linkedLaneId) {
    const lane = ctx.lanes.get(card.linkedLaneId);
    if (lane) {
      const ownerUser = lane.ownerUserId ? ctx.users.get(lane.ownerUserId) : undefined;
      const overseerUser = lane.overseerUserId ? ctx.users.get(lane.overseerUserId) : undefined;
      laneOwnerName = displayUserName(ownerUser);
      laneOverseerName = displayUserName(overseerUser);
    }
  }

  return {
    ...card,
    primaryContactName: pc?.name ?? null,
    primaryContactRelationshipBase: pc?.relationshipBase ?? null,
    primaryLaneLabel: formatLaneLabel(laneForLabel),
    laneOwnerName,
    laneOverseerName,
  };
}

/**
 * Collect the set of related-row IDs that a batch of cards will need
 * projected. Use this to build the SELECT IN (...) batches before
 * calling projectNbaCard on each card — avoids N+1 fetches.
 */
export function collectProjectionIds(cards: readonly NbaCard[]): {
  contactIds: string[];
  laneIds: string[];
} {
  const contactIds = new Set<string>();
  const laneIds = new Set<string>();
  for (const c of cards) {
    if (c.primaryContactId) contactIds.add(c.primaryContactId);
    if (c.primaryLaneId) laneIds.add(c.primaryLaneId);
    if (c.linkedLaneId) laneIds.add(c.linkedLaneId);
  }
  return { contactIds: [...contactIds], laneIds: [...laneIds] };
}
