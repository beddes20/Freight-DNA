/**
 * Carrier Contact Match Service (Task #751)
 *
 * Strengthens sender → carrier matching for inbound emails.
 *
 * Capabilities beyond the legacy ilike-on-primary-email matcher:
 *   - Email address normalization (display-name strip, lowercase, plus-addressing)
 *   - Domain fallback: aggregate every email currently on file for any carrier
 *     (carriers.primary_email, carriers.backup_email, carrier_contacts.email),
 *     extract distinct domains, and link unknown senders whose domain matches.
 *   - Free-mail providers (gmail, yahoo, etc) are excluded from domain matching
 *     so two unrelated carriers using gmail.com don't collide.
 *   - Ambiguous ties (one domain → multiple carriers) refuse to link.
 */

import { db } from "../storage";
import { carriers, carrierContacts } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";

// Same list used in graphWebhook for account domain matching — kept local
// here so the carrier path can evolve independently if needed.
export const CARRIER_FREE_PROVIDERS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "aol.com", "live.com", "msn.com", "me.com", "ymail.com",
  "protonmail.com", "proton.me", "comcast.net", "verizon.net", "att.net",
  "cox.net", "sbcglobal.net", "bellsouth.net", "earthlink.net",
]);

/**
 * Normalize a raw email-address string from a webhook payload.
 *
 * Handles:
 *   - "John Smith <john@acme.com>"  → john@acme.com
 *   - "  John@Acme.COM  "           → john@acme.com
 *   - "john+freight@acme.com"        → john@acme.com  (plus-addressing collapsed)
 *   - leading mailto:                → stripped
 */
export function normalizeEmailAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  // Strip "Display Name <addr>" form
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch) s = angleMatch[1].trim();
  // Strip mailto: prefix
  s = s.replace(/^mailto:/i, "");
  // Trim quotes
  s = s.replace(/^['"]+|['"]+$/g, "").trim();
  s = s.toLowerCase();
  // Plus-addressing: john+anything@host → john@host
  const at = s.indexOf("@");
  if (at > 0) {
    const local = s.slice(0, at);
    const host = s.slice(at + 1);
    const plus = local.indexOf("+");
    const cleanLocal = plus >= 0 ? local.slice(0, plus) : local;
    s = `${cleanLocal}@${host}`;
  }
  return s;
}

export function getEmailDomain(raw: string | null | undefined): string {
  const norm = normalizeEmailAddress(raw);
  const at = norm.indexOf("@");
  if (at < 0) return "";
  return norm.slice(at + 1).trim();
}

export interface CarrierDomainMatchResult {
  carrierId: string | null;
  ambiguous: boolean;
  domain: string;
}

/**
 * Match an inbound email's domain against the union of all carrier-side
 * email domains in the org. Returns the carrierId if exactly one carrier
 * uses that domain, or { ambiguous: true } if multiple carriers share it.
 *
 * Free providers (gmail.com etc) are skipped — too noisy for a unique link.
 */
export async function matchCarrierByDomain(
  fromEmail: string,
  orgId: string,
): Promise<CarrierDomainMatchResult> {
  const domain = getEmailDomain(fromEmail);
  if (!domain) return { carrierId: null, ambiguous: false, domain: "" };
  if (CARRIER_FREE_PROVIDERS.has(domain)) {
    return { carrierId: null, ambiguous: false, domain };
  }

  // Aggregate carrier IDs whose primary_email, backup_email, or any
  // carrier_contacts.email shares this domain. We use a single SQL pass
  // so domain matching is one query instead of an N×M scan.
  const rows = await db.execute<{ carrier_id: string }>(sql`
    SELECT DISTINCT carrier_id FROM (
      SELECT id AS carrier_id
        FROM ${carriers}
        WHERE org_id = ${orgId}
          AND (
            lower(split_part(primary_email, '@', 2)) = ${domain}
            OR lower(split_part(backup_email, '@', 2)) = ${domain}
          )
      UNION
      SELECT cc.carrier_id
        FROM ${carrierContacts} cc
        INNER JOIN ${carriers} c ON c.id = cc.carrier_id
        WHERE c.org_id = ${orgId}
          AND cc.is_active = true
          AND lower(split_part(cc.email, '@', 2)) = ${domain}
    ) t
    LIMIT 5
  `);

  // drizzle's db.execute returns { rows } in node-postgres flavor; normalize.
  const rowsAny = rows as unknown as { rows?: Array<{ carrier_id: string }> } | Array<{ carrier_id: string }>;
  const list: Array<{ carrier_id: string }> = Array.isArray(rowsAny)
    ? rowsAny
    : (rowsAny.rows ?? []);
  const carrierIds: string[] = list.map(r => r.carrier_id);

  if (carrierIds.length === 0) {
    return { carrierId: null, ambiguous: false, domain };
  }
  if (carrierIds.length === 1) {
    return { carrierId: carrierIds[0], ambiguous: false, domain };
  }
  return { carrierId: null, ambiguous: true, domain };
}

export type StrongMatchConfidence =
  | "exact"
  | "alternate_contact"
  | "domain_fallback"
  | "ambiguous"
  | "unmatched";

export interface StrongCarrierMatch {
  carrierId: string | null;
  contactId: string | null;
  confidence: StrongMatchConfidence;
  domain: string;
}

/**
 * One-shot strengthened matcher. Tries primary-email exact, then carrier-
 * contact email exact, then domain fallback. Always returns the normalized
 * domain (so callers can log even when unmatched).
 */
export async function matchInboundCarrier(
  rawFromEmail: string,
  orgId: string,
  storage: {
    getCarriersByPrimaryEmail: (email: string, orgId: string) => Promise<{ id: string }[]>;
    getCarrierContactByEmail: (email: string, orgId: string) => Promise<{ id: string; carrierId: string } | undefined>;
  },
): Promise<StrongCarrierMatch> {
  const normalized = normalizeEmailAddress(rawFromEmail);
  const domain = getEmailDomain(normalized);

  if (!normalized) {
    return { carrierId: null, contactId: null, confidence: "unmatched", domain };
  }

  const primary = await storage.getCarriersByPrimaryEmail(normalized, orgId);
  if (primary.length === 1) {
    return { carrierId: primary[0].id, contactId: null, confidence: "exact", domain };
  }
  if (primary.length > 1) {
    return { carrierId: null, contactId: null, confidence: "ambiguous", domain };
  }

  const contact = await storage.getCarrierContactByEmail(normalized, orgId);
  if (contact) {
    return { carrierId: contact.carrierId, contactId: contact.id, confidence: "alternate_contact", domain };
  }

  const dom = await matchCarrierByDomain(normalized, orgId);
  if (dom.carrierId) {
    return { carrierId: dom.carrierId, contactId: null, confidence: "domain_fallback", domain };
  }
  if (dom.ambiguous) {
    return { carrierId: null, contactId: null, confidence: "ambiguous", domain };
  }

  return { carrierId: null, contactId: null, confidence: "unmatched", domain };
}
