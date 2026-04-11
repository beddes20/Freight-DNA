/**
 * Account Contact Lane Pattern Responsibility Service (Task #203)
 *
 * Aggregates evidence from multiple pipeline sources (email, transaction, RFP)
 * and maintains a confidence-scored, lifecycle-managed mapping of which contacts
 * are responsible for which geographic lane patterns at each customer account.
 *
 * Key behaviors:
 *   - Idempotent: eventKey (hash of source event) prevents double-counting
 *   - Confidence scoring formula:
 *       +10 per event
 *       ×1.5 multiplier if any event within 90 days of now
 *       +15 for ≥2 distinct source types
 *       +15 if pattern ≥50% of contact's lane-related events for the account
 *       Capped at 100
 *   - Status: suggested → confirmed or dismissed (confirmed/dismissed rows never auto-downgraded)
 *   - NBA card fires when confidenceScore transitions to ≥70 with status 'suggested'
 */

import type { IStorage } from "./storage";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PatternEvidenceInput {
  orgId: string;
  accountId: string;
  contactId: string;
  lanePatternId: string;
  responsibilityType?: "spot" | "mini_bid" | "rfp" | "ops" | "other" | null;
  sourceType: "email" | "transaction" | "rfp";
  occurredAt: Date;
  /** Idempotency key — hash of the source event (e.g. sha256 of messageId+patternId). */
  eventKey: string;
}

export interface IngestResult {
  rowId: string;
  evidenceCount: number;
  confidenceScore: number;
  status: string;
  isNew: boolean;
  crossedHighConfidenceThreshold: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const RECENCY_WINDOW_DAYS = 90;
const RECENCY_MULTIPLIER = 1.5;
const DISTINCT_SOURCE_BONUS = 15;
const PATTERN_DOMINANCE_BONUS = 15;
const PATTERN_DOMINANCE_THRESHOLD = 0.5;
const HIGH_CONFIDENCE_THRESHOLD = 70;

// ─── Confidence computation ────────────────────────────────────────────────────

function computeConfidence(params: {
  evidenceCount: number;
  hasRecentEvent: boolean;
  distinctSourceCount: number;
  patternEventCount: number;
  totalContactEventCount: number;
}): number {
  let score = params.evidenceCount * 10;

  if (params.hasRecentEvent && score > 0) {
    score = Math.round(score * RECENCY_MULTIPLIER);
  }

  if (params.distinctSourceCount >= 2) {
    score += DISTINCT_SOURCE_BONUS;
  }

  if (
    params.totalContactEventCount > 0 &&
    params.patternEventCount / params.totalContactEventCount >= PATTERN_DOMINANCE_THRESHOLD
  ) {
    score += PATTERN_DOMINANCE_BONUS;
  }

  return Math.min(100, score);
}

// ─── Core ingestion function ───────────────────────────────────────────────────

/**
 * Ingest a single evidence event for a (accountId, contactId, lanePatternId) triple.
 * Idempotent: if eventKey already recorded, returns existing row without modification.
 */
export async function ingestPatternEvidence(
  input: PatternEvidenceInput,
  storage: IStorage,
): Promise<IngestResult> {
  const { orgId, accountId, contactId, lanePatternId, responsibilityType, sourceType, occurredAt, eventKey } = input;

  // 1. Load existing row if any
  const existing = await storage.getResponsibilityByKey(accountId, contactId, lanePatternId);

  if (existing) {
    // 2. Idempotency check: skip if eventKey already recorded
    const currentKeys = existing.evidenceEventKeys ?? [];
    if (currentKeys.includes(eventKey)) {
      return {
        rowId: existing.id,
        evidenceCount: existing.evidenceCount,
        confidenceScore: existing.confidenceScore,
        status: existing.status,
        isNew: false,
        crossedHighConfidenceThreshold: false,
      };
    }

    // Confirmed/dismissed rows continue accumulating evidence but never auto-downgrade status
    const newKeys = [...currentKeys, eventKey];
    const newSources = Array.from(new Set([...(existing.sourceTypes ?? []), sourceType]));
    const newCount = existing.evidenceCount + 1;
    const now = new Date();
    const recencyWindow = new Date(now.getTime() - RECENCY_WINDOW_DAYS * 24 * 3600 * 1000);
    const hasRecentEvent = occurredAt >= recencyWindow;

    // Fetch total contact events for this account to compute dominance
    const allContactResponsibilities = await storage.getResponsibilitiesByContact(contactId, { accountId });
    const totalContactEventCount = allContactResponsibilities.reduce(
      (sum, r) => sum + (r.accountId === accountId ? r.evidenceCount : 0),
      0,
    ) + 1; // +1 for the new event being ingested

    const newScore = computeConfidence({
      evidenceCount: newCount,
      hasRecentEvent,
      distinctSourceCount: newSources.length,
      patternEventCount: newCount,
      totalContactEventCount,
    });

    const prevScore = existing.confidenceScore;
    const crossedHighConfidenceThreshold =
      prevScore < HIGH_CONFIDENCE_THRESHOLD && newScore >= HIGH_CONFIDENCE_THRESHOLD;

    const updated = await storage.updateResponsibility(existing.id, {
      evidenceCount: newCount,
      lastSeenAt: occurredAt > existing.lastSeenAt ? occurredAt : existing.lastSeenAt,
      primarySourceType: newSources.length > 1 ? "mixed" : sourceType,
      confidenceScore: newScore,
      evidenceEventKeys: newKeys,
      sourceTypes: newSources,
      updatedAt: now,
      // Don't auto-change status for confirmed/dismissed rows
      ...(existing.status === "suggested" && { status: "suggested" }),
    });

    return {
      rowId: updated.id,
      evidenceCount: updated.evidenceCount,
      confidenceScore: updated.confidenceScore,
      status: updated.status,
      isNew: false,
      crossedHighConfidenceThreshold,
    };
  }

  // 3. No existing row — create new one (status: suggested)
  const now = new Date();
  const recencyWindow = new Date(now.getTime() - RECENCY_WINDOW_DAYS * 24 * 3600 * 1000);
  const hasRecentEvent = occurredAt >= recencyWindow;

  const initialScore = computeConfidence({
    evidenceCount: 1,
    hasRecentEvent,
    distinctSourceCount: 1,
    patternEventCount: 1,
    totalContactEventCount: 1,
  });

  const created = await storage.createResponsibility({
    orgId,
    accountId,
    contactId,
    lanePatternId,
    isResponsibleForPattern: true,
    responsibilityType: responsibilityType ?? null,
    confidenceScore: initialScore,
    evidenceCount: 1,
    firstSeenAt: occurredAt,
    lastSeenAt: occurredAt,
    primarySourceType: sourceType,
    status: "suggested",
    evidenceEventKeys: [eventKey],
    sourceTypes: [sourceType],
  });

  const crossedHighConfidenceThreshold = initialScore >= HIGH_CONFIDENCE_THRESHOLD;

  return {
    rowId: created.id,
    evidenceCount: created.evidenceCount,
    confidenceScore: created.confidenceScore,
    status: created.status,
    isNew: true,
    crossedHighConfidenceThreshold,
  };
}

// ─── Confidence bucket helper (for UI display) ────────────────────────────────

export function confidenceBucket(score: number): "low" | "medium" | "high" {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

// ─── NBA card rule ────────────────────────────────────────────────────────────

const NBA_RULE_TYPE = "high_confidence_geo_responsibility" as const;

/**
 * Fires an NBA card when a responsibility row transitions to confidenceScore ≥70
 * with status 'suggested', or when a lanePattern for an account has transactional
 * history but zero confirmed contacts.
 *
 * Called non-blocking (fire-and-forget) from the ingestion pipeline.
 */
export async function maybeFireResponsibilityNba(params: {
  orgId: string;
  accountId: string;
  contactId: string;
  lanePatternId: string;
  rowId: string;
  confidenceScore: number;
  crossedHighConfidenceThreshold: boolean;
  storage: IStorage;
}): Promise<void> {
  const { orgId, accountId, contactId, lanePatternId, rowId, confidenceScore, crossedHighConfidenceThreshold, storage } = params;
  if (!crossedHighConfidenceThreshold) return;

  try {
    const [pattern, company, contact] = await Promise.all([
      storage.getGeographicLanePattern(lanePatternId),
      storage.getCompany(accountId),
      storage.getContact(contactId),
    ]);
    if (!pattern || !company || !contact) return;

    // Find account owner for NBA assignment
    const ownerId = company.salesPersonId ?? company.assignedTo;
    if (!ownerId) return;

    const existing = await storage.getRecentNbaCardByType(accountId, NBA_RULE_TYPE, 30);
    if (existing) return;

    await storage.createNbaCard({
      orgId,
      userId: ownerId,
      companyId: accountId,
      companyName: company.name,
      ruleType: NBA_RULE_TYPE,
      outcomeType: "grow",
      confidence: "high",
      signalCount: 1,
      signalSummary: [{ patternName: pattern.name, contactName: contact.name, confidenceScore }] as any,
      whyThisNow: `${contact.name} is likely responsible for the "${pattern.name}" lane corridor at ${company.name} (confidence: ${confidenceScore}/100).`,
      suggestedAction: `Confirm ${contact.name} as the go-to contact for ${pattern.name} lanes and add them as a key stakeholder for future outreach in this corridor.`,
      expectedOutcome: `Streamlined outreach by knowing exactly who to contact for ${pattern.name} freight at ${company.name}.`,
      growthLever: "Geographic responsibility mapping",
      accountTier: null,
      urgencyScore: Math.round(confidenceScore * 0.7),
      status: "generated",
      marketSignalId: null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[geoResponsibility] NBA card creation error:", err);
  }
}

// ─── Evidence summary text ─────────────────────────────────────────────────────

export function buildEvidenceSummary(params: {
  evidenceCount: number;
  sourceTypes: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  responsibilityType?: string | null;
}): string {
  const { evidenceCount, sourceTypes, firstSeenAt, lastSeenAt } = params;
  const now = new Date();
  const daysSince = Math.round((now.getTime() - firstSeenAt.getTime()) / (24 * 3600 * 1000));
  const sources = sourceTypes.join(", ");
  const recencyDays = Math.round((now.getTime() - lastSeenAt.getTime()) / (24 * 3600 * 1000));
  const recencyLabel = recencyDays <= 0 ? "today" : recencyDays === 1 ? "yesterday" : `${recencyDays}d ago`;
  return `${evidenceCount} event${evidenceCount !== 1 ? "s" : ""} via ${sources} over ${daysSince}d (last: ${recencyLabel})`;
}
