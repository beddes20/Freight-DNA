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
import { retrieveContext, formatHitsForPrompt, type RetrievalHit } from "./retrieval";
import { rememberEntity } from "./sessionMemo";
import type { DepthMode } from "./classifier";
import { db } from "../storage";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { documents, documentExtractions, copilotIntelligence, copilotPlayRecommendations } from "@shared/schema";

export interface AnswerMeta {
  sources?: Array<{
    kind: string;
    id?: string;
    label: string;
    href?: string;
    /** ISO timestamp; client renders a relative age (e.g. "3 days old"). */
    updatedAt?: string;
    /** Optional bucket the source came from (org | library | project | tool). */
    bucket?: string;
  }>;
  followUps?: string[];
  scope?: string;
  confidence?: "high" | "medium" | "low";
}

export interface HealthSnapshot {
  embedder: "ok" | "down";
  orgCorpus: "ok" | "down";
  library: "ok" | "down";
  project: "ok" | "down" | "n/a";
}

export type AgentEvent =
  | { content: string }
  | { navigate: string }
  | { action: { tool: string; args: Record<string, unknown> } }
  | { progress: string }
  | { meta: AnswerMeta }
  | { error: string }
  | { confidence: number; route: string }
  | { mode: DepthMode; modeLabel: string }
  | { health: HealthSnapshot & { degraded: boolean } }
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
  /** Pre-classified depth mode. Defaults to "analytical". */
  mode?: DepthMode;
}

const MAX_TOOL_ITERATIONS = 6;

async function buildContextEnvelope(
  ctx: AgentContext,
  userMessage: string,
  projectId?: string | null,
): Promise<{ envelope: string; degraded: boolean; hits: RetrievalHit[]; health: NonNullable<Awaited<ReturnType<typeof retrieveContext>>["health"]> }> {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const lines: string[] = [
    `Today is ${today}.`,
    `Rep: ${ctx.rep.name} (${String(ctx.rep.role).replace(/_/g, " ")})`,
    `Channel: ${ctx.channel}`,
    `Data scope: ${ctx.scope === "everyone" ? "entire organization" : "rep's team only"}`,
  ];

  // Run facts, memory search, and retrieval concurrently — none of them need
  // each other's output, and the previous serial implementation cost ~1–3s of
  // wall-clock per turn while waiting on embeddings + DB calls one after the
  // other. Each branch handles its own failure so a single slow/broken one
  // can never block the others.
  const factsPromise = listFacts(ctx.rep.id).catch(() => [] as Awaited<ReturnType<typeof listFacts>>);
  const memoryPromise = searchMemories(ctx.rep.id, userMessage, 3).catch(() => [] as Awaited<ReturnType<typeof searchMemories>>);
  const retrievalPromise = retrieveContext({
    organizationId: ctx.organizationId,
    userId: ctx.rep.id,
    query: userMessage,
    projectId: projectId ?? null,
    perBucket: 4,
  }).catch((err) => {
    console.warn("[agent.core] retrieval failed:", err);
    return {
      hits: [] as RetrievalHit[],
      degraded: true,
      health: { embedder: "down" as const, orgCorpus: "down" as const, library: "down" as const, project: (projectId ? "down" : "n/a") as "down" | "n/a" },
    };
  });

  const [facts, memHits, retrieval] = await Promise.all([factsPromise, memoryPromise, retrievalPromise]);

  const pinned = facts.filter((f) => f.pinned).slice(0, 8);
  if (pinned.length) {
    lines.push("", "Standing facts about this rep:");
    for (const f of pinned) lines.push(`• ${f.fact}`);
  }
  if (memHits.length) {
    lines.push("", "Possibly relevant memories from prior sessions (use only if applicable):");
    for (const h of memHits) lines.push(`• ${h.content}`);
  }
  const formatted = formatHitsForPrompt(retrieval.hits, 3500);
  if (formatted) lines.push(formatted);

  // Task #926: surface recent documents the rep has uploaded along with
  // their resolved customer + computed intelligence summary + any open
  // play recommendations. We scope strictly to docs uploaded by this rep
  // (not the whole org) so we never leak someone else's customer doc into
  // a chat envelope. This block is best-effort — failures degrade silently.
  try {
    const recentDocsBlock = await buildRecentDocumentsBlock(ctx);
    if (recentDocsBlock) lines.push("", recentDocsBlock);
  } catch (err) {
    console.warn("[agent.core] recent_documents envelope skipped:", err);
  }

  const health = retrieval.health ?? { embedder: "ok", orgCorpus: "ok", library: "ok", project: projectId ? "ok" : "n/a" };
  return { envelope: lines.join("\n"), degraded: retrieval.degraded, hits: retrieval.hits, health };
}

/**
 * Recent-documents context block. Pulls up to 5 of the rep's most recent
 * parsed documents in the last 14 days, joins resolved customer name from
 * the extraction row, and surfaces any open play recommendations so the
 * agent can reference them without an extra tool call.
 *
 * Visibility rule: uploader-only — we don't list documents tied to other
 * reps' customers. This avoids leaking through the agent envelope what we
 * gate behind canAccessCompany at the HTTP layer.
 */
async function buildRecentDocumentsBlock(ctx: AgentContext): Promise<string | null> {
  const since = new Date(Date.now() - 14 * 86400_000);
  const recent = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      classLabel: documents.classLabel,
      status: documents.status,
      parsedAt: documents.parsedAt,
      createdAt: documents.createdAt,
      extractionResolved: documentExtractions.resolvedEntities,
      extractionPayload: documentExtractions.payload,
    })
    .from(documents)
    .leftJoin(
      documentExtractions,
      and(
        eq(documentExtractions.documentId, documents.id),
        eq(documentExtractions.organizationId, ctx.organizationId),
      ),
    )
    .where(and(
      eq(documents.organizationId, ctx.organizationId),
      eq(documents.uploaderId, ctx.rep.id),
      gte(documents.createdAt, since),
    ))
    .orderBy(desc(documents.createdAt))
    .limit(5);

  if (!recent.length) return null;

  const docIds = recent.map((d) => d.id);
  const intel = await db
    .select({
      documentId: copilotIntelligence.documentId,
      laneFitScore: copilotIntelligence.laneFitScore,
      customerFitScore: copilotIntelligence.customerFitScore,
      priceMid: copilotIntelligence.priceMid,
      confidence: copilotIntelligence.confidence,
    })
    .from(copilotIntelligence)
    .where(and(
      eq(copilotIntelligence.organizationId, ctx.organizationId),
      sql`${copilotIntelligence.documentId} = ANY(${docIds}::text[])`,
    ));
  const intelByDoc = new Map(intel.map((i) => [i.documentId ?? "", i]));

  const openPlays = await db
    .select({
      documentId: copilotPlayRecommendations.documentId,
      playName: copilotPlayRecommendations.playName,
      confidence: copilotPlayRecommendations.confidence,
    })
    .from(copilotPlayRecommendations)
    .where(and(
      eq(copilotPlayRecommendations.organizationId, ctx.organizationId),
      eq(copilotPlayRecommendations.status, "pending"),
      sql`${copilotPlayRecommendations.documentId} = ANY(${docIds}::text[])`,
    ));
  const playsByDoc = new Map<string, Array<{ playName: string; confidence: string }>>();
  for (const p of openPlays) {
    const k = p.documentId ?? "";
    if (!playsByDoc.has(k)) playsByDoc.set(k, []);
    playsByDoc.get(k)!.push({ playName: p.playName, confidence: p.confidence });
  }

  const out: string[] = ["Recent documents you've uploaded (last 14 days):"];
  for (const d of recent) {
    const resolved = (d.extractionResolved as { customerName?: string } | null) ?? null;
    const intelRow = intelByDoc.get(d.id);
    const plays = playsByDoc.get(d.id) ?? [];
    const parts: string[] = [
      `• [${d.classLabel}] ${d.filename}`,
    ];
    if (resolved?.customerName) parts.push(`customer=${resolved.customerName}`);
    if (intelRow) {
      const bits: string[] = [];
      if (intelRow.laneFitScore != null) bits.push(`lane_fit=${intelRow.laneFitScore}`);
      if (intelRow.customerFitScore != null) bits.push(`cust_fit=${intelRow.customerFitScore}`);
      if (intelRow.priceMid != null) bits.push(`mid=$${Number(intelRow.priceMid).toFixed(2)}/mi`);
      if (bits.length) parts.push(`intel: ${bits.join(", ")} (${intelRow.confidence})`);
    }
    if (plays.length) {
      parts.push(`open_plays: ${plays.map((p) => `${p.playName}(${p.confidence})`).join("; ")}`);
    }
    parts.push(`docId=${d.id}`);
    out.push(parts.join(" — "));
  }
  out.push("(Use get_document_intelligence or recommend_plays_for_document with docId for detail.)");
  return out.join("\n");
}

export async function runAgentTurn({ ctx, history, userMessage, emit, agentId: agentIdArg, projectId, pageContextBlock, mode }: RunAgentTurnArgs): Promise<{ assistantText: string; hadError: boolean; surfacedAction: boolean; agentId: string; meta: AnswerMeta; confidence: number; route: string; mode: DepthMode }> {
  let hadError = false;
  let surfacedAction = false;
  let toolsRun = 0;
  let toolErrors = 0;
  let toolsDenied = 0;
  let lastTool: string | null = null;
  const sources: AnswerMeta["sources"] = [];
  const startedAt = Date.now();
  const client = getAgentOpenAI();
  const { envelope: baseEnvelope, degraded, hits: retrievalHits, health } = await buildContextEnvelope(ctx, userMessage, projectId);
  emit({ health: { ...health, degraded } });
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
  const depthMode: DepthMode = mode ?? "analytical";
  // Quick turns run on the fast model start-to-finish. Analytical turns honour
  // the persisted runtime.model (defaults to the reasoning model).
  let model: string = depthMode === "quick"
    ? AGENT_MODELS.fast
    : (runtime?.model || AGENT_MODELS.reasoning);
  try {
    emit({ mode: depthMode, modeLabel: depthMode === "quick" ? "Quick answer" : "Full analysis" });
  } catch {}

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
      return { assistantText, hadError, surfacedAction, agentId, meta: { confidence: "low" }, confidence: 0.1, route: "error", mode: depthMode };
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

            // Seed sessionMemo with any typed entity hints the tool returned.
            // This covers carrier/lane/RFP/prospect/contact follow-ups so the
            // next turn's "this", "it", "the first one" resolves silently.
            // `related` is an optional field on every ToolOutput variant.
            const relatedHints = result.related;
            if (relatedHints && relatedHints.length) {
              try {
                for (const h of relatedHints) {
                  if (!h?.type || !h?.id || !h?.name) continue;
                  rememberEntity(ctx.conversationRef, {
                    type: h.type,
                    id: String(h.id),
                    name: String(h.name).slice(0, 80),
                  });
                }
              } catch {}
            }

            if (result.kind === "data") {
              toolResultText = result.text;
              if (result.relatedCompanyId) {
                const label = extractCompanyLabel(result.text) || tc.name;
                sources!.push({
                  kind: "company",
                  id: result.relatedCompanyId,
                  label,
                  href: `/companies/${result.relatedCompanyId}`,
                });
                // Seed the per-conversation memo so "summarize it" / "open it"
                // resolve without re-asking, even when the LLM (not the
                // router) was the one that surfaced this entity.
                try {
                  rememberEntity(ctx.conversationRef, {
                    type: "company",
                    id: result.relatedCompanyId,
                    name: label.replace(/^=+\s*|\s*=+$/g, "").trim().slice(0, 80),
                  });
                } catch {}
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

  // Merge retrieval-derived sources so reps can verify which docs/records
  // the answer was grounded on (and how stale they are).
  for (const h of retrievalHits.slice(0, 6)) {
    sources!.push(retrievalHitToSource(h));
  }

  // Build follow-up suggestions from the assistant's reply.
  const followUps = inferFollowUps(assistantText, sources!);
  const meta: AnswerMeta = {
    sources: dedupeSources(sources!).slice(0, 8),
    followUps,
    scope: ctx.scope === "everyone" ? "Org-wide view" : "My team",
    confidence: hadError ? "low" : (sources!.length ? "high" : "medium"),
  };
  if (meta.sources?.length || meta.followUps?.length) emit({ meta });

  return { assistantText, hadError, surfacedAction, agentId, meta, confidence, route, mode: depthMode };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_KIND_LABELS: Record<string, string> = {
  company: "Company record",
  contact: "Contact record",
  lane: "Lane",
  touchpoint: "Touchpoint",
  play: "Play",
  proven_tactic: "Proven tactic",
  market_signal: "Market signal",
};

function retrievalHitToSource(h: RetrievalHit): NonNullable<AnswerMeta["sources"]>[number] {
  const updatedAt = h.updatedAt ?? undefined;
  if (h.bucket === "library") {
    return {
      kind: `library:${h.sourceKind}`,
      id: h.sourceId,
      label: h.title?.trim() || `Library — ${h.sourceKind}`,
      updatedAt,
      bucket: "library",
    };
  }
  if (h.bucket === "project") {
    return {
      kind: "project_pin",
      id: h.sourceId,
      label: h.title ? `Project pin — ${h.title}` : "Project pinned context",
      updatedAt,
      bucket: "project",
    };
  }
  // org corpus
  const md = h.metadata as Record<string, unknown> | null | undefined;
  const niceKind = ORG_KIND_LABELS[h.sourceKind] ?? h.sourceKind.replace(/_/g, " ");
  const name = typeof md?.name === "string" ? md.name : null;
  const companyId = typeof md?.companyId === "string" ? md.companyId : null;
  const href = h.sourceKind === "company"
    ? `/companies/${h.sourceId}`
    : (companyId ? `/companies/${companyId}` : undefined);
  return {
    kind: h.sourceKind,
    id: h.sourceId,
    label: name ? `${niceKind} — ${name}` : niceKind,
    href,
    updatedAt,
    bucket: "org",
  };
}

function dedupeSources(items: NonNullable<AnswerMeta["sources"]>): NonNullable<AnswerMeta["sources"]> {
  const seen = new Set<string>();
  const out: NonNullable<AnswerMeta["sources"]> = [];
  for (const s of items) {
    const key = `${s.kind}::${s.id ?? s.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function extractCompanyLabel(text: string): string | null {
  if (!text) return null;
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const trimmed = firstLine.replace(/^[#*\-\s]+/, "").slice(0, 80);
  return trimmed || null;
}

function friendlyToolLabel(toolName: string, _args: Record<string, unknown>): string | null {
  const map: Record<string, string> = {
    log_touchpoint: "Preparing touchpoint…",
    create_task: "Drafting task…",
    complete_task: "Updating task…",
    mark_meaningful: "Marking touchpoint…",
    draft_email: "Drafting email…",
    open_filtered_queue: "Opening queue…",
    approve_freight_opportunity: "Reviewing freight opportunity…",
    remember_this: "Saving to memory…",
  };
  if (map[toolName]) return map[toolName];
  if (toolName.startsWith("get_") || toolName.startsWith("find_") || toolName.startsWith("search_") || toolName.startsWith("list_")) {
    return `Looking up ${toolName.replace(/_/g, " ").replace(/^(get|find|search|list)\s+/, "")}…`;
  }
  return `Running ${toolName.replace(/_/g, " ")}…`;
}

function inferFollowUps(_assistantText: string, sources: NonNullable<AnswerMeta["sources"]>): string[] {
  const ups: string[] = [];
  const company = sources.find((s) => s.kind === "company" && s.label);
  if (company) {
    const name = company.label.replace(/^Company record\s*—\s*/, "");
    ups.push(`Show recent touchpoints for ${name}`);
    ups.push(`Draft an outreach for ${name}`);
  }
  return ups.slice(0, 3);
}
