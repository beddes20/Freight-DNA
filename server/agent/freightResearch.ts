/**
 * Freight Research Tool
 * ---------------------
 * Answers freight-domain questions the agent can't answer from internal CRM
 * data alone — DOT/MC carrier lookups, fuel/diesel prices, and general market
 * questions. Routes the user's question by intent:
 *
 *   • DOT/MC number  → FMCSA SAFER public API   (carrier safety/operating)
 *                       — DOT via /carriers/{dot}, MC via /carriers/docket-number/{mc}
 *   • diesel/fuel    → EIA via existing helper   (national diesel + WoW delta)
 *   • everything else → Perplexity web search → Anthropic synth → OpenAI synth
 *                       (whichever provider is configured + healthy first).
 *
 * Every confident answer carries citations and the list of providers consulted.
 * Cached in-memory for 24h keyed by `${intent}::${normalized question}`.
 */
import { getEiaDieselPrice } from "../sonarClient";
import { getAnthropic } from "../aiHelpers";
import { getAgentOpenAI } from "./openai";

export type FreightIntent = "carrier_lookup" | "fuel" | "general";
export type FreightProvider = "fmcsa" | "eia" | "perplexity" | "anthropic" | "openai";

export interface FreightCitation {
  label: string;
  href?: string;
  fetchedAt: string; // ISO
}

export interface FreightResearchResult {
  intent: FreightIntent;
  answer: string;
  citations: FreightCitation[];
  /** Sources actually consulted; useful for tests + meta. */
  usedProviders: FreightProvider[];
  /** True when no provider produced a real answer — the agent should say so. */
  unknown: boolean;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: FreightResearchResult }>();

// Last-success tracking for /api/valueiq/health so the admin status row can
// show "FMCSA: last good fetch 4 minutes ago" instead of just a green dot.
const lastSuccess: Partial<Record<FreightProvider, number>> = {};
export function getFreightProviderLastSuccess(): Partial<Record<FreightProvider, string>> {
  const out: Partial<Record<FreightProvider, string>> = {};
  for (const [k, ts] of Object.entries(lastSuccess)) {
    if (ts) out[k as FreightProvider] = new Date(ts).toISOString();
  }
  return out;
}

function normalize(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

export function classifyIntent(question: string): FreightIntent {
  const q = question.toLowerCase();
  if (/\b(?:usdot|dot|mc)[\s#:-]*\d{3,8}\b/.test(q)) return "carrier_lookup";
  if (/\b(diesel|fuel|gas(oline)?|surcharge|fsc)\b/.test(q)) return "fuel";
  return "general";
}

function extractCarrierNumber(question: string): { kind: "DOT" | "MC"; number: string } | null {
  const dot = question.match(/\b(?:usdot|dot)[\s#:-]*(\d{3,8})\b/i);
  if (dot) return { kind: "DOT", number: dot[1] };
  const mc = question.match(/\bmc[\s#:-]*(\d{3,8})\b/i);
  if (mc) return { kind: "MC", number: mc[1] };
  return null;
}

// ── FMCSA SAFER (public, requires FMCSA_WEBKEY) ──────────────────────────────

interface FmcsaCarrier {
  legalName?: string;
  dbaName?: string;
  dotNumber?: number;
  status?: string;
  totalDrivers?: number;
  totalPowerUnits?: number;
  phyState?: string;
  phyCity?: string;
}

async function fetchFmcsaByDot(dot: string): Promise<FmcsaCarrier | null> {
  const key = process.env.FMCSA_WEBKEY;
  if (!key) return null;
  const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(dot)}?webKey=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: { carrier?: FmcsaCarrier } | Array<{ carrier?: FmcsaCarrier }> };
    const c = Array.isArray(j?.content) ? j.content[0]?.carrier : j?.content?.carrier;
    if (c) lastSuccess.fmcsa = Date.now();
    return c ?? null;
  } catch (err) {
    console.warn("[freight-research] FMCSA fetch (DOT) failed:", (err as Error).message);
    return null;
  }
}

/** Resolve an MC docket → DOT, then load the carrier snapshot by DOT. */
async function fetchFmcsaByMc(mc: string): Promise<FmcsaCarrier | null> {
  const key = process.env.FMCSA_WEBKEY;
  if (!key) return null;
  const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/docket-number/${encodeURIComponent(mc)}?webKey=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: Array<{ carrier?: FmcsaCarrier }> | { carrier?: FmcsaCarrier } };
    const carriers = Array.isArray(j?.content) ? j.content.map(x => x.carrier).filter(Boolean) as FmcsaCarrier[]
                    : j?.content?.carrier ? [j.content.carrier] : [];
    const first = carriers[0];
    if (!first?.dotNumber) return null;
    // The docket lookup returns a sparse record; re-fetch by DOT to get the
    // full snapshot (status, fleet size, location).
    const full = await fetchFmcsaByDot(String(first.dotNumber));
    if (full) lastSuccess.fmcsa = Date.now();
    return full ?? first;
  } catch (err) {
    console.warn("[freight-research] FMCSA fetch (MC) failed:", (err as Error).message);
    return null;
  }
}

async function answerCarrierLookup(question: string): Promise<FreightResearchResult> {
  const ref = extractCarrierNumber(question);
  const now = new Date().toISOString();
  if (!ref) {
    return {
      intent: "carrier_lookup",
      answer: "I couldn't find a DOT or MC number in that question — give me a number like USDOT 123456 or MC 789012 and I'll pull the SAFER record.",
      citations: [],
      usedProviders: [],
      unknown: true,
    };
  }
  const carrier = ref.kind === "DOT" ? await fetchFmcsaByDot(ref.number) : await fetchFmcsaByMc(ref.number);
  if (!carrier) {
    const reason = !process.env.FMCSA_WEBKEY ? "SAFER isn't configured here" : "SAFER didn't return a record (the carrier may be inactive, the number invalid, or the API is down right now)";
    return {
      intent: "carrier_lookup",
      answer: `${ref.kind} ${ref.number}: ${reason}.`,
      citations: [],
      usedProviders: ["fmcsa"],
      unknown: true,
    };
  }
  const name = carrier.legalName || carrier.dbaName || `${ref.kind} ${ref.number}`;
  const dotPart = carrier.dotNumber ? `USDOT ${carrier.dotNumber}` : `${ref.kind} ${ref.number}`;
  const loc = [carrier.phyCity, carrier.phyState].filter(Boolean).join(", ");
  const fleet = `${carrier.totalPowerUnits ?? "?"} power units, ${carrier.totalDrivers ?? "?"} drivers`;
  const status = carrier.status || "status unknown";
  const linkDot = carrier.dotNumber ?? (ref.kind === "DOT" ? ref.number : "");
  return {
    intent: "carrier_lookup",
    answer: `**${name}** (${dotPart}) — ${status}${loc ? ` · ${loc}` : ""} · ${fleet}.`,
    citations: [
      { label: `FMCSA SAFER — ${dotPart}`, href: linkDot ? `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${linkDot}` : undefined, fetchedAt: now },
    ],
    usedProviders: ["fmcsa"],
    unknown: false,
  };
}

// ── Fuel via EIA ─────────────────────────────────────────────────────────────

async function answerFuel(_question: string): Promise<FreightResearchResult> {
  const now = new Date().toISOString();
  const eia = await getEiaDieselPrice();
  if (!eia) {
    return {
      intent: "fuel",
      answer: "EIA's diesel feed isn't available right now — I can't quote a current national average. Try again in a few minutes.",
      citations: [],
      usedProviders: ["eia"],
      unknown: true,
    };
  }
  lastSuccess.eia = Date.now();
  const delta = eia.weekOverWeekDelta;
  const dir = delta > 0.001 ? `up $${delta.toFixed(3)}/gal week-over-week` : delta < -0.001 ? `down $${Math.abs(delta).toFixed(3)}/gal week-over-week` : "flat week-over-week";
  return {
    intent: "fuel",
    answer: `National on-highway diesel averaged **$${eia.pricePerGal.toFixed(3)}/gal** in the latest EIA reading — ${dir}.`,
    citations: [
      { label: "EIA — U.S. Weekly Retail On-Highway Diesel Prices", href: "https://www.eia.gov/petroleum/gasdiesel/", fetchedAt: now },
    ],
    usedProviders: ["eia"],
    unknown: false,
  };
}

// ── General synthesis: Perplexity web → Anthropic → OpenAI ───────────────────

interface PerplexityHit { title?: string; url?: string }
interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: PerplexityHit[];
}

async function tryPerplexity(question: string): Promise<{ text: string; citations: FreightCitation[] } | null> {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  const now = new Date().toISOString();
  try {
    const resp = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
      body: JSON.stringify({
        model: "sonar",
        messages: [{
          role: "user",
          content: `You are a freight-industry researcher answering for a brokerage rep. Answer the question in 2–4 sentences using current sources. If you can't find a confident answer, say so. Question: ${question}`,
        }],
        max_tokens: 400,
        temperature: 0.2,
        search_recency_filter: "month",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as PerplexityResponse;
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return null;
    const cites: FreightCitation[] = [];
    const seen = new Set<string>();
    for (const sr of data.search_results ?? []) {
      const href = sr.url; if (!href || seen.has(href)) continue; seen.add(href);
      cites.push({ label: sr.title || href, href, fetchedAt: now });
    }
    for (const url of data.citations ?? []) {
      if (!url || seen.has(url)) continue; seen.add(url);
      cites.push({ label: url, href: url, fetchedAt: now });
    }
    if (cites.length === 0) cites.push({ label: "Perplexity web search", fetchedAt: now });
    lastSuccess.perplexity = Date.now();
    return { text, citations: cites };
  } catch (err) {
    console.warn("[freight-research] perplexity failed:", (err as Error).message);
    return null;
  }
}

async function tryAnthropicSynth(question: string, web?: { text: string; citations: FreightCitation[] } | null): Promise<{ text: string } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = getAnthropic();
    const grounding = web?.text ? `\n\nWeb research notes you may use:\n${web.text}\n` : "";
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 400,
      messages: [{
        role: "user",
        content:
          "You are a freight-industry research assistant for a brokerage rep. Answer the question below in 2–4 sentences. " +
          "Use the web research notes if provided, otherwise rely on general industry knowledge. " +
          "If you don't have a confident answer, say \"I don't have a reliable source for that\" — do NOT speculate." +
          grounding +
          `\n\nQuestion: ${question}`,
      }],
    });
    const block = resp.content?.[0];
    const text = block && block.type === "text" ? block.text.trim() : "";
    if (!text) return null;
    lastSuccess.anthropic = Date.now();
    return { text };
  } catch (err) {
    console.warn("[freight-research] anthropic synth failed:", (err as Error).message);
    return null;
  }
}

async function tryOpenAiSynth(question: string, web?: { text: string; citations: FreightCitation[] } | null): Promise<{ text: string } | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const client = getAgentOpenAI();
    const grounding = web?.text ? `\n\nWeb research notes you may use:\n${web.text}\n` : "";
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 400,
      temperature: 0.2,
      messages: [{
        role: "user",
        content:
          "You are a freight-industry research assistant for a brokerage rep. Answer in 2–4 sentences. " +
          "Use the web research notes if provided, otherwise rely on general industry knowledge. " +
          "If you don't have a confident answer, say \"I don't have a reliable source for that\" — do NOT speculate." +
          grounding +
          `\n\nQuestion: ${question}`,
      }],
    });
    const text = resp.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return null;
    lastSuccess.openai = Date.now();
    return { text };
  } catch (err) {
    console.warn("[freight-research] openai synth failed:", (err as Error).message);
    return null;
  }
}

async function answerGeneral(question: string): Promise<FreightResearchResult> {
  const now = new Date().toISOString();
  const used: FreightProvider[] = [];

  // 1) Try web search first — gives us real, current citations.
  const web = await tryPerplexity(question);
  if (web) used.push("perplexity");

  // 2) Synthesize with Anthropic, then OpenAI as a fallback. Either model's
  //    output is preferred over raw web text because it answers the actual
  //    question rather than dumping search snippets.
  let synth: { text: string } | null = null;
  const anth = await tryAnthropicSynth(question, web);
  if (anth) { synth = anth; used.push("anthropic"); }
  else {
    const oa = await tryOpenAiSynth(question, web);
    if (oa) { synth = oa; used.push("openai"); }
  }

  if (!synth && !web) {
    return {
      intent: "general",
      answer: "I don't have a research provider available right now (no web search and no LLM keys configured) — I can't answer that confidently.",
      citations: [],
      usedProviders: used,
      unknown: true,
    };
  }

  const text = synth?.text ?? web!.text;
  const unknown = !text || /don'?t (have|know)|no reliable source/i.test(text);
  // Prefer real web citations if we have them; else cite the synthesizer.
  const citations: FreightCitation[] = web?.citations?.length ? web.citations
                  : synth ? [{ label: used.includes("anthropic") ? "Anthropic Claude (general industry knowledge)" : "OpenAI GPT (general industry knowledge)", fetchedAt: now }]
                  : [];

  return { intent: "general", answer: text, citations, usedProviders: used, unknown };
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function freightResearch(question: string, intentHint?: FreightIntent): Promise<FreightResearchResult> {
  const intent = intentHint ?? classifyIntent(question);
  const cacheKey = `${intent}::${normalize(question)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let result: FreightResearchResult;
  if (intent === "carrier_lookup") result = await answerCarrierLookup(question);
  else if (intent === "fuel") result = await answerFuel(question);
  else result = await answerGeneral(question);

  if (!result.unknown) cache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

/** Test / admin helper. */
export function _clearFreightResearchCache() { cache.clear(); for (const k of Object.keys(lastSuccess)) delete lastSuccess[k as FreightProvider]; }
