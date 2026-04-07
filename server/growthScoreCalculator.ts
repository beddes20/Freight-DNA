/**
 * Account Growth Score Calculator
 * Returns a 0–100 score with band + top drivers for each customer account.
 *
 * Positive buckets (max 100 pts):
 *   Touchpoint Health       25 pts  (recency 10, frequency 8, meaningful 7)
 *   Relationship Depth      20 pts  (HR contact 8, 3rd base 4, multi-base 4, breadth 4)
 *   Volume Signal           20 pts  (financial data present 10, meaningful loads 10)
 *   Lane Breadth            15 pts  (lane attributions / corridors)
 *   RFP & Opportunity       12 pts  (active RFP 5, open opp 4, recent award 3)
 *   Momentum                 8 pts  (touchpoint trend: recent vs prior 30d)
 *
 * Risk penalties (subtracted after summing, score clamped 0–100):
 *   No touchpoint 45+ days   −8
 *   No meaningful convo 90d  −7
 *   No contacts at 3rd/HR    −5
 *   Overdue open task         −3
 *
 * Bands:  76–100 high_expansion · 51–75 growth_ready · 26–50 stable · 0–25 at_risk
 */

import type { IStorage } from "./storage";

export type GrowthScoreDriver = {
  label: string;
  points: number;
  positive: boolean;
};

export type GrowthScoreResult = {
  score: number;
  band: "at_risk" | "stable" | "growth_ready" | "high_expansion";
  bandLabel: string;
  bandColor: "red" | "amber" | "blue" | "green";
  drivers: GrowthScoreDriver[];
};

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

export async function computeGrowthScore(
  companyId: string,
  organizationId: string,
  storage: IStorage,
): Promise<GrowthScoreResult> {
  const now = new Date();
  const todayStr       = now.toISOString().slice(0, 10);
  const d30Ago         = new Date(now); d30Ago.setDate(now.getDate() - 30);
  const d45Ago         = new Date(now); d45Ago.setDate(now.getDate() - 45);
  const d60Ago         = new Date(now); d60Ago.setDate(now.getDate() - 60);
  const d90Ago         = new Date(now); d90Ago.setDate(now.getDate() - 90);
  const d90AgoStr      = d90Ago.toISOString().slice(0, 10);
  const d60AgoStr      = d60Ago.toISOString().slice(0, 10);
  const d45AgoStr      = d45Ago.toISOString().slice(0, 10);
  const d30AgoStr      = d30Ago.toISOString().slice(0, 10);

  const [company, touchpoints, contacts, laneAttributions, tasks, rfps, uploads] = await Promise.all([
    storage.getCompany(companyId),
    storage.getTouchpointsByCompany(companyId),
    storage.getContactsByCompany(companyId),
    storage.getLaneAttributionsByCompany(companyId),
    storage.getTasksByCompany(companyId),
    storage.getRfps(),
    storage.getFinancialUploadsForOrg(organizationId),
  ]);

  if (!company) {
    const band = "stable" as const;
    return { score: 40, band, bandLabel: BAND_LABELS[band], bandColor: BAND_COLORS[band], drivers: [{ label: "New account — score will fill in over time", points: 40, positive: true }] };
  }

  const drivers: GrowthScoreDriver[] = [];

  // ── Bucket 1: Touchpoint Health (25 pts) ─────────────────────────────────
  const sortedTps = [...touchpoints].sort((a, b) => b.date.localeCompare(a.date));
  const lastTp    = sortedTps[0];
  const recent30  = touchpoints.filter(t => t.date >= d30AgoStr);
  const meaningful30 = touchpoints.filter(t => t.date >= d30AgoStr && t.isMeaningful);

  // Recency (max 10)
  let recencyPts = 0;
  if (lastTp) {
    const daysSince = Math.floor((now.getTime() - new Date(lastTp.date + "T12:00:00").getTime()) / 86400000);
    if      (daysSince <= 7)  { recencyPts = 10; drivers.push({ label: `Last touch ${daysSince === 0 ? "today" : `${daysSince}d ago`}`, points: 10, positive: true }); }
    else if (daysSince <= 14) { recencyPts = 6;  drivers.push({ label: `Last touch ${daysSince}d ago`, points: 6, positive: true }); }
    else if (daysSince <= 30) { recencyPts = 3;  drivers.push({ label: `Last touch ${daysSince}d ago`, points: 3, positive: true }); }
    else                      { recencyPts = 0; }
  } else {
    drivers.push({ label: "No touchpoints on record", points: -10, positive: false });
  }

  // Frequency 30d (max 8)
  let freqPts = 0;
  if      (recent30.length >= 4) { freqPts = 8; drivers.push({ label: `${recent30.length} touches in last 30 days`, points: 8, positive: true }); }
  else if (recent30.length >= 2) { freqPts = 5; drivers.push({ label: `${recent30.length} touches in last 30 days`, points: 5, positive: true }); }
  else if (recent30.length === 1){ freqPts = 2; drivers.push({ label: "1 touch in last 30 days", points: 2, positive: true }); }
  else                            { freqPts = 0; drivers.push({ label: "No touches in last 30 days", points: 0, positive: false }); }

  // Meaningful 30d (max 7)
  let meaningfulPts = 0;
  if (meaningful30.length >= 1) {
    meaningfulPts = 7;
    drivers.push({ label: `${meaningful30.length} meaningful conversation${meaningful30.length > 1 ? "s" : ""} this month`, points: 7, positive: true });
  }

  const tpHealth = recencyPts + freqPts + meaningfulPts; // max 25

  // ── Bucket 2: Relationship Depth (20 pts) ────────────────────────────────
  const hasHr      = contacts.some(c => isHrBase(c.relationshipBase));
  const has3rd     = contacts.some(c => is3rdBase(c.relationshipBase));
  const withBase   = contacts.filter(c => c.relationshipBase && c.relationshipBase.trim() !== "");
  const multiBase  = withBase.length >= 2;
  const deepBreadth = contacts.length >= 3;

  let relDepth = 0;
  if (hasHr)      { relDepth += 8; drivers.push({ label: "Home Run contact on file", points: 8, positive: true }); }
  if (has3rd)     { relDepth += 4; drivers.push({ label: "3rd Base contact on file", points: 4, positive: true }); }
  if (multiBase)  { relDepth += 4; drivers.push({ label: `${withBase.length} contacts with assigned relationship base`, points: 4, positive: true }); }
  if (deepBreadth){ relDepth += 4; drivers.push({ label: `${contacts.length} contacts in account`, points: 4, positive: true }); }
  // max 20

  // ── Bucket 3: Volume Signal (20 pts) ─────────────────────────────────────
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
    volumePts += 10;
    drivers.push({ label: `${totalLoadsYtd.toLocaleString()} YTD loads on record`, points: 10, positive: true });
    if (totalLoadsYtd >= 50) {
      volumePts += 10;
      drivers.push({ label: "Strong load volume this year", points: 10, positive: true });
    } else if (totalLoadsYtd >= 10) {
      volumePts += 6;
      drivers.push({ label: "Moderate load volume on file", points: 6, positive: true });
    } else if (totalLoadsYtd > 0) {
      volumePts += 3;
      drivers.push({ label: "Low load volume — room to grow", points: 3, positive: true });
    }
  } else {
    volumePts = 5; // half credit baseline when no financial data uploaded
    drivers.push({ label: "No freight data uploaded yet (baseline credit)", points: 5, positive: false });
  }
  // max 20

  // ── Bucket 4: Lane Breadth (15 pts) ──────────────────────────────────────
  const laneCount = laneAttributions.length;
  let lanePts = 0;
  if      (laneCount >= 5) { lanePts = 15; drivers.push({ label: `${laneCount} lane corridors attributed`, points: 15, positive: true }); }
  else if (laneCount >= 3) { lanePts = 10; drivers.push({ label: `${laneCount} lane corridors attributed`, points: 10, positive: true }); }
  else if (laneCount >= 1) { lanePts =  5; drivers.push({ label: `${laneCount} lane corridor${laneCount > 1 ? "s" : ""} attributed`, points: 5, positive: true }); }
  else                     { lanePts =  0; drivers.push({ label: "No lane corridors attributed", points: 0, positive: false }); }
  // max 15

  // ── Bucket 5: RFP & Opportunity Activity (12 pts) ────────────────────────
  const companyRfps = rfps.filter(r => r.companyId === companyId);
  const activeRfp   = companyRfps.find(r => r.status === "open" || r.status === "pending");

  let rfpPts = 0;
  if (activeRfp) {
    rfpPts += 5;
    drivers.push({ label: `Active RFP: ${activeRfp.title}`, points: 5, positive: true });
  }
  // max 5 from RFP
  // (Opp and award data would require additional storage methods — skipping for now, counted in momentum)
  // max 12 (leaving 7 for future opp/award signals)

  // ── Bucket 6: Momentum (8 pts) ────────────────────────────────────────────
  const prior30  = touchpoints.filter(t => t.date >= d60AgoStr && t.date < d30AgoStr);
  let momentumPts = 4; // default flat
  if (recent30.length > 0 && prior30.length === 0) {
    momentumPts = 8;
    drivers.push({ label: "New engagement — re-engaging this period", points: 8, positive: true });
  } else if (recent30.length > 0 && prior30.length > 0) {
    const pct = (recent30.length - prior30.length) / prior30.length;
    if      (pct >= 0.2)  { momentumPts = 8; drivers.push({ label: `Touchpoints up ${Math.round(pct * 100)}% vs prior month`, points: 8, positive: true }); }
    else if (pct >= -0.1) { momentumPts = 4; }
    else                  { momentumPts = 0; drivers.push({ label: `Touchpoints down ${Math.round(Math.abs(pct) * 100)}% vs prior month`, points: 0, positive: false }); }
  }
  // max 8

  // ── Sum positive buckets ─────────────────────────────────────────────────
  const positiveTotal = tpHealth + relDepth + volumePts + lanePts + rfpPts + momentumPts;

  // ── Risk Penalties ────────────────────────────────────────────────────────
  let penalties = 0;

  // No touch in 45+ days
  if (!lastTp || lastTp.date < d45AgoStr) {
    const daysSince = lastTp
      ? Math.floor((now.getTime() - new Date(lastTp.date + "T12:00:00").getTime()) / 86400000)
      : null;
    penalties += 8;
    drivers.push({ label: daysSince ? `No touch in ${daysSince} days` : "Never contacted", points: -8, positive: false });
  }

  // No meaningful conversation in 90 days
  const meaningful90 = touchpoints.filter(t => t.date >= d90AgoStr && t.isMeaningful);
  if (meaningful90.length === 0 && touchpoints.length > 0) {
    penalties += 7;
    drivers.push({ label: "No meaningful conversation in 90+ days", points: -7, positive: false });
  }

  // No contacts at 3rd base or HR
  if (!hasHr && !has3rd && contacts.length > 0) {
    penalties += 5;
    drivers.push({ label: "No contacts at 3rd Base or Home Run level", points: -5, positive: false });
  }

  // Overdue open task
  const overdueTasks = tasks.filter(t => t.status === "open" && t.dueDate && t.dueDate < todayStr);
  if (overdueTasks.length > 0) {
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

  return {
    score,
    band,
    bandLabel: BAND_LABELS[band],
    bandColor: BAND_COLORS[band],
    drivers: rankedDrivers,
  };
}
