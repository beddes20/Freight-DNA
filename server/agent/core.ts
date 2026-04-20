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
import { TOOLS, TOOL_BY_NAME, openAiToolSpecs, type AgentContext } from "./tools";
import { canInvoke } from "./permissions";
import { listFacts, searchMemories } from "./memory";
import { logActivity } from "./activity";
import { buildSystemPrompt, ensureDefaultAgent } from "./persona";

export type AgentEvent =
  | { content: string }
  | { navigate: string }
  | { action: { tool: string; args: Record<string, unknown> } }
  | { error: string }
  | { done: true };

export type Emit = (event: AgentEvent) => void;

export interface RunAgentTurnArgs {
  ctx: AgentContext;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  userMessage: string;
  emit: Emit;
}

const MAX_TOOL_ITERATIONS = 6;

async function buildContextEnvelope(ctx: AgentContext, userMessage: string): Promise<string> {
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

  return lines.join("\n");
}

export async function runAgentTurn({ ctx, history, userMessage, emit }: RunAgentTurnArgs): Promise<{ assistantText: string; hadError: boolean; surfacedAction: boolean }> {
  let hadError = false;
  let surfacedAction = false;
  const startedAt = Date.now();
  const client = getAgentOpenAI();
  const envelope = await buildContextEnvelope(ctx, userMessage);
  const agentId = await ensureDefaultAgent(ctx.organizationId);
  const systemPrompt = await buildSystemPrompt(agentId, ctx.channel);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: `${systemPrompt}\n\n=== CONTEXT ===\n${envelope}` },
    ...history.map((m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
    { role: "user", content: userMessage },
  ];

  let assistantText = "";
  let iterations = 0;
  let model: string = AGENT_MODELS.reasoning;

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
        tools: openAiToolSpecs(),
        tool_choice: "auto",
        stream: true,
        max_tokens: 1200,
      });
    } catch (err) {
      console.error("[agent.core] OpenAI call failed:", err);
      hadError = true;
      emit({ error: "AI service temporarily unavailable. Please try again." });
      return { assistantText, hadError, surfacedAction };
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

      // Permission check
      let toolResultText = "";
      if (!tool) {
        toolResultText = `Tool "${tc.name}" not registered.`;
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

  void logActivity({
    organizationId: ctx.organizationId,
    userId: ctx.rep.id,
    channel: ctx.channel,
    conversationRef: ctx.conversationRef,
    direction: "turn_complete",
    summary: `${iterations} iteration(s)`,
    model,
    latencyMs: Date.now() - startedAt,
    outcome: "ok",
  });

  return { assistantText, hadError, surfacedAction };
}
