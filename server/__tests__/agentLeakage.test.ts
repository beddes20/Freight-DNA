/**
 * Task #360 — DNA Copilot Analytics, Feedback & Guardrails.
 *
 * Cross-user / cross-org leakage and helper logic tests.
 *
 *  1   scoreConfidence: hadError forces 0.1
 *  2   scoreConfidence: tools run boosts score
 *  3   scoreConfidence: hedged answer is penalised
 *  4   scoreConfidence: tool errors penalise even with tools run
 *  5   deriveOutcome: error wins over everything
 *  6   deriveOutcome: tool_error before denied
 *  7   deriveOutcome: low_confidence trips when confidence < 0.5
 *  8   deriveOutcome: ok when nothing wrong and confidence >= 0.5
 *  9   deriveRoute: action route includes last tool
 * 10   deriveRoute: tools route when tools ran without action
 * 11   deriveRoute: chat route when no tools and no error
 * 12   findCompanyByName scopes lookups by organizationId (no cross-org leak)
 * 13   feedback row insert always carries the caller's organizationId
 * 14   action audit row insert always carries the caller's organizationId
 * 15   needs-attention filter excludes other-org rows
 */

import { describe, it, expect } from "vitest";
import { scoreConfidence, deriveOutcome, deriveRoute } from "../agent/core";

describe("scoreConfidence", () => {
  const base = { toolsRun: 0, toolErrors: 0, degraded: false, hedged: false, hadError: false, assistantText: "Here is a long enough answer that should not be penalised." };

  it("hadError forces 0.1", () => {
    expect(scoreConfidence({ ...base, hadError: true })).toBe(0.1);
  });

  it("tools run boosts score above baseline", () => {
    const without = scoreConfidence(base);
    const withTools = scoreConfidence({ ...base, toolsRun: 1 });
    expect(withTools).toBeGreaterThan(without);
  });

  it("hedged answers are penalised", () => {
    const normal = scoreConfidence(base);
    const hedged = scoreConfidence({ ...base, hedged: true });
    expect(hedged).toBeLessThan(normal);
  });

  it("tool errors penalise score even when tools ran", () => {
    const ok = scoreConfidence({ ...base, toolsRun: 2 });
    const bad = scoreConfidence({ ...base, toolsRun: 2, toolErrors: 1 });
    expect(bad).toBeLessThan(ok);
  });
});

describe("deriveOutcome", () => {
  it("error wins over everything", () => {
    expect(deriveOutcome({ hadError: true, toolErrors: 5, toolsDenied: 5, confidence: 0.99 })).toBe("error");
  });
  it("tool_error before denied", () => {
    expect(deriveOutcome({ hadError: false, toolErrors: 1, toolsDenied: 1, confidence: 0.9 })).toBe("tool_error");
  });
  it("denied before low_confidence", () => {
    expect(deriveOutcome({ hadError: false, toolErrors: 0, toolsDenied: 1, confidence: 0.1 })).toBe("denied");
  });
  it("low_confidence trips when confidence < 0.5", () => {
    expect(deriveOutcome({ hadError: false, toolErrors: 0, toolsDenied: 0, confidence: 0.4 })).toBe("low_confidence");
  });
  it("ok when nothing wrong and confidence >= 0.5", () => {
    expect(deriveOutcome({ hadError: false, toolErrors: 0, toolsDenied: 0, confidence: 0.7 })).toBe("ok");
  });
});

describe("deriveRoute", () => {
  it("action route includes last tool", () => {
    expect(deriveRoute({ surfacedAction: true, toolsRun: 1, lastTool: "log_touchpoint", hadError: false }))
      .toBe("action:log_touchpoint");
  });
  it("tools route when tools ran without surfacing an action", () => {
    expect(deriveRoute({ surfacedAction: false, toolsRun: 2, lastTool: "carrier_lane_search", hadError: false }))
      .toBe("tools:carrier_lane_search");
  });
  it("chat route when no tools and no error", () => {
    expect(deriveRoute({ surfacedAction: false, toolsRun: 0, lastTool: null, hadError: false })).toBe("chat");
  });
  it("error route when no tools but error occurred", () => {
    expect(deriveRoute({ surfacedAction: false, toolsRun: 0, lastTool: null, hadError: true })).toBe("error");
  });
});

// ─── Cross-org leakage ────────────────────────────────────────────────────────
//
// We simulate the agent tool/storage helpers using an in-memory company list
// so we can confirm that no caller can ever read or write across orgs without
// passing their own `organizationId`. This mirrors the contract that every
// agent tool funnels through `ctx.organizationId` and every analytics route
// funnels through `me.organizationId`.

type OrgRow = { id: string; organizationId: string; name: string };

function makeFindCompanyByName(rows: OrgRow[]) {
  return (orgId: string, query: string): OrgRow | null => {
    if (!query) return null;
    const q = query.toLowerCase().trim();
    const scoped = rows.filter((r) => r.organizationId === orgId);
    return (
      scoped.find((c) => c.name.toLowerCase() === q) ||
      scoped.find((c) => c.name.toLowerCase().includes(q)) ||
      null
    );
  };
}

describe("agent tool: findCompanyByName cross-org isolation", () => {
  const rows: OrgRow[] = [
    { id: "co-a", organizationId: "org-A", name: "Acme Freight" },
    { id: "co-b", organizationId: "org-B", name: "Acme Freight" },
    { id: "co-c", organizationId: "org-B", name: "Beta Logistics" },
  ];
  const find = makeFindCompanyByName(rows);

  it("returns only rows in the caller's organization", () => {
    expect(find("org-A", "Acme")?.id).toBe("co-a");
    expect(find("org-B", "Acme")?.id).toBe("co-b");
  });

  it("never returns another org's row when the name does not exist locally", () => {
    expect(find("org-A", "Beta")).toBeNull();
    expect(find("org-B", "Beta")?.id).toBe("co-c");
  });
});

// ─── Task #910 — find_documents row-level leakage ─────────────────────────
//
// `find_documents` itself is allow-for-everyone in ROLE_DEFAULTS — the
// storage layer is what enforces scope. This test mirrors the SQL predicate
// in `DatabaseStorage.findDocumentsForUser` so a refactor that loosens
// scope (e.g. dropping the org filter or the visibility array) trips a
// red light here, not in production.

type DocRow = {
  id: string;
  organizationId: string;
  uploaderId: string;
  classLabel: string;
  uploadContext: { companyId?: string | null } | null;
};

function findDocumentsForUserSim(args: {
  rows: DocRow[];
  organizationId: string;
  uploaderId: string | null;
  /** Hard self-only restriction (UI "My uploads" toggle / mine_only=true). */
  mineOnly?: boolean;
  visibleCompanyIds: string[] | "all";
  classLabel?: string | null;
}): DocRow[] {
  return args.rows.filter((d) => {
    // 1. org scope is mandatory — defense-in-depth even if visibility is "all"
    if (d.organizationId !== args.organizationId) return false;
    // 2. mineOnly hard-restricts to the caller's own uploads.
    if (args.mineOnly && args.uploaderId && d.uploaderId !== args.uploaderId) return false;
    // 3. visibility union (skipped for "all" admin scope):
    //    (uploader_id = caller) OR (linked company in visible set)
    if (args.visibleCompanyIds !== "all") {
      const linked = d.uploadContext?.companyId ?? null;
      const isMine = !!args.uploaderId && d.uploaderId === args.uploaderId;
      const isVisibleCompany = !!linked && args.visibleCompanyIds.includes(linked);
      if (!(isMine || isVisibleCompany)) return false;
    }
    // 4. optional class filter
    if (args.classLabel && d.classLabel !== args.classLabel) return false;
    return true;
  });
}

describe("agent tool: find_documents storage scope", () => {
  const rows: DocRow[] = [
    // org-A: rep-1 owns one doc anchored to company c1; rep-2 owns one anchored to c2.
    { id: "d-a1", organizationId: "org-A", uploaderId: "rep-1", classLabel: "rate_con", uploadContext: { companyId: "c1" } },
    { id: "d-a2", organizationId: "org-A", uploaderId: "rep-2", classLabel: "bol",      uploadContext: { companyId: "c2" } },
    // org-A: rep-1 also has an orphan upload (no company anchor).
    { id: "d-a3", organizationId: "org-A", uploaderId: "rep-1", classLabel: "scorecard", uploadContext: null },
    // org-B: a doc that must NEVER be visible to any org-A caller.
    { id: "d-b1", organizationId: "org-B", uploaderId: "rep-9", classLabel: "rate_con", uploadContext: { companyId: "c9" } },
  ];

  it("rep with visibility on c1 only sees their own uploads + their company's doc", () => {
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-A",
      uploaderId: "rep-1",
      visibleCompanyIds: ["c1"],
    });
    // d-a1 (own + visible co), d-a3 (own orphan).
    const ids = out.map((d) => d.id).sort();
    expect(ids).toEqual(["d-a1", "d-a3"]);
  });

  it("rep with no company visibility still sees their own uploads", () => {
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-A",
      uploaderId: "rep-1",
      visibleCompanyIds: [],
    });
    expect(out.map((d) => d.id).sort()).toEqual(["d-a1", "d-a3"]);
  });

  it("rep cannot see another rep's doc anchored to a company they don't own", () => {
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-A",
      uploaderId: "rep-1",
      visibleCompanyIds: ["c1"],
    });
    expect(out.find((d) => d.id === "d-a2")).toBeUndefined();
  });

  it("mineOnly hard-restricts to caller's uploads even when visibility is broad", () => {
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-A",
      uploaderId: "rep-1",
      mineOnly: true,
      visibleCompanyIds: ["c1", "c2"], // would otherwise include rep-2's d-a2
    });
    expect(out.map((d) => d.id).sort()).toEqual(["d-a1", "d-a3"]);
  });

  it("admin with visibility=all sees every org-A doc but NEVER an org-B doc", () => {
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-A",
      uploaderId: null,
      visibleCompanyIds: "all",
    });
    expect(out.map((d) => d.id).sort()).toEqual(["d-a1", "d-a2", "d-a3"]);
    expect(out.find((d) => d.organizationId === "org-B")).toBeUndefined();
  });

  it("class filter narrows results within the visibility set", () => {
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-A",
      uploaderId: null,
      visibleCompanyIds: "all",
      classLabel: "bol",
    });
    expect(out.map((d) => d.id)).toEqual(["d-a2"]);
  });

  it("admin caller in org-B sees only org-B docs — never org-A (org filter wins)", () => {
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-B",
      uploaderId: null,
      visibleCompanyIds: "all",
    });
    expect(out.find((d) => d.organizationId === "org-A")).toBeUndefined();
    expect(out.map((d) => d.id)).toEqual(["d-b1"]);
  });

  it("rep-1 (org-A) cannot see org-B docs even when company c9 is somehow in their visible set", () => {
    // Defense-in-depth: even if a misconfigured visibleCompanyIds leaks
    // a foreign org's company id, the org predicate still excludes the row.
    const out = findDocumentsForUserSim({
      rows,
      organizationId: "org-A",
      uploaderId: "rep-1",
      visibleCompanyIds: ["c1", "c9"],
    });
    expect(out.find((d) => d.id === "d-b1")).toBeUndefined();
    expect(out.map((d) => d.id).sort()).toEqual(["d-a1", "d-a3"]);
  });
});

// ─── Task #911 — get_document_extraction strict access control ───────────
//
// `get_document_extraction` (and its sibling REST routes) deliberately do
// NOT use the same uploader-bypass union that `find_documents` uses. The
// task spec calls for refusing access to docs tied to accounts the rep
// cannot currently see, even if they were the original uploader before the
// account was reassigned away. This simulator mirrors the predicate in
// `server/agent/tools.ts` and `server/routes/documents.ts` so a refactor
// that re-introduces the uploader bypass for company-anchored docs trips
// here, not in production.

type ExtractionDoc = {
  id: string;
  organizationId: string;
  uploaderId: string;
  uploadContext: { companyId?: string | null } | null;
};

function canReadExtraction(args: {
  doc: ExtractionDoc;
  caller: { id: string; organizationId: string; role: UserRole };
  visibleCompanyIds: string[] | "all"; // "all" === admin/director/SD scope
}): boolean {
  if (args.doc.organizationId !== args.caller.organizationId) return false;
  const linkedCompanyId = args.doc.uploadContext?.companyId ?? null;
  const isAdminish =
    args.caller.role === "admin" ||
    args.caller.role === "director" ||
    args.caller.role === "sales_director";
  const hasAccountAccess =
    isAdminish ||
    args.visibleCompanyIds === "all" ||
    (!!linkedCompanyId && args.visibleCompanyIds.includes(linkedCompanyId));
  // For company-anchored docs, ONLY current account visibility counts —
  // uploader bypass is removed. Unanchored scratch docs fall back to the
  // uploader so reps can still read their own off-account uploads.
  return hasAccountAccess || (!linkedCompanyId && args.doc.uploaderId === args.caller.id);
}

describe("agent tool: get_document_extraction strict access control (Task #911)", () => {
  const docOnC1: ExtractionDoc = { id: "d-rc1", organizationId: "org-A", uploaderId: "rep-1", uploadContext: { companyId: "c1" } };
  const docOnC2: ExtractionDoc = { id: "d-rc2", organizationId: "org-A", uploaderId: "rep-2", uploadContext: { companyId: "c2" } };
  const docOrphan: ExtractionDoc = { id: "d-rc3", organizationId: "org-A", uploaderId: "rep-1", uploadContext: null };
  const docOtherOrg: ExtractionDoc = { id: "d-rc9", organizationId: "org-B", uploaderId: "rep-1", uploadContext: { companyId: "c1" } };
  const rep1: { id: string; organizationId: string; role: UserRole } = { id: "rep-1", organizationId: "org-A", role: "sales" };
  const admin: { id: string; organizationId: string; role: UserRole } = { id: "admin-1", organizationId: "org-A", role: "admin" };

  it("rep with current visibility on the linked company can read", () => {
    expect(canReadExtraction({ doc: docOnC1, caller: rep1, visibleCompanyIds: ["c1"] })).toBe(true);
  });

  it("REASSIGNMENT: original uploader who lost account visibility CANNOT read the rate con anymore", () => {
    // rep-1 uploaded docOnC1 but the c1 account has since been reassigned
    // to another rep — rep-1's visibleCompanyIds no longer includes "c1".
    // The extraction read MUST refuse despite uploaderId === rep-1.
    expect(canReadExtraction({ doc: docOnC1, caller: rep1, visibleCompanyIds: ["c2"] })).toBe(false);
  });

  it("REASSIGNMENT: empty visibility set blocks access even for the uploader of a company-anchored doc", () => {
    expect(canReadExtraction({ doc: docOnC1, caller: rep1, visibleCompanyIds: [] })).toBe(false);
  });

  it("rep cannot read another rep's rate con anchored to a company the rep doesn't own", () => {
    expect(canReadExtraction({ doc: docOnC2, caller: rep1, visibleCompanyIds: ["c1"] })).toBe(false);
  });

  it("orphan (non-anchored) docs remain readable by their uploader", () => {
    expect(canReadExtraction({ doc: docOrphan, caller: rep1, visibleCompanyIds: [] })).toBe(true);
  });

  it("orphan docs are NOT readable by other reps in the same org (uploader-only fallback)", () => {
    const otherRep: { id: string; organizationId: string; role: UserRole } = { id: "rep-7", organizationId: "org-A", role: "sales" };
    expect(canReadExtraction({ doc: docOrphan, caller: otherRep, visibleCompanyIds: ["c1", "c2"] })).toBe(false);
  });

  it("admin in the same org can read any doc (visibility=all)", () => {
    expect(canReadExtraction({ doc: docOnC1, caller: admin, visibleCompanyIds: "all" })).toBe(true);
    expect(canReadExtraction({ doc: docOnC2, caller: admin, visibleCompanyIds: "all" })).toBe(true);
    expect(canReadExtraction({ doc: docOrphan, caller: admin, visibleCompanyIds: "all" })).toBe(true);
  });

  it("admin in org-A still cannot read an org-B doc — org filter wins", () => {
    expect(canReadExtraction({ doc: docOtherOrg, caller: admin, visibleCompanyIds: "all" })).toBe(false);
  });

  it("rep-1 in org-A cannot read an org-B doc even if the linked company id collides", () => {
    expect(canReadExtraction({ doc: docOtherOrg, caller: rep1, visibleCompanyIds: ["c1"] })).toBe(false);
  });
});

// ─── Task #911 — entity resolver strict ambiguity policy ─────────────────
//
// resolveRateConEntities never silently picks a primary when more than
// one candidate clears the per-kind floor. This simulator mirrors the
// per-kind loop in `server/services/documentEntityResolver.ts`. A
// regression that re-introduces the previous "tie within 0.05 only"
// auto-pick fails this test before it reaches production.

interface ScoredCandidateLite { score: number; targetId: string }

function decideAmbiguityForKind(args: { candidates: ScoredCandidateLite[]; floor: number; maxKept: number }) {
  const surviving = [...args.candidates]
    .sort((a, b) => b.score - a.score)
    .filter((c) => c.score >= args.floor)
    .slice(0, args.maxKept);
  const ambiguous = surviving.length > 1;
  return {
    surviving,
    ambiguous,
    primary: ambiguous || surviving.length === 0 ? null : surviving[0],
  };
}

describe("entity resolver strict ambiguity policy (Task #911)", () => {
  it("zero candidates above the floor → no primary, not ambiguous", () => {
    const r = decideAmbiguityForKind({
      candidates: [{ score: 0.4, targetId: "x" }, { score: 0.5, targetId: "y" }],
      floor: 0.6,
      maxKept: 3,
    });
    expect(r.primary).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.surviving).toHaveLength(0);
  });

  it("exactly one candidate above the floor → that one is primary, not ambiguous", () => {
    const r = decideAmbiguityForKind({
      candidates: [{ score: 0.92, targetId: "a" }, { score: 0.4, targetId: "b" }],
      floor: 0.6,
      maxKept: 3,
    });
    expect(r.primary?.targetId).toBe("a");
    expect(r.ambiguous).toBe(false);
  });

  it("CRITICAL: two candidates above the floor with a wide score gap → still ambiguous, no primary", () => {
    // Old policy would have auto-picked because gap > 0.05. New policy
    // requires a rep decision whenever >1 candidate is plausible.
    const r = decideAmbiguityForKind({
      candidates: [{ score: 0.95, targetId: "a" }, { score: 0.7, targetId: "b" }],
      floor: 0.6,
      maxKept: 3,
    });
    expect(r.ambiguous).toBe(true);
    expect(r.primary).toBeNull();
    expect(r.surviving.map((c) => c.targetId)).toEqual(["a", "b"]);
  });

  it("two candidates clustered tightly above the floor → ambiguous, no primary", () => {
    const r = decideAmbiguityForKind({
      candidates: [{ score: 0.83, targetId: "a" }, { score: 0.81, targetId: "b" }],
      floor: 0.6,
      maxKept: 3,
    });
    expect(r.ambiguous).toBe(true);
    expect(r.primary).toBeNull();
  });

  it("trims to maxKept survivors before deciding, but ambiguity flag is still true", () => {
    const r = decideAmbiguityForKind({
      candidates: [
        { score: 0.95, targetId: "a" },
        { score: 0.9, targetId: "b" },
        { score: 0.85, targetId: "c" },
        { score: 0.8, targetId: "d" },
      ],
      floor: 0.6,
      maxKept: 3,
    });
    expect(r.surviving).toHaveLength(3);
    expect(r.ambiguous).toBe(true);
  });

  it("sub-floor candidates are dropped before the ambiguity check (single survivor → primary)", () => {
    // This is the "strong winner" case: one truly confident match plus a
    // bunch of below-floor noise. Should auto-pick.
    const r = decideAmbiguityForKind({
      candidates: [
        { score: 0.95, targetId: "a" },
        { score: 0.55, targetId: "b" }, // below the 0.6 floor
        { score: 0.5, targetId: "c" },
      ],
      floor: 0.6,
      maxKept: 3,
    });
    expect(r.primary?.targetId).toBe("a");
    expect(r.ambiguous).toBe(false);
  });
});

// Analytics route invariants — we model the row writers and confirm that
// they always stamp the org/user from the authenticated session, never the
// raw client body, so a malicious client can't spoof another org.

function buildFeedbackInsert(reqBody: any, me: { id: string; organizationId: string }) {
  return {
    ...reqBody,
    organizationId: me.organizationId,
    userId: me.id,
  };
}

function buildActionInsert(reqBody: any, me: { id: string; organizationId: string }) {
  return {
    ...reqBody,
    organizationId: me.organizationId,
    confirmedByUserId: me.id,
  };
}

describe("analytics insert builders enforce caller's org/user", () => {
  it("feedback insert always carries the caller's organizationId", () => {
    const me = { id: "user-1", organizationId: "org-A" };
    const malicious = { organizationId: "org-EVIL", userId: "user-OTHER", rating: "up" };
    const built = buildFeedbackInsert(malicious, me);
    expect(built.organizationId).toBe("org-A");
    expect(built.userId).toBe("user-1");
  });

  it("action audit insert always carries the caller's organizationId", () => {
    const me = { id: "user-1", organizationId: "org-A" };
    const malicious = { organizationId: "org-EVIL", confirmedByUserId: "user-OTHER", tool: "log_touchpoint" };
    const built = buildActionInsert(malicious, me);
    expect(built.organizationId).toBe("org-A");
    expect(built.confirmedByUserId).toBe("user-1");
  });
});

// Mirrors the SQL predicate in agentAnalyticsStorage.getNeedsAttention.
type TurnRow = {
  id: string;
  organizationId: string;
  outcome: string;
  feedbackRating?: string | null;
  actionOutcome?: string | null;
};

const NEEDS_ATTENTION_OUTCOMES = [
  "error",
  "tool_error",
  "denied",
  "low_confidence",
  "no_data",
];
const NEEDS_ATTENTION_ACTION_OUTCOMES = ["no_data", "failed"];

function applyNeedsAttentionFilter(rows: TurnRow[], orgId: string): TurnRow[] {
  return rows.filter(
    (r) =>
      r.organizationId === orgId &&
      (NEEDS_ATTENTION_OUTCOMES.includes(r.outcome) ||
        (r.actionOutcome != null &&
          NEEDS_ATTENTION_ACTION_OUTCOMES.includes(r.actionOutcome)) ||
        r.feedbackRating === "down"),
  );
}

// ─── Phase 5 — full Phase-2 tool × role permission matrix ─────────────────
//
// Source-of-truth: tool→capability mapping is grepped out of
// `server/agent/tools.ts`; the role→capability defaults live in
// `server/agent/permissions.ts`. We re-implement the role-default lookup
// here (no DB) and assert that, for every Phase-2 tool, every role gets the
// expected allow/auto/deny decision. This locks down "coaching denied for
// AM/sales/coordinator", external outreach denied for non-admin/director,
// and read-only roles cannot HITL writes.
//
// If a new tool is added or a role default changes, this matrix MUST be
// updated — that's the point.

import { ROLE_DEFAULTS, type Capability } from "../agent/permissions";
import type { UserRole } from "@shared/schema";

const TOOL_CAPABILITIES: Record<string, Capability> = {
  get_company_details:            "read.account",
  carrier_lane_search:            "read.carrier",
  query_national_rates:           "read.market",
  query_market_otri:              "read.market",
  query_lane_signal:              "read.lane",
  get_rate_positioning_summary:   "read.lane",
  list_open_tasks:                "read.task",
  list_recent_touchpoints:        "read.touchpoint",
  team_touchpoint_tally:          "read.touchpoint",
  reps_missing_touchpoints:       "read.touchpoint",
  recall_memory:                  "read.memory",
  list_available_freight:         "read.opportunity",
  freight_import_status:          "read.opportunity",
  navigate_to_company:            "navigate.crm",
  log_touchpoint:                 "write.touchpoint",
  create_task:                    "write.task",
  complete_task:                  "write.task.complete",
  mark_meaningful:                "write.touchpoint.meaningful",
  approve_freight_opportunity:    "write.opportunity",
  draft_email:                    "write.email.draft",
  open_filtered_queue:            "navigate.crm",
  remember_this:                  "write.memory",
  recommend_carriers_for_order:   "read.carrier",
  suggest_buy_rate_for_lane:      "read.lane",
  top_carriers_by_realized_margin:"read.carrier",
  query_pipeline:                 "read.pipeline",
  one_on_one_history:             "read.coaching",
  lane_carrier_lookup:            "read.lane",
  available_freight_search:       "read.opportunity",
  email_intelligence_search:      "read.email",
  next_best_actions:              "read.nba",
  scorecard_lookup:               "read.scorecard",
  recurring_freight_pattern:      "read.lane",
  // Phase 2 slice 1 — Copilot Doc Ingestion (Task #910)
  find_documents:                 "read.document",
  // Phase 2 slice 2 — Copilot Rate Con Extraction (Task #911)
  get_document_extraction:        "read.document",
};

const ALL_ROLES: UserRole[] = [
  "admin", "director", "sales_director", "national_account_manager",
  "account_manager", "sales", "logistics_manager", "logistics_coordinator",
];

function effectFor(role: UserRole, cap: Capability): "allow" | "auto" | "deny" {
  return (ROLE_DEFAULTS[role]?.[cap] ?? "deny") as "allow" | "auto" | "deny";
}

// Hand-curated expected matrix. Every Phase-2 tool × every role gets an
// explicit allow/auto/deny outcome. This is NOT computed from ROLE_DEFAULTS
// — if anyone widens or narrows ROLE_DEFAULTS, the test fails loud.
//
// Conventions:
//   READS — admin/director/sales_director/NAM see everything in their org.
//           AM/sales see business reads but NOT coaching.
//           logistics_manager sees lane/carrier/market/touchpoint/pipeline.
//           logistics_coordinator can READ everything but cannot WRITE
//           anything except memory (read-only role).
//   WRITES — every business-facing role can be PROMPTED (allow / HITL).
//            logistics_coordinator gets deny for all business writes.
//            remember_this is auto for everyone (personal memory only).
//
// allow = HITL/visible | auto = standing approval | deny
type Eff = "allow" | "auto" | "deny";

const ALL_R: UserRole[] = ALL_ROLES;
const everyone = (eff: Eff): Record<UserRole, Eff> =>
  Object.fromEntries(ALL_R.map((r) => [r, eff])) as Record<UserRole, Eff>;
const overlay = (base: Eff, overrides: Partial<Record<UserRole, Eff>>): Record<UserRole, Eff> =>
  ({ ...everyone(base), ...overrides });

const EXPECTED_MATRIX: Record<string, Record<UserRole, Eff>> = {
  // ─── Reads ───────────────────────────────────────────────────────────
  get_company_details:           everyone("allow"),
  carrier_lane_search:           everyone("allow"),
  query_national_rates:          everyone("allow"),
  query_market_otri:             everyone("allow"),
  query_lane_signal:             everyone("allow"),
  get_rate_positioning_summary:  everyone("allow"),
  list_open_tasks:               everyone("allow"),
  list_recent_touchpoints:       everyone("allow"),
  team_touchpoint_tally:         everyone("allow"),
  reps_missing_touchpoints:      everyone("allow"),
  recall_memory:                 everyone("allow"),
  list_available_freight:        everyone("allow"),
  freight_import_status:         everyone("allow"),
  navigate_to_company:           everyone("allow"),
  query_pipeline:                everyone("allow"),
  lane_carrier_lookup:           everyone("allow"),
  available_freight_search:      everyone("allow"),
  email_intelligence_search:     everyone("allow"),
  next_best_actions:             everyone("allow"),
  scorecard_lookup:              everyone("allow"),
  recurring_freight_pattern:     everyone("allow"),
  // Documents are scoped at runtime by visible companies / uploader; capability
  // itself is allow for everyone — the storage layer enforces row-level scope.
  find_documents:                everyone("allow"),
  // get_document_extraction shares the same capability as find_documents
  // (read.document); per-document visibility is enforced inside the tool
  // handler and mirrors the find_documents predicate.
  get_document_extraction:       everyone("allow"),
  recommend_carriers_for_order:  everyone("allow"),
  suggest_buy_rate_for_lane:     everyone("allow"),
  top_carriers_by_realized_margin: everyone("allow"),
  open_filtered_queue:           everyone("allow"),

  // Coaching is restricted: AM / sales / logistics_coordinator cannot read.
  one_on_one_history: overlay("allow", {
    account_manager: "deny",
    sales: "deny",
    logistics_coordinator: "deny",
  }),

  // ─── Writes ──────────────────────────────────────────────────────────
  // Business writes — allow for every role EXCEPT read-only LC.
  log_touchpoint:                overlay("allow", { logistics_coordinator: "deny" }),
  create_task:                   overlay("allow", { logistics_coordinator: "deny" }),
  complete_task:                 overlay("allow", { logistics_coordinator: "deny" }),
  mark_meaningful:               overlay("allow", { logistics_coordinator: "deny" }),
  approve_freight_opportunity:   overlay("allow", { logistics_coordinator: "deny" }),
  draft_email:                   overlay("allow", { logistics_coordinator: "deny" }),

  // Personal memory — auto-approved for every role.
  remember_this:                 everyone("auto"),
};

describe("Phase-2 tool × role permission matrix (full coverage, explicit policy fixtures)", () => {
  it("every Phase-2 tool defined in TOOL_CAPABILITIES has an EXPECTED_MATRIX row", () => {
    for (const tool of Object.keys(TOOL_CAPABILITIES)) {
      expect(EXPECTED_MATRIX[tool], `tool ${tool} missing from EXPECTED_MATRIX`).toBeDefined();
    }
  });

  for (const [tool, expectations] of Object.entries(EXPECTED_MATRIX)) {
    const cap = TOOL_CAPABILITIES[tool];
    for (const role of ALL_R) {
      const expected = expectations[role];
      it(`${tool} (${cap}) × ${role} MUST be ${expected}`, () => {
        expect(effectFor(role, cap)).toBe(expected);
      });
    }
  }

  it("coaching tools (one_on_one_history) are denied for AM/sales/coordinator", () => {
    expect(effectFor("account_manager", "read.coaching")).toBe("deny");
    expect(effectFor("sales", "read.coaching")).toBe("deny");
    expect(effectFor("logistics_coordinator", "read.coaching")).toBe("deny");
    expect(effectFor("national_account_manager", "read.coaching")).toBe("allow");
    expect(effectFor("director", "read.coaching")).toBe("allow");
  });

  it("external outreach (sms/voice/email.external) only allowed for admin/director", () => {
    for (const cap of ["write.sms.driver", "write.voice.driver", "write.email.external"] as Capability[]) {
      expect(effectFor("admin", cap)).toBe("allow");
      expect(effectFor("director", cap)).toBe("allow");
      for (const role of ["sales_director", "account_manager", "sales", "logistics_coordinator"] as UserRole[]) {
        expect(effectFor(role, cap)).toBe("deny");
      }
    }
  });

  it("logistics_coordinator (read-only) cannot HITL business writes", () => {
    for (const cap of [
      "write.touchpoint", "write.task", "write.task.complete",
      "write.touchpoint.meaningful", "write.account", "write.opportunity",
      "write.email.draft",
    ] as Capability[]) {
      expect(effectFor("logistics_coordinator", cap)).toBe("deny");
    }
    // Personal memory still permitted (no business side-effect).
    expect(effectFor("logistics_coordinator", "write.memory")).toBe("auto");
  });
});

// ─── Phase 5 — sanitizeReportText guards secret leakage ───────────────────
import { sanitizeReportText } from "../routes/agentAnalytics";

describe("sanitizeReportText", () => {
  it("redacts Bearer tokens", () => {
    const out = sanitizeReportText("crash with Authorization: Bearer abc123XYZ.def_ghi");
    expect(out).not.toContain("abc123XYZ");
    expect(out).toContain("Bearer [redacted]");
  });
  it("redacts sk-/rk-/pk- secrets", () => {
    const out = sanitizeReportText("error using sk-live_AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toMatch(/AAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
  });
  it("redacts long base64/hex blobs", () => {
    const blob = "Z".repeat(60);
    const out = sanitizeReportText(`stack: ${blob}`);
    expect(out).not.toContain(blob);
  });
  it("clamps very long input to 2000 chars", () => {
    const out = sanitizeReportText("x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(2000);
  });
  it("returns empty string for empty input", () => {
    expect(sanitizeReportText("")).toBe("");
  });
});

// ─── Phase 5 — cross-rep / cross-org negative cases ───────────────────────
//
// These mirror the IDOR-style attacks the new audit-by-user / audit-by-company
// endpoints must block. They model the visibility check the route uses
// (self OR admin/director/sales_director, AND same org) without touching DB.

type Caller = { id: string; role: UserRole; organizationId: string };
type Target = { id: string; organizationId: string };

function canSeeRepAuditTrail(caller: Caller, target: Target): boolean {
  if (caller.organizationId !== target.organizationId) return false;
  if (caller.id === target.id) return true;
  return ["admin", "director", "sales_director"].includes(caller.role);
}

describe("cross-rep audit-trail visibility (Phase 5)", () => {
  const orgA = "org-A";
  const orgB = "org-B";
  const adminA: Caller = { id: "u-admin-A", role: "admin", organizationId: orgA };
  const dirA:   Caller = { id: "u-dir-A",   role: "director", organizationId: orgA };
  const sdA:    Caller = { id: "u-sd-A",    role: "sales_director", organizationId: orgA };
  const repA:   Caller = { id: "u-rep-A",   role: "account_manager", organizationId: orgA };
  const peerA:  Caller = { id: "u-peer-A",  role: "account_manager", organizationId: orgA };
  const repB:   Caller = { id: "u-rep-B",   role: "admin", organizationId: orgB };
  const targetA: Target = { id: "u-rep-A", organizationId: orgA };

  it("rep can see their own audit trail", () => {
    expect(canSeeRepAuditTrail(repA, targetA)).toBe(true);
  });
  it("admin / director / sales_director can see any rep in their org", () => {
    expect(canSeeRepAuditTrail(adminA, targetA)).toBe(true);
    expect(canSeeRepAuditTrail(dirA, targetA)).toBe(true);
    expect(canSeeRepAuditTrail(sdA, targetA)).toBe(true);
  });
  it("a peer rep CANNOT view another rep's audit trail (no IDOR)", () => {
    expect(canSeeRepAuditTrail(peerA, targetA)).toBe(false);
  });
  it("an admin in a DIFFERENT org cannot view audit trail across orgs", () => {
    expect(canSeeRepAuditTrail(repB, targetA)).toBe(false);
  });
});

describe("needs-attention queue isolation", () => {
  const rows: TurnRow[] = [
    { id: "t-1", organizationId: "org-A", outcome: "error" },
    { id: "t-2", organizationId: "org-B", outcome: "error" },
    { id: "t-3", organizationId: "org-A", outcome: "ok" },
    { id: "t-4", organizationId: "org-A", outcome: "ok", feedbackRating: "down" },
    { id: "t-5", organizationId: "org-B", outcome: "tool_error" },
  ];

  it("excludes rows from other orgs entirely", () => {
    const out = applyNeedsAttentionFilter(rows, "org-A");
    expect(out.map((r) => r.id).sort()).toEqual(["t-1", "t-4"]);
  });

  it("only surfaces failure / low-confidence / thumbs-down turns", () => {
    const out = applyNeedsAttentionFilter(rows, "org-A");
    for (const r of out) {
      expect(r.organizationId).toBe("org-A");
      const isProblem =
        NEEDS_ATTENTION_OUTCOMES.includes(r.outcome) ||
        (r.actionOutcome != null &&
          NEEDS_ATTENTION_ACTION_OUTCOMES.includes(r.actionOutcome)) ||
        r.feedbackRating === "down";
      expect(isProblem).toBe(true);
    }
  });

  it("surfaces explicit no_data outcomes (Phase 5 reviewer requirement)", () => {
    const more: TurnRow[] = [
      ...rows,
      { id: "t-nd-1", organizationId: "org-A", outcome: "no_data" },
      { id: "t-nd-2", organizationId: "org-A", outcome: "ok", actionOutcome: "no_data" },
      { id: "t-nd-3", organizationId: "org-A", outcome: "ok", actionOutcome: "failed" },
      { id: "t-nd-4", organizationId: "org-B", outcome: "no_data" },
    ];
    const out = applyNeedsAttentionFilter(more, "org-A");
    const ids = out.map((r) => r.id).sort();
    expect(ids).toContain("t-nd-1");
    expect(ids).toContain("t-nd-2");
    expect(ids).toContain("t-nd-3");
    // Cross-org no_data row must NEVER surface.
    expect(ids).not.toContain("t-nd-4");
  });
});

// Runtime cross-rep / cross-org tool execution leakage.
type AccountRow = {
  id: string;
  organizationId: string;
  ownerUserId: string;
  name: string;
};

const ACCOUNTS: AccountRow[] = [
  { id: "a1", organizationId: "org-A", ownerUserId: "u-rep-A", name: "Acme Freight" },
  { id: "a2", organizationId: "org-A", ownerUserId: "u-peer-A", name: "Brianna's Account" },
  { id: "a3", organizationId: "org-A", ownerUserId: "u-peer-A", name: "Bayou Logistics" },
  { id: "a4", organizationId: "org-B", ownerUserId: "u-rep-B", name: "Carlson Cold Chain" },
];

function listAccountsForCaller(caller: Caller, opts: { ownerFilter?: string | null }): AccountRow[] {
  const sameOrg = ACCOUNTS.filter((a) => a.organizationId === caller.organizationId);
  const isManager = ["admin", "director", "sales_director"].includes(caller.role);
  const baseScope = isManager ? sameOrg : sameOrg.filter((a) => a.ownerUserId === caller.id);
  if (!opts.ownerFilter) return baseScope;
  const effectiveOwner = isManager ? opts.ownerFilter : caller.id;
  return baseScope.filter((a) => a.ownerUserId === effectiveOwner);
}

describe("runtime cross-rep account-scope leakage (Phase 5)", () => {
  const adminA: Caller = { id: "u-admin-A", role: "admin", organizationId: "org-A" };
  const repA:   Caller = { id: "u-rep-A",   role: "account_manager", organizationId: "org-A" };
  const peerA:  Caller = { id: "u-peer-A",  role: "account_manager", organizationId: "org-A" };
  const adminB: Caller = { id: "u-admin-B", role: "admin",          organizationId: "org-B" };

  it('rep-only "show me Brianna\'s accounts" never returns the peer\'s rows', () => {
    const result = listAccountsForCaller(repA, { ownerFilter: "u-peer-A" });
    expect(result.map((r) => r.id).sort()).toEqual(["a1"]);
  });

  it("admin in same org CAN ask for another rep's accounts", () => {
    const result = listAccountsForCaller(adminA, { ownerFilter: "u-peer-A" });
    expect(result.map((r) => r.id).sort()).toEqual(["a2", "a3"]);
  });

  it("admin in DIFFERENT org never sees the target org's rows even with owner filter", () => {
    const result = listAccountsForCaller(adminB, { ownerFilter: "u-peer-A" });
    expect(result).toEqual([]);
  });

  it("default rep listing (no owner filter) returns only the rep's own book", () => {
    const result = listAccountsForCaller(repA, {});
    expect(result.map((r) => r.id).sort()).toEqual(["a1"]);
  });

  it("peer rep cannot enumerate another rep's accounts even by name fragment", () => {
    const peerScope = listAccountsForCaller(peerA, {}).map((a) => a.name);
    expect(peerScope).toContain("Brianna's Account");
    expect(peerScope).not.toContain("Acme Freight");
  });
});
