/**
 * Task #631 — Unit tests for the unified contact-lock helper.
 *
 * Covers the pure pieces of logic exposed by `server/carrierContactLocks.ts`:
 *
 *   1. formatLaneLabel — produces the canonical "Origin → Destination" string
 *      that every send path persists into procurement_lane.
 *   2. normalizeContactLockSource — clamps unknown / null source_module values
 *      into the typed union without throwing.
 *   3. formatLockReason — renders the human suppression string with correct
 *      module label, age string, and rep-name handling (auto-pilot omits the
 *      actor name because the actor is the policy owner, not the sender).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatLaneLabel,
  formatLockReason,
  normalizeContactLockSource,
  type ContactLock,
} from "../carrierContactLocks";

function lock(partial: Partial<ContactLock> = {}): ContactLock {
  return {
    carrierId: "carrier-1",
    lastSentAt: new Date("2026-04-25T10:00:00Z"),
    source: "lwq",
    actorUserId: "user-1",
    actorName: "Sara Lin",
    matchedBy: "lane_id",
    outreachLogId: "log-1",
    ...partial,
  };
}

// ── formatLaneLabel ─────────────────────────────────────────────────────────

test("formatLaneLabel — returns canonical 'Origin → Destination' string", () => {
  assert.equal(
    formatLaneLabel("Chicago, IL", "Dallas, TX"),
    "Chicago, IL → Dallas, TX",
  );
});

test("formatLaneLabel — trims whitespace from both inputs", () => {
  assert.equal(
    formatLaneLabel("  Chicago, IL  ", "  Dallas, TX  "),
    "Chicago, IL → Dallas, TX",
  );
});

test("formatLaneLabel — returns null when origin is missing", () => {
  assert.equal(formatLaneLabel("", "Dallas, TX"), null);
  assert.equal(formatLaneLabel(null, "Dallas, TX"), null);
  assert.equal(formatLaneLabel(undefined, "Dallas, TX"), null);
});

test("formatLaneLabel — returns null when destination is missing", () => {
  assert.equal(formatLaneLabel("Chicago, IL", ""), null);
  assert.equal(formatLaneLabel("Chicago, IL", null), null);
  assert.equal(formatLaneLabel("Chicago, IL", undefined), null);
});

// ── normalizeContactLockSource ──────────────────────────────────────────────

test("normalizeContactLockSource — passes through known values", () => {
  for (const src of ["lwq", "af_wave", "auto_pilot", "single_carrier", "lwq_procurement", "lwq_adhoc"] as const) {
    assert.equal(normalizeContactLockSource(src), src);
  }
});

test("normalizeContactLockSource — clamps unknown to 'unknown'", () => {
  assert.equal(normalizeContactLockSource("garbage"), "unknown");
  assert.equal(normalizeContactLockSource(""), "unknown");
  assert.equal(normalizeContactLockSource(null), "unknown");
  assert.equal(normalizeContactLockSource(undefined), "unknown");
});

// ── formatLockReason ────────────────────────────────────────────────────────

test("formatLockReason — LWQ send by named rep includes actor name", () => {
  const now = new Date("2026-04-25T12:00:00Z");
  const reason = formatLockReason(lock({ source: "lwq", actorName: "Sara Lin" }), now);
  assert.equal(reason, "Contacted 2h ago via LWQ by Sara Lin");
});

test("formatLockReason — auto-pilot OMITS the actor name (policy owner ≠ sender)", () => {
  const now = new Date("2026-04-25T10:30:00Z");
  const reason = formatLockReason(
    lock({ source: "auto_pilot", actorName: "Manager Mike" }),
    now,
  );
  assert.equal(reason, "Contacted 30m ago via auto-pilot");
});

test("formatLockReason — Available Freight wave includes actor name", () => {
  const now = new Date("2026-04-25T11:00:00Z");
  const reason = formatLockReason(
    lock({ source: "af_wave", actorName: "Danny Beddes" }),
    now,
  );
  assert.equal(reason, "Contacted 1h ago via Available Freight by Danny Beddes");
});

test("formatLockReason — single-carrier email path renders correctly", () => {
  const now = new Date("2026-04-25T10:05:00Z");
  const reason = formatLockReason(
    lock({ source: "single_carrier", actorName: "Alex Shumway" }),
    now,
  );
  assert.equal(reason, "Contacted 5m ago via single-carrier email by Alex Shumway");
});

test("formatLockReason — anonymous actor (null name) drops the 'by …' clause", () => {
  const now = new Date("2026-04-25T10:30:00Z");
  const reason = formatLockReason(lock({ source: "lwq", actorName: null }), now);
  assert.equal(reason, "Contacted 30m ago via LWQ");
});

test("formatLockReason — age string switches m → h → d at the right thresholds", () => {
  const sentAt = new Date("2026-04-25T10:00:00Z");
  // < 1m
  assert.equal(
    formatLockReason(lock({ lastSentAt: sentAt, source: "lwq", actorName: null }), new Date("2026-04-25T10:00:30Z")),
    "Contacted just now via LWQ",
  );
  // 45m
  assert.equal(
    formatLockReason(lock({ lastSentAt: sentAt, source: "lwq", actorName: null }), new Date("2026-04-25T10:45:00Z")),
    "Contacted 45m ago via LWQ",
  );
  // 3h
  assert.equal(
    formatLockReason(lock({ lastSentAt: sentAt, source: "lwq", actorName: null }), new Date("2026-04-25T13:00:00Z")),
    "Contacted 3h ago via LWQ",
  );
  // > 48h flips to days
  assert.equal(
    formatLockReason(lock({ lastSentAt: sentAt, source: "lwq", actorName: null }), new Date("2026-04-28T10:00:00Z")),
    "Contacted 3d ago via LWQ",
  );
});

test("formatLockReason — unknown source falls back to generic 'outreach'", () => {
  const now = new Date("2026-04-25T11:00:00Z");
  const reason = formatLockReason(
    lock({ source: "unknown", actorName: "Sara Lin" }),
    now,
  );
  assert.equal(reason, "Contacted 1h ago via outreach by Sara Lin");
});

test("formatLockReason — LWQ procurement renders module name correctly", () => {
  const now = new Date("2026-04-25T11:00:00Z");
  const reason = formatLockReason(
    lock({ source: "lwq_procurement", actorName: "Sara Lin" }),
    now,
  );
  assert.equal(reason, "Contacted 1h ago via LWQ procurement by Sara Lin");
});
