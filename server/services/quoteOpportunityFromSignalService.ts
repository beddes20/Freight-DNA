import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  captureLeakReviews,
  emailSignals,
  monitoredMailboxes,
  organizations,
  quoteCustomers,
  quoteOpportunities,
  users,
  type EmailMessage,
  type EmailSignal,
} from "@shared/schema";
import { findOrCreateCustomer, findOrCreateRep } from "./quoteEmailIngestion";

export const FORWARD_CLOSURE_ENV_FLAG = "QUOTE_LEAK_FORWARD_CLOSURE_ENABLED";

export function isForwardClosureEnabled(): boolean {
  return (process.env[FORWARD_CLOSURE_ENV_FLAG] ?? "").trim().toLowerCase() === "true";
}

export const CLOSURE_CONFIDENCE_FLOOR = (() => {
  const raw = process.env.QUOTE_LEAK_FORWARD_CLOSURE_CONFIDENCE_FLOOR;
  const n = raw ? parseInt(raw, 10) : 60;
  return Number.isFinite(n) ? n : 60;
})();

export const CLOSURE_ATTACH_WINDOW_DAYS = 14;

const QUOTE_INTENT_TYPES = new Set(["pricing_request", "quote_request"]);

const INTERNAL_CACHE_TTL_MS = 5 * 60 * 1000;
let _internalCache: { ts: number; map: Map<string, Set<string>> } | null = null;
let _internalCacheLoad: Promise<void> | null = null;

// Live writes are gated on this; flipped to true once the partial unique
// index migration is verified at boot. While false, live mode degrades
// to a no-op (returns skipped_not_eligible) so we never lose the
// database-level dedup guarantee.
let _idempotencyIndexVerified = false;

export function _markIdempotencyIndexVerified(): void {
  _idempotencyIndexVerified = true;
}

export function _resetIdempotencyIndexFlagForTests(value: boolean): void {
  _idempotencyIndexVerified = value;
}

export async function verifyClosureIdempotencyIndex(): Promise<void> {
  const r = await db.execute(sql`
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'quote_opportunities_email_signal_source_ref_uidx'
     LIMIT 1
  `);
  const rows = (r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[]);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      "[quote-closure] partial unique index " +
      "quote_opportunities_email_signal_source_ref_uidx is missing — " +
      "refusing to enable live writes (would lose duplicate protection)",
    );
  }
  _markIdempotencyIndexVerified();
}

// Accepts a full RFC 5322 From header in any of the common stored
// shapes and returns a lowercase domain.
//   "user@host.tld"                 -> "host.tld"
//   "Display Name <user@host.tld>"  -> "host.tld"
//   "<user@host.tld>"               -> "host.tld"
//   "  USER @ HOST.TLD  "           -> "host.tld"
// Returns null when the address is unparseable.
const ANGLE_ADDR_RE = /<\s*([^<>\s]+@[^<>\s]+)\s*>/;
const BARE_ADDR_RE = /([^\s<>"'()]+@[^\s<>"'()]+)/;
function extractDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const angle = ANGLE_ADDR_RE.exec(trimmed);
  const candidate = (angle?.[1] ?? BARE_ADDR_RE.exec(trimmed)?.[1] ?? "").trim();
  if (!candidate) return null;
  const at = candidate.lastIndexOf("@");
  if (at < 0) return null;
  let dom = candidate.slice(at + 1).toLowerCase();
  // Defensively strip trailing punctuation that some clients leave on
  // unbracketed forms (e.g. trailing `>`, `;`, `,`).
  dom = dom.replace(/[>;,\s]+$/g, "");
  return dom.length > 0 ? dom : null;
}

export const _extractDomainForTests = extractDomain;

async function loadInternalDomains(): Promise<void> {
  const [mboxRows, userRows, orgRows] = await Promise.all([
    db
      .select({ orgId: monitoredMailboxes.orgId, email: monitoredMailboxes.email })
      .from(monitoredMailboxes),
    db
      .select({ orgId: users.organizationId, email: users.username })
      .from(users),
    db
      .select({ orgId: organizations.id, internalDomains: organizations.internalDomains })
      .from(organizations),
  ]);
  const map = new Map<string, Set<string>>();
  const ensureSet = (orgId: string): Set<string> => {
    let set = map.get(orgId);
    if (!set) {
      set = new Set();
      map.set(orgId, set);
    }
    return set;
  };
  const addEmail = (orgId: string, email: string | null | undefined) => {
    const dom = extractDomain(email);
    if (dom) ensureSet(orgId).add(dom);
  };
  for (const r of mboxRows) addEmail(r.orgId, r.email);
  for (const r of userRows) addEmail(r.orgId, r.email);
  for (const r of orgRows) {
    const list = r.internalDomains ?? [];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const dom = (typeof raw === "string" ? raw : "").trim().toLowerCase().replace(/^@/, "");
      if (dom) ensureSet(r.orgId).add(dom);
    }
  }
  _internalCache = { ts: Date.now(), map };
}

async function ensureInternalDomainsCache(): Promise<void> {
  const fresh = _internalCache && Date.now() - _internalCache.ts <= INTERNAL_CACHE_TTL_MS;
  if (fresh) return;
  if (_internalCacheLoad) {
    await _internalCacheLoad;
    return;
  }
  _internalCacheLoad = loadInternalDomains().finally(() => {
    _internalCacheLoad = null;
  });
  await _internalCacheLoad;
}

export async function isInternalDomain(
  orgId: string,
  email: string | null | undefined,
): Promise<boolean> {
  const dom = extractDomain(email);
  if (!dom) return false;
  await ensureInternalDomainsCache();
  return _internalCache?.map.get(orgId)?.has(dom) ?? false;
}

export function _resetInternalDomainsCacheForTests(): void {
  _internalCache = null;
  _internalCacheLoad = null;
}

export type ClosureDecisionKind =
  | "created"
  | "would_create"
  | "attached"
  | "would_attach"
  | "skipped_low_confidence"
  | "would_skipped_low_confidence"
  | "skipped_internal";

interface DecisionEntry {
  ts: number;
  kind: ClosureDecisionKind;
}

const DECISION_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const _decisionsByOrg = new Map<string, DecisionEntry[]>();

function recordDecision(orgId: string, kind: ClosureDecisionKind): void {
  let list = _decisionsByOrg.get(orgId);
  if (!list) {
    list = [];
    _decisionsByOrg.set(orgId, list);
  }
  const now = Date.now();
  list.push({ ts: now, kind });
  const cutoff = now - DECISION_RETENTION_MS;
  let drop = 0;
  while (drop < list.length && list[drop].ts < cutoff) drop++;
  if (drop > 0) list.splice(0, drop);
}

export interface ClosureCounters {
  enabled: boolean;
  created: number;
  attached: number;
  skippedLowConfidence: number;
  skippedInternal: number;
  wouldCreate: number;
  wouldAttach: number;
  wouldSkippedLowConfidence: number;
}

export function getClosureCounters(orgId: string, sinceMs: number): ClosureCounters {
  const list = _decisionsByOrg.get(orgId) ?? [];
  const out: ClosureCounters = {
    enabled: isForwardClosureEnabled(),
    created: 0,
    attached: 0,
    skippedLowConfidence: 0,
    skippedInternal: 0,
    wouldCreate: 0,
    wouldAttach: 0,
    wouldSkippedLowConfidence: 0,
  };
  for (const d of list) {
    if (d.ts < sinceMs) continue;
    switch (d.kind) {
      case "created": out.created++; break;
      case "attached": out.attached++; break;
      case "skipped_low_confidence": out.skippedLowConfidence++; break;
      case "would_create": out.wouldCreate++; break;
      case "would_attach": out.wouldAttach++; break;
      case "would_skipped_low_confidence": out.wouldSkippedLowConfidence++; break;
      case "skipped_internal": out.skippedInternal++; break;
    }
  }
  return out;
}

export function _resetClosureCountersForTests(): void {
  _decisionsByOrg.clear();
}

const _threadLocks = new Map<string, Promise<unknown>>();

async function withThreadMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _threadLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ours = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => ours);
  _threadLocks.set(key, chained);
  try {
    await prev.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (_threadLocks.get(key) === chained) {
      _threadLocks.delete(key);
    }
  }
}

export type ClosureOutcome =
  | "created"
  | "attached"
  | "skipped_low_confidence"
  | "would_create"
  | "would_attach"
  | "would_skipped_low_confidence"
  | "skipped_internal"
  | "skipped_not_eligible";

export interface ClosureDecisionResult {
  outcome: ClosureOutcome;
  signalId: string;
  opportunityId?: string;
  reason: string;
}

const LOG_EVERY = (() => {
  const raw = process.env.QUOTE_LEAK_FORWARD_CLOSURE_LOG_EVERY;
  const n = raw ? parseInt(raw, 10) : 100;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();
let _decisionCounter = 0;

function maybeLogDecision(
  message: EmailMessage,
  signal: EmailSignal,
  result: ClosureDecisionResult,
): void {
  _decisionCounter++;
  if (_decisionCounter % LOG_EVERY !== 0) return;
  console.log(
    `[quote-closure] ${result.outcome} org=${message.orgId} ` +
    `msg=${message.id} signal=${signal.id} conf=${signal.confidence} ` +
    `from=${message.fromEmail ?? "?"} reason=${result.reason}` +
    (result.opportunityId ? ` opp=${result.opportunityId}` : ""),
  );
}

interface LaneFields {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
}

function pickStr(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function deriveLaneFields(extracted: Record<string, unknown> | null | undefined): LaneFields {
  const data = extracted ?? {};
  const originCity = pickStr(data, ["originCity", "origin_city", "pickupCity", "pickup_city"]) ?? "Unknown";
  const originState = (pickStr(data, ["originState", "origin_state", "pickupState"]) ?? "??").toUpperCase();
  const destCity = pickStr(data, ["destCity", "destination_city", "destinationCity", "deliveryCity"]) ?? "Unknown";
  const destState = (pickStr(data, ["destState", "destination_state", "destinationState"]) ?? "??").toUpperCase();
  const equipment = pickStr(data, ["equipment", "equipmentType", "equipment_type"]) ?? "Unknown";
  return { originCity, originState, destCity, destState, equipment };
}

async function findOpportunityBySourceReference(
  orgId: string,
  providerMessageId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: quoteOpportunities.id })
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.sourceReference, providerMessageId),
    ))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function findRecentOpenOpportunityForCustomer(
  orgId: string,
  customerId: string,
  windowDays: number,
): Promise<string | null> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: quoteOpportunities.id })
    .from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      eq(quoteOpportunities.customerId, customerId),
      eq(quoteOpportunities.outcomeStatus, "pending"),
      gte(quoteOpportunities.requestDate, cutoff),
    ))
    .orderBy(desc(quoteOpportunities.requestDate))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function findExistingCustomerByName(
  orgId: string,
  name: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: quoteCustomers.id })
    .from(quoteCustomers)
    .where(and(
      eq(quoteCustomers.organizationId, orgId),
      sql`lower(${quoteCustomers.name}) = lower(${name})`,
    ))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveCustomerForMessage(
  message: EmailMessage,
): Promise<{ name: string; confidence: "high" | "medium" | "low" | "unknown" }> {
  const { resolveCustomerName } = await import("./customerNameResolver");
  const resolved = resolveCustomerName({
    fromEmail: message.fromEmail,
    subject: message.subject,
    body: message.body,
  });
  return { name: resolved.name, confidence: resolved.confidence };
}

async function writeLowConfidenceLeakReview(
  orgId: string,
  messageId: string,
  note: string,
): Promise<void> {
  await db
    .insert(captureLeakReviews)
    .values({
      organizationId: orgId,
      messageId,
      leakType: "missed_inbound",
      decision: "deferred",
      decidedByUserId: null,
      note,
    })
    .onConflictDoNothing({
      target: [
        captureLeakReviews.organizationId,
        captureLeakReviews.messageId,
        captureLeakReviews.leakType,
      ],
    });
}

export async function processQuoteSignalClosure(
  message: EmailMessage,
  savedSignals: EmailSignal[],
): Promise<ClosureDecisionResult[]> {
  if (message.direction !== "inbound") return [];
  const eligible = savedSignals.filter(
    (s) => s.actorType === "customer" && QUOTE_INTENT_TYPES.has(s.intentType),
  );
  if (eligible.length === 0) return [];

  const mutexKey = `${message.orgId}:${message.threadId ?? message.id}`;
  return withThreadMutex(mutexKey, async () => {
    const results: ClosureDecisionResult[] = [];
    for (const signal of eligible) {
      const result = await processOneSignal(message, signal);
      results.push(result);
      maybeLogDecision(message, signal, result);
    }
    return results;
  });
}

async function processOneSignal(
  message: EmailMessage,
  signal: EmailSignal,
): Promise<ClosureDecisionResult> {
  const dryRun = !isForwardClosureEnabled();

  if (await isInternalDomain(message.orgId, message.fromEmail)) {
    recordDecision(message.orgId, "skipped_internal");
    return {
      outcome: "skipped_internal",
      signalId: signal.id,
      reason: `internal sender domain (${message.fromEmail ?? "?"})`,
    };
  }

  // Task #849 §3.2 — operator-installed suppression. A `quote_sender_mappings`
  // row with `suppressed=true` flagged this sender (or its domain) as
  // "do not auto-create opps". This sits before the confidence floor on
  // purpose: a high-confidence classifier hit from a suppressed sender
  // is still wrong, and we want the decision to be observable in the
  // closure counters so admins can see suppression working. We piggy-
  // back on the existing `skipped_internal` counter rather than minting
  // a new bucket because the operator-facing tile groups them as
  // "intentionally not opp'd".
  const { findSuppressionMapping } = await import("./quoteSenderMappings");
  const suppression = await findSuppressionMapping(message.orgId, message.fromEmail);
  if (suppression) {
    recordDecision(message.orgId, "skipped_internal");
    return {
      outcome: "skipped_internal",
      signalId: signal.id,
      reason: `suppressed sender (${message.fromEmail ?? "?"} via mapping ${suppression.id})`,
    };
  }

  // Refuse live writes when the dedup index isn't verified — losing
  // ON CONFLICT DO NOTHING would let concurrent workers create
  // duplicate opps for the same source_reference.
  if (!dryRun && !_idempotencyIndexVerified) {
    return {
      outcome: "skipped_not_eligible",
      signalId: signal.id,
      reason: "idempotency index not verified; live writes disabled",
    };
  }

  if (signal.confidence < CLOSURE_CONFIDENCE_FLOOR) {
    const reason = `confidence ${signal.confidence} < floor ${CLOSURE_CONFIDENCE_FLOOR}`;
    if (dryRun) {
      recordDecision(message.orgId, "would_skipped_low_confidence");
      return {
        outcome: "would_skipped_low_confidence",
        signalId: signal.id,
        reason: `dry-run: ${reason}`,
      };
    }
    await writeLowConfidenceLeakReview(
      message.orgId,
      message.id,
      `low_confidence: ${signal.intentType}=${signal.confidence}`,
    );
    recordDecision(message.orgId, "skipped_low_confidence");
    return {
      outcome: "skipped_low_confidence",
      signalId: signal.id,
      reason,
    };
  }

  const providerMessageId = message.providerMessageId ?? message.id;

  const existingByRef = await findOpportunityBySourceReference(message.orgId, providerMessageId);
  if (existingByRef) {
    if (dryRun) {
      recordDecision(message.orgId, "would_attach");
      return {
        outcome: "would_attach",
        signalId: signal.id,
        opportunityId: existingByRef,
        reason: "dry-run: existing opp for providerMessageId",
      };
    }
    await linkSignalToOpportunity(signal.id, existingByRef);
    recordDecision(message.orgId, "attached");
    return {
      outcome: "attached",
      signalId: signal.id,
      opportunityId: existingByRef,
      reason: "existing opp for providerMessageId",
    };
  }

  const resolved = await resolveCustomerForMessage(message);

  // Free-mail / unresolvable sender guard. When the resolver can't recover
  // a real customer name (no business domain, no signature company, no
  // usable display name), refuse to attach to the shared
  // "Unknown — needs review" bucket — that path would silently merge
  // unrelated Gmail/Yahoo quote requests onto the same open opp. Route
  // to the leak queue for human triage instead.
  if (resolved.confidence === "unknown") {
    const note = `unresolvable_sender: ${message.fromEmail ?? "?"} (${signal.intentType})`;
    if (dryRun) {
      recordDecision(message.orgId, "would_skipped_low_confidence");
      return {
        outcome: "would_skipped_low_confidence",
        signalId: signal.id,
        reason: `dry-run: ${note}`,
      };
    }
    await writeLowConfidenceLeakReview(message.orgId, message.id, note);
    recordDecision(message.orgId, "skipped_low_confidence");
    return {
      outcome: "skipped_low_confidence",
      signalId: signal.id,
      reason: note,
    };
  }

  const customerName = resolved.name;

  if (dryRun) {
    const existingCustomerId = await findExistingCustomerByName(message.orgId, customerName);
    if (existingCustomerId) {
      const existingByCustomer = await findRecentOpenOpportunityForCustomer(
        message.orgId,
        existingCustomerId,
        CLOSURE_ATTACH_WINDOW_DAYS,
      );
      if (existingByCustomer) {
        recordDecision(message.orgId, "would_attach");
        return {
          outcome: "would_attach",
          signalId: signal.id,
          opportunityId: existingByCustomer,
          reason: `dry-run: recent open opp for existing customer (within ${CLOSURE_ATTACH_WINDOW_DAYS}d)`,
        };
      }
    }
    recordDecision(message.orgId, "would_create");
    return {
      outcome: "would_create",
      signalId: signal.id,
      reason: existingCustomerId
        ? "dry-run: would create new opp for existing customer"
        : "dry-run: would create new opp + new customer",
    };
  }

  const customerId = await findOrCreateCustomer(message.orgId, customerName, message.fromEmail ?? null);

  const existingByCustomer = await findRecentOpenOpportunityForCustomer(
    message.orgId,
    customerId,
    CLOSURE_ATTACH_WINDOW_DAYS,
  );
  if (existingByCustomer) {
    await linkSignalToOpportunity(signal.id, existingByCustomer);
    recordDecision(message.orgId, "attached");
    return {
      outcome: "attached",
      signalId: signal.id,
      opportunityId: existingByCustomer,
      reason: `recent open opp for customer (within ${CLOSURE_ATTACH_WINDOW_DAYS}d)`,
    };
  }

  const lane = deriveLaneFields(signal.extractedData as Record<string, unknown> | null);
  const repId = await findOrCreateRep(
    message.orgId,
    (message.toEmail ?? "").split(/[,;]/)[0]?.trim().toLowerCase() ?? "",
  );
  const requestDate = message.providerSentAt ?? message.createdAt ?? new Date();
  const validThrough = new Date(requestDate.getTime() + 7 * 24 * 60 * 60 * 1000);

  const inserted = await db
    .insert(quoteOpportunities)
    .values({
      organizationId: message.orgId,
      customerId,
      repId: repId ?? null,
      laneGroupId: null,
      carrierId: null,
      outcomeReasonId: null,
      requestDate,
      originCity: lane.originCity,
      originState: lane.originState,
      destCity: lane.destCity,
      destState: lane.destState,
      equipment: lane.equipment,
      quotedAmount: null,
      validThrough,
      outcomeStatus: "pending",
      carrierPaid: null,
      responseTimeHours: null,
      source: "email_signal",
      sourceReference: providerMessageId,
      notes: message.subject ?? null,
      score: null,
      needsNewContactReview: null,
    })
    .onConflictDoNothing()
    .returning({ id: quoteOpportunities.id });

  if (inserted.length === 0) {
    const existing = await findOpportunityBySourceReference(message.orgId, providerMessageId);
    if (!existing) {
      console.error(
        `[quote-closure] insert returned no row but no existing opp found for ` +
        `org=${message.orgId} ref=${providerMessageId}`,
      );
      return {
        outcome: "skipped_not_eligible",
        signalId: signal.id,
        reason: "insert conflict but no existing opp visible (anomaly)",
      };
    }
    await linkSignalToOpportunity(signal.id, existing);
    recordDecision(message.orgId, "attached");
    return {
      outcome: "attached",
      signalId: signal.id,
      opportunityId: existing,
      reason: "lost insert race; attached to concurrent winner",
    };
  }

  const oppId = inserted[0].id;
  await linkSignalToOpportunity(signal.id, oppId);
  recordDecision(message.orgId, "created");
  return {
    outcome: "created",
    signalId: signal.id,
    opportunityId: oppId,
    reason: "created new opp from signal",
  };
}

async function linkSignalToOpportunity(signalId: string, opportunityId: string): Promise<void> {
  await db
    .update(emailSignals)
    .set({ linkedOpportunityId: opportunityId })
    .where(eq(emailSignals.id, signalId));
}
