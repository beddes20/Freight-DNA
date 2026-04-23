/**
 * AI Helpers — wrappers around OpenAI, Anthropic, and Perplexity for text generation.
 * Used by lane carrier outreach routes and the intel route.
 *
 * Caching:
 *   OpenAI (GPT-4o)    30-min TTL — alert narratives, spot op descriptions, buy rate rationale
 *   Anthropic (Claude) 60-min TTL — lane narratives, executive summaries
 *   Perplexity         60-min TTL — external market context blocks
 *
 * Concurrency:
 *   Claude lane-narrative calls are capped at MAX_CLAUDE_CONCURRENCY to avoid
 *   rate-limit errors when the lane set is large.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getDbCached, setDbCached } from "./dbCache";

// ── Clients ───────────────────────────────────────────────────────────────────

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

let _anthropic: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface AiCacheEntry {
  value: string;
  fetchedAt: number;
  ttlMs: number;
}
const aiCache = new Map<string, AiCacheEntry>();

function getCached(key: string): string | null {
  const entry = aiCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > entry.ttlMs) { aiCache.delete(key); return null; }
  return entry.value;
}

function setCached(key: string, value: string, ttlMs: number): void {
  aiCache.set(key, { value, fetchedAt: Date.now(), ttlMs });
}

const TTL_30 = 30 * 60 * 1000;
const TTL_60 = 60 * 60 * 1000;

// DB-backed cache TTLs (seconds) — survive restarts so cold starts skip
// re-generating identical narratives.
const DB_TTL_30 = 30 * 60;
const DB_TTL_60 = 60 * 60;
const DB_TTL_4H = 4 * 60 * 60;

/**
 * Layered cache: L1 = in-memory aiCache (fastest), L2 = DB via dbCache.
 * Returns null if neither layer has the key. Hydrates L1 on L2 hit.
 */
async function getCachedLayered(key: string, hydrateTtlMs: number = TTL_60): Promise<string | null> {
  const mem = getCached(key);
  if (mem !== null) return mem;
  const dbVal = await getDbCached<string>(`ai:${key}`);
  if (dbVal !== null && dbVal !== undefined) {
    setCached(key, dbVal, hydrateTtlMs);
    return dbVal;
  }
  return null;
}

function setCachedLayered(key: string, value: string, ttlMs: number, dbTtlSec: number): void {
  setCached(key, value, ttlMs);
  setDbCached(`ai:${key}`, value, dbTtlSec, "ai");
}

// ── Bounded concurrency helper ────────────────────────────────────────────────

const MAX_CLAUDE_CONCURRENCY = 4;

/**
 * Run an array of async tasks with a maximum concurrency limit.
 * Preserves order of results relative to input tasks.
 */
export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [ai] ${msg}`);
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

/**
 * Send a prompt to GPT-4o-mini and return the text response.
 * Throws if the API call fails or no API key is configured.
 */
export async function callAI(prompt: string, maxTokens = 400, timeoutMs = 15_000): Promise<string> {
  const openai = getOpenAI();
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.5,
  }, { signal: AbortSignal.timeout(timeoutMs) });
  return resp.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Generate a 1–2 sentence plain-English explanation for a lane alert.
 * Cached 30 min keyed by lane + signal + severity.
 */
export async function getAlertNarrative(
  lane: string,
  signal: string,
  action: string,
  severity: string,
  originOtri: number,
  votri: number | null,
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const key = `alert:${lane}:${signal}:${severity}:${Math.round(originOtri)}:${votri !== null ? Math.round(votri) : "n"}`;
  const cached = await getCachedLayered(key, TTL_30);
  if (cached) return cached;

  try {
    const prompt = `You are a freight market intelligence analyst. Write a 1–2 sentence plain-English explanation for a freight lane alert that a logistics professional can act on immediately.

Lane: ${lane}
Signal: ${signal}
Recommended action: ${action}
Severity: ${severity}
Origin market OTRI: ${originOtri.toFixed(1)}%${votri !== null ? `\nLane VOTRI (van tender rejection): ${votri.toFixed(1)}%` : ""}

Keep the tone direct and professional. No bullet points, no headers. 1–2 sentences only.`;
    const result = await callAI(prompt, 120);
    setCachedLayered(key, result, TTL_30, DB_TTL_30);
    log(`Alert narrative generated for ${lane}`);
    return result;
  } catch (err: unknown) {
    log(`Alert narrative error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Generate a 1–2 sentence description for a spot opportunity.
 * Cached 30 min keyed by lane + margin gap.
 */
export async function getSpotOpportunityNarrative(
  lane: string,
  historicalRate: number,
  expectedCost: number,
  marginGap: number,
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const key = `spot:${lane}:${Math.round(marginGap * 10)}`;
  const cached = await getCachedLayered(key, TTL_30);
  if (cached) return cached;

  try {
    const prompt = `You are a freight market intelligence analyst. Write a 1–2 sentence plain-English description of a spot rate opportunity for a freight broker.

Lane: ${lane}
Historical customer rate: $${Math.round(historicalRate)}
Expected current carrier cost: $${Math.round(expectedCost)}
Estimated margin gap: ${marginGap.toFixed(1)}%

Explain why this is an opportunity and what the broker should do. 1–2 sentences only, direct and actionable.`;
    const result = await callAI(prompt, 120);
    setCachedLayered(key, result, TTL_30, DB_TTL_30);
    log(`Spot narrative generated for ${lane}`);
    return result;
  } catch (err: unknown) {
    log(`Spot narrative error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Generate a 1–2 sentence buy rate rationale for a lane.
 * Cached 30 min keyed by lane + buy rate range + votri.
 */
export async function getBuyRateRationale(
  lane: string,
  buyRateLow: number,
  buyRateHigh: number,
  originOtri: number,
  votri: number | null,
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  const key = `buyr:${lane}:${Math.round(buyRateLow * 100)}:${Math.round(buyRateHigh * 100)}:${Math.round(originOtri)}`;
  if (buyRateLow <= 0 && buyRateHigh <= 0) return null;
  const cached = await getCachedLayered(key, TTL_30);
  if (cached) return cached;

  try {
    const prompt = `You are a freight market intelligence analyst. Write a 1–2 sentence buy rate rationale for a freight broker.

Lane: ${lane}
Recommended buy rate range: $${buyRateLow.toFixed(2)} – $${buyRateHigh.toFixed(2)}/mile
Origin market OTRI: ${originOtri.toFixed(1)}%${votri !== null ? `\nLane VOTRI (van tender rejection): ${votri.toFixed(1)}%` : ""}

Explain why this rate range makes sense given current market conditions. 1–2 sentences, direct and professional.`;
    const result = await callAI(prompt, 120);
    setCachedLayered(key, result, TTL_30, DB_TTL_30);
    log(`Buy rate rationale generated for ${lane}`);
    return result;
  } catch (err: unknown) {
    log(`Buy rate rationale error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Anthropic (Claude) ────────────────────────────────────────────────────────

/** Typed shape of an Anthropic TextBlock content item */
interface AnthropicTextBlock {
  type: "text";
  text: string;
}

function extractClaudeText(resp: Anthropic.Message): string {
  const block = resp.content[0];
  if (block && block.type === "text") {
    return (block as AnthropicTextBlock).text.trim();
  }
  return "";
}

/**
 * Generate a 2–3 sentence strategic lane narrative using Claude.
 * Covers the 6-week performance arc of a lane.
 * Cached 60 min keyed by lane + margin pct + trend.
 */
export async function getLaneNarrative(
  lane: string,
  avg6WkMarginPct: number,
  marginTrend: string,
  weeklyMarginPcts: number[],
  totalLoads: number,
  votri: number | null,
  destOtri: number,
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const key = `lane-narr:${lane}:${Math.round(avg6WkMarginPct * 10)}:${marginTrend}:${weeklyMarginPcts.map(p => Math.round(p)).join(",")}`;
  const cached = await getCachedLayered(key, TTL_60);
  if (cached) return cached;

  try {
    const anthropic = getAnthropic();
    const weeklyStr = weeklyMarginPcts.map((p, i) => `Wk${i + 1}: ${p.toFixed(1)}%`).join(", ");
    const prompt = `You are a senior freight market strategist. Write a 2–3 sentence strategic narrative analyzing this freight lane's 6-week performance arc for a logistics executive.

Lane: ${lane}
6-week average margin: ${avg6WkMarginPct.toFixed(1)}%
Carrier rate trend: ${marginTrend}
Weekly margin pattern: ${weeklyStr}
Total loads in 6 weeks: ${totalLoads}${votri !== null ? `\nLane VOTRI (van tender rejection index): ${votri.toFixed(1)}%` : ""}
Destination market OTRI: ${destOtri.toFixed(1)}%

Focus on: what the trend means, what's driving it, and one strategic recommendation. 2–3 sentences, no bullet points, executive-level writing.`;

    const resp = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 180,
      messages: [{ role: "user", content: prompt }],
    });
    const result = extractClaudeText(resp);
    if (!result) return null;
    setCachedLayered(key, result, TTL_60, DB_TTL_60);
    log(`Lane narrative generated for ${lane}`);
    return result;
  } catch (err: unknown) {
    log(`Lane narrative error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Generate a natural-language executive brief using Claude.
 * Cached 60 min keyed by core stats.
 */
export async function getExecutiveBrief(
  totalLoads: number,
  totalRevenue: number,
  overallMarginPct: number,
  healthDistribution: { SCALE: number; GROW: number; WATCH: number; HOLD: number },
  topMarket: string,
  bestWeek: string,
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const key = `exec-brief:${totalLoads}:${Math.round(totalRevenue / 1000)}:${Math.round(overallMarginPct * 10)}:${healthDistribution.SCALE}:${healthDistribution.HOLD}`;
  const cached = await getCachedLayered(key, TTL_60);
  if (cached) return cached;

  try {
    const anthropic = getAnthropic();
    const totalLanes = healthDistribution.SCALE + healthDistribution.GROW + healthDistribution.WATCH + healthDistribution.HOLD;
    const prompt = `You are a freight logistics executive advisor. Write a concise 2–3 sentence natural-language executive brief summarizing the organization's freight portfolio performance for the last 6 weeks.

Key statistics:
- Total loads: ${totalLoads.toLocaleString()}
- Total revenue: $${(totalRevenue / 1000).toFixed(0)}K
- Overall margin: ${overallMarginPct.toFixed(1)}%
- Lane health: ${healthDistribution.SCALE} SCALE (ready to grow), ${healthDistribution.GROW} GROW, ${healthDistribution.WATCH} WATCH, ${healthDistribution.HOLD} HOLD out of ${totalLanes} lanes
- Best performing week: ${bestWeek || "N/A"}
- Most active market: ${topMarket || "N/A"}

Write as if briefing a VP. Highlight the most important insight and one strategic priority. 2–3 sentences, no bullet points.`;

    const resp = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });
    const result = extractClaudeText(resp);
    if (!result) return null;
    setCachedLayered(key, result, TTL_60, DB_TTL_60);
    log(`Executive brief generated`);
    return result;
  } catch (err: unknown) {
    log(`Executive brief error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Perplexity ────────────────────────────────────────────────────────────────

export interface MarketContextItem {
  market: string;
  headline: string;
  summary: string;
  relevance: string;
}

interface PerplexityResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * Query Perplexity for current real-world freight news relevant to the user's top markets.
 * Returns an array of MarketContextItem, or null on failure.
 * Cached 60 min keyed by top-3 markets.
 */
export async function getPerplexityMarketContext(
  markets: string[],
): Promise<MarketContextItem[] | null> {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  if (markets.length === 0) return null;

  const top3 = markets.slice(0, 3);
  const key = `perplexity:${top3.join(",")}`;
  const cached = await getCachedLayered(key, TTL_60);
  if (cached) {
    try { return JSON.parse(cached) as MarketContextItem[]; } catch { /* fall through */ }
  }

  try {
    const marketsStr = top3.join(", ");
    const prompt = `You are a freight market intelligence service. Provide current real-world freight market context for a logistics company with heavy activity in these markets: ${marketsStr}.

For each of the top 2–3 markets, provide one piece of current freight news or capacity condition that would affect a freight broker operating there today. Focus on: seasonal demand patterns, industrial activity, port activity, driver availability, fuel costs, or major shippers in the region.

Respond ONLY with a valid JSON array (no markdown, no code fences) in exactly this format:
[
  {
    "market": "Market Name",
    "headline": "One-line headline about current conditions",
    "summary": "1–2 sentence explanation of what is happening and why it matters for freight",
    "relevance": "1 sentence on how this affects carrier availability or rates"
  }
]

Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

    const resp = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
        temperature: 0.2,
        search_recency_filter: "week",
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!resp.ok) {
      log(`Perplexity error: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const data = await resp.json() as PerplexityResponse;
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return null;

    // Extract JSON array from the response (strip any accidental markdown fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) { log("Perplexity: no JSON array found in response"); return null; }
    const items = JSON.parse(jsonMatch[0]) as MarketContextItem[];
    if (!Array.isArray(items) || items.length === 0) return null;

    const serialized = JSON.stringify(items);
    setCachedLayered(key, serialized, TTL_60, DB_TTL_4H);
    log(`Perplexity market context fetched for: ${top3.join(", ")}`);
    return items;
  } catch (err: unknown) {
    log(`Perplexity error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Run multiple lane narrative calls with bounded concurrency.
 * Use this instead of Promise.all for large lane sets to avoid Claude rate limits.
 */
export async function getLaneNarrativesBatch(
  lanes: Array<{
    lane: string;
    avg6WkMarginPct: number;
    marginTrend: string;
    weeklyMarginPcts: number[];
    totalLoads: number;
    votri: number | null;
    destOtri: number;
  }>,
): Promise<Array<string | null>> {
  const tasks = lanes.map(l => () => getLaneNarrative(
    l.lane,
    l.avg6WkMarginPct,
    l.marginTrend,
    l.weeklyMarginPcts,
    l.totalLoads,
    l.votri,
    l.destOtri,
  ));
  return runConcurrent(tasks, MAX_CLAUDE_CONCURRENCY);
}

// ── Rate Positioning Coaching Card ───────────────────────────────────────────

/**
 * Generate a 2–3 sentence rep-facing coaching card for a lane's rate positioning.
 * Incorporates: paid rate vs. TRAC benchmark delta, 3-week forecast direction,
 * VOTRI signal, and margin trend.
 * Cached 60 min keyed by lane + rounded rate values.
 */
export async function generateLaneCoachingCard(
  lane: string,
  paidRatePerMile: number,
  marketRatePerMile: number | null,
  deltaPerMile: number,
  deltaPct: number,
  classification: "ABOVE_MARKET" | "AT_MARKET" | "BELOW_MARKET",
  forecastDirection: "TIGHTENING" | "EASING" | "STABLE",
  votri: number | null,
  marginTrend: "tightening" | "easing" | "stable",
): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY || marketRatePerMile === null) return null;

  const key = `coaching:${lane}:${Math.round(paidRatePerMile * 100)}:${Math.round(marketRatePerMile * 100)}:${forecastDirection}:${classification}`;
  const cached = await getCachedLayered(key, TTL_60);
  if (cached) return cached;

  try {
    const aboveBelow = deltaPerMile >= 0 ? "above" : "below";
    const aboveBelowAbs = Math.abs(deltaPerMile);
    const targetRate = marketRatePerMile;

    const forecastText = forecastDirection === "TIGHTENING"
      ? "Rates on this lane are forecast to rise over the next 3 weeks."
      : forecastDirection === "EASING"
      ? "Rates on this lane are forecast to ease over the next 3 weeks."
      : "Rates on this lane are expected to remain stable over the next 3 weeks.";

    const votriText = votri !== null
      ? `Lane VOTRI (van tender rejection): ${votri.toFixed(1)}%.`
      : "";

    const prompt = `You are a freight market intelligence coach. Write a 2–3 sentence, direct, action-oriented coaching recommendation for a freight rep about their carrier rate positioning on this lane.

Lane: ${lane}
Your paid carrier rate: $${paidRatePerMile.toFixed(2)}/mile
TRAC market benchmark: $${marketRatePerMile.toFixed(2)}/mile
Delta: ${aboveBelow === "above" ? "+" : "-"}$${aboveBelowAbs.toFixed(2)}/mile (${Math.abs(deltaPct).toFixed(1)}% ${aboveBelow} market)
Rate classification: ${classification}
3-week rate forecast: ${forecastText}
${votriText}
Carrier margin trend (last 6 weeks): ${marginTrend}
Target benchmark rate: $${targetRate.toFixed(2)}/mile

Write a coaching card that tells the rep EXACTLY what action to take (renegotiate, lock in current rates, hold, or capitalize on favorable positioning). Be specific: include the dollar amount and the reason. 2–3 sentences only, direct and action-oriented. No bullet points, no headers.`;

    const result = await callAI(prompt, 180);
    setCachedLayered(key, result, TTL_60, DB_TTL_60);
    log(`Coaching card generated for ${lane}`);
    return result;
  } catch (err: unknown) {
    log(`Coaching card error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Batch generate coaching cards for multiple lanes with bounded concurrency.
 */
export async function generateLaneCoachingCardsBatch(
  lanes: Array<{
    lane: string;
    paidRatePerMile: number;
    marketRatePerMile: number | null;
    deltaPerMile: number;
    deltaPct: number;
    classification: "ABOVE_MARKET" | "AT_MARKET" | "BELOW_MARKET";
    forecastDirection: "TIGHTENING" | "EASING" | "STABLE";
    votri: number | null;
    marginTrend: "tightening" | "easing" | "stable";
  }>,
): Promise<Array<string | null>> {
  const MAX_CONCURRENCY = 6;
  const tasks = lanes.map(l => () => generateLaneCoachingCard(
    l.lane,
    l.paidRatePerMile,
    l.marketRatePerMile,
    l.deltaPerMile,
    l.deltaPct,
    l.classification,
    l.forecastDirection,
    l.votri,
    l.marginTrend,
  ));
  return runConcurrent(tasks, MAX_CONCURRENCY);
}
