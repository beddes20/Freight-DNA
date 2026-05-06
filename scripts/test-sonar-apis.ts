/**
 * SONAR API Test Harness — Task #254
 *
 * Exercises the SONAR client functions directly (server-side, no HTTP layer)
 * and reports timing, response shape, and any failures.
 */

import * as fs from "fs";
const LOGFILE = "/tmp/sonar-test.log";
fs.writeFileSync(LOGFILE, `[${new Date().toISOString()}] script booting...\n`);
function flog(s: string) {
  fs.appendFileSync(LOGFILE, s + "\n");
}
console.log = (...args: unknown[]) => fs.appendFileSync(LOGFILE, args.map((a) => String(a)).join(" ") + "\n");
console.error = console.log;
flog(`[${new Date().toISOString()}] imports starting`);

import {
  getNationalMarketSummary,
  getMarketOtris,
  getLaneVotri,
  getLaneVotrisBatch,
  getLaneMarketRate,
  getSonarCircuitBreakerStatus,
  buildVotriQualifier,
} from "../server/sonarClient";
import { getPerplexityMarketContext } from "../server/aiHelpers";

const RESULTS: Array<{ test: string; status: "PASS" | "FAIL" | "WARN"; ms: number; note: string }> = [];

type Timed<T> = { result: T; ms: number };

async function timed<T>(name: string, fn: () => Promise<T>): Promise<Timed<T> | null> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, ms: Date.now() - t0 };
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    RESULTS.push({ test: name, status: "FAIL", ms, note: `EXCEPTION: ${msg}` });
    return null;
  }
}

function record(name: string, status: "PASS" | "FAIL" | "WARN", ms: number, note: string) {
  RESULTS.push({ test: name, status, ms, note });
}

function fmt(n: number | null | undefined, suffix = ""): string {
  if (n === null || n === undefined) return "null";
  return `${typeof n === "number" ? n.toFixed(2) : n}${suffix}`;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}
process.on("uncaughtException", (e) => { flog(`UNCAUGHT: ${describeError(e)}`); process.exit(99); });
process.on("unhandledRejection", (e) => { flog(`UNHANDLED: ${describeError(e)}`); process.exit(98); });

async function main() {
  flog("\n========== SONAR API DIAGNOSTIC (Task #254) ==========");
  flog(`Started: ${new Date().toISOString()}`);

  // ── ENV CHECK ────────────────────────────────────────────────────────────
  const fwToken = process.env.FREIGHTWAVES_TOKEN;
  const sUser   = process.env.SONAR_USERNAME;
  const sPass   = process.env.SONAR_PASSWORD;
  const ppx     = process.env.PERPLEXITY_API_KEY;

  console.log("\n--- ENV VARS ---");
  console.log(`FREIGHTWAVES_TOKEN:  ${fwToken ? `set (${fwToken.length} chars)` : "MISSING"}`);
  console.log(`SONAR_USERNAME:      ${sUser ? "set" : "missing"}`);
  console.log(`SONAR_PASSWORD:      ${sPass ? "set" : "missing"}`);
  console.log(`PERPLEXITY_API_KEY:  ${ppx ? `set (${ppx.length} chars)` : "MISSING"}`);
  console.log(`Auth path: ${fwToken ? "FREIGHTWAVES_TOKEN (direct bearer)" : sUser && sPass ? "username/password" : "NONE — all calls will return fallback"}`);

  // ── NATIONAL SUMMARY ─────────────────────────────────────────────────────
  console.log("\n--- getNationalMarketSummary() ---");
  const nat1 = await timed("getNationalMarketSummary (cold)", () => getNationalMarketSummary());
  if (nat1) {
    const v = nat1.result;
    console.log(`  OTRI=${fmt(v.otri, "%")}  WoW=${fmt(v.otriWoWDelta, "pp")}  NTI=$${fmt(v.ntiPerMove)}  $/mi=${fmt(v.ntiPerMile)}  isStale=${v.isStale}  ${nat1.ms}ms`);
    const status = (v.otri !== null || v.ntiPerMove !== null) ? "PASS" : "WARN";
    record("getNationalMarketSummary", status, nat1.ms,
      status === "PASS"
        ? `OTRI=${v.otri} NTI=${v.ntiPerMove} $/mi=${v.ntiPerMile} stale=${v.isStale}`
        : `All metrics null; lastSuccessfulPull=${v.lastSuccessfulPull}`);
  }

  // Cache hit
  const nat2 = await timed("getNationalMarketSummary (warm)", () => getNationalMarketSummary());
  if (nat2) {
    const fasterOk = nat2.ms < (nat1?.ms ?? 999) || nat2.ms < 50;
    record("getNationalMarketSummary cache", fasterOk ? "PASS" : "WARN", nat2.ms,
      `2nd call ${nat2.ms}ms (1st ${nat1?.ms ?? "n/a"}ms) — cache ${fasterOk ? "HIT" : "miss?"}`);
    console.log(`  warm call: ${nat2.ms}ms (cache ${fasterOk ? "HIT" : "miss?"})`);
  }

  // ── MARKET OTRIs ──────────────────────────────────────────────────────────
  console.log("\n--- getMarketOtris(['Atlanta','Dallas','Chicago','Los Angeles']) ---");
  const markets = ["Atlanta", "Dallas", "Chicago", "Los Angeles"];
  const otris = await timed("getMarketOtris", () => getMarketOtris(markets));
  if (otris) {
    console.log(`  Got ${otris.result.length} markets in ${otris.ms}ms`);
    for (const o of otris.result) {
      console.log(`    ${o.market.padEnd(14)} OTRI=${fmt(o.otri, "%")} WoW=${fmt(o.otriWoW, "pp")} signal=${o.signal ?? "—"}`);
    }
    const liveCount = otris.result.filter((o) => o.otri !== null).length;
    record("getMarketOtris", liveCount > 0 ? "PASS" : "WARN", otris.ms,
      `${liveCount}/${otris.result.length} markets returned live OTRI values`);
  }

  // ── LANE VOTRI (single) ──────────────────────────────────────────────────
  console.log("\n--- getLaneVotri('Atlanta', 'Dallas') ---");
  const v1 = await timed("getLaneVotri ATL→DAL", () => getLaneVotri("Atlanta", "Dallas"));
  if (v1) {
    const v = v1.result;
    console.log(`  qualifier=${v.qualifier} VOTRI=${fmt(v.votri, "%")} WoW=${fmt(v.votriWoW, "pp")} signal=${v.signal ?? "—"} isStale=${v.isStale}  ${v1.ms}ms`);
    record("getLaneVotri", v.votri !== null ? "PASS" : "WARN", v1.ms,
      `qualifier=${v.qualifier} VOTRI=${v.votri} stale=${v.isStale}`);
  }

  // qualifier sanity
  const q = buildVotriQualifier("Atlanta", "Dallas");
  console.log(`  buildVotriQualifier check: Atlanta+Dallas → ${q} (expected ATLDAL)`);
  record("buildVotriQualifier", q === "ATLDAL" ? "PASS" : "FAIL", 0, `got ${q}`);

  // ── LANE VOTRI BATCH ─────────────────────────────────────────────────────
  console.log("\n--- getLaneVotrisBatch (4 lanes) ---");
  const lanes = [
    { origin: "Atlanta", destination: "Dallas" },
    { origin: "Chicago", destination: "Los Angeles" },
    { origin: "Houston", destination: "Memphis" },
    { origin: "Phoenix", destination: "Denver" },
  ];
  const vBatch = await timed("getLaneVotrisBatch", () => getLaneVotrisBatch(lanes));
  if (vBatch) {
    const lanesArr = Array.from(vBatch.result.values());
    const liveLanes = lanesArr.filter((v) => v.votri !== null).length;
    console.log(`  Got ${vBatch.result.size} lanes, ${liveLanes} with live data, in ${vBatch.ms}ms`);
    for (const v of lanesArr) {
      console.log(`    ${v.qualifier}  VOTRI=${fmt(v.votri, "%")} signal=${v.signal ?? "—"}`);
    }
    record("getLaneVotrisBatch", "PASS", vBatch.ms, `${liveLanes}/${vBatch.result.size} live`);
  }

  // ── LANE MARKET RATE ─────────────────────────────────────────────────────
  console.log("\n--- getLaneMarketRate('Atlanta','Dallas') ---");
  const lmr = await timed("getLaneMarketRate", () => getLaneMarketRate("Atlanta", "Dallas"));
  if (lmr) {
    const r = lmr.result;
    console.log(`  rate=$${fmt(r.marketRatePerMile)}/mi  source=${r.source}  forecast=${r.forecastDirection}  conf=${r.confidence}  isStale=${r.isStale}  ${lmr.ms}ms`);
    console.log(`  3-week forecast: ${r.forecastWeeklyRates.map((w) => `wk${w.week}=$${w.ratePerMile}`).join(", ")}`);
    record("getLaneMarketRate", r.marketRatePerMile !== null ? "PASS" : "WARN", lmr.ms,
      `$${r.marketRatePerMile}/mi source=${r.source} forecast=${r.forecastDirection}`);
  }

  // ── PERPLEXITY ───────────────────────────────────────────────────────────
  console.log("\n--- getPerplexityMarketContext(['Atlanta','Dallas','Chicago']) ---");
  const ppxRes = await timed("getPerplexityMarketContext", () =>
    getPerplexityMarketContext(["Atlanta", "Dallas", "Chicago"]));
  if (ppxRes) {
    const items = ppxRes.result;
    if (items === null) {
      record("getPerplexityMarketContext", ppx ? "FAIL" : "WARN", ppxRes.ms,
        ppx ? "API key set but call returned null — check key validity / network / parsing" : "PERPLEXITY_API_KEY not configured");
      console.log(`  Returned null (${ppx ? "API call failed" : "no API key"})  ${ppxRes.ms}ms`);
    } else {
      console.log(`  Got ${items.length} market context items in ${ppxRes.ms}ms`);
      for (const it of items) {
        console.log(`    [${it.market}] ${it.headline}`);
      }
      record("getPerplexityMarketContext", "PASS", ppxRes.ms, `${items.length} items returned`);
    }
  }

  // ── CIRCUIT BREAKER STATUS ───────────────────────────────────────────────
  const cb = getSonarCircuitBreakerStatus();
  console.log(`\n--- Circuit breaker: ${cb.isOpen ? `OPEN (resumes ${cb.resumesAt})` : "CLOSED (healthy)"} ---`);
  record("circuitBreaker", cb.isOpen ? "WARN" : "PASS", 0,
    cb.isOpen ? `OPEN — tripped at ${cb.trippedAt}, resumes ${cb.resumesAt}` : "CLOSED");

  // ── SUMMARY TABLE ────────────────────────────────────────────────────────
  console.log("\n\n========== RESULTS SUMMARY ==========");
  console.log("STATUS  TIME     TEST                                  NOTE");
  console.log("------  -------  ------------------------------------  ------------------------------------------------");
  for (const r of RESULTS) {
    const stat = r.status.padEnd(6);
    const ms = `${r.ms}ms`.padStart(6);
    const test = r.test.padEnd(36);
    console.log(`${stat}  ${ms}   ${test}  ${r.note}`);
  }
  const passes = RESULTS.filter(r => r.status === "PASS").length;
  const fails  = RESULTS.filter(r => r.status === "FAIL").length;
  const warns  = RESULTS.filter(r => r.status === "WARN").length;
  console.log(`\nTotal: ${RESULTS.length}  PASS: ${passes}  WARN: ${warns}  FAIL: ${fails}`);
  console.log("========================================\n");

  process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => { console.error("FATAL:", err); process.exit(2); });
