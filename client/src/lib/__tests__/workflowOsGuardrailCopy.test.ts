// Workflow OS — guardrail copy contract.
//
// Asserts the iconography rule (ADR-004): every reason maps to an icon
// in the canonical category bucket and exposes a short label and a long
// explanation. New reasons land here first.

import { describe, it, expect } from "vitest";
import {
  guardrailCopy,
  isGuardrailReason,
} from "@/lib/workflow-os/guardrailCopy";

describe("guardrailCopy", () => {
  it("covers every documented reason with non-empty copy", () => {
    const reasons = Object.keys(guardrailCopy);
    expect(reasons).toContain("recent_contact");
    expect(reasons).toContain("daily_cap");
    expect(reasons).toContain("not_approved");
    expect(reasons).toContain("do_not_contact_lane");
    expect(reasons).toContain("customer_carrier_blocked");
    expect(reasons).toContain("throttled_too_soon");
    expect(reasons).toContain("throttled_daily_cap");
    expect(reasons).toContain("dedup_skipped");

    for (const c of Object.values(guardrailCopy)) {
      expect(c.shortLabel.length).toBeGreaterThan(0);
      expect(c.longExplanation.length).toBeGreaterThan(0);
      expect(c.icon).toBeTruthy();
    }
  });

  it("groups reasons into the four canonical categories (ADR-004)", () => {
    expect(guardrailCopy.do_not_contact_lane.category).toBe("dnc");
    expect(guardrailCopy.not_approved.category).toBe("compliance");
    expect(guardrailCopy.customer_carrier_blocked.category).toBe("compliance");
    expect(guardrailCopy.recent_contact.category).toBe("throttle");
    expect(guardrailCopy.throttled_too_soon.category).toBe("throttle");
    expect(guardrailCopy.throttled_daily_cap.category).toBe("throttle");
    expect(guardrailCopy.daily_cap.category).toBe("throttle");
    expect(guardrailCopy.dedup_skipped.category).toBe("dedup");
  });

  it("isGuardrailReason narrows arbitrary strings", () => {
    expect(isGuardrailReason("recent_contact")).toBe(true);
    expect(isGuardrailReason("nope")).toBe(false);
    expect(isGuardrailReason(42)).toBe(false);
  });
});
