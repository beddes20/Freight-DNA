/**
 * Unit test for the AI helper status collector — verifies the
 * "level up" honesty pass: helpers that previously returned `null` now
 * record a status, and the bag returned to the route handler reflects
 * the worst observed signal per category.
 *
 * Why this matters: the Intel page renders a degraded banner *only* when
 * a category's status is non-ok. Regressing the precedence rules (e.g. an
 * `ok` call later being downgraded by a `failed` retry) would flip the
 * banner on for users with a perfectly-working AI surface.
 */
import {
  withAiStatusContext,
  recordAiStatus,
  isAnyDegraded,
  type AiStatusBag,
} from "../server/lib/aiHelperStatus";
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.error(`  ✗ ${name}`); console.error(err); });
}

async function run() {
  console.log("AI helper status collector");

  await test("recordAiStatus is a no-op outside a context", () => {
    // Should not throw. There's no bag to assert against; the contract is
    // simply that helpers stay safe to call from cron jobs / workers.
    recordAiStatus("alert_narrative", "failed", "test");
  });

  await test("withAiStatusContext collects ok signals", async () => {
    const { aiStatus } = await withAiStatusContext(async () => {
      recordAiStatus("alert_narrative", "ok");
      recordAiStatus("market_context", "ok");
      return null;
    });
    assert.equal(aiStatus.alert_narrative?.status, "ok");
    assert.equal(aiStatus.market_context?.status, "ok");
    assert.equal(isAnyDegraded(aiStatus), false);
  });

  await test("unconfigured > failed > empty in severity ranking", async () => {
    const { aiStatus } = await withAiStatusContext(async () => {
      recordAiStatus("alert_narrative", "empty");
      recordAiStatus("alert_narrative", "failed", "openai 503");
      recordAiStatus("alert_narrative", "unconfigured", "no key");
      return null;
    });
    assert.equal(aiStatus.alert_narrative?.status, "unconfigured");
    assert.equal(aiStatus.alert_narrative?.reason, "no key");
    assert.equal(aiStatus.alert_narrative?.count, 3);
    assert.equal(isAnyDegraded(aiStatus), true);
  });

  await test("any ok in a category locks status as ok", async () => {
    const { aiStatus } = await withAiStatusContext(async () => {
      recordAiStatus("lane_narrative", "failed", "claude timeout");
      recordAiStatus("lane_narrative", "ok");
      recordAiStatus("lane_narrative", "unconfigured", "key removed?");
      return null;
    });
    assert.equal(aiStatus.lane_narrative?.status, "ok");
    assert.equal(aiStatus.lane_narrative?.reason, undefined);
    assert.equal(aiStatus.lane_narrative?.count, 3);
  });

  await test("isAnyDegraded distinguishes empty bag from degraded bag", () => {
    assert.equal(isAnyDegraded(undefined), false);
    assert.equal(isAnyDegraded({}), false);
    const ok: AiStatusBag = { alert_narrative: { status: "ok", count: 1 } };
    assert.equal(isAnyDegraded(ok), false);
    const bad: AiStatusBag = {
      alert_narrative: { status: "ok", count: 1 },
      executive_brief: { status: "failed", count: 1 },
    };
    assert.equal(isAnyDegraded(bad), true);
  });

  await test("contexts are isolated across concurrent calls", async () => {
    const [a, b] = await Promise.all([
      withAiStatusContext(async () => {
        await new Promise(r => setTimeout(r, 5));
        recordAiStatus("alert_narrative", "unconfigured", "ctx-a");
        return "a";
      }),
      withAiStatusContext(async () => {
        recordAiStatus("alert_narrative", "ok");
        await new Promise(r => setTimeout(r, 10));
        return "b";
      }),
    ]);
    assert.equal(a.aiStatus.alert_narrative?.status, "unconfigured");
    assert.equal(a.aiStatus.alert_narrative?.reason, "ctx-a");
    assert.equal(b.aiStatus.alert_narrative?.status, "ok");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
