/**
 * Email Intelligence v1.5 — Tier 2.2 promise register (Task #943).
 *
 * Detects time-bound rep commitments in outbound mail and writes them to
 * `email_promises`. Status flips when subsequent thread events land.
 */

import type { EmailMessage } from "@shared/schema";
import {
  upsertPromise,
  getOpenPromisesForThread,
  markPromiseResolved,
  listOverdueOpenPromises,
} from "./emailFactsStorage";

const PROMISE_PATTERNS: Array<{ re: RegExp; confidence: number }> = [
  { re: /\bI(?:'ll| will)\s+([\w\s,'-]{3,80}?)\s+by\s+([^.;\n]{3,40})/i, confidence: 80 },
  { re: /\b(?:get|send|share|deliver|reply|respond)\s+(?:back\s+)?(?:to\s+you\s+)?([\w\s,'-]{0,40}?)\s+by\s+([^.;\n]{3,40})/i, confidence: 75 },
  { re: /\b(?:I'?l?l?|we'?ll?)\s+(?:call|reach\s+out|circle\s+back|follow\s+up|check\s+in)\s+([^.;\n]{3,60})/i, confidence: 65 },
  { re: /\b(?:you'?ll?\s+have|expect)\s+(?:it|the\s+\w+)\s+by\s+([^.;\n]{3,40})/i, confidence: 70 },
];

const RELATIVE_DATE_PATTERNS: Array<{ re: RegExp; resolve: (m: RegExpMatchArray, now: Date) => Date | null }> = [
  { re: /\btoday\b/i, resolve: (_, now) => endOfDay(now) },
  { re: /\b(?:tomorrow|tmrw)\b/i, resolve: (_, now) => endOfDay(addDays(now, 1)) },
  { re: /\bend\s+of\s+(?:day|today)\b|\bEOD\b/i, resolve: (_, now) => endOfDay(now) },
  { re: /\bend\s+of\s+(?:business|the\s+day)\b|\bEOB\b/i, resolve: (_, now) => endOfDay(now) },
  { re: /\bend\s+of\s+(?:week|EOW)\b/i, resolve: (_, now) => endOfDay(nextDayOfWeek(now, 5)) },
  { re: /\bend\s+of\s+next\s+week\b/i, resolve: (_, now) => endOfDay(addDays(nextDayOfWeek(now, 5), 7)) },
  { re: /\b(?:first\s+thing\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+morning)?\b/i, resolve: (m, now) => endOfDay(nextDayOfWeek(now, weekdayIndex(m[1]))) },
  { re: /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, resolve: (m, now) => endOfDay(addDays(nextDayOfWeek(now, weekdayIndex(m[1])), 7)) },
  { re: /\bin\s+(\d+)\s+(hour|day|week)s?\b/i, resolve: (m, now) => {
    const n = Number(m[1]); const unit = m[2].toLowerCase();
    if (unit === "hour") return new Date(now.getTime() + n * 3600 * 1000);
    if (unit === "day") return endOfDay(addDays(now, n));
    if (unit === "week") return endOfDay(addDays(now, n * 7));
    return null;
  } },
  { re: /\bby\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i, resolve: (m, now) => {
    let h = Number(m[1]);
    const min = Number(m[2] || "0");
    const ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  } },
];

function weekdayIndex(name: string): number {
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(name.toLowerCase());
}
function endOfDay(d: Date): Date {
  const out = new Date(d); out.setHours(17, 0, 0, 0); return out;
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d); out.setDate(out.getDate() + n); return out;
}
function nextDayOfWeek(now: Date, target: number): Date {
  const diff = (target + 7 - now.getDay()) % 7 || 7;
  return addDays(now, diff);
}

export function parseRelativeDeadline(phrase: string, now: Date = new Date()): Date | null {
  for (const p of RELATIVE_DATE_PATTERNS) {
    const m = phrase.match(p.re);
    if (m) {
      const resolved = p.resolve(m, now);
      if (resolved) return resolved;
    }
  }
  // Try a direct date parse of the whole phrase as a last resort.
  const direct = new Date(phrase);
  if (!isNaN(direct.getTime()) && direct.getFullYear() >= 1990 && direct.getFullYear() < 2100) {
    return direct;
  }
  return null;
}

export interface DetectedPromise {
  promiseText: string;
  promiseDueAt: Date | null;
  confidence: number;
}

/**
 * Pure detector — given an outbound message body, return zero or more promises.
 */
export function detectPromisesInOutbound(body: string | null, now: Date = new Date()): DetectedPromise[] {
  if (!body) return [];
  const promises: DetectedPromise[] = [];
  const seen = new Set<string>();
  for (const pattern of PROMISE_PATTERNS) {
    const m = body.match(pattern.re);
    if (!m) continue;
    const text = m[0].replace(/\s+/g, " ").trim().slice(0, 240);
    if (seen.has(text)) continue;
    seen.add(text);
    // The deadline phrase is captured in different groups depending on pattern.
    const deadlinePhrase = m[2] || m[1] || "";
    const due = parseRelativeDeadline(deadlinePhrase, now);
    promises.push({
      promiseText: text,
      promiseDueAt: due,
      confidence: pattern.confidence,
    });
  }
  return promises;
}

/**
 * Live ingestion entry — detect + persist on outbound mail.
 */
export async function detectAndPersistPromises(msg: EmailMessage, repUserId?: string | null): Promise<number> {
  if (msg.direction !== "outbound") return 0;
  const promises = detectPromisesInOutbound(msg.body, msg.providerSentAt ?? msg.createdAt ?? new Date());
  for (const p of promises) {
    await upsertPromise({
      orgId: msg.orgId,
      messageId: msg.id,
      threadId: msg.threadId ?? null,
      repUserId: repUserId ?? null,
      linkedAccountId: msg.linkedAccountId ?? null,
      linkedContactId: null,
      promiseText: p.promiseText,
      promiseDueAt: p.promiseDueAt,
      status: "open",
      confidence: p.confidence,
    });
  }
  return promises.length;
}

/**
 * On every subsequent rep follow-up to the same thread, mark all open promises
 * created BEFORE the new message and BEFORE their due date as "kept".
 */
export async function reconcilePromisesOnThreadReply(msg: EmailMessage): Promise<number> {
  if (!msg.threadId) return 0;
  if (msg.direction !== "outbound") return 0;
  const open = await getOpenPromisesForThread(msg.orgId, msg.threadId);
  let resolved = 0;
  for (const p of open) {
    if (p.messageId === msg.id) continue;
    await markPromiseResolved(p.id, "kept", msg.id);
    resolved += 1;
  }
  return resolved;
}

/**
 * Daily sweep — flip overdue open promises to "broken".
 * Returns the number of rows flipped.
 */
export async function sweepOverduePromises(orgId: string): Promise<number> {
  const overdue = await listOverdueOpenPromises(orgId);
  for (const p of overdue) {
    await markPromiseResolved(p.id, "broken", null);
  }
  return overdue.length;
}
