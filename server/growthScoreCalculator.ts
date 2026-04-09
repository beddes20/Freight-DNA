/**
 * Account Growth Score Calculator  (UI label: "Momentum Score")
 * Returns a 0–100 score with band + top drivers + structured breakdown.
 *
 * Positive buckets (max 100 pts):
 *   Touchpoint Health       40 pts  (BD recency 28, frequency 10BD 7, meaningful 30d 5)
 *   Relationship Depth      18 pts  (HR contact 8, 3rd base 4, multi-base 3, breadth 3)
 *   Volume Signal           12 pts  (financial data present 6, meaningful loads: ≥50=+6, 10–49=+4, 1–9=+2, baseline 3)
 *   Lane Breadth            10 pts  (≥5=10, ≥3=7, ≥1=3, 0=0)
 *   RFP & Opportunity        8 pts  (active RFP 5, reserved 3)
 *   Momentum                12 pts  (touch consistency 10BD 7, touch trend 5)
 *
 * Risk penalties (subtracted after summing, score clamped 0–100):
 *   No touch 3–6 business days     −4  (mutually exclusive with 7+ BD penalty)
 *   No touch 7+ business days      −10 (only heavier one applies, never both)
 *   No meaningful convo 90d        −7
 *   No contacts at 3rd/HR          −5
 *   Overdue open task               −3
 *
 * Bands:  76–100 high_expansion · 51–75 growth_ready · 26–50 stable · 0–25 at_risk
 */

import type { IStorage } from "./storage";

export type GrowthScoreDriver = {
  label: string;
  points: number;
  positive: boolean;
};

export type MomentumBreakdown = {
  touchpointHealth: {
    points: number;
    max: number;
    recency: { points: number; max: number; bdSinceLastTouch: number | null };
    frequency10BD: { points: number; max: number; count: number };
    meaningful30d: { points: number; max: number; count: number };
  };
  momentum: {
    points: number;
    max: number;
    current10BD: number;
    prior10BD: number;
    trendLabel: "up" | "flat" | "down" | "reengaging";
  };
  relationshipDepth: {
    points: number;
    max: number;
    hasHomeRun: boolean;
    hasThirdBase: boolean;
    multiBaseContacts: number;
    totalContacts: number;
  };
  volumeSignal: {
    points: number;
    max: number;
    hasFinancialData: boolean;
    ytdLoads: number;
  };
  laneBreadth: {
    points: number;
    max: number;
    corridorCount: number;
  };
  rfpOpportunity: {
    points: number;
    max: number;
    hasActiveRfp: boolean;
    rfpTitle: string | null;
  };
  penalties: {
    totalPenalty: number;
    staleTouchLight: number;
    staleTouchHeavy: number;
    noMeaningfulConversation90Days: number;
    noThirdOrHomeRun: number;
    overdueTask: number;
  };
};

export type GrowthScoreResult = {
  score: number;
  band: "at_risk" | "stable" | "growth_ready" | "high_expansion";
  bandLabel: string;
  bandColor: "red" | "amber" | "blue" | "green";
  drivers: GrowthScoreDriver[];
  breakdown: MomentumBreakdown;
};

// ── Business day utilities ────────────────────────────────────────────────────

/**
 * Count Monday–Friday business days between two YYYY-MM-DD strings.
 * Exclusive of fromDateStr, inclusive of toDateStr.
 * Returns a non-negative integer.
 */
export function businessDaysBetween(fromDateStr: string, toDateStr: string): number {
  const from = new Date(fromDateStr + "T12:00:00Z");
  const to   = new Date(toDateStr   + "T12:00:00Z");

  if (to <= from) return 0;

  let count = 0;
  const cursor = new Date(from);
  cursor.setUTCDate(cursor.getUTCDate() + 1); // exclusive of from

  while (cursor <= to) {
    const dow = cursor.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return count;
}

/**
 * How many business days ago was dateStr, relative to today (YYYY-MM-DD).
 * today defaults to the current UTC date if omitted.
 */
export function businessDaysAgo(dateStr: string, today?: string): number {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  return businessDaysBetween(dateStr, todayStr);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeName(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isHrBase(base: string | null | undefined): boolean {
  if (!base) return false;
  const n = normalizeName(base);
  return n.includes("homerun") || n === "hr" || n.includes("homerun") || n === "home";
}

function is3rdBase(base: string | null | undefined): boolean {
  if (!base) return false;
  const n = normalizeName(base);
  return n.includes("3rd") || n === "3rdbase";
}

function scoreToBand(score: number): GrowthScoreResult["band"] {
  if (score >= 76) return "high_expansion";
  if (score >= 51) return "growth_ready";
  if (score >= 26) return "stable";
  return "at_risk";
}

const BAND_LABELS: Record<GrowthScoreResult["band"], string> = {
  high_expansion: "Primed to Grow",
  growth_ready:   "Growth Ready",
  stable:         "Stable",
  at_risk:        "At Risk",
};

const BAND_COLORS: Record<GrowthScoreResult["band"], GrowthScoreResult["bandColor"]> = {
  high_expansion: "green",
  growth_ready:   "blue",
  stable:         "amber",
  at_risk:        "red",
};

function emptyBreakdown(): MomentumBreakdown {
  return {
    touchpointHealth: { points: 0, max: 40, recency: { points: 0, max: 28, bdSinceLastTouch: null }, frequency10BD: { points: 0, max: 7, count: 0 }, meaningful30d: { points: 0, max: 5, count: 0 } },
    momentum: { points: 0, max: 12, current10BD: 0, prior10BD: 0, trendLabel: "flat" },
    relationshipDepth: { points: 0, max: 18, hasHomeRun: false, hasThirdBase: false, multiBaseContacts: 0, totalContacts: 0 },
    volumeSignal: { points: 0, max: 12, hasFinancialData: false, ytdLoads: 0 },
    laneBreadth: { points: 0, max: 10, corridorCount: 0 },
    rfpOpportunity: { points: 0, max: 8, hasActiveRfp: false, rfpTitle: null },
    penalties: { totalPenalty: 0, staleTouchLight: 0, staleTouchHeavy: 0, noMeaningfulConversation90Days: 0, noThirdOrHomeRun: 0, overdueTask: 0 },
  };
}

export async function computeGrowthScore(
  companyId: string,
  organizationId: string,
  storage: IStorage,
): Promise<GrowthScoreResult> {
  const now = new Date();
  const todayStr  = now.toISOString().slice(0, 10);
  const d90Ago    = new Date(now); d90Ago.setDate(now.getDate() - 90);
  const d30Ago    = new Date(now); d30Ago.setDate(now.getDate() - 30);
  const d90AgoStr = d90Ago.toISOString().slice(0, 10);
  const d30AgoStr = d30Ago.toISOString().slice(0, 10);

  // getRfps and getFinancialUploadsForOrg are global / org-level queries.
  // If either fails (e.g. transient DB error), we fall back to empty arrays so
  // the touchpoint, relationship, and lane buckets — the most real-time signals —
  // are still computed correctly.
  const [company, touchpoints, contacts, laneAttributions, tasks, rfps, uploads] = await Promise.all([
    storage.getCompany(companyId),
    storage.getTouchpointsByCompany(companyId),
    storage.getContactsByCompany(companyId),
    storage.getLaneAttributionsByCompany(companyId),
    storage.getTasksByCompany(companyId),
    storage.getRfps().catch((err: unknown) => {
      console.error("[growthScore] getRfps fallback:", err);
      return [] as Awaited<ReturnType<typeof storage.getRfps>>;
    }),
    storage.getFinancialUploadsForOrg(organizationId).catch((err: unknown) => {
      console.error("[growthScore] getFinancialUploadsForOrg fallback:", err);
      return [] as Awaited<ReturnType<typeof storage.getFinancialUploadsForOrg>>;
    }),
  ]);

  if (!company) {
    const band = "stable" as const;
    const bd = emptyBreakdown();
    bd.touchpointHealth.points = 40;
    return {
      score: 40, band, bandLabel: BAND_LABELS[band], bandColor: BAND_COLORS[band],
      drivers: [{ label: "New account — score will fill in over time", points: 40, positive: true }],
      breakdown: bd,
    };
  }

  const drivers: GrowthScoreDriver[] = [];

  // ── Bucket 1: Touchpoint Health (40 pts) ─────────────────────────────────
  const sortedTps = [...touchpoints].sort((a, b) => b.date.localeCompare(a.date));
  const lastTp    = sortedTps[0];

  // Business-Day Recency (max 28 pts)
  // 0 BD=28, 1 BD=22, 2 BD=12, 3 BD=4, 4+ BD=0
  let recencyPts = 0;
  let bdSinceLastTouch: number | null = null;
  if (lastTp) {
    bdSinceLastTouch = businessDaysAgo(lastTp.date, todayStr);
    if      (bdSinceLastTouch === 0) { recencyPts = 28; drivers.push({ label: "Touched today", points: 28, positive: true }); }
    else if (bdSinceLastTouch === 1) { recencyPts = 22; drivers.push({ label: `Last touch ${bdSinceLastTouch} business day ago`, points: 22, positive: true }); }
    else if (bdSinceLastTouch === 2) { recencyPts = 12; drivers.push({ label: `Last touch ${bdSinceLastTouch} business days ago`, points: 12, positive: true }); }
    else if (bdSinceLastTouch === 3) { recencyPts =  4; drivers.push({ label: `Last touch ${bdSinceLastTouch} business days ago`, points: 4, positive: true }); }
    else                             { recencyPts =  0; }
  } else {
    drivers.push({ label: "No touchpoints on record", points: -10, positive: false });
  }

  // Frequency over last 10 business days (max 7 pts)
  // ≥8=7, ≥5=5, ≥2=2, <2=0
  // "Last 10 BDs" = business days 1..10 ago (exclusive of today)
  const tpsLast10BD = touchpoints.filter(t => {
    if (t.date > todayStr) return false;
    const bd = businessDaysAgo(t.date, todayStr);
    return bd >= 1 && bd <= 10;
  });
  let freqPts = 0;
  if      (tpsLast10BD.length >= 8) { freqPts = 7; drivers.push({ label: `${tpsLast10BD.length} touches in last 10 business days`, points: 7, positive: true }); }
  else if (tpsLast10BD.length >= 5) { freqPts = 5; drivers.push({ label: `${tpsLast10BD.length} touches in last 10 business days`, points: 5, positive: true }); }
  else if (tpsLast10BD.length >= 2) { freqPts = 2; drivers.push({ label: `${tpsLast10BD.length} touches in last 10 business days`, points: 2, positive: true }); }
  else                               { freqPts = 0; drivers.push({ label: "Fewer than 2 touches in last 10 business days", points: 0, positive: false }); }

  // Meaningful Conversation in 30 days (max 5 pts)
  const meaningful30 = touchpoints.filter(t => t.date >= d30AgoStr && t.isMeaningful);
  let meaningfulPts = 0;
  if (meaningful30.length >= 1) {
    meaningfulPts = 5;
    drivers.push({ label: `${meaningful30.length} meaningful conversation${meaningful30.length > 1 ? "s" : ""} this month`, points: 5, positive: true });
  }

  const tpHealth = recencyPts + freqPts + meaningfulPts; // max 40

  // ── Bucket 2: Relationship Depth (18 pts) ────────────────────────────────
  // Home Run=8, 3rd Base=4, multi-base=3, breadth=3
  const hasHr      = contacts.some(c => isHrBase(c.relationshipBase));
  const has3rd     = contacts.some(c => is3rdBase(c.relationshipBase));
  const withBase   = contacts.filter(c => c.relationshipBase && c.relationshipBase.trim() !== "");
  const multiBase  = withBase.length >= 2;
  const deepBreadth = contacts.length >= 3;

  let relDepth = 0;
  if (hasHr)      { relDepth += 8; drivers.push({ label: "Home Run contact on file", points: 8, positive: true }); }
  if (has3rd)     { relDepth += 4; drivers.push({ label: "3rd Base contact on file", points: 4, positive: true }); }
  if (multiBase)  { relDepth += 3; drivers.push({ label: `${withBase.length} contacts with assigned relationship base`, points: 3, positive: true }); }
  if (deepBreadth){ relDepth += 3; drivers.push({ label: `${contacts.length} contacts in account`, points: 3, positive: true }); }
  // max 18

  // ── Bucket 3: Volume Signal (12 pts) ─────────────────────────────────────
  // data present=6, ≥50 loads=+6, 10–49=+4, 1–9=+2, no data baseline=3
  const crmNorm    = normalizeName(company.name);
  const aliasNorms = company.financialAlias
    ? company.financialAlias.split(",").map((a: string) => normalizeName(a.trim())).filter(Boolean)
    : [];

  let totalLoadsYtd = 0;
  let hasFinancialData = false;
  for (const upload of uploads) {
    const rows = (upload.rows as any[]) || [];
    for (const row of rows) {
      const custName = normalizeName(String(row.customerName || ""));
      if (custName === crmNorm || aliasNorms.some((a: string) => custName === a)) {
        totalLoadsYtd += Number(row.totalLoads || 0);
        hasFinancialData = true;
      }
    }
  }

  let volumePts = 0;
  if (hasFinancialData) {
    volumePts += 6;
    drivers.push({ label: `${totalLoadsYtd.toLocaleString()} YTD loads on record`, points: 6, positive: true });
    if (totalLoadsYtd >= 50) {
      volumePts += 6;
      drivers.push({ label: "Strong load volume this year", points: 6, positive: true });
    } else if (totalLoadsYtd >= 10) {
      volumePts += 4;
      drivers.push({ label: "Moderate load volume on file", points: 4, positive: true });
    } else if (totalLoadsYtd > 0) {
      volumePts += 2;
      drivers.push({ label: "Low load volume — room to grow", points: 2, positive: true });
    }
  } else {
    volumePts = 3; // baseline when no financial data uploaded
    drivers.push({ label: "No freight data uploaded yet (baseline credit)", points: 3, positive: false });
  }
  // max 12

  // ── Bucket 4: Lane Breadth (10 pts) ──────────────────────────────────────
  // ≥5=10, ≥3=7, ≥1=3, 0=0
  const laneCount = laneAttributions.length;
  let lanePts = 0;
  if      (laneCount >= 5) { lanePts = 10; drivers.push({ label: `${laneCount} lane corridors attributed`, points: 10, positive: true }); }
  else if (laneCount >= 3) { lanePts =  7; drivers.push({ label: `${laneCount} lane corridors attributed`, points: 7, positive: true }); }
  else if (laneCount >= 1) { lanePts =  3; drivers.push({ label: `${laneCount} lane corridor${laneCount > 1 ? "s" : ""} attributed`, points: 3, positive: true }); }
  else                     { lanePts =  0; drivers.push({ label: "No lane corridors attributed", points: 0, positive: false }); }
  // max 10

  // ── Bucket 5: RFP & Opportunity Activity (8 pts) ─────────────────────────
  // active RFP=5, reserved=3
  const companyRfps = rfps.filter(r => r.companyId === companyId);
  const activeRfp   = companyRfps.find(r => r.status === "open" || r.status === "pending");

  let rfpPts = 0;
  if (activeRfp) {
    rfpPts += 5;
    drivers.push({ label: `Active RFP: ${activeRfp.title}`, points: 5, positive: true });
  }
  // max 5 from RFP; remaining 3 reserved for future opp/award signals
  // max 8

  // ── Bucket 6: Momentum (12 pts) ──────────────────────────────────────────
  // Sub-signal 1: Business-Day Touch Consistency over last 10 BDs (max 7 pts)
  // Count distinct business days (1..10 BDs ago) that had at least one touch
  const distinctBDsTouched = new Set<string>();
  for (const tp of touchpoints) {
    if (tp.date > todayStr) continue;
    const bd = businessDaysAgo(tp.date, todayStr);
    if (bd >= 1 && bd <= 10) {
      distinctBDsTouched.add(tp.date);
    }
  }
  const distinctBDCount = distinctBDsTouched.size;

  let consistencyPts = 0;
  if      (distinctBDCount >= 8) { consistencyPts = 7; drivers.push({ label: `Touches on ${distinctBDCount} distinct business days in last 10`, points: 7, positive: true }); }
  else if (distinctBDCount >= 5) { consistencyPts = 5; drivers.push({ label: `Touches on ${distinctBDCount} distinct business days in last 10`, points: 5, positive: true }); }
  else if (distinctBDCount >= 3) { consistencyPts = 2; drivers.push({ label: `Touches on ${distinctBDCount} distinct business days in last 10`, points: 2, positive: true }); }
  else                            { consistencyPts = 0; }

  // Sub-signal 2: Touch Trend comparing current 10 BDs vs prior 10 BDs (max 5 pts)
  // re-engaging or up≥20%=5, flat=3, down>10%=0
  // Current window: BDs 1..10 ago (same as tpsLast10BD)
  // Prior window: BDs 11..20 ago (symmetric 10-BD window)
  const tpsPrior10BD = touchpoints.filter(t => {
    if (t.date > todayStr) return false;
    const bd = businessDaysAgo(t.date, todayStr);
    return bd >= 11 && bd <= 20;
  });

  let trendPts = 0;
  let momentumTrendLabel: MomentumBreakdown["momentum"]["trendLabel"] = "flat";
  const currentCount = tpsLast10BD.length;
  const priorCount   = tpsPrior10BD.length;

  if (currentCount > 0 && priorCount === 0) {
    trendPts = 5;
    momentumTrendLabel = "reengaging";
    drivers.push({ label: "New engagement — re-engaging this period", points: 5, positive: true });
  } else if (currentCount > 0 && priorCount > 0) {
    const pct = (currentCount - priorCount) / priorCount;
    if      (pct >= 0.2)  { trendPts = 5; momentumTrendLabel = "up";   drivers.push({ label: `Touchpoints up ${Math.round(pct * 100)}% vs prior 10 business days`, points: 5, positive: true }); }
    else if (pct >= -0.1) { trendPts = 3; momentumTrendLabel = "flat"; }
    else                  { trendPts = 0; momentumTrendLabel = "down"; drivers.push({ label: `Touchpoints down ${Math.round(Math.abs(pct) * 100)}% vs prior 10 business days`, points: 0, positive: false }); }
  } else if (currentCount === 0 && priorCount > 0) {
    trendPts = 0;
    momentumTrendLabel = "down";
  }

  const momentumPts = consistencyPts + trendPts; // max 12

  // ── Sum positive buckets ─────────────────────────────────────────────────
  const positiveTotal = tpHealth + relDepth + volumePts + lanePts + rfpPts + momentumPts;

  // ── Risk Penalties ────────────────────────────────────────────────────────
  let penalties = 0;
  let penStaleTouchLight = 0;
  let penStaleTouchHeavy = 0;
  let penNoMeaningful90 = 0;
  let penNoThirdOrHR = 0;
  let penOverdueTask = 0;

  // Stale touch penalties (mutually exclusive — only the heavier one applies)
  if (lastTp) {
    const bdSinceTouch = bdSinceLastTouch!;
    if (bdSinceTouch >= 7) {
      penStaleTouchHeavy = 10;
      penalties += 10;
      drivers.push({ label: `No touch in ${bdSinceTouch} business days`, points: -10, positive: false });
    } else if (bdSinceTouch >= 3) {
      penStaleTouchLight = 4;
      penalties += 4;
      drivers.push({ label: `No touch in ${bdSinceTouch} business days`, points: -4, positive: false });
    }
  } else {
    penStaleTouchHeavy = 10;
    penalties += 10;
    drivers.push({ label: "Never contacted", points: -10, positive: false });
  }

  // No meaningful conversation in 90 days
  const meaningful90 = touchpoints.filter(t => t.date >= d90AgoStr && t.isMeaningful);
  if (meaningful90.length === 0 && touchpoints.length > 0) {
    penNoMeaningful90 = 7;
    penalties += 7;
    drivers.push({ label: "No meaningful conversation in 90+ days", points: -7, positive: false });
  }

  // No contacts at 3rd base or HR
  if (!hasHr && !has3rd && contacts.length > 0) {
    penNoThirdOrHR = 5;
    penalties += 5;
    drivers.push({ label: "No contacts at 3rd Base or Home Run level", points: -5, positive: false });
  }

  // Overdue open task
  const overdueTasks = tasks.filter(t => t.status === "open" && t.dueDate && t.dueDate < todayStr);
  if (overdueTasks.length > 0) {
    penOverdueTask = 3;
    penalties += 3;
    drivers.push({ label: `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`, points: -3, positive: false });
  }

  const rawScore = Math.max(0, Math.min(100, positiveTotal - penalties));
  const score    = Math.round(rawScore);
  const band     = scoreToBand(score);

  // Keep only the most impactful drivers (top 5 by absolute points, non-zero)
  const rankedDrivers = drivers
    .filter(d => d.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 5);

  const breakdown: MomentumBreakdown = {
    touchpointHealth: {
      points: tpHealth,
      max: 40,
      recency: { points: recencyPts, max: 28, bdSinceLastTouch },
      frequency10BD: { points: freqPts, max: 7, count: tpsLast10BD.length },
      meaningful30d: { points: meaningfulPts, max: 5, count: meaningful30.length },
    },
    momentum: {
      points: momentumPts,
      max: 12,
      current10BD: currentCount,
      prior10BD: priorCount,
      trendLabel: momentumTrendLabel,
    },
    relationshipDepth: {
      points: relDepth,
      max: 18,
      hasHomeRun: hasHr,
      hasThirdBase: has3rd,
      multiBaseContacts: withBase.length,
      totalContacts: contacts.length,
    },
    volumeSignal: {
      points: volumePts,
      max: 12,
      hasFinancialData,
      ytdLoads: totalLoadsYtd,
    },
    laneBreadth: {
      points: lanePts,
      max: 10,
      corridorCount: laneCount,
    },
    rfpOpportunity: {
      points: rfpPts,
      max: 8,
      hasActiveRfp: !!activeRfp,
      rfpTitle: activeRfp?.title ?? null,
    },
    penalties: {
      totalPenalty: -penalties,
      staleTouchLight: penStaleTouchLight,
      staleTouchHeavy: penStaleTouchHeavy,
      noMeaningfulConversation90Days: penNoMeaningful90,
      noThirdOrHomeRun: penNoThirdOrHR,
      overdueTask: penOverdueTask,
    },
  };

  return {
    score,
    band,
    bandLabel: BAND_LABELS[band],
    bandColor: BAND_COLORS[band],
    drivers: rankedDrivers,
    breakdown,
  };
}
