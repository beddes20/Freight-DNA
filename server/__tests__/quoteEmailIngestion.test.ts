import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { parseQuoteEmail, decideLostReason, ingestQuoteFromEmail } from "../services/quoteEmailIngestion";
import {
  resolveCustomerName,
  isFreeMailDomain,
  isLegacyFreeMailCustomerName,
  isFreeMailProviderName,
  sanitizeCustomerName,
  nameFromBusinessDomain,
  extractCompanyFromText,
  parseFromHeader,
  UNKNOWN_CUSTOMER_NAME,
  FREE_MAIL_PROVIDERS,
} from "../services/customerNameResolver";
import { backfillFreeMailCustomerNames } from "../services/quoteEmailIngestion";
import { createQuoteCustomer } from "../services/customerQuotes";
import { db } from "../storage";
import {
  emailMessages, quoteOpportunities, quoteCustomers, quoteEvents, quoteReps,
  organizations, users,
} from "@shared/schema";

describe("parseQuoteEmail", () => {
  it("extracts a basic city,ST → city,ST lane", () => {
    const out = parseQuoteEmail({
      subject: "Quote needed",
      body: "Need a rate from Chicago, IL to Atlanta, GA next Tuesday.",
    });
    expect(out).not.toBeNull();
    expect(out!.originCity).toBe("Chicago");
    expect(out!.originState).toBe("IL");
    expect(out!.destCity).toBe("Atlanta");
    expect(out!.destState).toBe("GA");
    expect(out!.equipment).toBe("Dry Van");
  });

  it("detects reefer equipment", () => {
    const out = parseQuoteEmail({
      subject: "Reefer rate",
      body: "Looking for reefer capacity Portland, OR to Los Angeles, CA.",
    });
    expect(out!.equipment).toBe("Reefer");
  });

  it("detects flatbed equipment", () => {
    const out = parseQuoteEmail({
      subject: "",
      body: "Flatbed load Dallas, TX to Newark, NJ — pickup tomorrow.",
    });
    expect(out!.equipment).toBe("Flatbed");
  });

  it("parses a target rate when present", () => {
    const out = parseQuoteEmail({
      subject: "RFQ",
      body: "Memphis, TN to St Louis, MO target $1,850 firm.",
    });
    expect(out!.quotedAmount).toBe(1850);
  });

  it("supports arrow lane format", () => {
    const out = parseQuoteEmail({
      subject: "Spot quote",
      body: "Lane: Houston, TX -> Boston, MA",
    });
    expect(out!.originCity).toBe("Houston");
    expect(out!.destCity).toBe("Boston");
  });

  it("returns null for emails without a recognizable lane", () => {
    expect(parseQuoteEmail({ subject: "Hello", body: "Just checking in." })).toBeNull();
    expect(parseQuoteEmail({ subject: "", body: "" })).toBeNull();
  });

  it("rejects implausible rates", () => {
    const out = parseQuoteEmail({
      subject: "",
      body: "Chicago, IL to Atlanta, GA — invoice #5",
    });
    expect(out!.quotedAmount).toBeNull();
  });
});

describe("decideLostReason (Task #482)", () => {
  it("defaults to lost_incumbent for empty / null language", () => {
    expect(decideLostReason(null).code).toBe("lost_incumbent");
    expect(decideLostReason("").code).toBe("lost_incumbent");
    expect(decideLostReason(undefined).code).toBe("lost_incumbent");
  });

  it("maps 'load is covered' style replies to lost_incumbent", () => {
    expect(decideLostReason("load is covered").code).toBe("lost_incumbent");
    expect(decideLostReason("we're covered, thanks").code).toBe("lost_incumbent");
    expect(decideLostReason("went with another carrier").code).toBe("lost_incumbent");
  });

  it("maps cancellation language to lost_timing", () => {
    expect(decideLostReason("load cancelled").code).toBe("lost_timing");
    expect(decideLostReason("no longer needed").code).toBe("lost_timing");
    expect(decideLostReason("customer pulled the freight").code).toBe("lost_timing");
  });

  it("maps price-driven losses to lost_price", () => {
    expect(decideLostReason("rate is too high").code).toBe("lost_price");
    expect(decideLostReason("found cheaper coverage").code).toBe("lost_price");
  });

  it("maps service / fit losses to lost_service", () => {
    expect(decideLostReason("transit time doesn't fit").code).toBe("lost_service");
    expect(decideLostReason("equipment isn't right").code).toBe("lost_service");
  });

  it("returns a status that matches the reason code", () => {
    for (const phrase of ["load is covered", "load cancelled", "rate is too high", "transit fit issue"]) {
      const r = decideLostReason(phrase);
      expect(r.status).toBe(r.code);
    }
  });
});

describe("resolveCustomerName (Task #578)", () => {
  describe("parseFromHeader", () => {
    it("parses bare email addresses", () => {
      const h = parseFromHeader("ops@acme-logistics.com");
      expect(h?.email).toBe("ops@acme-logistics.com");
      expect(h?.localPart).toBe("ops");
      expect(h?.domain).toBe("acme-logistics.com");
      expect(h?.displayName).toBeNull();
    });

    it("parses Display Name <email> form", () => {
      const h = parseFromHeader('"Jane Doe" <jane@gmail.com>');
      expect(h?.displayName).toBe("Jane Doe");
      expect(h?.email).toBe("jane@gmail.com");
      expect(h?.domain).toBe("gmail.com");
    });

    it("returns null for unparseable input", () => {
      expect(parseFromHeader("")).toBeNull();
      expect(parseFromHeader(null)).toBeNull();
      expect(parseFromHeader(undefined)).toBeNull();
      expect(parseFromHeader("not-an-email")).toBeNull();
      expect(parseFromHeader("trailing@")).toBeNull();
    });
  });

  describe("isFreeMailDomain", () => {
    it("flags every centralized provider", () => {
      for (const d of FREE_MAIL_PROVIDERS) expect(isFreeMailDomain(d)).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isFreeMailDomain("GMAIL.COM")).toBe(true);
      expect(isFreeMailDomain("Yahoo.COM")).toBe(true);
    });

    it("does not flag business domains", () => {
      expect(isFreeMailDomain("acme.com")).toBe(false);
      expect(isFreeMailDomain("northwest-logistics.com")).toBe(false);
      expect(isFreeMailDomain("uzbfreight.com")).toBe(false);
    });

    it("returns false for empty / null", () => {
      expect(isFreeMailDomain(null)).toBe(false);
      expect(isFreeMailDomain(undefined)).toBe(false);
      expect(isFreeMailDomain("")).toBe(false);
    });
  });

  describe("nameFromBusinessDomain", () => {
    it("title-cases simple domains", () => {
      expect(nameFromBusinessDomain("uzbfreight.com")).toBe("Uzbfreight");
      expect(nameFromBusinessDomain("acme.com")).toBe("Acme");
    });

    it("splits hyphenated domains into words", () => {
      expect(nameFromBusinessDomain("northwest-logistics.com")).toBe("Northwest Logistics");
      expect(nameFromBusinessDomain("blue_ridge_freight.com")).toBe("Blue Ridge Freight");
    });

    it("preserves common acronyms", () => {
      expect(nameFromBusinessDomain("acme-llc.com")).toBe("Acme LLC");
      expect(nameFromBusinessDomain("foo-inc.com")).toBe("Foo Inc");
      expect(nameFromBusinessDomain("usa-freight.com")).toBe("USA Freight");
    });

    it("strips ccTLD suffixes", () => {
      expect(nameFromBusinessDomain("abc.co.uk")).toBe("Abc");
      expect(nameFromBusinessDomain("foo-bar.com.au")).toBe("Foo Bar");
    });
  });

  describe("extractCompanyFromText", () => {
    it("pulls a company suffix pattern from a signature", () => {
      const out = extractCompanyFromText(
        "Quote: Atlanta to Dallas",
        "Hi, please quote this lane.\n\nThanks,\nMarcus\nPatriot Haulers LLC\n555-1212",
      );
      expect(out).toBe("Patriot Haulers LLC");
    });

    it("recognizes 'on behalf of X'", () => {
      const out = extractCompanyFromText(
        "Spot rate request",
        "I'm reaching out on behalf of Cascade Logistics for a Portland to Seattle quote.",
      );
      expect(out).toBe("Cascade Logistics");
    });

    it("rejects bare person-name signatures", () => {
      const out = extractCompanyFromText(
        "Quick rate",
        "Need a rate Memphis to Chicago.\n\nThanks,\nSarah Williams\nsarah@gmail.com",
      );
      expect(out).toBeNull();
    });

    it("returns null when nothing matches", () => {
      expect(extractCompanyFromText("Hello", "Hi, just checking in.")).toBeNull();
      expect(extractCompanyFromText("", "")).toBeNull();
      expect(extractCompanyFromText(null, null)).toBeNull();
    });

    it("strips HTML before scanning", () => {
      const out = extractCompanyFromText(
        "Quote",
        "<div>Sent on behalf of <b>Heartland Express Inc</b></div>",
      );
      expect(out).toBe("Heartland Express Inc");
    });
  });

  describe("resolveCustomerName", () => {
    it("uses a business-domain root for non-free-mail senders", () => {
      const r = resolveCustomerName({ fromEmail: "ops@uzbfreight.com" });
      expect(r.name).toBe("Uzbfreight");
      expect(r.confidence).toBe("high");
    });

    it("title-cases hyphenated business domains", () => {
      const r = resolveCustomerName({ fromEmail: "dispatch@northwest-logistics.com" });
      expect(r.name).toBe("Northwest Logistics");
      expect(r.confidence).toBe("high");
    });

    it("never names a free-mail sender after the provider", () => {
      const r = resolveCustomerName({
        fromEmail: "someone@gmail.com",
        subject: "Hello",
        body: "Just checking in.",
      });
      expect(r.name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(r.confidence).toBe("unknown");
      // The legacy bug: must NOT return any provider name.
      expect(r.name.toLowerCase()).not.toBe("gmail");
    });

    it("extracts company from body for free-mail senders", () => {
      const r = resolveCustomerName({
        fromEmail: "marcus@gmail.com",
        subject: "Quote: ATL→CLT",
        body: "Need a spot rate.\n\nThanks,\nMarcus Reed\nPatriot Haulers LLC",
      });
      expect(r.name).toBe("Patriot Haulers LLC");
      expect(r.confidence).toBe("medium");
    });

    it("extracts 'on behalf of X' for free-mail senders", () => {
      const r = resolveCustomerName({
        fromEmail: "intern@gmail.com",
        subject: "Lane request",
        body: "I'm emailing on behalf of Cascade Logistics, can you quote?",
      });
      expect(r.name).toBe("Cascade Logistics");
      expect(r.confidence).toBe("medium");
    });

    it("falls back to the From-header display name when no body match", () => {
      const r = resolveCustomerName({
        fromEmail: '"Acme Brokers" <ops@gmail.com>',
        subject: "Rate?",
        body: "Need a rate, thanks.",
      });
      expect(r.name).toBe("Acme Brokers");
      expect(r.confidence).toBe("low");
    });

    it("ignores display names equal to the local part", () => {
      const r = resolveCustomerName({
        fromEmail: '"ops" <ops@gmail.com>',
        subject: "Hi",
        body: "Hi.",
      });
      expect(r.name).toBe(UNKNOWN_CUSTOMER_NAME);
    });

    it("ignores display names equal to the provider", () => {
      const r = resolveCustomerName({
        fromEmail: '"Gmail" <jane@gmail.com>',
        subject: "Hi",
        body: "Hi.",
      });
      expect(r.name).toBe(UNKNOWN_CUSTOMER_NAME);
    });

    it("ignores cross-provider display names (display = some OTHER free-mail provider)", () => {
      // "Gmail" display on a yahoo.com sender — must not leak.
      const r1 = resolveCustomerName({
        fromEmail: '"Gmail" <user@yahoo.com>',
        subject: "",
        body: "",
      });
      expect(r1.name).toBe(UNKNOWN_CUSTOMER_NAME);

      // "Yahoo" display on a gmail.com sender — must not leak.
      const r2 = resolveCustomerName({
        fromEmail: '"Yahoo" <user@gmail.com>',
        subject: "",
        body: "",
      });
      expect(r2.name).toBe(UNKNOWN_CUSTOMER_NAME);

      // Same protection via the explicit fromName override path.
      const r3 = resolveCustomerName({
        fromEmail: "user@gmail.com",
        fromName: "Outlook",
        subject: "",
        body: "",
      });
      expect(r3.name).toBe(UNKNOWN_CUSTOMER_NAME);

      // And via every other provider in the centralized list.
      for (const provider of ["Hotmail", "Aol", "Icloud", "Proton", "Gmx", "Zoho"]) {
        const r = resolveCustomerName({
          fromEmail: "user@yahoo.com",
          fromName: provider,
        });
        expect(r.name, `display='${provider}' must not leak`).toBe(UNKNOWN_CUSTOMER_NAME);
      }
    });

    it("ignores domain-form display names like 'gmail.com'", () => {
      const r = resolveCustomerName({
        fromEmail: '"gmail.com" <user@yahoo.com>',
        subject: "",
        body: "",
      });
      expect(r.name).toBe(UNKNOWN_CUSTOMER_NAME);
    });

    it("returns Unknown for empty / unparseable from-email", () => {
      expect(resolveCustomerName({ fromEmail: "" }).name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(resolveCustomerName({ fromEmail: null }).name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(resolveCustomerName({ fromEmail: "garbage" }).name).toBe(UNKNOWN_CUSTOMER_NAME);
    });

    it("produces the same Unknown string every time (shared bucket key)", () => {
      const a = resolveCustomerName({ fromEmail: "x@gmail.com", subject: "", body: "" });
      const b = resolveCustomerName({ fromEmail: "y@yahoo.com", subject: "Hi", body: "Hi" });
      const c = resolveCustomerName({ fromEmail: null });
      expect(a.name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(b.name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(c.name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(a.name === b.name && b.name === c.name).toBe(true);
    });

    it("respects an explicit fromName override", () => {
      const r = resolveCustomerName({
        fromEmail: "anon@gmail.com",
        fromName: "Heartland Express",
        subject: "",
        body: "",
      });
      expect(r.name).toBe("Heartland Express");
      expect(r.confidence).toBe("low");
    });
  });

  /**
   * DB-level lock-in for the "single shared Unknown bucket per org" rule.
   * Ingest two free-mail emails with no extractable company name and assert
   * both opportunities resolve to the SAME quote_customers row whose name
   * is the canonical UNKNOWN_CUSTOMER_NAME.
   */
  describe("shared Unknown bucket (DB integration)", () => {
    it("two free-mail ingestions with no extractable company share one quote_customers row per org", async () => {
      const orgRow = await db.select({ id: organizations.id }).from(organizations).limit(1);
      if (orgRow.length === 0) return; // No org in DB — skip silently in clean envs.
      const orgId = orgRow[0].id;
      const tag = `t578-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const messageIds: string[] = [];
      const ingestedIds: string[] = [];
      try {
        for (const sender of ["alice@gmail.com", "bob@yahoo.com"]) {
          const [row] = await db.insert(emailMessages).values({
            orgId,
            providerMessageId: `${tag}-${sender}`,
            direction: "inbound",
            fromEmail: sender,
            toEmail: "ops@example.com",
            subject: `${tag} Spot quote needed`,
            body: "Need a rate from Chicago, IL to Atlanta, GA next Tuesday. Thanks.",
          }).returning();
          messageIds.push(row.id);
        }

        for (const id of messageIds) {
          const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
          const result = await ingestQuoteFromEmail(msg, { useAiFallback: false });
          expect(result.status).toBe("ingested");
          expect(result.quoteId).toBeTruthy();
          ingestedIds.push(result.quoteId!);
        }

        const opps = await db.select({
          id: quoteOpportunities.id,
          customerId: quoteOpportunities.customerId,
        }).from(quoteOpportunities).where(inArray(quoteOpportunities.id, ingestedIds));
        expect(opps.length).toBe(2);
        expect(opps[0].customerId).toBe(opps[1].customerId);

        const [customer] = await db.select({ name: quoteCustomers.name }).from(quoteCustomers)
          .where(eq(quoteCustomers.id, opps[0].customerId));
        expect(customer.name).toBe(UNKNOWN_CUSTOMER_NAME);
      } finally {
        // Cleanup test artifacts (events FK first, then opps, then messages).
        if (ingestedIds.length > 0) {
          await db.delete(quoteEvents).where(inArray(quoteEvents.quoteId, ingestedIds));
          await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, ingestedIds));
        }
        if (messageIds.length > 0) {
          await db.delete(emailMessages).where(inArray(emailMessages.id, messageIds));
        }
      }
    }, 30_000);
  });

  /**
   * Task #753 — broader sibling check used by every customer-creation
   * chokepoint AND by the cleanup script. Must catch the bare provider
   * roots the legacy bug produced PLUS the full-domain / decorated shapes
   * that appeared in the wild after Task #578 went out.
   */
  describe("isFreeMailProviderName (Task #753)", () => {
    it("flags every bare provider root", () => {
      for (const name of ["Gmail", "gmail", "Yahoo", "Outlook", "Hotmail", "Aol", "Icloud", "Mac", "Pm", "Proton", "Gmx", "Mail", "Zoho"]) {
        expect(isFreeMailProviderName(name), `bare='${name}'`).toBe(true);
      }
    });

    it("flags every full provider domain", () => {
      for (const d of FREE_MAIL_PROVIDERS) {
        expect(isFreeMailProviderName(d), `domain='${d}'`).toBe(true);
        expect(isFreeMailProviderName(d.toUpperCase()), `domain='${d.toUpperCase()}'`).toBe(true);
      }
    });

    it("flags decorated provider names", () => {
      for (const name of ["Gmail Mail", "Yahoo Inc", "Outlook.com Co", "Hotmail LLC", "gmail.com inc", "Yahoo, Inc."]) {
        expect(isFreeMailProviderName(name), `decorated='${name}'`).toBe(true);
      }
    });

    it("does NOT flag real freight-business names that share a token", () => {
      // The strip-list intentionally excludes freight tokens so a real
      // shipper like "Gmail Logistics" is preserved verbatim.
      expect(isFreeMailProviderName("Patriot Haulers LLC")).toBe(false);
      expect(isFreeMailProviderName("Cascade Logistics")).toBe(false);
      expect(isFreeMailProviderName("Northwind Industrial")).toBe(false);
      expect(isFreeMailProviderName("Heartland Express")).toBe(false);
      expect(isFreeMailProviderName(UNKNOWN_CUSTOMER_NAME)).toBe(false);
    });

    it("returns false for empty / null / whitespace", () => {
      expect(isFreeMailProviderName(null)).toBe(false);
      expect(isFreeMailProviderName(undefined)).toBe(false);
      expect(isFreeMailProviderName("")).toBe(false);
      expect(isFreeMailProviderName("   ")).toBe(false);
    });
  });

  describe("sanitizeCustomerName (Task #753)", () => {
    it("returns the trimmed name for legitimate inputs", () => {
      expect(sanitizeCustomerName("  Patriot Haulers LLC  ")).toBe("Patriot Haulers LLC");
      expect(sanitizeCustomerName("Cascade   Logistics")).toBe("Cascade Logistics");
    });

    it("rebuckets every provider-shaped name into UNKNOWN", () => {
      for (const bad of ["Gmail", "yahoo.com", "Outlook", "Hotmail Mail", "icloud.com Inc"]) {
        expect(sanitizeCustomerName(bad), `bad='${bad}'`).toBe(UNKNOWN_CUSTOMER_NAME);
      }
    });

    it("returns UNKNOWN for empty / null / whitespace", () => {
      expect(sanitizeCustomerName(null)).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(sanitizeCustomerName(undefined)).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(sanitizeCustomerName("")).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(sanitizeCustomerName("   ")).toBe(UNKNOWN_CUSTOMER_NAME);
    });
  });

  describe("isLegacyFreeMailCustomerName", () => {
    it("flags every legacy provider-root name", () => {
      for (const name of ["Gmail", "gmail", "Yahoo", "Outlook", "Hotmail", "Live", "Aol", "Icloud", "Mac", "Me", "Pm", "Proton", "Protonmail", "Gmx", "Mail", "Zoho"]) {
        expect(isLegacyFreeMailCustomerName(name)).toBe(true);
      }
    });

    it("does not flag real business names", () => {
      expect(isLegacyFreeMailCustomerName("Patriot Haulers LLC")).toBe(false);
      expect(isLegacyFreeMailCustomerName("Cascade Logistics")).toBe(false);
      expect(isLegacyFreeMailCustomerName(UNKNOWN_CUSTOMER_NAME)).toBe(false);
      expect(isLegacyFreeMailCustomerName("")).toBe(false);
      expect(isLegacyFreeMailCustomerName(null)).toBe(false);
    });
  });
});

/**
 * Task #721 — Stop creating new rep records from carrier-facing email
 * senders. The ingestion pipeline must skip the `quote_reps` insert when
 * the recipient (rep) email resolves to an org user whose role is
 * non-customer-facing (logistics_manager, logistics_coordinator, sales,
 * etc.) so carrier-only inboxes don't keep growing the table with rows
 * that the Quote Opportunities pickers already hide.
 */
describe("ingestQuoteFromEmail rep-create gate (Task #721)", () => {
  it("skips quote_reps insert for a logistics_manager rep but creates one for an account_manager", async () => {
    const orgRow = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (orgRow.length === 0) return; // No org in DB — skip silently in clean envs.
    const orgId = orgRow[0].id;
    const tag = `t721-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const lmEmail = `lm-${tag}@example.com`;
    const amEmail = `am-${tag}@example.com`;

    const userIds: string[] = [];
    const messageIds: string[] = [];
    const ingestedIds: string[] = [];
    try {
      // Seed two users in the org: one carrier-facing (logistics_manager)
      // and one customer-facing (account_manager).
      const [lmUser] = await db.insert(users).values({
        organizationId: orgId,
        username: lmEmail,
        name: `LM ${tag}`,
        role: "logistics_manager",
      }).returning();
      const [amUser] = await db.insert(users).values({
        organizationId: orgId,
        username: amEmail,
        name: `AM ${tag}`,
        role: "account_manager",
      }).returning();
      userIds.push(lmUser.id, amUser.id);

      // Build two inbound emails routed to each user's mailbox.
      for (const toEmail of [lmEmail, amEmail]) {
        const [row] = await db.insert(emailMessages).values({
          orgId,
          providerMessageId: `${tag}-${toEmail}`,
          direction: "inbound",
          fromEmail: `customer-${tag}@acme.com`,
          toEmail,
          subject: `${tag} Spot quote needed`,
          body: "Need a rate from Chicago, IL to Atlanta, GA next Tuesday. Thanks.",
        }).returning();
        messageIds.push(row.id);
      }

      for (const id of messageIds) {
        const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, id)).limit(1);
        const result = await ingestQuoteFromEmail(msg, { useAiFallback: false });
        expect(result.status).toBe("ingested");
        expect(result.quoteId).toBeTruthy();
        ingestedIds.push(result.quoteId!);
      }

      // The logistics_manager mailbox must NOT have produced a rep row;
      // the account_manager mailbox must have.
      const lmReps = await db.select({ id: quoteReps.id }).from(quoteReps).where(and(
        eq(quoteReps.organizationId, orgId),
        eq(quoteReps.email, lmEmail),
      ));
      expect(lmReps.length).toBe(0);

      const amReps = await db.select({ id: quoteReps.id }).from(quoteReps).where(and(
        eq(quoteReps.organizationId, orgId),
        eq(quoteReps.email, amEmail),
      ));
      expect(amReps.length).toBe(1);

      // And the resulting opportunities must reflect the gate: the
      // logistics_manager opp has no rep attached, the account_manager
      // opp does.
      const opps = await db.select({
        id: quoteOpportunities.id,
        repId: quoteOpportunities.repId,
        sourceReference: quoteOpportunities.sourceReference,
      }).from(quoteOpportunities).where(inArray(quoteOpportunities.id, ingestedIds));

      const byRef = new Map(opps.map((o) => [o.sourceReference, o]));
      expect(byRef.get(`${tag}-${lmEmail}`)?.repId).toBeNull();
      expect(byRef.get(`${tag}-${amEmail}`)?.repId).toBe(amReps[0].id);
    } finally {
      if (ingestedIds.length > 0) {
        await db.delete(quoteEvents).where(inArray(quoteEvents.quoteId, ingestedIds));
        await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, ingestedIds));
      }
      if (messageIds.length > 0) {
        await db.delete(emailMessages).where(inArray(emailMessages.id, messageIds));
      }
      // Drop the rep we created for the AM (FK on opportunities is
      // already gone by this point) and any LM rep that may have leaked
      // in if the gate regressed, so the test is fully self-cleaning.
      await db.delete(quoteReps).where(and(
        eq(quoteReps.organizationId, orgId),
        inArray(quoteReps.email, [lmEmail, amEmail]),
      ));
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
    }
  }, 30_000);
});

/**
 * Task #753 — DB-level lock-in for the "no provider names on the funnel"
 * rule across every customer-creation chokepoint and the cleanup path.
 *
 * Covers:
 *   1. Email ingestion safety net — a Display Name of "Gmail" on a
 *      yahoo.com sender lands in the shared Unknown bucket, NOT a
 *      "Gmail"-named customer row.
 *   2. Manual entry safety net — `createQuoteCustomer("Gmail")` returns
 *      the shared Unknown row instead of forking a new "Gmail" customer.
 *   3. Broadened cleanup — `backfillFreeMailCustomerNames` rebuckets a
 *      legacy "gmail.com" / "Yahoo Inc"-named customer (full-domain and
 *      decorated shapes) that the original Task #578 narrow check would
 *      have skipped.
 *   4. Idempotency — a second back-to-back run is a true no-op.
 */
describe("free-mail provider safety net (Task #753)", () => {
  it("email ingestion routes a 'Gmail' display name to the shared Unknown bucket", async () => {
    const orgRow = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (orgRow.length === 0) return;
    const orgId = orgRow[0].id;
    const tag = `t753-ing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const messageIds: string[] = [];
    const ingestedIds: string[] = [];
    let leakedCustomerIds: string[] = [];
    try {
      // Display-name "Gmail" on a yahoo sender — the resolver already
      // rejects this, but the safety net at findOrCreateCustomer is what
      // we actually want to lock in.
      const [row] = await db.insert(emailMessages).values({
        orgId,
        providerMessageId: `${tag}-msg`,
        direction: "inbound",
        fromEmail: '"Gmail" <someone@yahoo.com>',
        toEmail: "ops@example.com",
        subject: `${tag} Quote needed`,
        body: "Need a rate from Chicago, IL to Atlanta, GA next Tuesday. Thanks.",
      }).returning();
      messageIds.push(row.id);

      const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, row.id)).limit(1);
      const result = await ingestQuoteFromEmail(msg, { useAiFallback: false });
      expect(result.status).toBe("ingested");
      ingestedIds.push(result.quoteId!);

      const [opp] = await db.select({ customerId: quoteOpportunities.customerId })
        .from(quoteOpportunities).where(eq(quoteOpportunities.id, result.quoteId!));
      const [customer] = await db.select({ id: quoteCustomers.id, name: quoteCustomers.name })
        .from(quoteCustomers).where(eq(quoteCustomers.id, opp.customerId));
      expect(customer.name).toBe(UNKNOWN_CUSTOMER_NAME);
      // Belt + suspenders: no provider-named row for this org.
      const leaks = await db.select({ id: quoteCustomers.id })
        .from(quoteCustomers)
        .where(and(
          eq(quoteCustomers.organizationId, orgId),
          inArray(quoteCustomers.name, ["Gmail", "gmail.com", "Yahoo", "yahoo.com"]),
        ));
      leakedCustomerIds = leaks.map((l) => l.id);
      expect(leaks.length).toBe(0);
    } finally {
      if (ingestedIds.length > 0) {
        await db.delete(quoteEvents).where(inArray(quoteEvents.quoteId, ingestedIds));
        await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, ingestedIds));
      }
      if (messageIds.length > 0) {
        await db.delete(emailMessages).where(inArray(emailMessages.id, messageIds));
      }
      if (leakedCustomerIds.length > 0) {
        // Defensive — only deletes anything if the safety net regressed.
        await db.delete(quoteCustomers).where(inArray(quoteCustomers.id, leakedCustomerIds));
      }
    }
  }, 30_000);

  it("createQuoteCustomer rebuckets every provider name into the shared Unknown row", async () => {
    const orgRow = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (orgRow.length === 0) return;
    const orgId = orgRow[0].id;
    const tag = `t753-mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let createdIds: string[] = [];
    try {
      const a = await createQuoteCustomer(orgId, "Gmail");
      const b = await createQuoteCustomer(orgId, "yahoo.com");
      const c = await createQuoteCustomer(orgId, "Hotmail Mail");
      createdIds = [a.id, b.id, c.id];

      // All three resolved to the SAME shared Unknown row.
      expect(a.name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(b.name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(c.name).toBe(UNKNOWN_CUSTOMER_NAME);
      expect(a.id).toBe(b.id);
      expect(b.id).toBe(c.id);
      expect(a.partyType).toBe("unknown");

      // No provider-named rows in the org as a side-effect.
      const leaks = await db.select({ id: quoteCustomers.id })
        .from(quoteCustomers)
        .where(and(
          eq(quoteCustomers.organizationId, orgId),
          inArray(quoteCustomers.name, ["Gmail", "yahoo.com", "Hotmail Mail"]),
        ));
      expect(leaks.length).toBe(0);

      // Real names still go through cleanly.
      const real = await createQuoteCustomer(orgId, `${tag} Patriot Haulers LLC`);
      createdIds.push(real.id);
      expect(real.name).toBe(`${tag} Patriot Haulers LLC`);
      expect(real.partyType).not.toBe("unknown");
    } finally {
      // Only delete the test-tagged real customer; leave the shared
      // Unknown bucket intact for other tests / production data.
      const taggedIds = createdIds.filter((_id, idx) => idx === 3);
      if (taggedIds.length > 0) {
        await db.delete(quoteCustomers).where(inArray(quoteCustomers.id, taggedIds));
      }
    }
  }, 30_000);

  it("backfillFreeMailCustomerNames cleans full-domain & decorated provider rows and is idempotent", async () => {
    const orgRow = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (orgRow.length === 0) return;
    const orgId = orgRow[0].id;
    const tag = `t753-bf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const customerIds: string[] = [];
    const messageIds: string[] = [];
    const oppIds: string[] = [];
    try {
      // Seed two leaked customer rows that the original narrow detector
      // would have skipped: a full-domain "gmail.com" and a decorated
      // "Yahoo Inc". Bypass the safety net by going straight to the table.
      const [c1] = await db.insert(quoteCustomers).values({
        organizationId: orgId, name: "gmail.com", partyType: "unknown",
      }).returning();
      const [c2] = await db.insert(quoteCustomers).values({
        organizationId: orgId, name: "Yahoo Inc", partyType: "unknown",
      }).returning();
      customerIds.push(c1.id, c2.id);

      // Seed an inbound email + opp pointing at c1 so the backfill has a
      // real `from` to re-resolve. The opp pointing at c2 has no email
      // source so it falls through to the Unknown bucket directly.
      const [m1] = await db.insert(emailMessages).values({
        orgId,
        providerMessageId: `${tag}-cleanup-1`,
        direction: "inbound",
        fromEmail: "intern@gmail.com",
        toEmail: "ops@example.com",
        subject: `${tag} Quote`,
        body: "Quote on behalf of Heartland Express Inc from Chicago, IL to Atlanta, GA.",
      }).returning();
      messageIds.push(m1.id);

      const [o1] = await db.insert(quoteOpportunities).values({
        organizationId: orgId, customerId: c1.id,
        requestDate: new Date(),
        originCity: "Chicago", originState: "IL",
        destCity: "Atlanta", destState: "GA",
        equipment: "Dry Van",
        outcomeStatus: "pending",
        source: "email",
        sourceReference: m1.providerMessageId,
      }).returning();
      const [o2] = await db.insert(quoteOpportunities).values({
        organizationId: orgId, customerId: c2.id,
        requestDate: new Date(),
        originCity: "Houston", originState: "TX",
        destCity: "Boston", destState: "MA",
        equipment: "Reefer",
        outcomeStatus: "pending",
        source: "manual",
        sourceReference: null,
      }).returning();
      oppIds.push(o1.id, o2.id);

      const summary = await backfillFreeMailCustomerNames(orgId);
      expect(summary.scanned).toBe(2);
      // o1 should have been re-resolved to a real company from the body.
      // o2 should have moved to the shared Unknown bucket.
      expect(summary.relinked + summary.movedToUnknown).toBe(2);

      // Both opps now point at non-leaked customer rows.
      const opps = await db.select({
        id: quoteOpportunities.id, customerId: quoteOpportunities.customerId,
      }).from(quoteOpportunities).where(inArray(quoteOpportunities.id, oppIds));
      const newCustomerIds = Array.from(new Set(opps.map((o) => o.customerId)));
      const newCustomers = await db.select({ id: quoteCustomers.id, name: quoteCustomers.name })
        .from(quoteCustomers).where(inArray(quoteCustomers.id, newCustomerIds));
      // Track these for cleanup (other than the original leaked rows we
      // seeded). Heartland Express / Unknown bucket are persistent, so we
      // only delete the rows we own (the original leak rows + any new
      // tag-prefixed ones — there are none here, but the orphan-row delete
      // inside the backfill should already have removed c1/c2).
      for (const c of newCustomers) {
        expect(isFreeMailProviderName(c.name)).toBe(false);
        expect(c.name.toLowerCase()).not.toBe("gmail.com");
        expect(c.name.toLowerCase()).not.toBe("yahoo inc");
      }

      // Original leaked rows must be deleted by the orphan-row sweep
      // (no remaining opps point at them).
      const stillThere = await db.select({ id: quoteCustomers.id })
        .from(quoteCustomers).where(inArray(quoteCustomers.id, [c1.id, c2.id]));
      expect(stillThere.length).toBe(0);
      // Don't try to clean them up below — they're already gone.
      customerIds.length = 0;

      // Idempotency: a second run scans nothing (no provider-named rows
      // remain) and changes nothing.
      const summary2 = await backfillFreeMailCustomerNames(orgId);
      expect(summary2.scanned).toBe(0);
      expect(summary2.relinked).toBe(0);
      expect(summary2.movedToUnknown).toBe(0);
      expect(summary2.unchanged).toBe(0);
      expect(summary2.customerRowsDeleted).toBe(0);
    } finally {
      if (oppIds.length > 0) {
        await db.delete(quoteEvents).where(inArray(quoteEvents.quoteId, oppIds));
        await db.delete(quoteOpportunities).where(inArray(quoteOpportunities.id, oppIds));
      }
      if (messageIds.length > 0) {
        await db.delete(emailMessages).where(inArray(emailMessages.id, messageIds));
      }
      if (customerIds.length > 0) {
        await db.delete(quoteCustomers).where(inArray(quoteCustomers.id, customerIds));
      }
    }
  }, 60_000);
});
