/**
 * Email Intelligence v1.5 — Tier 1.2 participants exploder (Task #943).
 *
 * Parses the message header strings into typed participant rows and writes
 * them to `email_participants`. Idempotent on (message_id, email_address, role).
 *
 * Stakeholder graph helpers classify each address by recency.
 */

import type { EmailMessage, InsertEmailParticipant } from "@shared/schema";
import { db } from "../../storage";
import { emailMessages } from "@shared/schema";
import { sql, eq, and, isNotNull } from "drizzle-orm";
import { insertParticipants, getStakeholderRowsForCompany } from "./emailFactsStorage";

export const ACTIVE_DAYS = 30;
export const SILENT_DAYS = 90;

const ADDR_RE = /(?:"?([^"<]+)"?\s*)?<?([\w.+\-']+@[\w.\-]+\.[a-z]{2,})>?/gi;

export interface ParsedAddress {
  emailAddress: string;
  displayName: string | null;
}

export function parseAddressList(raw: string | null | undefined): ParsedAddress[] {
  if (!raw) return [];
  const out: ParsedAddress[] = [];
  const seen = new Set<string>();
  // Reset regex state across calls.
  const re = new RegExp(ADDR_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const email = m[2].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const name = m[1] ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
    out.push({ emailAddress: email, displayName: name && name.length > 0 ? name : null });
  }
  return out;
}

export interface InternalDomainResolver {
  isInternalAddress(email: string): boolean;
}

/**
 * Default — internal if the address ends in any of the configured org domains
 * OR matches a `valuetruck.com` style pattern. Tests inject a stub.
 */
export const defaultInternalResolver: InternalDomainResolver = {
  isInternalAddress(email: string): boolean {
    const lc = email.toLowerCase();
    return /@valuetruck\.com$/.test(lc) || /@freight-?dna\.com$/.test(lc);
  },
};

/**
 * Forwarded-thread "From:" header inside the body. Outlook / Gmail emit
 *   From: "Jane Doe" <jane@acme.com>
 * on the line that precedes the quoted history when a user clicks Forward.
 */
const FORWARD_HEADER_RE = /(?:^|\n)\s*From:\s*([^\n<]*<[^>\n]+>|[^\s<>"][^\n]*?@[^\s<>"]+)/i;
const FORWARDED_SUBJECT_RE = /^\s*(fwd?|fw|tr|wg|rv|enc|i)\s*:/i;

function parseForwardedOriginalSender(subject: string | null | undefined, body: string | null | undefined): ParsedAddress | null {
  if (!subject || !body) return null;
  if (!FORWARDED_SUBJECT_RE.test(subject)) return null;
  const m = body.match(FORWARD_HEADER_RE);
  if (!m) return null;
  const parsed = parseAddressList(m[1]);
  return parsed[0] ?? null;
}

export interface ExplodeParticipantsOpts {
  internalResolver?: InternalDomainResolver;
  /** Raw Bcc header value (if surfaced by the provider). */
  bccEmail?: string | null;
  /** Raw Reply-To header value (if surfaced by the provider). */
  replyTo?: string | null;
}

/**
 * Pure exploder — given a message + entity-resolved hints, produce participant rows.
 * Used by the live ingestion path AND by tests.
 *
 * Roles emitted:
 *   - `from` / `to` / `cc` from the canonical message columns
 *   - `bcc` / `reply_to` from explicit header overrides (when the provider
 *     surfaces them — Microsoft Graph exposes them on `message.bccRecipients`
 *     / `replyTo` even though we don't persist them on the row today)
 *   - `forwarded_original_sender` parsed out of the body when the subject is
 *     a forward (FW: / Fwd:) — preserves the actual decision-maker email
 *     even when the rep is the apparent `from` on the row
 */
export function explodeMessageToParticipants(
  msg: Pick<EmailMessage, "id" | "orgId" | "threadId" | "fromEmail" | "toEmail" | "ccEmail" | "linkedAccountId" | "providerSentAt" | "createdAt"> & { subject?: string | null; body?: string | null },
  opts?: ExplodeParticipantsOpts,
): InsertEmailParticipant[] {
  const resolver = opts?.internalResolver ?? defaultInternalResolver;
  const messageSentAt = msg.providerSentAt ?? msg.createdAt ?? null;

  const rows: InsertEmailParticipant[] = [];
  const seenByRole = new Set<string>(); // dedupe within a single explosion call.
  const sources: Array<{ raw: string | null | undefined; role: "from" | "to" | "cc" | "bcc" | "reply_to" | "forwarded_original_sender" }> = [
    { raw: msg.fromEmail, role: "from" },
    { raw: msg.toEmail, role: "to" },
    { raw: msg.ccEmail, role: "cc" },
    { raw: opts?.bccEmail ?? null, role: "bcc" },
    { raw: opts?.replyTo ?? null, role: "reply_to" },
  ];

  for (const src of sources) {
    for (const addr of parseAddressList(src.raw)) {
      const key = `${addr.emailAddress}|${src.role}`;
      if (seenByRole.has(key)) continue;
      seenByRole.add(key);
      rows.push({
        orgId: msg.orgId,
        messageId: msg.id,
        threadId: msg.threadId ?? null,
        emailAddress: addr.emailAddress,
        displayName: addr.displayName,
        role: src.role,
        isInternal: resolver.isInternalAddress(addr.emailAddress),
        contactId: null,
        companyId: msg.linkedAccountId ?? null,
        messageSentAt,
      });
    }
  }

  // Forwarded original sender — extracted from the body header.
  const forwarded = parseForwardedOriginalSender(msg.subject ?? null, msg.body ?? null);
  if (forwarded) {
    const key = `${forwarded.emailAddress}|forwarded_original_sender`;
    if (!seenByRole.has(key)) {
      seenByRole.add(key);
      rows.push({
        orgId: msg.orgId,
        messageId: msg.id,
        threadId: msg.threadId ?? null,
        emailAddress: forwarded.emailAddress,
        displayName: forwarded.displayName,
        role: "forwarded_original_sender",
        isInternal: resolver.isInternalAddress(forwarded.emailAddress),
        contactId: null,
        companyId: msg.linkedAccountId ?? null,
        messageSentAt,
      });
    }
  }
  return rows;
}

/**
 * Live ingestion entry — explode + persist. Idempotent.
 */
export async function recordParticipantsForMessage(
  msg: EmailMessage,
  opts?: ExplodeParticipantsOpts,
): Promise<number> {
  const rows = explodeMessageToParticipants(msg, opts);
  if (rows.length === 0) return 0;
  const inserted = await insertParticipants(rows);
  return inserted.length;
}

/**
 * Backfill helper. Re-derives participant rows from existing `email_messages`
 * for an org. Safe to re-run; the unique index keeps it idempotent.
 *
 * Returns the number of messages processed.
 */
export async function backfillEmailParticipants(orgId: string, sinceDays = 30, batchSize = 500): Promise<{ processed: number }> {
  const since = new Date(Date.now() - sinceDays * 86400 * 1000);
  let processed = 0;
  let lastCreatedAt: Date | null = null;

  while (true) {
    const where: ReturnType<typeof and> = lastCreatedAt
      ? and(eq(emailMessages.orgId, orgId), sql`${emailMessages.createdAt} > ${lastCreatedAt}`)
      : and(eq(emailMessages.orgId, orgId), sql`${emailMessages.createdAt} >= ${since}`);
    const batch: EmailMessage[] = await db
      .select()
      .from(emailMessages)
      .where(where)
      .orderBy(emailMessages.createdAt)
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const msg of batch) {
      const rows = explodeMessageToParticipants(msg);
      if (rows.length > 0) await insertParticipants(rows);
      processed += 1;
    }
    lastCreatedAt = batch[batch.length - 1].createdAt ?? null;
    if (batch.length < batchSize) break;
  }
  return { processed };
}

// ─── Stakeholder graph ───────────────────────────────────────────────────────

export type StakeholderActivity = "active" | "silent" | "churned";

export interface StakeholderRow {
  emailAddress: string;
  displayName: string | null;
  contactId: string | null;
  messageCount: number;
  lastSeenAt: Date | null;
  activity: StakeholderActivity;
}

export function classifyActivity(lastSeenAt: Date | null, now: Date = new Date()): StakeholderActivity {
  if (!lastSeenAt) return "churned";
  const ageDays = (now.getTime() - lastSeenAt.getTime()) / 86400000;
  if (ageDays <= ACTIVE_DAYS) return "active";
  if (ageDays <= SILENT_DAYS) return "silent";
  return "churned";
}

export async function getStakeholderGraphForAccount(orgId: string, companyId: string, now: Date = new Date()): Promise<StakeholderRow[]> {
  const rows = await getStakeholderRowsForCompany(orgId, companyId);
  return rows.map((r) => ({
    emailAddress: r.emailAddress,
    displayName: r.displayName,
    contactId: r.contactId,
    messageCount: r.messageCount,
    lastSeenAt: r.lastSeenAt,
    activity: classifyActivity(r.lastSeenAt, now),
  }));
}
