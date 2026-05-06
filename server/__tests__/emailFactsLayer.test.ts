/**
 * Email Intelligence Layer v1.5 — Fact crystallization tests (Task #943).
 *
 * Pure-function coverage for all 8 detectors + adapter contract. Storage
 * and DB writes are mocked; we never touch a real Postgres connection here.
 *
 *   1–8     bounceClassifier  — DSN, hard/soft, OOO, alternate contact, suppression
 *   9–13    participants      — address parsing, role classification, internal flag
 *  14–17    attachmentRouter  — RateCon / POD / spreadsheet fallback / unknown
 *  18–24    slotExtractor     — target_rate, incumbent, competitor, RFP date,
 *                                contract end, equipment, weight
 *  25–30    promiseDetector   — "I'll do X by Y" patterns + relative deadlines
 *  31–34    questionDetector  — direct questions, lead-word questions, quoted skip
 *  35–40    outboundQuality   — clarity hedges, tone, value-add, objection ack
 *  41–45    sentiment         — positive/negative scoring, smoothing, trend
 *  46–48    runEmailFactExtractors — orchestrator isolation + best-effort
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// All storage-touching modules get mocked so the suite is hermetic.
vi.mock("../services/emailFacts/emailFactsStorage", () => ({
  upsertBounceEvent: vi.fn(async () => undefined),
  getActiveBouncesForEmail: vi.fn(async () => []),
  getBounceDailyCounts: vi.fn(async () => []),
  insertParticipants: vi.fn(async (rows: any[]) => rows.map((r, i) => ({ id: `p-${i}`, ...r }))),
  getStakeholderRowsForCompany: vi.fn(async () => []),
  getParticipantsForThread: vi.fn(async () => []),
  upsertAttachmentClassification: vi.fn(async () => undefined),
  getAttachmentsForMessage: vi.fn(async () => []),
  getRateConClassificationsForLane: vi.fn(async () => []),
  upsertSlot: vi.fn(async () => undefined),
  upsertForwardCalendarEvent: vi.fn(async () => undefined),
  getLatestSlotsForThread: vi.fn(async () => new Map()),
  getUpcomingForwardCalendarEvents: vi.fn(async () => []),
  upsertPromise: vi.fn(async () => undefined),
  getOpenPromisesForThread: vi.fn(async () => []),
  markPromiseResolved: vi.fn(async () => undefined),
  listOverdueOpenPromises: vi.fn(async () => []),
  listPromisesForRep: vi.fn(async () => []),
  listPromisesForAccount: vi.fn(async () => []),
  upsertQuestion: vi.fn(async () => undefined),
  getOpenQuestionsForThread: vi.fn(async () => []),
  markQuestionAnswered: vi.fn(async () => undefined),
  listOpenQuestionsForAccount: vi.fn(async () => []),
  listOpenQuestionsForRep: vi.fn(async () => []),
  getProviderSentAtForMessages: vi.fn(async () => new Map()),
  upsertOutboundQualityScore: vi.fn(async () => undefined),
  listQualityScoresForRep: vi.fn(async () => []),
  listQualityScoresForAccount: vi.fn(async () => []),
  upsertContactSentiment: vi.fn(async (orgId: string, contactId: string, companyId: string, score: number, trend: string, signals: unknown) => ({
    id: "cs-1", orgId, contactId, companyId, sentimentScore: score, sentimentTrend: trend,
    avgResponseTimeHours: null, responseTimeChange: null, signals, analysisDate: new Date(), createdAt: new Date(),
  })),
  getContactSentiment: vi.fn(async () => undefined),
  listSentimentForCompany: vi.fn(async () => []),
}));

// db is touched by participants for the company-domain heuristic; stub minimally.
vi.mock("../storage", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  },
  storage: {},
}));

import {
  classifyBounceFromMessage,
  classifyAndPersistBounces,
  isContactSuppressed,
} from "../services/emailFacts/bounceClassifier";
import { parseAddressList, recordParticipantsForMessage, explodeMessageToParticipants } from "../services/emailFacts/participants";
import { classifyAttachment } from "../services/emailFacts/attachmentRouter";
import { extractSlotsFromMessage } from "../services/emailFacts/slotExtractor";
import { detectPromisesInOutbound, parseRelativeDeadline } from "../services/emailFacts/promiseDetector";
import { detectQuestionsInInbound } from "../services/emailFacts/questionDetector";
import { gradeOutboundQuality } from "../services/emailFacts/outboundQualityGrader";
import { scoreMessageSentiment, smoothSentiment, computeTrend, recordContactSentiment } from "../services/emailFacts/sentimentWriteback";
import { reconcileQuestionsOnRepReply } from "../services/emailFacts/questionDetector";
import { resolveRateConUploaderId, buildRateConRouter } from "../services/emailFacts/rateConEmailRouter";
import { runEmailFactExtractors } from "../services/emailFacts";
import { emailFactsAdapter } from "../services/emailFacts";

import * as storageMod from "../services/emailFacts/emailFactsStorage";
import type { EmailMessage } from "@shared/schema";

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: "msg-001",
    orgId: "org-001",
    providerMessageId: null,
    threadId: "thr-1",
    direction: "inbound",
    fromEmail: "jane@acme.com",
    toEmail: "rep@valuetruck.com",
    ccEmail: null,
    subject: null,
    body: null,
    linkedAccountId: "co-1",
    linkedCarrierId: null,
    linkedLaneId: null,
    linkedLoadId: null,
    linkedTaskId: null,
    linkedNbaId: null,
    linkedOutreachLogId: null,
    processedForSignalsAt: null,
    providerSentAt: null,
    ingestedVia: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tier 1.1 — Bounce / DSN / OOO ──────────────────────────────────────────

describe("bounceClassifier", () => {
  it("[1] hard bounce: DSN with 5.x.x status code", () => {
    const out = classifyBounceFromMessage({
      fromEmail: "Mailer-Daemon@google.com",
      toEmail: "rep@valuetruck.com",
      subject: "Delivery Status Notification (Failure)",
      body: "Final-Recipient: rfc822; jane@acme.com\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 No such user",
    });
    expect(out).toHaveLength(1);
    expect(out[0].bounceType).toBe("hard_bounce");
    expect(out[0].contactEmail).toBe("jane@acme.com");
    expect(out[0].diagnosticCode).toBe("5.1.1");
  });

  it("[2] soft bounce: DSN with 4.x.x status code", () => {
    const out = classifyBounceFromMessage({
      fromEmail: "postmaster@outlook.com",
      toEmail: "rep@valuetruck.com",
      subject: "Undeliverable: hello",
      body: "Final-Recipient: rfc822; jane@acme.com\nStatus: 4.2.2\nMailbox full",
    });
    expect(out[0].bounceType).toBe("soft_bounce");
    expect(out[0].diagnosticCode).toBe("4.2.2");
  });

  it("[3] hard bounce: prose-only 'no such user' falls back to hard", () => {
    const out = classifyBounceFromMessage({
      fromEmail: "mailer-daemon@yahoo.com",
      toEmail: "rep@valuetruck.com",
      subject: "Mail delivery failed",
      body: "Recipients: jane@acme.com\nThe address was rejected — user unknown.",
    });
    expect(out).toHaveLength(1);
    expect(out[0].bounceType).toBe("hard_bounce");
    expect(out[0].contactEmail).toBe("jane@acme.com");
  });

  it("[4] OOO with explicit return date populates oooUntil", () => {
    const out = classifyBounceFromMessage({
      fromEmail: "jane@acme.com",
      toEmail: "rep@valuetruck.com",
      subject: "Out of Office: Re: pricing",
      body: "I am out of the office until December 5, 2026 and will reply when I return.",
    });
    expect(out).toHaveLength(1);
    expect(out[0].bounceType).toBe("auto_reply_ooo");
    expect(out[0].contactEmail).toBe("jane@acme.com");
    expect(out[0].oooUntil).toBeInstanceOf(Date);
  });

  it("[5] OOO surfaces alternate contact when present", () => {
    const out = classifyBounceFromMessage({
      fromEmail: "jane@acme.com",
      toEmail: "rep@valuetruck.com",
      subject: "Automatic reply",
      body: "I am out of the office until Monday. In my absence please contact John Smith at john.smith@acme.com.",
    });
    expect(out[0].alternateContactEmail).toBe("john.smith@acme.com");
  });

  it("[6] OOO subject without 'out of office' words still classifies as ooo (autoresponder marker)", () => {
    const out = classifyBounceFromMessage({
      fromEmail: "jane@acme.com",
      toEmail: "rep@valuetruck.com",
      subject: "Automatic reply: thanks",
      body: "Thank you for your message. Your inquiry has been logged.",
    });
    // Per classifier ADR — any of the autoresponder subject markers (Out of
    // Office / Automatic reply / Auto-Reply / Vacation Responder) lands the
    // event as `auto_reply_ooo`. `auto_reply_other` is reserved for body-only
    // markers we may add later.
    expect(out[0].bounceType).toBe("auto_reply_ooo");
  });

  it("[7] non-bounce inbound returns no classifications", () => {
    const out = classifyBounceFromMessage({
      fromEmail: "jane@acme.com",
      toEmail: "rep@valuetruck.com",
      subject: "RFQ for next week",
      body: "Can you quote 4 loads CHI-LAX dry van?",
    });
    expect(out).toHaveLength(0);
  });

  it("[8] suppression: hard bounce within 90d → suppressed; soft bounce alone → not", async () => {
    const events1 = [{ bounceType: "hard_bounce", oooUntil: null, detectedAt: new Date() } as any];
    (storageMod.getActiveBouncesForEmail as any).mockResolvedValueOnce(events1);
    const a = await isContactSuppressed("org-1", "jane@acme.com");
    expect(a.suppressed).toBe(true);
    expect(a.reason).toBe("hard_bounce");

    const events2 = [{ bounceType: "soft_bounce", oooUntil: null, detectedAt: new Date() } as any];
    (storageMod.getActiveBouncesForEmail as any).mockResolvedValueOnce(events2);
    const b = await isContactSuppressed("org-1", "jane@acme.com");
    expect(b.suppressed).toBe(false);

    const future = new Date(Date.now() + 3 * 86400 * 1000);
    const events3 = [{ bounceType: "auto_reply_ooo", oooUntil: future, detectedAt: new Date() } as any];
    (storageMod.getActiveBouncesForEmail as any).mockResolvedValueOnce(events3);
    const c = await isContactSuppressed("org-1", "jane@acme.com");
    expect(c.suppressed).toBe(true);
    expect(c.reason).toBe("ooo");
  });

  it("[8b] outbound messages are skipped by classifyAndPersistBounces", async () => {
    const msg = makeMessage({ direction: "outbound", body: "anything" });
    const n = await classifyAndPersistBounces(msg);
    expect(n).toBe(0);
    expect(storageMod.upsertBounceEvent).not.toHaveBeenCalled();
  });
});

// ─── Tier 1.2 — Participants ─────────────────────────────────────────────────

describe("participants", () => {
  it("[9] parseAddressList handles named + bracketed addresses", () => {
    const out = parseAddressList(`Jane Doe <jane@acme.com>, <bob@acme.com>, "Carol King" <carol@acme.com>`);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ emailAddress: "jane@acme.com", displayName: "Jane Doe" });
    expect(out[1].emailAddress).toBe("bob@acme.com");
    expect(out[2].emailAddress).toBe("carol@acme.com");
    expect(out[2].displayName).toBe("Carol King");
  });

  it("[10] parseAddressList dedupes case-insensitively", () => {
    const out = parseAddressList("jane@acme.com, JANE@acme.com, jane@ACME.com");
    expect(out).toHaveLength(1);
  });

  it("[11] parseAddressList handles empty / null input", () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("   ")).toEqual([]);
  });

  it("[11b] explodeMessageToParticipants emits bcc + reply_to roles when surfaced", () => {
    // Microsoft Graph + Gmail both serialize Bcc/Reply-To with the same
    // angle-bracketed format the rest of the headers use, e.g.
    // "Display Name" <addr@example.com>.
    const rows = explodeMessageToParticipants(
      makeMessage({ id: "m-1", fromEmail: "<rep@valuetruck.com>", toEmail: "<jane@acme.com>" }) as any,
      { bccEmail: '"VP Sales" <vp@acme.com>', replyTo: "<ops@acme.com>" },
    );
    const roles = rows.map((r: any) => `${r.role}:${r.emailAddress}`);
    expect(roles).toContain("bcc:vp@acme.com");
    expect(roles).toContain("reply_to:ops@acme.com");
  });

  it("[11c] explodeMessageToParticipants extracts forwarded_original_sender from FW: body", () => {
    const body = [
      "Heads up — passing this along.",
      "",
      "---------- Forwarded message ---------",
      "From: \"Karen Decisionmaker\" <karen@acme.com>",
      "Date: Mon, May 5 2026",
      "Subject: RFP intake",
    ].join("\n");
    const rows = explodeMessageToParticipants(
      makeMessage({ id: "m-fwd", subject: "FW: RFP intake", body, fromEmail: "rep@valuetruck.com", toEmail: "team@valuetruck.com" }) as any,
    );
    const fwd = rows.find((r: any) => r.role === "forwarded_original_sender");
    expect(fwd).toBeTruthy();
    expect(fwd!.emailAddress).toBe("karen@acme.com");
  });

  it("[11d] every role emitted by explodeMessageToParticipants is registered in emailParticipantRoles enum", async () => {
    // Guardrail: prevent participants exploder from drifting away from the
    // shared schema's role enum (consumers will validate against this list).
    const { emailParticipantRoles } = await import("@shared/schema");
    const enumSet = new Set<string>(emailParticipantRoles as readonly string[]);
    const fwBody = `Forwarded message:\nFrom: "Karen Decisionmaker" <karen@acme.com>\n`;
    const rows = explodeMessageToParticipants(
      makeMessage({
        id: "m-roles",
        subject: "FW: RFP intake",
        body: fwBody,
        fromEmail: "<rep@valuetruck.com>",
        toEmail: "<jane@acme.com>",
        ccEmail: "<lurker@acme.com>",
      }) as any,
      { bccEmail: "<vp@acme.com>", replyTo: "<ops@acme.com>" },
    );
    const seenRoles = new Set(rows.map((r: any) => r.role));
    // sanity — we did exercise every role.
    expect(seenRoles.size).toBeGreaterThanOrEqual(6);
    for (const role of seenRoles) {
      expect(enumSet.has(role)).toBe(true);
    }
  });

  it("[12] recordParticipantsForMessage explodes from/to/cc into rows", async () => {
    const insertSpy = storageMod.insertParticipants as any;
    const msg = makeMessage({
      fromEmail: "<jane@acme.com>",
      toEmail: "<rep@valuetruck.com>",
      ccEmail: "<boss@acme.com>",
    });
    const n = await recordParticipantsForMessage(msg);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const inserted = insertSpy.mock.calls[0][0] as any[];
    const roles = inserted.map((p) => p.role).sort();
    expect(roles).toEqual(["cc", "from", "to"]);
    expect(n).toBe(3);
  });

  it("[13] recordParticipantsForMessage no-op when message has no addresses", async () => {
    const insertSpy = storageMod.insertParticipants as any;
    const msg = makeMessage({ fromEmail: null, toEmail: null, ccEmail: null });
    const n = await recordParticipantsForMessage(msg);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });
});

// ─── Tier 1.3 — Attachment router ────────────────────────────────────────────

describe("attachmentRouter", () => {
  it("[14] classifies a rate confirmation PDF", () => {
    const out = classifyAttachment({ name: "Rate_Con_Load123.pdf", contentType: "application/pdf" });
    expect(out.kind).toBe("rate_con");
    expect(out.confidence).toBeGreaterThanOrEqual(80);
  });

  it("[15] classifies a POD by filename", () => {
    const out = classifyAttachment({ name: "POD-signed-1234.pdf", contentType: "application/pdf" });
    expect(out.kind).toBe("pod");
  });

  it("[16] spreadsheet fallback when no kind hint", () => {
    const out = classifyAttachment({ name: "lanes-q3.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(out.kind).toBe("spreadsheet");
  });

  it("[17] generic fallback for unknown content", () => {
    const out = classifyAttachment({ name: "notes.bin", contentType: "application/octet-stream" });
    expect(out.kind).toBe("generic");
    expect(out.confidence).toBeLessThan(50);
  });
});

// ─── Tier 2.1 — Slot extractor ───────────────────────────────────────────────

describe("slotExtractor", () => {
  it("[18] pulls target_rate from rate phrasing", () => {
    const out = extractSlotsFromMessage({
      subject: "RFQ CHI→LAX",
      body: "Our target rate is $2,750 all-in for this lane.",
    });
    const rate = out.slots.find((s) => s.slotName === "target_rate");
    expect(rate).toBeDefined();
    expect(rate?.slotValueNumeric).toBe("2750");
  });

  it("[19] extracts incumbent carrier when stated", () => {
    const out = extractSlotsFromMessage({
      subject: null,
      body: "The incumbent carrier is Acme Logistics and their rate is $2,400.",
    });
    const inc = out.slots.find((s) => s.slotName === "incumbent");
    expect(inc?.slotValue).toMatch(/Acme/i);
  });

  it("[20] extracts competitor name from 'going with X'", () => {
    const out = extractSlotsFromMessage({
      subject: null,
      body: "We're going with Big Blue Logistics this quarter.",
    });
    const comp = out.slots.find((s) => s.slotName === "competitor_name");
    expect(comp?.slotValue).toMatch(/Big Blue/i);
  });

  it("[21] forward calendar: RFP date", () => {
    const out = extractSlotsFromMessage({
      subject: "Q1 RFP",
      body: "RFP closes on January 15, 2027.",
    });
    const rfp = out.forwardCalendar.find((e) => e.eventType === "rfp");
    expect(rfp).toBeDefined();
    expect(rfp?.eventDate).toBeInstanceOf(Date);
  });

  it("[22] forward calendar: contract end date", () => {
    const out = extractSlotsFromMessage({
      subject: null,
      body: "Our current contract expires March 31, 2027.",
    });
    const ce = out.forwardCalendar.find((e) => e.eventType === "contract_end");
    expect(ce).toBeDefined();
  });

  it("[23] equipment + weight extraction", () => {
    const out = extractSlotsFromMessage({
      subject: "RFQ",
      body: "Need a reefer truck, 42,000 lbs gross.",
    });
    expect(out.slots.find((s) => s.slotName === "equipment")?.slotValue).toMatch(/reefer/i);
    expect(out.slots.find((s) => s.slotName === "weight")?.slotValueNumeric).toBe("42000");
  });

  it("[24] no slots → empty arrays (no crash)", () => {
    const out = extractSlotsFromMessage({ subject: null, body: null });
    expect(out.slots).toEqual([]);
    expect(out.forwardCalendar).toEqual([]);
  });
});

// ─── Tier 2.2 — Promise register ─────────────────────────────────────────────

describe("promiseDetector", () => {
  it("[25] detects 'I'll send X by Friday'", () => {
    const out = detectPromisesInOutbound("Thanks — I'll send the updated rate sheet by Friday.");
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].promiseDueAt).toBeInstanceOf(Date);
  });

  it("[26] detects 'I'll follow up tomorrow'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T10:00:00Z"));
    const out = detectPromisesInOutbound("I'll follow up tomorrow morning.");
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].promiseDueAt).toBeInstanceOf(Date);
  });

  it("[27] no promises in pure pleasantries", () => {
    const out = detectPromisesInOutbound("Thanks for the call earlier today.");
    expect(out).toEqual([]);
  });

  it("[28] parseRelativeDeadline: tomorrow / Friday / EOD", () => {
    const now = new Date("2026-05-04T10:00:00Z"); // Monday
    const tom = parseRelativeDeadline("tomorrow", now);
    expect(tom).toBeInstanceOf(Date);
    const fri = parseRelativeDeadline("Friday", now);
    expect(fri).toBeInstanceOf(Date);
    const eod = parseRelativeDeadline("EOD", now);
    expect(eod).toBeInstanceOf(Date);
  });

  it("[29] parseRelativeDeadline: 'in 3 days'", () => {
    const now = new Date("2026-05-04T10:00:00Z");
    const out = parseRelativeDeadline("in 3 days", now);
    expect(out).toBeInstanceOf(Date);
    if (out) {
      const diffDays = Math.round((out.getTime() - now.getTime()) / 86400000);
      expect(diffDays).toBeGreaterThanOrEqual(3);
      expect(diffDays).toBeLessThanOrEqual(4);
    }
  });

  it("[30] parseRelativeDeadline returns null for unparseable text", () => {
    expect(parseRelativeDeadline("at some point eventually")).toBeNull();
  });
});

// ─── Tier 2.3 — Question register ────────────────────────────────────────────

describe("questionDetector", () => {
  it("[31] detects classic question with question mark", () => {
    const out = detectQuestionsInInbound("Quick one — can you cover CHI-LAX next week?");
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].questionText).toMatch(/can you cover/i);
  });

  it("[32] detects multiple questions in one body", () => {
    const out = detectQuestionsInInbound("What's the rate? When can the truck pickup? Thanks.");
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("[33] skips quoted reply lines", () => {
    const out = detectQuestionsInInbound([
      "Confirmed for tomorrow.",
      "",
      "On Wed, May 1 someone wrote:",
      "> Can you cover CHI-LAX next week?",
    ].join("\n"));
    // The quoted line is skipped, leaving no detectable question.
    expect(out).toEqual([]);
  });

  it("[34] no questions in pure statements", () => {
    const out = detectQuestionsInInbound("All booked. Driver dispatched at 9.");
    expect(out).toEqual([]);
  });
});

// ─── Tier 2.4 — Outbound quality grader ──────────────────────────────────────

describe("outboundQualityGrader", () => {
  it("[35] hedges drag clarity down", () => {
    const a = gradeOutboundQuality({ body: "Hi — I think maybe we could possibly cover that lane, kinda. Let me know." });
    const b = gradeOutboundQuality({ body: "Hi — confirmed: we can cover CHI-LAX at $2,750 all-in for Tuesday pickup. Tender it over and I'll dispatch." });
    expect(b.clarity).toBeGreaterThan(a.clarity);
  });

  it("[36] greeting + close lifts tone score", () => {
    const a = gradeOutboundQuality({ body: "Send the BOL." });
    const b = gradeOutboundQuality({ body: "Hi Jane — please send the BOL when you can. Thanks!" });
    expect(b.tone).toBeGreaterThan(a.tone);
  });

  it("[37] value-add tokens lift the value-add score", () => {
    const a = gradeOutboundQuality({ body: "Hi Jane, thanks for the note." });
    const b = gradeOutboundQuality({ body: "Hi Jane — we have 3 trucks available CHI→LAX this week at a $2,750 all-in rate, with capacity confirmed for Tuesday." });
    expect(b.valueAdd).toBeGreaterThan(a.valueAdd);
  });

  it("[38] objection handling: ack + reframe scores higher under objection context", () => {
    const ackBody = "I hear you on the rate — that said, here's what I can do: drop $50 if we lock pickup before 8am.";
    const flatBody = "We can't move on the rate.";
    const a = gradeOutboundQuality({ body: flatBody, priorInboundIntent: "objection" });
    const b = gradeOutboundQuality({ body: ackBody, priorInboundIntent: "objection" });
    expect(b.objectionHandling).toBeGreaterThan(a.objectionHandling);
  });

  it("[39] overall score is bounded 0..100 and weighted blend", () => {
    const out = gradeOutboundQuality({ body: "Hi Jane — confirmed CHI-LAX $2,750 Tuesday pickup. Thanks!" });
    expect(out.overall).toBeGreaterThanOrEqual(0);
    expect(out.overall).toBeLessThanOrEqual(100);
  });

  it("[40] empty body yields low clarity but doesn't crash", () => {
    const out = gradeOutboundQuality({ body: "" });
    expect(out.clarity).toBeLessThan(60);
    expect(out.overall).toBeLessThanOrEqual(100);
  });
});

// ─── Tier 2.5 — Sentiment writeback ──────────────────────────────────────────

describe("sentimentWriteback", () => {
  it("[41] positive language scores > neutral", () => {
    const s = scoreMessageSentiment("Thanks so much — this is perfect, really appreciate the fast turnaround.");
    expect(s.score).toBeGreaterThan(50);
    expect(s.positiveHits.length).toBeGreaterThan(0);
  });

  it("[42] negative language scores < neutral", () => {
    const s = scoreMessageSentiment("Frustrated with the delay — this is unacceptable. Cancel the load.");
    expect(s.score).toBeLessThan(50);
    expect(s.negativeHits.length).toBeGreaterThan(0);
  });

  it("[43] empty body returns neutral 50", () => {
    expect(scoreMessageSentiment(null).score).toBe(50);
    expect(scoreMessageSentiment("").score).toBe(50);
  });

  it("[44] smoothSentiment + computeTrend", () => {
    expect(smoothSentiment(50, 80, 0)).toBe(80);
    expect(smoothSentiment(50, 80, 5)).toBe(59); // 0.7*50 + 0.3*80 = 59
    expect(computeTrend([40, 45, 50, 55, 60])).toBe("improving");
    expect(computeTrend([60, 55, 50, 45, 40])).toBe("declining");
    expect(computeTrend([50, 51, 52])).toBe("stable");
  });

  it("[45] recordContactSentiment skips non-inbound + missing contact", async () => {
    const upsert = storageMod.upsertContactSentiment as any;
    const a = await recordContactSentiment(makeMessage({ direction: "outbound", body: "thanks" }), { contactId: "c-1" });
    expect(a).toBeNull();
    expect(upsert).not.toHaveBeenCalled();

    const b = await recordContactSentiment(makeMessage({ direction: "inbound", body: "thanks" }), { contactId: null });
    expect(b).toBeNull();

    const c = await recordContactSentiment(makeMessage({ direction: "inbound", body: "thanks!" }), { contactId: "c-1" });
    expect(c).not.toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("[45b] recordContactSentiment is idempotent on (contact, msg.id) — replays return existing without double-counting", async () => {
    const upsert = storageMod.upsertContactSentiment as any;
    const getExisting = storageMod.getContactSentiment as any;
    const msg = makeMessage({ id: "m-replay", direction: "inbound", body: "thanks!" });

    // First ingestion writes a new score and records msg.id in processedMessageIds.
    getExisting.mockResolvedValueOnce(undefined);
    const first = await recordContactSentiment(msg, { contactId: "c-1" });
    expect(first).not.toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
    const persistedSignals = (upsert.mock.calls[0][5] as { processedMessageIds: string[] });
    expect(persistedSignals.processedMessageIds).toContain("m-replay");

    // Replaying the same message must NOT call upsert again.
    getExisting.mockResolvedValueOnce({
      id: "cs-existing",
      orgId: msg.orgId,
      contactId: "c-1",
      companyId: msg.linkedAccountId,
      sentimentScore: 70,
      sentimentTrend: "improving",
      signals: { history: [70], processedMessageIds: ["m-replay"] },
    });
    const replayed = await recordContactSentiment(msg, { contactId: "c-1" });
    expect(replayed).not.toBeNull();
    expect((replayed as any).id).toBe("cs-existing");
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

// ─── Tier 2.3 — Question reconciler (TTA wiring) ─────────────────────────────

describe("reconcileQuestionsOnRepReply", () => {
  it("[45c] computes time_to_answer_sec via internal sent-at lookup (no external map needed)", async () => {
    const askedAt = new Date("2026-01-01T10:00:00Z");
    const repAt = new Date("2026-01-01T10:05:00Z"); // +300s

    (storageMod.getOpenQuestionsForThread as any).mockResolvedValue([
      { id: "q-1", messageId: "m-asking", status: "unanswered" },
    ]);
    const sentAtSpy = (storageMod.getProviderSentAtForMessages as any).mockResolvedValue(
      new Map([["m-asking", askedAt]]),
    );
    const markSpy = storageMod.markQuestionAnswered as any;

    const reply = makeMessage({ id: "m-reply", direction: "outbound", providerSentAt: repAt });
    const count = await reconcileQuestionsOnRepReply(reply);

    expect(count).toBe(1);
    expect(sentAtSpy).toHaveBeenCalledWith("org-001", ["m-asking"]);
    expect(markSpy).toHaveBeenCalledWith("q-1", "m-reply", 300);
  });

  it("[45d] inbound replies do nothing", async () => {
    const inbound = makeMessage({ direction: "inbound" });
    const count = await reconcileQuestionsOnRepReply(inbound);
    expect(count).toBe(0);
    expect(storageMod.getOpenQuestionsForThread as any).not.toHaveBeenCalled();
  });
});

// ─── Tier 1.3 — Rate-con router wiring ───────────────────────────────────────

describe("rateConEmailRouter", () => {
  it("[45e] resolveRateConUploaderId picks rep on outbound, mailbox owner on inbound", async () => {
    const calls: Array<[string, string]> = [];
    const fakeStorage = {
      getUserByEmailAddress: vi.fn(async (email: string, orgId: string) => {
        calls.push([email, orgId]);
        if (email === "rep@valuetruck.com") return { id: "u-rep" };
        if (email === "kim@valuetruck.com") return { id: "u-kim" };
        return undefined;
      }),
    } as any;

    const outbound = makeMessage({ direction: "outbound", fromEmail: "kim@valuetruck.com", toEmail: "jane@acme.com" });
    const outId = await resolveRateConUploaderId(fakeStorage, outbound);
    expect(outId).toBe("u-kim");

    const inbound = makeMessage({ direction: "inbound", fromEmail: "jane@acme.com", toEmail: "rep@valuetruck.com" });
    const inId = await resolveRateConUploaderId(fakeStorage, inbound);
    expect(inId).toBe("u-rep");

    const orphan = makeMessage({ direction: "inbound", fromEmail: "stranger@x.com", toEmail: "ghost@valuetruck.com" });
    const noId = await resolveRateConUploaderId(fakeStorage, orphan);
    expect(noId).toBeNull();
  });

  it("[45f] buildRateConRouter is a graceful no-op when uploader is unresolved", async () => {
    const router = buildRateConRouter(null);
    const result = await router(makeMessage(), { name: "rc.pdf", contentType: "application/pdf", contentBase64: "AAA" });
    expect(result.extractionId).toBeNull();
  });

  it("[45g] buildRateConRouter is a no-op when attachment has no contentBase64", async () => {
    const router = buildRateConRouter({ uploaderId: "u-rep", orgId: "org-001" });
    const result = await router(makeMessage(), { name: "rc.pdf", contentType: "application/pdf" });
    expect(result.extractionId).toBeNull();
  });
});

// ─── runEmailFactExtractors orchestrator ────────────────────────────────────

describe("runEmailFactExtractors", () => {
  it("[46] runs all stages and returns a structured result", async () => {
    const result = await runEmailFactExtractors(makeMessage({ subject: "RFQ", body: "Can you quote CHI-LAX?" }), [], {});
    expect(result).toMatchObject({
      bounces: expect.any(Number),
      participants: expect.any(Number),
      attachments: expect.any(Number),
      slots: expect.any(Number),
      forwardCalendar: expect.any(Number),
      promises: expect.any(Number),
      questions: expect.any(Number),
    });
    expect(result.errors).toEqual([]);
  });

  it("[47] one failing stage does NOT block the rest (best-effort isolation)", async () => {
    (storageMod.insertParticipants as any).mockRejectedValueOnce(new Error("simulated db failure"));
    const result = await runEmailFactExtractors(makeMessage({ body: "test" }), [], {});
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].stage).toBe("participants");
    // Other stages still recorded normally (no throw).
    expect(typeof result.bounces).toBe("number");
    expect(typeof result.questions).toBe("number");
  });

  it("[48] outbound message routes to grader + promise detector, not bounce/sentiment", async () => {
    const out = await runEmailFactExtractors(
      makeMessage({ direction: "outbound", body: "I'll send the rate sheet by Friday." }),
      [],
      { repUserId: "u-1" },
    );
    expect(storageMod.upsertBounceEvent).not.toHaveBeenCalled();
    expect(storageMod.upsertContactSentiment).not.toHaveBeenCalled();
    expect(out.graded).toBe(true);
  });
});

// ─── Adapter contract ───────────────────────────────────────────────────────

describe("emailFactsAdapter", () => {
  it("[49] adapter exposes every consumer-visible method", () => {
    const methods: Array<keyof typeof emailFactsAdapter> = [
      "getBounceStatusForContact",
      "isContactSuppressed",
      "getBounceDailyCounts",
      "getParticipantsForThread",
      "getStakeholderGraphForAccount",
      "getAttachmentsForMessage",
      "getRateConsForLane",
      "getSlotsForThread",
      "getUpcomingForwardCalendar",
      "getPromisesForRep",
      "getPromisesForAccount",
      "getQuestionsForAccount",
      "getUnansweredQuestionsForRep",
      "getQualityScoresForRep",
      "getQualityScoresForAccount",
      "getSentimentForContact",
      "getSentimentTrendForAccount",
    ];
    for (const m of methods) {
      expect(typeof emailFactsAdapter[m]).toBe("function");
    }
  });

  it("[50] getBounceStatusForContact merges suppression + raw events", async () => {
    (storageMod.getActiveBouncesForEmail as any).mockResolvedValue([
      { id: "b-1", bounceType: "hard_bounce", oooUntil: null, detectedAt: new Date() },
    ]);
    const out = await emailFactsAdapter.getBounceStatusForContact("org-1", "jane@acme.com");
    expect(out.suppressed).toBe(true);
    expect(out.events.length).toBe(1);
  });

  it("[50b] /api/admin/email-facts/run-sweeps is admin-only — non-admin gets 403, missing user gets 401, admin gets 200", async () => {
    // The sweep entry point is mocked so the test stays hermetic — we only
    // care that the route gates the privilege escalation correctly.
    vi.doMock("../emailFactsScheduler", () => ({
      runEmailFactsSweepsOnce: vi.fn(async () => undefined),
      initEmailFactsScheduler: vi.fn(),
    }));
    const { registerEmailFactsRoutes } = await import("../routes/emailFacts");

    type Handler = (req: any, res: any) => Promise<void> | void;
    const handlers = new Map<string, Handler>();
    const fakeApp = {
      get: (path: string, handler: Handler) => { handlers.set(`GET ${path}`, handler); },
      post: (path: string, handler: Handler) => { handlers.set(`POST ${path}`, handler); },
    } as any;
    registerEmailFactsRoutes(fakeApp);

    const handler = handlers.get("POST /api/admin/email-facts/run-sweeps");
    expect(handler).toBeTruthy();

    function makeRes() {
      const out: { status: number; body: any } = { status: 200, body: null };
      return {
        out,
        status: (s: number) => { out.status = s; return { json: (b: any) => { out.body = b; return out; } }; },
        json: (b: any) => { out.body = b; return out; },
      } as any;
    }

    // Missing user → 401
    let res = makeRes();
    await handler!({ user: undefined }, res);
    expect(res.out.status).toBe(401);
    expect(res.out.body.error).toBe("unauthorized");

    // Authenticated org member, non-admin role → 403
    res = makeRes();
    await handler!({ user: { organizationId: "org-1", role: "rep" } }, res);
    expect(res.out.status).toBe(403);
    expect(res.out.body.error).toBe("admin_only");

    // Authenticated admin → 200
    res = makeRes();
    await handler!({ user: { organizationId: "org-1", role: "admin" } }, res);
    expect(res.out.status).toBe(200);
    expect(res.out.body.ok).toBe(true);
    expect(res.out.body.queued).toBe(true);
  });

  it("[51] quality rollups compute median/p25/p75 over recent scores", async () => {
    (storageMod.listQualityScoresForRep as any).mockResolvedValue(
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((overallScore, i) => ({
        id: `q-${i}`, overallScore, createdAt: new Date(),
      })),
    );
    const out = await emailFactsAdapter.getQualityScoresForRep("org-1", "u-1", 30);
    expect(out.count).toBe(10);
    expect(out.median).toBeGreaterThan(0);
    expect(out.p25).toBeLessThanOrEqual(out.median);
    expect(out.p75).toBeGreaterThanOrEqual(out.median);
    expect(out.recent.length).toBeLessThanOrEqual(10);
  });
});
