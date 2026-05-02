/**
 * Email Intelligence v1.5 — Tier 2.4 outbound quality grader (Task #943).
 *
 * Heuristic scorer. NEVER blocks sends. Diagnostic-only output, read by the
 * coaching dashboard. Heuristic version keeps the per-email cost at ~zero.
 */

import type { EmailMessage } from "@shared/schema";
import { upsertOutboundQualityScore } from "./emailFactsStorage";

const HEDGE_WORDS = ["maybe", "perhaps", "kinda", "sort of", "i guess", "probably", "possibly", "i think", "might be", "could be"];
const TONE_GREETING_WORDS = ["hi", "hello", "good morning", "good afternoon", "thanks", "thank you", "appreciate"];
const TONE_CLOSE_WORDS = ["thanks", "thank you", "regards", "best", "cheers", "appreciate"];
const VALUE_ADD_TOKENS = [/\$\s*\d/, /\d+\s*(loads?|lanes?|trucks?)/i, /\bcapacity\b/i, /\brate\b/i, /\bavailable\b/i, /\bcoverage\b/i];
const OBJECTION_ACK_TOKENS = [/\bi\s+(?:hear|understand|see)\s+you\b/i, /\bgood\s+point\b/i, /\bvalid\s+(?:point|concern)\b/i, /\bappreciate\s+the\s+(?:feedback|context)\b/i, /\bthat\s+(?:makes\s+sense|is\s+fair)\b/i];
const OBJECTION_REFRAME_TOKENS = [/\bthat\s+said\b/i, /\bhowever\b/i, /\bone\s+thing\s+to\s+consider\b/i, /\bhere'?s\s+(?:what|the)\s+(?:i\s+can|we\s+can)\b/i, /\bif\s+we\s+(?:can|could)\b/i];
const ASK_TOKENS = [/\bcan\s+you\b/i, /\blet\s+me\s+know\b/i, /\bcould\s+you\b/i, /\bplease\s+\w+\b/i, /\?$/m];
const DEADLINE_TOKENS = [/\bby\s+(?:end\s+of|EOD|EOB|tomorrow|today|monday|tuesday|wednesday|thursday|friday)\b/i, /\bnext\s+(?:week|monday|tuesday|wednesday|thursday|friday)\b/i];

function clamp(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }

export interface QualityScore {
  clarity: number;
  tone: number;
  valueAdd: number;
  objectionHandling: number;
  overall: number;
  features: Record<string, unknown>;
}

/**
 * Pure grader — input is the rep's outbound body + (optionally) the prior
 * inbound message it replies to so objection handling can be scored against it.
 */
export function gradeOutboundQuality(input: { body: string | null; priorInboundIntent?: string | null }): QualityScore {
  const body = (input.body || "").trim();
  const lc = body.toLowerCase();
  const features: Record<string, unknown> = {};

  // ── clarity ────────────────────────────────────────────────────────────────
  const len = body.length;
  features.length = len;
  let clarity: number;
  if (len < 40) clarity = 30;
  else if (len < 80) clarity = 55;
  else if (len < 600) clarity = 80;
  else if (len < 1200) clarity = 65;
  else clarity = 45;

  const sentenceCount = body.split(/[.?!]\s+/).filter((s) => s.trim().length > 0).length;
  features.sentenceCount = sentenceCount;
  if (sentenceCount > 12) clarity -= 15;

  const hedgeMatches = HEDGE_WORDS.filter((w) => lc.includes(w));
  features.hedgeMatches = hedgeMatches;
  clarity -= hedgeMatches.length * 8;
  const askMatches = ASK_TOKENS.filter((re) => re.test(body));
  features.askMatches = askMatches.length;
  if (askMatches.length === 0 && len > 100) clarity -= 10;
  if (askMatches.length > 0) clarity += 5;

  // ── tone ───────────────────────────────────────────────────────────────────
  const greeting = TONE_GREETING_WORDS.some((w) => lc.startsWith(w) || lc.slice(0, 50).includes(w));
  const close = TONE_CLOSE_WORDS.some((w) => lc.slice(-100).includes(w));
  features.hasGreeting = greeting;
  features.hasClose = close;
  let tone = 60 + (greeting ? 15 : 0) + (close ? 15 : 0);
  const exclaimCount = (body.match(/!/g) || []).length;
  features.exclaimCount = exclaimCount;
  if (exclaimCount > 2) tone -= 15;
  const allCapsWords = (body.match(/\b[A-Z]{4,}\b/g) || []).length;
  features.allCapsWords = allCapsWords;
  if (allCapsWords > 1) tone -= 20;

  // ── value-add ──────────────────────────────────────────────────────────────
  const valueMatches = VALUE_ADD_TOKENS.filter((re) => re.test(body));
  features.valueAddMatches = valueMatches.length;
  let valueAdd = 30 + valueMatches.length * 12;
  if (DEADLINE_TOKENS.some((re) => re.test(body))) valueAdd += 10;

  // ── objection handling ────────────────────────────────────────────────────
  const acks = OBJECTION_ACK_TOKENS.filter((re) => re.test(body));
  const reframes = OBJECTION_REFRAME_TOKENS.filter((re) => re.test(body));
  features.ackMatches = acks.length;
  features.reframeMatches = reframes.length;
  let objectionHandling = 50;
  const isObjectionContext = input.priorInboundIntent && /objection|price_pushback|service_complaint/i.test(input.priorInboundIntent);
  if (isObjectionContext) {
    objectionHandling = 30 + acks.length * 25 + reframes.length * 20;
  } else {
    // No objection context — score full marks if the rep didn't need to handle one.
    objectionHandling = 75;
  }

  const clampedClarity = clamp(clarity);
  const clampedTone = clamp(tone);
  const clampedValue = clamp(valueAdd);
  const clampedObj = clamp(objectionHandling);
  const overall = clamp(0.3 * clampedClarity + 0.2 * clampedTone + 0.3 * clampedValue + 0.2 * clampedObj);

  return {
    clarity: clampedClarity,
    tone: clampedTone,
    valueAdd: clampedValue,
    objectionHandling: clampedObj,
    overall,
    features,
  };
}

/**
 * Live ingestion entry — grade + persist on outbound rep mail.
 */
export async function gradeAndPersistOutbound(msg: EmailMessage, opts?: { repUserId?: string | null; priorInboundIntent?: string | null }): Promise<void> {
  if (msg.direction !== "outbound") return;
  const score = gradeOutboundQuality({ body: msg.body, priorInboundIntent: opts?.priorInboundIntent ?? null });
  await upsertOutboundQualityScore({
    orgId: msg.orgId,
    messageId: msg.id,
    repUserId: opts?.repUserId ?? null,
    linkedAccountId: msg.linkedAccountId ?? null,
    clarityScore: score.clarity,
    toneScore: score.tone,
    valueAddScore: score.valueAdd,
    objectionHandlingScore: score.objectionHandling,
    overallScore: score.overall,
    features: score.features,
    graderVersion: "heuristic_v1",
  });
}
