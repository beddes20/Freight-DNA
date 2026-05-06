/**
 * Email Intelligence v1.5 — Consumer adapter (Task #943).
 *
 * Single read surface for downstream consumers (NBAs, coaching, conversations,
 * accounts) over every fact written by Tier 1 + Tier 2. Consumers must call
 * the adapter rather than reading from `email_signals.extractedData` directly.
 */

import {
  getActiveBouncesForEmail,
  getBounceDailyCounts,
  getParticipantsForThread,
  getAttachmentsForMessage,
  getRateConClassificationsForLane,
  getLatestSlotsForThread,
  getUpcomingForwardCalendarEvents,
  listPromisesForRep,
  listPromisesForAccount,
  listOpenQuestionsForAccount,
  listOpenQuestionsForRep,
  listQualityScoresForRep,
  listQualityScoresForAccount,
  getContactSentiment,
} from "./emailFactsStorage";
import { isContactSuppressed as bounceSuppressed } from "./bounceClassifier";
import { getStakeholderGraphForAccount, type StakeholderRow } from "./participants";
import { getSentimentTrendForAccount, type SentimentTrend } from "./sentimentWriteback";
import type {
  EmailBounceEvent,
  EmailParticipant,
  EmailAttachmentClassification,
  EmailExtractedSlot,
  ForwardCalendarEvent,
  EmailPromise,
  EmailQuestion,
  EmailOutboundQualityScore,
  ContactSentiment,
} from "@shared/schema";

export interface BounceStatus {
  suppressed: boolean;
  reason: string | null;
  activeUntil: Date | null;
  events: EmailBounceEvent[];
}

export interface OutboundQualityRollup {
  count: number;
  median: number;
  p25: number;
  p75: number;
  recent: EmailOutboundQualityScore[];
}

export interface AccountSentimentSnapshot {
  averageScore: number;
  trend: SentimentTrend;
  contactCount: number;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}
function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

export class EmailFactsAdapter {
  // ── Bounce / DSN / OOO ────────────────────────────────────────────────────
  async getBounceStatusForContact(orgId: string, email: string): Promise<BounceStatus> {
    const status = await bounceSuppressed(orgId, email);
    const events = await getActiveBouncesForEmail(orgId, email);
    return { ...status, events };
  }

  async isContactSuppressed(orgId: string, email: string): Promise<boolean> {
    const s = await bounceSuppressed(orgId, email);
    return s.suppressed;
  }

  async getBounceDailyCounts(orgId: string, sinceDays = 7) {
    return getBounceDailyCounts(orgId, sinceDays);
  }

  // ── Participants / stakeholder graph ──────────────────────────────────────
  async getParticipantsForThread(orgId: string, threadId: string): Promise<EmailParticipant[]> {
    return getParticipantsForThread(orgId, threadId);
  }

  async getStakeholderGraphForAccount(orgId: string, companyId: string): Promise<StakeholderRow[]> {
    return getStakeholderGraphForAccount(orgId, companyId);
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  async getAttachmentsForMessage(messageId: string): Promise<EmailAttachmentClassification[]> {
    return getAttachmentsForMessage(messageId);
  }

  async getRateConsForLane(orgId: string, laneId: string, limit = 25) {
    return getRateConClassificationsForLane(orgId, laneId, limit);
  }

  // ── Slots + forward calendar ──────────────────────────────────────────────
  async getSlotsForThread(orgId: string, threadId: string): Promise<Map<string, EmailExtractedSlot>> {
    return getLatestSlotsForThread(orgId, threadId);
  }

  async getUpcomingForwardCalendar(orgId: string, withinDays = 14): Promise<ForwardCalendarEvent[]> {
    return getUpcomingForwardCalendarEvents(orgId, withinDays);
  }

  // ── Promises ──────────────────────────────────────────────────────────────
  async getPromisesForRep(orgId: string, repUserId: string, status?: string): Promise<EmailPromise[]> {
    return listPromisesForRep(orgId, repUserId, status);
  }

  async getPromisesForAccount(orgId: string, accountId: string): Promise<EmailPromise[]> {
    return listPromisesForAccount(orgId, accountId);
  }

  // ── Questions ─────────────────────────────────────────────────────────────
  async getQuestionsForAccount(orgId: string, accountId: string): Promise<EmailQuestion[]> {
    return listOpenQuestionsForAccount(orgId, accountId);
  }

  async getUnansweredQuestionsForRep(orgId: string, repAddresses: string[]): Promise<EmailQuestion[]> {
    return listOpenQuestionsForRep(orgId, repAddresses);
  }

  // ── Outbound quality ──────────────────────────────────────────────────────
  async getQualityScoresForRep(orgId: string, repUserId: string, sinceDays = 30): Promise<OutboundQualityRollup> {
    const rows = await listQualityScoresForRep(orgId, repUserId, sinceDays);
    const overalls = rows.map((r) => r.overallScore);
    return {
      count: rows.length,
      median: median(overalls),
      p25: percentile(overalls, 25),
      p75: percentile(overalls, 75),
      recent: rows.slice(0, 10),
    };
  }

  async getQualityScoresForAccount(orgId: string, accountId: string, sinceDays = 30): Promise<OutboundQualityRollup> {
    const rows = await listQualityScoresForAccount(orgId, accountId, sinceDays);
    const overalls = rows.map((r) => r.overallScore);
    return {
      count: rows.length,
      median: median(overalls),
      p25: percentile(overalls, 25),
      p75: percentile(overalls, 75),
      recent: rows.slice(0, 10),
    };
  }

  // ── Sentiment ─────────────────────────────────────────────────────────────
  async getSentimentForContact(orgId: string, contactId: string): Promise<ContactSentiment | undefined> {
    return getContactSentiment(orgId, contactId);
  }

  async getSentimentTrendForAccount(orgId: string, companyId: string): Promise<AccountSentimentSnapshot | null> {
    return getSentimentTrendForAccount(orgId, companyId);
  }
}

export const emailFactsAdapter = new EmailFactsAdapter();
