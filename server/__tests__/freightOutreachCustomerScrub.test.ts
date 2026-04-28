// Task #820 — carrier-bound emails must never mention the customer/shipper.
// Exercises the seeded templates, buildTemplateVars, renderTemplate, and the
// end-to-end buildOpportunityDraft path against the Louisville → Norcross
// (4/30 → 5/1) reference scenario.

import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_FREIGHT_OUTREACH_TEMPLATES,
  buildTemplateVars,
  buildOpportunityDraft,
  renderTemplate,
  formatShortDate,
  humanizeEquipmentLabel,
} from "../freightOpportunityOutreachService";
import type {
  Carrier,
  Company,
  FreightOpportunity,
  FreightOpportunityCarrier,
  User,
} from "@shared/schema";
import type { IStorage } from "../storage";

// Some legacy code paths or admin-customised templates may still embed
// `{{customer_name}}` directly. Confirm the runtime substitution map
// renders it as the empty string (the migration scrubs the seeded rows
// but old custom rows might persist).
const LEGACY_CUSTOMER_TEMPLATE =
  "Hey {{carrier_name}} team,\n\nLoad for {{customer_name}} on {{lane_display_to}}.";

function makeOpportunity(overrides: Partial<FreightOpportunity> = {}): FreightOpportunity {
  return {
    id: "opp-1",
    orgId: "org-1",
    companyId: "company-1",
    mode: "exact_load",
    origin: "Louisville",
    originState: "KY",
    destination: "Norcross",
    destinationState: "GA",
    equipmentType: "Dry Van",
    pickupWindowStart: "2026-04-30",
    pickupWindowEnd: "2026-04-30",
    deliveryDate: "2026-05-01",
    loadCount: 1,
    ...overrides,
  } as unknown as FreightOpportunity;
}

const carrier: Pick<Carrier, "name"> = { name: "Acme Trucking" };
const rep: Pick<User, "name" | "username"> = {
  name: "Sam Davis",
  username: "sam.davis@valuetruck.com",
};
const company: Pick<Company, "name"> = { name: "Confidential Foods Inc" };

describe("Task #820 — carrier outreach customer-name scrub", () => {
  it("formatShortDate renders ISO dates as M/D with no leading zeros and no year", () => {
    expect(formatShortDate("2026-04-30")).toBe("4/30");
    expect(formatShortDate("2026-05-01")).toBe("5/1");
    expect(formatShortDate("2026-12-09")).toBe("12/9");
    expect(formatShortDate(null)).toBe("");
    expect(formatShortDate("")).toBe("");
    expect(formatShortDate("not-a-date")).toBe("");
  });

  it("humanizeEquipmentLabel lowercases canonical labels but keeps acronyms", () => {
    expect(humanizeEquipmentLabel("Dry Van")).toBe("dry van");
    expect(humanizeEquipmentLabel("Reefer")).toBe("reefer");
    expect(humanizeEquipmentLabel("Flatbed")).toBe("flatbed");
    expect(humanizeEquipmentLabel("LTL")).toBe("LTL");
    expect(humanizeEquipmentLabel(null)).toBe("dry van");
    expect(humanizeEquipmentLabel("")).toBe("dry van");
  });

  it("buildTemplateVars returns customer_name as empty string", () => {
    const vars = buildTemplateVars({
      carrier,
      rep,
      company,
      opportunity: makeOpportunity(),
      hasHistory: false,
    });
    expect(vars.customer_name).toBe("");
    // The company name itself MUST NOT appear in any rendered variable.
    for (const [key, value] of Object.entries(vars)) {
      expect(value, `variable ${key} leaked customer name "${company.name}"`)
        .not.toContain(company.name);
    }
  });

  it("buildTemplateVars exposes the new short-date + equipment_human variables", () => {
    const vars = buildTemplateVars({
      carrier,
      rep,
      company,
      opportunity: makeOpportunity(),
      hasHistory: false,
    });
    expect(vars.pickup_date_short).toBe("4/30");
    expect(vars.delivery_date_short).toBe("5/1");
    expect(vars.pickup_window_short).toBe("4/30 - 5/1");
    expect(vars.equipment_human).toBe("dry van");
    expect(vars.lane_display_to).toBe("Louisville, KY to Norcross, GA");
  });

  it("collapses pickup_window_short to a single date when pickup === delivery", () => {
    const vars = buildTemplateVars({
      carrier,
      rep,
      company,
      // Same-day pickup + delivery: subject should render "(M/D)" not "(M/D - M/D)".
      opportunity: makeOpportunity({ deliveryDate: "2026-04-30" }),
      hasHistory: false,
    });
    expect(vars.pickup_window_short).toBe("4/30");
  });

  it("falls back to pickup_window_end when delivery_date is null (legacy rows)", () => {
    const vars = buildTemplateVars({
      carrier,
      rep,
      company,
      opportunity: makeOpportunity({
        deliveryDate: null,
        pickupWindowEnd: "2026-05-02",
      }),
      hasHistory: false,
    });
    expect(vars.delivery_date_short).toBe("5/2");
    expect(vars.pickup_window_short).toBe("4/30 - 5/2");
  });

  it("default exact_load template renders the rep-approved subject + body", () => {
    const opportunity = makeOpportunity();
    const vars = buildTemplateVars({
      carrier,
      rep,
      company,
      opportunity,
      hasHistory: false,
    });

    const tpl = DEFAULT_FREIGHT_OUTREACH_TEMPLATES.exact_load;
    const subject = renderTemplate(tpl.subject, vars);
    const body = renderTemplate(tpl.body, vars);

    // Subject — exact spec wording.
    expect(subject).toBe(
      "Available freight - Louisville, KY to Norcross, GA (4/30 - 5/1)",
    );

    // Body — must contain pickup + delivery dates and never the customer.
    expect(body).toContain("Hey Acme Trucking team,");
    expect(body).toContain("dry van");
    expect(body).toContain("Louisville");
    expect(body).toContain("Norcross");
    expect(body).toContain("P/U 4/30");
    expect(body).toContain("delivers 5/1");
    expect(body).toContain("Sam Davis");
    expect(body).not.toContain("Confidential");
    // No leftover unsubstituted tokens.
    expect(body).not.toMatch(/\{\{[^}]+\}\}/);
    expect(subject).not.toMatch(/\{\{[^}]+\}\}/);
    // Spec calls for the word "to", not the arrow glyph.
    expect(subject).not.toContain("→");
    expect(body).not.toContain("→");
  });

  it("default lane_building template never mentions the customer", () => {
    const opportunity = makeOpportunity({ mode: "lane_building" });
    const vars = buildTemplateVars({
      carrier,
      rep,
      company,
      opportunity,
      hasHistory: false,
    });

    const tpl = DEFAULT_FREIGHT_OUTREACH_TEMPLATES.lane_building;
    const subject = renderTemplate(tpl.subject, vars);
    const body = renderTemplate(tpl.body, vars);

    expect(subject).toBe(
      "Available freight - Louisville, KY to Norcross, GA (4/30 - 5/1)",
    );
    expect(body).not.toContain("Confidential");
    expect(body).not.toMatch(/\{\{[^}]+\}\}/);
    expect(body).toContain("Acme Trucking");
    expect(body).toContain("Sam Davis");
  });

  it("legacy {{customer_name}} token still renders as empty (no leak, no leftover)", () => {
    const vars = buildTemplateVars({
      carrier,
      rep,
      company,
      opportunity: makeOpportunity(),
      hasHistory: false,
    });
    const rendered = renderTemplate(LEGACY_CUSTOMER_TEMPLATE, vars);
    expect(rendered).not.toContain("Confidential");
    expect(rendered).not.toContain("{{customer_name}}");
    // The substitution leaves "Load for  on …" — the empty string is
    // harmless and the carrier never sees a literal token.
    expect(rendered).toContain("Hey Acme Trucking team");
    expect(rendered).toContain("Louisville, KY to Norcross, GA");
  });

  it("seeded default templates do NOT include {{customer_name}}", () => {
    for (const kind of ["exact_load", "lane_building"] as const) {
      const tpl = DEFAULT_FREIGHT_OUTREACH_TEMPLATES[kind];
      expect(tpl.subject, `${kind} subject leaked customer_name`)
        .not.toContain("{{customer_name}}");
      expect(tpl.body, `${kind} body leaked customer_name`)
        .not.toContain("{{customer_name}}");
      // Spec house-style guards.
      expect(tpl.body, `${kind} body uses arrow instead of "to"`)
        .not.toContain("→");
    }
  });
});

// End-to-end leak guard over buildOpportunityDraft against a stubbed storage.
describe("Task #820 — buildOpportunityDraft end-to-end carrier-name leak guard", () => {
  function makeStorage(opts: {
    companyName: string;
    template?: { subject: string; body: string };
  }): IStorage {
    const tpl = opts.template ?? DEFAULT_FREIGHT_OUTREACH_TEMPLATES.exact_load;
    return {
      getCarrier: vi.fn(async () => ({
        id: "car-1",
        orgId: "org-1",
        name: "Acme Trucking",
        primaryEmail: "dispatch@acme.example",
        backupEmail: null,
      })),
      getCompany: vi.fn(async () => ({
        id: "company-1",
        orgId: "org-1",
        name: opts.companyName,
      })),
      getFreightOutreachTemplate: vi.fn(async () => ({
        id: "tpl-1",
        orgId: "org-1",
        kind: "exact_load",
        subject: tpl.subject,
        body: tpl.body,
        updatedAt: new Date(),
        updatedById: null,
      })),
      upsertFreightOutreachTemplate: vi.fn(async (t: { subject: string; body: string }) => ({
        id: "tpl-1",
        orgId: "org-1",
        kind: "exact_load",
        subject: t.subject,
        body: t.body,
        updatedAt: new Date(),
        updatedById: null,
      })),
    } as unknown as IStorage;
  }

  const baseOpp: FreightOpportunity = {
    id: "opp-1",
    orgId: "org-1",
    companyId: "company-1",
    mode: "exact_load",
    origin: "Louisville",
    originState: "KY",
    destination: "Norcross",
    destinationState: "GA",
    equipmentType: "Dry Van",
    pickupWindowStart: "2026-04-30",
    pickupWindowEnd: "2026-04-30",
    deliveryDate: "2026-05-01",
    loadCount: 1,
  } as unknown as FreightOpportunity;

  const oppCarrier: FreightOpportunityCarrier = {
    id: "oppc-1",
    opportunityId: "opp-1",
    carrierId: "car-1",
    historyMatch: "none",
    responsivenessSnapshot: null,
  } as unknown as FreightOpportunityCarrier;

  const repUser: User = {
    id: "user-1",
    name: "Sam Davis",
    username: "sam.davis@valuetruck.com",
  } as unknown as User;

  it("renders the Louisville → Norcross spec scenario verbatim with no customer name", async () => {
    const storage = makeStorage({ companyName: "Confidential Foods Inc" });
    const draft = await buildOpportunityDraft(storage, baseOpp, oppCarrier, repUser);

    expect(draft.subject).toBe(
      "Available freight - Louisville, KY to Norcross, GA (4/30 - 5/1)",
    );
    expect(draft.subject).not.toContain("Confidential");
    expect(draft.body).not.toContain("Confidential");
    expect(draft.subject).not.toMatch(/\{\{[^}]+\}\}/);
    expect(draft.body).not.toMatch(/\{\{[^}]+\}\}/);
    expect(draft.body).toContain("Hey Acme Trucking team,");
    expect(draft.body).toContain("dry van");
    expect(draft.body).toContain("P/U 4/30");
    expect(draft.body).toContain("delivers 5/1");
    expect(draft.body).toContain("Sam Davis");
    expect(draft.toEmail).toBe("dispatch@acme.example");
    expect(draft.warnings).toEqual([]);
  });

  it("blocks customer-name leakage even when template still has {{customer_name}} (defense in depth)", async () => {
    const storage = makeStorage({
      companyName: "MegaCorp Logistics",
      template: {
        subject: "Load for {{customer_name}} on {{lane_display_to}}",
        body: "Hey {{carrier_name}} team, {{customer_name}} needs a truck on {{lane_display_to}}.\nThanks,\n{{rep_name}}",
      },
    });
    const draft = await buildOpportunityDraft(storage, baseOpp, oppCarrier, repUser);
    expect(draft.subject).not.toContain("MegaCorp");
    expect(draft.body).not.toContain("MegaCorp");
    expect(draft.body).toContain("Acme Trucking");
    expect(draft.body).toContain("Louisville, KY to Norcross, GA");
  });

  it("scans every variable in buildTemplateVars output against a battery of company names", () => {
    const samples = [
      "Confidential Foods Inc",
      "ACME Cold Storage LLC",
      "Globex Beverages, North America",
      "X-Prime Industrial Supply Co.",
      "Tesla, Inc.",
    ];
    for (const companyName of samples) {
      const vars = buildTemplateVars({
        carrier,
        rep,
        company: { name: companyName },
        opportunity: makeOpportunity(),
        hasHistory: false,
      });
      for (const [key, value] of Object.entries(vars)) {
        expect(value, `variable ${key} leaked customer name "${companyName}"`)
          .not.toContain(companyName);
      }
    }
  });

  // Mirrors the contract of GET /api/freight-opportunities/:oppId/carriers/:carrierRowId/draft
  // (server/routes/proactiveOpportunities.ts:687) which feeds the Send Outreach
  // preview dialog. The route is a thin wrapper over buildOpportunityDraft, so
  // pinning the draft shape here pins the preview contract.
  it("emulates the Send Outreach preview endpoint and validates the rendered preview JSON", async () => {
    const storage = makeStorage({ companyName: "Confidential Foods Inc" });
    const draft = await buildOpportunityDraft(storage, baseOpp, oppCarrier, repUser);
    const previewResponse = { draft };

    expect(previewResponse.draft.subject).toBe(
      "Available freight - Louisville, KY to Norcross, GA (4/30 - 5/1)",
    );
    // Pickup + delivery short-date format ("M/D" — no year, no leading zeros).
    expect(previewResponse.draft.body).toMatch(/P\/U \d{1,2}\/\d{1,2}/);
    expect(previewResponse.draft.body).toMatch(/delivers \d{1,2}\/\d{1,2}/);
    // No customer name leaks anywhere in the preview JSON.
    const serialized = JSON.stringify(previewResponse);
    expect(serialized).not.toContain("Confidential");
    expect(serialized).not.toMatch(/\{\{[^}]+\}\}/);
  });
});
