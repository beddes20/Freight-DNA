/**
 * Phase 5 (Task #425) — DNA Copilot analytics data-access layer.
 *
 * All copilot analytics reads go through this module. Every method
 * REQUIRES an `organizationId` and applies the org filter at the storage
 * layer so route handlers never have a code path that can read another
 * tenant's analytics. The route layer keeps responsibility for AUTHZ
 * (role check) only.
 *
 * Why a separate module:
 *  - storage.ts is a 7k-line monolith; we don't want to grow it further
 *    for one feature.
 *  - These reads are read-only aggregations; isolating them keeps the
 *    test surface small and lets us add fixtures/integration tests
 *    against a single contract.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./storage";
import {
  agentActivity,
  copilotActions,
  copilotFeedback,
  users,
  type CopilotAction,
} from "@shared/schema";

function daysAgo(d: number): Date {
  const t = new Date();
  t.setDate(t.getDate() - d);
  return t;
}

// ─── Typed row parsers for our raw SQL aggregations. We never trust the
//     untyped `Record<string, unknown>` shape that drizzle's `db.execute`
//     hands back; instead we coerce known columns through helpers and
//     return narrowly-typed objects so the rest of the module is fully
//     typed (no `any` leakage past these boundaries).
type SqlRow = Record<string, unknown>;
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string => (v == null ? "" : String(v));

interface QuestionRow { question: string; count: number }
interface ToolMixRow { tool: string; outcome: string; count: number }
interface OutcomeRow { outcome: string; count: number }
interface FeedbackRow { rating: string; count: number }
interface LatencyRow { p50: number | null; p95: number | null; avg: number | null; n: number }
interface WeeklyRow { week: string; turns: number; failed: number; avgConfidence: number | null }

function parseQuestion(r: SqlRow): QuestionRow { return { question: str(r.q), count: num(r.n) }; }
function parseToolMix(r: SqlRow): ToolMixRow { return { tool: str(r.tool), outcome: str(r.outcome), count: num(r.n) }; }
function parseOutcome(r: SqlRow): OutcomeRow { return { outcome: str(r.outcome ?? "unknown"), count: num(r.n) }; }
function parseFeedback(r: SqlRow): FeedbackRow { return { rating: str(r.rating), count: num(r.n) }; }
function parseLatency(r: SqlRow | undefined): LatencyRow {
  if (!r) return { p50: null, p95: null, avg: null, n: 0 };
  return { p50: numOrNull(r.p50), p95: numOrNull(r.p95), avg: numOrNull(r.avg), n: num(r.n) };
}
function parseWeekly(r: SqlRow): WeeklyRow {
  const week = r.week instanceof Date
    ? r.week.toISOString().slice(0, 10)
    : str(r.week).slice(0, 10);
  return { week, turns: num(r.turns), failed: num(r.failed), avgConfidence: numOrNull(r.avg_conf) };
}

export interface OverviewKpis {
  windowDays: number;
  totals: {
    turns: number;
    inbound: number;
    actionsConfirmed: number;
  };
  rates: {
    /** turns whose outcome ∈ {error, tool_error, denied} ÷ total turns */
    unansweredRate: number;
    /** turns whose outcome = 'low_confidence' ÷ total turns */
    lowConfidenceRate: number;
    /** thumbs-down ÷ (thumbs-up + thumbs-down) */
    thumbsDownRate: number;
    /** thumbs-up ÷ (thumbs-up + thumbs-down) */
    thumbsUpRate: number;
    /** ok ÷ total turns */
    successRate: number;
  };
  topQuestions: Array<{ question: string; count: number }>;
  toolMix: Array<{ tool: string; outcome: string; count: number }>;
  latency: { p50: number | null; p95: number | null; avg: number | null; count: number };
  outcomes: Array<{ outcome: string; count: number }>;
  feedback: { up: number; down: number };
  weekly: Array<{ week: string; turns: number; failed: number; avgConfidence: number | null }>;
}

export interface NeedsAttentionRow {
  id: string;
  userId: string;
  userName: string;
  conversationRef: string | null;
  messageId: number | null;
  summary: string | null;
  outcome: string | null;
  confidence: number | null;
  route: string | null;
  feedbackRating: string | null;
  actionOutcome: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
  feedbackComment: string | null;
}

export interface ActionsRow extends CopilotAction {
  userName: string;
}

export interface TurnToolCall {
  id: string;
  tool: string | null;
  capability: string | null;
  outcome: string;
  errorMessage: string | null;
  inputJson: unknown;
  outputJson: unknown;
  latencyMs: number | null;
  createdAt: Date;
}

export interface TurnDetail {
  id: string;
  userId: string;
  userName: string;
  conversationRef: string | null;
  messageId: number | null;
  /** The user's input prompt for this turn (the most-recent inbound row). */
  question: string | null;
  /** Short headline for the turn (the assistant's `agent_activity.summary`). */
  summary: string | null;
  /**
   * Full assistant output body, taken from `agent_activity.output_json`.
   * Phase 5 audit requirement: needs-attention drawer must show what the
   * assistant actually returned, not just the headline summary.
   */
  assistantOutput: unknown;
  /**
   * Envelope summary — the trimmed system-prompt / context envelope we
   * sent to the model for this turn (from `agent_activity.input_json`).
   * Used by admins to reconstruct what the model "saw" when triaging
   * a failure.
   */
  envelopeSummary: unknown;
  outcome: string;
  confidence: number | null;
  route: string | null;
  feedbackRating: string | null;
  feedbackComment: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
  toolsUsed: string[];
  /** Detailed tool calls (input + output) for full-turn audit. */
  toolCalls: TurnToolCall[];
  actions: Array<{
    id: string;
    tool: string;
    result: string;
    args: unknown;
    errorMessage: string | null;
    completedAt: Date;
  }>;
}

export const agentAnalyticsStorage = {
  /** Org-scoped overview KPIs. */
  async getOverview(organizationId: string, days: number): Promise<OverviewKpis> {
    const since = daysAgo(days);

    const topQuestionsRaw = await db.execute(sql`
      SELECT lower(trim(summary)) as q, count(*)::int as n
      FROM ${agentActivity}
      WHERE organization_id = ${organizationId}
        AND direction = 'inbound'
        AND created_at >= ${since}
        AND summary IS NOT NULL
      GROUP BY lower(trim(summary))
      ORDER BY n DESC
      LIMIT 20
    `);
    const topQuestions: QuestionRow[] = (topQuestionsRaw.rows as SqlRow[]).map(parseQuestion);

    const toolMixRaw = await db.execute(sql`
      SELECT tool, outcome, count(*)::int as n
      FROM ${agentActivity}
      WHERE organization_id = ${organizationId}
        AND direction = 'tool'
        AND created_at >= ${since}
        AND tool IS NOT NULL
      GROUP BY tool, outcome
      ORDER BY n DESC
    `);
    const toolMix: ToolMixRow[] = (toolMixRaw.rows as SqlRow[]).map(parseToolMix);

    const latencyRaw = await db.execute(sql`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95,
        avg(latency_ms)::int as avg,
        count(*)::int as n
      FROM ${agentActivity}
      WHERE organization_id = ${organizationId}
        AND direction = 'turn_complete'
        AND created_at >= ${since}
        AND latency_ms IS NOT NULL
    `);
    const lat = parseLatency((latencyRaw.rows as SqlRow[])[0]);

    const outcomesRaw = await db.execute(sql`
      SELECT outcome, count(*)::int as n
      FROM ${agentActivity}
      WHERE organization_id = ${organizationId}
        AND direction = 'turn_complete'
        AND created_at >= ${since}
      GROUP BY outcome
    `);
    const outcomes: OutcomeRow[] = (outcomesRaw.rows as SqlRow[]).map(parseOutcome);

    const fbRaw = await db.execute(sql`
      SELECT rating, count(*)::int as n
      FROM ${copilotFeedback}
      WHERE organization_id = ${organizationId}
        AND captured_at >= ${since}
      GROUP BY rating
    `);
    const feedback = (fbRaw.rows as SqlRow[]).map(parseFeedback).reduce<{ up: number; down: number }>(
      (m, r) => {
        if (r.rating === "up") m.up = r.count;
        else if (r.rating === "down") m.down = r.count;
        return m;
      },
      { up: 0, down: 0 },
    );

    const inboundRaw = await db.execute(sql`
      SELECT count(*)::int as n
      FROM ${agentActivity}
      WHERE organization_id = ${organizationId}
        AND direction = 'inbound'
        AND created_at >= ${since}
    `);
    const inbound = num((inboundRaw.rows as SqlRow[])[0]?.n);

    const actionsRaw = await db.execute(sql`
      SELECT count(*)::int as n
      FROM ${copilotActions}
      WHERE organization_id = ${organizationId}
        AND completed_at >= ${since}
    `);
    const actionsConfirmed = num((actionsRaw.rows as SqlRow[])[0]?.n);

    const weeklyRaw = await db.execute(sql`
      SELECT date_trunc('week', created_at) as week,
             count(*)::int as turns,
             sum(CASE WHEN outcome != 'ok' THEN 1 ELSE 0 END)::int as failed,
             avg(CASE WHEN confidence IS NOT NULL THEN confidence ELSE NULL END)::float as avg_conf
      FROM ${agentActivity}
      WHERE organization_id = ${organizationId}
        AND direction = 'turn_complete'
        AND created_at >= ${daysAgo(Math.max(56, days))}
      GROUP BY week
      ORDER BY week ASC
    `);
    const weekly: WeeklyRow[] = (weeklyRaw.rows as SqlRow[]).map(parseWeekly);

    // ─── Rates ────────────────────────────────────────────────────────
    const totalTurns = outcomes.reduce((s, o) => s + o.count, 0);
    const safeRate = (n: number, d: number) => (d > 0 ? n / d : 0);
    const sumOutcome = (...keys: string[]) =>
      outcomes
        .filter((o) => keys.includes(o.outcome))
        .reduce((s, o) => s + o.count, 0);
    const unansweredRate = safeRate(
      sumOutcome("error", "tool_error", "denied"),
      totalTurns,
    );
    const lowConfidenceRate = safeRate(sumOutcome("low_confidence"), totalTurns);
    const successRate = safeRate(sumOutcome("ok"), totalTurns);
    const thumbsTotal = feedback.up + feedback.down;
    const thumbsDownRate = safeRate(feedback.down, thumbsTotal);
    const thumbsUpRate = safeRate(feedback.up, thumbsTotal);

    return {
      windowDays: days,
      totals: { turns: totalTurns, inbound, actionsConfirmed },
      rates: {
        unansweredRate,
        lowConfidenceRate,
        thumbsDownRate,
        thumbsUpRate,
        successRate,
      },
      topQuestions,
      toolMix,
      latency: { p50: lat.p50, p95: lat.p95, avg: lat.avg, count: lat.n },
      outcomes,
      feedback,
      weekly,
    };
  },

  async getNeedsAttention(
    organizationId: string,
    days: number,
    limit: number,
  ): Promise<NeedsAttentionRow[]> {
    const since = daysAgo(days);
    const turnsRows = await db
      .select({
        id: agentActivity.id,
        userId: agentActivity.userId,
        conversationRef: agentActivity.conversationRef,
        messageId: agentActivity.messageId,
        summary: agentActivity.summary,
        outcome: agentActivity.outcome,
        confidence: agentActivity.confidence,
        route: agentActivity.route,
        feedbackRating: agentActivity.feedbackRating,
        actionOutcome: agentActivity.actionOutcome,
        latencyMs: agentActivity.latencyMs,
        errorMessage: agentActivity.errorMessage,
        createdAt: agentActivity.createdAt,
      })
      .from(agentActivity)
      .where(
        and(
          eq(agentActivity.organizationId, organizationId),
          eq(agentActivity.direction, "turn_complete"),
          gte(agentActivity.createdAt, since),
          // failure / no-data / low-confidence / thumbs-down turns
          sql`(
            outcome IN ('error','tool_error','denied','low_confidence','no_data')
            OR action_outcome IN ('no_data','failed')
            OR feedback_rating = 'down'
          )`,
        ),
      )
      .orderBy(desc(agentActivity.createdAt))
      .limit(limit);

    const ids = Array.from(new Set(turnsRows.map((r) => r.userId)));
    const nameRows = ids.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : [];
    const nameMap = new Map(nameRows.map((n) => [n.id, n.name]));

    const msgIds = turnsRows.map((r) => r.messageId).filter((x): x is number => x != null);
    const comments = msgIds.length
      ? await db.select().from(copilotFeedback).where(
          and(
            eq(copilotFeedback.organizationId, organizationId),
            inArray(copilotFeedback.messageId, msgIds),
          ),
        )
      : [];
    const commentByMsg = new Map<number, string>();
    for (const c of comments) {
      if (c.messageId != null && c.comment) commentByMsg.set(c.messageId, c.comment);
    }

    return turnsRows.map((r) => ({
      ...r,
      confidence: r.confidence == null ? null : Number(r.confidence),
      userName: nameMap.get(r.userId) ?? "Unknown",
      feedbackComment: r.messageId != null ? (commentByMsg.get(r.messageId) ?? null) : null,
    }));
  },

  async getRecentActions(
    organizationId: string,
    days: number,
    limit: number,
  ): Promise<ActionsRow[]> {
    const since = daysAgo(days);
    const rows = await db
      .select()
      .from(copilotActions)
      .where(
        and(
          eq(copilotActions.organizationId, organizationId),
          gte(copilotActions.completedAt, since),
        ),
      )
      .orderBy(desc(copilotActions.completedAt))
      .limit(limit);
    const ids = Array.from(new Set(rows.map((r) => r.confirmedByUserId)));
    const nameRows = ids.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : [];
    const nameMap = new Map(nameRows.map((n) => [n.id, n.name]));
    return rows.map((r) => ({ ...r, userName: nameMap.get(r.confirmedByUserId) ?? "Unknown" }));
  },

  async getActionsByUser(
    organizationId: string,
    userId: string,
    limit: number,
  ): Promise<CopilotAction[]> {
    return db
      .select()
      .from(copilotActions)
      .where(
        and(
          eq(copilotActions.organizationId, organizationId),
          eq(copilotActions.confirmedByUserId, userId),
        ),
      )
      .orderBy(desc(copilotActions.completedAt))
      .limit(limit);
  },

  async getActionsByCompany(
    organizationId: string,
    companyId: string,
    limit: number,
  ): Promise<ActionsRow[]> {
    const rows = await db
      .select()
      .from(copilotActions)
      .where(
        and(
          eq(copilotActions.organizationId, organizationId),
          eq(copilotActions.relatedCompanyId, companyId),
        ),
      )
      .orderBy(desc(copilotActions.completedAt))
      .limit(limit);
    const ids = Array.from(new Set(rows.map((r) => r.confirmedByUserId)));
    const nameRows = ids.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : [];
    const nameMap = new Map(nameRows.map((n) => [n.id, n.name]));
    return rows.map((r) => ({ ...r, userName: nameMap.get(r.confirmedByUserId) ?? "Unknown" }));
  },

  async getTurnDetail(
    organizationId: string,
    turnId: string,
  ): Promise<TurnDetail | null> {
    const [turn] = await db
      .select()
      .from(agentActivity)
      .where(
        and(
          eq(agentActivity.id, turnId),
          eq(agentActivity.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!turn) return null;

    const siblings = turn.conversationRef
      ? await db
          .select()
          .from(agentActivity)
          .where(
            and(
              eq(agentActivity.organizationId, organizationId),
              eq(agentActivity.conversationRef, turn.conversationRef),
            ),
          )
          .orderBy(desc(agentActivity.createdAt))
          .limit(40)
      : [];

    const inbound = siblings.find(
      (s) => s.direction === "inbound" && s.createdAt <= turn.createdAt,
    );

    const toolSiblings = siblings.filter(
      (s) =>
        s.tool && (turn.messageId == null || s.messageId === turn.messageId),
    );
    const toolsUsed = Array.from(new Set(toolSiblings.map((s) => s.tool!)));
    const toolCalls: TurnToolCall[] = toolSiblings.map((s) => ({
      id: s.id,
      tool: s.tool,
      capability: s.capability,
      outcome: s.outcome ?? "ok",
      errorMessage: s.errorMessage ?? null,
      inputJson: s.inputJson ?? null,
      outputJson: s.outputJson ?? null,
      latencyMs: s.latencyMs ?? null,
      createdAt: s.createdAt,
    }));

    const feedbackRow =
      turn.messageId != null
        ? (
            await db
              .select()
              .from(copilotFeedback)
              .where(
                and(
                  eq(copilotFeedback.organizationId, organizationId),
                  eq(copilotFeedback.messageId, turn.messageId),
                ),
              )
              .limit(1)
          )[0] ?? null
        : null;

    const actionRows =
      turn.messageId != null
        ? await db
            .select()
            .from(copilotActions)
            .where(
              and(
                eq(copilotActions.organizationId, organizationId),
                eq(copilotActions.messageId, turn.messageId),
              ),
            )
            .orderBy(desc(copilotActions.completedAt))
        : [];

    const [u] = turn.userId
      ? await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, turn.userId))
          .limit(1)
      : [];

    return {
      id: turn.id,
      userId: turn.userId,
      userName: u?.name ?? "—",
      conversationRef: turn.conversationRef,
      messageId: turn.messageId,
      question: inbound?.summary ?? null,
      summary: turn.summary,
      assistantOutput: turn.outputJson ?? null,
      envelopeSummary: inbound?.inputJson ?? turn.inputJson ?? null,
      outcome: turn.outcome ?? "ok",
      confidence: turn.confidence == null ? null : Number(turn.confidence),
      route: turn.route ?? null,
      feedbackRating: feedbackRow?.rating ?? null,
      feedbackComment: feedbackRow?.comment ?? null,
      latencyMs: turn.latencyMs ?? null,
      errorMessage: turn.errorMessage ?? null,
      createdAt: turn.createdAt,
      toolsUsed,
      toolCalls,
      actions: actionRows.map((a) => ({
        id: a.id,
        tool: a.tool,
        result: a.result,
        args: a.args,
        errorMessage: a.errorMessage,
        completedAt: a.completedAt,
      })),
    };
  },
};
