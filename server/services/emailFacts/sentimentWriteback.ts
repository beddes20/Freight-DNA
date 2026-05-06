/**
 * Email Intelligence v1.5 — Tier 2.5 sentiment writeback (Task #943).
 *
 * Computes a deterministic per-message sentiment score and writes the smoothed
 * per-contact rolling aggregate to `contact_sentiment_tracking`.
 */

import type { EmailMessage, ContactSentiment } from "@shared/schema";
import { upsertContactSentiment, getContactSentiment, listSentimentForCompany } from "./emailFactsStorage";

const POSITIVE_LEXICON = [
  "thanks", "thank you", "appreciate", "great", "perfect", "awesome",
  "excellent", "amazing", "happy", "love", "fantastic", "wonderful",
  "yes", "agree", "deal", "approved", "go ahead", "good", "nice", "smooth",
];
const NEGATIVE_LEXICON = [
  "frustrated", "frustrating", "angry", "upset", "disappointed", "issue",
  "problem", "complaint", "delay", "delayed", "missed", "broken",
  "no", "not happy", "unacceptable", "concerned", "concern", "concerns",
  "wrong", "bad", "worst", "terrible", "horrible", "fed up", "annoyed",
  "cancel", "cancelled", "won't", "cannot", "can't", "stop", "done",
];
const INTENSIFIERS = ["very", "really", "extremely", "super", "highly", "absolutely"];
const NEGATORS = ["not", "never", "no", "without", "barely", "hardly"];

const TOKEN_RE = /[\w']+/g;

export interface MessageSentiment {
  score: number; // 0–100 (50 = neutral)
  positiveHits: string[];
  negativeHits: string[];
}

export function scoreMessageSentiment(body: string | null): MessageSentiment {
  if (!body) return { score: 50, positiveHits: [], negativeHits: [] };
  const tokens = body.toLowerCase().match(TOKEN_RE) ?? [];
  const positiveHits: string[] = [];
  const negativeHits: string[] = [];
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const intensifier = i > 0 && INTENSIFIERS.includes(tokens[i - 1]) ? 2 : 1;
    const negated = i >= 1 && NEGATORS.includes(tokens[i - 1]);
    if (POSITIVE_LEXICON.includes(tok) || POSITIVE_LEXICON.some((p) => p.includes(" ") && body.toLowerCase().includes(p))) {
      if (negated) { neg += intensifier; negativeHits.push(tok); }
      else { pos += intensifier; positiveHits.push(tok); }
    } else if (NEGATIVE_LEXICON.includes(tok)) {
      if (negated) { pos += intensifier; positiveHits.push(`!${tok}`); }
      else { neg += intensifier; negativeHits.push(tok); }
    }
  }
  // Multi-word positive hits
  const lc = body.toLowerCase();
  for (const p of POSITIVE_LEXICON.filter((x) => x.includes(" "))) {
    if (lc.includes(p)) { pos += 1; positiveHits.push(p); }
  }
  for (const n of NEGATIVE_LEXICON.filter((x) => x.includes(" "))) {
    if (lc.includes(n)) { neg += 1; negativeHits.push(n); }
  }

  const total = pos + neg;
  if (total === 0) return { score: 50, positiveHits, negativeHits };
  const ratio = pos / total;
  // Map 0..1 → 25..85 (we don't go to extremes on a single message).
  const score = Math.round(25 + ratio * 60);
  return { score, positiveHits, negativeHits };
}

export function smoothSentiment(existingScore: number, newScore: number, dataPoints: number): number {
  if (dataPoints < 3) {
    // Naive average for the first few messages.
    return Math.round((existingScore * dataPoints + newScore) / (dataPoints + 1));
  }
  return Math.round(existingScore * 0.7 + newScore * 0.3);
}

export type SentimentTrend = "improving" | "stable" | "declining";

export function computeTrend(history: number[]): SentimentTrend {
  if (history.length < 3) return "stable";
  const recent = history.slice(-5);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const delta = last - first;
  if (delta >= 8) return "improving";
  if (delta <= -8) return "declining";
  return "stable";
}

/** How many recent message-IDs we keep in the dedupe window. */
const SENTIMENT_DEDUPE_WINDOW = 100;

interface PersistedSentimentSignals {
  history?: number[];
  processedMessageIds?: string[];
  lastMessageId?: string;
  lastMessageScore?: number;
  lastPositive?: string[];
  lastNegative?: string[];
}

/**
 * Live ingestion entry — score + writeback to `contact_sentiment_tracking`.
 *
 * Idempotent per (contact, msg.id): the last `SENTIMENT_DEDUPE_WINDOW` message
 * IDs that contributed to the rolling history are stored alongside the score
 * in the `signals` jsonb. Re-ingesting the same Graph message (webhook
 * retries, delta resync, backfill, self-heal) short-circuits and never
 * double-counts the contribution.
 */
export async function recordContactSentiment(msg: EmailMessage, opts?: { contactId?: string | null }): Promise<ContactSentiment | null> {
  const contactId = opts?.contactId ?? null;
  if (!contactId || !msg.linkedAccountId) return null;
  if (msg.direction !== "inbound") return null;

  const ms = scoreMessageSentiment(msg.body);
  const existing = await getContactSentiment(msg.orgId, contactId);
  const existingSignals = (existing?.signals as PersistedSentimentSignals | undefined) ?? {};
  const processed = Array.isArray(existingSignals.processedMessageIds)
    ? existingSignals.processedMessageIds
    : [];

  // Replay short-circuit — same message already counted.
  if (processed.includes(msg.id)) {
    return existing ?? null;
  }

  const history = Array.isArray(existingSignals.history) ? existingSignals.history.slice(-9) : [];
  const dataPoints = history.length;
  const newScore = smoothSentiment(existing?.sentimentScore ?? ms.score, ms.score, dataPoints);
  history.push(newScore);
  const trend = computeTrend(history);

  // Append the new message id to the dedupe window (bounded length).
  const nextProcessed = [...processed, msg.id].slice(-SENTIMENT_DEDUPE_WINDOW);

  return upsertContactSentiment(msg.orgId, contactId, msg.linkedAccountId, newScore, trend, {
    history,
    processedMessageIds: nextProcessed,
    lastMessageId: msg.id,
    lastMessageScore: ms.score,
    lastPositive: ms.positiveHits.slice(0, 5),
    lastNegative: ms.negativeHits.slice(0, 5),
  });
}

export async function getSentimentTrendForAccount(orgId: string, companyId: string): Promise<{
  averageScore: number;
  trend: SentimentTrend;
  contactCount: number;
} | null> {
  const rows = await listSentimentForCompany(orgId, companyId);
  if (rows.length === 0) return null;
  const avg = rows.reduce((sum, r) => sum + r.sentimentScore, 0) / rows.length;
  const trends = rows.map((r) => r.sentimentTrend);
  const declining = trends.filter((t) => t === "declining").length;
  const improving = trends.filter((t) => t === "improving").length;
  let trend: SentimentTrend = "stable";
  if (declining > improving + 1) trend = "declining";
  else if (improving > declining + 1) trend = "improving";
  return { averageScore: Math.round(avg), trend, contactCount: rows.length };
}
