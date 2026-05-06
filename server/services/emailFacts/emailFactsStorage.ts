/**
 * Email Intelligence v1.5 — Fact storage helpers (Task #943).
 *
 * Thin Drizzle wrappers used by every fact service. Uses the shared `db`
 * exported from `server/storage.ts`. We keep these helpers off the
 * `IStorage` interface so the v1.5 surface stays small and the existing
 * email pipeline contract doesn't grow new methods.
 */

import { and, eq, sql, desc, inArray, isNull, lte, gte } from "drizzle-orm";
import { db } from "../../storage";
import {
  emailBounceEvents,
  emailParticipants,
  emailAttachmentClassifications,
  emailExtractedSlots,
  forwardCalendarEvents,
  emailPromises,
  emailQuestions,
  emailOutboundQualityScores,
  contactSentimentTracking,
  emailMessages,
  type InsertEmailBounceEvent,
  type EmailBounceEvent,
  type InsertEmailParticipant,
  type EmailParticipant,
  type InsertEmailAttachmentClassification,
  type EmailAttachmentClassification,
  type InsertEmailExtractedSlot,
  type EmailExtractedSlot,
  type InsertForwardCalendarEvent,
  type ForwardCalendarEvent,
  type InsertEmailPromise,
  type EmailPromise,
  type InsertEmailQuestion,
  type EmailQuestion,
  type InsertEmailOutboundQualityScore,
  type EmailOutboundQualityScore,
  type ContactSentiment,
  type InsertContactSentiment,
} from "@shared/schema";

// ─── Bounce events ───────────────────────────────────────────────────────────

export async function upsertBounceEvent(row: InsertEmailBounceEvent): Promise<EmailBounceEvent> {
  const [out] = await db
    .insert(emailBounceEvents)
    .values(row)
    .onConflictDoUpdate({
      target: [emailBounceEvents.messageId, emailBounceEvents.contactEmail],
      set: {
        bounceType: row.bounceType,
        diagnosticCode: row.diagnosticCode ?? null,
        oooUntil: row.oooUntil ?? null,
        alternateContactEmail: row.alternateContactEmail ?? null,
        alternateContactName: row.alternateContactName ?? null,
        rawHeaders: row.rawHeaders ?? null,
      },
    })
    .returning();
  return out;
}

export async function getActiveBouncesForEmail(orgId: string, contactEmail: string): Promise<EmailBounceEvent[]> {
  const norm = contactEmail.toLowerCase();
  return db
    .select()
    .from(emailBounceEvents)
    .where(and(
      eq(emailBounceEvents.orgId, orgId),
      sql`lower(${emailBounceEvents.contactEmail}) = ${norm}`,
    ))
    .orderBy(desc(emailBounceEvents.detectedAt))
    .limit(10);
}

export async function getBounceDailyCounts(orgId: string, sinceDays: number): Promise<Array<{ day: string; bounceType: string; count: number }>> {
  const since = new Date(Date.now() - sinceDays * 86400 * 1000);
  const rows = await db.execute<{ day: string; bounce_type: string; count: number }>(sql`
    SELECT date_trunc('day', detected_at)::date::text AS day,
           bounce_type,
           COUNT(*)::int AS count
      FROM email_bounce_events
     WHERE org_id = ${orgId} AND detected_at >= ${since}
     GROUP BY 1, 2
     ORDER BY 1 DESC
  `);
  return rows.rows.map((r) => ({ day: r.day, bounceType: r.bounce_type, count: Number(r.count) }));
}

// ─── Participants ────────────────────────────────────────────────────────────

export async function insertParticipants(rows: InsertEmailParticipant[]): Promise<EmailParticipant[]> {
  if (rows.length === 0) return [];
  return db
    .insert(emailParticipants)
    .values(rows)
    .onConflictDoNothing({
      target: [emailParticipants.messageId, emailParticipants.emailAddress, emailParticipants.role],
    })
    .returning();
}

export async function getParticipantsForThread(orgId: string, threadId: string): Promise<EmailParticipant[]> {
  return db
    .select()
    .from(emailParticipants)
    .where(and(
      eq(emailParticipants.orgId, orgId),
      eq(emailParticipants.threadId, threadId),
    ))
    .orderBy(desc(emailParticipants.messageSentAt));
}

export async function getStakeholderRowsForCompany(orgId: string, companyId: string): Promise<Array<{
  emailAddress: string;
  displayName: string | null;
  contactId: string | null;
  messageCount: number;
  lastSeenAt: Date | null;
}>> {
  const rows = await db.execute<{
    email_address: string;
    display_name: string | null;
    contact_id: string | null;
    message_count: number;
    last_seen_at: Date | null;
  }>(sql`
    SELECT email_address,
           MAX(display_name) AS display_name,
           MAX(contact_id)   AS contact_id,
           COUNT(DISTINCT message_id)::int AS message_count,
           MAX(message_sent_at) AS last_seen_at
      FROM email_participants
     WHERE org_id = ${orgId} AND company_id = ${companyId}
     GROUP BY email_address
     ORDER BY MAX(message_sent_at) DESC NULLS LAST
  `);
  return rows.rows.map((r) => ({
    emailAddress: r.email_address,
    displayName: r.display_name,
    contactId: r.contact_id,
    messageCount: Number(r.message_count),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at) : null,
  }));
}

// ─── Attachment classifications ──────────────────────────────────────────────

/**
 * Drizzle's generated type for the jsonb `features` column is `unknown` —
 * so the public input type just declares a plain object / null which we
 * persist verbatim. Internally we serialise once when handing the value
 * to drizzle so neither caller code nor the upsert needs `as` casts.
 */
type AttachmentFeatures = Record<string, unknown> | null;

export interface UpsertAttachmentClassificationInput
  extends Omit<InsertEmailAttachmentClassification, "features"> {
  features?: AttachmentFeatures;
}

export async function upsertAttachmentClassification(
  row: UpsertAttachmentClassificationInput,
): Promise<EmailAttachmentClassification> {
  const features: AttachmentFeatures = row.features ?? null;
  const insertRow: InsertEmailAttachmentClassification = {
    ...row,
    features,
  };
  const [out] = await db
    .insert(emailAttachmentClassifications)
    .values(insertRow)
    .onConflictDoUpdate({
      target: [emailAttachmentClassifications.messageId, emailAttachmentClassifications.attachmentName],
      set: {
        kind: row.kind,
        confidence: row.confidence ?? 50,
        contentType: row.contentType ?? null,
        attachmentSize: row.attachmentSize ?? null,
        routedTo: row.routedTo ?? null,
        routedRefId: row.routedRefId ?? null,
        features,
      },
    })
    .returning();
  return out;
}

export async function getAttachmentsForMessage(messageId: string): Promise<EmailAttachmentClassification[]> {
  return db
    .select()
    .from(emailAttachmentClassifications)
    .where(eq(emailAttachmentClassifications.messageId, messageId));
}

export async function getRateConClassificationsForLane(orgId: string, laneId: string, limit = 25): Promise<Array<EmailAttachmentClassification & { messageProviderId: string | null; threadId: string | null }>> {
  const rows = await db.execute<{
    id: string;
    org_id: string;
    message_id: string;
    attachment_name: string;
    attachment_size: number | null;
    content_type: string | null;
    kind: string;
    confidence: number;
    routed_to: string | null;
    routed_ref_id: string | null;
    features: unknown;
    created_at: Date;
    message_provider_id: string | null;
    thread_id: string | null;
  }>(sql`
    SELECT eac.*, em.provider_message_id AS message_provider_id, em.thread_id
      FROM email_attachment_classifications eac
      JOIN email_messages em ON em.id = eac.message_id
     WHERE eac.org_id = ${orgId}
       AND eac.kind = 'rate_con'
       AND em.linked_lane_id = ${laneId}
     ORDER BY eac.created_at DESC
     LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    messageId: r.message_id,
    attachmentName: r.attachment_name,
    attachmentSize: r.attachment_size,
    contentType: r.content_type,
    kind: r.kind,
    confidence: r.confidence,
    routedTo: r.routed_to,
    routedRefId: r.routed_ref_id,
    features: r.features,
    createdAt: r.created_at,
    messageProviderId: r.message_provider_id,
    threadId: r.thread_id,
  }));
}

// ─── Slots ───────────────────────────────────────────────────────────────────

export async function upsertSlot(row: InsertEmailExtractedSlot): Promise<EmailExtractedSlot> {
  const [out] = await db
    .insert(emailExtractedSlots)
    .values(row)
    .onConflictDoUpdate({
      target: [emailExtractedSlots.messageId, emailExtractedSlots.slotName],
      set: {
        slotValue: row.slotValue ?? null,
        slotValueNumeric: row.slotValueNumeric ?? null,
        slotValueDate: row.slotValueDate ?? null,
        confidence: row.confidence ?? 50,
        evidence: row.evidence ?? null,
        linkedAccountId: row.linkedAccountId ?? null,
        linkedLaneId: row.linkedLaneId ?? null,
      },
    })
    .returning();
  return out;
}

export async function getLatestSlotsForThread(orgId: string, threadId: string): Promise<Map<string, EmailExtractedSlot>> {
  const rows = await db.execute<{
    id: string;
    org_id: string;
    message_id: string;
    thread_id: string | null;
    slot_name: string;
    slot_value: string | null;
    slot_value_numeric: string | null;
    slot_value_date: Date | null;
    confidence: number;
    evidence: string | null;
    linked_account_id: string | null;
    linked_lane_id: string | null;
    created_at: Date;
  }>(sql`
    SELECT DISTINCT ON (slot_name) *
      FROM email_extracted_slots
     WHERE org_id = ${orgId} AND thread_id = ${threadId}
     ORDER BY slot_name, created_at DESC
  `);
  const map = new Map<string, EmailExtractedSlot>();
  for (const r of rows.rows) {
    map.set(r.slot_name, {
      id: r.id,
      orgId: r.org_id,
      messageId: r.message_id,
      threadId: r.thread_id,
      slotName: r.slot_name,
      slotValue: r.slot_value,
      slotValueNumeric: r.slot_value_numeric,
      slotValueDate: r.slot_value_date,
      confidence: r.confidence,
      evidence: r.evidence,
      linkedAccountId: r.linked_account_id,
      linkedLaneId: r.linked_lane_id,
      createdAt: r.created_at,
    });
  }
  return map;
}

// ─── Forward calendar ────────────────────────────────────────────────────────

export async function upsertForwardCalendarEvent(row: InsertForwardCalendarEvent): Promise<ForwardCalendarEvent> {
  const [out] = await db
    .insert(forwardCalendarEvents)
    .values(row)
    .onConflictDoUpdate({
      target: [forwardCalendarEvents.messageId, forwardCalendarEvents.eventType],
      set: {
        eventDate: row.eventDate,
        description: row.description ?? null,
        confidence: row.confidence ?? 50,
        status: row.status ?? "pending",
        linkedAccountId: row.linkedAccountId ?? null,
        linkedLaneId: row.linkedLaneId ?? null,
        nbaCardId: row.nbaCardId ?? null,
      },
    })
    .returning();
  return out;
}

export async function getUpcomingForwardCalendarEvents(orgId: string, withinDays: number): Promise<ForwardCalendarEvent[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + withinDays * 86400 * 1000);
  return db
    .select()
    .from(forwardCalendarEvents)
    .where(and(
      eq(forwardCalendarEvents.orgId, orgId),
      eq(forwardCalendarEvents.status, "pending"),
      gte(forwardCalendarEvents.eventDate, now),
      lte(forwardCalendarEvents.eventDate, horizon),
    ))
    .orderBy(forwardCalendarEvents.eventDate);
}

export async function markForwardCalendarEventStatus(id: string, status: string, nbaCardId?: string | null): Promise<void> {
  await db
    .update(forwardCalendarEvents)
    .set({ status, nbaCardId: nbaCardId ?? null })
    .where(eq(forwardCalendarEvents.id, id));
}

// ─── Promises ────────────────────────────────────────────────────────────────

export async function upsertPromise(row: InsertEmailPromise): Promise<EmailPromise> {
  const [out] = await db
    .insert(emailPromises)
    .values(row)
    .onConflictDoUpdate({
      target: [emailPromises.messageId, emailPromises.promiseText],
      set: {
        promiseDueAt: row.promiseDueAt ?? null,
        confidence: row.confidence ?? 50,
        repUserId: row.repUserId ?? null,
        linkedAccountId: row.linkedAccountId ?? null,
        linkedContactId: row.linkedContactId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return out;
}

export async function getOpenPromisesForThread(orgId: string, threadId: string): Promise<EmailPromise[]> {
  return db
    .select()
    .from(emailPromises)
    .where(and(
      eq(emailPromises.orgId, orgId),
      eq(emailPromises.threadId, threadId),
      eq(emailPromises.status, "open"),
    ));
}

export async function markPromiseResolved(id: string, status: "kept" | "broken" | "cancelled", resolvedByMessageId?: string | null): Promise<void> {
  await db
    .update(emailPromises)
    .set({
      status,
      resolvedAt: new Date(),
      resolvedByMessageId: resolvedByMessageId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(emailPromises.id, id));
}

export async function listPromisesForRep(orgId: string, repUserId: string, status?: string, limit = 100): Promise<EmailPromise[]> {
  return db
    .select()
    .from(emailPromises)
    .where(and(
      eq(emailPromises.orgId, orgId),
      eq(emailPromises.repUserId, repUserId),
      ...(status ? [eq(emailPromises.status, status)] : []),
    ))
    .orderBy(desc(emailPromises.createdAt))
    .limit(limit);
}

export async function listPromisesForAccount(orgId: string, accountId: string, limit = 100): Promise<EmailPromise[]> {
  return db
    .select()
    .from(emailPromises)
    .where(and(
      eq(emailPromises.orgId, orgId),
      eq(emailPromises.linkedAccountId, accountId),
    ))
    .orderBy(desc(emailPromises.createdAt))
    .limit(limit);
}

export async function listOverdueOpenPromises(orgId: string): Promise<EmailPromise[]> {
  return db
    .select()
    .from(emailPromises)
    .where(and(
      eq(emailPromises.orgId, orgId),
      eq(emailPromises.status, "open"),
      lte(emailPromises.promiseDueAt, new Date()),
    ));
}

// ─── Questions ───────────────────────────────────────────────────────────────

export async function upsertQuestion(row: InsertEmailQuestion): Promise<EmailQuestion> {
  const [out] = await db
    .insert(emailQuestions)
    .values(row)
    .onConflictDoUpdate({
      target: [emailQuestions.messageId, emailQuestions.questionText],
      set: {
        confidence: row.confidence ?? 50,
        askedByEmail: row.askedByEmail ?? null,
        linkedAccountId: row.linkedAccountId ?? null,
        linkedContactId: row.linkedContactId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return out;
}

export async function getOpenQuestionsForThread(orgId: string, threadId: string): Promise<EmailQuestion[]> {
  return db
    .select()
    .from(emailQuestions)
    .where(and(
      eq(emailQuestions.orgId, orgId),
      eq(emailQuestions.threadId, threadId),
      eq(emailQuestions.status, "unanswered"),
    ));
}

export async function markQuestionAnswered(id: string, answeredByMessageId: string, timeToAnswerSec: number | null): Promise<void> {
  await db
    .update(emailQuestions)
    .set({
      status: "answered",
      answeredAt: new Date(),
      answeredByMessageId,
      timeToAnswerSec,
      updatedAt: new Date(),
    })
    .where(eq(emailQuestions.id, id));
}

export async function listOpenQuestionsForAccount(orgId: string, accountId: string, limit = 100): Promise<EmailQuestion[]> {
  return db
    .select()
    .from(emailQuestions)
    .where(and(
      eq(emailQuestions.orgId, orgId),
      eq(emailQuestions.linkedAccountId, accountId),
      eq(emailQuestions.status, "unanswered"),
    ))
    .orderBy(desc(emailQuestions.createdAt))
    .limit(limit);
}

type QuestionRowSql = {
  id: string;
  org_id: string;
  message_id: string;
  thread_id: string | null;
  question_text: string;
  asked_by_email: string | null;
  linked_account_id: string | null;
  linked_contact_id: string | null;
  status: string;
  confidence: number;
  answered_by_message_id: string | null;
  answered_at: Date | string | null;
  time_to_answer_sec: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

export async function listOpenQuestionsForRep(orgId: string, repAddresses: string[], limit = 50): Promise<EmailQuestion[]> {
  if (repAddresses.length === 0) return [];
  // Open questions on threads where the rep is a participant. Both eq and ep
  // are scoped to the same org_id so cross-org thread-id collisions can never
  // bleed across tenants.
  const rows = await db.execute<QuestionRowSql>(sql`
    SELECT eq.*
      FROM email_questions eq
     WHERE eq.org_id = ${orgId}
       AND eq.status = 'unanswered'
       AND EXISTS (
         SELECT 1 FROM email_participants ep
          WHERE ep.org_id = eq.org_id
            AND ep.thread_id = eq.thread_id
            AND lower(ep.email_address) = ANY(${repAddresses.map(a => a.toLowerCase())})
       )
     ORDER BY eq.created_at DESC
     LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    messageId: r.message_id,
    threadId: r.thread_id,
    questionText: r.question_text,
    askedByEmail: r.asked_by_email,
    linkedAccountId: r.linked_account_id,
    linkedContactId: r.linked_contact_id,
    status: r.status,
    confidence: r.confidence,
    answeredByMessageId: r.answered_by_message_id,
    answeredAt: r.answered_at ? new Date(r.answered_at) : null,
    timeToAnswerSec: r.time_to_answer_sec,
    createdAt: r.created_at ? new Date(r.created_at) : new Date(),
    updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
  }));
}

// ─── Outbound quality scores ─────────────────────────────────────────────────

export async function upsertOutboundQualityScore(row: InsertEmailOutboundQualityScore): Promise<EmailOutboundQualityScore> {
  const [out] = await db
    .insert(emailOutboundQualityScores)
    .values(row)
    .onConflictDoUpdate({
      target: [emailOutboundQualityScores.messageId],
      set: {
        clarityScore: row.clarityScore ?? 0,
        toneScore: row.toneScore ?? 0,
        valueAddScore: row.valueAddScore ?? 0,
        objectionHandlingScore: row.objectionHandlingScore ?? 0,
        overallScore: row.overallScore ?? 0,
        features: row.features ?? null,
        graderVersion: row.graderVersion ?? "heuristic_v1",
      },
    })
    .returning();
  return out;
}

export async function listQualityScoresForRep(orgId: string, repUserId: string, sinceDays: number): Promise<EmailOutboundQualityScore[]> {
  const since = new Date(Date.now() - sinceDays * 86400 * 1000);
  return db
    .select()
    .from(emailOutboundQualityScores)
    .where(and(
      eq(emailOutboundQualityScores.orgId, orgId),
      eq(emailOutboundQualityScores.repUserId, repUserId),
      gte(emailOutboundQualityScores.createdAt, since),
    ))
    .orderBy(desc(emailOutboundQualityScores.createdAt));
}

export async function listQualityScoresForAccount(orgId: string, accountId: string, sinceDays: number): Promise<EmailOutboundQualityScore[]> {
  const since = new Date(Date.now() - sinceDays * 86400 * 1000);
  return db
    .select()
    .from(emailOutboundQualityScores)
    .where(and(
      eq(emailOutboundQualityScores.orgId, orgId),
      eq(emailOutboundQualityScores.linkedAccountId, accountId),
      gte(emailOutboundQualityScores.createdAt, since),
    ))
    .orderBy(desc(emailOutboundQualityScores.createdAt));
}

// ─── Sentiment writeback ─────────────────────────────────────────────────────

export async function upsertContactSentiment(orgId: string, contactId: string, companyId: string, score: number, trend: string, signals: Record<string, unknown>): Promise<ContactSentiment> {
  const insert: InsertContactSentiment = {
    orgId,
    contactId,
    companyId,
    sentimentScore: Math.round(score),
    sentimentTrend: trend,
    signals,
    analysisDate: new Date(),
  };
  // upsert by (orgId, contactId): we don't have a unique index there today, so
  // we delete-and-insert atomically. Existing schema has no uniqueness; this
  // keeps the row count bounded at 1 per (org, contact).
  return db.transaction(async (tx) => {
    await tx
      .delete(contactSentimentTracking)
      .where(and(
        eq(contactSentimentTracking.orgId, orgId),
        eq(contactSentimentTracking.contactId, contactId),
      ));
    const [row] = await tx.insert(contactSentimentTracking).values(insert).returning();
    return row;
  });
}

export async function getContactSentiment(orgId: string, contactId: string): Promise<ContactSentiment | undefined> {
  const rows = await db
    .select()
    .from(contactSentimentTracking)
    .where(and(
      eq(contactSentimentTracking.orgId, orgId),
      eq(contactSentimentTracking.contactId, contactId),
    ))
    .orderBy(desc(contactSentimentTracking.analysisDate))
    .limit(1);
  return rows[0];
}

export async function listSentimentForCompany(orgId: string, companyId: string): Promise<ContactSentiment[]> {
  return db
    .select()
    .from(contactSentimentTracking)
    .where(and(
      eq(contactSentimentTracking.orgId, orgId),
      eq(contactSentimentTracking.companyId, companyId),
    ))
    .orderBy(desc(contactSentimentTracking.analysisDate));
}

// ─── Email message helpers used by detectors ─────────────────────────────────

export async function getMessage(messageId: string) {
  const rows = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId)).limit(1);
  return rows[0];
}

export async function getMessagesForThreadAfter(orgId: string, threadId: string, after: Date) {
  return db
    .select()
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      eq(emailMessages.threadId, threadId),
      gte(emailMessages.createdAt, after),
    ))
    .orderBy(emailMessages.createdAt);
}

/**
 * Bulk lookup of provider_sent_at (falling back to created_at) for a set of
 * message IDs scoped to the given org. Used by the question reconciler so
 * `time_to_answer_sec` can be computed without the caller pre-loading a
 * thread message map.
 */
export async function getProviderSentAtForMessages(
  orgId: string,
  messageIds: string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      id: emailMessages.id,
      providerSentAt: emailMessages.providerSentAt,
      createdAt: emailMessages.createdAt,
    })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.orgId, orgId),
      inArray(emailMessages.id, messageIds),
    ));
  for (const r of rows) {
    const ts = r.providerSentAt ?? r.createdAt;
    if (ts) out.set(r.id, ts);
  }
  return out;
}
