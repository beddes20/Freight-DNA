/**
 * Task #517 — coverage classifier shared by the admin coverage route and
 * the test suite. Pulled out as a pure function so route behavior and
 * test expectations stay locked together (no risk of test helper drift
 * from the live endpoint logic).
 */

export type CoverageSeverity = "ok" | "info" | "warn" | "error";
export type ConsentStatus = "granted" | "pending" | "denied" | "unknown";

export interface CoverageInputs {
  eligibleUsers: number;
  enrolledMailboxes: number;
  consentStatus: ConsentStatus;
  consentConfigured: boolean;
  failedBackfills: number;
  neverBackfilled: number;
}

export interface CoverageVerdict {
  severity: CoverageSeverity;
  reasons: string[];
}

export function classifyCoverage(input: CoverageInputs): CoverageVerdict {
  let severity: CoverageSeverity = "ok";
  const reasons: string[] = [];

  if (input.eligibleUsers > 0 && input.enrolledMailboxes === 0) {
    severity = "warn";
    reasons.push("zero_enrolled");
  }

  if (input.consentStatus === "denied" || input.consentStatus === "unknown") {
    // Don't yell about consent in environments where Azure isn't even
    // configured — that's a self-hosted dev box, not a coverage gap.
    if (input.consentConfigured) {
      severity = "error";
      reasons.push("mail_read_missing");
    }
  } else if (input.consentStatus === "pending") {
    if (severity === "ok") severity = "info";
    reasons.push("mail_read_pending");
  }

  if (input.failedBackfills > 0) {
    severity = severity === "error" ? "error" : "warn";
    reasons.push("backfill_failed");
  }

  // Task #517 — flag pending whenever ANY enrolled mailbox is still
  // missing its 30-day backfill, not only when every mailbox is.
  // Partial coverage gaps are still gaps.
  if (input.enrolledMailboxes > 0 && input.neverBackfilled > 0) {
    if (severity === "ok") severity = "info";
    reasons.push("backfill_pending");
  }

  return { severity, reasons };
}
