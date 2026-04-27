import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { parseQuoteEmail, decideLostReason, ingestQuoteFromEmail } from "../services/quoteEmailIngestion";
import {
  resolveCustomerName,
  isFreeMailDomain,
  isLegacyFreeMailCustomerName,
  nameFromBusinessDomain,
  extractCompanyFromText,
  parseFromHeader,
  UNKNOWN_CUSTOMER_NAME,
  FREE_MAIL_PROVIDERS,
} from "../services/customerNameResolver";
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
