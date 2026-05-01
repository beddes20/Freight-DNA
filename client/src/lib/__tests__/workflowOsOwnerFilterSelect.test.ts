// Task #907 — Contract test for the OwnerFilterSelect option set.
//
// The shared dropdown is the same control across AF, LWQ, and Available
// Loads, so the canonical 4 base options + their values + their
// data-testids are a stable cross-surface contract. This test asserts
// that contract and exercises the value-emission helpers
// (`ownerValueFromString`) so we know <Select onValueChange> hands the
// surface a well-typed `OwnerFilterValue`.

import { describe, it, expect } from "vitest";
import {
  OWNER_FILTER_BASE_OPTIONS,
  ownerFilterBaseLabel,
  ownerValueToString,
  ownerValueFromString,
  type WorkflowOsSurface,
} from "@/components/workflow-os/OwnerFilterSelect";
import type { OwnerFilterValue } from "@shared/workflowOs/ownership";

describe("OwnerFilterSelect — canonical option contract", () => {
  it("renders exactly the 4 spec-defined base options in the documented order", () => {
    expect(OWNER_FILTER_BASE_OPTIONS.map((o) => o.value)).toEqual([
      "all",
      "me",
      "am_book",
      "unassigned",
    ]);
  });

  it("ships stable, surface-agnostic data-testids for each base option", () => {
    expect(OWNER_FILTER_BASE_OPTIONS.map((o) => o.testId)).toEqual([
      "owner-option-all",
      "owner-option-me",
      "owner-option-am-book",
      "owner-option-unassigned",
    ]);
  });

  it("uses surface-specific labels only for `me` (My freight / My lanes / My loads)", () => {
    const surfaces: WorkflowOsSurface[] = ["af", "lwq", "available_loads"];
    for (const s of surfaces) {
      expect(ownerFilterBaseLabel("all", s)).toBe("All owners");
      expect(ownerFilterBaseLabel("am_book", s)).toBe("My AM's book");
      expect(ownerFilterBaseLabel("unassigned", s)).toBe("Unassigned");
    }
    expect(ownerFilterBaseLabel("me", "af")).toBe("My freight");
    expect(ownerFilterBaseLabel("me", "lwq")).toBe("My lanes");
    expect(ownerFilterBaseLabel("me", "available_loads")).toBe("My loads");
  });
});

describe("OwnerFilterSelect — value emission contract", () => {
  // Simulates what <Select onValueChange={(s) => onChange(ownerValueFromString(s))} />
  // delivers to the surface for each base option.
  it.each(OWNER_FILTER_BASE_OPTIONS.map((o) => o.value))(
    "decodes base option %s → matching OwnerFilterValue string union",
    (raw) => {
      const v = ownerValueFromString(raw);
      expect(v).toBe(raw);
    },
  );

  it("decodes `specific:<id>` into the structured OwnerFilterValue", () => {
    const v = ownerValueFromString("specific:user-42");
    expect(v).toEqual({ specificUserId: "user-42" });
  });

  it("falls back to `all` for unknown raw strings (defensive default)", () => {
    expect(ownerValueFromString("garbage")).toBe("all");
    expect(ownerValueFromString("")).toBe("all");
  });

  it("roundtrips every kind of OwnerFilterValue through to-string + from-string", () => {
    const cases: OwnerFilterValue[] = [
      "all",
      "me",
      "am_book",
      "unassigned",
      { specificUserId: "abc-123" },
    ];
    for (const v of cases) {
      const s = ownerValueToString(v);
      expect(ownerValueFromString(s)).toEqual(v);
    }
  });
});
