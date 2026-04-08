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

// ── Types ─────────────────────────────────────────────────────────────────────

export type Phase1RuleType =
  | "load_decline"
  | "single_thread_risk"
  | "stale_account"
  | "overdue_next_action"
  | "spot_to_contract"
  | "rfp_coverage_gap"
  | "stalled_award_lanes"
  | "recurring_lane_capacity";

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
  financialRows: Array<{ month: string; loads: number }>;
  latestUploadAgeDays: number | null;  // null = no uploads
  daysSinceLastTouch: number | null;
  lastTouchDate: string | null;
  hasRevenue: boolean;
}

async function gatherPhase1Signals(
  company: Company,
  orgId: string,
  userId: string,
  storage: IStorage,
  uploads: FinancialUpload[],
  allAwards: Award[],
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

  const financialRows: Array<{ month: string; loads: number }> = [];
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
      const loads = Number(row.totalLoads ?? 0);
      const existing = financialRows.find(r => r.month === month);
      if (existing) { existing.loads += loads; }
      else { financialRows.push({ month, loads }); }
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
  };
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
    urgencyScore: daysSinceLastTouch,
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
  if ((s as any).hasOpenRfp) {
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
): CardCandidate {
  const origin = `${lane.origin}${lane.originState ? ", " + lane.originState : ""}`;
  const dest = `${lane.destination}${lane.destinationState ? ", " + lane.destinationState : ""}`;
  const avgLoads = lane.avgLoadsPerWeek ?? "2+";
  const tier = accountTier(company);
  const confidence: "high" | "medium" = lane.eligibilityConfidence === "high" ? "high" : "medium";

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
): LaneCapacityCardSpec[] {
  if (!flagEnabled) return [];

  const companyMap = new Map(allCompanies.map(c => [c.id, c]));
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const eligible = recurringLanes.filter(l => {
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

    for (const lane of lanes) {
      const ownerUserId = lane.ownerUserId ?? company.assignedTo;
      const candidate = buildLaneCapacityCandidate(company, lane, lanes.length);
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
): Promise<CompanyEvalResult> {
  const signals = await gatherPhase1Signals(company, orgId, userId, storage, uploads, allAwards);

  // Inject open-RFP signal (gathered outside at batch level for efficiency)
  (signals as any).hasOpenRfp = openRfpCompanyIds.has(company.id);

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
        ).then(result => ({ userId: company.assignedTo!, result }))
      )
    );
    companyResults.push(...batchResults);
  }

  // R12: generate one card per eligible lane × owner user (separate from company-level cards)
  const laneCapacitySpecs = generateLaneCapacityCards(allCompanies, recurringLanes, laneFeatureEnabled);

  return { companyResults, laneCapacitySpecs };
}
