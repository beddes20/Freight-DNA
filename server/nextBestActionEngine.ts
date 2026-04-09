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
import type { Touchpoint, Contact, Rfp } from "../shared/schema";
import { businessDaysAgo } from "./growthScoreCalculator";

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
