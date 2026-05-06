/**
 * Email Intelligence v1.5 — Tier 2.1 slot extractor (Task #943).
 *
 * Heuristic-first extraction of structured slots from email bodies. Slots are
 * drawn from a closed enum (target_rate, incumbent, competitor_name, …) and
 * landed in `email_extracted_slots` with one row per (message_id, slot_name).
 *
 * Forward-calendar events (RFP date, contract end) get their own row in
 * `forward_calendar_events`.
 */

import { and, eq } from "drizzle-orm";
import type { EmailMessage, EmailSlotName, ForwardCalendarEventType } from "@shared/schema";
import { competitiveSignals } from "@shared/schema";
import { db } from "../../storage";
import { upsertSlot, upsertForwardCalendarEvent } from "./emailFactsStorage";

export interface ExtractedSlotRecord {
  slotName: EmailSlotName;
  slotValue?: string | null;
  slotValueNumeric?: string | null;
  slotValueDate?: Date | null;
  confidence: number;
  evidence: string;
}

export interface ExtractedForwardCalendarRecord {
  eventType: ForwardCalendarEventType;
  eventDate: Date;
  description: string;
  confidence: number;
}

const RATE_RE = /\$\s*(\d{1,2}(?:[,.]\d{3})?(?:\.\d{1,2})?)\s*(?:per\s+mile|\/\s*mile|\bpm\b|\brpm\b|\ball-?in\b)?/gi;
const TARGET_RATE_CONTEXT = /(target|need(?:ing)?|looking\s+for|budget(?:ed)?|asking|aim(?:ing)?\s+for|ideal(?:ly)?|approved\s+at|book(?:ed)?\s+at|rate)\b/i;
const INCUMBENT_RE = /\b(incumbent(?:\s+(?:carrier|rate))?|current\s+(?:carrier|provider)|existing\s+carrier)\s+(?:is\s+)?["']?([A-Z][\w\s&.-]{2,40})["']?/i;
const COMPETITOR_RE = /\b(?:competitor(?:s)?|going\s+with|chose|chosen|awarded\s+to|switching\s+to|moved\s+(?:it\s+)?to|moving\s+to)\s+["']?([A-Z][\w\s&.-]{2,40})["']?/i;
const RFP_DATE_RE = /\b(?:rfp|bid|tender|rfq)\s+(?:closes?|due|deadline|opens?|launch(?:es)?)\s+(?:on\s+)?([\w\s,/-]{4,30})/i;
const CONTRACT_END_RE = /\b(?:contract|agreement|deal)\s+(?:ends?|expires?|expir(?:es|ation)?|terminates?|terminating|renew(?:s|al))\s+(?:on\s+|in\s+|at\s+)?([\w\s,/-]{4,30})/i;
const EQUIPMENT_RE = /\b(?:dry\s+van|reefer(?:s)?|flatbed|conestoga|step\s?deck|power[\s-]?only|hot\s+shot|box\s+truck|sprinter|cargo\s+van|tanker|drop\s+trailer)\b/i;
const COMMODITY_RE = /\bcommodity\s*[:\-]?\s*([\w\s/-]{2,30})/i;
const WEIGHT_RE = /\b(\d{1,2}[,.]?\d{3})\s*(?:lbs?|pounds)\b/i;
const TEMP_RE = /\b(-?\d{1,3})\s*(?:°|deg(?:rees)?)?\s*(?:F|C)\b/i;
const TRANSIT_RE = /\b(\d{1,2})\s*(?:day|days)?\s*transit\b/i;

function snippet(body: string, idx: number, len = 120): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + len);
  return body.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Pure extractor — deterministic; returns slots + forward calendar entries.
 */
export function extractSlotsFromMessage(input: { subject: string | null; body: string | null }): {
  slots: ExtractedSlotRecord[];
  forwardCalendar: ExtractedForwardCalendarRecord[];
} {
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const haystack = `${subject}\n${body}`;

  const slots: ExtractedSlotRecord[] = [];
  const forwardCalendar: ExtractedForwardCalendarRecord[] = [];

  // ── target_rate ────────────────────────────────────────────────────────────
  const rateRe = new RegExp(RATE_RE.source, "gi");
  let m: RegExpExecArray | null;
  let bestRate: { value: number; idx: number } | null = null;
  while ((m = rateRe.exec(haystack)) !== null) {
    const numeric = Number(m[1].replace(/,/g, ""));
    if (!isFinite(numeric) || numeric <= 0) continue;
    const before = haystack.slice(Math.max(0, m.index - 50), m.index);
    if (TARGET_RATE_CONTEXT.test(before)) {
      bestRate = { value: numeric, idx: m.index };
      break;
    }
    if (!bestRate) bestRate = { value: numeric, idx: m.index };
  }
  if (bestRate) {
    slots.push({
      slotName: "target_rate",
      slotValueNumeric: bestRate.value.toString(),
      slotValue: `$${bestRate.value}`,
      confidence: TARGET_RATE_CONTEXT.test(haystack.slice(Math.max(0, bestRate.idx - 50), bestRate.idx)) ? 80 : 55,
      evidence: snippet(haystack, bestRate.idx),
    });
  }

  // ── incumbent / incumbent_rate ────────────────────────────────────────────
  const incM = haystack.match(INCUMBENT_RE);
  if (incM) {
    slots.push({
      slotName: "incumbent",
      slotValue: incM[2].trim(),
      confidence: 70,
      evidence: snippet(haystack, haystack.indexOf(incM[0])),
    });
    // Look for an adjacent rate within 80 chars.
    const tail = haystack.slice(haystack.indexOf(incM[0]) + incM[0].length, haystack.indexOf(incM[0]) + incM[0].length + 120);
    const rateInTail = tail.match(/\$\s*(\d{1,2}(?:[,.]\d{3})?(?:\.\d{1,2})?)/);
    if (rateInTail) {
      const num = Number(rateInTail[1].replace(/,/g, ""));
      if (isFinite(num) && num > 0) {
        slots.push({
          slotName: "incumbent_rate",
          slotValueNumeric: num.toString(),
          slotValue: `$${num}`,
          confidence: 70,
          evidence: snippet(haystack, haystack.indexOf(rateInTail[0])),
        });
      }
    }
  }

  // ── competitor_name ────────────────────────────────────────────────────────
  const compM = haystack.match(COMPETITOR_RE);
  if (compM) {
    const candidate = compM[1].trim().replace(/[.,;]+$/, "");
    if (candidate.length >= 2 && !/^(another|cheaper|someone)\b/i.test(candidate)) {
      slots.push({
        slotName: "competitor_name",
        slotValue: candidate,
        confidence: 65,
        evidence: snippet(haystack, haystack.indexOf(compM[0])),
      });
    }
  }

  // ── RFP date / contract end ────────────────────────────────────────────────
  const rfpM = haystack.match(RFP_DATE_RE);
  if (rfpM) {
    const parsed = parseLooseDate(rfpM[1]);
    if (parsed) {
      slots.push({
        slotName: "rfp_date",
        slotValueDate: parsed,
        confidence: 70,
        evidence: snippet(haystack, haystack.indexOf(rfpM[0])),
      });
      forwardCalendar.push({
        eventType: "rfp",
        eventDate: parsed,
        description: snippet(haystack, haystack.indexOf(rfpM[0])),
        confidence: 70,
      });
    }
  }
  const contractM = haystack.match(CONTRACT_END_RE);
  if (contractM) {
    const parsed = parseLooseDate(contractM[1]);
    if (parsed) {
      slots.push({
        slotName: "contract_end_date",
        slotValueDate: parsed,
        confidence: 70,
        evidence: snippet(haystack, haystack.indexOf(contractM[0])),
      });
      forwardCalendar.push({
        eventType: /renew/i.test(contractM[0]) ? "renewal" : "contract_end",
        eventDate: parsed,
        description: snippet(haystack, haystack.indexOf(contractM[0])),
        confidence: 70,
      });
    }
  }

  // ── lane attributes ────────────────────────────────────────────────────────
  const eqM = haystack.match(EQUIPMENT_RE);
  if (eqM) {
    slots.push({ slotName: "equipment", slotValue: eqM[0], confidence: 80, evidence: snippet(haystack, haystack.indexOf(eqM[0])) });
  }
  const cmM = haystack.match(COMMODITY_RE);
  if (cmM) {
    slots.push({ slotName: "commodity", slotValue: cmM[1].trim(), confidence: 75, evidence: snippet(haystack, haystack.indexOf(cmM[0])) });
  }
  const wM = haystack.match(WEIGHT_RE);
  if (wM) {
    const num = Number(wM[1].replace(/[.,]/g, ""));
    if (isFinite(num)) slots.push({ slotName: "weight", slotValueNumeric: num.toString(), slotValue: wM[0], confidence: 80, evidence: snippet(haystack, haystack.indexOf(wM[0])) });
  }
  const tM = haystack.match(TEMP_RE);
  if (tM) {
    const num = Number(tM[1]);
    if (isFinite(num)) slots.push({ slotName: "temperature", slotValueNumeric: num.toString(), slotValue: tM[0], confidence: 80, evidence: snippet(haystack, haystack.indexOf(tM[0])) });
  }
  const trM = haystack.match(TRANSIT_RE);
  if (trM) {
    const num = Number(trM[1]);
    if (isFinite(num)) slots.push({ slotName: "transit_days", slotValueNumeric: num.toString(), slotValue: `${num} days`, confidence: 75, evidence: snippet(haystack, haystack.indexOf(trM[0])) });
  }

  return { slots, forwardCalendar };
}

function parseLooseDate(raw: string): Date | null {
  const trimmed = raw.trim().replace(/[\s,]+$/, "");
  if (!trimmed) return null;
  const now = new Date();
  // ISO / numeric / MMM DD[, YYYY]
  const direct = new Date(trimmed);
  if (!isNaN(direct.getTime()) && direct.getFullYear() >= 1990 && direct.getFullYear() < 2100) {
    if (!/\d{4}/.test(trimmed) && direct < now) direct.setFullYear(now.getFullYear() + 1);
    return direct;
  }
  // "Q1 2027", "end of Q3"
  const qMatch = trimmed.match(/Q([1-4])(?:\s+(\d{4}))?/i);
  if (qMatch) {
    const q = Number(qMatch[1]);
    const year = qMatch[2] ? Number(qMatch[2]) : now.getFullYear();
    return new Date(year, (q - 1) * 3, 1);
  }
  return null;
}

/**
 * Crystallize a competitor mention into a `competitive_signals` row so the
 * AI Intelligence layer's existing competitor pages light up from email
 * evidence (Step 5 — Tier 2.1). Idempotent on (org, company, source_id) by
 * looking for an existing active row keyed to this message before inserting.
 */
async function recordCompetitiveSignalFromSlot(
  msg: EmailMessage,
  competitorName: string,
  evidence: string,
): Promise<void> {
  if (!msg.linkedAccountId) return;
  const sourceId = `email_msg:${msg.id}:competitor`;
  // Idempotent guard — if we already wrote this signal for this message, skip.
  const existing = await db
    .select({ id: competitiveSignals.id })
    .from(competitiveSignals)
    .where(and(
      eq(competitiveSignals.orgId, msg.orgId),
      eq(competitiveSignals.companyId, msg.linkedAccountId),
      eq(competitiveSignals.sourceId, sourceId),
    ))
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(competitiveSignals).values({
    orgId: msg.orgId,
    companyId: msg.linkedAccountId,
    signalType: "competitor_mention",
    competitorName,
    description: evidence.slice(0, 500),
    sourceType: "email_signal",
    sourceId,
    severity: "moderate",
    status: "active",
  });
}

/**
 * Live ingestion entry — extract + persist slots and forward calendar entries.
 */
export async function extractAndPersistSlots(msg: EmailMessage): Promise<{ slots: number; forwardCalendar: number; competitiveSignals: number }> {
  const { slots, forwardCalendar } = extractSlotsFromMessage({ subject: msg.subject, body: msg.body });
  let competitiveSignalCount = 0;
  for (const s of slots) {
    await upsertSlot({
      orgId: msg.orgId,
      messageId: msg.id,
      threadId: msg.threadId ?? null,
      slotName: s.slotName,
      slotValue: s.slotValue ?? null,
      slotValueNumeric: s.slotValueNumeric ?? null,
      slotValueDate: s.slotValueDate ?? null,
      confidence: s.confidence,
      evidence: s.evidence,
      linkedAccountId: msg.linkedAccountId ?? null,
      linkedLaneId: msg.linkedLaneId ?? null,
    });
    if (s.slotName === "competitor_name" && s.slotValue && msg.linkedAccountId) {
      try {
        await recordCompetitiveSignalFromSlot(msg, s.slotValue, s.evidence);
        competitiveSignalCount += 1;
      } catch (err) {
        console.error(`[emailFacts] competitive_signal write failed for msg ${msg.id}:`, err);
      }
    }
  }
  for (const ev of forwardCalendar) {
    await upsertForwardCalendarEvent({
      orgId: msg.orgId,
      messageId: msg.id,
      threadId: msg.threadId ?? null,
      linkedAccountId: msg.linkedAccountId ?? null,
      linkedLaneId: msg.linkedLaneId ?? null,
      eventType: ev.eventType,
      eventDate: ev.eventDate,
      description: ev.description,
      confidence: ev.confidence,
      status: "pending",
      nbaCardId: null,
    });
  }
  return { slots: slots.length, forwardCalendar: forwardCalendar.length, competitiveSignals: competitiveSignalCount };
}
