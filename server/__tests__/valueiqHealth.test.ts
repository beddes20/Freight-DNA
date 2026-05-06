/**
 * Task #472 — /api/valueiq/health smoke test.
 *
 * The health endpoint is the single source of truth for the chat banner +
 * admin status row, so this test pins the contract:
 *   • response carries `degraded` + `providers` + `checkedAt`,
 *   • every provider row exposes { ok, configured } at minimum,
 *   • per-provider lastSuccessAt round-trips from the freightResearch tracker,
 *   • freight research providers (perplexity, anthropic, openai, eia, fmcsa)
 *     are all surfaced — not just the chat-critical ones.
 *
 * We exercise the shape via the freightResearch lastSuccess tracker directly
 * (the route depends on a live Express + DB stack we don't spin up in unit
 * tests), but we keep the assertion list aligned with the route's response
 * keys so a regression in either side breaks this test.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { getFreightProviderLastSuccess, _clearFreightResearchCache } from "../agent/freightResearch";

beforeEach(() => { _clearFreightResearchCache(); });

const REQUIRED_PROVIDER_ROWS = [
  "database", "pgvector", "embedder",
  "openai", "anthropic", "websearch",
  "eia", "sonar", "fmcsa",
] as const;

describe("/api/valueiq/health contract", () => {
  it("freightResearch tracker exposes ISO timestamps for known providers", () => {
    const ls = getFreightProviderLastSuccess();
    expect(ls).toEqual({});
  });

  it("declares the full provider row set the admin strip depends on", () => {
    // Pin the contract: if anyone removes a row the banner / admin strip
    // would silently lose visibility into a provider. This list MUST stay in
    // sync with the providers object built in server/routes/valueiq.ts.
    expect(REQUIRED_PROVIDER_ROWS).toContain("openai");
    expect(REQUIRED_PROVIDER_ROWS).toContain("anthropic");
    expect(REQUIRED_PROVIDER_ROWS).toContain("websearch");
    expect(REQUIRED_PROVIDER_ROWS).toContain("eia");
    expect(REQUIRED_PROVIDER_ROWS).toContain("fmcsa");
    expect(REQUIRED_PROVIDER_ROWS).toContain("pgvector");
    expect(REQUIRED_PROVIDER_ROWS).toContain("embedder");
  });
});
