import type { Express, Request } from "express";
import { z, type ZodIssue } from "zod";
import { getCurrentUser, requireAuth, requireUser } from "../auth";
import {
  getSnapshot, getQuoteDetail, getQuoteFreshness,
  listQuotes, listSavedViews, createSavedView, deleteSavedView, updateSavedView, exportCsv,
  createQuote, updateQuote,
  getPricingIntelligence,
  searchSpotQuote, laneAutocomplete,
  purgeDemoSeed,
  createQuoteCustomer,
  setCustomerPartyType,
  setQuoteCustomerOwner,
  getQuoteCustomerWithOwner,
  findQuoteCustomerByName,
  clearPartyTypeBackfillCache,
  getActionQueue,
  bulkReassignCustomerForQuotes,
  bulkSetQuoteStatus,
  getAutoWonQuoteAfHandoffEnabled,
  setAutoWonQuoteAfHandoffEnabled,
  getFunnel,
  getFunnelDiagnostics,
  getLeakedQuoteEmails,
  getLeakAnalytics,
  reviewLeakRow,
  manuallyCreateQuoteFromLeakRow,
  attachOrphanOutboundToQuote,
  listAttachCandidateQuotes,
  listNewContactReviews,
  resolveNewContactReview,
  resolveFunnelRepScope,
  markQuoteOutcome,
  type ManualMarkOutcomeStatus,
  type QuoteFilters, type ListSortKey,
} from "../services/customerQuotes";
import { QUOTE_PARTY_TYPES, CAPTURE_LEAK_TYPES, CAPTURE_LEAK_REVIEW_DECISIONS, senderRoutingRules, quotePipelineDrops, SENDER_ROUTING_DECISIONS } from "@shared/schema";
import { syncQuoteOutcomesFromTms } from "../services/quoteTmsSync";
import { backfillQuotesFromEmails, ensureEmailBackfill, getEmailBackfillStatus } from "../services/quoteEmailIngestion";
import {
  getPricingRecommendation,
  getMarginFloors,
  setMarginFloors,
} from "../services/quotePricingRecommendation";
import { QUOTE_OUTCOME_STATUSES, QUOTE_SOURCES, companies, contacts, quoteReps, spotQuoteCreateSchema } from "@shared/schema";
import {
  getFreightCaptureRepAudit,
  linkRepToUser,
  setRepSuppressed,
  mergeReps,
  searchOrgUsers,
  REP_AUDIT_LOOKBACK_DAYS,
} from "../services/freightCaptureRepAudit";
import { getStaleQuoteFollowUps, getStaleQuoteFollowUpCount, clearStaleFollowUpCache } from "../services/staleQuoteFollowup";
import { publish as publishLiveSync } from "../services/liveSync";
import { db, storage } from "../storage";
import { quoteOpportunities } from "@shared/schema";
import { and as andSql, eq as eqSql, inArray as inArraySql, isNull as isNullSql, sql as sqlExpr } from "drizzle-orm";

// =============================================================================
// Task #849 §6.1 — Quote-mutation ownership gate (security fix folded into S1).
//
// Before this fix, the mutation routes below either gated only on `requireUser`
// (PATCH /quote/:id, bulk-reassign-customer, bulk-status) or relied on the
// service layer to enforce rep scope (mark-outcome). The architect review of
// docs/quote-requests-tab-post-2d-backend-contract.md flagged both as a
// broken-access-control vector — any rep in an org could mutate any other
// rep's opp by guessing or listing the id, and the service-only gate could
// silently disappear in a future refactor. This helper closes the gap.
//
// Contract:
//   • Elevated roles (admin / director / sales_director) — pass.
//   • The `national_account_manager` and `sales` roles are also treated as
//     elevated for this purpose because `resolveFunnelRepScope` already
//     does — they're org-wide visibility roles that route through the
//     funnel without a per-rep restriction.
//   • Scoped roles (account_manager / logistics_manager etc.) — must own
//     EVERY id in the requested set. "Own" = `quote_opportunities.repId`
//     resolves to the same `quote_reps.id` the user is linked to via
//     `quote_reps.userId`. Cross-rep attempts get 403 with the denied ids
//     so the UI can show a precise message instead of a generic forbidden.
//   • Scoped role with no rep mapping at all (`__none__`) — 403, can't
//     own any quote.
//   • Unknown / hidden / different-org id → 404 (org-isolation, never
//     leak existence).
//
// Returns a discriminated union so callers can early-return cleanly without
// throwing across the request-handler boundary.
// =============================================================================
type MutationGateResult =
  | { ok: true }
  | { ok: false; status: 403; reason: "forbidden" | "no_rep_mapping"; deniedIds?: string[] }
  | { ok: false; status: 404; reason: "not_found"; missingIds?: string[] };

export async function assertCanMutateQuotes(
  orgId: string,
  oppIds: string[],
  user: { id: string; role: string },
): Promise<MutationGateResult> {
  if (oppIds.length === 0) return { ok: true };
  // Org-isolation first: confirm every requested id exists in this org.
  // This doubles as the 404 check — if any id is missing, the caller
  // never learns whether it's in a different org or doesn't exist at all.
  const rows = await db
    .select({ id: quoteOpportunities.id, repId: quoteOpportunities.repId })
    .from(quoteOpportunities)
    .where(andSql(
      eqSql(quoteOpportunities.organizationId, orgId),
      inArraySql(quoteOpportunities.id, oppIds),
    ));
  if (rows.length !== oppIds.length) {
    const found = new Set(rows.map(r => r.id));
    const missingIds = oppIds.filter(id => !found.has(id));
    return { ok: false, status: 404, reason: "not_found", missingIds };
  }
  const scope = await resolveFunnelRepScope(orgId, { id: user.id, role: user.role });
  if (scope === null) {
    // Elevated — no per-rep restriction.
    return { ok: true };
  }
  if (scope === "__none__") {
    return { ok: false, status: 403, reason: "no_rep_mapping" };
  }
  const deniedIds = rows.filter(r => r.repId !== scope).map(r => r.id);
  if (deniedIds.length > 0) {
    return { ok: false, status: 403, reason: "forbidden", deniedIds };
  }
  return { ok: true };
}

/** Single-id convenience wrapper. */
export async function assertCanMutateQuote(
  orgId: string,
  oppId: string,
  user: { id: string; role: string },
): Promise<MutationGateResult> {
  return assertCanMutateQuotes(orgId, [oppId], user);
}
import { gatherDataAnchors, generateDraft } from "./emailDrafting";
import { getVoiceProfile } from "../voiceProfileService";
import { listMappings, deleteMapping } from "../services/quoteSenderMappings";
import {
  attachQuoteToTarget,
  sendQuoteToLeak,
  snoozeQuote,
  SNOOZE_QUOTE_LIMITS,
} from "../services/customerQuotes";
import { isQuoteOpportunitiesRole } from "@shared/quoteOpportunitiesRoles";
import multer from "multer";
import {
  parseQuoteIntakeFromText,
  parseQuoteIntakeFromImage,
  MAX_INTAKE_IMAGE_BYTES,
  MAX_INTAKE_TEXT_BYTES,
} from "../services/spotQuoteIntake";
import { getErrorMessage } from "../lib/errors";
import { pStr, qStr, qInt, qBool } from "../lib/req";

// Minimum margin % guardrail when estimatedCost is supplied. Env-tunable.
const SPOT_MIN_MARGIN_PCT: number = (() => {
  const raw = parseFloat(process.env.SPOT_MIN_MARGIN_PCT ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
})();

const filtersSchema = z.object({
  customerId: z.string().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  equipment: z.string().min(1).optional(),
  repId: z.string().min(1).optional(),
  outcomeStatus: z.string().min(1).optional(),
  outcomeReasonId: z.string().min(1).optional(),
  laneSearch: z.string().min(1).max(120).optional(),
  laneGroupId: z.string().min(1).optional(),
  wonOnly: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  lostOnly: z.boolean().optional(),
  expiringOnly: z.boolean().optional(),
  // Task #615 — accepted but ignored. Kept on the schema so old saved-view
  // rows (and any old client builds during deploy) don't 400 the request;
  // the service layer now hard-filters every non-customer row.
  needsReviewOnly: z.boolean().optional(),
  // Task #850 — UI "Mine only" toggle. Resolved server-side to the
  // requesting user's quote_reps.id; if the user has no rep mapping the
  // filter degrades to "show nothing" via a sentinel repId so the UI
  // doesn't accidentally widen scope.
  mineOnly: z.boolean().optional(),
  // Task #850 — UI "Include snoozed" toggle. When false/undefined the
  // service hides rows whose `snoozedUntil` is still in the future.
  includeSnoozed: z.boolean().optional(),
});
// NOTE: not `.strict()`. parseFilters and applyMineOnly run this schema
// against the full `req.query` of the LIST endpoint, which legitimately
// includes sort/offset/limit keys defined by listQuerySchema. Strict mode
// would reject those extras and silently drop EVERY filter (parseFilters
// returns {} on parse failure). Default object mode strips unknown keys
// instead, preserving the declared filter fields. listQuerySchema is the
// authoritative validator for the full list-route payload.

// Task #863 polish — Saved Views persistence schema.
//
// The /quote-requests page tracks filters in a UI-friendly shape
// (status: "new"|"won"|…, age: "today"|"7d"|…, plus client-only knobs
// like freeEmailOnly, domainFilter, pastSlaOnly, search). When the rep
// hits "Save current view…" we POST that exact shape; reload time we
// read it back and feed it straight into the page state setters.
//
// `filtersSchema` above is shaped for the LIST query (outcomeStatus,
// startDate, etc.) and would silently strip every UI-only key. To make
// save → reload round-trip lossless we accept BOTH shapes here, plus
// passthrough so a future client-side filter automatically persists
// without requiring a server change.
export const savedViewFiltersSchema = filtersSchema.extend({
  status: z.string().min(1).max(40).optional(),
  age: z.string().min(1).max(40).optional(),
  freeEmailOnly: z.boolean().optional(),
  pastSlaOnly: z.boolean().optional(),
  domainFilter: z.string().min(1).max(120).nullable().optional(),
  search: z.string().min(0).max(120).optional(),
}).passthrough();

// Exported for regression tests in tests/quote-requests-list-filters.test.ts
// (Task #850 — proves that LIST requests preserve filters even when the
// query string also carries sort/paging keys).
export const queryFiltersSchema = filtersSchema.extend({
  wonOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  activeOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  lostOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  expiringOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  needsReviewOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  mineOnly: z.preprocess(v => v === "true" || v === true || v === "1", z.boolean().optional()),
  includeSnoozed: z.preprocess(v => v === "true" || v === true || v === "1", z.boolean().optional()),
});

// Task #816 — `carrierPaid` / `marginDollar` / `marginPct` were retired
// from the Quote Opportunities surface (the table, drawer, and CSV are
// customer-only). Keep them tolerated by the route schema as a free-form
// string so a stale saved view that still references one doesn't 400 the
// list endpoint; the service layer's sort switch falls back to the
// default request-date ordering for any unknown sort key.
const KNOWN_SORT_KEYS = new Set<string>([
  "requestDate", "customerName", "originCity", "destCity", "equipment",
  "quotedAmount", "validThrough", "outcomeStatus", "outcomeReasonLabel",
  "repName", "responseTimeHours", "source", "score",
]);

const listQuerySchema = queryFiltersSchema.extend({
  sortKey: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  offset: z.preprocess(v => v === undefined ? 0 : Number(v), z.number().int().min(0).max(100000)),
  limit: z.preprocess(v => v === undefined ? 50 : Number(v), z.number().int().min(1).max(500)),
});

// Task #1148 — Telemetry for silently-dropped filter keys.
//
// `filtersSchema` is intentionally non-strict (see comment above) so that
// list/snapshot requests carrying sort/paging keys don't 400 and silently
// drop every filter. The symmetrical risk: a typo'd or stale filter key
// from a future client build (e.g. `?lostOnly2=true`) is silently ignored
// and the rep sees an unfiltered queue with no signal anywhere.
//
// `logDroppedFilterKeys` diffs the request's query keys against the union
// of the declared `filtersSchema` keys and the well-known list-route
// sort/paging keys, and emits a single `console.debug` line if and only
// if there is at least one unknown key. No response shape change, no 400.
//
// Exported for the unit test in
// tests/customer-quotes-dropped-filter-telemetry.test.ts.
const KNOWN_FILTER_KEYS: ReadonlySet<string> = new Set(Object.keys(filtersSchema.shape));
const KNOWN_LIST_ROUTE_KEYS: ReadonlySet<string> = new Set([
  "sortKey", "sortDir", "offset", "limit", "mineOnly", "includeSnoozed",
]);

export function diffDroppedFilterKeys(query: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  for (const key of Object.keys(query)) {
    if (!KNOWN_FILTER_KEYS.has(key) && !KNOWN_LIST_ROUTE_KEYS.has(key)) {
      dropped.push(key);
    }
  }
  return dropped;
}

export function logDroppedFilterKeys(
  route: string,
  organizationId: string,
  query: Record<string, unknown>,
): void {
  const dropped = diffDroppedFilterKeys(query);
  if (dropped.length === 0) return;
  console.debug(
    `[customer-quotes] ${route} dropped unknown filter keys org=${organizationId} keys=${dropped.join(",")}`,
  );
}

// Task #1148 (extension) — Telemetry for invalid filter VALUES.
//
// Symmetrical risk to `logDroppedFilterKeys`: when a request carries a
// known filter key with a malformed value (e.g. `?startDate=garbage` or
// `?limit=NaN`), `parseFilters`'s `safeParse` returns `success=false` and
// the function returns `{}` — silently dropping EVERY filter, including
// the valid ones. The rep sees an unfiltered queue with no warning.
//
// `summarizeFilterParseFailure` produces a short list of `path:code`
// tokens (e.g. `startDate:invalid_string`) so the debug line is grep-able
// without exposing user input. `logFilterParseFailure` emits at most one
// `console.debug` line per call. Both are exported for the unit test in
// tests/customer-quotes-dropped-filter-telemetry.test.ts.
export function summarizeFilterParseFailure(issues: ZodIssue[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const issue of issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const token = `${path}:${issue.code}`;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function logFilterParseFailure(
  route: string,
  organizationId: string,
  issues: ZodIssue[],
): void {
  const summary = summarizeFilterParseFailure(issues);
  if (summary.length === 0) return;
  console.debug(
    `[customer-quotes] ${route} dropped all filters: parse failure org=${organizationId} issues=${summary.join(",")}`,
  );
}

function parseFilters(req: Request): QuoteFilters {
  const parsed = queryFiltersSchema.safeParse(req.query);
  if (!parsed.success) {
    // Task #1148 (extension) — emit one structured debug line per
    // request when the entire filter set is silently dropped due to a
    // malformed value. Route name is `parseFilters` because this helper
    // is shared across snapshot/list/funnel/funnel-csv/etc. — the
    // call-site routes already emit their own `logDroppedFilterKeys`
    // line for unknown KEYS, so callers that want richer attribution
    // can wrap parseFilters themselves.
    const orgId = req.user?.organizationId ?? "unknown";
    logFilterParseFailure("parseFilters", orgId, parsed.error.issues);
    return {};
  }
  const f: QuoteFilters = {};
  const d = parsed.data;
  if (d.customerId) f.customerId = d.customerId;
  if (d.startDate) f.startDate = d.startDate;
  if (d.endDate) f.endDate = d.endDate;
  if (d.equipment) f.equipment = d.equipment;
  if (d.repId) f.repId = d.repId;
  if (d.outcomeStatus) f.outcomeStatus = d.outcomeStatus;
  if (d.outcomeReasonId) f.outcomeReasonId = d.outcomeReasonId;
  if (d.laneSearch) f.laneSearch = d.laneSearch;
  if (d.laneGroupId) f.laneGroupId = d.laneGroupId;
  if (d.wonOnly) f.wonOnly = true;
  if (d.activeOnly) f.activeOnly = true;
  if (d.lostOnly) f.lostOnly = true;
  if (d.expiringOnly) f.expiringOnly = true;
  if (d.needsReviewOnly) f.needsReviewOnly = true;
  if (d.includeSnoozed) f.includeSnoozed = true;
  return f;
}

// Task #1007 — Quote Requests trust contract.
// `mineOnly=true` resolves to the requesting user's quote_reps.id when
// such a mapping exists. When it does NOT exist we deliberately do
// **not** scope the request (the legacy `__no_rep__` sentinel silently
// turned the list into a fake zero, which was the trust bug we were
// fixing). Instead we return the filters un-narrowed and surface a
// structured warning the UI uses to render an honest "Mine only is on
// but you're not mapped to a rep" banner with a one-click escape hatch.
//
// Contract:
//   { requested: true,  applied: true,  myRepId: <id>, warningCode: null }
//     → mineOnly was honored, repId scoped down to user's rep.
//   { requested: true,  applied: false, myRepId: null,
//     warningCode: "NO_QUOTE_REP_MAPPING" }
//     → user asked for mineOnly but has no quote_reps row. Filters returned
//       *un-scoped* so org-wide rows still show; UI renders the warning.
//   { requested: false, applied: false, myRepId: <id|null>, warningCode: null }
//     → user did not request mineOnly. No-op.
export type MineOnlyMeta = {
  requested: boolean;
  applied: boolean;
  myRepId: string | null;
  warningCode: "NO_QUOTE_REP_MAPPING" | null;
};

async function applyMineOnly(
  req: Request,
  f: QuoteFilters,
): Promise<{ filters: QuoteFilters; meta: MineOnlyMeta }> {
  const parsed = queryFiltersSchema.safeParse(req.query);
  const requested = parsed.success && !!parsed.data.mineOnly;
  const user = req.user;
  if (!user) {
    return {
      filters: f,
      meta: { requested, applied: false, myRepId: null, warningCode: requested ? "NO_QUOTE_REP_MAPPING" : null },
    };
  }
  const [rep] = await db.select({ id: quoteReps.id }).from(quoteReps)
    .where(andSql(eqSql(quoteReps.organizationId, user.organizationId), eqSql(quoteReps.userId, user.id)))
    .limit(1);
  const myRepId = rep?.id ?? null;
  if (!requested) {
    return { filters: f, meta: { requested: false, applied: false, myRepId, warningCode: null } };
  }
  if (!myRepId) {
    // Honest fallback: do NOT silently scope to nothing. Return un-narrowed
    // filters so the rep sees real org-wide work, and let the UI explain
    // why their personal queue can't be honored.
    return {
      filters: f,
      meta: { requested: true, applied: false, myRepId: null, warningCode: "NO_QUOTE_REP_MAPPING" },
    };
  }
  return {
    filters: { ...f, repId: myRepId },
    meta: { requested: true, applied: true, myRepId, warningCode: null },
  };
}

// ─── Attribution response builder ──────────────────────────────────────
// Pure helper extracted so `tests/customer-quotes-attribution-endpoint.test.ts`
// can pin the JSON shape without standing up Express + Clerk middleware.
// Takes a row from the attribution SELECT (snake_case keys, all string|null)
// and returns the camelCase response payload the AttributionDrawer expects.
export interface AttributionRow {
  quote_id: string | null;
  source_reference: string | null;
  created_at: string | null;
  customer_id: string | null;
  customer_name: string | null;
  rep_id: string | null;
  rep_name: string | null;
  rep_email: string | null;
  message_id: string | null;
  sender_email: string | null;
  sender_name: string | null;
  recipient_email: string | null;
  subject: string | null;
  sent_at: string | null;
  received_at: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_title: string | null;
  // Task #1012 — surfaced so the attribution drawer can explain when
  // a quote landed on the customer's owner rep via the new fallback,
  // and so it can cite the owner by name even if the quote row's own
  // `rep_id` is null (display fallback case).
  owner_rep_id: string | null;
  owner_rep_name: string | null;
  // Task #1056 — Free-mail attribution recovery. Surfaces the
  // email_conversation_thread's tier+evidence so the drawer can
  // render the same badge the Conversations Inbox shows. NULL when
  // the quote has no inbound source email or the matching thread
  // never had attribution stamped.
  thread_attribution_inference_source: string | null;
  thread_attribution_evidence: Record<string, unknown> | null;
}

// ─── Force-reprocess body-status mapping ──────────────────────────────
// Pure helper that converts a `ManualLeakCreateResult` (from the
// service layer) into the JSON body the route returns on HTTP 200.
// Extracted so the rep-side toast contract is unit-testable without
// standing up Express + Clerk + a stubbed `manuallyCreateQuoteFromLeakRow`.
// Returning every handled outcome (created, duplicate, unparseable,
// not_a_leak, not_found, wrong_direction) at HTTP 200 with `status`
// in the body is required by the rep-side mutations that call
// `apiRequest` (which throws on non-2xx) — see the inline comment on
// the force-reprocess route below.
export interface ForceReprocessResultLike {
  status:
    | "created"
    | "duplicate"
    | "unparseable"
    | "not_a_leak"
    | "not_found"
    | "wrong_direction";
  quoteId?: string;
  reason?: string;
}
export interface ForceReprocessBody {
  status: ForceReprocessResultLike["status"];
  quoteId: string | null;
  reason: string | null;
  messageId: string | null;
}
export function buildForceReprocessBody(
  result: ForceReprocessResultLike,
  messageId: string | null,
): ForceReprocessBody {
  return {
    status: result.status,
    quoteId: result.quoteId ?? null,
    reason: result.reason ?? null,
    messageId,
  };
}

// Canonical assignment-rule taxonomy from task #969:
//   • account_owner — rep owns the customer-facing inbox the email arrived at
//   • lane_pattern  — rep matched a lane-pattern rule (reserved; not yet wired)
//   • last_toucher  — rep was the most recent rep to touch this customer (reserved)
//   • fallback      — no automated rule fired (manual intake)
// `ingestQuoteFromEmail` currently only resolves the rep via
// `findOrCreateRep(toEmail)` (rep that owns the recipient inbox), so
// the only two values this helper emits today are `account_owner`
// and `fallback`. Persisting `lane_pattern` and `last_toucher` is
// follow-up #980; the type stays open so wiring those rules later is
// a value-only change.
// Task #1011 extends the taxonomy with explicit identity-precedence
// reasons emitted by `customer_email_identities` matches:
//   • customer_contact      — sender's exact email is on a CRM contact identity
//   • shared_distribution   — sender matches a shared/distribution mailbox identity
//   • customer_domain       — sender domain matches a registered customer domain
//   • account_owner_fallback — no inbox-recipient match; account owner caught it
// Task #1012 adds:
//   • customer_owner — quote_customers.owner_rep_id supplied (or projected)
//                      the rep when sender/inbox routing didn't resolve one.
export type AssignmentRule =
  | "account_owner"
  | "customer_owner"
  | "lane_pattern"
  | "last_toucher"
  | "fallback"
  | "customer_contact"
  | "shared_distribution"
  | "customer_domain"
  | "account_owner_fallback";

export function buildAttributionResponse(
  row: AttributionRow | Record<string, string | null>,
  // Task #1011 — optional identity-precedence hit from
  // `resolveCustomerIdentityForEmail(sender_email)`. When present the
  // drawer surfaces the explicit identity that won routing
  // (customer_contact / shared_distribution / customer_domain) and,
  // for unrouted-recipient rows, account_owner_fallback.
  identity?: {
    kind: "contact" | "shared_distribution" | "domain";
    value: string;
    ownerRepId: string | null;
  } | null,
) {
  // Rule inference. `findOrCreateRep(toEmail)` finds the rep that owns
  // the customer-facing inbox the email was sent to, which is the
  // closest match to `account_owner` in the canonical taxonomy. If
  // the quote was created without an email source (e.g. spot intake),
  // no automated rule fired — surface `fallback` so the drawer can
  // render an honest "manual entry" explanation.
  //
  // Task #1011 — when an identity matched at ingestion time, prefer
  // the identity-specific rule name; if no inbox-recipient match fired
  // but the rep is the company's owner, surface `account_owner_fallback`.
  // Task #1012 — when the row's `rep_id` matches the linked customer's
  // `owner_rep_id` AND there is no inbound source email, the assignment
  // came from the customer-owner fallback at ingestion time. When
  // `rep_id` is null but the customer has an `owner_rep_id`, the
  // display rep was projected from the owner (display fallback). Both
  // surface as `customer_owner`. Identity-precedence rules (1011) win
  // over `customer_owner` because they reflect a stronger sender-side
  // signal than the customer-default owner.
  let ruleName: AssignmentRule = row.message_id ? "account_owner" : "fallback";
  if (row.rep_id && row.owner_rep_id && row.rep_id === row.owner_rep_id && !row.message_id) {
    ruleName = "customer_owner";
  } else if (!row.rep_id && row.owner_rep_id) {
    ruleName = "customer_owner";
  }
  if (identity) {
    if (identity.kind === "contact") ruleName = "customer_contact";
    else if (identity.kind === "shared_distribution") ruleName = "shared_distribution";
    else if (identity.kind === "domain") ruleName = "customer_domain";
    if (row.message_id && identity.ownerRepId && row.rep_id === identity.ownerRepId && !row.recipient_email) {
      ruleName = "account_owner_fallback";
    }
  }
  // `decidedAt` is the assignment-resolution timestamp the code review
  // asked for. We don't yet persist a per-rule audit row (see follow-up
  // #980), so the closest honest proxy is the inbound message's
  // received-at (when the inbox-recipient rule ran) — falling back to
  // sent-at and finally the quote's created_at for manual rows.
  const decidedAt = row.received_at ?? row.sent_at ?? row.created_at ?? null;
  return {
    ok: true as const,
    quoteId: row.quote_id,
    customer: row.customer_id
      ? { id: row.customer_id, name: row.customer_name ?? "(unnamed)" }
      : null,
    rep: row.rep_id
      ? { id: row.rep_id, name: row.rep_name ?? "(unnamed)", email: row.rep_email ?? null }
      : null,
    // Task #1012 — surface the customer's owner rep (when set) so the
    // drawer can name them in the customer_owner explanation regardless
    // of whether the row's `rep_id` is the owner or null.
    customerOwnerRep: row.owner_rep_id
      ? { id: row.owner_rep_id, name: row.owner_rep_name ?? "(unnamed)" }
      : null,
    contact: row.contact_id
      ? {
          id: row.contact_id,
          name: row.contact_name ?? null,
          email: row.contact_email ?? null,
          title: row.contact_title ?? null,
        }
      : null,
    sender: row.message_id
      ? {
          email: row.sender_email,
          name: row.sender_name,
          recipientEmail: row.recipient_email,
          subject: row.subject,
          sentAt: row.sent_at,
        }
      : null,
    // Task #1056 — Tier+evidence from the conversation thread that
    // produced this quote. The drawer renders the AttributionBadge
    // off this object so reps see which tier (thread continuity vs
    // signature suggestion vs weak match vs confirmed) put a
    // free-mail sender on the quote.
    threadAttribution: (row as AttributionRow).thread_attribution_inference_source
      ? {
          source: (row as AttributionRow).thread_attribution_inference_source as string,
          evidence: (row as AttributionRow).thread_attribution_evidence ?? null,
        }
      : null,
    rule: {
      name: ruleName,
      description:
        ruleName === "account_owner"
          ? "Rep owns the customer-facing inbox this inbound email was sent to."
          : ruleName === "customer_owner"
            ? (row.rep_id
                ? "Defaulted to the account's owner rep when no inbox match was found."
                : "Showing the account's owner rep until a rep is explicitly assigned.")
            : "No automated assignment rule fired; rep was set manually.",
      decidedAt,
      inputs: ruleName === "account_owner"
        ? {
            inboundMessageId: row.message_id,
            recipientEmail: row.recipient_email,
            senderEmail: row.sender_email,
          }
        : ruleName === "customer_owner"
          ? {
              customerId: row.customer_id,
              ownerRepId: row.owner_rep_id,
              ownerRepName: row.owner_rep_name,
            }
          : null,
    },
  };
}

// ─── Attribution SQL (Task #994) ──────────────────────────────────────
// Extracted from the inline route handler so the regression test in
// `tests/customer-quotes-attribution-endpoint.test.ts` can exercise
// the actual SELECT against a live database. Pinning only
// `buildAttributionResponse` is what let Task #969 ship a SQL bug
// (`ct.organization_id` does not exist on the `contacts` table) —
// contacts are org-scoped indirectly via `companies.organization_id`,
// so the fix joins through `companies` via an EXISTS subquery and
// preserves the `LEFT JOIN` semantics (no contact match still
// returns the quote row, just with a null contact).
export async function fetchAttributionRow(
  quoteId: string,
  organizationId: string,
): Promise<AttributionRow | null> {
  const result = await db.execute(sqlExpr`
    SELECT
      q.id              AS quote_id,
      q.organization_id AS org_id,
      q.source_reference AS source_reference,
      q.created_at      AS created_at,
      c.id              AS customer_id,
      c.name            AS customer_name,
      r.id              AS rep_id,
      r.name            AS rep_name,
      r.email           AS rep_email,
      orep.id           AS owner_rep_id,
      COALESCE(NULLIF(TRIM(ouser.name), ''), orep.name) AS owner_rep_name,
      em.id             AS message_id,
      em.from_email     AS sender_email,
      -- email_messages does not store a separate sender display name today
      -- (only from_email); surface NULL so AttributionRow stays well-typed.
      NULL::text        AS sender_name,
      em.to_email       AS recipient_email,
      em.subject        AS subject,
      em.provider_sent_at AS sent_at,
      -- email_messages has no dedicated received_at column; created_at is
      -- the ingestion timestamp, which is the closest honest proxy for
      -- when the inbound email entered the system.
      em.created_at     AS received_at,
      ct.id             AS contact_id,
      ct.name           AS contact_name,
      ct.email          AS contact_email,
      ct.title          AS contact_title,
      -- Task #1056 — surface the email_conversation_thread's
      -- attribution inference source + evidence so the Customer
      -- Quotes drawer can render the same Tier-1/2/3 badge the
      -- Conversations Inbox shows. Joined LEFT so quotes without
      -- an inbound source still return a row.
      ect.attribution_inference_source AS thread_attribution_inference_source,
      ect.attribution_evidence         AS thread_attribution_evidence
    FROM quote_opportunities q
    LEFT JOIN quote_customers c ON c.id = q.customer_id
    LEFT JOIN quote_reps r      ON r.id = q.rep_id
    LEFT JOIN quote_reps orep   ON orep.id = c.owner_rep_id
    LEFT JOIN users ouser       ON ouser.id = orep.user_id
    LEFT JOIN email_messages em ON (
      em.org_id = q.organization_id
      AND em.direction = 'inbound'
      AND (em.provider_message_id = q.source_reference OR em.id = q.source_reference)
    )
    LEFT JOIN contacts ct ON (
      em.from_email IS NOT NULL
      AND lower(ct.email) = lower(em.from_email)
      AND ct.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM companies co
        WHERE co.id = ct.company_id
          AND co.organization_id = q.organization_id
      )
    )
    LEFT JOIN email_conversation_threads ect ON (
      ect.org_id = q.organization_id
      AND em.thread_id IS NOT NULL
      AND ect.thread_id = em.thread_id
    )
    WHERE q.id = ${quoteId}
      AND q.organization_id = ${organizationId}
    LIMIT 1
  `);
  return (result.rows?.[0] ?? null) as unknown as AttributionRow | null;
}

export function registerCustomerQuoteRoutes(app: Express): void {
  // Task #923 — Quote Requests freshness strip.
  // Always-honest answer to "how stale is this page?" Read-only, no filters,
  // no auth elevation. The freshness strip on /quote-requests polls this
  // endpoint and renders the last_run timestamp + (when the inbound→opp gap
  // is material) a "X emails still being processed" hint. Lives in this
  // file rather than its own route module so the existing requireUser /
  // org-scoping pattern is reused.
  app.get("/api/customer-quotes/freshness", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const freshness = await getQuoteFreshness(user.organizationId);
      res.json(freshness);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] freshness error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/snapshot", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Task #597 — `ensureQuoteSeed` removed from request paths so demo
      // rows can never re-seed an org via the dashboard. Demo seeding is
      // now strictly opt-in via the dev-only seed script.
      void ensureEmailBackfill(user.organizationId);
      logDroppedFilterKeys("snapshot", user.organizationId, req.query as Record<string, unknown>);
      const { filters, meta: mineOnlyMeta } = await applyMineOnly(req, parseFilters(req));
      const snap = await getSnapshot(user.organizationId, filters);
      // Task #850 + #1007 — surface the requesting user's quote_reps.id
      // (mineOnlyMeta.myRepId is the same value, but we keep `myRepId`
      // at the top level for backwards-compat with existing UI checks).
      res.json({ ...snap, myRepId: mineOnlyMeta.myRepId, mineOnlyMeta });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] snapshot error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #673 — Freight Capture Funnel.
  // Sliceable funnel view of quote opportunities. Reuses parseFilters so the
  // existing filter UI (customer/rep/equipment/date/outcome) works identically.
  // RBAC: account_manager is auto-scoped to the QuoteRep mapped to their user
  // id. national_account_manager / admin / director / sales_director are
  // manager-style roles (consistent with managerRoles elsewhere in the
  // codebase) and see the full org-wide funnel. Page-level access is still
  // gated by QUOTE_OPPORTUNITIES_ROLES on the client.
  app.get("/api/customer-quotes/funnel", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const allowed = new Set([
        "admin", "director", "sales_director",
        "national_account_manager", "sales", "account_manager",
      ]);
      if (!allowed.has(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const filters = parseFilters(req);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const result = await getFunnel(user.organizationId, filters, scope);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/list", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Task #597 — see snapshot route. No demo seeding from request paths.
      void ensureEmailBackfill(user.organizationId);
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      const d = parsed.data;
      logDroppedFilterKeys("list", user.organizationId, req.query as Record<string, unknown>);
      const filters = parseFilters(req);
      // Task #816 — coerce stale saved-view sort keys (carrierPaid /
      // marginDollar / marginPct, retired with the carrier columns) into
      // the safe default so the request can't crash the list endpoint.
      const requestedSort = d.sortKey ?? "requestDate";
      const sortKey: ListSortKey = (KNOWN_SORT_KEYS.has(requestedSort)
        ? requestedSort
        : "requestDate") as ListSortKey;
      const sortDir = d.sortDir ?? "desc";
      const { filters: scopedFilters, meta: mineOnlyMeta } = await applyMineOnly(req, filters);
      const result = await listQuotes(user.organizationId, scopedFilters, sortKey, sortDir, d.offset, d.limit);
      res.json({ ...result, mineOnlyMeta });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] list error:", err);
      res.status(500).json({ error: msg });
    }
  });

  const createQuoteSchema = z.object({
    customerId: z.string().min(1),
    repId: z.string().min(1).nullable().optional(),
    carrierId: z.string().min(1).nullable().optional(),
    outcomeReasonId: z.string().min(1).nullable().optional(),
    originCity: z.string().min(1).max(80),
    originState: z.string().min(1).max(8),
    destCity: z.string().min(1).max(80),
    destState: z.string().min(1).max(8),
    equipment: z.string().min(1).max(40),
    quotedAmount: z.union([z.string(), z.number()]).nullable().optional(),
    validThrough: z.string().nullable().optional(),
    outcomeStatus: z.enum(QUOTE_OUTCOME_STATUSES).optional(),
    carrierPaid: z.union([z.string(), z.number()]).nullable().optional(),
    responseTimeHours: z.union([z.string(), z.number()]).nullable().optional(),
    source: z.enum(QUOTE_SOURCES).optional(),
    sourceReference: z.string().max(80).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    score: z.union([z.string(), z.number()]).nullable().optional(),
    requestDate: z.string().nullable().optional(),
    // Task #968 — Convert-to-quote handoff from Conversations. Capped at
    // 200 because Outlook conversationIds are ~140 base64 chars and
    // we never want to accept arbitrarily-long values here. The service
    // layer is responsible for resolving this to a concrete message id
    // and stamping source/sourceReference.
    sourceThreadId: z.string().max(200).nullable().optional(),
  });

  const updateQuoteSchema = createQuoteSchema.partial().extend({
    // Task #477 — UI win-outcome dialog passes this when the rep unchecks
    // "Create LWQ lane" before confirming the win.
    skipLwqHandoff: z.boolean().optional(),
  });

  function actorName(u: { name?: string | null; username?: string | null; id: string } | null): string {
    if (!u) return "system";
    return (u.name && u.name.trim()) || u.username || u.id;
  }

  app.post("/api/customer-quotes/quote", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = createQuoteSchema.parse(req.body);
      const opp = await createQuote(user.organizationId, actorName(user), data, user.id);
      const detail = await getQuoteDetail(user.organizationId, opp.id);
      res.status(201).json(detail);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] create error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.patch("/api/customer-quotes/quote/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = updateQuoteSchema.parse(req.body);
      const id = pStr(req.params.id);
      // Task #849 §6.1 — ownership gate. Pre-S1 this route was only
      // `requireUser`-gated, so any rep in an org could PATCH any other
      // rep's opp by guessing the id. Closed via the shared helper.
      const gate = await assertCanMutateQuote(user.organizationId, id, user);
      if (!gate.ok) {
        return res.status(gate.status).json({
          error: gate.reason === "forbidden" ? "Quote belongs to another rep"
            : gate.reason === "no_rep_mapping" ? "No rep mapping — cannot update quotes"
            : "Quote not found",
        });
      }
      const { opp, handoff } = await updateQuote(user.organizationId, actorName(user), id, data, user.id);
      const detail = await getQuoteDetail(user.organizationId, opp.id);
      // Cross-tab UX (option A) — quote outcome/status edits affect the
      // snapshot KPIs, the list view, and the action queue. One topic
      // event covers all three (the client maps the topic to all three
      // query keys).
      // Task #967 — Date.now() at publish doubles as the row-version
      // stamp for the client-side `applyRowVersionGuard`. Publishes
      // commit-ordered, so this is monotonic per opp id.
      publishLiveSync(user.organizationId, "customer_quote", opp.id, Date.now());
      // Task #690 — any edit that could change a quote's outcome status
      // (won / lost / expired) drops it out of the stale-followup window;
      // any edit that revives a previously-decided quote could put one back
      // in. Bust the cache so the next sidebar badge poll (or page load)
      // recomputes; the membership tracker inside the service will then
      // publish `customer_quote_followup` if the set actually changed.
      clearStaleFollowUpCache(user.organizationId);
      // Pilot trust fix — hero-aware Won toast. The client uses `_handoff`
      // to branch the markWon toast: `auto` → "auto-routed to AF" with a
      // View-in-AF action, `pending_approval` → "waiting on NAM/AM
      // approval", `none` → generic "Quote updated". Read-only reflection
      // of the routing decision updateQuote already made.
      res.json({ ...detail, _handoff: handoff });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] update error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #584 — inline "Create new customer" used by the dashboard's
  // Unknown-bucket reassign popover. Idempotent on case-insensitive name.
  app.post("/api/customer-quotes/customers", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = z.object({
        name: z.string().trim().min(1, "Name is required").max(120),
        segment: z.string().trim().max(80).optional().nullable(),
      }).parse(req.body);
      const customer = await createQuoteCustomer(user.organizationId, data.name, data.segment ?? null);
      res.json(customer);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] create customer error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #597 — manual party-type override for a single quote_customers row.
  // Always sets `partyTypeManual=true` so background classifiers leave the
  // row alone going forward. Used by the drawer's "Mark customer / Mark
  // carrier" buttons. Returns the updated row.
  app.patch("/api/customer-quotes/customers/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = z.object({
        partyType: z.enum(QUOTE_PARTY_TYPES),
      }).parse(req.body);
      const updated = await setCustomerPartyType(user.organizationId, pStr(req.params.id), data.partyType);
      if (!updated) return res.status(404).json({ error: "Not found" });
      // Bust the lazy backfill cache so other dashboards that depend on the
      // classification (e.g., snapshot KPIs) reflect the change immediately.
      clearPartyTypeBackfillCache(user.organizationId);
      res.json(updated);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] set party-type error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #1012 — get a single quote_customer (with denormalized owner rep
  // display name) so the company-detail page can render the Owner Rep
  // widget without round-tripping through the snapshot. Read-only,
  // org-scoped.
  app.get("/api/customer-quotes/customers/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const found = await getQuoteCustomerWithOwner(user.organizationId, pStr(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });
      res.json({
        customer: found.customer,
        ownerRepName: found.ownerRepName,
      });
    } catch (err) {
      console.error("[customer-quotes] get customer error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // Task #1012 — resolve a CRM company name to its quote_customers row
  // (case-insensitive). Used by company-detail to discover whether
  // there's a Customer Quotes record for the company being viewed.
  // Returns 404 when no match exists; the caller renders an
  // empty-state ("Not yet a quote customer") in that case.
  app.get("/api/customer-quotes/customers/by-name/:name", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const name = decodeURIComponent(pStr(req.params.name));
      const found = await findQuoteCustomerByName(user.organizationId, name);
      if (!found) return res.status(404).json({ error: "Not found" });
      res.json({
        customer: found.customer,
        ownerRepName: found.ownerRepName,
      });
    } catch (err) {
      console.error("[customer-quotes] find customer by-name error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // Task #1012 — set or clear the primary owner rep on a quote_customer.
  // Validates that the rep belongs to the same org and isn't suppressed
  // (suppressed reps shouldn't be picked as new owners; existing rows
  // referencing a now-suppressed rep are handled by the FK + UI badge).
  // PATCH body: { ownerRepId: string | null }.
  app.patch("/api/customer-quotes/customers/:id/owner", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Task #1012 — same admin guard as the rep-audit surface. Owner
      // mutations change which rep new inbound quotes (and unassigned
      // display rows) are routed to, so we restrict this to admins.
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const data = z.object({
        ownerRepId: z.string().min(1).nullable(),
      }).parse(req.body);
      if (data.ownerRepId) {
        const [rep] = await db.select({ id: quoteReps.id, suppressed: quoteReps.suppressed })
          .from(quoteReps)
          .where(andSql(
            eqSql(quoteReps.organizationId, user.organizationId),
            eqSql(quoteReps.id, data.ownerRepId),
          ))
          .limit(1);
        if (!rep) {
          return res.status(400).json({ error: "Rep not found in this organization" });
        }
        if (rep.suppressed) {
          return res.status(400).json({ error: "Cannot assign a suppressed rep as owner" });
        }
      }
      const updated = await setQuoteCustomerOwner(
        user.organizationId,
        pStr(req.params.id),
        data.ownerRepId,
      );
      if (!updated) return res.status(404).json({ error: "Customer not found" });
      res.json({
        customer: updated.customer,
        ownerRepName: updated.ownerRepName,
      });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] set owner error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/quote/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const detail = await getQuoteDetail(user.organizationId, pStr(req.params.id));
      if (!detail) return res.status(404).json({ error: "Not found" });
      res.json(detail);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] detail error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/pricing-intelligence", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        customerId: z.string().min(1),
        originCity: z.string().min(1),
        originState: z.string().min(1).max(4),
        destCity: z.string().min(1),
        destState: z.string().min(1).max(4),
        equipment: z.string().min(1).optional(),
        laneGroupId: z.string().min(1).optional(),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      // Task #597 — ensureQuoteSeed removed from request paths.
      void ensureEmailBackfill(user.organizationId);
      const intel = await getPricingIntelligence(user.organizationId, parsed.data);
      res.json(intel);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] pricing intel error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // 3-tier pricing recommendation for a specific quote (Aggressive /
  // Balanced / Premium with per-tier estimated win-prob and floor flag).
  app.get("/api/customer-quotes/quote/:id/recommendation", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const rec = await getPricingRecommendation(user.organizationId, pStr(req.params.id));
      res.json(rec);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] recommendation error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Per-equipment $/mile margin floors (read).
  app.get("/api/customer-quotes/pricing-floors", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const floors = await getMarginFloors(user.organizationId);
      res.json({ floors });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] pricing-floors get error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Per-equipment $/mile margin floors (admin update). Replaces the full map.
  app.patch("/api/customer-quotes/pricing-floors", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const schema = z.object({ floors: z.record(z.string(), z.number().finite().nonnegative()) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      const saved = await setMarginFloors(user.organizationId, parsed.data.floors, user.id);
      res.json({ floors: saved });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] pricing-floors patch error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #3 — admin list of learned sender→customer mappings.
  // Visible only to admin/director/sales_director — these mappings are an
  // org-level config artifact, not a per-rep view.
  app.get("/api/customer-quotes/sender-mappings", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const mappings = await listMappings(user.organizationId);
      res.json({ mappings });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] sender-mappings list error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #3 — admin delete of a learned mapping. Org-scoped at
  // the service layer; we still re-check the role here so we never let a
  // rep delete an org-wide config row.
  app.delete("/api/customer-quotes/sender-mappings/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing mapping id" });
      const result = await deleteMapping(user.organizationId, id);
      if (!result.deleted) return res.status(404).json({ error: "Mapping not found" });
      res.json({ deleted: true });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] sender-mappings delete error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #654 — Org-level toggle for the won-quote → Available Freight
  // same-day handoff. Admin-only; the setting defaults ON if no row exists
  // in app_settings. Stored under the `auto_won_quote_af_handoff:${orgId}`
  // key so it follows the rest of the project's org-scoped settings
  // convention (no separate org_settings table).
  app.get("/api/customer-quotes/settings/auto-af-handoff", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const enabled = await getAutoWonQuoteAfHandoffEnabled(user.organizationId);
      res.json({ enabled });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] auto-af-handoff get error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.put("/api/customer-quotes/settings/auto-af-handoff", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "enabled (boolean) required" });
      await setAutoWonQuoteAfHandoffEnabled(user.organizationId, parsed.data.enabled);
      res.json({ enabled: parsed.data.enabled });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] auto-af-handoff put error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #2 — Action Queue (sla-breaching / expiring-today).
  // Task #615 retired the needs-review bucket along with the rest of the
  // unknown-customer surface area. Each list capped at `limit` (default 5,
  // max 25).
  app.get("/api/customer-quotes/action-queue", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        limit: z.preprocess(
          v => v === undefined ? 5 : Number(v),
          z.number().int().min(1).max(25),
        ),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      const queue = await getActionQueue(user.organizationId, { limit: parsed.data.limit });
      res.json(queue);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] action-queue error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #2 — bulk reassign Needs-Review quotes to a real
  // customer. Defensive: a quote is skipped if its current customer is
  // NOT in the shared "Unknown — needs review" bucket.
  app.post("/api/customer-quotes/quotes/bulk-reassign-customer", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        quoteIds: z.array(z.string().min(1)).min(1).max(500),
        targetCustomerId: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      const result = await bulkReassignCustomerForQuotes(
        user.organizationId,
        parsed.data.quoteIds,
        parsed.data.targetCustomerId,
      );
      // Bust the lazy backfill cache so snapshot KPIs reflect the move.
      clearPartyTypeBackfillCache(user.organizationId);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] bulk-reassign error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Customer Quotes #2 — bulk-flip outcome status. Used by the
  // "Mark ignored" / "Mark pending" bulk action.
  app.post("/api/customer-quotes/quotes/bulk-status", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        quoteIds: z.array(z.string().min(1)).min(1).max(500),
        status: z.enum(["ignored", "pending"]),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      // Task #849 §6.1 — bulk ownership gate. Same pattern as
      // bulk-reassign-customer above; mirrors the single-id PATCH.
      const gate = await assertCanMutateQuotes(user.organizationId, parsed.data.quoteIds, user);
      if (!gate.ok) {
        return res.status(gate.status).json({
          error: gate.reason === "forbidden" ? "Some quotes belong to another rep"
            : gate.reason === "no_rep_mapping" ? "No rep mapping — cannot flip status"
            : "One or more quotes not found",
          ...(gate.reason === "forbidden" ? { deniedIds: gate.deniedIds } : {}),
          ...(gate.reason === "not_found" ? { missingIds: gate.missingIds } : {}),
        });
      }
      const result = await bulkSetQuoteStatus(
        user.organizationId,
        parsed.data.quoteIds,
        parsed.data.status,
      );
      // Cross-tab UX (option A) — bulk flip mutates many rows; one
      // org-wide hint is enough to refresh the list / snapshot / queue.
      // Task #967 — bulk topic-wide hint (no key); rowVersionAt left
      // unset because the guard is keyed by (topic, key) and bulk fans
      // out across many rows.
      publishLiveSync(user.organizationId, "customer_quote");
      // Task #690 — bulk status flip (e.g., ignored ↔ pending) can drop
      // many quotes out of, or back into, the stale-followup window in
      // one shot. Bust the cache so the next badge poll recomputes and
      // the membership tracker fires `customer_quote_followup` if the
      // set actually changed.
      clearStaleFollowUpCache(user.organizationId);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] bulk-status error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #505 — Spot Quote Search
  app.get("/api/customer-quotes/spot-search", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        pickupCity: z.string().min(1).max(80),
        pickupState: z.string().min(1).max(8),
        deliveryCity: z.string().min(1).max(80),
        deliveryState: z.string().min(1).max(8),
        equipment: z.string().max(40).optional(),
        pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
        customerId: z.string().min(1).optional(),
        lookbackDays: z.coerce.number().int().min(1).max(3650).optional(),
        exactOnly: z.preprocess(v => v === "true" || v === true, z.boolean()).optional(),
        includeSimilar: z.preprocess(v => !(v === "false" || v === false), z.boolean()).optional(),
        matchMode: z.enum(["strict", "relaxed"]).optional(),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      // Task #597 — ensureQuoteSeed removed from request paths.
      void ensureEmailBackfill(user.organizationId);
      const result = await searchSpotQuote(user.organizationId, parsed.data);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] spot search error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #617 — Spot Quote Intake (drop a screenshot or paste an email)
  // Accepts either a multipart upload (image or `.eml` file) or a JSON body
  // with raw text/subject/body. Returns a normalized ParsedQuoteIntake the
  // Spot Quote Search form can use to pre-fill its inputs.
  const intakeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(MAX_INTAKE_IMAGE_BYTES, MAX_INTAKE_TEXT_BYTES) },
  });
  app.post(
    "/api/customer-quotes/spot-intake",
    requireUser,
    intakeUpload.single("file"),
    async (req, res) => {
      try {
        const user = req.user!;

        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (file) {
          const mime = (file.mimetype || "").toLowerCase();
          // Image branch — vision parse.
          if (mime.startsWith("image/")) {
            const result = await parseQuoteIntakeFromImage(file.buffer, mime);
            return res.json(result);
          }
          // .eml or plain-text branch — treat as raw email content.
          const isEmlName = (file.originalname || "").toLowerCase().endsWith(".eml");
          if (mime === "message/rfc822" || mime === "text/plain" || isEmlName) {
            if (file.buffer.byteLength > MAX_INTAKE_TEXT_BYTES) {
              return res.status(413).json({ error: "Email is too large — please paste the body instead." });
            }
            const rawText = file.buffer.toString("utf8");
            const result = await parseQuoteIntakeFromText({ rawText, source: "email" });
            return res.json(result);
          }
          return res.status(415).json({
            error: "Unsupported file type. Drop an image, an .eml file, or paste the email text.",
          });
        }

        // JSON body branch.
        const schema = z.object({
          subject: z.string().max(500).optional(),
          body: z.string().max(MAX_INTAKE_TEXT_BYTES).optional(),
          rawText: z.string().max(MAX_INTAKE_TEXT_BYTES).optional(),
        }).refine(d => (d.body && d.body.trim()) || (d.rawText && d.rawText.trim()) || (d.subject && d.subject.trim()), {
          message: "Provide subject, body, or rawText.",
        });
        const parsed = schema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid intake payload", issues: parsed.error.issues });
        }
        const result = await parseQuoteIntakeFromText({
          subject: parsed.data.subject ?? null,
          body: parsed.data.body ?? null,
          rawText: parsed.data.rawText ?? null,
          source: parsed.data.rawText ? "email" : "text",
        });
        res.json(result);
      } catch (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "File is too large — please upload under 8 MB." });
        }
        const msg = getErrorMessage(err);
        console.error("[customer-quotes] spot-intake error:", err);
        res.status(500).json({ error: msg });
      }
    },
  );

  app.get("/api/customer-quotes/lane-autocomplete", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        q: z.string().min(1).max(80),
        kind: z.enum(["origin", "dest"]),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.json([]);
      // Task #597 — ensureQuoteSeed removed from request paths.
      void ensureEmailBackfill(user.organizationId);
      const items = await laneAutocomplete(user.organizationId, parsed.data.q, parsed.data.kind);
      res.json(items);
    } catch (err) {
      console.error("[customer-quotes] autocomplete error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/api/customer-quotes/saved-views", requireUser, async (req, res) => {
    const user = req.user!;
    const views = await listSavedViews(user.organizationId);
    res.json(views);
  });

  app.post("/api/customer-quotes/saved-views", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        name: z.string().min(1).max(80),
        filters: savedViewFiltersSchema.default({}),
      });
      const data = schema.parse(req.body);
      const view = await createSavedView(user.organizationId, user.id, data.name, data.filters);
      res.json(view);
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/customer-quotes/saved-views/:id", requireUser, async (req, res) => {
    const user = req.user!;
    await deleteSavedView(user.organizationId, user.id, pStr(req.params.id));
    res.json({ ok: true });
  });

  // Task #863 — Manage Views: rename and/or update filter shape on a
  // user-saved view.
  app.patch("/api/customer-quotes/saved-views/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        name: z.string().min(1).max(80).optional(),
        filters: savedViewFiltersSchema.optional(),
      });
      const data = schema.parse(req.body);
      const view = await updateSavedView(
        user.organizationId, user.id, pStr(req.params.id), data,
      );
      if (!view) return res.status(404).json({ error: "Saved view not found" });
      res.json(view);
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #516 — Spot Quote Search Deal Sheet: create + email-draft endpoints.
  // The create path delegates to the same `createQuote` service used elsewhere
  // (no duplicate insert logic). Margin guardrail is enforced server-side when
  // an estimatedCost is provided so the frontend can't bypass it.
  app.post("/api/customer-quotes/spot/create", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const parsed = spotQuoteCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const data = parsed.data;
      if (typeof data.estimatedCost === "number" && data.estimatedCost > 0) {
        const marginPct = ((data.quotedAmount - data.estimatedCost) / data.quotedAmount) * 100;
        if (marginPct < SPOT_MIN_MARGIN_PCT) {
          return res.status(400).json({
            error: `Margin ${marginPct.toFixed(1)}% is below the ${SPOT_MIN_MARGIN_PCT}% guardrail`,
            marginPct,
            minMarginPct: SPOT_MIN_MARGIN_PCT,
          });
        }
      }
      const actor = (user.name && user.name.trim()) || user.username || user.id;
      let resolvedRepId: string | null = null;
      try {
        const [rep] = await db.select().from(quoteReps).where(andSql(
          eqSql(quoteReps.organizationId, user.organizationId),
          eqSql(quoteReps.userId, user.id),
        )).limit(1);
        if (rep) resolvedRepId = rep.id;
      } catch (lookupErr) {
        console.warn("[customer-quotes] spot create rep lookup failed:", lookupErr);
      }
      const opp = await createQuote(user.organizationId, actor, {
        customerId: data.customerId,
        repId: resolvedRepId,
        originCity: data.pickupCity,
        originState: data.pickupState.toUpperCase(),
        destCity: data.deliveryCity,
        destState: data.deliveryState.toUpperCase(),
        equipment: data.equipment,
        quotedAmount: data.quotedAmount,
        validThrough: data.validUntil ?? null,
        source: "manual",
        notes: data.notes ?? null,
      }, user.id);
      res.status(201).json(opp);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] spot create error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/spot/email-draft", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        quoteId: z.string().min(1),
        recommendedRate: z.number().finite().positive().optional(),
        guidanceMessage: z.string().max(500).optional(),
        bandLow: z.number().finite().positive().optional(),
        bandMid: z.number().finite().positive().optional(),
        bandHigh: z.number().finite().positive().optional(),
        bandSource: z.string().max(40).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const { quoteId, recommendedRate, guidanceMessage, bandLow, bandMid, bandHigh, bandSource } = parsed.data;
      const detail = await getQuoteDetail(user.organizationId, quoteId);
      if (!detail) return res.status(404).json({ error: "Quote not found" });

      let accountId: string | undefined;
      let toEmails: string[] = [];
      if (detail.customer) {
        try {
          const [match] = await db.select().from(companies).where(andSql(
            eqSql(companies.organizationId, user.organizationId),
            sqlExpr`lower(${companies.name}) = lower(${detail.customer.name})`,
          )).limit(1);
          if (match) {
            accountId = match.id;
            const cs = await db.select().from(contacts).where(andSql(eqSql(contacts.companyId, match.id), isNullSql(contacts.deletedAt))).limit(20);
            toEmails = cs.map(c => c.email).filter((e): e is string => !!e).slice(0, 5);
          }
        } catch (lookupErr) {
          console.warn("[customer-quotes] spot email-draft contact lookup failed:", lookupErr);
        }
      }

      const [voiceProfile, dataResult] = await Promise.all([
        getVoiceProfile(user.id, user.username, user.organizationId),
        gatherDataAnchors(user.organizationId, accountId, undefined),
      ]);

      const lane = `${detail.opp.originCity}, ${detail.opp.originState} → ${detail.opp.destCity}, ${detail.opp.destState}`;
      const quotedAmt = Number(detail.opp.quotedAmount ?? 0);
      const validStr = detail.opp.validThrough ? new Date(detail.opp.validThrough).toLocaleDateString() : "";
      const recRate = recommendedRate && recommendedRate > 0 ? recommendedRate : quotedAmt;
      const guidanceLine = (bandLow || bandMid || bandHigh)
        ? `Pricing guidance${bandSource ? ` (${bandSource})` : ""}: ` +
          [
            bandLow ? `low $${Math.round(bandLow).toLocaleString()}` : "",
            bandMid ? `mid $${Math.round(bandMid).toLocaleString()}` : "",
            bandHigh ? `high $${Math.round(bandHigh).toLocaleString()}` : "",
          ].filter(Boolean).join(" / ")
        : "";
      const guidanceContextLine = guidanceMessage && guidanceMessage.trim()
        ? `Guidance: ${guidanceMessage.trim()}`
        : "";
      const dataContext = [
        `Spot quote: ${lane}`,
        `Equipment: ${detail.opp.equipment}`,
        `Recommended rate: $${Math.round(recRate).toLocaleString()}`,
        `Quoted: $${quotedAmt.toLocaleString()}`,
        guidanceLine,
        guidanceContextLine,
        validStr ? `Valid through: ${validStr}` : "",
        detail.opp.notes ? `Internal notes: ${detail.opp.notes}` : "",
        dataResult.context,
      ].filter(Boolean).join("\n");

      const body = await generateDraft({
        voiceProfile,
        playType: "general",
        dataContext,
        additionalContext: `Outreach for spot quote ${lane}. Recommended rate $${Math.round(recRate).toLocaleString()}${guidanceLine ? `. ${guidanceLine}` : ""}.`,
      });
      const subject = `Spot Quote: ${lane}`;
      res.json({ subject, body, to: toEmails });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] spot email-draft error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #723 — Capture funnel diagnostics. Admin-only panel that reports
  // the most recent TMS sync (scanned / matched / probable / won-lost-
  // expired counts) plus a window of email-classifier outcomes (won / lost
  // / neither inbound replies) plus near-miss TMS candidates surfaced by
  // the looser matcher. Scoped to the same filter slice the funnel uses.
  app.get("/api/customer-quotes/funnel-diagnostics", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const filters = parseFilters(req);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const diagnostics = await getFunnelDiagnostics(user.organizationId, filters, scope);
      res.json(diagnostics);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Capture leak queue (Phase 1, read-only). Row-level expansion of the
  // missingIntentInbound / orphanOutbound counters surfaced by
  // /funnel-diagnostics. Same admin gating, same rep-scope rules; the
  // queue inherits windowDays from the diagnostics defaults so the count
  // and the rows are computed against the same window.
  app.get("/api/customer-quotes/funnel-diagnostics/leaks", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const typeRaw = qStr(req.query.type);
      if (typeRaw !== "missed_inbound" && typeRaw !== "orphan_outbound") {
        return res.status(400).json({ error: "type must be 'missed_inbound' or 'orphan_outbound'" });
      }
      // qInt collapses missing / non-numeric to the fallback. Sentinel
      // -1 ⇒ "use service default" (50 / 0). The service also clamps,
      // so a user-supplied 9999 still gets capped — we don't have to
      // duplicate the bounds here.
      const limitParsed = qInt(req.query.limit, -1);
      const offsetParsed = qInt(req.query.offset, -1);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const result = await getLeakedQuoteEmails(user.organizationId, scope, {
        type: typeRaw,
        limit: limitParsed >= 0 ? limitParsed : undefined,
        offset: offsetParsed >= 0 ? offsetParsed : undefined,
      });
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics/leaks error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Phase 3 — Capture leak analytics: 7/30-day resolution mix, current
  // unresolved aging buckets, and a 30-day discovered-vs-resolved
  // trendline. Same admin gating + rep-scope rules as the queue.
  // Read-only; no writes; data sources are already-existing tables
  // (capture_leak_reviews, quote_events with actor=manual_leak_create,
  // and the same buildLeakCandidateIds chokepoint as the queue).
  app.get("/api/customer-quotes/funnel-diagnostics/leaks/analytics", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const result = await getLeakAnalytics(user.organizationId, scope);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics/leaks/analytics error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Phase 2A — Record a "Not a quote" / "Ignore for now" decision on a
  // single leak row. Same admin gating as the GET. Idempotent at the DB
  // level via `(organization_id, message_id, leak_type)` unique index.
  // The reviewed (messageId, leakType) is filtered out by
  // `buildLeakCandidateIds`, so the diagnostics counts AND the queue
  // both shrink on the next refetch — no client-side hiding.
  const reviewLeakBodySchema = z.object({
    messageId: z.string().min(1),
    leakType: z.enum(CAPTURE_LEAK_TYPES),
    decision: z.enum(CAPTURE_LEAK_REVIEW_DECISIONS),
    note: z.string().max(2000).optional(),
  });
  app.post("/api/customer-quotes/funnel-diagnostics/leaks/review", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = reviewLeakBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const result = await reviewLeakRow(user.organizationId, user.id, parsed.data);
      if (result.status === "not_found") {
        return res.status(404).json({ error: "Leak row not found in this organization" });
      }
      res.json({ status: "ok", review: result.review });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics/leaks/review error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Phase 2B — Manually create a quote opportunity from a Missed Inbound
  // leak row. Reuses `ingestQuoteFromEmail` so parsing, idempotency
  // (provider message id), and customer resolution behave identically
  // to the autopilot pipeline. Orphan Outbound rows are intentionally
  // out of scope (no inbound email payload to parse).
  //
  // On success, the route returns `{ quoteId }` so the client can
  // navigate to `?quote=<id>` (the existing customer-quotes drawer
  // deep-link). The leak row disappears from the queue automatically
  // because `quote_opportunities.sourceReference = providerMessageId`
  // is what `buildLeakCandidateIds` already excludes via the
  // `existingQuoteRefs` set.
  const createLeakQuoteBodySchema = z.object({
    messageId: z.string().min(1),
  });
  app.post("/api/customer-quotes/funnel-diagnostics/leaks/create-quote", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = createLeakQuoteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const result = await manuallyCreateQuoteFromLeakRow(
        user.organizationId,
        user.id,
        parsed.data.messageId,
      );
      switch (result.status) {
        case "created":
          return res.status(201).json({ status: "created", quoteId: result.quoteId });
        case "duplicate":
          // Quote already exists for this provider message id (race
          // with autopilot, or row was already converted). Surface the
          // existing quote so the client can still deep-link to it.
          return res.status(200).json({ status: "duplicate", quoteId: result.quoteId });
        case "unparseable":
          return res.status(422).json({ status: "unparseable", reason: result.reason });
        case "not_a_leak":
          // Race: someone else reviewed/created in between page load
          // and click, or the email is no longer a candidate.
          return res.status(409).json({ status: "not_a_leak" });
        case "not_found":
          return res.status(404).json({ status: "not_found" });
        case "wrong_direction":
          return res.status(400).json({ status: "wrong_direction" });
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics/leaks/create-quote error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Task #969 — rep-side "This should be a quote" reprocess. ──────────
  // The conversation pane lets reps look at a specific inbound message
  // that the classifier did NOT flag as a missed-inbound leak (e.g. a
  // status_update that was actually a pricing request) and force it
  // through ingestion. The endpoint is callable by any authenticated
  // user — reps see a quote in their queue, not an admin tool — but
  // every call writes a `quote_events` audit row tagged with the
  // triggering userId via `manuallyCreateQuoteFromLeakRow`'s existing
  // audit path. The `forced` flag in the underlying service skips the
  // missed-inbound race-guard but keeps every other safety check
  // (org boundary, direction, ingestQuoteFromEmail dup-check).
  // Body accepts `messageId` OR `threadId`. When `threadId` is given we
  // resolve to the latest inbound message in that thread (within the
  // caller's org). At least one of the two must be present.
  const forceReprocessBodySchema = z
    .object({
      messageId: z.string().min(1).optional(),
      threadId: z.string().min(1).optional(),
    })
    .refine((v) => !!(v.messageId || v.threadId), {
      message: "messageId or threadId required",
    });
  app.post(
    "/api/customer-quotes/funnel-diagnostics/inbound/force-reprocess",
    requireUser,
    async (req, res) => {
      try {
        const user = req.user!;
        const parsed = forceReprocessBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
        }
        // Resolve threadId → latest inbound messageId within the
        // caller's org. We pick the most recent inbound because that
        // is the message the rep was looking at when they clicked
        // "This should be a quote" from a thread-level surface.
        let messageId = parsed.data.messageId ?? null;
        if (!messageId && parsed.data.threadId) {
          const lookup = await db.execute(sqlExpr`
            SELECT id
            FROM email_messages
            WHERE org_id = ${user.organizationId}
              AND thread_id = ${parsed.data.threadId}
              AND direction = 'inbound'
            ORDER BY provider_sent_at DESC NULLS LAST, id DESC
            LIMIT 1
          `);
          const row = lookup.rows?.[0] as { id?: string } | undefined;
          if (!row?.id) {
            // Task #969 review-fix: keep this on the body-status path
            // so the rep-side toast `onSuccess` switch can render the
            // "no inbound messages" branch (the shared `apiRequest`
            // helper would throw on a 404 and skip the switch).
            return res.status(200).json({
              status: "not_found",
              quoteId: null,
              reason: "No inbound messages on this thread",
              messageId: null,
            });
          }
          messageId = row.id;
        }
        if (!messageId) {
          return res.status(400).json({ error: "messageId or threadId required" });
        }
        const result = await manuallyCreateQuoteFromLeakRow(
          user.organizationId,
          user.id,
          messageId,
          { forced: true },
        );
        // Task #969 review fix: every handled outcome returns HTTP 200
        // with the status carried in the body. Reserve non-2xx for
        // genuine errors (auth/server). The client uses the shared
        // `apiRequest` helper which throws on non-2xx; if we surfaced
        // 422/409/404/400 here, the toast switch in the caller would
        // never see `unparseable | not_a_leak | not_found |
        // wrong_direction` and the "View drops queue" deep link would
        // be unreachable. Returning 200 keeps the status routing in
        // one place (the body).
        return res.status(200).json(buildForceReprocessBody(result, messageId));
      } catch (err) {
        const msg = getErrorMessage(err);
        console.error("[customer-quotes] force-reprocess error:", err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // ── Task #969 — "Why this rep?" attribution drawer. ───────────────────
  // Surfaces the human-readable inputs the email-ingestion pipeline
  // used to assign this quote's rep + customer. Attribution rules are
  // not yet persisted (Task #969 ships the reduced explainer only),
  // so the rule name is inferred from how `ingestQuoteFromEmail`
  // currently routes: `findOrCreateRep(toEmail)` — i.e. the inbox the
  // customer emailed wins. We label that as `inbox_recipient` so the
  // UI doesn't claim a sophistication the system doesn't yet have.
  app.get("/api/customer-quotes/quote/:id/attribution", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const quoteId = pStr(req.params.id);
      if (!quoteId) return res.status(400).json({ error: "id required" });
      const row = await fetchAttributionRow(quoteId, user.organizationId);
      if (!row) return res.status(404).json({ error: "Not found" });
      // Task #1011 — re-resolve the customer-email-identity from the
      // sender so the drawer can name the explicit identity rule that
      // won routing (contact / shared / domain) instead of the
      // generic "inbox recipient" label.
      let identity: { kind: "contact" | "shared_distribution" | "domain"; value: string; ownerRepId: string | null } | null = null;
      if (row.sender_email) {
        const hit = await storage.resolveCustomerIdentityForEmail(user.organizationId, row.sender_email);
        if (hit) identity = { kind: hit.kind, value: hit.value, ownerRepId: hit.ownerRepId };
      }
      res.json(buildAttributionResponse(row, identity));
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] attribution error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Phase 4 — List candidate quote_opportunities to attach an
  // Orphan Outbound row to. Scoped to the row's linked customer
  // (default = open quotes; toggle = recent terminal). Same admin
  // gating as the queue.
  app.get("/api/customer-quotes/funnel-diagnostics/leaks/attach-candidates", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const messageId = qStr(req.query.messageId);
      if (!messageId) {
        return res.status(400).json({ error: "messageId is required" });
      }
      const closed = qStr(req.query.closed) === "true";
      const q = qStr(req.query.q) ?? undefined;
      const result = await listAttachCandidateQuotes(user.organizationId, messageId, { closed, q });
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics/leaks/attach-candidates error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Phase 4 — Attach an Orphan Outbound leak row to an existing
  // quote_opportunity. Writes a `capture_leak_reviews(decision='attached')`
  // row (the chokepoint excludes ANY review row, so the queue + counters
  // shrink in lock-step) AND a `quote_events(actor='manual_leak_attach',
  // eventType='email_attached')` audit row keyed off the target quote.
  // Idempotent at the DB level via the unique index on
  // (orgId, messageId, leakType).
  const attachLeakBodySchema = z.object({
    messageId: z.string().min(1),
    targetQuoteId: z.string().min(1),
  });
  app.post("/api/customer-quotes/funnel-diagnostics/leaks/attach", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = attachLeakBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const result = await attachOrphanOutboundToQuote(
        user.organizationId,
        user.id,
        parsed.data.messageId,
        parsed.data.targetQuoteId,
      );
      switch (result.status) {
        case "attached":
          return res.status(201).json({ status: "attached", quoteId: result.quoteId });
        case "already_attached":
          return res.status(200).json({ status: "already_attached", quoteId: result.quoteId });
        case "not_a_leak":
          return res.status(409).json({ status: "not_a_leak" });
        case "not_found":
          return res.status(404).json({ status: "not_found" });
        case "wrong_leak_type":
          return res.status(400).json({ status: "wrong_leak_type" });
        case "invalid_quote":
          return res.status(404).json({ status: "invalid_quote" });
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics/leaks/attach error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #803 — Quote Lifecycle Autopilot prompt queue. Lists every
  // pending "new sender at known customer" prompt scoped to the org so
  // the Quote Opportunities page can render the Add/Dismiss strip.
  // Returns a flat array sorted newest-first; we deliberately do NOT
  // apply rep-scope filtering here — the prompt is a one-window shared
  // chore and any rep with quote-list access should be able to clear it.
  app.get("/api/customer-quotes/new-contact-reviews", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const items = await listNewContactReviews(user.organizationId);
      res.json({ items });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] new-contact-reviews list error:", err);
      res.status(500).json({ error: msg });
    }
  });

  const newContactActionSchema = z.object({
    action: z.enum(["add", "dismiss"]),
    name: z.string().trim().min(1).max(120).optional(),
    companyId: z.string().min(1).optional(),
  });
  app.post("/api/customer-quotes/quote/:id/new-contact-review", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const parsed = newContactActionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payload", details: parsed.error.format() });
      }
      const quoteId = pStr(req.params.id);
      const result = await resolveNewContactReview(
        user.organizationId,
        quoteId,
        parsed.data.action,
        user.id,
        { name: parsed.data.name, companyIdHint: parsed.data.companyId ?? null },
      );
      switch (result.status) {
        case "not_found":            return res.status(404).json({ error: "Quote not found" });
        case "no_pending_prompt":    return res.status(409).json({ error: "No pending prompt for this quote" });
        case "no_company_match":     return res.status(409).json({ error: "Could not match sender domain to an existing customer; create the contact manually." });
        default:                     return res.json(result);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] new-contact-review action error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #723 — manual mark-outcome action. Lets reps resolve a pending
  // quote in-page with one click. Same write-path the auto-detectors use:
  // updates outcomeStatus + reasonId, writes manual_won / manual_lost
  // quote_event, fires the customer touchpoint. Idempotent — bails when
  // the quote is already in a terminal status.
  //
  // Authorization: allowed roles are the ones that can see the funnel.
  // Rep-scoped roles (account_manager etc.) are further restricted by
  // resolveFunnelRepScope to their own quotes — mirrors the GET /list and
  // /funnel scoping so a rep can never act on another rep's row.
  const markOutcomeSchema = z.object({
    outcomeStatus: z.enum([
      "won", "won_low_margin",
      "lost_price", "lost_service", "lost_timing", "lost_incumbent",
      "no_response",
    ]),
    outcomeReasonId: z.string().min(1).nullable().optional(),
  });
  app.post("/api/customer-quotes/quote/:id/mark-outcome", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const allowed = new Set([
        "admin", "director", "sales_director",
        "national_account_manager", "sales",
        "account_manager", "logistics_manager", "logistics_coordinator",
      ]);
      if (!allowed.has(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing quote id" });
      const parsed = markOutcomeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      }
      const { outcomeStatus, outcomeReasonId } = parsed.data;

      // Task #849 §6.1 — defense-in-depth ownership gate at the
      // top of the handler. The service-layer enforceRepScope below
      // is the existing belt; this is the suspenders. Without it,
      // a future refactor that drops the `enforceRepScope` argument
      // would silently re-open the cross-rep mutation hole.
      const gate = await assertCanMutateQuote(user.organizationId, id, user);
      if (!gate.ok) {
        return res.status(gate.status).json({
          error: gate.reason === "forbidden" ? "Quote belongs to another rep"
            : gate.reason === "no_rep_mapping" ? "No rep mapping — cannot mark quotes"
            : "Quote not found",
        });
      }

      // Resolve per-rep scope. Elevated roles get null (no rep restriction);
      // scoped roles get their rep id, which the service uses to bail with
      // status="forbidden" on cross-rep attempts. The "__none__" sentinel
      // means the user is in a scoped role with no rep mapping at all —
      // they can't have any quotes, so reject up-front.
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      if (scope === "__none__") {
        return res.status(403).json({ error: "No rep mapping — cannot mark quotes" });
      }

      const result = await markQuoteOutcome(
        user.organizationId,
        id,
        outcomeStatus as ManualMarkOutcomeStatus,
        outcomeReasonId ?? null,
        actorName(user),
        { enforceRepScope: scope ?? undefined },
      );
      if (result.status === "not_found") return res.status(404).json({ error: "Quote not found" });
      if (result.status === "forbidden") return res.status(403).json({ error: "Quote belongs to another rep" });
      if (result.status === "invalid_reason") return res.status(400).json({ error: "Unknown outcomeReasonId for this org" });
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] mark-outcome error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/sync-tms", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Restrict to admin/director — write path that mutates outcomes.
      if (user.role !== "admin" && user.role !== "director") {
        return res.status(403).json({ error: "Forbidden" });
      }
      const result = await syncQuoteOutcomesFromTms(user.organizationId);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] tms sync error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #480 — list stale quote follow-ups (on-demand recompute supported via ?force=1).
  // Task #690 — viewer-scoped: account_manager sees only their own quotes,
  // managers/directors/admins see the full org list. Scope mirrors
  // resolveFunnelRepScope so behavior is consistent with the funnel view.
  app.get("/api/customer-quotes/stale-followups", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const forceStr = qStr(req.query.force);
      const force = forceStr === "1" || forceStr === "true";
      if (force) clearStaleFollowUpCache(user.organizationId);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const items = await getStaleQuoteFollowUps(user.organizationId, { force, scope });
      res.json({ items });
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #690 — count-only variant for the sidebar badge. Shares the same
  // per-org cache as the full list endpoint (compute is org-wide, then
  // filtered post-cache per viewer), so a sidebar poll is free (cached hit)
  // or triggers a single shared recompute. Returns just the integer to keep
  // the payload tiny across many open tabs.
  app.get("/api/customer-quotes/stale-followups/count", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const count = await getStaleQuoteFollowUpCount(user.organizationId, { scope });
      res.json({ count });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] stale-followups count error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/recompute-stale", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      clearStaleFollowUpCache(user.organizationId);
      const items = await getStaleQuoteFollowUps(user.organizationId, { force: true });
      res.json({ ok: true, count: items.length });
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/export.csv", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const filters = parseFilters(req);
      const csv = await exportCsv(user.organizationId, filters);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="customer-quotes-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #526 — observability for the lazy auto-backfill (and any admin-
  // triggered run). Returns the most recent backfill state for the caller's
  // org so ops can verify the Customer Quotes table is fully real-data-backed.
  app.get("/api/customer-quotes/email-backfill-status", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const status = getEmailBackfillStatus(user.organizationId);
      res.json({ ok: true, organizationId: user.organizationId, status });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] email-backfill-status error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #526 — admin-only endpoint to backfill quote_opportunities from
  // historical inbound email_messages. Idempotent; safe to invoke repeatedly.
  app.post("/api/customer-quotes/backfill-from-emails", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const sinceDays = req.body?.sinceDays ? Number(req.body.sinceDays) : undefined;
      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      const summary = await backfillQuotesFromEmails(user.organizationId, {
        sinceDays: Number.isFinite(sinceDays) ? sinceDays : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] backfill error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Task #752 — Freight Capture Rep Audit (admin-only) ──────────────────
  // GET  /api/customer-quotes/rep-audit          → table + summary counters
  // GET  /api/customer-quotes/rep-audit/users    → user search for the link picker
  // POST /api/customer-quotes/rep-audit/:repId/link     { userId: string|null }
  // POST /api/customer-quotes/rep-audit/:repId/suppress { suppressed: boolean }
  // POST /api/customer-quotes/rep-audit/merge    { sourceRepId, targetRepId }
  function isRepAuditAdmin(role: string | undefined): boolean {
    // Task #752 — admin-only by spec. Mutates rep identity (link / suppress /
    // merge) and changes who appears in the funnel rep dropdown / column /
    // rankings, so we keep this strictly tighter than the rest of the
    // customer-quotes admin surface (which allows admin/director/sales_director).
    return role === "admin";
  }

  app.get("/api/customer-quotes/rep-audit", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const lookbackDays = Math.max(
        1,
        Math.min(365, qInt(req.query.lookbackDays, REP_AUDIT_LOOKBACK_DAYS)),
      );
      const result = await getFreightCaptureRepAudit(user.organizationId, { lookbackDays });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[customer-quotes] rep-audit list error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get("/api/customer-quotes/rep-audit/users", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const q = qStr(req.query.q);
      const rows = await searchOrgUsers(user.organizationId, q, 50);
      res.json({ ok: true, users: rows });
    } catch (err) {
      console.error("[customer-quotes] rep-audit users error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  const linkBodySchema = z.object({
    userId: z.string().min(1).nullable(),
  });
  app.post("/api/customer-quotes/rep-audit/:repId/link", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const repId = pStr(req.params.repId);
      if (!repId) return res.status(400).json({ error: "Missing repId" });
      const parsed = linkBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const result = await linkRepToUser(user.organizationId, repId, parsed.data.userId);
      if (result.status === "not_found") return res.status(404).json({ error: "Rep not found" });
      if (result.status === "invalid") return res.status(400).json({ error: result.message });
      res.json({ ok: true });
    } catch (err) {
      console.error("[customer-quotes] rep-audit link error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  const suppressBodySchema = z.object({ suppressed: z.boolean() });
  app.post("/api/customer-quotes/rep-audit/:repId/suppress", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const repId = pStr(req.params.repId);
      if (!repId) return res.status(400).json({ error: "Missing repId" });
      const parsed = suppressBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const result = await setRepSuppressed(user.organizationId, repId, parsed.data.suppressed);
      if (result.status === "not_found") return res.status(404).json({ error: "Rep not found" });
      if (result.status === "invalid") return res.status(400).json({ error: result.message });
      res.json({ ok: true });
    } catch (err) {
      console.error("[customer-quotes] rep-audit suppress error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  const mergeBodySchema = z.object({
    sourceRepId: z.string().min(1),
    targetRepId: z.string().min(1),
  });
  app.post("/api/customer-quotes/rep-audit/merge", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = mergeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { sourceRepId, targetRepId } = parsed.data;
      const result = await mergeReps(user.organizationId, sourceRepId, targetRepId);
      if (result.status === "not_found") return res.status(404).json({ error: "One or both reps not found" });
      if (result.status === "invalid") return res.status(400).json({ error: result.message });
      res.json({ ok: true, reassigned: result.reassigned ?? 0 });
    } catch (err) {
      console.error("[customer-quotes] rep-audit merge error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // Task #526 — admin-only endpoint to purge demo seed rows that may have
  // leaked into a live org (e.g., when QUOTE_DEMO_SEED_ENABLED was briefly on).
  // Idempotent. Defaults to the caller's org; pass { allOrgs: true } to sweep
  // every org (admin only).
  app.post("/api/customer-quotes/purge-demo-seed", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const allOrgs = Boolean(req.body?.allOrgs) && user.role === "admin";
      const summary = await purgeDemoSeed(allOrgs ? undefined : user.organizationId);
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] purge-demo-seed error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // ===========================================================================
  // Task #849 §3.1, §3.2, §3.3 — operator actions on quote opportunities.
  //
  // These three routes share an authentication+authorization shape:
  //   • requireUser   — must be logged in; org-isolation comes from
  //                     `user.organizationId` on every DB lookup.
  //   • assertCanMutateQuote — Quote Opportunities role + ownership gate.
  //                     This is the same gate `PATCH /quote/:id` uses; it
  //                     covers admin/director/sales_director and treats
  //                     national_account_manager / sales as elevated for
  //                     funnel-wide ops, while keeping account_manager
  //                     scoped to their own opps.
  //
  // Re-attach correction (§5.10) is gated separately to admin/director/
  // sales_director only — `assertCanMutateQuote` would let a sales rep
  // re-attach an opp they own, but the contract reserves the correction
  // path for elevated roles. We check `allowReattach` at the top of the
  // attach-to handler.
  // ===========================================================================

  // ─── §3.1 POST /api/customer-quotes/quote/:id/attach-to ──────────────────
  const attachToBodySchema = z.object({
    targetOppId: z.string().min(1, "targetOppId is required"),
    decision: z.enum(["attached", "duplicate"]).default("attached"),
    note: z.string().max(2000).nullish(),
    allowReattach: z.boolean().optional(),
  });
  app.post("/api/customer-quotes/quote/:id/attach-to", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing quote id" });

      const parsed = attachToBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { targetOppId, decision, note, allowReattach } = parsed.data;

      // Self-attach is a UX bug. Catch it at the route boundary so we
      // don't waste a service call (the service guards too — defense in
      // depth — but we want a precise 400 here).
      if (id === targetOppId) {
        return res.status(400).json({ error: "Cannot attach a quote to itself" });
      }

      // Ownership: the operator must be allowed to mutate the SOURCE opp
      // (the one being closed). They do NOT need to own the target —
      // attach-to-someone-else's opp is the supported flow when the rep
      // hands a duplicate to the canonical owner.
      const gate = await assertCanMutateQuote(user.organizationId, id, user);
      if (!gate.ok) {
        if (gate.status === 404) return res.status(404).json({ error: "Quote not found" });
        return res.status(403).json({ error: gate.reason, deniedIds: gate.deniedIds });
      }

      // Re-attach correction is admin/director/sales_director only.
      // Other roles passing allowReattach=true is rejected up-front so
      // the UI doesn't need to guess at the role matrix.
      const wantsReattach = Boolean(allowReattach);
      const isElevated = ["admin", "director", "sales_director"].includes(user.role);
      if (wantsReattach && !isElevated) {
        return res.status(403).json({ error: "Re-attach correction requires elevated role" });
      }

      const result = await attachQuoteToTarget(
        user.organizationId,
        user.id,
        id,
        targetOppId,
        decision,
        note ?? null,
        wantsReattach,
      );
      switch (result.status) {
        case "source_not_found":
        case "target_not_found":
          return res.status(404).json({ error: result.status });
        case "self_attach":
          return res.status(400).json({ error: "self_attach" });
        case "already_closed":
          return res.status(409).json({
            error: "already_closed",
            currentOutcome: result.currentOutcome,
          });
        case "attached":
        case "reattached":
          return res.json({
            ok: true,
            status: result.status,
            fromOppId: result.fromOppId,
            targetOppId: result.targetOppId,
            previousTargetOppId: result.previousTargetOppId ?? null,
            capturedReviewIds: result.capturedReviewIds ?? [],
          });
      }
    } catch (err) {
      console.error("[customer-quotes] attach-to error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ─── §3.2 POST /api/customer-quotes/quote/:id/send-to-leak ───────────────
  const sendToLeakBodySchema = z.object({
    reason: z.enum(["not_a_request", "unparseable", "wrong_party", "duplicate_email", "other"]),
    note: z.string().max(2000).nullish(),
    suppressSender: z.boolean().optional(),
  });
  app.post("/api/customer-quotes/quote/:id/send-to-leak", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing quote id" });
      const parsed = sendToLeakBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { reason, note, suppressSender } = parsed.data;

      const gate = await assertCanMutateQuote(user.organizationId, id, user);
      if (!gate.ok) {
        if (gate.status === 404) return res.status(404).json({ error: "Quote not found" });
        return res.status(403).json({ error: gate.reason, deniedIds: gate.deniedIds });
      }

      // Sender suppression is a per-org learning operation; reserve to
      // elevated roles + national account managers (who run the senders
      // admin). Other roles can still send to leak — `suppressSender`
      // is silently downgraded to false instead of 403'ing the whole
      // call, which would block the primary write for a secondary
      // permission.
      const allowSuppress = ["admin", "director", "sales_director", "national_account_manager"]
        .includes(user.role);
      const effectiveSuppress = Boolean(suppressSender) && allowSuppress;

      const result = await sendQuoteToLeak(
        user.organizationId,
        user.id,
        id,
        reason,
        note ?? null,
        effectiveSuppress,
      );
      switch (result.status) {
        case "not_found":
          return res.status(404).json({ error: "not_found" });
        case "already_closed":
          return res.status(409).json({
            error: "already_closed",
            currentOutcome: result.currentOutcome,
          });
        case "sent_to_leak":
          return res.json({
            ok: true,
            oppId: result.oppId,
            decision: result.decision,
            capturedReviewIds: result.capturedReviewIds ?? [],
            senderSuppressed: result.senderSuppressed ?? false,
            // Surface the downgrade so the UI can show "suppression
            // skipped — admin only" inline.
            senderSuppressionRequested: Boolean(suppressSender),
          });
      }
    } catch (err) {
      console.error("[customer-quotes] send-to-leak error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ─── §3.3 PATCH /api/customer-quotes/quote/:id/snooze ────────────────────
  const snoozeBodySchema = z.object({
    // ISO-8601 string or null. Null clears the snooze ("unsnooze").
    snoozedUntil: z.string().datetime().nullable(),
  });
  app.patch("/api/customer-quotes/quote/:id/snooze", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing quote id" });
      const parsed = snoozeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { snoozedUntil } = parsed.data;

      // Window guard. Past dates are rejected (use null to clear instead),
      // and we cap the future window at +14d so reps don't park work for
      // a quarter and forget it. Elevated roles get the same cap — this
      // is product policy, not security.
      if (snoozedUntil) {
        const ts = Date.parse(snoozedUntil);
        const now = Date.now();
        if (!Number.isFinite(ts) || ts <= now) {
          return res.status(400).json({ error: "snoozedUntil must be a future date" });
        }
        if (ts - now > SNOOZE_QUOTE_LIMITS.MAX_FUTURE_MS) {
          return res.status(400).json({
            error: "snoozedUntil cannot be more than 14 days in the future",
          });
        }
      }

      const gate = await assertCanMutateQuote(user.organizationId, id, user);
      if (!gate.ok) {
        if (gate.status === 404) return res.status(404).json({ error: "Quote not found" });
        return res.status(403).json({ error: gate.reason, deniedIds: gate.deniedIds });
      }

      const result = await snoozeQuote(user.organizationId, user.id, id, snoozedUntil);
      if (result.status === "not_found") return res.status(404).json({ error: "not_found" });
      return res.json({
        ok: true,
        status: result.status,
        oppId: result.oppId,
        snoozedUntil: result.snoozedUntil,
      });
    } catch (err) {
      console.error("[customer-quotes] snooze error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // ─── Task #1003 — Needs Routing tab + one-click routing ─────────────────
  //
  // Capture-first contract: every quote-shaped inbound email becomes a
  // quote_opportunity row tagged with `routing_status`. The classifier
  // gates AUTOMATION (auto_customer / auto_carrier) on confidence; rows
  // it isn't sure about land in `needs_routing` and are surfaced here for
  // a one-click human decision. This endpoint is intentionally separate
  // from /list so the existing rep-facing Customer Quotes views never
  // accidentally pick up unrouted rows in their default counters.
  app.get("/api/customer-quotes/needs-routing", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const limit = Math.min(qInt(req.query.limit, 50), 200);
      const includeAll = qBool(req.query.includeAll, false);
      const elevatedRoles = new Set([
        "admin", "director", "sales_director", "national_account_manager", "sales",
      ]);
      const isElevated = elevatedRoles.has(user.role);
      // `users.username` holds the rep's email-like login in this codebase
      // (there is no separate `user.email` column); use it for to/cc match.
      const recipientMatch = (user.username ?? "").trim();
      // Recipient scoping: by default a non-elevated rep only sees rows where
      // they are the sender of one of the to/cc addresses on the source
      // email. `includeAll=1` (manager toggle) lifts the scope.
      const scopeNarrowed = !isElevated && !includeAll && !!recipientMatch;
      const scopeFilter = scopeNarrowed
        ? sqlExpr`AND (em.to_email ILIKE ${'%' + recipientMatch + '%'}
                    OR em.cc_email ILIKE ${'%' + recipientMatch + '%'})`
        : sqlExpr``;
      const rows = await db.execute<any>(sqlExpr`
        SELECT q.id, q.organization_id AS "organizationId", q.customer_id AS "customerId",
               q.rep_id AS "repId", q.lane_group_id AS "laneGroupId",
               q.origin_city AS "originCity", q.origin_state AS "originState",
               q.dest_city AS "destCity", q.dest_state AS "destState",
               q.equipment, q.request_date AS "requestDate",
               q.routing_status AS "routingStatus", q.routing_note AS "routingNote",
               q.quote_hints AS "quoteHints",
               q.source_reference AS "sourceReference",
               c.name AS "customerName",
               em.id AS "messageId", em.subject AS "subject", em.from_email AS "fromEmail",
               em.from_name AS "fromName", em.body AS "body",
               em.to_email AS "toEmail", em.cc_email AS "ccEmail",
               em.thread_id AS "threadId", em.created_at AS "messageCreatedAt"
          FROM quote_opportunities q
          LEFT JOIN quote_customers c ON c.id = q.customer_id
          LEFT JOIN email_messages em ON em.id = q.source_reference
         WHERE q.organization_id = ${user.organizationId}
           AND q.routing_status = 'needs_routing'
           ${scopeFilter}
         ORDER BY q.request_date DESC
         LIMIT ${limit}
      `);
      // Task #1016 — `total` now reflects the SAME scope as `rows` so the
      // tab badge, the count line, and the table never disagree. The
      // org-wide number is exposed separately as `orgTotal` so the UI
      // can surface "X more org-wide — switch to All reps" when the
      // rep's recipient scope hides everything.
      const scopedTotalRow = await db.execute<{ c: number }>(sqlExpr`
        SELECT COUNT(*)::int AS c
          FROM quote_opportunities q
          LEFT JOIN email_messages em ON em.id = q.source_reference
         WHERE q.organization_id = ${user.organizationId}
           AND q.routing_status = 'needs_routing'
           ${scopeFilter}
      `);
      const orgTotalRow = scopeNarrowed
        ? await db.execute<{ c: number }>(sqlExpr`
            SELECT COUNT(*)::int AS c
              FROM quote_opportunities
             WHERE organization_id = ${user.organizationId}
               AND routing_status = 'needs_routing'
          `)
        : null;
      const scopedTotal = scopedTotalRow.rows?.[0]?.c ?? 0;
      const orgTotal = orgTotalRow ? (orgTotalRow.rows?.[0]?.c ?? 0) : scopedTotal;
      res.json({
        rows: rows.rows ?? [],
        total: scopedTotal,
        orgTotal,
        scopeNarrowed,
        isElevated,
        includeAll: !!includeAll,
      });
    } catch (err) {
      console.error("[customer-quotes] needs-routing list error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post("/api/customer-quotes/:id/route", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const id = pStr(req.params.id);
      const schema = z.object({
        decision: z.enum(SENDER_ROUTING_DECISIONS),
        remember: z.enum(["none", "email", "domain"]).default("none"),
        note: z.string().max(500).optional().nullable(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      }
      const { decision, remember, note } = parsed.data;

      // Look up the quote + its source email (for the sender address).
      const oppRow = await db.execute<any>(sqlExpr`
        SELECT q.id, q.routing_status AS "routingStatus", q.source_reference AS "sourceReference",
               em.from_email AS "fromEmail"
          FROM quote_opportunities q
          LEFT JOIN email_messages em ON em.id = q.source_reference
         WHERE q.id = ${id} AND q.organization_id = ${user.organizationId}
         LIMIT 1
      `);
      const opp = oppRow.rows?.[0];
      if (!opp) return res.status(404).json({ error: "Quote not found" });

      const newStatus =
        decision === "customer" ? "routed_customer"
        : decision === "carrier" ? "routed_carrier"
        : "dismissed";

      // Task #1053 — idempotency contract for one-click "Confirm & Create".
      // A double-click on the Needs Routing drawer's confirm button (or a
      // race between two reps clicking simultaneously) must NOT create a
      // duplicate row or 409. If the row is already in the requested
      // terminal state we return ok with `idempotent:true` so the UI can
      // collapse the drawer and the optimistic refetch stays consistent.
      if (opp.routingStatus === newStatus) {
        return res.json({ ok: true, id, newStatus, remembered: "none", idempotent: true });
      }
      if (opp.routingStatus !== "needs_routing") {
        return res.status(409).json({ error: "Quote is not in needs_routing state", currentStatus: opp.routingStatus });
      }

      await db.update(quoteOpportunities).set({
        routingStatus: newStatus,
        routingDecisionAt: new Date(),
        routingDecisionByUserId: user.id,
        routingNote: note ?? null,
      }).where(andSql(eqSql(quoteOpportunities.id, id), eqSql(quoteOpportunities.organizationId, user.organizationId)));

      // Optional: remember this decision for future mail from the same
      // sender / domain. Idempotent via ON CONFLICT.
      if (remember !== "none" && opp.fromEmail) {
        const lower = String(opp.fromEmail).trim().toLowerCase();
        const scopeValue = remember === "email"
          ? lower
          : (lower.split("@")[1] ?? "");
        if (scopeValue) {
          await db.execute(sqlExpr`
            INSERT INTO sender_routing_rules (org_id, scope_type, scope_value, decision, remembered_by_user_id)
            VALUES (${user.organizationId}, ${remember}, ${scopeValue}, ${decision}, ${user.id})
            ON CONFLICT (org_id, scope_type, scope_value)
            DO UPDATE SET decision = EXCLUDED.decision, remembered_by_user_id = EXCLUDED.remembered_by_user_id
          `);
        }
      }

      try {
        publishLiveSync(user.organizationId, "customer_quote", id, Date.now());
      } catch { /* best-effort */ }

      res.json({ ok: true, id, newStatus, remembered: remember });
    } catch (err) {
      console.error("[customer-quotes] route decision error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // SLO endpoint — capture-first p50/p95/p99 + open backlog. Read-only,
  // org-scoped, used by the admin pipeline observability page and the
  // Needs Routing tab's small SLO chip.
  app.get("/api/customer-quotes/routing-slo", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Task #1016 — accept the same `includeAll` toggle the list endpoint
      // uses, so the tab badge count reflects what the user will actually
      // see in the table. Org-wide total is still surfaced separately.
      const includeAll = qBool(req.query.includeAll, false);
      const elevatedRoles = new Set([
        "admin", "director", "sales_director", "national_account_manager", "sales",
      ]);
      const isElevated = elevatedRoles.has(user.role);
      const recipientMatch = (user.username ?? "").trim();
      const scopeNarrowed = !isElevated && !includeAll && !!recipientMatch;
      const scopeFilter = scopeNarrowed
        ? sqlExpr`AND (em.to_email ILIKE ${'%' + recipientMatch + '%'}
                    OR em.cc_email ILIKE ${'%' + recipientMatch + '%'})`
        : sqlExpr``;
      const sloRow = await db.execute<{ p50: number | null; p95: number | null; p99: number | null; sample: number }>(sqlExpr`
        SELECT
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (q.created_at - em.created_at))) AS p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (q.created_at - em.created_at))) AS p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (q.created_at - em.created_at))) AS p99,
          COUNT(*)::int AS sample
          FROM quote_opportunities q
          JOIN email_messages em
            ON em.provider_message_id = q.source_reference
           AND em.org_id = q.organization_id
         WHERE q.organization_id = ${user.organizationId}
           AND q.source IN ('email', 'email_signal')
           AND q.created_at >= NOW() - INTERVAL '24 hours'
      `);
      const backlogRow = await db.execute<{ c: number }>(sqlExpr`
        SELECT COUNT(*)::int AS c
          FROM email_messages
         WHERE org_id = ${user.organizationId}
           AND direction = 'inbound'
           AND processed_for_signals_at IS NULL
           AND created_at >= NOW() - INTERVAL '24 hours'
      `);
      // Task #1016 — scoped count first (matches what the rep would see in
      // the Needs Routing table). The org-wide total is returned alongside
      // so the UI can render "X more org-wide" without re-fetching.
      const needsRoutingScopedRow = await db.execute<{ c: number }>(sqlExpr`
        SELECT COUNT(*)::int AS c
          FROM quote_opportunities q
          LEFT JOIN email_messages em ON em.id = q.source_reference
         WHERE q.organization_id = ${user.organizationId}
           AND q.routing_status = 'needs_routing'
           ${scopeFilter}
      `);
      const needsRoutingOrgRow = scopeNarrowed
        ? await db.execute<{ c: number }>(sqlExpr`
            SELECT COUNT(*)::int AS c
              FROM quote_opportunities
             WHERE organization_id = ${user.organizationId}
               AND routing_status = 'needs_routing'
          `)
        : null;
      const needsRoutingCount = needsRoutingScopedRow.rows?.[0]?.c ?? 0;
      const needsRoutingOrgTotal = needsRoutingOrgRow
        ? (needsRoutingOrgRow.rows?.[0]?.c ?? 0)
        : needsRoutingCount;
      res.json({
        p50Sec: sloRow.rows?.[0]?.p50 ?? null,
        p95Sec: sloRow.rows?.[0]?.p95 ?? null,
        p99Sec: sloRow.rows?.[0]?.p99 ?? null,
        sampleSize: sloRow.rows?.[0]?.sample ?? 0,
        unprocessedBacklog: backlogRow.rows?.[0]?.c ?? 0,
        needsRoutingCount,
        needsRoutingOrgTotal,
        scopeNarrowed,
        isElevated,
        includeAll: !!includeAll,
      });
    } catch (err) {
      console.error("[customer-quotes] routing-slo error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
