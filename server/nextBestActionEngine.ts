import { getPlayForRuleType } from "./playsRegistry";

/**
 * Next Best Action (NBA) Engine
 *
 * Evaluates per-account signals and returns the single most actionable next step.
 * Rules are checked in strict priority order — first match wins.
 * All signal values are exposed on the result for transparency and easy debugging.
 *
 * Rule priority table (R1 = highest):
 *  R1   Emergency save        critical   score dropped ≥15 pts AND band = at_risk
 *  R2   Re-engage dormant     critical   7+ business days since last touch
 *  R3   Escalate risk         high       band = at_risk AND 5+ business days no touch
 *  R4   Margin erosion        high       band = at_risk AND latest-month margin % < 5%   [partial]
 *  R5   Follow up open RFP    high       open RFP deadline ≤14d AND 7+ days no touch
 *  R6   Add stakeholder       moderate   <2 contacts with any relationship base AND growth band
 *  R7   Introduce new mode    moderate   high_expansion band AND <2 shipping modes on file
 *  R8   Explore new lanes     moderate   growth band AND <3 lane corridors attributed
 *  R9   Schedule QBR          high       no meaningful convo 60d AND loads ≥ 50 ytd      [partial]
 *  R10  Deepen key contact    moderate   a 1st-Base contact has not been touched in 30d+
 *  R11  Account plan          moderate   band newly elevated to growth_ready or higher
 *  R12  Cadence nudge         moderate   3+ business days since last touch (catch-all)
 *  R13  No action needed      none       fallback — all checks passed
 *
 * Partial rules (marked with [partial]):
 *   R4 and R9 require financial upload data. If no uploads are on file for the org,
 *   these rules are skipped and evaluation continues to the next rule.
 */

import type { IStorage } from "./storage";
import type { Touchpoint, Contact, Rfp, EmailMessage, EmailSignal } from "../shared/schema";
import { businessDaysAgo } from "./growthScoreCalculator";
import { storage as defaultStorage } from "./storage";

// ── Public types ──────────────────────────────────────────────────────────────

export type NbaUrgency = "critical" | "high" | "moderate" | "none";
export type NbaOwner   = "rep" | "nam" | "rep+nam" | "director";

/**
 * CTA hint for the UI — tells it which quick-action button to render.
 *   log_touch        → pre-fill the log-touchpoint dialog
 *   create_task      → open task creation dialog
 *   compose_email    → open email compose dialog
 *   schedule_meeting → create task dialog (meeting type)
 *   view_rfp         → navigate to RFP tab
 *   none             → no button shown (R13)
 */
export type NbaCta =
  | "log_touch"
  | "create_task"
  | "compose_email"
  | "schedule_meeting"
  | "view_rfp"
  | "none";

/**
 * All signals gathered for one account.
 * Null means the signal was unavailable (e.g. no financial data uploaded).
 * Exposed on NextBestAction for transparency and future UI use.
 */
export type AccountSignals = {
  // ── Growth score ───────────────────────────────────────────────────────────
  currentScore:            number | null;
  currentBand:             string | null;  // "at_risk" | "stable" | "growth_ready" | "high_expansion"
  previousScore:           number | null;  // null = first calculation, no history yet
  previousBand:            string | null;
  scoreDrop:               number | null;  // positive = dropped; null if no previous score

  // ── Touchpoint activity ────────────────────────────────────────────────────
  daysSinceLastTouch:      number | null;  // null = never touched
  touchesLast30d:          number;
  touchesPrior30d:         number;         // 30–60 days ago (for momentum context)
  meaningfulConvosLast60d: number;

  // ── Relationship depth ─────────────────────────────────────────────────────
  contactCount:            number;
  contactsWithBase:        number;         // contacts with any non-empty relationship base
  hasHrContact:            boolean;
  has3rdBaseContact:       boolean;
  stale1stBaseContacts:    Array<{ id: string; name: string; daysSinceTouch: number | null }>;

  // ── Account profile ────────────────────────────────────────────────────────
  shippingModeCount:       number;         // count from company.shippingModes array
  laneCorridorCount:       number;         // count of lane attributions

  // ── RFP pipeline ──────────────────────────────────────────────────────────
  openRfpCount:            number;
  urgentRfpDaysUntilDue:   number | null;  // days until nearest open-RFP deadline; null = no deadline set
  urgentRfpId:             string | null;
  urgentRfpTitle:          string | null;

  // ── Financial (partial) ────────────────────────────────────────────────────
  totalLoadsYtd:           number | null;  // null = no financial uploads on file
  latestMonthMarginPct:    number | null;  // null = no monthly data or no revenue

  // ── Tasks ──────────────────────────────────────────────────────────────────
  overdueTaskCount:        number;
};

/** The recommended action for one account. */
export type NextBestAction = {
  ruleId:          string;          // "R1"–"R13" — identifies which rule fired
  actionName:      string;          // Short display label
  reason:          string;          // One sentence: why this action now
  urgency:         NbaUrgency;
  owner:           NbaOwner;
  expectedOutcome: string;          // One sentence describing what success looks like
  cta:             NbaCta;
  ctaLabel:        string;          // Button label for the CTA
  rfpId?:          string;          // Set when R5 fires, for direct RFP navigation
  signals:         AccountSignals;  // Raw signals — full transparency
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function normBase(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isHr(base: string | null | undefined): boolean {
  const n = normBase(base);
  return n.includes("homerun") || n === "hr" || n === "home";
}

function is3rd(base: string | null | undefined): boolean {
  const n = normBase(base);
  return n.includes("3rd") || n === "3rdbase";
}

function is1st(base: string | null | undefined): boolean {
  const n = normBase(base);
  return n.includes("1st") || n === "1stbase";
}

function isGrowthBand(band: string | null | undefined): boolean {
  return band === "growth_ready" || band === "high_expansion";
}

/** Days between a date string ("YYYY-MM-DD") and now.  Positive = in the past. */
function daysSince(dateStr: string): number {
  const then = new Date(dateStr + "T12:00:00Z").getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

/** Days until a date string.  Positive = in the future. */
function daysUntil(dateStr: string): number {
  return -daysSince(dateStr);
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Signal gathering ──────────────────────────────────────────────────────────

/**
 * Collects all signals for a single company in ~5 parallel queries.
 * Financial data is optional; rules that need it degrade gracefully when null.
 */
async function gatherSignals(
  companyId: string,
  organizationId: string,
  storage: IStorage,
): Promise<{ signals: AccountSignals; businessDaysSinceLastTouch: number | null }> {
  const now          = new Date();
  const todayStr     = now.toISOString().slice(0, 10);
  const d7AgoStr     = new Date(now.getTime() - 7  * 86_400_000).toISOString().slice(0, 10);
  const d21AgoStr    = new Date(now.getTime() - 21 * 86_400_000).toISOString().slice(0, 10);
  const d30AgoStr    = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const d60AgoStr    = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);

  // Current month key for financial slice, e.g. "2026-04"
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // ── Parallel data fetch ───────────────────────────────────────────────────
  const [company, tps, contacts, laneAttributions, tasks, allRfps, growthScore, uploads] =
    await Promise.all([
      storage.getCompany(companyId),
      storage.getTouchpointsByCompany(companyId),
      storage.getContactsByCompany(companyId),
      storage.getLaneAttributionsByCompany(companyId),
      storage.getTasksByCompany(companyId),
      storage.getRfps(),                                   // all RFPs; filtered below
      storage.getGrowthScore(companyId),                   // cached score + previous
      storage.getFinancialUploadsForOrg(organizationId),   // may be empty
    ]);

  // ── Growth score ──────────────────────────────────────────────────────────
  const currentScore  = growthScore?.score  ?? null;
  const currentBand   = growthScore?.band   ?? null;
  const previousScore = growthScore?.previousScore ?? null;
  const previousBand  = growthScore?.previousBand  ?? null;
  const scoreDrop     = (currentScore !== null && previousScore !== null)
    ? (previousScore - currentScore)   // positive = dropped
    : null;

  // ── Touchpoints ───────────────────────────────────────────────────────────
  const sortedTps = [...tps].sort((a, b) => b.date.localeCompare(a.date));
  const lastTp    = sortedTps[0] ?? null;
  const daysSinceLastTouch         = lastTp ? daysSince(lastTp.date) : null;
  const businessDaysSinceLastTouch = lastTp ? businessDaysAgo(lastTp.date, todayStr) : null;

  const touchesLast30d          = tps.filter(t => t.date >= d30AgoStr).length;
  const touchesPrior30d         = tps.filter(t => t.date >= d60AgoStr && t.date < d30AgoStr).length;
  const meaningfulConvosLast60d = tps.filter(t => t.date >= d60AgoStr && t.isMeaningful).length;

  // Map contactId → most recent touch date for R10
  const lastTouchByContact = new Map<string, string>();
  for (const tp of tps) {
    if (!tp.contactId) continue;
    const existing = lastTouchByContact.get(tp.contactId);
    if (!existing || tp.date > existing) {
      lastTouchByContact.set(tp.contactId, tp.date);
    }
  }

  // ── Relationship depth ────────────────────────────────────────────────────
  const contactsWithBase = contacts.filter(c => c.relationshipBase?.trim());
  const hasHrContact     = contacts.some(c => isHr(c.relationshipBase));
  const has3rdBaseContact = contacts.some(c => is3rd(c.relationshipBase));

  // 1st Base contacts not touched in 30+ days (R10)
  const stale1stBaseContacts = contacts
    .filter(c => is1st(c.relationshipBase))
    .map(c => {
      const lastDate = lastTouchByContact.get(c.id) ?? null;
      const days     = lastDate ? daysSince(lastDate) : null;
      return { id: c.id, name: c.name, daysSinceTouch: days };
    })
    .filter(c => c.daysSinceTouch === null || c.daysSinceTouch >= 30);

  // ── Account profile ───────────────────────────────────────────────────────
  const shippingModeCount  = company?.shippingModes?.length ?? 0;
  const laneCorridorCount  = laneAttributions.length;
  const overdueTaskCount   = tasks.filter(
    t => t.status === "open" && t.dueDate && t.dueDate < todayStr
  ).length;

  // ── RFPs ─────────────────────────────────────────────────────────────────
  const companyRfps = allRfps.filter(r => r.companyId === companyId);
  const openRfps    = companyRfps.filter(r => r.status === "open" || r.status === "pending");
  const openRfpCount = openRfps.length;

  // Find the open RFP with the nearest deadline
  let urgentRfpDaysUntilDue: number | null = null;
  let urgentRfpId:           string | null = null;
  let urgentRfpTitle:        string | null = null;

  const rfpsWithDeadline = openRfps.filter(r => r.dueDate);
  if (rfpsWithDeadline.length > 0) {
    const nearest = rfpsWithDeadline.sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))[0];
    urgentRfpDaysUntilDue = daysUntil(nearest.dueDate!);
    urgentRfpId           = nearest.id;
    urgentRfpTitle        = nearest.title;
  }

  // ── Financial (partial) ───────────────────────────────────────────────────
  let totalLoadsYtd:        number | null = null;
  let latestMonthMarginPct: number | null = null;

  if (uploads.length > 0 && company) {
    const crmNorm    = normalizeName(company.name);
    const aliasNorms = company.financialAlias
      ? company.financialAlias.split(",").map((a: string) => normalizeName(a.trim())).filter(Boolean)
      : [];

    let ytdLoads         = 0;
    let monthMargin      = 0;
    let monthRevenue     = 0;
    let hasAnyData       = false;
    let hasCurrentMonth  = false;

    for (const upload of uploads) {
      const rows = (upload.rows as any[]) ?? [];
      for (const row of rows) {
        const custName = normalizeName(String(row.customerName ?? ""));
        if (custName !== crmNorm && !aliasNorms.some((a: string) => custName === a)) continue;

        hasAnyData = true;
        ytdLoads  += Number(row.totalLoads ?? 0);

        // Monthly slice — the row may have a "month" key or be in an upload keyed by month
        const rowMonth = String(row.month ?? "").slice(0, 7); // "YYYY-MM"
        if (rowMonth === thisMonthKey) {
          hasCurrentMonth = true;
          monthMargin  += Number(row.totalMargin  ?? 0);
          monthRevenue += Number(row.totalRevenue ?? 0);
        }
      }
    }

    if (hasAnyData) {
      totalLoadsYtd = ytdLoads;
      if (hasCurrentMonth && monthRevenue > 0) {
        latestMonthMarginPct = (monthMargin / monthRevenue) * 100;
      }
    }
  }

  return {
    signals: {
      currentScore, currentBand, previousScore, previousBand, scoreDrop,
      daysSinceLastTouch,
      touchesLast30d, touchesPrior30d, meaningfulConvosLast60d,
      contactCount:    contacts.length,
      contactsWithBase: contactsWithBase.length,
      hasHrContact, has3rdBaseContact, stale1stBaseContacts,
      shippingModeCount, laneCorridorCount,
      openRfpCount, urgentRfpDaysUntilDue, urgentRfpId, urgentRfpTitle,
      totalLoadsYtd, latestMonthMarginPct,
      overdueTaskCount,
    } satisfies AccountSignals,
    businessDaysSinceLastTouch,
  };
}

// ── Rule evaluation ───────────────────────────────────────────────────────────

/**
 * Walks R1–R13 in priority order.  Returns the first rule that fires.
 * Never returns null — R13 (no action needed) is always the fallback.
 */
function evaluateRules(s: AccountSignals, businessDaysSinceLastTouch: number | null): Omit<NextBestAction, "signals"> {

  // R1 — Emergency save
  // Fires when the growth score has dropped ≥15 points AND the account is now at_risk.
  // Indicates active deterioration that requires an escalation motion, not just a check-in.
  if (
    s.scoreDrop !== null &&
    s.scoreDrop >= 15 &&
    s.currentBand === "at_risk"
  ) {
    return {
      ruleId:          "R1",
      actionName:      "Escalate a Save Motion",
      reason:          `Growth score dropped ${s.scoreDrop} points and this account is now At Risk — act before it churns.`,
      urgency:         "critical",
      owner:           "rep+nam",
      expectedOutcome: "Identify the root cause, re-engage the key contact, and stop the score from declining further.",
      cta:             "schedule_meeting",
      ctaLabel:        "Plan Save Call",
    };
  }

  // R2 — Re-engage dormant contact
  // Fires when there has been no touchpoint in 7+ business days regardless of score band.
  // This is a pure activity signal — the rep has gone dark on this account.
  if (businessDaysSinceLastTouch === null || businessDaysSinceLastTouch >= 7) {
    const bd = businessDaysSinceLastTouch ?? 0;
    return {
      ruleId:          "R2",
      actionName:      "Re-Engage a Dormant Contact",
      reason:          businessDaysSinceLastTouch === null
        ? "This account has never been contacted — time to make first contact."
        : `No touchpoint in ${bd} business days — this account is going cold.`,
      urgency:         "critical",
      owner:           "rep",
      expectedOutcome: "Re-establish communication and confirm the account is still active.",
      cta:             "log_touch",
      ctaLabel:        "Log a Touch",
    };
  }

  // R3 — Escalate service / risk issue
  // Fires when band is at_risk AND no touch in 5+ business days.
  // Score is already in the danger zone and the rep isn't engaging.
  if (s.currentBand === "at_risk" && (businessDaysSinceLastTouch ?? 0) >= 5) {
    return {
      ruleId:          "R3",
      actionName:      "Follow Up on a Service Issue",
      reason:          `Account is At Risk and hasn't been touched in ${businessDaysSinceLastTouch} business days — there may be an unresolved issue.`,
      urgency:         "high",
      owner:           "rep",
      expectedOutcome: "Uncover any service concerns and restore engagement before the account deteriorates further.",
      cta:             "log_touch",
      ctaLabel:        "Log a Touch",
    };
  }

  // R4 — Review margin erosion  [partial — skipped if no financial data]
  // Fires when band is at_risk AND this month's margin % is negative or below 5%.
  // Financial data required — if unavailable this rule silently falls through.
  if (
    s.currentBand === "at_risk" &&
    s.latestMonthMarginPct !== null &&
    s.latestMonthMarginPct < 5
  ) {
    const pctStr = s.latestMonthMarginPct < 0
      ? `negative (${s.latestMonthMarginPct.toFixed(1)}%)`
      : `${s.latestMonthMarginPct.toFixed(1)}%`;
    return {
      ruleId:          "R4",
      actionName:      "Review Margin Erosion",
      reason:          `This account is At Risk and current-month margin is ${pctStr} — pricing or lane profitability needs review.`,
      urgency:         "high",
      owner:           "rep+nam",
      expectedOutcome: "Identify which lanes are losing margin and take corrective action on pricing or carrier costs.",
      cta:             "create_task",
      ctaLabel:        "Create Review Task",
    };
  }

  // R5 — Follow up on open RFP
  // Fires when there is an open RFP with a deadline ≤14 days away AND no touch in 7+ days.
  // Time-critical — competitor could win this if the rep is not actively engaged.
  if (
    s.urgentRfpDaysUntilDue !== null &&
    s.urgentRfpDaysUntilDue <= 14 &&
    (s.daysSinceLastTouch === null || s.daysSinceLastTouch >= 7)
  ) {
    const daysStr = s.urgentRfpDaysUntilDue <= 0
      ? "deadline has passed"
      : `${s.urgentRfpDaysUntilDue} days until deadline`;
    return {
      ruleId:          "R5",
      actionName:      "Follow Up on Open RFP",
      reason:          `"${s.urgentRfpTitle}" has ${daysStr} and the rep hasn't been in contact in ${s.daysSinceLastTouch ?? 0}+ days.`,
      urgency:         "high",
      owner:           "rep",
      expectedOutcome: "Ensure the submission is on track, answer any procurement questions, and stay top-of-mind before the decision.",
      cta:             "view_rfp",
      ctaLabel:        "View RFP",
      rfpId:           s.urgentRfpId ?? undefined,
    } as Omit<NextBestAction, "signals">;
  }

  // R6 — Add another stakeholder
  // Fires for growth-band accounts that have fewer than 2 contacts with a relationship base.
  // Single-contact dependency is a retention risk even on healthy accounts.
  if (isGrowthBand(s.currentBand) && s.contactsWithBase < 2) {
    return {
      ruleId:          "R6",
      actionName:      "Add Another Stakeholder",
      reason:          s.contactsWithBase === 0
        ? "No contacts have a relationship base assigned — this account has no mapped relationships."
        : `Only ${s.contactsWithBase} contact has a relationship base — expand coverage to reduce key-person risk.`,
      urgency:         "moderate",
      owner:           "rep",
      expectedOutcome: "Map a second or third contact to a relationship base to broaden account coverage.",
      cta:             "create_task",
      ctaLabel:        "Plan Intro",
    };
  }

  // R7 — Introduce a new shipping mode or service
  // Fires when a high-expansion account has fewer than 2 shipping modes on file.
  // This signals an untapped growth opportunity in adjacent services.
  if (s.currentBand === "high_expansion" && s.shippingModeCount < 2) {
    return {
      ruleId:          "R7",
      actionName:      "Introduce a New Mode or Service",
      reason:          s.shippingModeCount === 0
        ? "This high-potential account has no shipping modes on file — find out what they're moving."
        : "This account is primed to grow but only uses one shipping mode — explore adjacent services.",
      urgency:         "moderate",
      owner:           "rep",
      expectedOutcome: "Identify at least one new freight mode or service the customer isn't currently using with you.",
      cta:             "log_touch",
      ctaLabel:        "Log Discovery Call",
    };
  }

  // R8 — Explore additional lanes or locations
  // Fires for growth-band accounts with fewer than 3 lane corridors attributed.
  // Low lane attribution on a healthy account suggests hidden freight volume.
  if (isGrowthBand(s.currentBand) && s.laneCorridorCount < 3) {
    return {
      ruleId:          "R8",
      actionName:      "Explore Additional Lanes or Locations",
      reason:          s.laneCorridorCount === 0
        ? "No lanes are attributed to this account — map their freight patterns to find growth opportunities."
        : `Only ${s.laneCorridorCount} lane corridor${s.laneCorridorCount === 1 ? "" : "s"} attributed — there may be unworked freight volume.`,
      urgency:         "moderate",
      owner:           "rep",
      expectedOutcome: "Identify at least one new origin/destination corridor to pursue.",
      cta:             "log_touch",
      ctaLabel:        "Log Lane Discovery Call",
    };
  }

  // R9 — Schedule a QBR  [partial — load threshold only checked when financial data is available]
  // Fires when there's been no meaningful conversation in 60+ days AND the account has
  // significant freight volume (≥50 loads YTD).  If financial data is unavailable,
  // fires on the conversation-gap signal alone for accounts with a high/growth score.
  const noMeaningful60d = s.meaningfulConvosLast60d === 0;
  const hasSignificantVolume = s.totalLoadsYtd === null
    ? isGrowthBand(s.currentBand)           // fallback: use band when no load data
    : s.totalLoadsYtd >= 50;
  if (noMeaningful60d && hasSignificantVolume) {
    return {
      ruleId:          "R9",
      actionName:      "Schedule a QBR",
      reason:          s.totalLoadsYtd !== null
        ? `No meaningful conversation in 60+ days — this account moves ${s.totalLoadsYtd.toLocaleString()} loads and deserves a strategic review.`
        : "No meaningful conversation in 60+ days with a growth-band account — time for a strategic check-in.",
      urgency:         "high",
      owner:           "rep+nam",
      expectedOutcome: "Align on account goals, surface expansion lanes, and schedule the next QBR or business review.",
      cta:             "schedule_meeting",
      ctaLabel:        "Schedule QBR",
    };
  }

  // R10 — Deepen a key 1st-Base contact
  // Fires when any 1st-Base contact hasn't been touched in 30+ days.
  // 1st Base contacts are the entry point to advancing relationships — keeping them warm is table stakes.
  if (s.stale1stBaseContacts.length > 0) {
    const staleContact = s.stale1stBaseContacts[0];
    const daysStr = staleContact.daysSinceTouch === null
      ? "and has never been contacted"
      : `for ${staleContact.daysSinceTouch} days`;
    return {
      ruleId:          "R10",
      actionName:      "Deepen a Key Contact",
      reason:          `${staleContact.name} is at 1st Base ${daysStr} — advance the relationship before they go cold.`,
      urgency:         "moderate",
      owner:           "rep",
      expectedOutcome: "Have a meaningful conversation and advance this contact toward 2nd or 3rd Base.",
      cta:             "log_touch",
      ctaLabel:        "Log a Touch",
    };
  }

  // R11 — Create or update an account plan
  // Fires when the account's band has just improved to growth_ready or higher.
  // A newly elevated account represents a strategic opportunity that should be planned.
  if (
    isGrowthBand(s.currentBand) &&
    s.previousBand !== null &&
    !isGrowthBand(s.previousBand)
  ) {
    return {
      ruleId:          "R11",
      actionName:      "Create or Update the Account Plan",
      reason:          `This account just moved from ${s.previousBand === "stable" ? "Stable" : "At Risk"} to ${s.currentBand === "high_expansion" ? "Primed to Grow" : "Growth Ready"} — time to plan how to capitalize on the momentum.`,
      urgency:         "moderate",
      owner:           "nam",
      expectedOutcome: "Document the growth strategy, assign ownership to specific contacts, and set a 90-day milestone.",
      cta:             "create_task",
      ctaLabel:        "Create Account Plan Task",
    };
  }

  // R12 — Maintain cadence (catch-all)
  // Fires when the last touch was 3+ business days ago and no higher-priority rule has fired.
  // Keeps the rep honest about staying in cadence on stable accounts.
  if ((businessDaysSinceLastTouch ?? 0) >= 3) {
    return {
      ruleId:          "R12",
      actionName:      "Maintain Cadence — Check In",
      reason:          `It's been ${businessDaysSinceLastTouch} business days since the last touch — keep the relationship warm.`,
      urgency:         "moderate",
      owner:           "rep",
      expectedOutcome: "Confirm the account is happy, surface any upcoming needs, and stay top-of-mind.",
      cta:             "log_touch",
      ctaLabel:        "Log a Touch",
    };
  }

  // R13 — No action needed (fallback — always fires if nothing above matched)
  return {
    ruleId:          "R13",
    actionName:      "No Action Needed — Account Is Healthy",
    reason:          "All signals look good. Keep up the current engagement cadence.",
    urgency:         "none",
    owner:           "rep",
    expectedOutcome: "Continue current activity levels to maintain the account's health score.",
    cta:             "none",
    ctaLabel:        "",
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Compute the Next Best Action for a single company.
 *
 * @param companyId      - the company to evaluate
 * @param organizationId - needed to scope financial uploads
 * @param storage        - the shared storage interface
 *
 * All heavy queries run in parallel inside gatherSignals.
 * Rule evaluation is pure/synchronous given the signals object.
 */
export async function computeNextBestAction(
  companyId: string,
  organizationId: string,
  storage: IStorage,
): Promise<NextBestAction> {
  const { signals, businessDaysSinceLastTouch } = await gatherSignals(companyId, organizationId, storage);
  const action  = evaluateRules(signals, businessDaysSinceLastTouch);
  return { ...action, signals };
}

// ── Email Signal → NBA Card mapping (Task #190) ───────────────────────────────

/**
 * Signal → NBA card mapping table.
 *
 * Keys are intentType values from the email intelligence taxonomy.
 * Values are the ruleType, urgency, and outcomeType for the NBA card, or null
 * when the signal does not warrant its own NBA card (hard confirmations, positive signals, etc.).
 *
 * outcomeType semantics:
 *   protect  — at-risk or defensive action (close-lost risk, stalled threads, service issues)
 *   grow     — expansion or revenue-capture opportunity (new lanes, pricing, contracts)
 *   execute  — capacity or operational action (lane coverage, carrier follow-through)
 */
interface NbaSignalMapping {
  ruleType: string;
  urgency: string;
  outcomeType: string;
}

const EMAIL_SIGNAL_NBA_MAP: Record<string, NbaSignalMapping | null> = {
  // Carrier signals — Execute (capacity management) or Protect (service/risk)
  lane_offer:             { ruleType: "recurring_lane_capacity",         urgency: "high",     outcomeType: "execute" },
  lane_decline:           { ruleType: "load_decline",                    urgency: "high",     outcomeType: "execute" },
  capacity_available:     { ruleType: "recurring_lane_capacity",         urgency: "moderate", outcomeType: "execute" },
  capacity_unavailable:   { ruleType: "single_thread_risk",              urgency: "moderate", outcomeType: "execute" },
  new_lane_preference:    { ruleType: "recurring_lane_capacity",         urgency: "moderate", outcomeType: "execute" },
  price_pushback:         { ruleType: "stale_account",                   urgency: "moderate", outcomeType: "protect" },
  service_issue:          { ruleType: "overdue_next_action",             urgency: "high",     outcomeType: "protect" },
  soft_commitment:        { ruleType: "stale_account",                   urgency: "moderate", outcomeType: "execute" },
  hard_commitment:        null,
  paperwork_compliance:   null,

  // Customer signals — Grow (opportunity) or Protect (at-risk/churn defense)
  pricing_request:        { ruleType: "market_surge_customer_outreach",  urgency: "high",     outcomeType: "grow"    },
  objection:              { ruleType: "stale_account",                   urgency: "moderate", outcomeType: "protect" },
  service_complaint:      { ruleType: "overdue_next_action",             urgency: "high",     outcomeType: "protect" },
  urgency_signal:         { ruleType: "overdue_next_action",             urgency: "high",     outcomeType: "execute" },
  stalled_thread:         { ruleType: "stale_account",                   urgency: "moderate", outcomeType: "protect" },
  meaningful_touchpoint:  null,
  new_opportunity:        { ruleType: "spot_to_contract",                urgency: "high",     outcomeType: "grow"    },
  positive_feedback:      null,
  closed_won_indicator:   null,
  closed_lost_indicator:  { ruleType: "stale_account",                   urgency: "critical", outcomeType: "protect" },

  // Conversation spark signals — actionable outreach opportunities from email patterns
  conversation_spark_adhoc_to_structured:  { ruleType: "email_spark_adhoc_to_structured",   urgency: "high",     outcomeType: "grow"    },
  conversation_spark_new_stakeholder:      { ruleType: "email_spark_new_stakeholder",        urgency: "moderate", outcomeType: "deepen"  },
  conversation_spark_geography_expansion:  { ruleType: "email_spark_geography_expansion",    urgency: "high",     outcomeType: "grow"    },
};

export const SIGNAL_CONFIDENCE_THRESHOLD = 60;

/**
 * Given a set of email signals that were just extracted from a message,
 * creates NBA cards for signals that map to known NBA rule types.
 *
 * Supports both account-context (linkedAccountId) and carrier-context
 * (linkedCarrierId with a lane resolved to a company) generation paths.
 * Skips signals below the confidence threshold and deduplicates via
 * getRecentNbaCardByType (24h window).
 */
type NbaEmailStorage = Pick<
  IStorage,
  "getRecentNbaCardByType" | "getRecurringLane" | "getFirstOrgAdmin" | "createNbaCard"
>;

export async function generateNbasFromEmailSignals(
  orgId: string,
  message: EmailMessage,
  signals: EmailSignal[],
  storageInstance: NbaEmailStorage = defaultStorage,
): Promise<void> {
  // Task #943 — Email Intelligence v1.5 bounce/OOO suppression.
  // The "outreach target" for an inbound message is the contact who *sent* it
  // (msg.fromEmail). For outbound messages it's the recipient (msg.toEmail).
  // If that mailbox is currently bouncing or OOO, do not generate follow-up
  // NBAs — they would just push reps to email a dead inbox. Best-effort: any
  // adapter failure must NOT block v1 NBA generation.
  const outreachEmail = (message.direction === "inbound" ? message.fromEmail : message.toEmail) || null;
  if (outreachEmail) {
    try {
      const { isContactSuppressed } = await import("./services/emailFacts");
      const status = await isContactSuppressed(orgId, outreachEmail.toLowerCase());
      if (status.suppressed) {
        console.log(`[nba] suppressing email NBAs for ${outreachEmail} (reason=${status.reason})`);
        return;
      }
    } catch (err) {
      console.error("[nba] bounce suppression check failed (continuing):", err);
    }
  }

  for (const signal of signals) {
    if (signal.confidence < SIGNAL_CONFIDENCE_THRESHOLD) continue;

    const mapping = EMAIL_SIGNAL_NBA_MAP[signal.intentType];
    if (!mapping) continue;

    // Resolve the account (companyId) for the NBA card.
    // Direct account link is preferred; for carrier signals we fall through to
    // the lane's company when the message has no explicit account link.
    let companyId: string | null = message.linkedAccountId ?? null;

    if (!companyId && message.linkedLaneId) {
      const lane = await storageInstance.getRecurringLane(message.linkedLaneId);
      companyId = lane?.companyId ?? null;
    }

    if (!companyId) continue;

    // 24-hour dedup — skip if a card of this rule type was already created today.
    const existingCard = await storageInstance.getRecentNbaCardByType(companyId, mapping.ruleType, 1);
    if (existingCard) continue;

    // Assign to lane owner if possible, otherwise fall back to org admin.
    let assignedUserId: string | null = null;
    if (message.linkedLaneId) {
      const lane = await storageInstance.getRecurringLane(message.linkedLaneId);
      if (lane?.ownerUserId) assignedUserId = lane.ownerUserId;
    }
    if (!assignedUserId) {
      const admin = await storageInstance.getFirstOrgAdmin(orgId);
      assignedUserId = admin?.id ?? null;
    }
    if (!assignedUserId) continue;

    const confidenceLabel: string =
      signal.confidence >= 80 ? "high" : signal.confidence >= 60 ? "medium" : "low";
    const urgencyScore: number =
      mapping.urgency === "critical" ? 90 : mapping.urgency === "high" ? 70 : 50;

    // signalSummary is typed as jsonb (any[]) — use a plain object array
    const signalSummaryValue: Array<Record<string, unknown>> = [
      { intentType: signal.intentType, confidence: signal.confidence },
    ];

    const now = new Date().toISOString();
    await storageInstance.createNbaCard({
      companyId,
      userId: assignedUserId,
      orgId,
      ruleType: mapping.ruleType,
      outcomeType: mapping.outcomeType,
      confidence: confidenceLabel,
      signalCount: 1,
      signalSummary: signalSummaryValue,
      whyThisNow: buildNbaTitleFromSignal(signal),
      suggestedAction: buildNbaBodyFromSignal(signal, message),
      expectedOutcome: "Engage promptly to maintain the relationship and resolve the issue.",
      urgencyScore,
      playLabel: getPlayForRuleType(mapping.ruleType)?.name ?? null,
      status: "generated",
      linkedLaneId: message.linkedLaneId ?? null,
      createdAt: now,
    });
  }
}

// ── Account Email NBA Consumer (Task #191) ────────────────────────────────────

/**
 * Intent family groupings for dedup — at most one active NBA per
 * (threadId, intent family, accountId) is allowed.
 */
const ACCOUNT_EMAIL_INTENT_FAMILIES: Record<string, string> = {
  pricing_request:       "pricing",
  objection:             "objection",
  service_complaint:     "service",
  stalled_thread:        "stalled",
  urgency_signal:        "urgency",
  new_opportunity:       "opportunity",
  closed_lost_indicator: "outcome",
  conversation_spark_adhoc_to_structured:  "spark_adhoc",
  conversation_spark_new_stakeholder:      "spark_stakeholder",
  conversation_spark_geography_expansion:  "spark_geography",
};

interface AccountEmailNbaRule {
  ruleType: string;
  outcomeType: string;
  urgency: "critical" | "high" | "moderate";
  title: string;
  body: (signal: EmailSignal, message: EmailMessage) => string;
}

const ACCOUNT_EMAIL_NBA_RULES: Record<string, AccountEmailNbaRule> = {
  pricing_request: {
    ruleType: "email_quote_follow_up",
    outcomeType: "grow",
    urgency: "high",
    title: "Follow up on pricing request",
    body: (s, m) => `Customer requested a quote${m.subject ? ` — "${m.subject.slice(0, 60)}"` : ""}. Send a competitive rate and confirm lane details.`,
  },
  objection: {
    ruleType: "email_objection_handling",
    outcomeType: "protect",
    urgency: "high",
    title: "Handle customer objection",
    body: (s, m) => `Customer raised an objection${m.subject ? ` in "${m.subject.slice(0, 60)}"` : ""}. Address the concern promptly to protect the relationship.`,
  },
  service_complaint: {
    ruleType: "email_service_recovery",
    outcomeType: "protect",
    urgency: "high",
    title: "Service recovery — escalate complaint",
    body: (s, m) => `Service complaint received${m.subject ? ` — "${m.subject.slice(0, 60)}"` : ""}. Escalate internally and respond with a resolution plan.`,
  },
  stalled_thread: {
    ruleType: "email_re_engage_thread",
    outcomeType: "protect",
    urgency: "moderate",
    title: "Re-engage stalled email thread",
    body: (s, m) => `Email thread appears stalled${m.subject ? ` — "${m.subject.slice(0, 60)}"` : ""}. Send a follow-up to unblock and keep the conversation moving.`,
  },
  urgency_signal: {
    ruleType: "email_urgency_outreach",
    outcomeType: "execute",
    urgency: "high",
    title: "Customer has urgent need — prioritize outreach",
    body: (s, m) => `Urgency signal detected${m.subject ? ` in "${m.subject.slice(0, 60)}"` : ""}. Contact the customer immediately to confirm capacity and timing.`,
  },
  new_opportunity: {
    ruleType: "email_opportunity_qualify",
    outcomeType: "grow",
    urgency: "high",
    title: "Qualify new freight opportunity",
    body: (s, m) => `Customer mentioned new lanes or freight volume${m.subject ? ` in "${m.subject.slice(0, 60)}"` : ""}. Set up a qualification call to scope the opportunity.`,
  },
  conversation_spark_adhoc_to_structured: {
    ruleType: "email_spark_adhoc_to_structured",
    outcomeType: "grow",
    urgency: "high",
    title: "Propose mini-bid for repeated ad hoc corridor",
    body: (s, m) => {
      const data = (s.extractedData ?? {}) as Record<string, unknown>;
      const corridor = data.corridor ? ` on ${data.corridor}` : "";
      const loads = data.loadCount ? ` (${data.loadCount} ad hoc loads observed)` : "";
      return `Repeated ad hoc loads detected${corridor}${loads}${m.subject ? ` — thread: "${m.subject.slice(0, 50)}"` : ""}. Propose a mini-bid or contracted lane to capture this volume.`;
    },
  },
  conversation_spark_new_stakeholder: {
    ruleType: "email_spark_new_stakeholder",
    outcomeType: "deepen",
    urgency: "moderate",
    title: "New stakeholder active — send intro",
    body: (s, m) => {
      const data = (s.extractedData ?? {}) as Record<string, unknown>;
      const who = data.stakeholderName ? ` ${data.stakeholderName}` : "";
      const role = data.role ? ` (${data.role})` : "";
      return `New stakeholder${who}${role} is active on recent threads${m.subject ? ` including "${m.subject.slice(0, 50)}"` : ""}. Send a personalized intro to build the relationship.`;
    },
  },
  conversation_spark_geography_expansion: {
    ruleType: "email_spark_geography_expansion",
    outcomeType: "grow",
    urgency: "high",
    title: "Geography expansion opportunity detected",
    body: (s, m) => {
      const data = (s.extractedData ?? {}) as Record<string, unknown>;
      const region = data.region ? ` in ${data.region}` : "";
      const corridor = data.corridor ? ` (corridor: ${data.corridor})` : "";
      return `Email threads reveal freight activity${region}${corridor} not previously covered${m.subject ? ` — "${m.subject.slice(0, 50)}"` : ""}. Expand coverage to capture this new geography.`;
    },
  },
};

type AccountEmailNbaStorage = Pick<
  IStorage,
  "getRecentNbaCardByType" | "getActiveNbaCardByThreadAndType" | "getFirstOrgAdmin" | "createNbaCard"
>;

/**
 * Generate email-driven account NBA cards from a set of signals.
 * Dedup: at most one active NBA per (threadId, intent family, accountId).
 * Uses the existing nba_cards table with a 24-hour window dedup.
 */
export async function generateAccountEmailNbas(
  orgId: string,
  accountId: string,
  message: EmailMessage,
  signals: EmailSignal[],
  storageInstance: AccountEmailNbaStorage = defaultStorage,
): Promise<void> {
  // Task #943 — bounce/OOO suppression mirrors generateNbasFromEmailSignals.
  const outreachEmail = (message.direction === "inbound" ? message.fromEmail : message.toEmail) || null;
  if (outreachEmail) {
    try {
      const { isContactSuppressed } = await import("./services/emailFacts");
      const status = await isContactSuppressed(orgId, outreachEmail.toLowerCase());
      if (status.suppressed) {
        console.log(`[nba] suppressing account email NBAs for ${outreachEmail} (reason=${status.reason})`);
        return;
      }
    } catch (err) {
      console.error("[nba] bounce suppression check failed (continuing):", err);
    }
  }

  const familiesProcessed = new Set<string>();

  for (const signal of signals) {
    if (signal.confidence < 60) continue;

    const family = ACCOUNT_EMAIL_INTENT_FAMILIES[signal.intentType];
    if (!family) continue;

    const rule = ACCOUNT_EMAIL_NBA_RULES[signal.intentType];
    if (!rule) continue;

    // Per-thread per-family dedup within this call (in-memory)
    const threadFamilyKey = `${message.threadId ?? signal.id}:${family}`;
    if (familiesProcessed.has(threadFamilyKey)) continue;
    familiesProcessed.add(threadFamilyKey);

    // DB dedup: at most one active NBA per (accountId, ruleType, threadId)
    // Uses JSONB @> query on signalSummary[*].threadId for precise thread-keyed dedup.
    const threadId = message.threadId ?? signal.id;
    const existing = await storageInstance.getActiveNbaCardByThreadAndType(accountId, rule.ruleType, threadId);
    if (existing) continue;

    let assignedUserId: string | null = null;
    const admin = await storageInstance.getFirstOrgAdmin(orgId);
    assignedUserId = admin?.id ?? null;
    if (!assignedUserId) continue;

    const urgencyScore =
      rule.urgency === "critical" ? 90 : rule.urgency === "high" ? 70 : 50;

    const signalSummaryValue: Array<Record<string, unknown>> = [{
      intentType: signal.intentType,
      confidence: signal.confidence,
      threadId: message.threadId ?? null,
      signalDate: signal.createdAt.toISOString(),
      subject: message.subject ?? null,
    }];

    const now = new Date().toISOString();
    await storageInstance.createNbaCard({
      companyId: accountId,
      userId: assignedUserId,
      orgId,
      ruleType: rule.ruleType,
      outcomeType: rule.outcomeType,
      confidence: signal.confidence >= 80 ? "high" : "medium",
      signalCount: 1,
      signalSummary: signalSummaryValue,
      whyThisNow: rule.title,
      suggestedAction: rule.body(signal, message),
      expectedOutcome: "Engage promptly to maintain the relationship and capture the opportunity.",
      urgencyScore,
      playLabel: getPlayForRuleType(rule.ruleType)?.name ?? null,
      status: "generated",
      linkedLaneId: message.linkedLaneId ?? null,
      createdAt: now,
    });
  }
}

// ── Conversation Ownership NBA Generator (Task #202) ─────────────────────────

type ConversationNbaStorage = Pick<
  IStorage,
  | "getRecentNbaCardByType"
  | "createNbaCard"
  | "getUser"
  | "getCompany"
>;

/**
 * Generate NBA cards from email_conversation_threads waiting state.
 * Called after thread state is updated.
 *
 * Rules:
 *  (a) waiting_on_us + overdue  → one summary card per user "N convos waiting — X overdue"
 *  (b) high-priority + waiting_on_us + overdueAt set → one card per thread
 *  (c) unowned + waiting_on_us  → one card per thread
 */
export async function generateConversationOwnershipNbas(
  orgId: string,
  threads: Array<{
    id: string;
    ownerUserId: string | null;
    waitingState: string;
    responsePriority: string;
    overdueAt: Date | null;
    threadId: string;
    linkedAccountId: string | null;
    linkedCarrierId: string | null;
  }>,
  storageInstance: ConversationNbaStorage = defaultStorage,
): Promise<void> {
  const now = new Date();
  const nowStr = now.toISOString();

  // Group waiting_on_us threads by owner for rule (a)
  const ownerOverdueMap = new Map<string, { total: number; overdue: number }>();

  for (const thread of threads) {
    if (thread.waitingState !== "waiting_on_us") continue;

    // Rule (b): overdue past SLA — one card per owned thread (any priority; high=4h, normal=24h)
    if (thread.ownerUserId && thread.overdueAt && thread.overdueAt <= now) {
      const companyId = thread.linkedAccountId ?? thread.linkedCarrierId;
      if (!companyId) continue;

      const isHighPriority = thread.responsePriority === "high";
      const dedupKey = `conv_overdue_sla_${thread.id}`;
      const existing = await storageInstance.getRecentNbaCardByType(companyId, dedupKey, 7);
      if (!existing) {
        const slaLabel = isHighPriority ? "4-hour" : "24-hour";
        await storageInstance.createNbaCard({
          companyId,
          userId: thread.ownerUserId,
          orgId,
          ruleType: dedupKey,
          outcomeType: "protect",
          confidence: isHighPriority ? "high" : "medium",
          signalCount: 1,
          signalSummary: [{ threadId: thread.threadId, waitingState: thread.waitingState, priority: thread.responsePriority }],
          whyThisNow: `${isHighPriority ? "High" : "Normal"}-priority conversation is past ${slaLabel} SLA`,
          suggestedAction: `Thread (${thread.threadId}) has been waiting on us past the ${slaLabel} SLA. Reply now.`,
          expectedOutcome: "Reply sent within SLA — thread moves to waiting_on_them.",
          urgencyScore: isHighPriority ? 85 : 70,
          playLabel: "Clear Overdue Commitment",
          status: "generated",
          linkedLaneId: null,
          createdAt: nowStr,
        });
      }
    }

    // Rule (c): unowned + waiting_on_us — one card per thread
    if (!thread.ownerUserId) {
      const companyId = thread.linkedAccountId ?? thread.linkedCarrierId;
      if (!companyId) continue;

      // Route the card to the company's salesperson; skip if none assigned.
      const company = thread.linkedAccountId
        ? await storageInstance.getCompany(thread.linkedAccountId)
        : null;
      const fallbackUserId = company?.assignedTo ?? null;
      if (!fallbackUserId) continue;

      const dedupKey = `conv_unowned_waiting_${thread.id}`;
      const existing = await storageInstance.getRecentNbaCardByType(companyId, dedupKey, 3);
      if (!existing) {
        await storageInstance.createNbaCard({
          companyId,
          userId: fallbackUserId,
          orgId,
          ruleType: dedupKey,
          outcomeType: "execute",
          confidence: "medium",
          signalCount: 1,
          signalSummary: [{ threadId: thread.threadId, waitingState: thread.waitingState }],
          whyThisNow: "Unowned conversation waiting on us",
          suggestedAction: `Thread ${thread.threadId} has no owner and is waiting on a reply. Assign ownership and respond.`,
          expectedOutcome: "Thread is claimed and reply is sent.",
          urgencyScore: 65,
          playLabel: "Clear Overdue Commitment",
          status: "generated",
          linkedLaneId: null,
          createdAt: nowStr,
        });
      }
    }

    // Accumulate for rule (a) summary card
    if (thread.ownerUserId) {
      const stats = ownerOverdueMap.get(thread.ownerUserId) ?? { total: 0, overdue: 0 };
      stats.total++;
      if (thread.overdueAt && thread.overdueAt <= now) stats.overdue++;
      ownerOverdueMap.set(thread.ownerUserId, stats);
    }
  }

  // Rule (a): summary card per user — once per day max
  for (const [ownerUserId, stats] of ownerOverdueMap.entries()) {
    if (stats.total === 0) continue;
    const dedupKey = `conv_waiting_summary_${ownerUserId}`;
    const existing = await storageInstance.getRecentNbaCardByType(ownerUserId, dedupKey, 1);
    if (existing) continue;

    const overdueText = stats.overdue > 0 ? ` (${stats.overdue} overdue)` : "";
    await storageInstance.createNbaCard({
      companyId: ownerUserId, // use userId as companyId sentinel for user-level cards
      userId: ownerUserId,
      orgId,
      ruleType: dedupKey,
      outcomeType: "execute",
      confidence: stats.overdue > 0 ? "high" : "medium",
      signalCount: stats.total,
      signalSummary: [{ totalWaiting: stats.total, overdue: stats.overdue }],
      whyThisNow: `You have ${stats.total} conversation${stats.total !== 1 ? "s" : ""} waiting on you${overdueText}`,
      suggestedAction: "Open the Conversations inbox to review and reply to threads waiting on you.",
      expectedOutcome: "All waiting threads receive a timely reply.",
      urgencyScore: stats.overdue > 0 ? 80 : 55,
      playLabel: "Clear Overdue Commitment",
      status: "generated",
      linkedLaneId: null,
      createdAt: nowStr,
    }).catch(() => undefined); // Non-fatal — suppress if companyId constraint fails
  }
}

function buildNbaTitleFromSignal(signal: EmailSignal): string {
  const titles: Record<string, string> = {
    lane_offer:             "Carrier offering lane capacity — log interest",
    lane_decline:           "Carrier declined lane — find backup",
    capacity_available:     "Carrier has capacity available",
    capacity_unavailable:   "Carrier capacity unavailable",
    new_lane_preference:    "Carrier expressing new lane preference",
    price_pushback:         "Carrier rate pushback — review pricing",
    service_issue:          "Carrier reported a service issue",
    soft_commitment:        "Carrier gave soft commitment — confirm",
    pricing_request:        "Customer requested pricing",
    objection:              "Customer objection raised",
    service_complaint:      "Service complaint received",
    urgency_signal:         "Customer urgent — action needed",
    stalled_thread:         "Email thread stalled — follow up",
    new_opportunity:        "New freight opportunity from customer",
    closed_lost_indicator:  "Customer lost signal detected",
  };
  return titles[signal.intentType] ?? `Email signal: ${signal.intentType}`;
}

function buildNbaBodyFromSignal(signal: EmailSignal, message: EmailMessage): string {
  const base = `Detected from ${message.direction} email` +
    (message.subject ? ` — "${message.subject.slice(0, 80)}"` : "") +
    `. Intent: ${signal.intentType} (${signal.confidence}% confidence).`;
  if (signal.intentSubtype) return `${base} Subtype: ${signal.intentSubtype}.`;
  return base;
}
