/**
 * Market Signal Engine
 *
 * Core service layer for the Market Signal Intelligence Layer.
 * Ingests normalized market events, evaluates threshold-driven signals,
 * manages signal lifecycle (active → cooling → resolved / suppressed),
 * and generates deterministic plain-English explanations.
 *
 * All threshold values come from marketSignalThresholds.ts — no magic numbers here.
 */

import { normalizeEquipmentType, normalizeLaneLocation } from "@shared/laneFormatters";
import type { IStorage } from "./storage";
import {
  type InsertMarketEvent,
  type MarketEvent,
  type MarketSignal,
  type InsertMarketSignal,
  type MarketSignalType,
  type MarketScopeType,
  type MarketSignalStatus,
  type MarketSignalSeverity,
  marketEventTypes,
  marketScopeTypes,
  marketSignalTypes,
} from "@shared/schema";
import { MARKET_SIGNAL_THRESHOLDS as CFG } from "./marketSignalThresholds";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EvidencePayload {
  recentCount: number;
  baselineCount: number;
  percentChange: number;
  distinctAccounts: number;
  distinctCarriers: number;
  evaluationWindowHours: number;
  baselineLookbackHours: number;
  scopeKey: string;
  scopeType: string;
  equipmentType: string | null;
  [key: string]: unknown;
}

export interface MarketSignalFilters {
  scopeType?: MarketScopeType;
  scopeKey?: string;
  equipmentType?: string;
  signalType?: MarketSignalType;
  status?: MarketSignalStatus | MarketSignalStatus[];
}

// Validation schema for inbound event recording
const recordEventSchema = z.object({
  eventType: z.enum(marketEventTypes),
  scopeType: z.enum(marketScopeTypes),
  scopeKey: z.string().min(1),
  equipmentType: z.string().nullable().optional(),
  originRegion: z.string().nullable().optional(),
  destinationRegion: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  carrierId: z.string().nullable().optional(),
  eventValue: z.union([z.string(), z.number()]).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  occurredAt: z.string().datetime().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function computeSeverity(pctChange: number): MarketSignalSeverity {
  if (pctChange >= CFG.severity.criticalPctThreshold) return "critical";
  if (pctChange >= CFG.severity.highPctThreshold) return "high";
  if (pctChange >= CFG.severity.mediumPctThreshold) return "medium";
  return "low";
}

function computeConfidence(
  recentCount: number,
  pctChange: number,
  distinctAccounts: number,
  minEventCount: number,
): number {
  // Base confidence from count relative to minimum
  const countFactor = Math.min(1.0, recentCount / (minEventCount * 2));
  // Pct change factor caps at 1.0 for very large surges
  const pctFactor = Math.min(1.0, pctChange / CFG.severity.criticalPctThreshold);
  // Multi-account bonus
  const accountBonus = distinctAccounts >= CFG.distinctAccountFloor ? 0.1 : 0;
  const raw = countFactor * 0.5 + pctFactor * 0.4 + accountBonus;
  return Math.min(1.0, Math.round(raw * 10000) / 10000);
}

/**
 * Generates a deterministic, data-driven plain-English explanation.
 * No LLM — all values come from the evidencePayload.
 */
export function generateExplanation(
  signalType: MarketSignalType,
  evidence: EvidencePayload,
): string {
  const { recentCount, baselineCount, percentChange, distinctAccounts, distinctCarriers, equipmentType, scopeKey } = evidence;
  const equip = equipmentType ? ` for ${equipmentType}` : "";
  const scope = scopeKey || "this market";
  const pctStr = percentChange > 0 ? `+${Math.round(percentChange)}%` : `${Math.round(percentChange)}%`;

  switch (signalType) {
    case "demand_surge":
      return `Demand surge detected in ${scope}${equip}. ${recentCount} demand requests in the last ${evidence.evaluationWindowHours}h vs a baseline of ${Math.round(baselineCount)} (${pctStr} above baseline). ${distinctAccounts} distinct shipper account${distinctAccounts !== 1 ? "s" : ""} driving volume.`;

    case "capacity_shortage":
      return `Carrier capacity shortage detected in ${scope}${equip}. Only ${distinctCarriers} distinct carrier${distinctCarriers !== 1 ? "s" : ""} declared capacity in the last ${evidence.evaluationWindowHours}h — ${pctStr} below baseline expectations.`;

    case "demand_capacity_imbalance":
      return `Demand-capacity imbalance in ${scope}${equip}. Strong demand signal (${recentCount} requests, ${distinctAccounts} accounts) but carrier capacity is weak or absent. Expect rate pressure and tighter coverage.`;

    case "quote_activity_spike":
      return `Quote activity spike in ${scope}${equip}. ${recentCount} quotes submitted in the last ${evidence.evaluationWindowHours}h — ${pctStr} above the ${evidence.baselineLookbackHours}h baseline average.`;

    case "carrier_capacity_declaration":
      return `Carrier capacity declaration surge in ${scope}${equip}. ${distinctCarriers} distinct carrier${distinctCarriers !== 1 ? "s" : ""} declared capacity in the last ${evidence.evaluationWindowHours}h (${pctStr} above baseline), indicating ample supply.`;

    default:
      return `Market signal detected in ${scope}${equip}. ${recentCount} events in the last ${evidence.evaluationWindowHours}h (${pctStr} vs baseline of ${Math.round(baselineCount)}).`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Engine
// ─────────────────────────────────────────────────────────────────────────────

export class MarketSignalEngine {
  constructor(private readonly storage: IStorage) {}

  /**
   * Validate and persist a normalized input event.
   */
  async recordMarketEvent(raw: unknown): Promise<MarketEvent> {
    const parsed = recordEventSchema.parse(raw);
    const normalizedEquip = parsed.equipmentType
      ? normalizeEquipmentType(parsed.equipmentType)
      : null;

    const event = await this.storage.insertMarketEvent({
      eventType: parsed.eventType,
      scopeType: parsed.scopeType,
      scopeKey: normalizeLaneLocation(parsed.scopeKey),
      equipmentType: normalizedEquip,
      originRegion: parsed.originRegion ?? null,
      destinationRegion: parsed.destinationRegion ?? null,
      accountId: parsed.accountId ?? null,
      carrierId: parsed.carrierId ?? null,
      eventValue: parsed.eventValue != null ? String(parsed.eventValue) : null,
      metadata: parsed.metadata ?? null,
      occurredAt: parsed.occurredAt ? new Date(parsed.occurredAt) : new Date(),
    });

    return event;
  }

  /**
   * Evaluate market signals across all (or a specific) scope.
   * Rolls up recent events against thresholds, upserts signals, handles lifecycle.
   */
  async evaluateMarketSignals(scope?: { scopeType?: MarketScopeType; scopeKey?: string }): Promise<void> {
    const now = new Date();
    const recentFrom = hoursAgo(CFG.evaluationWindowHours);
    // Baseline window excludes the recent evaluation window so it reflects historical rate only
    const baselineFrom = hoursAgo(CFG.baselineLookbackHours);

    // Fetch events: recent window (for signal detection) and full baseline window (for rate comparison)
    // Baseline events are filtered to exclude the recent window when computing the baseline count.
    const [recentEvents, allBaselineEvents] = await Promise.all([
      this.storage.getMarketEventsSince(recentFrom, scope),
      this.storage.getMarketEventsSince(baselineFrom, scope),
    ]);

    // Exclude recent events from baseline to get a true historical baseline
    const recentFromMs = recentFrom.getTime();
    const baselineEvents = allBaselineEvents.filter(
      e => new Date(e.occurredAt).getTime() < recentFromMs,
    );

    // Group recent events by (scopeType, scopeKey, equipmentType, eventType)
    type GroupKey = string;
    interface EventGroup {
      scopeType: string;
      scopeKey: string;
      equipmentType: string | null;
      eventType: string;
      events: MarketEvent[];
    }

    const groups = new Map<GroupKey, EventGroup>();
    for (const ev of recentEvents) {
      const key = `${ev.scopeType}|${ev.scopeKey}|${ev.equipmentType ?? ""}|${ev.eventType}`;
      if (!groups.has(key)) {
        groups.set(key, {
          scopeType: ev.scopeType,
          scopeKey: ev.scopeKey,
          equipmentType: ev.equipmentType,
          eventType: ev.eventType,
          events: [],
        });
      }
      groups.get(key)!.events.push(ev);
    }

    // Baseline period length = lookbackHours - evalWindowHours
    const baselinePeriodHours = CFG.baselineLookbackHours - CFG.evaluationWindowHours;
    // Scale factor to normalize baseline count to evaluation window duration
    const baselineScaleFactor = baselinePeriodHours > 0
      ? CFG.evaluationWindowHours / baselinePeriodHours
      : 1;

    for (const [, group] of groups) {
      if (group.eventType !== "demand_request" && group.eventType !== "carrier_capacity_declaration" && group.eventType !== "quote_submission") {
        continue;
      }

      const recentCount = group.events.length;
      if (recentCount < CFG.minEventCount) continue;

      // Baseline: same scope/equip/eventType events in the historical (pre-recent) window
      const baseline = baselineEvents.filter(e =>
        e.scopeType === group.scopeType &&
        e.scopeKey === group.scopeKey &&
        e.equipmentType === group.equipmentType &&
        e.eventType === group.eventType
      );
      const baselineCount = baseline.length * baselineScaleFactor;

      const percentChange = baselineCount > 0
        ? ((recentCount - baselineCount) / baselineCount) * 100
        : recentCount > 0 ? 100 : 0;

      const distinctAccounts = new Set(group.events.map(e => e.accountId).filter(Boolean)).size;
      const distinctCarriers = new Set(group.events.map(e => e.carrierId).filter(Boolean)).size;

      // Distinct account floor for demand signals
      if (group.eventType === "demand_request" && distinctAccounts < CFG.distinctAccountFloor) {
        continue;
      }
      // Distinct carrier floor for capacity signals
      if (group.eventType === "carrier_capacity_declaration" && distinctCarriers < CFG.distinctCarrierFloor) {
        continue;
      }

      // Map event type → signal type
      let signalType: MarketSignalType;
      if (group.eventType === "demand_request") {
        if (percentChange < CFG.demandSurgeMinPctIncrease) continue;
        signalType = "demand_surge";
      } else if (group.eventType === "carrier_capacity_declaration") {
        signalType = "carrier_capacity_declaration";
      } else if (group.eventType === "quote_submission") {
        if (percentChange < CFG.demandSurgeMinPctIncrease) continue;
        signalType = "quote_activity_spike";
      } else {
        continue;
      }

      const confidence = computeConfidence(recentCount, percentChange, distinctAccounts, CFG.minEventCount);
      if (confidence < CFG.minConfidence) continue;

      const severity = computeSeverity(percentChange);

      const evidence: EvidencePayload = {
        recentCount,
        baselineCount,
        percentChange,
        distinctAccounts,
        distinctCarriers,
        evaluationWindowHours: CFG.evaluationWindowHours,
        baselineLookbackHours: CFG.baselineLookbackHours,
        scopeKey: group.scopeKey,
        scopeType: group.scopeType,
        equipmentType: group.equipmentType,
      };

      const explanation = generateExplanation(signalType, evidence);

      // Upsert signal (update existing active/cooling, create new otherwise).
      // Pass cooldownHours so a cooling signal cannot re-activate until the cooldown elapses.
      await this.storage.upsertMarketSignal({
        signalType,
        scopeType: group.scopeType,
        scopeKey: group.scopeKey,
        equipmentType: group.equipmentType,
        status: "active",
        severity,
        confidence: String(confidence),
        evidencePayload: evidence,
        explanation,
        lastEvaluatedAt: now,
      }, CFG.cooldownHours);
    }

    // Lifecycle management: transition active signals that haven't been refreshed
    await this._transitionStaleSignals(now);

    // Imbalance detection: check for demand_surge + weak/absent capacity
    await this._detectImbalances(now);
  }

  /**
   * Transition active signals that have gone stale.
   * active → cooling after coolingTransitionHours without new evidence.
   * cooling → resolved after autoResolveHours total.
   */
  private async _transitionStaleSignals(now: Date): Promise<void> {
    const activeSignals = await this.storage.getActiveMarketSignals({});
    for (const signal of activeSignals) {
      // Skip suppressed signals — they stay suppressed until explicitly cleared
      if (signal.status === "suppressed") continue;

      const lastEval = new Date(signal.lastEvaluatedAt).getTime();
      const ageSinceEvalHours = (now.getTime() - lastEval) / 3_600_000;
      const firstDetected = new Date(signal.firstDetectedAt).getTime();
      const totalAgeHours = (now.getTime() - firstDetected) / 3_600_000;

      if (signal.status === "active" && ageSinceEvalHours >= CFG.coolingTransitionHours) {
        await this.storage.updateMarketSignalStatus(signal.id, "cooling", now);
      } else if (signal.status === "cooling" && totalAgeHours >= CFG.autoResolveHours) {
        await this.storage.updateMarketSignalStatus(signal.id, "resolved", now);
      }
    }
  }

  /**
   * Imbalance detection: if a demand_surge signal is ACTIVE (not cooling) for a scope
   * and no matching carrier capacity signal exists or it is weak, create/update
   * a demand_capacity_imbalance signal.
   */
  private async _detectImbalances(now: Date): Promise<void> {
    // Only consider strictly active demand signals — cooling demand signals do not
    // indicate current strong demand and should not trigger imbalance.
    const demandSignals = await this.storage.getActiveMarketSignals({
      signalType: "demand_surge",
      status: "active",
    });

    for (const demandSig of demandSignals) {
      // Look for a capacity signal in the same scope
      const capacitySignals = await this.storage.getActiveMarketSignals({
        signalType: "carrier_capacity_declaration",
        scopeType: demandSig.scopeType as MarketScopeType,
        scopeKey: demandSig.scopeKey,
        equipmentType: demandSig.equipmentType ?? undefined,
      });

      const capacitySignal = capacitySignals[0] ?? null;
      const capacityIsWeak =
        !capacitySignal ||
        Number(capacitySignal.confidence) <= CFG.imbalance.weakCapacityConfidenceMax ||
        capacitySignal.status === "cooling";

      if (!capacityIsWeak) continue;

      const demandEvidence = demandSig.evidencePayload as EvidencePayload;
      const imbalanceEvidence: EvidencePayload = {
        ...demandEvidence,
        capacitySignalId: capacitySignal?.id ?? null,
        capacityConfidence: capacitySignal ? Number(capacitySignal.confidence) : 0,
        capacityStatus: capacitySignal?.status ?? "absent",
      };

      const explanation = generateExplanation("demand_capacity_imbalance", imbalanceEvidence);

      await this.storage.upsertMarketSignal({
        signalType: "demand_capacity_imbalance",
        scopeType: demandSig.scopeType,
        scopeKey: demandSig.scopeKey,
        equipmentType: demandSig.equipmentType,
        status: "active",
        severity: demandSig.severity,
        confidence: String(Math.min(1.0, Number(demandSig.confidence) * 0.9)),
        evidencePayload: imbalanceEvidence,
        explanation,
        lastEvaluatedAt: now,
      }, CFG.cooldownHours);
    }
  }

  /**
   * Suppress a signal by ID (removes it from active consideration without resolving).
   * Suppressed signals are excluded from lifecycle transitions and do not re-fire
   * unless explicitly cleared or a new signal is created for the same scope.
   */
  async suppressMarketSignal(id: string): Promise<void> {
    await this.storage.updateMarketSignalStatus(id, "suppressed", new Date());
  }

  /**
   * Return current active/cooling signals with evidence payload.
   */
  async getActiveMarketSignals(filters?: MarketSignalFilters): Promise<MarketSignal[]> {
    return this.storage.getActiveMarketSignals(filters ?? {});
  }

  /**
   * Return full signal detail by id.
   */
  async getMarketSignalById(id: string): Promise<MarketSignal | undefined> {
    return this.storage.getMarketSignalById(id);
  }
}
