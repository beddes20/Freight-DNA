/**
 * NBA Phase 1 Engine — Trust-First Freight Growth Recommendations
 *
 * Implements 6 high-confidence rules that generate persistent nba_cards.
 * Rules are evaluated per account; collision logic selects exactly ONE card per account.
 * All cards are written to the database — the UI reads from nba_cards, not from this engine directly.
 *
 * Rule priority (highest first):
 *   R1  Load Decline          Protect         financial monthly comparison
 *   R2  Single-Thread Risk    Protect·Deepen  1 contact + stale
 *   R3  Stale Account         Protect·Execute 21+ days no touch + revenue
 *   R5  Overdue Next Action   Execute         overdue task + contextual boosters
 *   R7  Spot-to-Contract      Execute·Grow    spotLoads > 0 + no awards
 *   R9  RFP Coverage Gap      Grow·Deepen     2+ uncovered high-volume RFP facilities + no recent touch
 *   R11 Stalled Award Lanes  Execute         award >= 30 days old + low/zero loads + no recent touch
 *
 * Analytics separation (locked spec):
 *   fired_count  = all generated cards including superseded/expired
 *   shown_count  = cards that reached "visible" status
 *   action_rate  = actioned / shown
 *   dismiss_rate = dismissed / shown
 */

import type { IStorage } from "./storage";
import type { Company, Contact, Touchpoint, Task, FinancialUpload, MarketShareEntry, Award, Rfp, RecurringLane } from "../shared/schema";
import { db } from "./storage";
import { loadFact } from "../shared/schema";
import { and, eq, gte, sql as dsql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Phase1RuleType =
  | "load_decline"
  | "single_thread_risk"
  | "stale_account"
  | "overdue_next_action"
  | "spot_to_contract"
  | "rfp_coverage_gap"
  | "stalled_award_lanes"
  | "recurring_lane_capacity"
  | "market_tightening"
  | "market_loosening"
  | "R_MARKET_TIGHT"
  | "R_MARKET_LOOSE"
  | "webex_missed_call"
  // ── Task #372: smarter targeting signals ──────────────────────────────────
  | "margin_slippage"
  | "rfp_expiring"
  | "win_back"
  | "lane_volume_drop"
  | "payment_credit_issue";

export type Phase1OutcomeType = "protect" | "execute" | "grow" | "deepen";

export interface CardCandidate {
  ruleType: Phase1RuleType;
  outcomeType: Phase1OutcomeType;
  confidence: "high" | "medium";
  signalCount: number;
  signalSummary: string[];
  whyThisNow: string;
  suggestedAction: string;
  expectedOutcome: string;
  growthLever?: string;
  relationshipMove?: string;
  accountTier: "A" | "B" | null;
  urgencyScore: number;          // days since signal threshold exceeded; for lane cards = laneScore
  contactId?: string;            // if rule is tied to a specific contact
  linkedTaskId?: string;         // for R5
  linkedLaneId?: string;         // for R12 recurring_lane_capacity
  // ── Task #372: at-stake $ + universal account/contact/lane linkage ────────
  /** $ impact estimate of the situation this card represents (USD). */
  atStakeAmount?: number;
  /** Short human-readable explanation of how atStakeAmount was derived. */
  atStakeBasis?: string;
  /** Resolved primary contact for the account (used for linkage chip + outreach). */
  primaryContactId?: string;
  /** Resolved primary recurring lane for the account (used for linkage chip + context). */
  primaryLaneId?: string;
}

export interface CompanyEvalResult {
  companyId: string;
  companyName: string;
  winner: CardCandidate | null;           // the one card to show
  superseded: CardCandidate[];            // all others (stored for diagnostics)
}

/** Emitted by the lane-capacity sub-engine — one entry per eligible lane × owner */
export interface LaneCapacityCardSpec {
  userId: string;
  companyId: string;
  companyName: string;
  laneId: string;
  candidate: CardCandidate;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  const then = new Date(dateStr + (dateStr.length === 10 ? "T12:00:00Z" : "")).getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function accountTier(company: Company): "A" | "B" | null {
  const spend = Number(company.estimatedFreightSpend ?? 0);
  if (spend >= 100_000) return "A";
  if (spend >= 25_000) return "B";
  return null;
}

/** Outcome type priority for collision sorting (lower = higher priority). */
const OUTCOME_RANK: Record<Phase1OutcomeType, number> = {
  protect: 1, execute: 2, grow: 3, deepen: 4,
};
const CONFIDENCE_RANK = { high: 1, medium: 2 };
const TIER_RANK: Record<string, number> = { A: 1, B: 2 };

function sortCandidates(candidates: CardCandidate[]): CardCandidate[] {
  return [...candidates].sort((a, b) => {
    const od = OUTCOME_RANK[a.outcomeType] - OUTCOME_RANK[b.outcomeType];
    if (od !== 0) return od;
    const cd = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (cd !== 0) return cd;
    const at = TIER_RANK[a.accountTier ?? "none"] ?? 3;
    const bt = TIER_RANK[b.accountTier ?? "none"] ?? 3;
    if (at !== bt) return at - bt;
    return b.urgencyScore - a.urgencyScore; // more urgent first
  });
}

// ── Signal gathering ──────────────────────────────────────────────────────────

interface Phase1Signals {
  company: Company;
  tier: "A" | "B" | null;
  contacts: Contact[];
  touchpoints: Touchpoint[];
  tasks: Task[];                 // all tasks for this company
  awards: Award[];
  marketShareEntries: MarketShareEntry[];
  /** Per-month aggregates for this company. margin/revenue = 0 when not present in upload schema. */
  financialRows: Array<{ month: string; loads: number; margin: number; revenue: number }>;
  latestUploadAgeDays: number | null;  // null = no uploads
  daysSinceLastTouch: number | null;
  lastTouchDate: string | null;
  hasRevenue: boolean;
  hasOpenRfp?: boolean;
  /** Recurring lanes for the account (used for primary-lane resolution). */
  companyLanes: RecurringLane[];
  /** Resolved primary contact (relationship-base ranked). */
  primaryContact: Contact | null;
  /** Resolved primary lane (highest laneScore among eligible). */
  primaryLane: RecurringLane | null;
}

/** Relationship-base rank — higher number = stronger primary contact candidate. */
function relationshipBaseRank(base: string | null | undefined): number {
  const b = (base ?? "").toLowerCase();
  if (b.includes("home")) return 5;
  if (b.includes("3rd")) return 4;
  if (b.includes("2nd")) return 3;
  if (b.includes("1st")) return 2;
  if (b.includes("on deck") || b.includes("on-deck")) return 1;
  return 0;
}

/** Pick a "primary" contact for an account: strongest relationship base, ties broken by name. */
function pickPrimaryContact(contacts: Contact[]): Contact | null {
  if (contacts.length === 0) return null;
  const sorted = [...contacts].sort((a, b) => {
    const r = relationshipBaseRank(b.relationshipBase) - relationshipBaseRank(a.relationshipBase);
    if (r !== 0) return r;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
  return sorted[0];
}

/** Pick a "primary" lane: highest laneScore among eligible non-snoozed lanes. */
function pickPrimaryLane(lanes: RecurringLane[]): RecurringLane | null {
  const today = new Date().toISOString().split("T")[0];
  const eligible = lanes.filter(l => l.isEligible !== false && (!l.snoozedUntil || l.snoozedUntil <= today));
  if (eligible.length === 0) return lanes[0] ?? null;
  return [...eligible].sort((a, b) => (b.laneScore ?? 0) - (a.laneScore ?? 0))[0];
}

async function gatherPhase1Signals(
  company: Company,
  orgId: string,
  userId: string,
  storage: IStorage,
  uploads: FinancialUpload[],
  allAwards: Award[],
  companyLanes: RecurringLane[] = [],
): Promise<Phase1Signals> {
  const [contacts, touchpoints, tasks, marketShareEntries] = await Promise.all([
    storage.getContactsByCompany(company.id),
    storage.getTouchpointsByCompany(company.id),
    storage.getTasksByCompany(company.id),
    storage.getMarketShareEntries(company.id),
  ]);

  // Touchpoint signals
  const sorted = [...touchpoints].sort((a, b) => b.date.localeCompare(a.date));
  const lastTouchDate = sorted[0]?.date ?? null;
  const daysSinceLastTouch = lastTouchDate ? daysSince(lastTouchDate) : null;

  // Awards for this company
  const awards = allAwards.filter(a => a.companyId === company.id);

  // Financial rows matching this company
  const crmNorm   = normName(company.name);
  const aliasNorms = company.financialAlias
    ? company.financialAlias.split(",").map((s: string) => normName(s.trim())).filter(Boolean)
    : [];

  const financialRows: Array<{ month: string; loads: number; margin: number; revenue: number }> = [];
  let latestUploadDate: string | null = null;

  for (const upload of uploads) {
    if (!latestUploadDate || upload.uploadedAt > latestUploadDate) {
      latestUploadDate = upload.uploadedAt;
    }
    const rows = (upload.rows as any[]) ?? [];
    for (const row of rows) {
      const cust = normName(String(row.customerName ?? ""));
      if (cust !== crmNorm && !aliasNorms.some((a: string) => cust === a)) continue;
      const month = String(row.month ?? "").slice(0, 7);
      if (!month) continue;
      const loads   = Number(row.totalLoads ?? 0);
      // Task #372: capture margin/revenue when upload schema includes them (graceful degradation).
      const margin  = Number(row.totalMargin  ?? row["Total Margin $"] ?? row["Margin $"] ?? 0) || 0;
      const revenue = Number(row.totalRevenue ?? row["Total revenue"]  ?? row["Total charges"] ?? 0) || 0;
      const existing = financialRows.find(r => r.month === month);
      if (existing) {
        existing.loads   += loads;
        existing.margin  += margin;
        existing.revenue += revenue;
      } else {
        financialRows.push({ month, loads, margin, revenue });
      }
    }
  }

  // Sort financial rows newest first
  financialRows.sort((a, b) => b.month.localeCompare(a.month));

  const latestUploadAgeDays = latestUploadDate ? daysSince(latestUploadDate) : null;

  const hasRevenue =
    Number(company.estimatedFreightSpend ?? 0) > 0 ||
    financialRows.some(r => r.loads > 0);

  return {
    company,
    tier: accountTier(company),
    contacts,
    touchpoints,
    tasks,
    awards,
    marketShareEntries,
    financialRows,
    latestUploadAgeDays,
    daysSinceLastTouch,
    lastTouchDate,
    hasRevenue,
    companyLanes,
    primaryContact: pickPrimaryContact(contacts),
    primaryLane: pickPrimaryLane(companyLanes),
  };
}

// ── Task #372: at-stake estimation helpers ───────────────────────────────────

/**
 * Estimate a sane monthly revenue figure for an account from any signal we have:
 *   1. Average of the last 3 months of margin-bearing upload rows (if revenue > 0)
 *   2. estimatedFreightSpend / 12
 *   3. 0 (caller must guard)
 */
function estimateMonthlyRevenue(s: Phase1Signals): number {
  const last3 = s.financialRows.slice(0, 3).filter(r => r.revenue > 0);
  if (last3.length > 0) {
    return last3.reduce((sum, r) => sum + r.revenue, 0) / last3.length;
  }
  const annual = Number(s.company.estimatedFreightSpend ?? 0);
  return annual > 0 ? annual / 12 : 0;
}

/** Estimate average margin per load for an account, falling back to a 12% margin assumption on revenue. */
function estimateMarginPerLoad(s: Phase1Signals): number {
  const rowsWithData = s.financialRows.filter(r => r.loads > 0 && r.margin > 0);
  if (rowsWithData.length > 0) {
    const totalMargin = rowsWithData.reduce((sum, r) => sum + r.margin, 0);
    const totalLoads  = rowsWithData.reduce((sum, r) => sum + r.loads,  0);
    if (totalLoads > 0) return totalMargin / totalLoads;
  }
  // Fallback: assume 12% margin on average load revenue (industry-typical brokerage margin)
  const monthly = estimateMonthlyRevenue(s);
  const monthlyLoads = s.financialRows[0]?.loads ?? 0;
  if (monthly > 0 && monthlyLoads > 0) return (monthly * 0.12) / monthlyLoads;
  return 0;
}

// ── Rule evaluation functions ─────────────────────────────────────────────────

/** R1 — Load Decline (Protect) */
function evalR1(s: Phase1Signals): CardCandidate | null {
  const { financialRows, latestUploadAgeDays, company, tier } = s;

  // Suppression: no financial data, or data too stale
  if (financialRows.length === 0) return null;
  if (latestUploadAgeDays !== null && latestUploadAgeDays > 45) return null;

  // Need at least 4 months of data (current + 3 prior)
  if (financialRows.length < 4) return null;

  const currentLoads = financialRows[0].loads;
  const prior3Avg = (financialRows[1].loads + financialRows[2].loads + financialRows[3].loads) / 3;

  // Suppression: too small a baseline for meaningful comparison
  if (prior3Avg < 5) return null;

  const pctDrop = prior3Avg > 0 ? ((prior3Avg - currentLoads) / prior3Avg) * 100 : 0;
  if (pctDrop < 20) return null;

  // Determine confidence
  const consecutiveDecline =
    financialRows.length >= 3 &&
    financialRows[0].loads < financialRows[1].loads &&
    financialRows[1].loads < financialRows[2].loads;

  const highConf = pctDrop >= 30 && consecutiveDecline && tier === "A";
  const confidence = highConf ? "high" : "medium";

  const signals: string[] = [
    `Loads dropped ${Math.round(pctDrop)}% vs. prior 3-month average (${Math.round(currentLoads)} vs avg ${Math.round(prior3Avg)})`,
    `Data as of ${financialRows[0].month}`,
  ];
  if (s.daysSinceLastTouch !== null) {
    signals.push(`Last touchpoint: ${s.daysSinceLastTouch} days ago`);
  }
  if (consecutiveDecline) {
    signals.push("Decline confirmed across multiple consecutive months");
  }

  // Task #372 — at-stake = est. monthly margin × % decline
  const monthlyMargin = (estimateMarginPerLoad(s) || 0) * prior3Avg;
  const atStakeAmount = monthlyMargin > 0 ? Math.round(monthlyMargin * (pctDrop / 100)) : 0;
  const atStakeBasis  = monthlyMargin > 0
    ? `${Math.round(prior3Avg)} loads/mo × $${Math.round(estimateMarginPerLoad(s))}/load margin × ${Math.round(pctDrop)}% drop`
    : "Margin data unavailable — estimate suppressed";

  return {
    ruleType: "load_decline",
    outcomeType: "protect",
    confidence,
    signalCount: signals.length,
    signalSummary: signals,
    whyThisNow: `Loads at ${company.name} dropped ${Math.round(pctDrop)}% last month vs. your 3-month average. ${s.daysSinceLastTouch !== null ? `Last touchpoint was ${s.daysSinceLastTouch} days ago.` : "No touchpoint on record."}`,
    suggestedAction: `Call your key contact at ${company.name} this week — confirm the cause of the load drop before it compounds.`,
    expectedOutcome: "Identify root cause of load decline, restore communication cadence, and prevent further erosion.",
    accountTier: tier,
    urgencyScore: Math.round(pctDrop),
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? atStakeBasis : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/** R2 — Single-Thread Risk (Protect · Deepen) */
function evalR2(s: Phase1Signals): CardCandidate | null {
  const { contacts, daysSinceLastTouch, company, tier } = s;

  if (contacts.length !== 1) return null;
  if (daysSinceLastTouch === null || daysSinceLastTouch < 14) return null;

  const highConf = daysSinceLastTouch >= 21 && tier === "A";
  const confidence = highConf ? "high" : "medium";
  const contact = contacts[0];

  const signals: string[] = [
    `Only 1 contact mapped at ${company.name}: ${contact.name}`,
    `No touchpoint in ${daysSinceLastTouch} days`,
  ];
  if (tier) signals.push(`${tier}-tier account`);

  // Task #372 — at-stake = annual freight spend (full account at risk if sole contact leaves)
  const atStakeAmount = Math.round(Number(company.estimatedFreightSpend ?? 0));
  return {
    ruleType: "single_thread_risk",
    outcomeType: "protect",
    confidence,
    signalCount: signals.length,
    signalSummary: signals,
    whyThisNow: `${company.name} has only 1 mapped contact — ${contact.name} — and no touchpoint in ${daysSinceLastTouch} days. If ${contact.name.split(" ")[0]} leaves, this account has zero relationship coverage.`,
    suggestedAction: `Ask ${contact.name.split(" ")[0]} to introduce you to one other stakeholder at ${company.name} — logistics, finance, or operations.`,
    expectedOutcome: "Map a second contact to reduce key-person dependency and deepen overall account coverage.",
    accountTier: tier,
    urgencyScore: daysSinceLastTouch,
    contactId: contact.id,
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? `Annual freight spend at risk if sole contact (${contact.name}) departs` : undefined,
    primaryContactId: contact.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/** R3 — Stale Account (Protect · Execute) */
function evalR3(s: Phase1Signals): CardCandidate | null {
  const { daysSinceLastTouch, hasRevenue, company, tier, tasks } = s;

  if (!hasRevenue) return null;
  if (daysSinceLastTouch === null || daysSinceLastTouch < 21) return null;

  // Suppression: completely dormant (financialRows show 0 loads across all months)
  const totalLoads = s.financialRows.reduce((sum, r) => sum + r.loads, 0);
  if (s.financialRows.length > 0 && totalLoads === 0) return null;

  // High confidence: 30+ days AND A-tier AND no future task
  const today = new Date().toISOString().split("T")[0];
  const hasFutureTask = tasks.some(t => t.status === "open" && t.dueDate && t.dueDate >= today);
  const highConf = daysSinceLastTouch >= 30 && tier === "A" && !hasFutureTask;
  const confidence = highConf ? "high" : "medium";

  const lastContact = s.contacts.length > 0 ? s.contacts[0].name : null;
  const signals: string[] = [
    `No touchpoint in ${daysSinceLastTouch} days`,
    "Account has active revenue signal",
  ];
  if (tier) signals.push(`${tier}-tier account`);
  if (!hasFutureTask) signals.push("No upcoming action scheduled");

  // Task #372 — at-stake = ~one month of margin while account drifts dormant
  const monthlyMargin = (estimateMarginPerLoad(s) || 0) * (s.financialRows[0]?.loads ?? 0);
  const atStakeAmount = Math.round(monthlyMargin);
  return {
    ruleType: "stale_account",
    outcomeType: "protect",
    confidence,
    signalCount: signals.length,
    signalSummary: signals,
    whyThisNow: `No touchpoint logged at ${company.name} in ${daysSinceLastTouch} days.${lastContact ? ` Last known contact: ${lastContact}.` : ""}`,
    suggestedAction: `Log a touchpoint this week — call or email your main contact at ${company.name} to stay in cadence.`,
    expectedOutcome: "Re-establish contact, confirm account health, and reset the engagement clock.",
    accountTier: tier,
    // Task #372 — weighted no-touch: combine days × monthly revenue tier so
    // bigger / higher-margin accounts surface above smaller stale ones.
    urgencyScore: (() => {
      const monthlyRev = estimateMonthlyRevenue(s);
      const revBoost = monthlyRev >= 50_000 ? 30 : monthlyRev >= 10_000 ? 15 : monthlyRev >= 1_000 ? 5 : 0;
      const marginBoost = monthlyMargin >= 5_000 ? 15 : monthlyMargin >= 1_000 ? 5 : 0;
      return Math.min(200, daysSinceLastTouch + revBoost + marginBoost);
    })(),
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? "Approx. one month of margin at risk while account drifts" : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/** R5 — Overdue Next Action (Execute) */
function evalR5(s: Phase1Signals, userId: string): CardCandidate | null {
  const today = new Date().toISOString().split("T")[0];

  // Find the most overdue task assigned to this user
  const overdueTasks = s.tasks
    .filter(t =>
      t.assignedTo === userId &&
      t.status === "open" &&
      t.dueDate &&
      daysSince(t.dueDate) >= 7
    )
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1)); // oldest first

  if (overdueTasks.length === 0) return null;

  const task = overdueTasks[0];
  const daysOverdue = daysSince(task.dueDate!);
  const { company, tier } = s;

  // Count boosters
  let boosterCount = 0;
  const boosterSignals: string[] = [];

  // Booster 1: high-value account
  if (tier === "A" || tier === "B") {
    boosterCount++;
    boosterSignals.push(`${tier}-tier account`);
  }

  // Booster 2: company has an open RFP
  // (no direct storage here, but check via rfp data — approximated by checking if the tasks array has rfp-adjacent notes)
  // Use hasOpenRfp from signals — passed via the company + rfp check done in the runner
  if (s.hasOpenRfp) {
    boosterCount++;
    boosterSignals.push("Open RFP on this account");
  }

  // Booster 3: no touchpoint since task was created
  if (task.createdAt) {
    const tpSinceCreation = s.touchpoints.some(tp => tp.date >= task.createdAt.slice(0, 10));
    if (!tpSinceCreation) {
      boosterCount++;
      boosterSignals.push("No touchpoint since this action was created");
    }
  }

  // Suppress if 0 boosters
  if (boosterCount === 0) return null;

  const signalCount = 1 + boosterCount;
  const confidence = boosterCount >= 2 ? "high" : "medium";

  const signals: string[] = [
    `Next step overdue by ${daysOverdue} days: "${task.title}"`,
    ...boosterSignals,
  ];

  // Task #372 — at-stake = monthly margin scaled by overdue tier (commit slipping)
  const monthlyMargin = (estimateMarginPerLoad(s) || 0) * (s.financialRows[0]?.loads ?? 0);
  const atStakeAmount = monthlyMargin > 0 ? Math.round(monthlyMargin * Math.min(daysOverdue / 30, 1)) : 0;
  return {
    ruleType: "overdue_next_action",
    outcomeType: "execute",
    confidence,
    signalCount,
    signalSummary: signals,
    whyThisNow: `"${task.title}" at ${company.name} is ${daysOverdue} days overdue. ${boosterSignals.join(". ")}.`,
    suggestedAction: `Complete or update the overdue action for ${company.name}: "${task.title}"`,
    expectedOutcome: "Clear the overdue commitment and restore execution momentum on this account.",
    accountTier: tier,
    urgencyScore: daysOverdue,
    linkedTaskId: task.id,
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? `Monthly margin × ${Math.min(Math.round(daysOverdue / 30 * 100), 100)}% slippage from overdue action` : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/** R7 — Spot-to-Contract (Execute · Grow) */
function evalR7(s: Phase1Signals): CardCandidate | null {
  const { company, marketShareEntries, awards, latestUploadAgeDays, tier, contacts } = s;

  // Suppression: no market share data, or financial data too stale
  if (marketShareEntries.length === 0) return null;
  if (latestUploadAgeDays !== null && latestUploadAgeDays > 45) return null;

  // Sum spot loads from entries in last ~180 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  let totalSpotLoads = 0;
  for (const entry of marketShareEntries) {
    const entryDate = entry.periodEnd ?? entry.periodStart ?? entry.createdAt ?? "";
    if (entryDate >= cutoffStr) {
      totalSpotLoads += entry.spotLoads ?? 0;
    }
  }

  // Need > 2 spot loads to fire (3+ per spec)
  if (totalSpotLoads <= 2) return null;

  // Suppress if awards already exist (contracts in place)
  if (awards.length > 0) return null;

  // Determine confidence
  const hasFirstBaseContact = contacts.some(c => {
    const base = (c.relationshipBase ?? "").toLowerCase();
    return base.includes("1st") || base.includes("2nd") || base.includes("3rd") || base.includes("home");
  });
  const highConf = totalSpotLoads >= 6 && tier !== null && hasFirstBaseContact;
  const confidence = highConf ? "high" : "medium";

  const signals: string[] = [
    `${totalSpotLoads} spot loads recorded in last 180 days`,
    "No contract or award on file for this account",
  ];
  if (hasFirstBaseContact) signals.push("Relationship contact at 1st Base or higher exists");
  if (tier) signals.push(`${tier}-tier account`);

  // Task #372 — at-stake = annualized contracted-margin opportunity from spot conversion
  const marginPerLoad = estimateMarginPerLoad(s) || 0;
  const annualizedSpotLoads = totalSpotLoads * 2; // 180-day → annual extrapolation
  const atStakeAmount = marginPerLoad > 0 ? Math.round(marginPerLoad * annualizedSpotLoads) : 0;
  return {
    ruleType: "spot_to_contract",
    outcomeType: "execute",
    confidence,
    signalCount: signals.length,
    signalSummary: signals,
    whyThisNow: `${company.name} has moved ${totalSpotLoads} spot loads in the last 180 days with no contract in place. This is a clear Spot-to-Contract opportunity.`,
    suggestedAction: `Reach out to your contact at ${company.name} to discuss converting recurring spot volume into a contracted lane agreement.`,
    expectedOutcome: "Open a contract conversation, propose a lane agreement, and reduce their spot dependency.",
    growthLever: "Spot-to-Contract",
    relationshipMove: "Contract conversation; relationship advance to 2nd/3rd base",
    accountTier: tier,
    urgencyScore: totalSpotLoads,
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? `${annualizedSpotLoads} annualized loads × $${Math.round(marginPerLoad)}/load contracted margin` : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/** R9 — RFP Coverage Gap (Grow · Deepen)
 *
 * Fires when the company's RFP data contains 2+ uncovered high-volume facility
 * sites (no contact owns those locations) and the AM hasn't touched the account
 * in more than 7 days. Suppressed for trivial or low-volume gaps.
 */
function evalR9(s: Phase1Signals, companyRfps: Rfp[]): CardCandidate | null {
  const { contacts, daysSinceLastTouch, company, tier } = s;

  if (companyRfps.length === 0) return null;

  // Suppression: rep touched very recently — let current cadence play out
  if (daysSinceLastTouch !== null && daysSinceLastTouch <= 7) return null;

  // Build facility map from all RFPs for this company
  const facilityMap = new Map<string, { name: string; state: string; totalVolume: number }>();

  // Suppress gaps from closed or rejected RFPs — only active RFP data is actionable
  const activeRfps = companyRfps.filter(r => !r.status || r.status === "open" || r.status === "pending");
  if (activeRfps.length === 0) return null;

  for (const rfp of activeRfps) {
    const fd = rfp.fileData as { highVolumeLanes?: any[] } | null;
    if (!fd?.highVolumeLanes) continue;

    for (const lane of fd.highVolumeLanes) {
      const addFacility = (name: string, state: string) => {
        if (!name) return;
        const key = `${name.toLowerCase()}|${state.toLowerCase()}`;
        const existing = facilityMap.get(key);
        if (existing) {
          existing.totalVolume += lane.volume || 0;
        } else {
          facilityMap.set(key, { name, state, totalVolume: lane.volume || 0 });
        }
      };
      addFacility(lane.origin || "", lane.originState || "");
      addFacility(lane.destination || "", lane.destinationState || "");
    }
  }

  if (facilityMap.size === 0) return null;

  // Determine uncovered facilities using same string-match logic as the API route
  const uncovered: Array<{ name: string; state: string; totalVolume: number }> = [];

  for (const [, f] of facilityMap) {
    const fLow = f.name.toLowerCase();
    const sLow = f.state.toLowerCase();
    const fullLow = f.state ? `${fLow}, ${sLow}` : fLow;

    const covered = contacts.some(c => {
      const lanes = (c.lanes ?? []).map((l: string) => l.toLowerCase().trim());
      const regions = (c.regions ?? []).map((r: string) => r.toLowerCase().trim());
      return (
        lanes.some(l => l.includes(fLow) || fLow.includes(l) || l.includes(fullLow)) ||
        regions.some(r => r.includes(fLow) || fLow.includes(r) || (sLow.length >= 2 && r === sLow) || r.includes(fullLow))
      );
    });

    if (!covered && f.totalVolume > 0) uncovered.push(f);
  }

  // Suppression: fewer than 2 uncovered sites — not a meaningful pattern
  if (uncovered.length < 2) return null;

  uncovered.sort((a, b) => b.totalVolume - a.totalVolume);
  const topFacility = uncovered[0];

  // Suppression: top uncovered facility is low-volume — not worth a card
  if (topFacility.totalVolume < 100) return null;

  const totalVolume = uncovered.reduce((sum, f) => sum + f.totalVolume, 0);
  const facLabel = topFacility.state
    ? `${topFacility.name}, ${topFacility.state}`
    : topFacility.name;

  const confidence = (uncovered.length >= 4 || topFacility.totalVolume >= 500) ? "high" : "medium";

  // Task #372 — at-stake = uncovered annual loads × est. margin per load
  const marginPerLoad = estimateMarginPerLoad(s) || 0;
  const atStakeAmount = marginPerLoad > 0 ? Math.round(totalVolume * marginPerLoad) : 0;
  return {
    ruleType: "rfp_coverage_gap",
    outcomeType: "grow",
    confidence,
    signalCount: uncovered.length,
    signalSummary: [
      `${uncovered.length} uncovered facility sites in RFP data`,
      `Top gap: ${facLabel} (${topFacility.totalVolume.toLocaleString()} loads/yr)`,
      `${totalVolume.toLocaleString()} total loads/yr across uncovered sites`,
    ],
    whyThisNow: `${company.name}'s RFP data shows ${uncovered.length} facility sites with no assigned contacts — ${facLabel} alone represents ${topFacility.totalVolume.toLocaleString()} loads/yr of untapped relationship opportunity.`,
    suggestedAction: `Ask your existing contacts at ${company.name} for introductions at ${facLabel}. Map who owns inbound/outbound freight decisions at each uncovered site.`,
    expectedOutcome: "Add at least one contact per uncovered high-volume facility to build multi-thread coverage and reduce single-thread risk across the account's network.",
    growthLever: "network_expansion",
    relationshipMove: "intro_request",
    accountTier: tier,
    // null = never touched; treat as maximum urgency so these sort first within grow cards
    urgencyScore: daysSinceLastTouch ?? 999,
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? `${totalVolume.toLocaleString()} uncovered loads/yr × $${Math.round(marginPerLoad)}/load margin` : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/** R11 — Stalled Award Lanes (Execute)
 *
 * Fires when a company has an award that's old enough to have started shipping
 * (>= 30 days from awardDate) but the company's total recent loads (last 60 days)
 * are very low or zero — suggesting the awarded lanes haven't activated.
 *
 * Phase 1 constraint: uses company-level total loads as a proxy since lane-level
 * load data isn't normalized. Explicitly documented as an approximation.
 *
 * Suppression guards:
 *   - No awards on file → null
 *   - Rep touched within 7 days → let the cadence play out
 *   - All awards are too fresh (< 30 days) → null
 *   - All awards are very old (> 365 days) → likely expired/irrelevant
 *   - Company loads in last 60 days >= threshold → lanes are moving, not stalled
 */
function evalR11(s: Phase1Signals): CardCandidate | null {
  const { awards, daysSinceLastTouch, financialRows, company, tier } = s;

  if (awards.length === 0) return null;
  if (daysSinceLastTouch !== null && daysSinceLastTouch <= 7) return null;

  const now = Date.now();
  const MIN_AGE_DAYS = 30;
  const MAX_AGE_DAYS = 365;

  const activeAwards = awards.filter(a => {
    if (!a.awardDate) return false;
    const ageDays = Math.floor((now - new Date(a.awardDate).getTime()) / 86_400_000);
    return ageDays >= MIN_AGE_DAYS && ageDays <= MAX_AGE_DAYS;
  });

  if (activeAwards.length === 0) return null;

  // Find the most recent active award (primary signal)
  activeAwards.sort((a, b) => (b.awardDate ?? "").localeCompare(a.awardDate ?? ""));
  const primaryAward = activeAwards[0];
  const primaryAgeDays = Math.floor((now - new Date(primaryAward.awardDate!).getTime()) / 86_400_000);

  // Check company loads in last 60 days (proxy for "are lanes moving?")
  const STALL_LOAD_THRESHOLD = 5;
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const cutoffMonth = sixtyDaysAgo.toISOString().slice(0, 7);

  const recentLoads = financialRows
    .filter(r => r.month >= cutoffMonth)
    .reduce((sum, r) => sum + r.loads, 0);

  // Suppress: loads are healthy — award lanes appear to be moving
  if (recentLoads >= STALL_LOAD_THRESHOLD) return null;

  // Don't fire if we have no financial data at all — too uncertain
  // (we can't distinguish "lanes stalled" from "no data uploaded yet")
  if (financialRows.length === 0) return null;

  const laneList = (primaryAward.lanes ?? []).filter(Boolean);
  const laneCount = laneList.length;
  const topLane = laneList[0] ?? "the awarded lanes";
  const laneSnippet = laneCount > 1
    ? `${topLane} and ${laneCount - 1} other lane${laneCount - 1 !== 1 ? "s" : ""}`
    : topLane;

  const confidence = (primaryAgeDays >= 60 && tier !== null) ? "high" : "medium";

  // Task #372 — at-stake = award annual value (or proxy from monthly margin × 12)
  const awardExtras = primaryAward as Award & { annualValue?: number | string | null; value?: number | string | null };
  const awardValue = Number(awardExtras.annualValue ?? awardExtras.value ?? 0);
  const monthlyMargin = (estimateMarginPerLoad(s) || 0) * (s.financialRows[0]?.loads ?? 0);
  const atStakeAmount = awardValue > 0
    ? Math.round(awardValue)
    : (monthlyMargin > 0 ? Math.round(monthlyMargin * 12) : 0);
  const atStakeBasis = awardValue > 0
    ? `Awarded annual value not activating (${primaryAgeDays} days since award)`
    : (atStakeAmount > 0 ? "Annualized margin from un-activated award lanes" : "");
  return {
    ruleType: "stalled_award_lanes",
    outcomeType: "execute",
    confidence,
    signalCount: activeAwards.length + 1,
    signalSummary: [
      `Award "${primaryAward.title}" is ${primaryAgeDays} days old`,
      `${recentLoads} loads recorded in last 60 days (threshold: ${STALL_LOAD_THRESHOLD})`,
      `${activeAwards.length} active award${activeAwards.length !== 1 ? "s" : ""} on file`,
    ],
    whyThisNow: `${company.name} has an award from ${primaryAgeDays} days ago — "${primaryAward.title}" (${laneSnippet}) — but only ${recentLoads} load${recentLoads !== 1 ? "s" : ""} recorded in the last 60 days. Contracted lanes may not be activating as expected.`,
    suggestedAction: `Call your contact at ${company.name} to confirm which lanes are active, whether the tendering process is set up, and if there are any barriers to moving freight on the awarded corridors.`,
    expectedOutcome: "Unblock lane activation, confirm first-load timeline, and identify whether additional onboarding support is needed to convert the paper win into moving freight.",
    growthLever: "award_activation",
    relationshipMove: "Activation check-in; advance relationship trust",
    accountTier: tier,
    urgencyScore: primaryAgeDays, // older = more urgent
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? atStakeBasis : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

// ── Task #372 New Rules: Margin Slippage / RFP Expiring / Win-Back ──────────

/**
 * R-MARGIN-SLIPPAGE — fires when last-3-month margin/load trends down ≥10%
 * vs the prior 3 months on the same account. Requires margin data in upload rows.
 */
function evalRMarginSlippage(s: Phase1Signals): CardCandidate | null {
  const rows = s.financialRows.filter(r => r.loads > 0 && r.margin > 0);
  if (rows.length < 6) return null;

  const recent = rows.slice(0, 3);
  const prior  = rows.slice(3, 6);
  const recentLoads = recent.reduce((a, r) => a + r.loads, 0);
  const priorLoads  = prior.reduce((a, r) => a + r.loads, 0);
  if (recentLoads === 0 || priorLoads === 0) return null;

  const recentMpl = recent.reduce((a, r) => a + r.margin, 0) / recentLoads;
  const priorMpl  = prior.reduce((a, r) => a + r.margin, 0) / priorLoads;
  if (priorMpl <= 0) return null;

  const pctSlip = ((priorMpl - recentMpl) / priorMpl) * 100;
  if (pctSlip < 10) return null;

  const tier = s.tier;
  const confidence: "high" | "medium" = (pctSlip >= 20 && tier !== null) ? "high" : "medium";
  const monthlyMarginLoss = (priorMpl - recentMpl) * recentLoads;
  const annualLoss = Math.round(monthlyMarginLoss * 4); // recent block is 3 months → annualize

  return {
    ruleType: "margin_slippage",
    outcomeType: "execute",
    confidence,
    signalCount: 2,
    signalSummary: [
      `Margin/load trending down ${pctSlip.toFixed(1)}% vs prior 3-mo`,
      `Recent $${recentMpl.toFixed(0)}/load vs prior $${priorMpl.toFixed(0)}/load`,
    ],
    whyThisNow: `${s.company.name} margin per load has slipped ${pctSlip.toFixed(1)}% in the last 3 months ($${priorMpl.toFixed(0)} → $${recentMpl.toFixed(0)}/load). Re-pricing or carrier mix correction may be needed.`,
    suggestedAction: `Pull a lane-level margin breakdown for ${s.company.name}, identify which lanes are eroding, and queue a re-rate or carrier-substitution plan.`,
    expectedOutcome: "Restore margin per load on degrading lanes; protect annual brokerage profit.",
    growthLever: "margin_recovery",
    relationshipMove: "Internal pricing review + targeted re-rate conversation",
    accountTier: tier,
    urgencyScore: Math.min(100, Math.round(pctSlip * 2)),
    atStakeAmount: annualLoss > 0 ? annualLoss : undefined,
    atStakeBasis: annualLoss > 0 ? `Δ$${(priorMpl - recentMpl).toFixed(0)}/load × ${recentLoads} loads/3mo annualized` : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/**
 * R-RFP-EXPIRING — fires when an RFP for this account has a closeDate / dueDate
 * within the next 45 days (renewal window) OR an award is approaching its
 * effectiveEnd date.
 */
function evalRRfpExpiring(s: Phase1Signals, companyRfps: Rfp[]): CardCandidate | null {
  const now = Date.now();
  const horizon = now + 45 * 86_400_000;

  type RfpExtras = Rfp & { dueDate?: string | null; closeDate?: string | null; expiresAt?: string | null };
  type AwardExtras = Award & { effectiveEnd?: string | null; expiresAt?: string | null };
  const rfpExpiry = (r: RfpExtras): string | null =>
    r.dueDate ?? r.closeDate ?? r.expiresAt ?? null;
  const awardExpiry = (a: AwardExtras): string | null =>
    a.effectiveEnd ?? a.expiresAt ?? null;

  // Look at any RFP with an expiring/due date inside the window
  const expiringRfps = (companyRfps as RfpExtras[]).filter(r => {
    const d = rfpExpiry(r);
    if (!d) return false;
    const t = new Date(d).getTime();
    return Number.isFinite(t) && t >= now && t <= horizon;
  });

  // Or expiring awards
  const expiringAwards = (s.awards as AwardExtras[]).filter(a => {
    const d = awardExpiry(a);
    if (!d) return false;
    const t = new Date(d).getTime();
    return Number.isFinite(t) && t >= now && t <= horizon;
  });

  if (expiringRfps.length === 0 && expiringAwards.length === 0) return null;

  const target = expiringRfps[0] ?? expiringAwards[0];
  const targetDate = "dueDate" in target
    ? (rfpExpiry(target as RfpExtras) ?? "")
    : (awardExpiry(target as AwardExtras) ?? "");
  const daysOut = Math.max(1, Math.floor((new Date(targetDate).getTime() - now) / 86_400_000));

  const tier = s.tier;
  const confidence: "high" | "medium" = (daysOut <= 21 && tier !== null) ? "high" : "medium";

  const annualAt = Number(s.company.estimatedFreightSpend ?? 0) || (estimateMonthlyRevenue(s) * 12);
  const atStake = annualAt > 0 ? Math.round(annualAt) : undefined;

  return {
    ruleType: "rfp_expiring",
    outcomeType: "execute",
    confidence,
    signalCount: expiringRfps.length + expiringAwards.length,
    signalSummary: [
      `${expiringRfps.length} RFP / ${expiringAwards.length} award expiring in ≤45 days`,
      `Next event in ${daysOut} day${daysOut !== 1 ? "s" : ""}`,
    ],
    whyThisNow: `${s.company.name} has a contract / RFP event closing in ${daysOut} day${daysOut !== 1 ? "s" : ""}. Re-bid prep starts now or you risk losing the lanes.`,
    suggestedAction: `Pull historical performance for ${s.company.name}, prep updated rates, and book a renewal meeting before the window closes.`,
    expectedOutcome: "Defend or re-win existing volume on expiring contracts.",
    growthLever: "renewal_defense",
    relationshipMove: "Renewal meeting + value recap",
    accountTier: tier,
    urgencyScore: 100 - daysOut,
    atStakeAmount: atStake,
    atStakeBasis: atStake ? "Annual freight spend on expiring contract / RFP" : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/**
 * R-WIN-BACK — fires when a previously-active account (had loads in months 4-12 ago)
 * has had ZERO loads in the last 3 months. Lost-then-recoverable signal.
 */
function evalRWinBack(s: Phase1Signals): CardCandidate | null {
  if (s.financialRows.length < 4) return null;

  const recent3 = s.financialRows.slice(0, 3);
  const past = s.financialRows.slice(3, 12);
  const recentLoads = recent3.reduce((a, r) => a + r.loads, 0);
  const pastLoads   = past.reduce((a, r) => a + r.loads, 0);
  if (recentLoads !== 0) return null;
  if (pastLoads < 5) return null; // need a meaningful prior history

  const monthsActive = past.filter(r => r.loads > 0).length;
  if (monthsActive < 2) return null;

  const tier = s.tier;
  const confidence: "high" | "medium" = (pastLoads >= 30 && tier !== null) ? "high" : "medium";
  const avgMonthlyLoads = pastLoads / Math.max(1, monthsActive);
  const mpl = estimateMarginPerLoad(s) || 0;
  const annualOpp = Math.round(avgMonthlyLoads * 12 * mpl);

  return {
    ruleType: "win_back",
    outcomeType: "execute",
    confidence,
    signalCount: 2,
    signalSummary: [
      `0 loads in last 3 months`,
      `${pastLoads} loads across prior ${monthsActive} active months`,
    ],
    whyThisNow: `${s.company.name} ran ${pastLoads} loads earlier this year but has gone dark for 3 months. Win-back call window is now.`,
    suggestedAction: `Reach out to ${s.company.name} with a win-back offer: refreshed rates on their historical lanes and a quick "what changed?" conversation.`,
    expectedOutcome: "Reactivate a churned account and recapture historical volume.",
    growthLever: "win_back",
    relationshipMove: "Win-back call with refreshed pricing",
    accountTier: tier,
    urgencyScore: 80,
    atStakeAmount: annualOpp > 0 ? annualOpp : undefined,
    atStakeBasis: annualOpp > 0 ? `${avgMonthlyLoads.toFixed(1)} loads/mo historical × $${Math.round(mpl)}/load × 12mo` : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

/**
 * R-LANE-VOLUME-DROP — fires when a recurring lane's last-30-day load count
 * is ≥40% below its trailing 90-day average. Lane-level volume drop signal.
 */
function evalRLaneVolumeDrop(
  s: Phase1Signals,
  recentLaneLoads: Map<string, { last30: number; avg30Of90: number }>,
): CardCandidate | null {
  if (s.companyLanes.length === 0 || recentLaneLoads.size === 0) return null;

  // Find the worst-affected lane on this account
  let worstLane: RecurringLane | null = null;
  let worstPctDrop = 0;
  let worstLast30 = 0;
  let worstAvg = 0;
  for (const lane of s.companyLanes) {
    const m = recentLaneLoads.get(lane.id);
    if (!m || m.avg30Of90 < 4) continue; // need a meaningful baseline
    const pct = ((m.avg30Of90 - m.last30) / m.avg30Of90) * 100;
    if (pct >= 40 && pct > worstPctDrop) {
      worstPctDrop = pct;
      worstLane = lane;
      worstLast30 = m.last30;
      worstAvg = m.avg30Of90;
    }
  }
  if (!worstLane) return null;

  const tier = s.tier;
  const confidence: "high" | "medium" = (worstPctDrop >= 60 && tier !== null) ? "high" : "medium";
  const mpl = estimateMarginPerLoad(s) || 150;
  const monthlyMarginGap = (worstAvg - worstLast30) * mpl;
  const annualLoss = Math.round(monthlyMarginGap * 12);

  const origin = `${worstLane.origin}${worstLane.originState ? ", " + worstLane.originState : ""}`;
  const dest = `${worstLane.destination}${worstLane.destinationState ? ", " + worstLane.destinationState : ""}`;

  return {
    ruleType: "lane_volume_drop",
    outcomeType: "protect",
    confidence,
    signalCount: 2,
    signalSummary: [
      `${origin} → ${dest} loads down ${worstPctDrop.toFixed(0)}% vs trailing 90d`,
      `Last 30d: ${worstLast30.toFixed(0)} loads (baseline ${worstAvg.toFixed(0)}/mo)`,
    ],
    whyThisNow: `${s.company.name} volume on ${origin} → ${dest} has dropped ${worstPctDrop.toFixed(0)}% vs the trailing 90-day baseline. Find out what changed before it walks.`,
    suggestedAction: `Call your contact at ${s.company.name}: ask what's happening on the ${origin} → ${dest} lane and whether you can win the freight back.`,
    expectedOutcome: "Identify the root cause of the lane volume drop and protect or recover the freight.",
    growthLever: "lane_protect",
    relationshipMove: "Diagnostic call on a specific lane",
    accountTier: tier,
    urgencyScore: Math.min(100, Math.round(worstPctDrop)),
    atStakeAmount: annualLoss > 0 ? annualLoss : undefined,
    atStakeBasis: annualLoss > 0 ? `${(worstAvg - worstLast30).toFixed(0)} loads/mo gap × $${Math.round(mpl)}/load × 12mo` : undefined,
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: worstLane.id,
  };
}

/**
 * R-PAYMENT-CREDIT — fires when an account is flagged with a credit / payment issue.
 * Reads optional company.creditStatus / creditHold / arDaysPastDue fields when present
 * and gracefully no-ops when none of those signals are available (acceptance: graceful skip).
 */
function evalRPaymentCredit(s: Phase1Signals): CardCandidate | null {
  const co = s.company as Company & {
    creditStatus?: string | null;
    creditHold?: boolean | null;
    arDaysPastDue?: number | null;
    arBalancePastDue?: number | string | null;
  };
  const status = (co.creditStatus ?? "").toLowerCase();
  const hold = co.creditHold === true;
  const dpd = Number(co.arDaysPastDue ?? 0) || 0;
  const balance = Number(co.arBalancePastDue ?? 0) || 0;

  const isFlagged = hold || status === "hold" || status === "flagged" || dpd >= 30;
  if (!isFlagged) return null;

  const tier = s.tier;
  const confidence: "high" | "medium" = (dpd >= 60 || hold) ? "high" : "medium";
  const atStake = balance > 0
    ? Math.round(balance)
    : (Number(s.company.estimatedFreightSpend ?? 0) > 0
        ? Math.round(Number(s.company.estimatedFreightSpend) * 0.1)
        : undefined);

  return {
    ruleType: "payment_credit_issue",
    outcomeType: "protect",
    confidence,
    signalCount: [hold, status, dpd, balance].filter(Boolean).length || 1,
    signalSummary: [
      hold ? "Credit hold flagged" : (status ? `Credit status: ${co.creditStatus}` : null),
      dpd > 0 ? `${dpd} days past due` : null,
      balance > 0 ? `$${Math.round(balance)} past-due balance` : null,
    ].filter(Boolean) as string[],
    whyThisNow: `${s.company.name} has a payment / credit issue${hold ? " (credit hold active)" : dpd ? ` (${dpd} days past due)` : ""}. New loads can't move until this clears.`,
    suggestedAction: `Loop in finance for ${s.company.name} and reach out to your primary contact to surface the issue and get a path to clear the hold.`,
    expectedOutcome: "Resolve credit / payment block to keep freight moving and protect future revenue.",
    growthLever: "credit_protect",
    relationshipMove: "Joint AM + Finance outreach",
    accountTier: tier,
    urgencyScore: Math.min(100, 50 + dpd),
    atStakeAmount: atStake,
    atStakeBasis: balance > 0 ? "Past-due AR balance" : (atStake ? "10% of annual freight spend (estimated exposure)" : undefined),
    primaryContactId: s.primaryContact?.id,
    primaryLaneId: s.primaryLane?.id,
  };
}

// ── R13: Market Tightening (Grow) ────────────────────────────────────────────

/**
 * R13 — Market Tightening
 *
 * Fires when the company has active recurring lanes AND the Sonar VOTRI WoW delta
 * for those lanes averages >= +2.5 pp (market is getting tighter).
 * This is a growth signal: carriers are rejecting more — capacity is shrinking,
 * which means our customer needs a reliable broker more than ever.
 *
 * votriWoWAvg is injected by the caller from the pre-computed Sonar batch.
 */
export function evalR13MarketTightening(
  company: Company,
  tier: "A" | "B" | null,
  votriWoWAvg: number,
  laneSummary: string,
  laneCount: number = 1,
  primaryContactId?: string | null,
  primaryLaneId?: string | null,
): CardCandidate | null {
  if (votriWoWAvg < 2.5) return null;

  const confidence: "high" | "medium" = votriWoWAvg >= 5 && tier !== null ? "high" : "medium";

  const topCorridor = laneSummary.split(",")[0].trim();
  const topMarket = topCorridor.split("→")[0].trim();
  return {
    ruleType: "R_MARKET_TIGHT",
    outcomeType: "execute",
    confidence,
    signalCount: 2,
    signalSummary: [
      `Market tightening in ${topMarket} (+${votriWoWAvg.toFixed(1)} pts this week)`,
      `Active corridors: ${laneSummary}`,
    ],
    whyThisNow: `Market tightening in ${topMarket} (+${votriWoWAvg.toFixed(1)}pts this week) — ${laneCount > 1 ? `${laneCount} of this account's corridors are at risk` : `${topCorridor} is at risk`}. Lock in capacity and reach out about rate protection.`,
    suggestedAction: `Call ${company.name} now — position Value Truck as their committed capacity source while the market tightens. Lock in coverage before competitor brokers reach out.`,
    expectedOutcome: "Protect existing volume and lock in contract commitment before spot rates spike further.",
    growthLever: "R_MARKET_TIGHT",
    relationshipMove: "Proactive capacity assurance call",
    accountTier: tier,
    urgencyScore: Math.round(votriWoWAvg * 10),
    // Task #372 — at-stake = est. annual freight spend exposed to the tightening corridor (proportional)
    atStakeAmount: (() => {
      const annual = Number(company.estimatedFreightSpend ?? 0);
      if (!annual) return undefined;
      // Cap proportional exposure at 100% of annual; min 5% to acknowledge corridor scope
      const exposure = Math.min(1, Math.max(0.05, votriWoWAvg / 10));
      return Math.round(annual * exposure);
    })(),
    atStakeBasis: company.estimatedFreightSpend ? "Annual freight spend × tightening exposure on active corridors" : undefined,
    primaryContactId: primaryContactId ?? undefined,
    primaryLaneId: primaryLaneId ?? undefined,
  };
}

// ── R14: Market Loosening (Grow) ─────────────────────────────────────────────

/**
 * R14 — Market Loosening
 *
 * Fires when the Sonar VOTRI WoW delta for the company's lanes averages <= -2.5 pp
 * (market is loosening — capacity increasing, rates softening).
 * Grow signal: use improving leverage to negotiate better rates, expand volume,
 * and deepen the relationship while shipper has market tailwind.
 */
export function evalR14MarketLoosening(
  company: Company,
  tier: "A" | "B" | null,
  votriWoWAvg: number,
  laneSummary: string,
  laneCount: number = 1,
  primaryContactId?: string | null,
  primaryLaneId?: string | null,
): CardCandidate | null {
  if (votriWoWAvg > -2.5) return null;

  const confidence: "high" | "medium" = votriWoWAvg <= -5 && tier !== null ? "high" : "medium";

  const topCorridor = laneSummary.split(",")[0].trim();
  const topMarket = topCorridor.split("→")[0].trim();
  return {
    ruleType: "R_MARKET_LOOSE",
    outcomeType: "grow",
    confidence,
    signalCount: 2,
    signalSummary: [
      `Market loosening in ${topMarket} (${Math.abs(votriWoWAvg).toFixed(1)} pts this week)`,
      `Active corridors: ${laneSummary}`,
    ],
    whyThisNow: `Market loosening in ${topMarket} (${Math.abs(votriWoWAvg).toFixed(1)}pts this week) — opportunity to offer rate relief and capture more share on ${laneCount > 1 ? `${laneCount} active corridors (${topCorridor} + more)` : topCorridor}.`,
    suggestedAction: `Contact ${company.name} with a market update. Use loosening conditions to negotiate expanded coverage, add new lanes, or grow share-of-wallet with favorable buy rates.`,
    expectedOutcome: "Grow active lane count and volume while market conditions favor the shipper.",
    growthLever: "R_MARKET_LOOSE",
    relationshipMove: "Market intel briefing + expansion conversation",
    accountTier: tier,
    urgencyScore: Math.round(Math.abs(votriWoWAvg) * 10),
    // Task #372 — at-stake = est. growth opportunity = annual spend × loosening upside
    atStakeAmount: (() => {
      const annual = Number(company.estimatedFreightSpend ?? 0);
      if (!annual) return undefined;
      const upside = Math.min(0.5, Math.max(0.05, Math.abs(votriWoWAvg) / 20));
      return Math.round(annual * upside);
    })(),
    atStakeBasis: company.estimatedFreightSpend ? "Share-of-wallet upside while market loosens" : undefined,
    primaryContactId: primaryContactId ?? undefined,
    primaryLaneId: primaryLaneId ?? undefined,
  };
}

// ── R12: Recurring Lane Capacity ─────────────────────────────────────────────

/**
 * Build a single CardCandidate for ONE specific recurring lane.
 * Used by generateLaneCapacityCards (one card per lane × owner user).
 */
function buildLaneCapacityCandidate(
  company: Company,
  lane: RecurringLane,
  allEligibleCount: number,
  primaryContact?: Contact | null,
): CardCandidate {
  const origin = `${lane.origin}${lane.originState ? ", " + lane.originState : ""}`;
  const dest = `${lane.destination}${lane.destinationState ? ", " + lane.destinationState : ""}`;
  const avgLoads = lane.avgLoadsPerWeek ?? "2+";
  const tier = accountTier(company);
  const confidence: "high" | "medium" = lane.eligibilityConfidence === "high" ? "high" : "medium";

  // Task #372 — at-stake = annual margin exposure on this lane (loads/wk × 50 wks × $/load)
  const avgLoadsNum = Number(typeof avgLoads === "string" ? parseFloat(avgLoads) : avgLoads) || 0;
  const annualLoads = avgLoadsNum * 50;
  // Lane-capacity is broker-side margin exposure. Use a conservative $150/load default
  // since per-account margin/load isn't readily available here.
  const marginPerLoad = 150;
  const atStakeAmount = annualLoads > 0 ? Math.round(annualLoads * marginPerLoad) : 0;

  return {
    ruleType: "recurring_lane_capacity",
    outcomeType: "execute",
    confidence,
    signalCount: allEligibleCount,
    signalSummary: [
      `${origin} → ${dest} (${lane.equipmentType ?? "any equipment"})`,
      `Avg ${avgLoads} loads/week · ${lane.weeksActive ?? 0}/${lane.lookbackWeeks ?? 4} weeks active`,
      `Lane score: ${lane.laneScore ?? "unscored"} · Confidence: ${lane.eligibilityConfidence}`,
    ],
    whyThisNow: `${company.name} is running freight on ${origin} → ${dest} averaging ${avgLoads} loads/week. No preferred carrier is locked in — building a bench now protects capacity and margin.`,
    suggestedAction: `Lock In Capacity on ${origin} → ${dest}: rank carriers, draft outreach emails, and build a bench for this recurring lane.`,
    expectedOutcome: "Secure committed carrier capacity on a high-frequency lane, reduce spot-rate exposure, and build toward a preferred-carrier program.",
    growthLever: "lane_capacity",
    relationshipMove: "Operational credibility — reliable capacity = trusted broker",
    accountTier: tier,
    // urgencyScore = laneScore so high-scoring lanes surface first in the panel
    urgencyScore: lane.laneScore ?? 0,
    linkedLaneId: lane.id,
    atStakeAmount: atStakeAmount > 0 ? atStakeAmount : undefined,
    atStakeBasis: atStakeAmount > 0 ? `${avgLoads} loads/week × 50 wks × ~$${marginPerLoad}/load broker margin exposure` : undefined,
    primaryContactId: primaryContact?.id,
    primaryLaneId: lane.id,
  };
}

/**
 * Generate one LaneCapacityCardSpec per eligible lane × owner user.
 * Called separately from per-company evaluation so each lane gets its own card.
 * Dedup key: laneId (not companyId), so multiple lanes per company each fire.
 */
export function generateLaneCapacityCards(
  allCompanies: Company[],
  recurringLanes: RecurringLane[],
  flagEnabled: boolean,
  /** Optional companyId → contacts map. When provided, the resolved primary contact
   * is attached to each lane card for universal account/contact/lane linkage (Task #372). */
  contactsByCompany?: Map<string, Contact[]>,
): LaneCapacityCardSpec[] {
  if (!flagEnabled) return [];

  const companyMap = new Map(allCompanies.map(c => [c.id, c]));
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const eligible = recurringLanes.filter(l => {
    // Belt-and-suspenders: caller should pass only isEligible=true lanes,
    // but guard here in case a zombie lane slips through from a partial engine run.
    if (l.isEligible === false) return false;
    // Permanently excluded if preferred program is set
    if (l.hasPreferredCarrierProgram) return false;
    // Eligible when not currently snoozed (resolvedAt is kept as historical marker only —
    // lanes re-enter evaluation automatically once snoozedUntil expires)
    return !l.snoozedUntil || l.snoozedUntil <= today;
  });

  const specs: LaneCapacityCardSpec[] = [];

  // Group by companyId to get allEligibleCount per company
  const byCompany = new Map<string, RecurringLane[]>();
  for (const lane of eligible) {
    if (!lane.companyId) continue;
    const arr = byCompany.get(lane.companyId) ?? [];
    arr.push(lane);
    byCompany.set(lane.companyId, arr);
  }

  for (const [companyId, lanes] of byCompany) {
    const company = companyMap.get(companyId);
    if (!company || !company.assignedTo) continue;

    const primaryContact = pickPrimaryContact(contactsByCompany?.get(companyId) ?? []);
    for (const lane of lanes) {
      const ownerUserId = lane.ownerUserId ?? company.assignedTo;
      const candidate = buildLaneCapacityCandidate(company, lane, lanes.length, primaryContact);
      // Emit one card per lane, assigned to the owner user only.
      // The overseer is visible via lane.overseerUserId in the outreach panel
      // so directors/admins still have full context without duplicate cards.
      specs.push({
        userId: ownerUserId,
        companyId,
        companyName: company.name,
        laneId: lane.id,
        candidate,
      });
    }
  }

  return specs;
}

/**
 * @deprecated R12 is no longer evaluated at the per-company level.
 * Lane capacity cards are now generated via generateLaneCapacityCards().
 * This stub is kept to avoid breaking the evaluateCompany function signature.
 */
function evalR12LaneCapacity(
  company: Company,
  companyLanes: RecurringLane[],
  flagEnabled: boolean,
): CardCandidate | null {
  // No longer generates cards from this path — handled by generateLaneCapacityCards()
  return null;
}

// ── Per-company evaluation ────────────────────────────────────────────────────

/**
 * Evaluates all Phase 1 rules for one company.
 * Returns the winner (top-ranked card) and all superseded candidates.
 */
export async function evaluateCompany(
  company: Company,
  orgId: string,
  userId: string,
  storage: IStorage,
  uploads: FinancialUpload[],
  allAwards: Award[],
  openRfpCompanyIds: Set<string>,
  allRfps: Rfp[] = [],
  companyLanesMap?: Map<string, RecurringLane[]>,
  laneFeatureEnabled?: boolean,
  laneVolumeMap?: Map<string, { last30: number; avg30Of90: number }>,
): Promise<CompanyEvalResult> {
  const companyLanesForSignals = companyLanesMap?.get(company.id) ?? [];
  const signals = await gatherPhase1Signals(company, orgId, userId, storage, uploads, allAwards, companyLanesForSignals);

  // Inject open-RFP signal (gathered outside at batch level for efficiency)
  signals.hasOpenRfp = openRfpCompanyIds.has(company.id);

  // Filter RFPs to this company for R9
  const companyRfps = allRfps.filter(r => r.companyId === company.id);

  // Evaluate rules in priority order
  const candidates: CardCandidate[] = [];

  const r1 = evalR1(signals);                   if (r1) candidates.push(r1);
  const r2 = evalR2(signals);                   if (r2) candidates.push(r2);
  const r3 = evalR3(signals);                   if (r3) candidates.push(r3);
  const r5 = evalR5(signals, userId);           if (r5) candidates.push(r5);
  const r7 = evalR7(signals);                   if (r7) candidates.push(r7);
  const r9 = evalR9(signals, companyRfps);      if (r9) candidates.push(r9);
  const r11 = evalR11(signals);                 if (r11) candidates.push(r11);
  // Task #372 new rules
  const rMargin   = evalRMarginSlippage(signals);                 if (rMargin) candidates.push(rMargin);
  const rRfpExp   = evalRRfpExpiring(signals, companyRfps);       if (rRfpExp) candidates.push(rRfpExp);
  const rWinBack  = evalRWinBack(signals);                        if (rWinBack) candidates.push(rWinBack);
  const rLaneVol  = laneVolumeMap ? evalRLaneVolumeDrop(signals, laneVolumeMap) : null; if (rLaneVol) candidates.push(rLaneVol);
  const rPayCred  = evalRPaymentCredit(signals);                  if (rPayCred) candidates.push(rPayCred);

  // R12: Recurring Lane Capacity
  const companyLanes = companyLanesMap?.get(company.id) ?? [];
  const r12 = evalR12LaneCapacity(company, companyLanes, laneFeatureEnabled ?? false);
  if (r12) candidates.push(r12);

  if (candidates.length === 0) {
    return { companyId: company.id, companyName: company.name, winner: null, superseded: [] };
  }

  // Apply collision sort
  const sorted = sortCandidates(candidates);
  const [winner, ...superseded] = sorted;

  return {
    companyId: company.id,
    companyName: company.name,
    winner,
    superseded,
  };
}

// ── Org-level runner ──────────────────────────────────────────────────────────

/**
 * Runs Phase 1 engine for all AM-assigned companies in an org.
 * Returns evaluation results per company (caller writes cards to DB).
 * Processes companies in controlled batches to avoid overwhelming the DB.
 */
export interface Phase1EngineOutput {
  /** One winner card per company/owner (all rules except R12) */
  companyResults: Array<{ userId: string; result: CompanyEvalResult }>;
  /** One card spec per eligible lane × owner user (R12 only) */
  laneCapacitySpecs: LaneCapacityCardSpec[];
}

export async function runPhase1EngineForOrg(
  orgId: string,
  storage: IStorage,
): Promise<Phase1EngineOutput> {
  // Fetch shared data once (expensive queries done once per org)
  const [allCompanies, uploads, allAwards, allRfps, recurringLanes, laneFeatureEnabled] = await Promise.all([
    storage.getCompanies(orgId),
    storage.getFinancialUploadsForOrg(orgId),
    storage.getAwards(),
    storage.getRfps(),
    storage.getEligibleRecurringLanes(orgId).catch(() => []),
    storage.getFeatureFlag(orgId, "lane_carrier_outreach_v1").catch(() => false),
  ]);

  // Build companyId → RecurringLane[] map (passed to evaluateCompany but R12 is now a no-op there)
  const companyLanesMap = new Map<string, RecurringLane[]>();
  for (const lane of recurringLanes) {
    if (!lane.companyId) continue;
    const existing = companyLanesMap.get(lane.companyId) ?? [];
    existing.push(lane);
    companyLanesMap.set(lane.companyId, existing);
  }

  // Task #372 — build laneId → recent volumes map for lane_volume_drop rule.
  // We aggregate load_fact pickups for the org over the last 90 days and
  // bucket them by (origin_state, destination_state, equipmentType) to match
  // recurring lanes. Failures are non-fatal so the engine still runs.
  const laneVolumeMap = new Map<string, { last30: number; avg30Of90: number }>();
  try {
    const today = new Date();
    const d90 = new Date(today.getTime() - 90 * 86400_000).toISOString().slice(0, 10);
    const d30 = new Date(today.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
    const rows = await db
      .select({
        companyId: loadFact.companyId,
        oState: loadFact.originState,
        dState: loadFact.destinationState,
        eq: loadFact.equipmentType,
        last30: dsql<number>`SUM(CASE WHEN ${loadFact.pickupDate} >= ${d30} THEN ${loadFact.loadCount} ELSE 0 END)::int`,
        last90: dsql<number>`SUM(${loadFact.loadCount})::int`,
      })
      .from(loadFact)
      .where(and(
        eq(loadFact.orgId, orgId),
        gte(loadFact.pickupDate, d90),
      ))
      .groupBy(loadFact.companyId, loadFact.originState, loadFact.destinationState, loadFact.equipmentType);

    // Index aggregates by composite key for O(1) lane lookup
    const key = (companyId: string | null, oState: string | null, dState: string | null, eq: string | null) =>
      `${companyId ?? ""}|${(oState ?? "").toUpperCase()}|${(dState ?? "").toUpperCase()}|${(eq ?? "").toUpperCase()}`;
    const agg = new Map<string, { last30: number; last90: number }>();
    for (const r of rows) {
      agg.set(key(r.companyId, r.oState, r.dState, r.eq), { last30: Number(r.last30) || 0, last90: Number(r.last90) || 0 });
    }
    for (const lane of recurringLanes) {
      const a = agg.get(key(lane.companyId, lane.originState ?? null, lane.destinationState ?? null, lane.equipmentType ?? null));
      if (!a) continue;
      // Trailing 90d monthly average vs the most recent 30d
      const avg30Of90 = a.last90 / 3;
      laneVolumeMap.set(lane.id, { last30: a.last30, avg30Of90 });
    }
  } catch (err) {
    console.warn("[nba/lane_volume_drop] aggregation skipped:", (err as Error).message);
  }

  // Build set of companyIds that have open RFPs (for R5 booster)
  const openRfpCompanyIds = new Set<string>(
    allRfps
      .filter(r => r.companyId && (r.status === "open" || r.status === "pending"))
      .map(r => r.companyId!)
  );

  // Filter org awards only (getAwards returns all)
  const orgAwards = allAwards.filter(a => {
    const co = allCompanies.find(c => c.id === a.companyId);
    return !!co;
  });

  // Exclude unowned, archived companies from engine evaluation
  const assigned = allCompanies.filter(c => c.assignedTo && c.organizationId === orgId && !c.archivedAt);

  const companyResults: Array<{ userId: string; result: CompanyEvalResult }> = [];

  // Process in batches of 10 to avoid parallel query overload
  const BATCH_SIZE = 10;
  for (let i = 0; i < assigned.length; i += BATCH_SIZE) {
    const batch = assigned.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(company =>
        evaluateCompany(
          company,
          orgId,
          company.assignedTo!,
          storage,
          uploads,
          orgAwards,
          openRfpCompanyIds,
          allRfps,
          companyLanesMap,
          laneFeatureEnabled,
          laneVolumeMap,
        ).then(result => ({ userId: company.assignedTo!, result }))
      )
    );
    companyResults.push(...batchResults);
  }

  // Build contacts map for lane-capacity cards (Task #372 — primary contact linkage)
  const contactsByCompany = new Map<string, Contact[]>();
  await Promise.all(
    Array.from(new Set(recurringLanes.map(l => l.companyId).filter(Boolean) as string[]))
      .map(async (cid) => {
        try {
          contactsByCompany.set(cid, await storage.getContactsByCompany(cid));
        } catch { /* non-fatal */ }
      })
  );

  // R12: generate one card per eligible lane × owner user (separate from company-level cards)
  const laneCapacitySpecs = generateLaneCapacityCards(allCompanies, recurringLanes, laneFeatureEnabled, contactsByCompany);

  return { companyResults, laneCapacitySpecs };
}
