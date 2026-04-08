/**
 * NBA Phase 1 Engine — Trust-First Freight Growth Recommendations
 *
 * Implements 5 high-confidence rules that generate persistent nba_cards.
 * Rules are evaluated per account; collision logic selects exactly ONE card per account.
 * All cards are written to the database — the UI reads from nba_cards, not from this engine directly.
 *
 * Rule priority (highest first):
 *   R1  Load Decline        Protect         financial monthly comparison
 *   R2  Single-Thread Risk  Protect·Deepen  1 contact + stale
 *   R3  Stale Account       Protect·Execute 21+ days no touch + revenue
 *   R5  Overdue Next Action Execute         overdue task + contextual boosters
 *   R7  Spot-to-Contract    Execute·Grow    spotLoads > 0 + no awards
 *
 * R9 (Contact Regression) is queued as fast-follow — not activated in Phase 1.
 *
 * Analytics separation (locked spec):
 *   fired_count  = all generated cards including superseded/expired
 *   shown_count  = cards that reached "visible" status
 *   action_rate  = actioned / shown
 *   dismiss_rate = dismissed / shown
 */

import type { IStorage } from "./storage";
import type { Company, Contact, Touchpoint, Task, FinancialUpload, MarketShareEntry, Award } from "../shared/schema";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Phase1RuleType =
  | "load_decline"
  | "single_thread_risk"
  | "stale_account"
  | "overdue_next_action"
  | "spot_to_contract";

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
  urgencyScore: number;          // days since signal threshold exceeded
  contactId?: string;            // if rule is tied to a specific contact
  linkedTaskId?: string;         // for R5
}

export interface CompanyEvalResult {
  companyId: string;
  companyName: string;
  winner: CardCandidate | null;           // the one card to show
  superseded: CardCandidate[];            // all others (stored for diagnostics)
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
): Promise<CompanyEvalResult> {
  const signals = await gatherPhase1Signals(company, orgId, userId, storage, uploads, allAwards);

  // Inject open-RFP signal (gathered outside at batch level for efficiency)
  (signals as any).hasOpenRfp = openRfpCompanyIds.has(company.id);

  // Evaluate rules in priority order
  const candidates: CardCandidate[] = [];

  const r1 = evalR1(signals);             if (r1) candidates.push(r1);
  const r2 = evalR2(signals);             if (r2) candidates.push(r2);
  const r3 = evalR3(signals);             if (r3) candidates.push(r3);
  const r5 = evalR5(signals, userId);     if (r5) candidates.push(r5);
  const r7 = evalR7(signals);             if (r7) candidates.push(r7);

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
export async function runPhase1EngineForOrg(
  orgId: string,
  storage: IStorage,
): Promise<Array<{ userId: string; result: CompanyEvalResult }>> {
  // Fetch shared data once (expensive queries done once per org)
  const [allCompanies, uploads, allAwards, allRfps] = await Promise.all([
    storage.getCompanies(orgId),
    storage.getFinancialUploadsForOrg(orgId),
    storage.getAwards(),
    storage.getRfps(),
  ]);

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

  // Exclude unowned, archived, and valubuaz-org companies from engine evaluation.
  const assigned = allCompanies.filter(c => c.assignedTo && c.organizationId === orgId && !c.archivedAt);

  const results: Array<{ userId: string; result: CompanyEvalResult }> = [];

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
        ).then(result => ({ userId: company.assignedTo!, result }))
      )
    );
    results.push(...batchResults);
  }

  return results;
}
