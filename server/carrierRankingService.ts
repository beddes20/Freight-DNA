/**
 * Carrier Ranking Service
 *
 * Given a recurring lane, scores each candidate carrier using:
 *   - Exact lane history (has the carrier run this corridor before?)
 *   - Similar-lane history (same region, similar haul, same equipment)
 *   - Carrier catalog region/equipment fit
 *   - Recency of last move
 *   - Notes quality
 *
 * Returns a ranked list with a short human-readable reason per carrier.
 *
 * V1 uses rule-based scoring; AI enrichment is additive.
 */

import type { RecurringLane, Carrier, FinancialUpload } from "@shared/schema";
import type { IStorage } from "./storage";

/** Typed shape of TMS rows from financial upload JSONB */
interface TmsRow {
  shipperCity?: string;
  originCity?: string;
  origin?: string;
  consigneeCity?: string;
  destinationCity?: string;
  destination?: string;
  carrier?: string;
  carrierName?: string;
  carrier_name?: string;
  month?: string | number;
  equipmentType?: string;
  mode?: string;
  customerName?: string;
  /** Margin fields (may be absent) */
  margin?: number | string;
  marginPct?: number | string;
  onTimePct?: number | string;
  on_time_pct?: number | string;
}

export interface RankedCarrier {
  carrierId: string | null;
  carrierName: string;
  mcDot: string | null;
  primaryEmail: string | null;
  backupEmail: string | null;
  regions: string[];
  equipmentTypes: string[];
  tags: string[];
  notes: string | null;
  fitScore: number;           // 0–100
  fitReason: string;
  historyMatch: "exact" | "similar" | "region" | "none";
  loadsOnLane: number;
  lastUsedMonth: string | null;
  isNewProspect: boolean;
  estimatedOnTimePct: number | null;   // derived from financial row on-time field if available
  marginContribution: number | null;   // derived from financial rows margin field if available
}

function normStr(s: string): string {
  return (s ?? "").toString().trim().toLowerCase();
}

function toTitleCase(s: string): string {
  return s.replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function overlaps(a: string[], b: string): boolean {
  const bLow = normStr(b);
  return a.some(x => normStr(x).includes(bLow) || bLow.includes(normStr(x)));
}

/**
 * Extract carrier history from financial upload rows for a given lane.
 * Returns a map of carrierName (normalized) → { loads, lastUsedMonth }
 */
interface CarrierHistory {
  loads: number;
  lastUsedMonth: string | null;
  /** Average on-time percentage from financial rows (if present) */
  avgOnTimePct: number | null;
  /** Total margin contribution from financial rows (if present) */
  totalMargin: number | null;
  marginRowCount: number;
}

function extractCarrierHistoryFromUploads(
  uploads: FinancialUpload[],
  lane: RecurringLane,
): Map<string, CarrierHistory> {
  const history = new Map<string, CarrierHistory>();
  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);

  // Sort uploads newest first
  const sorted = [...uploads].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

  for (const upload of sorted.slice(0, 3)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      const rowOrigin = normStr(row.shipperCity ?? row.originCity ?? row.origin ?? "");
      const rowDest = normStr(row.consigneeCity ?? row.destinationCity ?? row.destination ?? "");
      const carrierRaw = normStr(row.carrier ?? row.carrierName ?? row.carrier_name ?? "");
      const month = String(row.month ?? "").slice(0, 7);

      if (!carrierRaw) continue;

      // Skip rows with blank origin or destination — they can't be meaningfully matched
      if (!rowOrigin || !rowDest) continue;

      const isExact = rowOrigin === originNorm && rowDest === destNorm;
      // Require at least 4 chars on both sides before prefix-matching to avoid
      // false positives when either value is very short or empty after normalization
      const originPrefix = originNorm.slice(0, 4);
      const destPrefix = destNorm.slice(0, 4);
      const isSimilarOrigin = originPrefix.length >= 4 && rowOrigin.length >= 4 &&
        (rowOrigin.includes(originPrefix) || originNorm.includes(rowOrigin.slice(0, 4)));
      const isSimilarDest = destPrefix.length >= 4 && rowDest.length >= 4 &&
        (rowDest.includes(destPrefix) || destNorm.includes(rowDest.slice(0, 4)));

      if (!isExact && !(isSimilarOrigin && isSimilarDest)) continue;

      const existing = history.get(carrierRaw) ?? { loads: 0, lastUsedMonth: null, avgOnTimePct: null, totalMargin: null, marginRowCount: 0 };

      // Extract on-time % if present
      const onTimeRaw = row.onTimePct ?? row.on_time_pct;
      const onTimeParsed = onTimeRaw !== undefined ? parseFloat(String(onTimeRaw)) : NaN;

      // Extract margin if present
      const marginRaw = row.margin ?? row.marginPct;
      const marginParsed = marginRaw !== undefined ? parseFloat(String(marginRaw)) : NaN;

      history.set(carrierRaw, {
        loads: existing.loads + 1,
        lastUsedMonth: month > (existing.lastUsedMonth ?? "") ? month : existing.lastUsedMonth,
        avgOnTimePct: !isNaN(onTimeParsed)
          ? ((existing.avgOnTimePct ?? onTimeParsed) * existing.loads + onTimeParsed) / (existing.loads + 1)
          : existing.avgOnTimePct,
        totalMargin: !isNaN(marginParsed)
          ? (existing.totalMargin ?? 0) + marginParsed
          : existing.totalMargin,
        marginRowCount: !isNaN(marginParsed) ? existing.marginRowCount + 1 : existing.marginRowCount,
      });
    }
  }

  return history;
}

/**
 * Rank all carriers in the org catalog for a given lane.
 */
export async function rankCarriersForLane(
  lane: RecurringLane,
  storage: IStorage,
): Promise<RankedCarrier[]> {
  const [catalogCarriers, uploads] = await Promise.all([
    storage.getCarriers(lane.orgId),
    storage.getFinancialUploadsForOrg(lane.orgId),
  ]);

  const history = extractCarrierHistoryFromUploads(uploads, lane);
  const laneOrigin = normStr(lane.origin);
  const laneDest = normStr(lane.destination);
  const laneEquip = normStr(lane.equipmentType ?? "");
  const laneOriginState = normStr(lane.originState ?? "");
  const laneDestState = normStr(lane.destinationState ?? "");

  const ranked: RankedCarrier[] = [];

  // Score catalog carriers
  for (const carrier of catalogCarriers) {
    const carrierNorm = normStr(carrier.name);
    const hist = history.get(carrierNorm);
    let fitScore = 0;
    const reasons: string[] = [];
    let historyMatch: RankedCarrier["historyMatch"] = "none";

    // Exact history match
    if (hist && hist.loads > 0) {
      const exactLoad = extractExactLaneLoads(uploads, lane, carrier.name);
      if (exactLoad > 0) {
        historyMatch = "exact";
        const pts = Math.min(40, 10 + exactLoad * 5);
        fitScore += pts;
        reasons.push(`Ran this lane ${exactLoad}× recently`);
        if (hist.lastUsedMonth) reasons.push(`last used ${hist.lastUsedMonth}`);
      } else {
        historyMatch = "similar";
        fitScore += 25;
        reasons.push(`Ran similar corridors (${hist.loads} loads in region)`);
      }
    }

    // Equipment fit
    if (laneEquip && carrier.equipmentTypes && carrier.equipmentTypes.length > 0) {
      if (overlaps(carrier.equipmentTypes, laneEquip)) {
        fitScore += 20;
        reasons.push(`Equipment match: ${laneEquip}`);
      }
    } else {
      fitScore += 10; // no equipment filter = assume general fit
    }

    // Region fit
    const carrierRegions = carrier.regions ?? [];
    const regionMatch =
      (laneOriginState && overlaps(carrierRegions, laneOriginState)) ||
      (laneDestState && overlaps(carrierRegions, laneDestState)) ||
      overlaps(carrierRegions, laneOrigin) ||
      overlaps(carrierRegions, laneDest);
    if (regionMatch) {
      if (historyMatch === "none") historyMatch = "region";
      fitScore += 15;
      reasons.push("Operates in this region");
    }

    // Recency bonus
    if (hist?.lastUsedMonth) {
      const monthsAgo = monthDiff(hist.lastUsedMonth);
      if (monthsAgo <= 3) { fitScore += 10; reasons.push("Active in last 3 months"); }
      else if (monthsAgo <= 6) { fitScore += 5; reasons.push("Active in last 6 months"); }
    }

    // On-time % bonus from financial rows
    if (hist?.avgOnTimePct !== null && hist?.avgOnTimePct !== undefined) {
      if (hist.avgOnTimePct >= 95) { fitScore += 8; reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
      else if (hist.avgOnTimePct >= 85) { fitScore += 4; reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
    }

    // Margin contribution bonus from financial rows
    if (hist?.totalMargin !== null && hist?.totalMargin !== undefined && hist.totalMargin > 0) {
      const avgMargin = hist.totalMargin / Math.max(1, hist.marginRowCount);
      if (avgMargin >= 500) { fitScore += 5; reasons.push(`Avg margin contribution: $${avgMargin.toFixed(0)}`); }
    }

    // Notes / email present bonus
    if (carrier.primaryEmail) fitScore += 5;

    fitScore = Math.min(100, fitScore);

    if (fitScore === 0 && historyMatch === "none" && !regionMatch) continue; // skip zero-fit unknown carriers

    ranked.push({
      carrierId: carrier.id,
      carrierName: carrier.name,
      mcDot: carrier.mcDot ?? null,
      primaryEmail: carrier.primaryEmail ?? null,
      backupEmail: carrier.backupEmail ?? null,
      regions: carrier.regions ?? [],
      equipmentTypes: carrier.equipmentTypes ?? [],
      tags: carrier.tags ?? [],
      notes: carrier.notes ?? null,
      fitScore,
      fitReason: reasons.length > 0 ? reasons.join(". ") + "." : "Carrier in region catalog.",
      historyMatch,
      loadsOnLane: hist?.loads ?? 0,
      lastUsedMonth: hist?.lastUsedMonth ?? null,
      isNewProspect: (hist?.loads ?? 0) === 0,
      estimatedOnTimePct: hist?.avgOnTimePct ?? null,
      marginContribution: hist?.totalMargin ?? null,
    });
  }

  // Also add carriers from financial history that aren't in catalog yet
  for (const [carrierNorm, hist] of history.entries()) {
    const alreadyInCatalog = ranked.some(r => normStr(r.carrierName) === carrierNorm);
    if (alreadyInCatalog) continue;
    if ((hist.loads ?? 0) < 1) continue;

    const exactLoad = extractExactLaneLoads(uploads, lane, carrierNorm);
    const historyMatch: RankedCarrier["historyMatch"] = exactLoad > 0 ? "exact" : "similar";
    let fitScore = Math.min(85, 30 + (exactLoad > 0 ? exactLoad * 5 : hist.loads * 2));
    const reasons: string[] = [];
    if (exactLoad > 0) reasons.push(`Ran this lane ${exactLoad}× from financial history`);
    else reasons.push(`${hist.loads} loads on similar corridors`);
    if (hist.lastUsedMonth) reasons.push(`last used ${hist.lastUsedMonth}`);

    // On-time % from financial rows
    if (hist.avgOnTimePct !== null && hist.avgOnTimePct !== undefined) {
      if (hist.avgOnTimePct >= 95) { fitScore = Math.min(100, fitScore + 8); reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
      else if (hist.avgOnTimePct >= 85) { fitScore = Math.min(100, fitScore + 4); reasons.push(`On-time: ${hist.avgOnTimePct.toFixed(0)}%`); }
    }

    ranked.push({
      carrierId: null,
      carrierName: toTitleCase(carrierNorm),
      mcDot: null,
      primaryEmail: null,
      backupEmail: null,
      regions: [],
      equipmentTypes: [],
      tags: [],
      notes: null,
      fitScore,
      fitReason: reasons.join(". ") + ".",
      historyMatch,
      loadsOnLane: hist.loads,
      lastUsedMonth: hist.lastUsedMonth,
      isNewProspect: false,
      estimatedOnTimePct: hist.avgOnTimePct,
      marginContribution: hist.totalMargin,
    });
  }

  // Sort: historyMatch exact first, then by fitScore desc
  ranked.sort((a, b) => {
    const matchRank = { exact: 0, similar: 1, region: 2, none: 3 };
    const md = matchRank[a.historyMatch] - matchRank[b.historyMatch];
    if (md !== 0) return md;
    return b.fitScore - a.fitScore;
  });

  const top20 = ranked.slice(0, 20);

  // AI enrichment: enrich fitReason strings for top candidates with AI analysis
  // Falls back gracefully to rule-based reasons on any error.
  try {
    const { callAI } = await import("./aiHelpers");
    const top5 = top20.slice(0, 5);
    if (top5.length > 0) {
      const carrierSummaries = top5.map((c, i) =>
        `${i + 1}. ${c.carrierName}: rule fit=${c.fitScore}, history=${c.historyMatch}, ` +
        `loads=${c.loadsOnLane}, onTime=${c.estimatedOnTimePct != null ? c.estimatedOnTimePct.toFixed(0) + "%" : "?"}` +
        `${c.notes ? `, notes: ${c.notes.slice(0, 80)}` : ""}`
      ).join("\n");

      const prompt = `You are a freight logistics analyst. Assess each carrier's fit for this recurring lane.

Lane: ${lane.origin} → ${lane.destination} (${lane.equipmentType ?? "any equipment"})
Customer: ${lane.companyName ?? "Unknown"}, avg ${lane.avgLoadsPerWeek} loads/week

Carriers (rule-scored):
${carrierSummaries}

For each carrier, provide a concise 1-sentence fit reason focusing on capacity reliability and lane experience.
Respond ONLY with JSON array: [{"name": "<carrier name>", "reason": "<1 sentence>", "adjustedScore": <0-100>}]`;

      const raw = await callAI(prompt, 300);
      const aiResults: Array<{ name: string; reason: string; adjustedScore: number }> =
        JSON.parse(raw.replace(/```json|```/g, "").trim());

      if (Array.isArray(aiResults)) {
        for (const aiItem of aiResults) {
          const carrier = top20.find(c => normStr(c.carrierName) === normStr(aiItem.name));
          if (carrier && typeof aiItem.reason === "string" && typeof aiItem.adjustedScore === "number") {
            carrier.fitReason = aiItem.reason;
            // Blend rule-based and AI scores (70/30)
            carrier.fitScore = Math.min(100, Math.max(0,
              Math.round(0.7 * carrier.fitScore + 0.3 * aiItem.adjustedScore)
            ));
          }
        }
        // Re-sort after AI score adjustments
        top20.sort((a, b) => b.fitScore - a.fitScore);
      }
    }
  } catch {
    // Silent fallback to rule-based ranking
  }

  return top20;
}

function extractExactLaneLoads(uploads: FinancialUpload[], lane: RecurringLane, carrierName: string): number {
  const originNorm = normStr(lane.origin);
  const destNorm = normStr(lane.destination);
  const carrierNorm = normStr(carrierName);
  let count = 0;
  for (const upload of uploads.slice(0, 2)) {
    const rows = (upload.rows as TmsRow[]) ?? [];
    for (const row of rows) {
      const rowOrigin = normStr(row.shipperCity ?? row.originCity ?? row.origin ?? "");
      const rowDest = normStr(row.consigneeCity ?? row.destinationCity ?? row.destination ?? "");
      const rowCarrier = normStr(row.carrier ?? row.carrierName ?? row.carrier_name ?? "");
      if (rowOrigin === originNorm && rowDest === destNorm && rowCarrier === carrierNorm) {
        count++;
      }
    }
  }
  return count;
}

function monthDiff(monthKey: string): number {
  const [y, m] = monthKey.split("-").map(Number);
  const now = new Date();
  return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
}
