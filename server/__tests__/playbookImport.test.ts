/**
 * Playbook Import — parser & preview smoke tests (Task #439)
 *
 * Locks the validation/duplicate-detection contract that powers the
 * Import-from-Excel flow on the Playbook tab.
 */
import { describe, it, expect } from "vitest";
import {
  validateRow,
  buildPlaybookImportPreview,
  autoDetectPlaybookMapping,
} from "../lib/playbookImport";
import * as XLSX from "xlsx";

describe("validateRow", () => {
  it("accepts a complete row and parses defaults", () => {
    const { parsed, errors } = validateRow({
      name: "Re-engage stalled quote",
      description: "Reach out after 3+ days of silence",
      audience: "customer",
      channel: "email",
      triggerType: "quote_no_response",
      recommendedSteps: "1) Open quote\n2) Send nudge\n3) Offer call",
      templateBody: "Hi {{contactName}}",
      successMetric: "Reply within 96h",
      outcomeWindowHours: "72",
    });
    expect(errors).toEqual([]);
    expect(parsed?.name).toBe("Re-engage stalled quote");
    expect(parsed?.audience).toBe("customer");
    expect(parsed?.channel).toBe("email");
    expect(parsed?.triggerType).toBe("quote_no_response");
    expect(parsed?.recommendedSteps).toEqual(["Open quote", "Send nudge", "Offer call"]);
    expect(parsed?.outcomeWindowHours).toBe(72);
  });

  it("flags missing name", () => {
    const { parsed, errors } = validateRow({ name: "", channel: "email" });
    expect(parsed).toBeNull();
    expect(errors.join(";")).toMatch(/name/i);
  });

  it("flags invalid channel/audience/trigger", () => {
    const { parsed, errors } = validateRow({
      name: "Bad",
      audience: "internal",
      channel: "fax",
      triggerType: "telepathy",
    });
    expect(parsed).toBeNull();
    expect(errors.join(";")).toMatch(/audience/);
    expect(errors.join(";")).toMatch(/channel/);
    expect(errors.join(";")).toMatch(/trigger/);
  });

  it("defaults audience/channel/trigger when blank", () => {
    const { parsed, errors } = validateRow({ name: "OK" });
    expect(errors).toEqual([]);
    expect(parsed?.audience).toBe("customer");
    expect(parsed?.channel).toBe("email");
    expect(parsed?.triggerType).toBe("manual");
    expect(parsed?.outcomeWindowHours).toBe(96);
  });

  it("normalizes channel hyphens/spaces", () => {
    const { parsed } = validateRow({ name: "n", channel: "in person" });
    expect(parsed?.channel).toBe("in_person");
  });

  it("rejects out-of-range outcome window", () => {
    const { errors } = validateRow({ name: "x", outcomeWindowHours: "999999" });
    expect(errors.join(";")).toMatch(/outcome window/i);
  });
});

describe("buildPlaybookImportPreview", () => {
  it("flags duplicate names against existing org plays", () => {
    const preview = buildPlaybookImportPreview(
      [{ name: "Welcome call" }, { name: "Re-engage" }],
      ["Welcome Call"], // case-insensitive
    );
    expect(preview[0].isDuplicate).toBe(true);
    expect(preview[0].duplicateReason).toMatch(/existing/i);
    expect(preview[1].isDuplicate).toBe(false);
  });

  it("flags duplicate names within the same file", () => {
    const preview = buildPlaybookImportPreview(
      [{ name: "Foo" }, { name: "foo" }],
      [],
    );
    expect(preview[0].isDuplicate).toBe(false);
    expect(preview[1].isDuplicate).toBe(true);
    expect(preview[1].duplicateReason).toMatch(/file/i);
  });

  it("returns row-level errors for invalid rows", () => {
    const preview = buildPlaybookImportPreview(
      [{ name: "" }, { name: "Good", channel: "fax" }],
      [],
    );
    expect(preview[0].errors.length).toBeGreaterThan(0);
    expect(preview[0].parsed).toBeNull();
    expect(preview[1].errors.join(";")).toMatch(/channel/);
  });
});

describe("autoDetectPlaybookMapping", () => {
  it("matches common header synonyms case-insensitively", () => {
    const mapping = autoDetectPlaybookMapping([
      "Play Name", "Purpose", "Audience", "Channel", "Trigger", "Steps", "Template", "Metric", "Window",
    ]);
    expect(mapping.name).toBe("Play Name");
    expect(mapping.description).toBe("Purpose");
    expect(mapping.recommendedSteps).toBe("Steps");
    expect(mapping.templateBody).toBe("Template");
    expect(mapping.outcomeWindowHours).toBe("Window");
  });
});

describe("xlsx round-trip", () => {
  it("parses a generated .xlsx with mixed valid/invalid rows", () => {
    const headers = ["name", "audience", "channel", "triggerType"];
    const rows = [
      ["Good Play", "customer", "email", "manual"],
      ["", "customer", "email", "manual"],          // missing name
      ["Bad Channel", "customer", "fax", "manual"], // invalid channel
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Plays");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const parsedWb = XLSX.read(buf, { type: "buffer" });
    const parsedWs = parsedWb.Sheets[parsedWb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json<Record<string, string>>(parsedWs, { raw: false });

    const preview = buildPlaybookImportPreview(data, []);
    expect(preview).toHaveLength(3);
    expect(preview[0].errors).toEqual([]);
    expect(preview[0].parsed?.name).toBe("Good Play");
    expect(preview[1].parsed).toBeNull();
    expect(preview[2].errors.join(";")).toMatch(/channel/);
  });
});
