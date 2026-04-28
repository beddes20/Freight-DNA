/**
 * Task #816 — shared customer-only chokepoint for the Quote Opportunities
 * surface. The Quote Opportunities table, portlets, drawer, and stale
 * follow-up rail must NEVER expose a row that resolves to a carrier or
 * unknown party, even when the underlying `quote_customers.partyType` is
 * still stored as "customer" (a misclassification we re-detect at read
 * time using the same signals the classifier uses).
 *
 * A `quote_customers.id` lands in the returned set — and is therefore
 * hidden from every customer-only consumer — when ANY of these is true:
 *   1. `partyType !== "customer"`.
 *   2. The display name matches a carrier-suffix token (Freight, Logistics,
 *      Trucking, Express, …).
 *   3. The display name (case-insensitive) matches an entry in the org's
 *      `quote_carriers` catalog.
 *   4. ANY known sender-domain mapped to this customer is also present in
 *      the org's carriers-catalog email-domain set.
 *
 * Margin / carrier-cost data is preserved in the database (still used by
 * other surfaces such as LWQ); only the *visibility* on this page is
 * stripped. Returns an empty set when the org has no signals so callers
 * can pass it unconditionally to `applyFilters`.
 *
 * Lives in its own module so `customerQuotes.ts` and the satellite
 * services (stale follow-ups, etc.) can share one implementation without
 * a circular dependency.
 */

import { eq } from "drizzle-orm";
import { db } from "../storage";
import {
  quoteCarriers, quoteSenderMappings,
  carriers as carriersCatalog,
  type QuoteCustomer,
} from "@shared/schema";
import { CARRIER_TOKEN_RE } from "./customerNameResolver";

/**
 * Internal — load every distinct email domain present on the org's
 * carriers catalog (primary + backup). Lowercased; empty when the org
 * has nothing on file. Local copy of the helper that lives in
 * `customerQuotes.ts` so the chokepoint module has no inbound
 * dependency on the very service it's used by.
 */
async function loadCarrierDomainsForOrg(orgId: string): Promise<Set<string>> {
  const rows = await db.select({
    primary: carriersCatalog.primaryEmail,
    backup: carriersCatalog.backupEmail,
  }).from(carriersCatalog).where(eq(carriersCatalog.orgId, orgId));
  const domains = new Set<string>();
  for (const r of rows) {
    for (const email of [r.primary, r.backup]) {
      if (!email) continue;
      const at = email.lastIndexOf("@");
      if (at < 0) continue;
      const dom = email.slice(at + 1).trim().toLowerCase();
      if (dom) domains.add(dom);
    }
  }
  return domains;
}

export async function loadNonCustomerCustomerIds(
  orgId: string,
  customerMap: Map<string, QuoteCustomer>,
): Promise<Set<string>> {
  const [carriers, carrierDomains, senderMappingRows] = await Promise.all([
    db.select({ name: quoteCarriers.name }).from(quoteCarriers)
      .where(eq(quoteCarriers.organizationId, orgId)),
    loadCarrierDomainsForOrg(orgId),
    db.select({
      customerId: quoteSenderMappings.customerId,
      senderDomain: quoteSenderMappings.senderDomain,
    }).from(quoteSenderMappings)
      .where(eq(quoteSenderMappings.organizationId, orgId)),
  ]);

  const knownCarrierNames = new Set<string>(
    carriers.map((c: { name: string | null }) => (c.name ?? "").trim().toLowerCase()).filter(Boolean),
  );

  const customerSenderDomains = new Map<string, Set<string>>();
  for (const row of senderMappingRows) {
    const dom = (row.senderDomain ?? "").trim().toLowerCase();
    if (!dom || !row.customerId) continue;
    let bucket = customerSenderDomains.get(row.customerId);
    if (!bucket) {
      bucket = new Set<string>();
      customerSenderDomains.set(row.customerId, bucket);
    }
    bucket.add(dom);
  }

  const out = new Set<string>();
  customerMap.forEach((c, id) => {
    if (c.partyType !== "customer") { out.add(id); return; }
    const name = (c.name ?? "").trim();
    if (!name) { out.add(id); return; }
    if (CARRIER_TOKEN_RE.test(name)) { out.add(id); return; }
    if (knownCarrierNames.has(name.toLowerCase())) { out.add(id); return; }
    const doms = customerSenderDomains.get(id);
    if (doms && carrierDomains.size > 0) {
      for (const d of doms) {
        if (carrierDomains.has(d)) { out.add(id); return; }
      }
    }
  });
  return out;
}
