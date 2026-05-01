/**
 * Copilot Intelligence Engine — Task #926 step 4 orchestrator.
 *
 * Joins fit + price-range output into `copilot_intelligence` rows. One
 * row per (documentId, laneKey). Idempotent — re-running for the same
 * (doc, lane) updates the existing row in place.
 */
import { db } from "../../storage";
import { sql, eq, and, desc } from "drizzle-orm";
import {
  copilotIntelligence,
  documentExtractions,
  type CopilotIntelligence,
  type DocumentExtraction,
  type Document,
  type ResolvedEntities,
} from "@shared/schema";
import { computeDocLevelFit, type FitResult, type EvidenceRef } from "./copilotFitEngine";
import { computePriceRange } from "./copilotPriceRange";

export const SCORING_VERSION = 1;

function parseLaneKey(laneKey: string): { originState: string | null; destinationState: string | null; equip: string | null } {
  const parts = laneKey.split("-");
  return {
    originState: parts[0] && parts[0] !== "NA" ? parts[0] : null,
    destinationState: parts[1] && parts[1] !== "NA" ? parts[1] : null,
    equip: parts.slice(2).join("-") || null,
  };
}

export async function computeIntelligenceForDocument(args: {
  document: Document;
  extraction: DocumentExtraction;
}): Promise<CopilotIntelligence[]> {
  const { document, extraction } = args;
  const resolved = (extraction.resolvedEntities ?? null) as ResolvedEntities | null;
  if (!resolved) return [];

  const fits: FitResult[] = await computeDocLevelFit({
    organizationId: document.organizationId,
    resolved,
  });

  const out: CopilotIntelligence[] = [];
  for (const fit of fits) {
    const laneKey = fit.laneKey ?? "NA-NA-ANY";
    const { originState, destinationState, equip } = parseLaneKey(laneKey);
    const price = await computePriceRange({
      organizationId: document.organizationId,
      originState,
      destinationState,
      equipment: equip,
      customerId: resolved.customerId,
    });
    const allEvidence: EvidenceRef[] = [...fit.evidence, ...price.comparables];

    // Risk: lane lost money the last N times we ran it (placeholder — uses
    // historic max - min spread > 30%).
    if (price.low && price.high && price.high - price.low > price.low * 0.3) {
      fit.risks.push({
        label: "Wide rate spread on historic comparables — margin risk",
        severity: "medium",
        evidence: [{ kind: "lane_rate_history", label: `low=$${price.low} / high=$${price.high}` }],
      });
    }
    if (price.confidence === "low" && price.comparables.length === 0) {
      fit.risks.push({
        label: "No comparable rate history — pricing is a guess",
        severity: "medium",
        evidence: [],
      });
    }

    const confidence: CopilotIntelligence["confidence"] =
      allEvidence.length >= 5 ? "high" : allEvidence.length >= 2 ? "medium" : "low";

    const [row] = await db
      .insert(copilotIntelligence)
      .values({
        organizationId: document.organizationId,
        documentId: document.id,
        extractionId: extraction.id,
        laneKey,
        customerId: resolved.customerId,
        laneFitScore: fit.laneFitScore,
        customerFitScore: fit.customerFitScore,
        carrierFitScore: fit.carrierFitScore,
        priceLow: price.low != null ? String(price.low) : null,
        priceMid: price.mid != null ? String(price.mid) : null,
        priceHigh: price.high != null ? String(price.high) : null,
        risks: fit.risks as object,
        opportunities: fit.opportunities as object,
        evidenceRefs: allEvidence as object,
        confidence,
        scoringVersion: SCORING_VERSION,
        adjustmentsApplied: fit.adjustmentsApplied as object,
      })
      .onConflictDoUpdate({
        target: [copilotIntelligence.documentId, copilotIntelligence.laneKey],
        set: {
          laneFitScore: sql`excluded.lane_fit_score`,
          customerFitScore: sql`excluded.customer_fit_score`,
          carrierFitScore: sql`excluded.carrier_fit_score`,
          priceLow: sql`excluded.price_low`,
          priceMid: sql`excluded.price_mid`,
          priceHigh: sql`excluded.price_high`,
          risks: sql`excluded.risks`,
          opportunities: sql`excluded.opportunities`,
          evidenceRefs: sql`excluded.evidence_refs`,
          confidence: sql`excluded.confidence`,
          scoringVersion: sql`excluded.scoring_version`,
          adjustmentsApplied: sql`excluded.adjustments_applied`,
          computedAt: sql`now()`,
        },
      })
      .returning();
    if (row) out.push(row);
  }
  return out;
}

export async function getIntelligenceForDocument(
  organizationId: string,
  documentId: string,
): Promise<CopilotIntelligence[]> {
  return db
    .select()
    .from(copilotIntelligence)
    .where(and(
      eq(copilotIntelligence.organizationId, organizationId),
      eq(copilotIntelligence.documentId, documentId),
    ))
    .orderBy(desc(copilotIntelligence.computedAt));
}

export async function getIntelligenceForCustomer(
  organizationId: string,
  customerId: string,
  limit = 25,
): Promise<CopilotIntelligence[]> {
  return db
    .select()
    .from(copilotIntelligence)
    .where(and(
      eq(copilotIntelligence.organizationId, organizationId),
      eq(copilotIntelligence.customerId, customerId),
    ))
    .orderBy(desc(copilotIntelligence.computedAt))
    .limit(limit);
}

export async function getExtractionsForDocument(
  organizationId: string,
  documentId: string,
): Promise<DocumentExtraction[]> {
  return db
    .select()
    .from(documentExtractions)
    .where(and(
      eq(documentExtractions.organizationId, organizationId),
      eq(documentExtractions.documentId, documentId),
    ))
    .orderBy(desc(documentExtractions.extractedAt));
}
