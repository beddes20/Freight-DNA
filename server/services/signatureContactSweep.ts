/**
 * Signature Contact Sweep — Task #1055 (Email→Exec 4)
 *
 * Plug-in for the single inbound-mail ingest path. Given a freshly-persisted
 * `email_messages` row that's already linked to a known org+company, this
 * sweep:
 *
 *   1. Parses the body's signature block deterministically
 *      (`signatureContactParser.parseSignatureBlock`).
 *   2. Looks up the sender's email under the SAME company (org-scoped via
 *      the company itself — `getContactByEmailAndCompany` keys on
 *      `companies.id`, never crossing tenants).
 *   3. If the contact exists: enriches null fields only — never overwrites
 *      filled fields (idempotent, preserves rep edits).
 *   4. If the contact doesn't exist AND the parser is high-confidence: creates
 *      a fresh `contacts` row scoped to the company (+ `sourceType =
 *      "email_signature"`).
 *   5. If the parser is below the high-confidence floor: enqueues into the
 *      existing `account_contact_suggestions` queue via the canonical
 *      `accountContactCaptureService.detectAndSuggest` rather than writing
 *      directly. Reuses the established enrichment surface — no parallel
 *      pipeline.
 *
 * Cross-org safety: the only company id this helper touches is the one
 * supplied by the caller (`accountMatch.companyId` from
 * `processUserMailboxEmail`), which was resolved through
 * `matchInboundSenderToAccount` / `matchAccountByEmailDomain` — both
 * org-scoped. We never look companies up by name. The `getContactByEmailAndCompany`
 * + `createContact` pair is keyed on `companyId`, so the FK to `companies`
 * forces the same org by construction.
 *
 * Best-effort: every external call is wrapped — sweep failures must NEVER
 * break the ingest pipeline. The caller (`processUserMailboxEmail`) treats
 * a thrown error as "no sweep ran" and continues.
 *
 * Stability contract: this helper writes to upstream contact storage; it
 * does NOT touch any of the protected functions in
 * `server/services/customerQuotes.ts` (CQ-1..CQ-6). The downstream
 * customer-quote read-only derivation now sees stronger linkage because the
 * upstream contact + ownerRep chain is filled in correctly.
 */

import type { EmailMessage } from "@shared/schema";
import type { IStorage } from "../storage";
import { parseSignatureBlock, type ParsedSignature } from "./signatureContactParser";
import { detectAndSuggest } from "../accountContactCaptureService";
import { normalizeEmailAddress } from "./carrierContactMatchService";

export type SweepAction =
  | "skipped_no_company"
  | "skipped_outbound"
  | "skipped_no_sender"
  | "skipped_no_signal"
  | "enriched"
  | "created"
  | "suggested"
  | "noop_existing_complete"
  | "error";

export interface SweepResult {
  action: SweepAction;
  contactId?: string;
  parsed?: ParsedSignature;
  error?: string;
}

export interface SweepOptions {
  /** Override the sweep's known-company scope. When omitted, the sweep
   *  reads `message.linkedAccountId` (which the ingest path has already
   *  normalised to a company id under the message's org). */
  companyId?: string | null;
}

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [signatureContactSweep] ${msg}`);
}

export async function sweepSignatureContactForInbound(
  message: EmailMessage,
  storage: IStorage,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  if (message.direction !== "inbound") {
    return { action: "skipped_outbound" };
  }
  const companyId = opts.companyId ?? message.linkedAccountId ?? null;
  if (!companyId) {
    // Per task spec: senders on UNKNOWN accounts must NOT trigger an
    // upsert. We never invent a company here.
    return { action: "skipped_no_company" };
  }
  const senderEmail = normalizeEmailAddress(message.fromEmail ?? "");
  if (!senderEmail) {
    return { action: "skipped_no_sender" };
  }

  let parsed: ParsedSignature;
  try {
    parsed = parseSignatureBlock(message.body, senderEmail, message.subject);
  } catch (err) {
    log(`parse error sender=${senderEmail}: ${err instanceof Error ? err.message : String(err)}`);
    return { action: "error", error: err instanceof Error ? err.message : String(err) };
  }

  // Cross-tenant guard: confirm the company is actually in this message's
  // org before touching contacts. Defence-in-depth — the FK on
  // `contacts.companyId` would already prevent a cross-org write, but
  // refusing to look up here makes the failure mode obvious in logs.
  let company: Awaited<ReturnType<IStorage["getCompany"]>>;
  try {
    company = await storage.getCompany(companyId);
  } catch (err) {
    log(`getCompany failed company=${companyId}: ${err instanceof Error ? err.message : String(err)}`);
    return { action: "error", parsed, error: err instanceof Error ? err.message : String(err) };
  }
  if (!company) return { action: "skipped_no_company", parsed };
  if ("organizationId" in company && company.organizationId && company.organizationId !== message.orgId) {
    log(`cross-org refusal: company=${companyId} belongs to ${company.organizationId} but message.orgId=${message.orgId}`);
    return { action: "skipped_no_company", parsed };
  }

  // Existing contact → enrich null fields only.
  let existing: Awaited<ReturnType<IStorage["getContactByEmailAndCompany"]>>;
  try {
    existing = await storage.getContactByEmailAndCompany(senderEmail, companyId);
  } catch (err) {
    log(`getContactByEmailAndCompany failed: ${err instanceof Error ? err.message : String(err)}`);
    return { action: "error", parsed, error: err instanceof Error ? err.message : String(err) };
  }

  if (existing) {
    const patch: Record<string, string> = {};
    // Only fill nulls — never overwrite. Preserves rep edits and explicit
    // CRM data; signature data is a fallback, not a source of truth.
    if (!existing.title && parsed.title) patch.title = parsed.title;
    if (!existing.phone && parsed.phone) patch.phone = parsed.phone;
    if (!existing.mobile && parsed.mobile) patch.mobile = parsed.mobile;
    // Name: only update when existing name is the email/local-part fallback
    // (signature names are higher-fidelity than email-derived placeholders).
    if (parsed.name) {
      const nameLower = (existing.name ?? "").toLowerCase();
      const localPart = senderEmail.split("@")[0].toLowerCase();
      if (
        !existing.name ||
        nameLower === senderEmail ||
        nameLower === localPart ||
        nameLower.replace(/[._-]+/g, "") === localPart.replace(/[._-]+/g, "")
      ) {
        patch.name = parsed.name;
      }
    }
    if (Object.keys(patch).length === 0) {
      return { action: "noop_existing_complete", contactId: existing.id, parsed };
    }
    try {
      await storage.updateContact(existing.id, {
        ...existing,
        ...patch,
      });
      log(`enriched contact=${existing.id} company=${companyId} fields=${Object.keys(patch).join(",")}`);
      return { action: "enriched", contactId: existing.id, parsed };
    } catch (err) {
      log(`updateContact failed contact=${existing.id}: ${err instanceof Error ? err.message : String(err)}`);
      return { action: "error", contactId: existing.id, parsed, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // No existing contact. High-confidence → create directly. Lower
  // confidence → fall back to the existing suggestion queue so a human
  // can confirm before a thin contact pollutes the CRM.
  if (parsed.confidence === "high" && parsed.name) {
    try {
      const created = await storage.createContact({
        companyId,
        name: parsed.name,
        title: parsed.title ?? null,
        email: senderEmail,
        phone: parsed.phone ?? null,
        mobile: parsed.mobile ?? null,
        sourceType: "email_signature",
        status: "active",
        isPrimary: false,
      });
      log(`created contact=${created.id} company=${companyId} email=${senderEmail}`);
      return { action: "created", contactId: created.id, parsed };
    } catch (err) {
      log(`createContact failed company=${companyId} email=${senderEmail}: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to the suggestion path on create failure so the rep
      // still sees the inbound-sender hint instead of losing it entirely.
    }
  }

  // Soft path — enqueue via the canonical suggestion service.
  try {
    const result = await detectAndSuggest(message, storage);
    if (result.upserted > 0) {
      return { action: "suggested", parsed };
    }
    return { action: "skipped_no_signal", parsed };
  } catch (err) {
    log(`detectAndSuggest failed: ${err instanceof Error ? err.message : String(err)}`);
    return { action: "error", parsed, error: err instanceof Error ? err.message : String(err) };
  }
}
