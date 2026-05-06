// Pins the "Webhook unhealthy" vs "Pipeline degraded" disambiguation
// contract for the Conversations capture-audit pill.
//
// Background: when the email_intelligence_batch cron started hitting its
// 5-minute wall clock and bumping consecutive_failures, the rollup in
// `getCaptureAuditHealthForUsers` flipped to "unhealthy" — but the pill
// rendered the literal string "Webhook unhealthy" even though the
// webhook itself was fine and inbound mail was flowing in real time.
// That false-blame label burned trust on the Conversations tab.
//
// Contract:
//   - status="unhealthy" + webhookFailureCount > 0   → "Webhook unhealthy"
//   - status="unhealthy" + webhookFailureCount = 0
//                          + cronJobs has stale/failing → "Pipeline degraded"
//   - status="unhealthy" + only sharedReplyMailbox bad  → "Pipeline degraded"
//   - status="unhealthy" + nothing identifiable          → "Pipeline degraded"
//                                                          (defensive default)
//   - status="healthy"   → "All synced"
//   - status="recovering" → "N pending recovery"

import { describe, expect, it } from "vitest";
import { pillVisuals } from "@/components/conversations/capture-audit-status-pill";

type Status = "healthy" | "recovering" | "unhealthy";

function payload(overrides: {
  status: Status;
  webhookFailureCount?: number;
  pendingRecoveryThreadCount?: number;
  cronJobs?: Array<{ jobName: string; status: "ok" | "stale" | "failing" | "unknown" }>;
  sharedReplyConfigured?: boolean;
  sharedReplyEnabled?: boolean;
}) {
  return {
    ok: true,
    status: overrides.status,
    generatedAt: new Date().toISOString(),
    lastSuccessfulSyncAt: new Date().toISOString(),
    pendingRecoveryThreadCount: overrides.pendingRecoveryThreadCount ?? 0,
    webhookFailureCount: overrides.webhookFailureCount ?? 0,
    scope: { mailboxes: 40, users: null },
    mailboxes: [],
    recentRuns: [],
    affectedThreads: [],
    cronJobs: (overrides.cronJobs ?? []).map(c => ({
      jobName: c.jobName,
      status: c.status,
      expectedIntervalMs: 120_000,
      lastStartedAt: null,
      lastFinishedAt: null,
      nextExpectedAt: null,
      consecutiveFailures: c.status === "failing" ? 14 : 0,
      lastError: c.status === "failing" ? "exceeded wall clock" : null,
    })),
    sharedReplyMailbox:
      overrides.sharedReplyConfigured === undefined
        ? null
        : {
            configured: overrides.sharedReplyConfigured,
            enabled: overrides.sharedReplyEnabled ?? false,
            subscriptionActive: false,
            mailbox: "replies@valuetruck.com",
            missingPermissions: [],
            warnings: [],
          },
  };
}

describe("pillVisuals — overall status wiring", () => {
  it("renders 'All synced' for healthy status", () => {
    const v = pillVisuals("healthy", payload({ status: "healthy" }));
    expect(v.label).toBe("All synced");
  });

  it("renders pending-count summary for recovering status", () => {
    const v = pillVisuals(
      "recovering",
      payload({ status: "recovering", pendingRecoveryThreadCount: 3 }),
    );
    expect(v.label).toBe("3 pending recovery");
  });

  it("renders 'Sync recovering' when status is recovering with zero threads", () => {
    const v = pillVisuals(
      "recovering",
      payload({ status: "recovering", pendingRecoveryThreadCount: 0 }),
    );
    expect(v.label).toBe("Sync recovering");
  });

  it("renders generic loading label when payload is undefined", () => {
    const v = pillVisuals("healthy", undefined);
    expect(v.label).toBe("Sync status");
  });
});

describe("pillVisuals — unhealthy disambiguation (the trust fix)", () => {
  it("renders 'Webhook unhealthy' when a per-mailbox subscription has expired", () => {
    const v = pillVisuals(
      "unhealthy",
      payload({ status: "unhealthy", webhookFailureCount: 2 }),
    );
    expect(v.label).toBe("Webhook unhealthy");
    expect(v.title).toMatch(/subscription/i);
  });

  it("keeps 'Webhook unhealthy' when BOTH webhook AND cron are degraded (severity wins)", () => {
    // Real subscription failure must not be hidden behind a cron label.
    const v = pillVisuals(
      "unhealthy",
      payload({
        status: "unhealthy",
        webhookFailureCount: 1,
        cronJobs: [{ jobName: "email_intelligence_batch", status: "failing" }],
      }),
    );
    expect(v.label).toBe("Webhook unhealthy");
  });

  it("renders 'Pipeline degraded' when only a critical cron is failing (the production case)", () => {
    // Reproduces the May 2026 incident: webhook is fine, AI classification
    // batch hit its 5-min wall clock 14 times in a row, pill was lying.
    const v = pillVisuals(
      "unhealthy",
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        cronJobs: [{ jobName: "email_intelligence_batch", status: "failing" }],
      }),
    );
    expect(v.label).toBe("Pipeline degraded");
    // Title must name the actual failing job so admins know what to fix.
    expect(v.title).toContain("AI classification batch");
    // Title must reassure the rep that mail itself is still flowing.
    expect(v.title).toMatch(/still flowing/i);
  });

  it("renders 'Pipeline degraded' when a stale (not failing) critical cron is the trigger", () => {
    const v = pillVisuals(
      "unhealthy",
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        cronJobs: [{ jobName: "mailbox_delta_sync_poll", status: "stale" }],
      }),
    );
    expect(v.label).toBe("Pipeline degraded");
    expect(v.title).toContain("Mailbox delta-sync poll");
  });

  it("names multiple failing cron jobs in the title (capped at 2 + overflow)", () => {
    const v = pillVisuals(
      "unhealthy",
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        cronJobs: [
          { jobName: "email_intelligence_batch", status: "failing" },
          { jobName: "mailbox_delta_sync_poll", status: "stale" },
          { jobName: "reply_capture_self_heal_sweep", status: "failing" },
        ],
      }),
    );
    expect(v.label).toBe("Pipeline degraded");
    expect(v.title).toContain("AI classification batch");
    expect(v.title).toContain("Mailbox delta-sync poll");
    expect(v.title).toMatch(/\+1 more/);
  });

  it("falls back to raw job_name when an unknown job is degraded", () => {
    const v = pillVisuals(
      "unhealthy",
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        cronJobs: [{ jobName: "future_job_we_havent_named_yet", status: "failing" }],
      }),
    );
    expect(v.label).toBe("Pipeline degraded");
    expect(v.title).toContain("future_job_we_havent_named_yet");
  });

  it("renders 'Pipeline degraded' when only the shared reply mailbox is the trigger", () => {
    // configured but not enabled → server rolls to "unhealthy" without
    // touching webhookFailureCount or cronJobs.
    const v = pillVisuals(
      "unhealthy",
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        sharedReplyConfigured: true,
        sharedReplyEnabled: false,
      }),
    );
    expect(v.label).toBe("Pipeline degraded");
    expect(v.title).toMatch(/shared reply mailbox/i);
  });

  it("falls through to a neutral 'Pipeline degraded' label when no sub-cause is identifiable", () => {
    // Defensive default: a future server-side trigger could roll to
    // unhealthy without any of the existing payload fields tipping us
    // off. The label MUST NOT regress to the misleading "Webhook
    // unhealthy" string in that case.
    const v = pillVisuals(
      "unhealthy",
      payload({ status: "unhealthy", webhookFailureCount: 0 }),
    );
    expect(v.label).toBe("Pipeline degraded");
  });

  it("never renders 'Webhook unhealthy' when webhookFailureCount === 0", () => {
    // Belt-and-suspenders against a future code path that would
    // accidentally re-introduce the false-blame label. Sweep across
    // every realistic combination of cron + shared-reply state.
    const combos = [
      payload({ status: "unhealthy", webhookFailureCount: 0 }),
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        cronJobs: [{ jobName: "email_intelligence_batch", status: "failing" }],
      }),
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        sharedReplyConfigured: true,
        sharedReplyEnabled: false,
      }),
      payload({
        status: "unhealthy",
        webhookFailureCount: 0,
        cronJobs: [{ jobName: "mailbox_delta_sync_poll", status: "stale" }],
        sharedReplyConfigured: true,
        sharedReplyEnabled: false,
      }),
    ];
    for (const p of combos) {
      const v = pillVisuals("unhealthy", p);
      expect(v.label).not.toBe("Webhook unhealthy");
    }
  });
});
