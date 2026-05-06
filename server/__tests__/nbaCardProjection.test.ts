/**
 * NBA Card Projection — Contract Test Suite
 *
 * Locks in the canonical wire shape emitted by `projectNbaCard` so that
 * `/api/nba/cards`, `/api/nba/company/:companyId/card`, and any future
 * NBA card endpoint cannot silently drift apart again. (Architect re-flagged
 * "add contract tests for projection parity" three reviews in a row.)
 *
 * Behavioral guarantees covered:
 *   1  primaryContactName / primaryContactRelationshipBase resolve via primaryContactId
 *   2  Missing contact context → null fields, no throw
 *   3  primaryLaneId takes precedence over linkedLaneId for the lane label
 *   4  linkedLaneId is the fallback when primaryLaneId is missing
 *   5  Lane label format includes state suffix only when present
 *   6  Owner/overseer names ONLY emit for ruleType === "recurring_lane_capacity"
 *   7  Owner/overseer require linkedLaneId (not primaryLaneId) for resolution
 *   8  displayUserName prefers trimmed name, falls back to username
 *   9  Card spread preserves all original NBA fields unchanged
 *  10  collectProjectionIds dedupes and includes BOTH primaryLaneId and linkedLaneId
 */

import { describe, it, expect } from "vitest";
import type { NbaCard, Contact, RecurringLane, User } from "@shared/schema";
import {
  projectNbaCard,
  collectProjectionIds,
  formatLaneLabel,
  displayUserName,
  EMPTY_PROJECTION_CONTEXT,
  type ProjectionContext,
} from "../lib/nbaCardProjection";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCard(overrides: Partial<NbaCard> = {}): NbaCard {
  return {
    id: "card-001",
    orgId: "org-001",
    userId: "user-rep-001",
    companyId: "co-001",
    companyName: "Acme Logistics",
    ruleType: "stalled_followup",
    outcomeType: null,
    confidence: "0.80",
    signalCount: 1,
    signalSummary: null,
    whyThisNow: null,
    suggestedAction: null,
    expectedOutcome: null,
    growthLever: null,
    relationshipMove: null,
    accountTier: null,
    urgencyScore: null,
    playLabel: null,
    status: "visible",
    createdAt: new Date("2026-04-01T12:00:00Z") as unknown as string,
    contactId: null,
    primaryContactId: null,
    primaryLaneId: null,
    linkedLaneId: null,
    linkedTaskId: null,
    linkedCommitmentId: null,
    linkedTouchpointId: null,
    outcomeLinkedAt: null,
    outcomeTypeLinked: null,
    resolutionAction: null,
    resolvedAt: null,
    dismissReason: null,
    snoozeUntil: null,
    alternateActionNote: null,
    firstViewedAt: null,
    ...overrides,
  } as unknown as NbaCard;
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-001",
    name: "Jane Doe",
    relationshipBase: "warm",
    ...overrides,
  } as unknown as Contact;
}

function makeLane(overrides: Partial<RecurringLane> = {}): RecurringLane {
  return {
    id: "lane-001",
    origin: "Chicago",
    originState: "IL",
    destination: "Dallas",
    destinationState: "TX",
    ownerUserId: null,
    overseerUserId: null,
    ...overrides,
  } as unknown as RecurringLane;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-001",
    name: "Sam Owner",
    username: "sowner",
    role: "sales",
    ...overrides,
  } as unknown as User;
}

function ctx(overrides: Partial<ProjectionContext> = {}): ProjectionContext {
  return {
    contacts: new Map(),
    lanes: new Map(),
    users: new Map(),
    ...overrides,
  };
}

// ─── 1: contact enrichment ────────────────────────────────────────────────────

describe("projectNbaCard — contact enrichment", () => {
  it("[1] resolves primaryContactName + relationshipBase from primaryContactId", () => {
    const card = makeCard({ primaryContactId: "contact-001" });
    const c = makeContact({ id: "contact-001", name: "Jane Doe", relationshipBase: "warm" });
    const dto = projectNbaCard(card, ctx({ contacts: new Map([[c.id, c]]) }));
    expect(dto.primaryContactName).toBe("Jane Doe");
    expect(dto.primaryContactRelationshipBase).toBe("warm");
  });

  it("[2a] returns null contact fields when primaryContactId is missing", () => {
    const dto = projectNbaCard(makeCard({ primaryContactId: null }), EMPTY_PROJECTION_CONTEXT);
    expect(dto.primaryContactName).toBeNull();
    expect(dto.primaryContactRelationshipBase).toBeNull();
  });

  it("[2b] returns null contact fields when context map is missing the row", () => {
    const card = makeCard({ primaryContactId: "contact-missing" });
    const dto = projectNbaCard(card, EMPTY_PROJECTION_CONTEXT);
    expect(dto.primaryContactName).toBeNull();
    expect(dto.primaryContactRelationshipBase).toBeNull();
  });
});

// ─── 2: lane label precedence ─────────────────────────────────────────────────

describe("projectNbaCard — lane label", () => {
  it("[3] primaryLaneId wins over linkedLaneId when both are set", () => {
    const primary = makeLane({ id: "lane-PRIMARY", origin: "Atlanta", originState: "GA", destination: "Miami", destinationState: "FL" });
    const linked  = makeLane({ id: "lane-LINKED", origin: "Boise",   originState: "ID", destination: "Seattle", destinationState: "WA" });
    const card = makeCard({ primaryLaneId: primary.id, linkedLaneId: linked.id });
    const dto = projectNbaCard(card, ctx({ lanes: new Map([[primary.id, primary], [linked.id, linked]]) }));
    expect(dto.primaryLaneLabel).toBe("Atlanta, GA → Miami, FL");
  });

  it("[4] falls back to linkedLaneId when primaryLaneId is null", () => {
    const linked = makeLane({ id: "lane-LINKED", origin: "Boise", originState: "ID", destination: "Seattle", destinationState: "WA" });
    const card = makeCard({ primaryLaneId: null, linkedLaneId: linked.id });
    const dto = projectNbaCard(card, ctx({ lanes: new Map([[linked.id, linked]]) }));
    expect(dto.primaryLaneLabel).toBe("Boise, ID → Seattle, WA");
  });

  it("[5a] state suffix omitted when originState is missing", () => {
    const lane = makeLane({ originState: null, destinationState: "TX" });
    expect(formatLaneLabel(lane)).toBe("Chicago → Dallas, TX");
  });

  it("[5b] state suffix omitted when destinationState is missing", () => {
    const lane = makeLane({ originState: "IL", destinationState: null });
    expect(formatLaneLabel(lane)).toBe("Chicago, IL → Dallas");
  });

  it("[5c] formatLaneLabel returns null for null/undefined input", () => {
    expect(formatLaneLabel(null)).toBeNull();
    expect(formatLaneLabel(undefined)).toBeNull();
  });
});

// ─── 3: owner/overseer narrowing ──────────────────────────────────────────────

describe("projectNbaCard — owner/overseer enrichment", () => {
  it("[6a] emits owner/overseer ONLY for ruleType === 'recurring_lane_capacity'", () => {
    const owner = makeUser({ id: "owner-1", name: "Owner Person" });
    const lane = makeLane({ id: "lane-1", ownerUserId: owner.id });
    const cardOther = makeCard({ ruleType: "stalled_followup", linkedLaneId: lane.id });
    const dtoOther = projectNbaCard(cardOther, ctx({ lanes: new Map([[lane.id, lane]]), users: new Map([[owner.id, owner]]) }));
    expect(dtoOther.laneOwnerName).toBeNull();
    expect(dtoOther.laneOverseerName).toBeNull();
  });

  it("[6b] DOES emit owner/overseer for ruleType === 'recurring_lane_capacity'", () => {
    const owner    = makeUser({ id: "owner-1",    name: "Owner Person" });
    const overseer = makeUser({ id: "overseer-1", name: "Overseer Person" });
    const lane = makeLane({ id: "lane-1", ownerUserId: owner.id, overseerUserId: overseer.id });
    const card = makeCard({ ruleType: "recurring_lane_capacity", linkedLaneId: lane.id });
    const dto = projectNbaCard(card, ctx({
      lanes: new Map([[lane.id, lane]]),
      users: new Map([[owner.id, owner], [overseer.id, overseer]]),
    }));
    expect(dto.laneOwnerName).toBe("Owner Person");
    expect(dto.laneOverseerName).toBe("Overseer Person");
  });

  it("[7] owner/overseer require linkedLaneId — primaryLaneId alone does NOT trigger", () => {
    const owner = makeUser({ id: "owner-1", name: "Owner Person" });
    const lane = makeLane({ id: "lane-1", ownerUserId: owner.id });
    const card = makeCard({
      ruleType: "recurring_lane_capacity",
      primaryLaneId: lane.id,
      linkedLaneId: null,
    });
    const dto = projectNbaCard(card, ctx({ lanes: new Map([[lane.id, lane]]), users: new Map([[owner.id, owner]]) }));
    expect(dto.laneOwnerName).toBeNull();
    expect(dto.laneOverseerName).toBeNull();
  });
});

// ─── 4: displayUserName helper ────────────────────────────────────────────────

describe("displayUserName", () => {
  it("[8a] prefers trimmed name", () => {
    expect(displayUserName(makeUser({ name: "  Trimmed Name  ", username: "tn" }))).toBe("Trimmed Name");
  });

  it("[8b] falls back to username when name is empty/whitespace", () => {
    expect(displayUserName(makeUser({ name: "   ", username: "fallback" }))).toBe("fallback");
    expect(displayUserName(makeUser({ name: null as unknown as string, username: "fallback" }))).toBe("fallback");
  });

  it("[8c] returns null for null/undefined user", () => {
    expect(displayUserName(null)).toBeNull();
    expect(displayUserName(undefined)).toBeNull();
  });
});

// ─── 5: card spread preserves originals ──────────────────────────────────────

describe("projectNbaCard — original fields preserved", () => {
  it("[9] all source NBA card fields appear unchanged on the DTO", () => {
    const card = makeCard({
      id: "card-XYZ",
      ruleType: "stalled_followup",
      confidence: "0.91",
      signalCount: 4,
      whyThisNow: "Original reason text",
      status: "visible",
    });
    const dto = projectNbaCard(card, EMPTY_PROJECTION_CONTEXT);
    expect(dto.id).toBe("card-XYZ");
    expect(dto.ruleType).toBe("stalled_followup");
    expect(dto.confidence).toBe("0.91");
    expect(dto.signalCount).toBe(4);
    expect(dto.whyThisNow).toBe("Original reason text");
    expect(dto.status).toBe("visible");
  });
});

// ─── 6: collectProjectionIds ──────────────────────────────────────────────────

describe("collectProjectionIds", () => {
  it("[10a] returns BOTH primaryLaneId and linkedLaneId, deduped", () => {
    const cards = [
      makeCard({ id: "a", primaryContactId: "c-1", primaryLaneId: "l-1", linkedLaneId: "l-2" }),
      makeCard({ id: "b", primaryContactId: "c-1", primaryLaneId: "l-3", linkedLaneId: "l-2" }), // dupes c-1 and l-2
      makeCard({ id: "c", primaryContactId: null,  primaryLaneId: null,  linkedLaneId: "l-4" }),
    ];
    const { contactIds, laneIds } = collectProjectionIds(cards);
    expect([...contactIds].sort()).toEqual(["c-1"]);
    expect([...laneIds].sort()).toEqual(["l-1", "l-2", "l-3", "l-4"]);
  });

  it("[10b] handles empty card list cleanly", () => {
    const { contactIds, laneIds } = collectProjectionIds([]);
    expect(contactIds).toEqual([]);
    expect(laneIds).toEqual([]);
  });
});
