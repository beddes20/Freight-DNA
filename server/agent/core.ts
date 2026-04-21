/**
 * Channel-agnostic agent loop for DNA Logistics Bot.
 *
 * Caller supplies the rep, channel, conversation reference, and an `emit`
 * callback that delivers SSE-style events to the transport (in-app SSE, email
 * reply composer, Teams adaptive card builder, etc.).
 *
 * Event shapes (preserved for the existing in-app client):
 *   { content: string }                — token of streamed text
 *   { navigate: string }               — client-side navigation
 *   { action: { tool, args } }         — HITL action card
 *   { error: string }                  — fatal error
 *   { done: true }                     — turn complete
 */
import type OpenAI from "openai";
import { getAgentOpenAI, AGENT_MODELS } from "./openai";
import { TOOLS, TOOL_BY_NAME, openAiToolSpecs, type AgentContext, type AgentTool } from "./tools";
import { canInvoke } from "./permissions";
import { listFacts, searchMemories } from "./memory";
import { logActivity } from "./activity";
import { buildSystemPrompt, ensureDefaultAgent, getAgentRuntime } from "./persona";
import { retrieveContext, formatHitsForPrompt } from "./retrieval";

export interface AnswerMeta {
  sources?: Array<{ kind: string; id?: string; label: string; href?: string }>;
  followUps?: string[];
  scope?: string;
  confidence?: "high" | "medium" | "low";
}

export type AgentEvent =
  | { content: string }
  | { navigate: string }
  | { action: { tool: string; args: Record<string, unknown> } }
  | { progress: string }
  | { meta: AnswerMeta }
  | { error: string }
  | { confidence: number; route: string }
  | { done: true };

const HEDGE_PATTERNS = [
  /i (?:don'?t|do not) (?:know|have)/i,
  /i'?m not sure/i,
  /unable to (?:find|determine|confirm)/i,
  /no (?:data|information|results?)/i,
  /couldn'?t (?:find|locate)/i,
  /i don'?t have access/i,
];

/** Heuristic confidence score: tools called, retrieval not degraded, no hedging. */
export function deriveRoute(opts: { surfacedAction: boolean; toolsRun: number; lastTool: string | null; hadError: boolean }): string {
  if (opts.surfacedAction) return `action:${opts.lastTool ?? "unknown"}`;
  if (opts.toolsRun > 0) return `tools:${opts.lastTool ?? "unknown"}`;
  if (opts.hadError) return "error";
  return "chat";
}

export function deriveOutcome(opts: { hadError: boolean; toolErrors: number; toolsDenied: number; confidence: number }): "error" | "tool_error" | "denied" | "low_confidence" | "ok" {
  if (opts.hadError) return "error";
  if (opts.toolErrors > 0) return "tool_error";
  if (opts.toolsDenied > 0) return "denied";
  if (opts.confidence < 0.5) return "low_confidence";
  return "ok";
}

export function scoreConfidence(opts: { toolsRun: number; toolErrors: number; degraded: boolean; hedged: boolean; hadError: boolean; assistantText: string }): number {
  if (opts.hadError) return 0.1;
  let score = 0.65;
  if (opts.toolsRun > 0) score += 0.2;
  if (opts.toolErrors > 0) score -= 0.25;
  if (opts.degraded) score -= 0.15;
  if (opts.hedged) score -= 0.3;
  if (opts.assistantText.trim().length < 40 && opts.toolsRun === 0) score -= 0.15;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export type Emit = (event: AgentEvent) => void;

export interface RunAgentTurnArgs {
  ctx: AgentContext;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  userMessage: string;
  emit: Emit;
  /** Optional explicit agent id (ValueIQ multi-agent support). Defaults to org's DNA agent. */
  agentId?: string;
  /** Optional ValueIQ project id for project-pinned context retrieval. */
  projectId?: string | null;
  /** Optional pre-built page context block (from the smart router). */
  pageContextBlock?: string | null;
}

const MAX_TOOL_ITERATIONS = 6;

async function buildContextEnvelope(
  ctx: AgentContext,
  userMessage: string,
  projectId?: string | null,
): Promise<{ envelope: string; degraded: boolean }> {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const lines: string[] = [
    `Today is ${today}.`,
    `Rep: ${ctx.rep.name} (${String(ctx.rep.role).replace(/_/g, " ")})`,
    `Channel: ${ctx.channel}`,
    `Data scope: ${ctx.scope === "everyone" ? "entire organization" : "rep's team only"}`,
  ];

  // Standing facts (always loaded)
  try {
    const facts = await listFacts(ctx.rep.id);
    const pinned = facts.filter((f) => f.pinned).slice(0, 8);
    if (pinned.length) {
      lines.push("", "Standing facts about this rep:");
      for (const f of pinned) lines.push(`• ${f.fact}`);
    }
  } catch {}

  // Top-k memory recall, scoped to the user's question
  try {
    const hits = await searchMemories(ctx.rep.id, userMessage, 3);
    if (hits.length) {
      lines.push("", "Possibly relevant memories from prior sessions (use only if applicable):");
      for (const h of hits) lines.push(`• ${h.content}`);
    }
  } catch {}

  // ValueIQ retrieval — org corpus + personal Library + project pin.
  let degraded = false;
  try {
    const result = await retrieveContext({
      organizationId: ctx.organizationId,
      userId: ctx.rep.id,
      query: userMessage,
      projectId: projectId ?? null,
      perBucket: 4,
    });
    degraded = result.degraded;
    const formatted = formatHitsForPrompt(result.hits, 3500);
    if (formatted) lines.push(formatted);
  } catch (err) {
    console.warn("[agent.core] retrieval failed:", err);
    degraded = true;
  }

  return { envelope: lines.join("\n"), degraded };
}

export async function runAgentTurn({ ctx, history, userMessage, emit, agentId: agentIdArg, projectId, pageContextBlock }: RunAgentTurnArgs): Promise<{ assistantText: string; hadError: boolean; surfacedAction: boolean; agentId: string; meta: AnswerMeta; confidence: number; route: string }> {
  let hadError = false;
  let surfacedAction = false;
  let toolsRun = 0;
  let toolErrors = 0;
  let toolsDenied = 0;
  let lastTool: string | null = null;
  const sources: AnswerMeta["sources"] = [];
  const startedAt = Date.now();
  const client = getAgentOpenAI();
  const { envelope: baseEnvelope, degraded } = await buildContextEnvelope(ctx, userMessage, projectId);
  const envelope = pageContextBlock ? `${baseEnvelope}\n\n${pageContextBlock}` : baseEnvelope;
  const agentId = agentIdArg ?? (await ensureDefaultAgent(ctx.organizationId));
  const runtime = await getAgentRuntime(agentId);
  const systemPrompt = await buildSystemPrompt(agentId, ctx.channel);

  // Per-agent tool allowlist. When the agent has no explicit allowlist row,
  // we expose the entire registry (the rep's individual permissions still
  // apply at execute time via canInvoke).
  const activeTools: AgentTool[] = runtime?.toolAllowlist
    ? TOOLS.filter((t) => runtime.toolAllowlist!.includes(t.capability))
    : TOOLS;
  const activeToolNames = new Set(activeTools.map((t) => t.name));
  const activeToolSpecs = openAiToolSpecs().filter((spec: any) => activeToolNames.has(spec.function?.name));

  const grounding = degraded
    ? "\n\nNOTE: The retrieval layer is degraded right now — answer from your tools and memory; mention this if the rep asks for grounded data."
    : "";

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: `${systemPrompt}\n\n=== CONTEXT ===\n${envelope}${grounding}` },
    ...history.map((m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
    { role: "user", content: userMessage },
  ];

  let assistantText = "";
  let iterations = 0;
  let model: string = runtime?.model || AGENT_MODELS.reasoning;

  void logActivity({
    organizationId: ctx.organizationId,
    userId: ctx.rep.id,
    channel: ctx.channel,
    conversationRef: ctx.conversationRef,
    direction: "inbound",
    summary: userMessage.slice(0, 280),
    outcome: "ok",
  });

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    const iterStart = Date.now();

    let stream;
    try {
      stream = await client.chat.completions.create({
        model,
        messages,
        tools: activeToolSpecs.length ? activeToolSpecs : undefined,
        tool_choice: activeToolSpecs.length ? "auto" : undefined,
        stream: true,
        max_tokens: 1200,
      });
    } catch (err) {
      console.error("[agent.core] OpenAI call failed:", err);
      hadError = true;
      emit({ error: "AI service temporarily unavailable. Please try again." });
      return { assistantText, hadError, surfacedAction, agentId, meta: { confidence: "low" } };
    }

    let textThisTurn = "";
    type PendingToolCall = { id: string; name: string; args: string };
    const pending: Record<number, PendingToolCall> = {};
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        textThisTurn += delta.content;
        emit({ content: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!pending[idx]) pending[idx] = { id: "", name: "", args: "" };
          if (tc.id) pending[idx].id += tc.id;
          if (tc.function?.name) pending[idx].name += tc.function.name;
          if (tc.function?.arguments) pending[idx].args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    assistantText += textThisTurn;
    const toolCalls = Object.values(pending).filter((p) => p.name);

    // No tool calls → we're done
    if (finishReason !== "tool_calls" || !toolCalls.length) {
      void logActivity({
        organizationId: ctx.organizationId,
        userId: ctx.rep.id,
        channel: ctx.channel,
        conversationRef: ctx.conversationRef,
        direction: "outbound",
        summary: textThisTurn.slice(0, 280),
        model,
        latencyMs: Date.now() - iterStart,
        outcome: "ok",
      });
      break;
    }

    // Append the assistant's tool-call message to history exactly as OpenAI expects
    messages.push({
      role: "assistant",
      content: textThisTurn || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id, type: "function" as const,
        function: { name: tc.name, arguments: tc.args || "{}" },
      })),
    });

    // Execute each tool sequentially
    let endTurn = false;
    for (const tc of toolCalls) {
      const tool = TOOL_BY_NAME.get(tc.name);
      let args: any = {};
      try { args = JSON.parse(tc.args || "{}"); } catch {}

      // Progressive loading — emit a short status line per tool call so the
      // client can show "Looking up X…" instead of an indefinite spinner.
      const progressLabel = friendlyToolLabel(tc.name, args);
      if (progressLabel) emit({ progress: progressLabel });

      // Permission check
      let toolResultText = "";
      if (!tool) {
        toolResultText = `Tool "${tc.name}" not registered.`;
      } else if (!activeToolNames.has(tool.name)) {
        toolResultText = `Tool "${tc.name}" is not enabled for this agent. Pick another approach or tell the rep this isn't in your toolkit.`;
      } else {
        const decision = await canInvoke(ctx.rep, tool.capability);
        // Phase 1 semantics: write/external tools that surface action cards
        // (kind:"action") always require user confirmation, even when the
        // capability is configured as "auto". Tools whose `execute()` performs
        // direct work (e.g. remember_this) honour "auto" naturally because
        // they return kind:"data". When a non-auto write tool is configured
        // as "auto" via override, the card is still surfaced — degraded-safe.
        if (decision.allowed && !decision.auto && tool.capability.startsWith("write.")) {
          // No-op: HITL action card is the tool's own responsibility.
        }
        if (!decision.allowed) {
          toolResultText = `Permission denied for ${tool.capability}: ${decision.reason}. Tell the user this isn't enabled for them yet — they can request access in Settings → AI Assistant.`;
          toolsDenied++;
          lastTool = tc.name;
          void logActivity({
            organizationId: ctx.organizationId, userId: ctx.rep.id,
            channel: ctx.channel, conversationRef: ctx.conversationRef,
            direction: "tool", tool: tc.name, capability: tool.capability,
            inputJson: args, model, outcome: "denied",
            errorMessage: decision.reason, latencyMs: Date.now() - iterStart,
          });
        } else {
          const toolStart = Date.now();
          try {
            const result = await tool.execute(ctx, args);
            toolsRun++;
            lastTool = tc.name;
            void logActivity({
              organizationId: ctx.organizationId, userId: ctx.rep.id,
              channel: ctx.channel, conversationRef: ctx.conversationRef,
              direction: "tool", tool: tc.name, capability: tool.capability,
              inputJson: args, outputJson: { kind: result.kind } as any,
              model, outcome: "ok", latencyMs: Date.now() - toolStart,
              relatedCompanyId: result.kind === "data" ? result.relatedCompanyId ?? null : null,
            });

            if (result.kind === "data") {
              toolResultText = result.text;
              if (result.relatedCompanyId) {
                sources!.push({
                  kind: "company",
                  id: result.relatedCompanyId,
                  label: extractCompanyLabel(result.text) || tc.name,
                  href: `/companies/${result.relatedCompanyId}`,
                });
              }
            } else if (result.kind === "navigate") {
              if (result.preface) { emit({ content: result.preface }); assistantText += result.preface; }
              emit({ navigate: result.path });
              endTurn = true;
              toolResultText = `Navigated to ${result.path}.`;
              break;
            } else if (result.kind === "action") {
              if (result.preface) { emit({ content: result.preface }); assistantText += result.preface; }
              emit({ action: { tool: result.tool, args: result.args } });
              endTurn = true;
              surfacedAction = true;
              toolResultText = `Action card surfaced: ${result.tool}.`;
              break;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toolResultText = `Tool ${tc.name} failed: ${msg}`;
            toolErrors++;
            lastTool = tc.name;
            void logActivity({
              organizationId: ctx.organizationId, userId: ctx.rep.id,
              channel: ctx.channel, conversationRef: ctx.conversationRef,
              direction: "tool", tool: tc.name, capability: tool.capability,
              inputJson: args, model, outcome: "error",
              errorMessage: msg, latencyMs: Date.now() - toolStart,
            });
          }
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResultText,
      });
    }

    if (endTurn) break;
    // After feeding tool results back, default to the fast model for follow-up
    // synthesis; the reasoning model already chose the tools.
    model = AGENT_MODELS.fast;
  }

  const hedged = HEDGE_PATTERNS.some((p) => p.test(assistantText));
  const confidence = scoreConfidence({ toolsRun, toolErrors, degraded, hedged, hadError, assistantText });
  const route = deriveRoute({ surfacedAction, toolsRun, lastTool, hadError });
  const outcome = deriveOutcome({ hadError, toolErrors, toolsDenied, confidence });

  try { emit({ confidence, route }); } catch {}

  void logActivity({
    organizationId: ctx.organizationId,
    userId: ctx.rep.id,
    channel: ctx.channel,
    conversationRef: ctx.conversationRef,
    direction: "turn_complete",
    summary: `${iterations} iteration(s)`,
    model,
    latencyMs: Date.now() - startedAt,
    outcome,
    confidence: String(confidence) as any,
    route,
    actionOutcome: surfacedAction ? "surfaced" : null,
  });

  // Build follow-up suggestions from the assistant's reply.
  const followUps = inferFollowUps(assistantText, sources!);
  const meta: AnswerMeta = {
    sources: dedupeSources(sources!).slice(0, 6),
    followUps,
    scope: ctx.scope === "everyone" ? "Org-wide view" : "My team",
    confidence: hadError ? "low" : (sources!.length ? "high" : "medium"),
  };
  if (meta.sources?.length || meta.followUps?.length) emit({ meta });

  return { assistantText, hadError, surfacedAction, agentId, meta, confidence, route };
}
