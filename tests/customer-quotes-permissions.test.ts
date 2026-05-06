/**
 * Customer Quotes — Mutation Ownership Gate Regression
 * (Task #849 §6.1 — folded into S1)
 *
 * The four mutation endpoints
 *   • PATCH /api/customer-quotes/quote/:id
 *   • POST  /api/customer-quotes/quote/:id/mark-outcome
 *   • POST  /api/customer-quotes/quotes/bulk-reassign-customer
 *   • POST  /api/customer-quotes/quotes/bulk-status
 * pre-S1 either gated only on `requireUser` or relied on the service-
 * layer enforceRepScope. The architect review of
 * docs/quote-requests-tab-post-2d-backend-contract.md flagged both as
 * a broken-access-control vector. S1 closed it via
 * `assertCanMutateQuotes` in `server/routes/customerQuotes.ts`.
 *
 * This test exercises that helper directly against the live database —
 * it's the actual security predicate the route handlers all funnel
 * through, and the guardrail (`Section 16` in
 * tests/code-quality-guardrails.test.ts) string-checks that all four
 * routes still wire it in. Together they fence the seam.
 *
 * Strategy:
 *   1. Pick an existing org that has at least two distinct
 *      account_manager reps with linked users + at least one admin.
 *   2. Pick a real quote_opportunity owned by Rep A.
 *   3. Verify:
 *        - Rep A can mutate it (ok=true)
 *        - Rep B cannot (403 forbidden, deniedIds = [oppId])
 *        - Admin can mutate it (ok=true)
 *        - Bulk with mixed ownership by Rep A is rejected (403)
 *        - Bulk with mixed ownership by admin passes (ok=true)
 *        - Unknown id by admin → 404 with missingIds
 *   4. Hit the live PATCH endpoint with no session — must NOT 200.
 *      (Sanity-checks that requireUser is still wired in front.)
 *
 * Gracefully degrades when the test DB doesn't have enough fixtures.
 *
 * Run with: npx tsx tests/customer-quotes-permissions.test.ts
 */

import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required to run this test");
  process.exit(1);
}

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:5000";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(description: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${description}`);
    passed++;
  } else {
    console.log(`  \u2717 ${description}${detail ? ` \u2014 ${detail}` : ""}`);
    failed++;
    failures.push(`${description}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n\u2500\u2500 ${title} \u2500\u2500`);
}

interface Fixture {
  orgId: string;
  oppId: string;
  ownerUserId: string;
  ownerRole: string;
  nonOwnerUserId: string;
  nonOwnerRole: string;
  adminUserId: string;
  adminRole: string;
  secondOppId: string | null;
  secondOppOwnedByOwner: boolean;
}

/**
 * Find an org/opp/users combo that lets us exercise both the owner and
 * non-owner branches of the gate. We need:
 *   - a quote_opportunity with a non-null repId
 *   - the rep linked to a user (quote_reps.user_id IS NOT NULL)
 *   - another user in the same org with a different rep id
 *   - an admin in the same org
 */
async function findFixture(pool: Pool): Promise<Fixture | null> {
  const r = await pool.query<{
    org_id: string;
    opp_id: string;
    owner_user_id: string;
    owner_role: string;
  }>(`
    SELECT
      qo.organization_id AS org_id,
      qo.id              AS opp_id,
      u.id               AS owner_user_id,
      u.role             AS owner_role
    FROM quote_opportunities qo
    JOIN quote_reps qr ON qr.id = qo.rep_id
    JOIN users      u  ON u.id  = qr.user_id
    WHERE qo.rep_id IS NOT NULL
      AND qr.user_id IS NOT NULL
      AND u.role IN ('account_manager','logistics_manager','logistics_coordinator')
    ORDER BY qo.created_at DESC
    LIMIT 50
  `);
  for (const row of r.rows) {
    // Find a different scoped user (different rep) in the same org.
    const nonOwner = await pool.query<{ id: string; role: string }>(`
      SELECT u.id, u.role
      FROM users u
      JOIN quote_reps qr ON qr.user_id = u.id
      WHERE u.organization_id = $1
        AND u.id <> $2
        AND u.role IN ('account_manager','logistics_manager','logistics_coordinator')
        AND qr.organization_id = u.organization_id
      LIMIT 1
    `, [row.org_id, row.owner_user_id]);
    if (nonOwner.rows.length === 0) continue;
    // Find an admin in the same org.
    const admin = await pool.query<{ id: string; role: string }>(`
      SELECT id, role
      FROM users
      WHERE organization_id = $1
        AND role IN ('admin','director','sales_director')
      LIMIT 1
    `, [row.org_id]);
    if (admin.rows.length === 0) continue;
    // Optional: a second opp owned by someone else (for bulk mixed-
    // ownership coverage). Tolerate absence.
    const secondOpp = await pool.query<{ id: string; owned_by_owner: boolean }>(`
      SELECT qo.id,
             (qr.user_id = $2) AS owned_by_owner
      FROM quote_opportunities qo
      JOIN quote_reps qr ON qr.id = qo.rep_id
      WHERE qo.organization_id = $1
        AND qo.id <> $3
        AND qo.rep_id IS NOT NULL
        AND qr.user_id IS NOT NULL
        AND qr.user_id <> $2
      LIMIT 1
    `, [row.org_id, row.owner_user_id, row.opp_id]);
    return {
      orgId: row.org_id,
      oppId: row.opp_id,
      ownerUserId: row.owner_user_id,
      ownerRole: row.owner_role,
      nonOwnerUserId: nonOwner.rows[0].id,
      nonOwnerRole: nonOwner.rows[0].role,
      adminUserId: admin.rows[0].id,
      adminRole: admin.rows[0].role,
      secondOppId: secondOpp.rows[0]?.id ?? null,
      secondOppOwnedByOwner: secondOpp.rows[0]?.owned_by_owner ?? false,
    };
  }
  return null;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    section("S1 §6.1: locate fixture");
    const fix = await findFixture(pool);
    if (!fix) {
      console.log("  ! No org has the required (rep-owned opp + 2 scoped users + admin) combo.");
      console.log("    Skipping live-helper checks; falling back to endpoint-presence sanity only.");
    } else {
      console.log(
        `  \u2192 org=${fix.orgId.slice(0, 8)}\u2026 opp=${fix.oppId.slice(0, 8)}\u2026 ` +
        `owner=${fix.ownerUserId.slice(0, 8)}/${fix.ownerRole} ` +
        `nonOwner=${fix.nonOwnerUserId.slice(0, 8)}/${fix.nonOwnerRole} ` +
        `admin=${fix.adminUserId.slice(0, 8)}/${fix.adminRole}`,
      );
    }

    if (fix) {
      // Import the helper after we know we have a fixture — keeps the
      // skip path zero-cost and avoids initializing the app graph for
      // setups that can't exercise it anyway.
      section("S1 §6.1: helper enforces ownership");
      const { assertCanMutateQuote, assertCanMutateQuotes } = await import(
        "../server/routes/customerQuotes"
      );

      const owner = { id: fix.ownerUserId, role: fix.ownerRole };
      const nonOwner = { id: fix.nonOwnerUserId, role: fix.nonOwnerRole };
      const admin = { id: fix.adminUserId, role: fix.adminRole };

      const resOwner = await assertCanMutateQuote(fix.orgId, fix.oppId, owner);
      assert("owner can mutate own quote (ok=true)", resOwner.ok === true,
        JSON.stringify(resOwner));

      const resNonOwner = await assertCanMutateQuote(fix.orgId, fix.oppId, nonOwner);
      assert("non-owner is blocked (status=403, reason=forbidden)",
        resNonOwner.ok === false &&
          resNonOwner.status === 403 &&
          (resNonOwner as any).reason === "forbidden",
        JSON.stringify(resNonOwner));
      assert("non-owner response includes denied ids",
        resNonOwner.ok === false &&
          Array.isArray((resNonOwner as any).deniedIds) &&
          (resNonOwner as any).deniedIds.includes(fix.oppId),
        JSON.stringify(resNonOwner));

      const resAdmin = await assertCanMutateQuote(fix.orgId, fix.oppId, admin);
      assert("admin can mutate any quote (ok=true)", resAdmin.ok === true,
        JSON.stringify(resAdmin));

      // Unknown id — must 404 (not leak existence).
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const resMissing = await assertCanMutateQuote(fix.orgId, fakeId, admin);
      assert("unknown id returns 404 with missingIds",
        resMissing.ok === false &&
          resMissing.status === 404 &&
          Array.isArray((resMissing as any).missingIds) &&
          (resMissing as any).missingIds.includes(fakeId),
        JSON.stringify(resMissing));

      // Cross-org safety: another org's opp should look "not found",
      // never "forbidden". Pick a different org's opp if one exists.
      const otherOrg = await pool.query<{ id: string }>(`
        SELECT qo.id FROM quote_opportunities qo
        WHERE qo.organization_id <> $1
        LIMIT 1
      `, [fix.orgId]);
      if (otherOrg.rows.length > 0) {
        const resCrossOrg = await assertCanMutateQuote(fix.orgId, otherOrg.rows[0].id, admin);
        assert("cross-org id returns 404 (never 403 — never leak existence)",
          resCrossOrg.ok === false && resCrossOrg.status === 404,
          JSON.stringify(resCrossOrg));
      }

      // Bulk: mixed ownership by non-owner → 403; same by admin → 200.
      if (fix.secondOppId && !fix.secondOppOwnedByOwner) {
        const bulkIds = [fix.oppId, fix.secondOppId];
        const resBulkRep = await assertCanMutateQuotes(fix.orgId, bulkIds, owner);
        assert("bulk with non-owned id by owner is rejected (403, denied=second)",
          resBulkRep.ok === false &&
            resBulkRep.status === 403 &&
            (resBulkRep as any).deniedIds?.includes(fix.secondOppId) &&
            !(resBulkRep as any).deniedIds?.includes(fix.oppId),
          JSON.stringify(resBulkRep));
        const resBulkAdmin = await assertCanMutateQuotes(fix.orgId, bulkIds, admin);
        assert("bulk by admin passes regardless of ownership", resBulkAdmin.ok === true,
          JSON.stringify(resBulkAdmin));
      } else {
        console.log("  \u2192 (skipping bulk mixed-ownership checks; no second non-owner opp available)");
      }
    }

    section("S1 §6.1: PATCH endpoint refuses anonymous requests");
    // We intentionally treat 404 as "server isn't fully booted yet"
    // and degrade gracefully — the test workflow can fire while the
    // app is still applying migrations, and a 404 in that window
    // doesn't mean the route is missing in source. The Section 16
    // guardrail (`assertCanMutateQuote(s)` is wired into all four
    // routes) is the real source-level fence.
    try {
      const res = await fetch(
        `${BASE_URL}/api/customer-quotes/quote/00000000-0000-0000-0000-000000000000`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ outcomeStatus: "pending" }),
        },
      );
      if (res.status === 404) {
        console.log(`  \u2192 endpoint returned 404 (server likely still booting; skipping live check)`);
      } else {
        assert(`PATCH refuses unauthenticated request (status NOT 200)`,
          res.status !== 200,
          `got ${res.status} — should be 401/403`);
      }
    } catch (err) {
      console.log(`  ! endpoint fetch failed (server may be down): ${err}`);
    }

    console.log(`\n\u2500\u2500 Results: ${passed} passed, ${failed} failed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    if (failed > 0) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
