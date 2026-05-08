/**
 * Task #1153 — Runtime test pinning the won-quote toast `_handoff` /
 * `handoff` contract.
 *
 * `PATCH /api/customer-quotes/quote/:id` returns a quote-detail payload
 * with a routing-decision side-channel. The field name was renamed from
 * `_handoff` to `handoff`; `_handoff` is kept as a one-release
 * compatibility alias so old-server-new-client and new-server-old-client
 * both keep branching the markWon toast.
 *
 * `resolveMarkWonHandoff` is the pure helper the client uses inside
 * `markOutcomeMut.onSuccess` to pick the toast branch. This test pins:
 *   1. The three branches (auto / pending_approval / none) all resolve
 *      from the canonical `handoff` field.
 *   2. The `_handoff` alias is a fallback when `handoff` is missing.
 *   3. `handoff` wins when both fields are present (so a future server
 *      that drops the alias keeps working).
 *   4. Garbage payloads collapse to `null` so the caller falls through
 *      to the generic "Quote updated" toast (no silent crash).
 *
 * Run with: npx tsx tests/customer-quotes-handoff-toast-contract.test.ts
 */

import {
  resolveMarkWonHandoff,
  type MarkWonHandoff,
} from "../client/src/lib/customerQuotes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expectEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} — expected ${b} got ${a}`);
    failures.push(label);
    failed++;
  }
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  Customer Quotes — markWon handoff toast contract (Task #1153)");
console.log("══════════════════════════════════════════════════════════════");

// ── Branch 1: auto ─────────────────────────────────────────────────────────
console.log("── Branch: auto (canonical `handoff`) ──");
{
  const expected: MarkWonHandoff = { state: "auto", opportunityId: "opp-123" };
  expectEq(
    "canonical handoff.state=auto resolves to auto branch with opportunityId",
    resolveMarkWonHandoff({ handoff: { state: "auto", opportunityId: "opp-123" } }),
    expected,
  );
}

// ── Branch 2: pending_approval ─────────────────────────────────────────────
console.log("── Branch: pending_approval ──");
{
  const expected: MarkWonHandoff = { state: "pending_approval", opportunityId: "opp-456" };
  expectEq(
    "canonical handoff.state=pending_approval resolves to pending_approval branch",
    resolveMarkWonHandoff({ handoff: { state: "pending_approval", opportunityId: "opp-456" } }),
    expected,
  );
}

// ── Branch 3: none ─────────────────────────────────────────────────────────
console.log("── Branch: none ──");
{
  const expected: MarkWonHandoff = { state: "none", opportunityId: null };
  expectEq(
    "canonical handoff.state=none resolves to none branch with null opportunityId",
    resolveMarkWonHandoff({ handoff: { state: "none", opportunityId: null } }),
    expected,
  );
}

// ── Compatibility: `_handoff` alias still works for old servers ────────────
console.log("── Compatibility: `_handoff` alias fallback (old server + new client) ──");
{
  const expected: MarkWonHandoff = { state: "auto", opportunityId: "opp-legacy" };
  expectEq(
    "legacy `_handoff` (no canonical) resolves the auto branch",
    resolveMarkWonHandoff({ _handoff: { state: "auto", opportunityId: "opp-legacy" } }),
    expected,
  );
}
{
  const expected: MarkWonHandoff = { state: "pending_approval", opportunityId: "opp-legacy-2" };
  expectEq(
    "legacy `_handoff` (no canonical) resolves the pending_approval branch",
    resolveMarkWonHandoff({ _handoff: { state: "pending_approval", opportunityId: "opp-legacy-2" } }),
    expected,
  );
}
{
  const expected: MarkWonHandoff = { state: "none", opportunityId: null };
  expectEq(
    "legacy `_handoff` (no canonical) resolves the none branch",
    resolveMarkWonHandoff({ _handoff: { state: "none", opportunityId: null } }),
    expected,
  );
}

// ── Precedence: canonical wins when both are present ──────────────────────
console.log("── Precedence: canonical wins over alias ──");
{
  const expected: MarkWonHandoff = { state: "auto", opportunityId: "canonical-wins" };
  expectEq(
    "when both handoff and _handoff exist, canonical handoff wins",
    resolveMarkWonHandoff({
      handoff: { state: "auto", opportunityId: "canonical-wins" },
      _handoff: { state: "none", opportunityId: null },
    }),
    expected,
  );
}

// ── Falls through to null on missing / garbage ─────────────────────────────
console.log("── Garbage / missing payloads → null (generic toast) ──");
expectEq("null payload → null", resolveMarkWonHandoff(null), null);
expectEq("undefined payload → null", resolveMarkWonHandoff(undefined), null);
expectEq("empty object → null", resolveMarkWonHandoff({}), null);
expectEq(
  "non-object inside handoff → null",
  resolveMarkWonHandoff({ handoff: "auto" }),
  null,
);
expectEq(
  "unknown state value → null",
  resolveMarkWonHandoff({ handoff: { state: "weird" } }),
  null,
);
expectEq(
  "missing state on handoff → null (falls back to _handoff if usable)",
  resolveMarkWonHandoff({ handoff: { opportunityId: "x" } }),
  null,
);

// Empty-string opportunityId is normalised to null so the toast does not
// render a "View in AF" link pointing at /available-freight?opportunity=
{
  const expected: MarkWonHandoff = { state: "auto", opportunityId: null };
  expectEq(
    "empty-string opportunityId is normalised to null",
    resolveMarkWonHandoff({ handoff: { state: "auto", opportunityId: "" } }),
    expected,
  );
}

console.log("\n──────────────────────────────────────────────");
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log("──────────────────────────────────────────────\n");

if (failed > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
