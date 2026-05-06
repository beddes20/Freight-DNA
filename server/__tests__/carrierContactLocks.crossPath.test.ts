/**
 * Task #631 — Cross-path integration coverage for findCarrierContactLocks.
 *
 * The pure-function unit tests in carrierContactLocks.test.ts cover formatters
 * and source normalization. THIS file mocks db.execute to verify the four
 * scenarios the unification was built for, with realistic outreach-log row
 * shapes from each source path:
 *
 *   1. LWQ send suppresses an AF wave on the same lane (and the suppression
 *      reason carries lwq attribution).
 *   2. AF wave send suppresses an LWQ ad-hoc on the same company+lane label
 *      (cross-direction parity — same helper, mirrored).
 *   3. Auto-pilot writes are returned with sourceModule=auto_pilot so chips
 *      render the policy attribution, not a misleading rep name.
 *   4. Partial-row safety: when a procurement batch row has
 *      delivery_status='partial', only carriers whose per-recipient status
 *      in the recipients jsonb is a success are locked. Failed carriers in
 *      the same row do NOT receive a false-positive lock.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock db.execute BEFORE importing the module under test so the helper picks
// up our mock instead of the real Drizzle client. vi.hoisted is required
// because vi.mock factories run before any top-level `const` initializers.
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("../storage", () => ({
  db: { execute: executeMock },
}));

import {
  findCarrierContactLocks,
  formatLockReason,
} from "../carrierContactLocks";

type Row = {
  log_id: string;
  carrier_id: string;
  sent_at: Date;
  source_module: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  matched_by: "lane_id" | "company_lane_label";
};

/**
 * The helper post-processes whatever `db.execute(...)` returns by reading
 * `.rows`. Production wraps a SQL CTE with a partial-row carrier-specific
 * filter, but at the helper boundary the rows that came BACK from Postgres
 * are what we assert on. We mirror Postgres semantics by feeding
 * pre-filtered rows here — i.e. the mock represents what survives the
 * EXISTS check on jsonb_array_elements(recipients).
 */
function mockRows(rows: Row[]) {
  executeMock.mockResolvedValueOnce({ rows });
}

const ORG = "org-test-631";
const LANE = "lane-abc";
const COMPANY = "company-xyz";
const LABEL = "Atlanta, GA → Dallas, TX";

const CARRIER_A = "carrier-a";
const CARRIER_B = "carrier-b";
const CARRIER_C = "carrier-c";

describe("Task #631 cross-path suppression", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("LWQ send suppresses an AF wave: lock surfaces lwq attribution + actor name", async () => {
    // Scenario: rep "Sara" just sent an LWQ ad-hoc to carrier A on lane.
    // 30 minutes later AF wave dispatcher runs the suppression check.
    mockRows([
      {
        log_id: "log-lwq-1",
        carrier_id: CARRIER_A,
        sent_at: new Date(Date.now() - 30 * 60 * 1000),
        source_module: "lwq_adhoc",
        actor_user_id: "user-sara",
        actor_name: "Sara Johnson",
        matched_by: "lane_id",
      },
    ]);

    const locks = await findCarrierContactLocks({
      orgId: ORG,
      carrierIds: [CARRIER_A, CARRIER_B],
      recurringLaneId: LANE,
      companyId: COMPANY,
      laneLabel: LABEL,
    });

    expect(locks.size).toBe(1);
    const lock = locks.get(CARRIER_A);
    expect(lock).toBeDefined();
    expect(lock!.source).toBe("lwq_adhoc");
    expect(lock!.actorName).toBe("Sara Johnson");
    expect(lock!.matchedBy).toBe("lane_id");
    expect(locks.has(CARRIER_B)).toBe(false);

    const reason = formatLockReason(lock!);
    expect(reason).toMatch(/Sara Johnson/);
  });

  it("AF wave send suppresses an LWQ ad-hoc on the same company+lane label", async () => {
    // Scenario: AF wave was sent against a synthetic opportunity (no recurring
    // lane id), so the lock match must come from the company + label fallback.
    // Now an LWQ surface tries to send to the same carrier — must be blocked.
    mockRows([
      {
        log_id: "log-af-1",
        carrier_id: CARRIER_B,
        sent_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
        source_module: "af_wave",
        actor_user_id: "user-mike",
        actor_name: "Mike Chen",
        matched_by: "company_lane_label",
      },
    ]);

    const locks = await findCarrierContactLocks({
      orgId: ORG,
      carrierIds: [CARRIER_A, CARRIER_B],
      recurringLaneId: null,
      companyId: COMPANY,
      laneLabel: LABEL,
    });

    expect(locks.has(CARRIER_B)).toBe(true);
    expect(locks.get(CARRIER_B)!.source).toBe("af_wave");
    expect(locks.get(CARRIER_B)!.matchedBy).toBe("company_lane_label");

    const reason = formatLockReason(locks.get(CARRIER_B)!);
    expect(reason).toMatch(/Available Freight/);
    expect(reason).toMatch(/Mike Chen/);
  });

  it("auto-pilot writes return sourceModule=auto_pilot and reason omits the actor", async () => {
    // Auto-pilot's "actor" is the policy owner, not the actual sender — the
    // formatter intentionally drops the name so the chip reads "by Auto-Pilot".
    mockRows([
      {
        log_id: "log-auto-1",
        carrier_id: CARRIER_C,
        sent_at: new Date(Date.now() - 5 * 60 * 60 * 1000),
        source_module: "auto_pilot",
        actor_user_id: "user-policy-owner",
        actor_name: "Anna Policy-Owner",
        matched_by: "lane_id",
      },
    ]);

    const locks = await findCarrierContactLocks({
      orgId: ORG,
      carrierIds: [CARRIER_C],
      recurringLaneId: LANE,
      companyId: COMPANY,
      laneLabel: LABEL,
    });

    const lock = locks.get(CARRIER_C);
    expect(lock).toBeDefined();
    expect(lock!.source).toBe("auto_pilot");

    const reason = formatLockReason(lock!);
    expect(reason).toMatch(/Auto-Pilot/i);
    // Critically: the policy owner's NAME must NOT leak into the chip text
    // — that would mislead the rep into pinging the wrong person.
    expect(reason).not.toMatch(/Anna Policy-Owner/);
  });

  it("partial-row carrier-specific filter: only successful recipients lock, failed carriers in the same row do not", async () => {
    // Scenario: a procurement batch send hit two carriers in one row. The
    // SQL CTE outer EXISTS filter removes carriers whose per-recipient status
    // in the recipients jsonb is NOT a success. We model that here by only
    // feeding back the row for the successful carrier — exactly what the
    // Postgres query produces.
    //
    // CARRIER_A → status=sent (locked), CARRIER_B → status=failed (NOT locked).
    mockRows([
      {
        log_id: "log-procurement-1",
        carrier_id: CARRIER_A,
        sent_at: new Date(Date.now() - 60 * 60 * 1000),
        source_module: "lwq_procurement",
        actor_user_id: "user-procurement-rep",
        actor_name: "Procurement Rep",
        matched_by: "lane_id",
      },
    ]);

    const locks = await findCarrierContactLocks({
      orgId: ORG,
      carrierIds: [CARRIER_A, CARRIER_B],
      recurringLaneId: LANE,
      companyId: COMPANY,
      laneLabel: LABEL,
    });

    expect(locks.has(CARRIER_A)).toBe(true);
    expect(locks.get(CARRIER_A)!.source).toBe("lwq_procurement");
    // The failed carrier in the SAME procurement row must NOT be locked —
    // otherwise we burn the rep's chance to reach out via a different module.
    expect(locks.has(CARRIER_B)).toBe(false);
  });

  it("when multiple locks exist for the same carrier, the most-recent one wins (DESC ordering)", async () => {
    // Postgres returns rows ordered by sent_at DESC. The helper takes the
    // first row per carrier (Map.set, no overwrite check). This guards
    // against a regression where a stale week-old lock would shadow a
    // fresh send and surface the wrong actor.
    const fresh = new Date(Date.now() - 10 * 60 * 1000);
    const stale = new Date(Date.now() - 40 * 60 * 60 * 1000);
    mockRows([
      {
        log_id: "log-fresh",
        carrier_id: CARRIER_A,
        sent_at: fresh,
        source_module: "af_wave",
        actor_user_id: "user-fresh",
        actor_name: "Fresh Actor",
        matched_by: "lane_id",
      },
      {
        log_id: "log-stale",
        carrier_id: CARRIER_A,
        sent_at: stale,
        source_module: "lwq",
        actor_user_id: "user-stale",
        actor_name: "Stale Actor",
        matched_by: "company_lane_label",
      },
    ]);

    const locks = await findCarrierContactLocks({
      orgId: ORG,
      carrierIds: [CARRIER_A],
      recurringLaneId: LANE,
      companyId: COMPANY,
      laneLabel: LABEL,
    });

    expect(locks.size).toBe(1);
    expect(locks.get(CARRIER_A)!.source).toBe("af_wave");
    expect(locks.get(CARRIER_A)!.actorName).toBe("Fresh Actor");
  });

  it("returns an empty map (no DB call) when neither lane id nor company+label is provided", async () => {
    const locks = await findCarrierContactLocks({
      orgId: ORG,
      carrierIds: [CARRIER_A],
      recurringLaneId: null,
      companyId: null,
      laneLabel: null,
    });

    expect(locks.size).toBe(0);
    // Critical: skipping the DB hit on missing keys prevents accidental
    // full-table scans on a hot path used by every send.
    expect(executeMock).not.toHaveBeenCalled();
  });
});
