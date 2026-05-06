/**
 * Task #912 — Phase 5 outcome wiring.
 *
 * When a downstream entity that a Fit & Intelligence Card pointed at reaches
 * a terminal state (opportunity won/lost, capture failure resolved, lane
 * leak resolved), we record the outcome on the matching card so the Phase 5
 * trainer can score how well the reasoner / matcher predicted reality.
 *
 * Each helper is idempotent — recording an outcome twice merges into the
 * existing downstreamOutcome JSON without overwriting the resolution time.
 *
 * NOTE: This module exposes pure functions; the caller (existing
 * opportunity / capture failure / leak resolver code) wires these into its
 * own commit hooks. Slice 3 ships the helpers + a smoke test only — a
 * follow-up task wires them into every resolver site.
 */

import { storage } from "../storage";
import type { CopilotRecommendation } from "@shared/schema";

export interface OutcomePatch {
  kind:
    | "opportunity_won"
    | "opportunity_lost"
    | "opportunity_snoozed"
    | "capture_failure_resolved"
    | "leak_resolved"
    | "available_freight_converted";
  detail?: string | null;
  amount?: number | null;
  resolvedById?: string | null;
}

/**
 * Record an outcome against the most recent card for a given anchor entity.
 * Returns null if no card exists for that anchor.
 */
export async function recordOutcomeForOpportunity(
  organizationId: string,
  opportunityId: string,
  patch: OutcomePatch,
): Promise<CopilotRecommendation | null> {
  const cards = await storage.listRecommendationsForOpportunity(opportunityId, organizationId, 1);
  const card = cards[0];
  if (!card) return null;
  return await storage.recordRecommendationOutcome(card.id, organizationId, {
    [patch.kind]: {
      at: new Date().toISOString(),
      detail: patch.detail ?? null,
      amount: patch.amount ?? null,
      resolvedById: patch.resolvedById ?? null,
    },
  }) ?? null;
}

export async function recordOutcomeForCustomer(
  organizationId: string,
  customerCompanyId: string,
  patch: OutcomePatch,
): Promise<CopilotRecommendation | null> {
  const cards = await storage.listRecommendationsForCustomer(customerCompanyId, organizationId, 1);
  const card = cards[0];
  if (!card) return null;
  return await storage.recordRecommendationOutcome(card.id, organizationId, {
    [patch.kind]: {
      at: new Date().toISOString(),
      detail: patch.detail ?? null,
      amount: patch.amount ?? null,
      resolvedById: patch.resolvedById ?? null,
    },
  }) ?? null;
}

export async function recordOutcomeForLane(
  organizationId: string,
  laneSignature: string,
  patch: OutcomePatch,
): Promise<CopilotRecommendation | null> {
  const cards = await storage.listRecommendationsForLane(laneSignature, organizationId, 1);
  const card = cards[0];
  if (!card) return null;
  return await storage.recordRecommendationOutcome(card.id, organizationId, {
    [patch.kind]: {
      at: new Date().toISOString(),
      detail: patch.detail ?? null,
      amount: patch.amount ?? null,
      resolvedById: patch.resolvedById ?? null,
    },
  }) ?? null;
}

export async function recordOutcomeForCard(
  organizationId: string,
  recommendationId: string,
  patch: OutcomePatch,
): Promise<CopilotRecommendation | null> {
  return await storage.recordRecommendationOutcome(recommendationId, organizationId, {
    [patch.kind]: {
      at: new Date().toISOString(),
      detail: patch.detail ?? null,
      amount: patch.amount ?? null,
      resolvedById: patch.resolvedById ?? null,
    },
  }) ?? null;
}
