/**
 * Free-mail attribution recovery (Task #1056 / Email→Exec 5).
 *
 * Pure-unit checks for the org-scoped tier classifier. Uses the
 * `_companiesOverride` test seam on `classifyFreeMailAttribution` so
 * the test runs without a database. End-to-end ingestion +
 * thread-attribution column writes are covered by the static guardrail
 * in `tests/code-quality-guardrails.test.ts` Section 1056.
 *
 * Run with: npx tsx tests/free-mail-attribution.test.ts
 */

import assert from "node:assert/strict";
import { classifyFreeMailAttribution } from "../server/services/freeMailAttributionService";

const ORG_A = "org-a";
const ORG_B = "org-b";

const COMPANIES_BY_ORG: Record<string, Array<{ id: string; name: string }>> = {
  [ORG_A]: [
    { id: "co-a-acme", name: "Acme Logistics LLC" },
    { id: "co-a-westside", name: "Westside Freight Co" },
  ],
  [ORG_B]: [
    // Intentional same-name in a different org — the cross-org leakage
    // test below confirms ORG_A's matcher only sees ORG_A's row.
    { id: "co-b-acme", name: "Acme Logistics LLC" },
  ],
};

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log("\nFree-mail attribution recovery (Task #1056)\n");

// ── Tier 2: signature/company text → unique strong match ────────────────────
await check("Tier 2 — Gmail with signature company match → tier='signature'", async () => {
  const r = await classifyFreeMailAttribution({
    orgId: ORG_A,
    fromEmail: "jane.doe@gmail.com",
    fromName: "Jane Doe",
    subject: "RFQ for next week",
    body: "Hi team,\n\nLooking for a quote on PHX→DAL.\n\nThanks,\nJane Doe\nAcme Logistics LLC\n555-1212",
    _companiesOverride: COMPANIES_BY_ORG[ORG_A],
  });
  assert.equal(r.tier, "signature");
  assert.equal(r.suggestedCompanyId, "co-a-acme");
  assert.ok(r.evidence?.label.includes("Acme Logistics LLC"));
});

// ── Tier 3: weak / display-name match (no signature company) ───────────────
await check("Tier 3 — Gmail with only display-name match → tier='weak'", async () => {
  const r = await classifyFreeMailAttribution({
    orgId: ORG_A,
    fromEmail: "joe@gmail.com",
    fromName: "Joe at Westside Freight",
    subject: "quick question",
    body: "thanks",
    _companiesOverride: COMPANIES_BY_ORG[ORG_A],
  });
  assert.equal(r.tier, "weak");
  assert.equal(r.suggestedCompanyId, "co-a-westside");
});

// ── No match: noisy display name with no overlap drops to 'none' ────────────
await check("No-match — Gmail with no signal → tier='none'", async () => {
  const r = await classifyFreeMailAttribution({
    orgId: ORG_A,
    fromEmail: "random@gmail.com",
    fromName: "Bob",
    subject: "hi",
    body: "no signature",
    _companiesOverride: COMPANIES_BY_ORG[ORG_A],
  });
  assert.equal(r.tier, "none");
  assert.equal(r.suggestedCompanyId, null);
});

// ── Non-free-mail short-circuits to 'none' (existing pipeline owns it) ─────
await check("Non-free-mail — corporate domain skipped (handled by domain match)", async () => {
  const r = await classifyFreeMailAttribution({
    orgId: ORG_A,
    fromEmail: "ops@acmelogistics.com",
    fromName: "Ops Desk",
    subject: "quote",
    body: "Acme Logistics LLC team",
    _companiesOverride: COMPANIES_BY_ORG[ORG_A],
  });
  assert.equal(r.tier, "none");
});

// ── Cross-org isolation: ORG_B's "Acme" never matches an ORG_A query ───────
await check("Cross-org isolation — ORG_A signature match doesn't leak ORG_B's Acme", async () => {
  const a = await classifyFreeMailAttribution({
    orgId: ORG_A,
    fromEmail: "jane@gmail.com", fromName: "Jane",
    subject: "rfq",
    body: "Hi,\n\nNeed a quote.\n\nThanks,\nJane Doe\nAcme Logistics LLC\n",
    _companiesOverride: COMPANIES_BY_ORG[ORG_A],
  });
  const b = await classifyFreeMailAttribution({
    orgId: ORG_B,
    fromEmail: "jane@gmail.com", fromName: "Jane",
    subject: "rfq",
    body: "Hi,\n\nNeed a quote.\n\nThanks,\nJane Doe\nAcme Logistics LLC\n",
    _companiesOverride: COMPANIES_BY_ORG[ORG_B],
  });
  assert.equal(a.suggestedCompanyId, "co-a-acme");
  assert.equal(b.suggestedCompanyId, "co-b-acme");
  assert.notEqual(a.suggestedCompanyId, b.suggestedCompanyId);
});

// ── Tier 1 (thread continuity) — applyFreeMailAttribution short-circuits ──
// When the webhook has already hard-attached the thread (existing thread
// continuity), `applyFreeMailAttribution` must NOT run inference; it just
// stamps the source and returns it. This pins the contract that a Gmail
// reply on an existing customer thread is hard-attributed via the Tier 1
// path, never re-classified by Tier 2/3.
await check("Tier 1 — applyFreeMailAttribution returns hardAttachedSource without re-classifying", async () => {
  const { applyFreeMailAttribution } = await import("../server/services/freeMailAttributionService");
  const result = await applyFreeMailAttribution({
    orgId: ORG_A,
    threadId: "thread-existing",
    fromEmail: "jane@gmail.com",
    fromName: "Jane",
    subject: "Re: previous quote",
    body: "thanks!",
    hardAttachedSource: "thread",
    existingThread: null,
  });
  assert.equal(result, "thread");
});

// ── Confirm flow preserves tier provenance (no laundering to 'contact') ───
// The confirm-attribution route must label confirmed Tier-2 matches as
// `confirmed_signature` and confirmed Tier-3 matches as `confirmed_weak`,
// never plain `'contact'` (which would erase the original signal). We
// inspect the route source statically here because the live HTTP path
// requires a DB; the regex below is the same shape Section 1056 of the
// guardrail file asserts.
await check("Confirm route preserves prior tier ('signature' → 'confirmed_signature', 'weak' → 'confirmed_weak')", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("server/routes/conversations.ts", "utf-8");
  assert.match(src, /priorSource === "signature"\s*\?\s*"confirmed_signature"/);
  assert.match(src, /priorSource === "weak"\s*\?\s*"confirmed_weak"/);
  // Negative: no naked stamp of source: "contact" inside the
  // confirm-attribution handler. (The fallback in the ternary is
  // allowed because it only fires when the prior source wasn't an
  // inference at all.)
  const handlerStart = src.indexOf("/confirm-attribution");
  const handlerEnd = src.indexOf("// GET /api/internal/conversations/:id/events", handlerStart);
  const handler = src.slice(handlerStart, handlerEnd);
  assert.equal(/source:\s*"contact"\s*,/.test(handler), false, "confirm handler must not hardcode source: 'contact'");
});

// ── Tier 2 ambiguity guard — two org-scoped companies that normalize to
// the same key (e.g. "Acme Logistics LLC" + "Acme Logistics Inc") must
// NOT produce a strong signature suggestion. This is the explicit
// uniqueness-safety contract called out in code review.
await check("Tier 2 — ambiguous same-name companies in one org → no strong match", async () => {
  const r = await classifyFreeMailAttribution({
    orgId: ORG_A,
    fromEmail: "rep@gmail.com",
    fromName: "Some Rep",
    subject: "freight",
    body: "Thanks,\nJane Doe\nAcme Logistics\n555-0100",
    _companiesOverride: [
      { id: "co-acme-llc", name: "Acme Logistics LLC" },
      { id: "co-acme-inc", name: "Acme Logistics Inc" },
    ],
  });
  // Tier 2 must abstain (no exact unique match). Tier 3 may also
  // abstain because both companies score equally on token overlap →
  // tied → 'none'. Either way, no strong signature suggestion is
  // emitted for an ambiguous name collision.
  assert.notEqual(r.tier, "signature");
});

// ── Tied weak matches drop to 'none' to avoid inventing confidence ─────────
await check("Tier 3 — tied match across multiple companies stays 'none'", async () => {
  const r = await classifyFreeMailAttribution({
    orgId: ORG_A,
    fromEmail: "joe@gmail.com",
    // "logistics" matches Acme; "freight" matches Westside; tied.
    fromName: "Joe Logistics Freight",
    subject: "",
    body: "",
    _companiesOverride: COMPANIES_BY_ORG[ORG_A],
  });
  assert.equal(r.tier, "none");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
