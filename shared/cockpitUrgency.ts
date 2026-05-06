// Task #971 — Available Freight cockpit urgency scoring, lifted from
// server/routes/freightOpportunityCockpit.ts so the client can recompute
// `urgency.level` in place every 60s without a refetch.
//
// Pure function: no `server/` imports. The server route re-exports
// `computeCockpitUrgency` from here so existing callers continue to work
// (server/__tests__/freightOpportunityCockpit.test.ts, server/services/
// todayQueue.ts) while the AF page can import the same implementation.

export interface CockpitUrgencyInput {
  pickupAt: Date | string | null | undefined;
  generatedAt: Date | string | null | undefined;
  includedCarriers: number;
  sentCarriers: number;
  respondedCarriers: number;
  status: string;
  customerTier?: string | null;
  laneScore?: number | null;
  now?: Date;
}

export type CockpitUrgencyLevel = "critical" | "high" | "medium" | "low";

export interface CockpitUrgencyResult {
  score: number;
  level: CockpitUrgencyLevel;
  reasons: string[];
}

// Normalized 0-100 urgency: pickup-proximity x tier x lane-score, plus
// coverage/freshness bonuses. The math is intentionally identical to the
// previous server-only implementation so the client recompute can never
// disagree with the server at the same `now`.
export function computeCockpitUrgency(input: CockpitUrgencyInput): CockpitUrgencyResult {
  const now = input.now ?? new Date();
  const reasons: string[] = [];

  // 1) Pickup proximity — base signal (0–60).
  let pickupBase = 0;
  const pickup = input.pickupAt ? new Date(input.pickupAt) : null;
  if (pickup && Number.isFinite(pickup.getTime())) {
    const hours = (pickup.getTime() - now.getTime()) / 3_600_000;
    if (hours <= 12) { pickupBase = 60; reasons.push("pickup ≤ 12h"); }
    else if (hours <= 24) { pickupBase = 50; reasons.push("pickup ≤ 24h"); }
    else if (hours <= 48) { pickupBase = 35; reasons.push("pickup ≤ 48h"); }
    else if (hours <= 96) { pickupBase = 20; reasons.push("pickup ≤ 4d"); }
    else { pickupBase = 10; reasons.push("pickup > 4d"); }
  } else {
    pickupBase = 15;
    reasons.push("pickup unknown");
  }

  // 2) Customer-tier multiplier (0.85–1.30).
  const tierMultiplier = (() => {
    const t = (input.customerTier ?? "").toLowerCase();
    if (t === "platinum") { reasons.push("platinum customer"); return 1.30; }
    if (t === "gold")     { reasons.push("gold customer");      return 1.15; }
    if (t === "silver")   {                                      return 1.05; }
    if (t === "bronze")   {                                      return 0.95; }
    return 1.0;
  })();

  // 3) Lane-score multiplier (0.9–1.20).
  const laneMultiplier = (() => {
    if (input.laneScore === null || input.laneScore === undefined) return 1.0;
    if (input.laneScore >= 85) { reasons.push("top strategic lane"); return 1.20; }
    if (input.laneScore >= 65) { reasons.push("strong lane");        return 1.10; }
    if (input.laneScore >= 35) return 1.0;
    return 0.9;
  })();

  let score = pickupBase * tierMultiplier * laneMultiplier;

  // 4) Coverage gap (additive, up to 25 pts).
  if (input.respondedCarriers === 0 && input.sentCarriers === 0) {
    score += 25;
    reasons.push("no outreach yet");
  } else if (input.respondedCarriers === 0) {
    score += 15;
    reasons.push("awaiting reply");
  } else if (input.respondedCarriers < input.sentCarriers) {
    score += 8;
    reasons.push("partial replies");
  }

  // 5) Shortlist health (additive, up to 15 pts).
  if (input.includedCarriers === 0) {
    score += 15;
    reasons.push("no shortlist");
  } else if (input.includedCarriers < 3) {
    score += 7;
    reasons.push("thin shortlist");
  }

  // 6) Bonus for stale generatedAt (>4h with no replies).
  const generated = input.generatedAt ? new Date(input.generatedAt) : null;
  if (generated && Number.isFinite(generated.getTime())) {
    const ageH = (now.getTime() - generated.getTime()) / 3_600_000;
    if (ageH > 4 && input.respondedCarriers === 0) {
      score += 5;
      reasons.push("stale, no replies");
    }
  }

  // Covered/expired/cancelled rows are de-prioritized hard.
  if (input.status === "covered" || input.status === "expired" || input.status === "cancelled") {
    score = Math.min(score, 5);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level: CockpitUrgencyLevel =
    score >= 75 ? "critical" : score >= 55 ? "high" : score >= 30 ? "medium" : "low";
  return { score, level, reasons };
}
