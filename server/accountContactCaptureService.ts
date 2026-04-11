/**
 * Account Contact Capture Service (Task #201)
 *
 * Detects new people in account-linked email threads and surfaces lightweight
 * contact suggestions for rep review. Never auto-creates contacts.
 *
 * Key behaviors:
 *  - Extracts participants from from/to/cc fields of a message
 *  - Skips addresses already known as contacts on the account
 *  - Scores each new address using heuristics (domain match, sender vs CC,
 *    generic inbox patterns, signature extraction)
 *  - Upserts into account_contact_suggestions (dedup by account + email)
 *  - Generic/shared inbox prefixes → lower confidence, never primary
 *  - Only acts when the message is already linked to a known account
 */

import type { EmailMessage } from "@shared/schema";
import type { IStorage } from "./storage";

// ─── Generic inbox prefix patterns ─────────────────────────────────────────

export const GENERIC_PREFIXES = new Set([
  "ops",
  "billing",
  "support",
  "ap",
  "ar",
  "accounting",
  "no-reply",
  "noreply",
  "info",
  "admin",
  "contact",
  "hello",
  "help",
  "sales",
  "service",
  "team",
  "office",
  "general",
  "inquiries",
  "enquiries",
  "donotreply",
  "do-not-reply",
  "mail",
  "postmaster",
  "webmaster",
  "customerservice",
  "customer-service",
  "newsletter",
  "notifications",
  "alerts",
  "dispatch",
  "freight",
  "logistics",
  "shipping",
  "receiving",
]);

/** Return true when the local part (before @) looks like a shared inbox. */
export function isGenericInbox(emailAddress: string): boolean {
  const local = emailAddress.split("@")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "") ?? "";
  return GENERIC_PREFIXES.has(local);
}

// ─── Common free / personal email providers to ignore ───────────────────────

const FREE_PROVIDERS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "msn.com",
  "me.com",
  "ymail.com",
  "protonmail.com",
  "proton.me",
]);

function isFreeProvider(domain: string): boolean {
  return FREE_PROVIDERS.has(domain.toLowerCase());
}

// ─── Signature heuristic extraction ──────────────────────────────────────────

interface SignatureHints {
  name: string | null;
  title: string | null;
  phone: string | null;
}

/**
 * Very lightweight heuristic extraction from email body.
 * Looks for the signature block (after --, ___, or end of body) and tries
 * to pull a name / title / phone from the first few lines.
 */
export function extractSignatureHints(
  body: string | null,
  senderEmail: string,
): SignatureHints {
  if (!body) return { name: null, title: null, phone: null };

  // Strip HTML tags first
  const plain = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s{2,}/g, " ");

  // Common signature separators
  const sigBreaks = [
    /\n--\s*\n/,
    /\n_{3,}/,
    /\n-{3,}\n/,
    /\nSent from\b/i,
    /\nGet Outlook\b/i,
    /\nOn .{5,100}wrote:/,
    /\nFrom:\s*\S+@\S+/,
  ];

  let sigBlock = "";
  for (const pattern of sigBreaks) {
    const idx = plain.search(pattern);
    if (idx >= 0) {
      sigBlock = plain.slice(idx);
      break;
    }
  }

  if (!sigBlock) {
    // Fall back to last 5 lines
    const lines = plain.split("\n").filter(l => l.trim().length > 0);
    sigBlock = lines.slice(-5).join("\n");
  }

  const sigLines = sigBlock
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 1 && l.length < 120)
    .slice(0, 10);

  // Phone: look for digit pattern
  const phonePattern = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
  let phone: string | null = null;
  for (const line of sigLines) {
    const m = line.match(phonePattern);
    if (m) { phone = m[0]; break; }
  }

  // Title: lines with | or common title keywords
  const titleKeywords = /\b(director|manager|vp|president|coordinator|analyst|specialist|associate|rep|executive|lead|officer)\b/i;
  let title: string | null = null;
  for (const line of sigLines) {
    if (titleKeywords.test(line) && !line.includes("@")) {
      title = line.slice(0, 80);
      break;
    }
  }

  // Name: first line that doesn't look like an address / phone / email / URL
  const looksLikeName = /^[A-Z][a-z]+(?: [A-Z][a-z]+){1,3}$/;
  const emailDomain = senderEmail.split("@")[1]?.toLowerCase() ?? "";
  let name: string | null = null;
  for (const line of sigLines) {
    if (
      looksLikeName.test(line.trim()) &&
      !line.includes("@") &&
      !line.includes("http") &&
      !phonePattern.test(line) &&
      !line.toLowerCase().includes(emailDomain.split(".")[0])
    ) {
      name = line.trim().slice(0, 80);
      break;
    }
  }

  return { name, title, phone };
}

// ─── Domain-match scoring ─────────────────────────────────────────────────────

function normalizeDomain(raw: string): string {
  return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Compare an email domain against a company's website / name.
 * Returns a bonus confidence score (0 or positive integer).
 */
function domainMatchScore(emailDomain: string, company: { website?: string | null; name: string }): number {
  const emailNorm = emailDomain.toLowerCase();

  // 1. Exact website domain match
  if (company.website) {
    const siteDomain = normalizeDomain(company.website);
    if (siteDomain && siteDomain === emailNorm) return 30;
    // Sub-domain match
    if (siteDomain && (emailNorm.endsWith("." + siteDomain) || siteDomain.endsWith("." + emailNorm))) return 25;
  }

  // 2. Company name → core domain match (e.g. "Acme Corp" → "acme")
  const coreNorm = normalizeName(company.name).slice(0, 10);
  const emailCore = emailNorm.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (coreNorm.length >= 4 && (coreNorm.includes(emailCore) || emailCore.includes(coreNorm.slice(0, 6)))) return 15;

  return 0;
}

// ─── Participant extraction ───────────────────────────────────────────────────

/**
 * Parse a comma- or semicolon-separated email header into individual addresses.
 * Handles "Display Name <addr@example.com>" format.
 */
export function parseEmailAddresses(header: string | null | undefined): string[] {
  if (!header) return [];
  const parts = header.split(/[,;]/);
  const results: string[] = [];
  for (const part of parts) {
    const m = part.match(/<([^>]+@[^>]+)>/);
    if (m) {
      results.push(m[1].trim().toLowerCase());
    } else {
      const plain = part.trim().toLowerCase();
      if (plain.includes("@")) results.push(plain);
    }
  }
  return results;
}

// ─── Core detection function ──────────────────────────────────────────────────

export interface DetectAndSuggestResult {
  upserted: number;
  skipped: number;
}

export async function detectAndSuggest(
  message: EmailMessage,
  storage: IStorage,
): Promise<DetectAndSuggestResult> {
  const accountId = message.linkedAccountId;
  if (!accountId) return { upserted: 0, skipped: 0 };

  // Get company info for domain matching
  let company: Awaited<ReturnType<IStorage["getCompany"]>>;
  try {
    company = await storage.getCompany(accountId);
  } catch (err) {
    console.error(`[accountContactCapture] getCompany failed for ${accountId} (msg ${message.id}):`, err instanceof Error ? err.message : String(err));
    return { upserted: 0, skipped: 0 };
  }
  if (!company) return { upserted: 0, skipped: 0 };

  const orgId = message.orgId;

  // Collect all participants from this message
  const fromAddresses = parseEmailAddresses(message.fromEmail);
  const toAddresses = parseEmailAddresses(message.toEmail);
  const ccAddresses = parseEmailAddresses(message.ccEmail);

  // Build participant set with role flags
  const participantMap = new Map<string, { isFrom: boolean; isCc: boolean }>();
  for (const addr of fromAddresses) {
    if (addr) participantMap.set(addr, { isFrom: true, isCc: false });
  }
  for (const addr of toAddresses) {
    if (!participantMap.has(addr)) participantMap.set(addr, { isFrom: false, isCc: false });
  }
  for (const addr of ccAddresses) {
    if (!participantMap.has(addr)) participantMap.set(addr, { isFrom: false, isCc: true });
  }

  if (participantMap.size === 0) return { upserted: 0, skipped: 0 };

  // Load existing contacts for this account
  let existingContacts: Awaited<ReturnType<IStorage["getContactsByCompany"]>>;
  try {
    existingContacts = await storage.getContactsByCompany(accountId);
  } catch (err) {
    console.error(`[accountContactCapture] getContactsByCompany failed for ${accountId} (msg ${message.id}):`, err instanceof Error ? err.message : String(err));
    return { upserted: 0, skipped: 0 };
  }
  const knownEmails = new Set(
    existingContacts.map(c => c.email?.toLowerCase()).filter(Boolean) as string[],
  );

  let upserted = 0;
  let skipped = 0;

  for (const [emailAddress, { isFrom, isCc }] of participantMap.entries()) {
    // Skip already-known contacts
    if (knownEmails.has(emailAddress)) {
      skipped++;
      continue;
    }

    const domain = emailAddress.split("@")[1] ?? "";

    // Skip free / personal providers — not customer contacts
    if (isFreeProvider(domain)) {
      skipped++;
      continue;
    }

    // Domain affinity guard: ALL participants (sender and CC) must have some
    // connection to the account's domain to be considered a customer contact.
    // This prevents internal rep addresses or third-party addresses from being
    // surfaced as suggestions on account threads.
    const domainBonus = domainMatchScore(domain, company);
    if (domainBonus === 0) {
      skipped++;
      continue;
    }

    // Base confidence
    let confidence = 40;
    if (isFrom) confidence += 20;       // sender is more likely a real person
    if (isCc) confidence -= 5;          // CC slightly lower weight
    confidence += domainBonus;           // domain match bonus

    // Generic inbox penalty
    const isGeneric = isGenericInbox(emailAddress);
    if (isGeneric) confidence = Math.min(confidence, 35);

    confidence = Math.max(0, Math.min(100, confidence));

    // Signature extraction for sender only (body too noisy for CC)
    let sigHints: SignatureHints = { name: null, title: null, phone: null };
    if (isFrom) {
      sigHints = extractSignatureHints(message.body, emailAddress);
    }

    // Determine suggestion source label
    const threadId = message.threadId;
    const suggestionSource = threadId ? "email_thread" : "email_message";

    try {
      await storage.upsertAccountContactSuggestion({
        accountId,
        orgId,
        emailAddress,
        suggestedName: sigHints.name ?? null,
        suggestedTitle: sigHints.title ?? null,
        suggestedPhone: sigHints.phone ?? null,
        suggestionSource,
        confidenceScore: confidence,
        status: "pending",
        threadCount: 1,
        emailMessageId: message.id,
        threadId: threadId ?? null,
        snoozedUntil: null,
        actedByUserId: null,
        notes: null,
      });
      upserted++;
    } catch (err) {
      console.error(`[accountContactCapture] upsert error for ${emailAddress} on account ${accountId}:`, err);
    }
  }

  return { upserted, skipped };
}
