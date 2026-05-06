/**
 * Email Intelligence Signal Consumers — Unit Tests (Task #191)
 *
 * Covers all five consumer areas:
 *   1. Account score consumers (emailSignalSummaryService)
 *   2. Account NBA consumers (generateAccountEmailNbas) — thread-keyed dedup
 *   3. Carrier enrichment (stageCarrierEmailEnrichment) — incl. new_equipment_or_region
 *   4. Carrier NBAs (generateCarrierEmailNbas) — signal-key dedup
 *   5. Win/loss evidence — co-queryability of all batch signals + opportunityId
 *   6. Integration safety
 *
 * Run with: npx tsx tests/email-signal-consumers.test.ts
 * Does NOT require a running server or live DB — all tests use in-memory mocks.
 */

import { getRecentAccountEmailSignalSummary, getRecentCarrierEmailSignalSummary } from "../server/emailSignalSummaryService";
import { generateAccountEmailNbas } from "../server/nextBestActionEngine";
import { generateCarrierEmailNbas } from "../server/carrierEmailNbaService";
import { stageCarrierEmailEnrichment } from "../server/carrierEmailEnrichmentService";
import { processWinLossEvidence } from "../server/emailWinLossService";
import type { EmailMessage, EmailSignal, NbaCard, CarrierEmailSuggestion, EmailOutcomeLink, CarrierMarketNba } from "../shared/schema";

// ─── Test infrastructure ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    const msg = detail ? `  ✗ ${description}\n    ${detail}` : `  ✗ ${description}`;
    console.error(msg);
    failures.push(description + (detail ? ` — ${detail}` : ""));
    failed++;
  }
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-1",
    orgId: "org-1",
    providerMessageId: null,
    threadId: "thread-abc",
    direction: "inbound",
    fromEmail: "test@customer.com",
    toEmail: "rep@broker.com",
    ccEmail: null,
    subject: "Re: Pricing inquiry",
    body: null,
    linkedAccountId: "account-1",
    linkedCarrierId: null,
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<EmailSignal> = {}): EmailSignal {
  return {
    id: "signal-1",
    messageId: "msg-1",
    intentType: "pricing_request",
    intentSubtype: null,
    actorType: "customer",
    entityType: "account",
    entityId: "account-1",
    confidence: 80,
    extractedData: {},
    linkedAccountId: null,
    linkedCarrierId: null,
    linkedLaneId: null,
    linkedOpportunityId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ─── 1. Account Score Consumers ───────────────────────────────────────────────

console.log("\n── 1. Account Score Consumers (emailSignalSummaryService) ─────────\n");

{
  const now = new Date();

  const signals: EmailSignal[] = [
    makeSignal({ intentType: "meaningful_touchpoint", confidence: 90, createdAt: now }),
    makeSignal({ id: "s2", intentType: "stalled_thread", confidence: 75, createdAt: now }),
    makeSignal({ id: "s3", intentType: "service_complaint", confidence: 80, createdAt: now }),
  ];

  const mockStorage = {
    getEmailSignalsForAccount: async (_accountId: string) => signals,
  };

  const summary = await getRecentAccountEmailSignalSummary("account-1", 30, mockStorage);

  assert(
    "meaningful_touchpoint count is included in summary",
    summary.counts.meaningful_touchpoint === 1,
    `expected 1, got ${summary.counts.meaningful_touchpoint}`,
  );

  assert(
    "stalled_thread count is negative signal",
    summary.counts.stalled_thread === 1 && summary.hasWarningSigns === true,
    `stalled=${summary.counts.stalled_thread}, hasWarningSigns=${summary.hasWarningSigns}`,
  );

  assert(
    "service_complaint is flagged as warning sign",
    summary.counts.service_complaint === 1 && summary.hasWarningSigns === true,
  );

  assert(
    "accountId is preserved in summary",
    summary.accountId === "account-1",
  );

  // Test window filtering
  const oldSignal: EmailSignal = makeSignal({
    id: "old-signal",
    intentType: "new_opportunity",
    createdAt: new Date(Date.now() - 40 * 86400000),
  });
  const filteredStorage = { getEmailSignalsForAccount: async () => [oldSignal] };
  const filteredSummary = await getRecentAccountEmailSignalSummary("account-1", 30, filteredStorage);
  assert(
    "signals older than window are excluded from summary",
    filteredSummary.counts.new_opportunity === 0,
    `expected 0 new_opportunity, got ${filteredSummary.counts.new_opportunity}`,
  );

  // Test carrier summary
  const carrierSignals: EmailSignal[] = [
    makeSignal({ id: "c1", intentType: "lane_offer", actorType: "carrier", createdAt: now }),
    makeSignal({ id: "c2", intentType: "price_pushback", actorType: "carrier", createdAt: now }),
  ];
  const carrierMockStorage = { getEmailSignalsForCarrier: async () => carrierSignals };
  const carrierSummary = await getRecentCarrierEmailSignalSummary("carrier-1", 14, carrierMockStorage);
  assert(
    "carrier lane_offer count is tracked",
    carrierSummary.counts.lane_offer === 1,
  );
  assert(
    "carrier price_pushback is flagged as risk signal",
    carrierSummary.counts.price_pushback === 1 && carrierSummary.hasRiskSignals === true,
  );

  // Graceful fallback
  const failingStorage = { getEmailSignalsForAccount: async () => { throw new Error("DB error"); } };
  const fallbackSummary = await getRecentAccountEmailSignalSummary("account-1", 30, failingStorage);
  assert(
    "getRecentAccountEmailSignalSummary returns empty summary on DB error",
    fallbackSummary.signals.length === 0 && fallbackSummary.counts.stalled_thread === 0,
  );
}

// ─── 2. Account NBA Consumers ─────────────────────────────────────────────────

console.log("\n── 2. Account NBA Consumers (generateAccountEmailNbas) ─────────────\n");

{
  const createdCards: NbaCard[] = [];

  const mockStorage = {
    getRecentNbaCardByType: async () => undefined,
    getActiveNbaCardByThreadAndType: async (_companyId: string, _ruleType: string, _threadId: string) =>
      createdCards.find(c => c.ruleType === _ruleType && (c.signalSummary as any[]).some((s: any) => s.threadId === _threadId)),
    getFirstOrgAdmin: async () => ({ id: "user-admin" } as any),
    createNbaCard: async (data: any): Promise<NbaCard> => {
      const card = { id: `card-${createdCards.length + 1}`, ...data } as NbaCard;
      createdCards.push(card);
      return card;
    },
  };

  const msg = makeMessage();
  const pricingSignal = makeSignal({ intentType: "pricing_request", confidence: 80 });

  await generateAccountEmailNbas("org-1", "account-1", msg, [pricingSignal], mockStorage);

  assert(
    "pricing_request signal creates an NBA card",
    createdCards.length === 1,
    `expected 1 card, got ${createdCards.length}`,
  );
  assert(
    "pricing_request NBA has correct ruleType",
    createdCards[0]?.ruleType === "email_quote_follow_up",
    `got ${createdCards[0]?.ruleType}`,
  );

  // Test objection NBA
  const objectionSignal = makeSignal({ id: "s2", intentType: "objection", confidence: 75 });
  await generateAccountEmailNbas("org-1", "account-1", msg, [objectionSignal], mockStorage);
  assert(
    "objection signal creates an objection-handling NBA",
    createdCards.some(c => c.ruleType === "email_objection_handling"),
  );

  // Test thread-keyed dedup: same threadId + ruleType → no duplicate
  const beforeCount = createdCards.length;
  await generateAccountEmailNbas("org-1", "account-1", msg, [pricingSignal], mockStorage);
  assert(
    "same thread + ruleType does not create a duplicate NBA card",
    createdCards.length === beforeCount,
    `before=${beforeCount}, after=${createdCards.length}`,
  );

  // Test different threadId: SHOULD create a new card even for same ruleType
  const msg2 = makeMessage({ id: "msg-2", threadId: "thread-different" });
  const pricingSignal2 = makeSignal({ id: "p2", intentType: "pricing_request", confidence: 80 });
  await generateAccountEmailNbas("org-1", "account-1", msg2, [pricingSignal2], mockStorage);
  assert(
    "different thread creates a new NBA card for the same ruleType",
    createdCards.filter(c => c.ruleType === "email_quote_follow_up").length === 2,
    `found ${createdCards.filter(c => c.ruleType === "email_quote_follow_up").length} pricing NBAs`,
  );

  // Test low-confidence signals are skipped
  const lowConfSignal = makeSignal({ id: "low", intentType: "service_complaint", confidence: 40 });
  const beforeLow = createdCards.length;
  await generateAccountEmailNbas("org-1", "account-1", msg, [lowConfSignal], mockStorage);
  assert(
    "signals below confidence threshold are not turned into NBAs",
    createdCards.length === beforeLow,
  );

  // Test same-thread dedup for same intent family (two signals, same family)
  const dedupCards: NbaCard[] = [];
  const dedupStorage = {
    getRecentNbaCardByType: async () => undefined,
    getActiveNbaCardByThreadAndType: async (_a: string, _r: string, _t: string) =>
      dedupCards.find(c => c.ruleType === _r && (c.signalSummary as any[]).some((s: any) => s.threadId === _t)),
    getFirstOrgAdmin: async () => ({ id: "user-admin" } as any),
    createNbaCard: async (data: any) => {
      const c = { id: `dc-${dedupCards.length}`, ...data } as NbaCard;
      dedupCards.push(c);
      return c;
    },
  };
  const urgencySignal1 = makeSignal({ id: "u1", intentType: "urgency_signal", confidence: 80 });
  const urgencySignal2 = makeSignal({ id: "u2", intentType: "urgency_signal", confidence: 80 });
  await generateAccountEmailNbas("org-1", "account-1", msg, [urgencySignal1, urgencySignal2], dedupStorage);
  assert(
    "same intent family within same thread is deduped to one NBA (in-memory pass)",
    dedupCards.filter(c => c.ruleType === "email_urgency_outreach").length === 1,
    `expected 1, got ${dedupCards.filter(c => c.ruleType === "email_urgency_outreach").length}`,
  );

  // Test all NBA ruleTypes use email_ prefix
  assert(
    "all account email NBA ruleTypes use email_ prefix",
    createdCards.every(c => c.ruleType.startsWith("email_")),
    `non-email ruleTypes: ${createdCards.filter(c => !c.ruleType.startsWith("email_")).map(c => c.ruleType).join(", ")}`,
  );
}

// ─── 3. Carrier Enrichment ────────────────────────────────────────────────────

console.log("\n── 3. Carrier Enrichment (stageCarrierEmailEnrichment) ──────────────\n");

{
  const staged: CarrierEmailSuggestion[] = [];

  const mockStorage = {
    getCarrierEmailSuggestionByDedup: async () => undefined,
    insertCarrierEmailSuggestion: async (data: any): Promise<CarrierEmailSuggestion> => {
      const s = { id: `sug-${staged.length + 1}`, createdAt: new Date(), ...data } as CarrierEmailSuggestion;
      staged.push(s);
      return s;
    },
  };

  const carrierMsg = makeMessage({ linkedCarrierId: "carrier-1", linkedAccountId: null });
  const laneOfferSignal = makeSignal({ intentType: "lane_offer", actorType: "carrier", confidence: 75 });

  const result = await stageCarrierEmailEnrichment("carrier-1", carrierMsg, [laneOfferSignal], mockStorage);

  assert(
    "lane_offer signal creates a staged enrichment suggestion",
    result.staged === 1,
    `staged=${result.staged}, deduped=${result.deduped}, skipped=${result.skipped}`,
  );
  assert(
    "staged suggestion has correct suggestionType",
    staged[0]?.suggestionType === "positive_lane_preference",
    `got ${staged[0]?.suggestionType}`,
  );

  // Test new_equipment_or_region creates equipment_or_region_preference
  const equipSignal = makeSignal({ id: "eq1", intentType: "new_equipment_or_region", actorType: "carrier", confidence: 70 });
  await stageCarrierEmailEnrichment("carrier-1", carrierMsg, [equipSignal], mockStorage);
  assert(
    "new_equipment_or_region creates an equipment_or_region_preference suggestion",
    staged.some(s => s.suggestionType === "equipment_or_region_preference"),
    `suggestions: ${staged.map(s => s.suggestionType).join(", ")}`,
  );

  // Test capacity_unavailable creates suppression suggestion
  const suppressSignal = makeSignal({ id: "cap-u", intentType: "capacity_unavailable", actorType: "carrier", confidence: 70 });
  await stageCarrierEmailEnrichment("carrier-1", carrierMsg, [suppressSignal], mockStorage);
  assert(
    "capacity_unavailable creates a capacity_suppression suggestion",
    staged.some(s => s.suggestionType === "capacity_suppression"),
    `suggestions: ${staged.map(s => s.suggestionType).join(", ")}`,
  );

  // Test dedup: same threadId + type + hash should not create duplicate
  const dedupStagged: CarrierEmailSuggestion[] = [];
  let existing: CarrierEmailSuggestion | undefined;
  const dedupStorage = {
    getCarrierEmailSuggestionByDedup: async () => existing,
    insertCarrierEmailSuggestion: async (data: any): Promise<CarrierEmailSuggestion> => {
      const s = { id: `dup-${dedupStagged.length + 1}`, createdAt: new Date(), ...data } as CarrierEmailSuggestion;
      dedupStagged.push(s);
      existing = s;
      return s;
    },
  };

  const dupSignal = makeSignal({ id: "dup1", intentType: "lane_offer", actorType: "carrier", confidence: 70 });
  await stageCarrierEmailEnrichment("carrier-1", carrierMsg, [dupSignal], dedupStorage);
  const firstCount = dedupStagged.length;
  await stageCarrierEmailEnrichment("carrier-1", carrierMsg, [dupSignal], dedupStorage);
  assert(
    "duplicate carrier suggestions (same thread/type/hash) are deduped",
    dedupStagged.length === firstCount,
    `before=${firstCount}, after=${dedupStagged.length}`,
  );
}

// ─── 4. Carrier NBAs ──────────────────────────────────────────────────────────

console.log("\n── 4. Carrier NBAs (generateCarrierEmailNbas) ───────────────────────\n");

{
  const carrierNbas: CarrierMarketNba[] = [];

  const mockStorage = {
    getCarrierMarketNbaBySignalKey: async (_carrierId: string, _signalId: string) =>
      carrierNbas.find(n => n.marketSignalId === _signalId && n.carrierId === _carrierId),
    upsertCarrierMarketNba: async (data: any): Promise<CarrierMarketNba> => {
      const nba = { id: `cnba-${carrierNbas.length + 1}`, createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date(), ...data } as CarrierMarketNba;
      carrierNbas.push(nba);
      return nba;
    },
    getFirstOrgAdmin: async () => ({ id: "user-admin" } as any),
  };

  const carrierMsg = makeMessage({ linkedCarrierId: "carrier-1", linkedAccountId: null, threadId: "carrier-thread-1" });
  const pricePushbackSignal = makeSignal({ id: "pp1", intentType: "price_pushback", actorType: "carrier", confidence: 75 });

  const ppResult = await generateCarrierEmailNbas("carrier-1", carrierMsg, [pricePushbackSignal], mockStorage);

  assert(
    "price_pushback signal creates a carrier pricing review NBA",
    ppResult.created === 1,
    `created=${ppResult.created}`,
  );
  assert(
    "pricing review NBA has correct recommendationType",
    carrierNbas[0]?.recommendationType === "email_pricing_review",
    `got ${carrierNbas[0]?.recommendationType}`,
  );

  // Test hard_commitment → assignment-ready NBA
  const hardCommitSignal = makeSignal({ id: "hc1", intentType: "hard_commitment", actorType: "carrier", confidence: 85 });
  await generateCarrierEmailNbas("carrier-1", carrierMsg, [hardCommitSignal], mockStorage);
  assert(
    "hard_commitment creates assignment-ready carrier NBA",
    carrierNbas.some(n => n.recommendationType === "email_assignment_ready"),
  );

  // Test signal-key dedup: same thread + intent family → only one NBA even with different recommendationTypes
  const dedupNbas: CarrierMarketNba[] = [];
  let existingNba: CarrierMarketNba | undefined;
  const dedupStorage = {
    getCarrierMarketNbaBySignalKey: async (_cid: string, signalKey: string) =>
      dedupNbas.find(n => n.marketSignalId === signalKey && n.carrierId === _cid),
    upsertCarrierMarketNba: async (data: any): Promise<CarrierMarketNba> => {
      const existing = dedupNbas.find(n => n.marketSignalId === data.marketSignalId && n.carrierId === data.carrierId);
      if (existing) return existing;
      const n = { id: `dup-cnba-${dedupNbas.length + 1}`, createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date(), ...data } as CarrierMarketNba;
      dedupNbas.push(n);
      return n;
    },
    getFirstOrgAdmin: async () => ({ id: "user-admin" } as any),
  };

  // Two signals in the same intent family ("capacity") for the same thread
  const capAvailSignal = makeSignal({ id: "ca1", intentType: "capacity_available", actorType: "carrier", confidence: 75 });
  const laneOfferSignal = makeSignal({ id: "lo1", intentType: "lane_offer", actorType: "carrier", confidence: 75 });
  await generateCarrierEmailNbas("carrier-1", carrierMsg, [capAvailSignal, laneOfferSignal], dedupStorage);
  assert(
    "two signals in the same intent family (capacity) on the same thread yield only one NBA",
    dedupNbas.length === 1,
    `expected 1, got ${dedupNbas.length}`,
  );

  // Test same-thread dedup: re-running with same signal should not create duplicate
  const dupSignal = makeSignal({ id: "dup-sig", intentType: "price_pushback", actorType: "carrier", confidence: 75 });
  const dupNbas: CarrierMarketNba[] = [];
  const dupNbaStorage = {
    getCarrierMarketNbaBySignalKey: async (_cid: string, sk: string) =>
      dupNbas.find(n => n.marketSignalId === sk && n.carrierId === _cid),
    upsertCarrierMarketNba: async (data: any) => {
      const existing = dupNbas.find(n => n.marketSignalId === data.marketSignalId && n.carrierId === data.carrierId);
      if (existing) return existing;
      const n = { id: `dup-n-${dupNbas.length}`, createdAt: new Date(), updatedAt: new Date(), firstSeenAt: new Date(), ...data } as CarrierMarketNba;
      dupNbas.push(n);
      return n;
    },
    getFirstOrgAdmin: async () => ({ id: "user-admin" } as any),
  };
  await generateCarrierEmailNbas("carrier-1", carrierMsg, [dupSignal], dupNbaStorage);
  const beforeDedup = dupNbas.length;
  await generateCarrierEmailNbas("carrier-1", carrierMsg, [dupSignal], dupNbaStorage);
  assert(
    "same-thread carrier NBAs are deduplicated on re-run",
    dupNbas.length === beforeDedup,
    `before=${beforeDedup}, after=${dupNbas.length}`,
  );
}

// ─── 5. Win/Loss Evidence ─────────────────────────────────────────────────────

console.log("\n── 5. Win/Loss Evidence (processWinLossEvidence) ────────────────────\n");

{
  const outcomeLinks: EmailOutcomeLink[] = [];
  const signalLinkUpdates: Array<{ id: string; links: Record<string, unknown> }> = [];

  const mockStorage = {
    insertEmailOutcomeLink: async (data: any): Promise<EmailOutcomeLink> => {
      const link = { id: `link-${outcomeLinks.length + 1}`, createdAt: new Date(), ...data } as EmailOutcomeLink;
      outcomeLinks.push(link);
      return link;
    },
    updateEmailSignalLinks: async (signalId: string, links: any): Promise<void> => {
      signalLinkUpdates.push({ id: signalId, links });
    },
  };

  const wonMsg = makeMessage({ linkedAccountId: "account-1", linkedLaneId: "lane-1", linkedLoadId: "load-1" });
  const wonSignal = makeSignal({ intentType: "closed_won_indicator", confidence: 85 });
  const objSignal = makeSignal({ id: "obj-related", intentType: "objection", confidence: 75 });
  await processWinLossEvidence(wonMsg, [wonSignal, objSignal], mockStorage);

  assert(
    "closed_won_indicator creates an outcome link with outcomeType won",
    outcomeLinks.some(l => l.outcomeType === "won"),
    `links: ${outcomeLinks.map(l => l.outcomeType).join(", ")}`,
  );

  assert(
    "won outcome links to the account entity",
    outcomeLinks.some(l => l.entityType === "account" && l.entityId === "account-1"),
  );

  assert(
    "won outcome links to the lane entity",
    outcomeLinks.some(l => l.entityType === "lane" && l.entityId === "lane-1"),
  );

  assert(
    "won outcome links to the load/opportunity entity",
    outcomeLinks.some(l => l.entityType === "load" && l.entityId === "load-1"),
  );

  assert(
    "related non-outcome signal (objection) is also linked as outcome evidence",
    outcomeLinks.some(l => l.emailSignalId === "obj-related"),
    `signal IDs in links: ${outcomeLinks.map(l => l.emailSignalId).join(", ")}`,
  );

  assert(
    "all batch signals in a won thread share the same outcomeType",
    outcomeLinks.every(l => l.outcomeType === "won"),
  );

  // Test linkedOpportunityId back-fill from linkedLoadId
  const oppLinks: Array<{ id: string; links: Record<string, unknown> }> = [];
  const oppStorage = {
    insertEmailOutcomeLink: async (data: any) => ({ id: "link", createdAt: new Date(), ...data } as EmailOutcomeLink),
    updateEmailSignalLinks: async (signalId: string, links: any) => { oppLinks.push({ id: signalId, links }); },
  };
  const oppMsg = makeMessage({ linkedLoadId: "load-opp-1" });
  const plainSignal = makeSignal({ id: "plain-s", intentType: "pricing_request", confidence: 70 });
  await processWinLossEvidence(oppMsg, [plainSignal], oppStorage);
  assert(
    "linkedOpportunityId is back-filled from message.linkedLoadId when signal has none",
    oppLinks.some(u => u.links.linkedOpportunityId === "load-opp-1"),
    `updates: ${JSON.stringify(oppLinks)}`,
  );

  // Test closed_lost_indicator
  const lostLinks: EmailOutcomeLink[] = [];
  const lostStorage = {
    insertEmailOutcomeLink: async (data: any) => {
      const l = { id: `lost-${lostLinks.length + 1}`, createdAt: new Date(), ...data } as EmailOutcomeLink;
      lostLinks.push(l);
      return l;
    },
    updateEmailSignalLinks: async () => {},
  };
  const lostMsg = makeMessage({ linkedAccountId: "account-2" });
  const lostSignal = makeSignal({ id: "lost-s", intentType: "closed_lost_indicator", confidence: 80 });
  await processWinLossEvidence(lostMsg, [lostSignal], lostStorage);
  assert(
    "closed_lost_indicator creates an outcome link with outcomeType lost",
    lostLinks.some(l => l.outcomeType === "lost"),
  );

  // Test low-confidence outcome signal is skipped (no outcome links created)
  const skipLinks: EmailOutcomeLink[] = [];
  const skipStorage = {
    insertEmailOutcomeLink: async (data: any) => {
      const l = { id: `skip-${skipLinks.length + 1}`, createdAt: new Date(), ...data } as EmailOutcomeLink;
      skipLinks.push(l);
      return l;
    },
    updateEmailSignalLinks: async () => {},
  };
  const lowConfWon = makeSignal({ id: "low-won", intentType: "closed_won_indicator", confidence: 40 });
  await processWinLossEvidence(makeMessage(), [lowConfWon], skipStorage);
  assert(
    "low-confidence closed_won_indicator does not create outcome link",
    skipLinks.length === 0,
    `expected 0 links, got ${skipLinks.length}`,
  );
}

// ─── 6. Integration Safety ────────────────────────────────────────────────────

console.log("\n── 6. Integration Safety ─────────────────────────────────────────────\n");

{
  // Missing admin user: generateAccountEmailNbas should not throw
  const safeStorage = {
    getRecentNbaCardByType: async () => undefined,
    getActiveNbaCardByThreadAndType: async () => undefined,
    getFirstOrgAdmin: async () => null,
    createNbaCard: async (data: any) => ({ id: "card", ...data } as NbaCard),
  };
  let accountNbaError: Error | null = null;
  try {
    await generateAccountEmailNbas("org-1", "missing-account", makeMessage({ linkedAccountId: null }), [makeSignal()], safeStorage);
  } catch (e) {
    accountNbaError = e as Error;
  }
  assert(
    "generateAccountEmailNbas does not throw when no admin user found",
    accountNbaError === null,
    accountNbaError?.message,
  );

  // Carrier enrichment: should not throw on valid input
  const safeCarrierStorage = {
    getCarrierEmailSuggestionByDedup: async () => undefined,
    insertCarrierEmailSuggestion: async (data: any) => ({ id: "sug", ...data } as CarrierEmailSuggestion),
  };
  let enrichmentError: Error | null = null;
  try {
    await stageCarrierEmailEnrichment(
      "carrier-missing",
      makeMessage({ linkedCarrierId: "carrier-missing" }),
      [makeSignal({ intentType: "lane_offer", actorType: "carrier" })],
      safeCarrierStorage,
    );
  } catch (e) {
    enrichmentError = e as Error;
  }
  assert(
    "stageCarrierEmailEnrichment does not throw on any valid input",
    enrichmentError === null,
    enrichmentError?.message,
  );

  // processWinLossEvidence should swallow storage errors
  const errorStorage = {
    insertEmailOutcomeLink: async () => { throw new Error("DB down"); },
    updateEmailSignalLinks: async () => { throw new Error("DB down"); },
  };
  let winLossError: Error | null = null;
  try {
    await processWinLossEvidence(makeMessage(), [makeSignal({ intentType: "closed_won_indicator", confidence: 80 })], errorStorage);
  } catch (e) {
    winLossError = e as Error;
  }
  assert(
    "processWinLossEvidence swallows storage errors gracefully",
    winLossError === null,
    winLossError?.message,
  );

  // Market-driven carrier NBA types should not collide with email types
  const { CARRIER_NBA_TYPES } = await import("../server/carrierMarketNbaService");
  assert(
    "email carrier NBA recommendation types don't conflict with market NBA types",
    !Object.values(CARRIER_NBA_TYPES).includes("email_pricing_review" as any) &&
    !Object.values(CARRIER_NBA_TYPES).includes("email_procurement_follow_up" as any),
  );

  // Account email NBAs must all have email_ prefix
  const noConflictCards: NbaCard[] = [];
  const noConflictStorage = {
    getRecentNbaCardByType: async () => undefined,
    getActiveNbaCardByThreadAndType: async () => undefined,
    getFirstOrgAdmin: async () => ({ id: "admin" } as any),
    createNbaCard: async (data: any) => {
      const c = { id: `nc-${noConflictCards.length}`, ...data } as NbaCard;
      noConflictCards.push(c);
      return c;
    },
  };
  await generateAccountEmailNbas(
    "org-1",
    "account-1",
    makeMessage(),
    [makeSignal({ intentType: "new_opportunity", confidence: 80 })],
    noConflictStorage,
  );
  assert(
    "account email NBA ruleTypes use email_ prefix to avoid conflicts",
    noConflictCards.every(c => c.ruleType.startsWith("email_")),
    `non-email ruleTypes: ${noConflictCards.filter(c => !c.ruleType.startsWith("email_")).map(c => c.ruleType).join(", ")}`,
  );
}

// ─── Final summary ────────────────────────────────────────────────────────────

console.log(`\n── Summary: ${passed} passed, ${failed} failed ──────────────────────\n`);

if (failures.length > 0) {
  console.error("Failed tests:");
  for (const f of failures) {
    console.error(`  • ${f}`);
  }
  process.exit(1);
}

console.log("All tests passed.");
