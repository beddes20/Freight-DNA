/**
 * Pre-classifier — picks the depth (and therefore the model) for a turn
 * BEFORE we spin up an LLM call. Tool-only / simple-lookup turns get the
 * fast model; open-ended analytical turns get the reasoning model.
 *
 * Two layers:
 *  1. Pure heuristics — fast, deterministic, no API roundtrip.
 *  2. Optional gpt-4o-mini classifier as an ambiguity fallback — only
 *     used when the heuristic returns a low-confidence answer (no strong
 *     analytical or quick signal AND length is in the gray zone). The
 *     fallback is wrapped in a tight timeout so a slow API call never
 *     blocks a turn — on timeout/error we fall back to the heuristic.
 */
import type OpenAI from "openai";
import { getAgentOpenAI } from "./openai";

export type DepthMode = "quick" | "analytical";

const ANALYTICAL_HINTS = /\b(why|recommend|recommendation|compare|comparison|rank|ranking|strategy|strategi[sz]e|analy[sz]e|analy[sz]is|analyst|brief|draft|plan|propose|suggest|outline|coach|critique|assess|evaluate|forecast|projection|predict|deep dive|breakdown|root cause|trend|trends|insight|insights|narrative|story|opportunity|bid|positioning)\b/i;
const RANKING_HINTS = /\b(top \d+|highest|lowest|leaderboard|ranking|biggest|smallest|most|least|vs\.?|versus|compared to)\b/i;
const QUICK_HINTS = /^(how many|whats|what's|what is|who is|who's|list|show me|show|find|get|search|look up|lookup|when is|where is|count|do i have|is there|open|go to|navigate|pull up|take me to)\b/i;

interface ClassifyResult {
  mode: DepthMode;
  /** "high" when a hard rule fired; "low" when we fell back on length only. */
  confidence: "high" | "low";
}

function classifyHeuristic(message: string): ClassifyResult {
  const m = (message || "").trim();
  if (!m) return { mode: "quick", confidence: "high" };
  if (ANALYTICAL_HINTS.test(m)) return { mode: "analytical", confidence: "high" };
  if (RANKING_HINTS.test(m)) return { mode: "analytical", confidence: "high" };
  if (m.length > 160) return { mode: "analytical", confidence: "high" };
  const sentences = m.split(/[.!?]+/).filter((s) => s.trim().length > 4);
  if (sentences.length > 1) return { mode: "analytical", confidence: "high" };
  if (QUICK_HINTS.test(m)) return { mode: "quick", confidence: "high" };
  // Gray zone: short-ish single-sentence message with no keyword hits.
  if (m.length < 70) return { mode: "quick", confidence: "low" };
  return { mode: "analytical", confidence: "low" };
}

/**
 * Synchronous heuristic-only classifier, kept for callers that can't await
 * (and as the canonical answer when the LLM fallback isn't needed).
 */
export function classifyDepth(message: string): DepthMode {
  return classifyHeuristic(message).mode;
}

/**
 * Async classifier with an LLM fallback for ambiguous prompts. Use this
 * from the request handler when you can afford a few hundred ms before
 * the main turn starts.
 */
export async function classifyDepthSmart(
  message: string,
  opts: { timeoutMs?: number; openai?: OpenAI } = {},
): Promise<DepthMode> {
  const heur = classifyHeuristic(message);
  if (heur.confidence === "high") return heur.mode;

  // Only spend an API call when the heuristic is genuinely ambiguous, and
  // only when an OpenAI key is actually available somewhere — match the
  // same key-resolution order getAgentOpenAI() uses.
  const timeoutMs = opts.timeoutMs ?? 600;
  const hasKey = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY);
  if (!hasKey) return heur.mode;

  const client = opts.openai ?? getAgentOpenAI();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await client.chat.completions.create(
      {
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 2,
        messages: [
          {
            role: "system",
            content:
              "Classify the user's CRM-assistant question as exactly one word: 'quick' (a simple lookup, navigation, or single-fact answer) or 'analytical' (requires reasoning, comparison, ranking, drafting, recommendation, or multi-step synthesis). Reply with only that word.",
          },
          { role: "user", content: message },
        ],
      },
      { signal: ctrl.signal },
    );
    const raw = (resp.choices?.[0]?.message?.content ?? "").trim().toLowerCase();
    if (raw.startsWith("analytical")) return "analytical";
    if (raw.startsWith("quick")) return "quick";
    return heur.mode;
  } catch {
    return heur.mode;
  } finally {
    clearTimeout(timer);
  }
}

export function modeLabel(mode: DepthMode): string {
  return mode === "quick" ? "Quick answer" : "Full analysis";
}
