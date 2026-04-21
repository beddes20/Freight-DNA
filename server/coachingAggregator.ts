/**
 * Manager Coaching Mode (Task #301) — aggregator service.
 *
 * Given a manager user ID + week range, returns a structured Coaching Card
 * payload per direct report by querying existing DNA signals (momentum
 * bands, touchpoints/sentiment, NBA cards, play_runs from the Playbook
 * module, response-time gaps, promotion-readiness composite).
 */
import { and, desc, eq, inArray, gte, sql } from "drizzle-orm";
import { db } from "./storage";
import {
  users,
  companies,
  touchpoints,
  accountGrowthScores,
  plays,
  playRuns,
  nbaCards,
  type User,
  type Company,
  type Touchpoint,
  type AccountGrowthScore,
  type Play,
  type PlayRun,
} from "@shared/schema";

// ── Types ──────────────────────────────────────────────────────────────────
export interface CoachingCardItem {
  subjectKind:
    | "account_risk"
    | "play_not_run"
    | "flagged_call"
    | "response_outlier"
    | "promotion_ready";
  subjectId: string | null;
  title: string;
  detail: string;
  severity: "info" | "watch" | "urgent";
  href?: string;
  meta?: Record<string, unknown>;
}

export interface CoachingCard {
  rep: { id: string; name: string; email: string; role: string };
  accountsAtRisk: CoachingCardItem[];
  playsNotRun: CoachingCardItem[];
  flaggedCalls: CoachingCardItem[];
  responseOutliers: CoachingCardItem[];
  promotionReady: CoachingCardItem | null;
  tenureDays: number;
  activeAccounts: number;
  weekStart: string;
  weekEnd: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function daysBetween(a: string | Date, b: string | Date): number {
  const toTs = (x: string | Date) => {
    if (x instanceof Date) return x.getTime();
    return new Date(x.length === 10 ? x + "T12:00:00Z" : x).getTime();
  };
  return Math.floor(Math.abs(toTs(a) - toTs(b)) / 86_400_000);
}

/** Monday-anchored ISO week-start YYYY-MM-DD. */
export function mondayOf(d: Date = new Date()): string {
  const copy = new Date(d);
  const day = copy.getUTCDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1 - day);
  copy.setUTCDate(copy.getUTCDate() + diff);
  return copy.toISOString().slice(0, 10);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Per-rep aggregation ────────────────────────────────────────────────────
async function buildCardForRep(
  rep: User,
  weekStart: string,
  weekEnd: string,
  orgId: string,
): Promise<CoachingCard> {
  // Scope: rep's accounts
  const repCompanies: Company[] = await db
    .select()
    .from(companies)
    .where(and(
      eq(companies.organizationId, orgId),
      sql`${companies.archivedAt} is null`,
      sql`(${companies.assignedTo} = ${rep.id} or ${companies.salesPersonId} = ${rep.id})`,
    ));
  const companyIds = repCompanies.map(c => c.id);
  const companyById = new Map(repCompanies.map(c => [c.id, c] as const));

  // All recent (past 30d) touchpoints for rep's accounts
  const thirtyAgo = addDays(weekStart, -23); // weekStart back 23 = ~30 days before weekEnd
  const recentTps: Touchpoint[] = companyIds.length === 0 ? [] : await db
    .select()
    .from(touchpoints)
    .where(and(
      inArray(touchpoints.companyId, companyIds),
      gte(touchpoints.date, thirtyAgo),
    ));

  // Latest growth score per account
  const latestScores: AccountGrowthScore[] = companyIds.length === 0 ? [] : await db
    .select()
    .from(accountGrowthScores)
    .where(inArray(accountGrowthScores.companyId, companyIds))
    .orderBy(desc(accountGrowthScores.calculatedAt));
  const latestByCompany = new Map<string, AccountGrowthScore>();
  for (const s of latestScores) {
    if (!latestByCompany.has(s.companyId)) latestByCompany.set(s.companyId, s);
  }

  // ── Accounts at risk: band=at_risk OR band dropped OR overdue meaningful
  const lastMeaningfulByCompany = new Map<string, string>();
  for (const tp of recentTps) {
    if (!tp.isMeaningful) continue;
    const prev = lastMeaningfulByCompany.get(tp.companyId);
    if (!prev || tp.date > prev) lastMeaningfulByCompany.set(tp.companyId, tp.date);
  }
  const accountsAtRisk: CoachingCardItem[] = [];
  for (const c of repCompanies) {
    const score = latestByCompany.get(c.id);
    const bandDropped = !!score?.previousBand && score.band !== score.previousBand &&
      (score.previousBand === "high_expansion" || score.previousBand === "growth_ready") &&
      (score.band === "stable" || score.band === "at_risk");
    const atRisk = score?.band === "at_risk";
    const lastMeaningful = lastMeaningfulByCompany.get(c.id);
    const daysSince = lastMeaningful ? daysBetween(lastMeaningful, new Date()) : 9999;
    const overdue = daysSince > 21;
    if (!atRisk && !bandDropped && !overdue) continue;
    const reasons: string[] = [];
    if (atRisk) reasons.push(`score ${score?.score ?? "?"} (at risk)`);
    if (bandDropped) reasons.push(`${score!.previousBand} → ${score!.band}`);
    if (overdue) reasons.push(lastMeaningful ? `last meaningful ${daysSince}d ago` : "no meaningful touches");
    accountsAtRisk.push({
      subjectKind: "account_risk",
      subjectId: c.id,
      title: c.name,
      detail: reasons.join(" • "),
      severity: atRisk ? "urgent" : bandDropped ? "urgent" : "watch",
      href: `/companies/${c.id}`,
      meta: { score: score?.score, band: score?.band, previousBand: score?.previousBand, daysSince },
    });
  }
  accountsAtRisk.sort((a, b) => {
    const w = (s: string) => (s === "urgent" ? 0 : s === "watch" ? 1 : 2);
    return w(a.severity) - w(b.severity);
  });
  const topAccountsAtRisk = accountsAtRisk.slice(0, 3);

  // ── Plays the rep should have run but didn't
  // Heuristic: play_runs suggested for this rep in the week, still in status=suggested at weekEnd
  const weekStartDt = new Date(weekStart + "T00:00:00Z");
  const weekEndDt = new Date(weekEnd + "T23:59:59Z");
  const suggestedRuns: PlayRun[] = await db
    .select()
    .from(playRuns)
    .where(and(
      eq(playRuns.orgId, orgId),
      eq(playRuns.repUserId, rep.id),
      gte(playRuns.suggestedAt, weekStartDt),
    ));
  const openRuns = suggestedRuns.filter(r =>
    r.status === "suggested" && new Date(r.suggestedAt) <= weekEndDt
  );
  const playIds = Array.from(new Set(openRuns.map(r => r.playId)));
  const playRows: Play[] = playIds.length === 0 ? [] : await db
    .select().from(plays).where(inArray(plays.id, playIds));
  const playById = new Map(playRows.map(p => [p.id, p] as const));
  const playsNotRun: CoachingCardItem[] = openRuns.slice(0, 5).map(r => {
    const p = playById.get(r.playId);
    const acct = r.accountName || (r.accountId ? companyById.get(r.accountId)?.name : null) || "Account";
    return {
      subjectKind: "play_not_run",
      subjectId: r.id,
      title: p?.name || "Suggested play",
      detail: `${acct} • trigger: ${p?.triggerType || "manual"} • suggested ${new Date(r.suggestedAt).toISOString().slice(0, 10)}`,
      severity: "watch" as const,
      href: r.accountId ? `/companies/${r.accountId}` : "/playbook",
      meta: { playId: r.playId, runId: r.id, triggerSnapshot: r.triggerSnapshot ?? null },
    };
  });

  // ── Calls flagged for coaching: negative-sentiment call touchpoints on at-risk accounts
  const atRiskIds = new Set(topAccountsAtRisk.map(a => a.subjectId!));
  const callTps = recentTps
    .filter(t => (t.type === "call" || t.type === "phone") && t.sentiment === "negative")
    .filter(t => atRiskIds.has(t.companyId) || latestByCompany.get(t.companyId)?.band === "at_risk")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  const flaggedCalls: CoachingCardItem[] = callTps.map(t => ({
    subjectKind: "flagged_call",
    subjectId: t.id,
    title: `Call with ${companyById.get(t.companyId)?.name || "account"} — ${t.date}`,
    detail: (t.notes || "Negative-sentiment call flagged.").slice(0, 180),
    severity: "urgent",
    href: `/companies/${t.companyId}`,
    meta: { touchpointId: t.id, companyId: t.companyId, playLabel: t.playLabel },
  }));

  // ── Response-time outliers: accounts where gap between rep-logged touches >14d within 30d window
  const tpsByCompany = new Map<string, Touchpoint[]>();
  for (const tp of recentTps) {
    if (tp.loggedById !== rep.id) continue;
    const arr = tpsByCompany.get(tp.companyId) || [];
    arr.push(tp);
    tpsByCompany.set(tp.companyId, arr);
  }
  const responseOutliers: CoachingCardItem[] = [];
  for (const [cid, tps] of tpsByCompany.entries()) {
    tps.sort((a, b) => a.date.localeCompare(b.date));
    let maxGap = 0;
    for (let i = 1; i < tps.length; i++) {
      const gap = daysBetween(tps[i - 1].date, tps[i].date);
      if (gap > maxGap) maxGap = gap;
    }
    if (maxGap >= 14) {
      responseOutliers.push({
        subjectKind: "response_outlier",
        subjectId: cid,
        title: companyById.get(cid)?.name || "Account",
        detail: `${maxGap}d gap between rep-logged touches`,
        severity: maxGap >= 21 ? "urgent" : "watch",
        href: `/companies/${cid}`,
        meta: { maxGapDays: maxGap },
      });
    }
  }
  responseOutliers.sort((a, b) => ((b.meta?.maxGapDays as number) || 0) - ((a.meta?.maxGapDays as number) || 0));

  // ── Promotion readiness composite
  // Signals: >=3 accounts with band = growth_ready/high_expansion, >=90d tenure,
  // avg score uplift positive (current > previous), <2 at_risk accounts.
  const tenureDays = rep.createdAt
    ? daysBetween(rep.createdAt, new Date())
    : 9999;
  let readyAccounts = 0;
  let upliftSum = 0;
  let upliftCount = 0;
  let atRiskCount = 0;
  for (const c of repCompanies) {
    const s = latestByCompany.get(c.id);
    if (!s) continue;
    if (s.band === "growth_ready" || s.band === "high_expansion") readyAccounts++;
    if (s.band === "at_risk") atRiskCount++;
    if (typeof s.previousScore === "number") {
      upliftSum += s.score - s.previousScore;
      upliftCount++;
    }
  }
  const avgUplift = upliftCount > 0 ? upliftSum / upliftCount : 0;
  const promotionReady: CoachingCardItem | null =
    (readyAccounts >= 3 && tenureDays >= 90 && avgUplift > 0 && atRiskCount < 2)
      ? {
          subjectKind: "promotion_ready",
          subjectId: rep.id,
          title: `${rep.name.split(" ")[0]} shows promotion-readiness signals`,
          detail: `${readyAccounts} growth-ready accounts • +${avgUplift.toFixed(1)} avg score uplift • ${tenureDays}d tenure • ${atRiskCount} at-risk`,
          severity: "info",
          href: `/rep-scorecard?rep=${rep.id}`,
          meta: { readyAccounts, avgUplift, tenureDays, atRiskCount },
        }
      : null;

  return {
    rep: { id: rep.id, name: rep.name, email: (rep as any).email || rep.username, role: rep.role },
    accountsAtRisk: topAccountsAtRisk,
    playsNotRun,
    flaggedCalls,
    responseOutliers: responseOutliers.slice(0, 5),
    promotionReady,
    tenureDays,
    activeAccounts: repCompanies.length,
    weekStart,
    weekEnd,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────
export async function getDirectReports(managerId: string, orgId: string): Promise<User[]> {
  const rows = await db.select().from(users).where(and(
    eq(users.organizationId, orgId),
    eq(users.managerId, managerId),
  ));
  return rows;
}

export async function buildCoachingCards(
  managerId: string,
  orgId: string,
  weekStart?: string,
): Promise<CoachingCard[]> {
  const start = weekStart || mondayOf(new Date());
  const end = addDays(start, 6);
  const directs = await getDirectReports(managerId, orgId);
  const cards: CoachingCard[] = [];
  for (const rep of directs) {
    try {
      cards.push(await buildCardForRep(rep, start, end, orgId));
    } catch (err) {
      console.warn("[coaching-aggregator] rep card failed:", rep.id, err);
    }
  }
  return cards;
}

export async function buildCoachingCardForRep(
  repId: string,
  orgId: string,
  weekStart?: string,
): Promise<CoachingCard | null> {
  const start = weekStart || mondayOf(new Date());
  const end = addDays(start, 6);
  const [rep] = await db.select().from(users).where(and(
    eq(users.id, repId), eq(users.organizationId, orgId),
  ));
  if (!rep) return null;
  return buildCardForRep(rep, start, end, orgId);
}
