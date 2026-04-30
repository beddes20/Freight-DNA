/**
 * Tool registry for DNA Logistics Bot.
 *
 * Each tool declares: name, capability key, OpenAI tool spec, and an `execute`
 * handler. Handlers return a `ToolOutput` describing what to do with the result:
 *   - "data"     → feed text back to the LLM as the tool result; loop continues
 *   - "action"   → emit a HITL action card to the client; the loop ends
 *   - "navigate" → emit a navigation event + optional message; loop ends
 */
import { z } from "zod";
import { eq, and, desc, ilike, sql, inArray, gte, lte, isNull } from "drizzle-orm";
import { db } from "../storage";
import { storage } from "../storage";
import { getVisibleCompanyIds } from "../auth";
import {
  companies, contacts, tasks, touchpoints, users, freightOpportunities, type User,
  loadFact, carrierRecommendation, carrierScorecardFact,
  prospects, crmOpportunities, oneOnOneSessions, oneOnOneTopics, oneOnOneTopicReplies,
  laneCarriers, awards, nbaCards, emailMessages, emailSignals, recurringLanes,
  reportCardSnapshots,
} from "@shared/schema";
import { getBlendedRate } from "../pricingBlendService";
import { recommendCarriersForLoad } from "../carrierRecommendationEngine";
import { listAvailableFreightImports } from "../availableFreightImporter";
import {
  getNationalMarketSummary, getMarketOtris, getLaneVotrisBatch,
  getLaneMarketRate, buildVotriQualifier, withSonarCaller,
} from "../sonarClient";
import { tracLaneDirectionSignal } from "../tracAlertEngine";
import {
  runCarrierLaneSearch, getCompanyDetails, getCachedRatePositioningContext,
} from "../chatbot";
import { saveMemory, searchMemories, listFacts } from "./memory";
import { freightResearch } from "./freightResearch";
import type { Capability } from "./permissions";

export interface AgentContext {
  rep: User;
  organizationId: string;
  channel: "in_app" | "email" | "teams" | "sms" | "voice";
  conversationRef: string | null;
  scope: "my_team" | "everyone";
}

/**
 * Optional structured hint a tool can attach to its result so the agent's
 * conversation memo knows which CRM entity the answer was *about*. The next
 * turn can then resolve "this", "it", "the first one" against this list
 * without a re-ask. Keep types in sync with EntityType in sessionMemo.ts.
 */
export interface RelatedEntityHint {
  type: "company" | "contact" | "carrier" | "lane" | "rfp" | "prospect" | "task";
  id: string;
  name: string;
}

export type ToolOutput =
  | {
      kind: "data";
      text: string;
      relatedCompanyId?: string | null;
      /** Any number of typed entity hints; written to sessionMemo by core.ts. */
      related?: RelatedEntityHint[];
    }
  | { kind: "action"; tool: string; args: Record<string, unknown>; preface?: string; related?: RelatedEntityHint[] }
  | { kind: "navigate"; path: string; preface?: string; related?: RelatedEntityHint[] };

export interface AgentTool {
  name: string;
  capability: Capability;
  description: string;
  parameters: Record<string, unknown>;
  execute: (ctx: AgentContext, args: any) => Promise<ToolOutput>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function findCompanyByName(orgId: string, query: string) {
  if (!query) return null;
  const all = await db.select().from(companies).where(eq(companies.organizationId, orgId));
  const q = query.toLowerCase().trim();
  return (
    all.find((c) => c.name.toLowerCase() === q) ||
    all.find((c) => c.name.toLowerCase().includes(q)) ||
    null
  );
}

// ── registry ─────────────────────────────────────────────────────────────────

export const TOOLS: AgentTool[] = [
  // ─── READ TOOLS ──────────────────────────────────────────────────────────
  {
    name: "get_company_details",
    capability: "read.account",
    description: "Pull the full account profile for a specific company: contacts, recent touchpoints, open RFPs, account summary, quirks, tendering style, rep assignment.",
    parameters: {
      type: "object",
      properties: { company_name: { type: "string", description: "Company name (partial match ok)" } },
      required: ["company_name"],
    },
    async execute(ctx, args) {
      const text = await getCompanyDetails(ctx.organizationId, String(args.company_name || ""));
      const company = await findCompanyByName(ctx.organizationId, String(args.company_name || ""));
      return { kind: "data", text, relatedCompanyId: company?.id ?? null };
    },
  },
  {
    name: "carrier_lane_search",
    capability: "read.carrier",
    description: "Find which carriers run a specific corridor and what we're paying. Use for questions about carriers on a lane, carrier pay rates, what we're paying for a mode on a lane.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string" },
        destination: { type: "string" },
        radius_miles: { type: "number" },
        mode: { type: "string" },
        min_loads_per_month: { type: "number" },
      },
    },
    async execute(ctx, args) {
      const text = await runCarrierLaneSearch(
        ctx.organizationId,
        String(args.origin || ""), String(args.destination || ""),
        Number(args.radius_miles || 75), String(args.mode || ""),
        Number(args.min_loads_per_month || 3),
      );
      return { kind: "data", text };
    },
  },
  {
    name: "query_national_rates",
    capability: "read.market",
    description: "Live national market data from FreightWaves Sonar: national OTRI, NTI spot $/move, contract VCRPM1, spread.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return withSonarCaller("ai:query_national_rates", async () => {
        try {
          const pulse = await getNationalMarketSummary();
          const has = pulse.otri !== null;
          const sig = !has ? "⚪ No Data" : pulse.otri! > 20 ? "🔴 Hot" : pulse.otri! > 8 ? "🟡 Warm" : "🟢 Cool";
          const lines = [`FreightWaves Sonar — National Pulse${pulse.isStale ? " ⚠ Stale" : ""}`];
          if (has) lines.push(`National OTRI: ${pulse.otri!.toFixed(2)}% (${(pulse.otriWoWDelta ?? 0) >= 0 ? "+" : ""}${(pulse.otriWoWDelta ?? 0).toFixed(1)}pp WoW) — ${sig}`);
          else lines.push(`National OTRI: unavailable`);
          lines.push(pulse.ntiPerMove !== null ? `NTI Spot: $${pulse.ntiPerMove.toFixed(2)}/move` : "NTI Spot: unavailable");
          lines.push(pulse.ntiPerMile !== null ? `Contract (VCRPM1): $${pulse.ntiPerMile.toFixed(2)}/mile` : "Contract: unavailable");
          return { kind: "data" as const, text: lines.join("\n") };
        } catch {
          return { kind: "data" as const, text: "Sonar national data temporarily unavailable." };
        }
      });
    },
  },
  {
    name: "query_market_otri",
    capability: "read.market",
    description: "Live OTRI/VOTRI for a specific market/city. Use for 'is X tight?', 'what's OTRI in Y?'.",
    parameters: {
      type: "object",
      properties: { market: { type: "string" } },
      required: ["market"],
    },
    async execute(_ctx, args) {
      const market = String(args.market || "").trim();
      if (!market) return { kind: "data", text: "No market specified." };
      return withSonarCaller("ai:query_market_otri", async () => {
        try {
          const otris = await getMarketOtris([market]);
          const m = otris[0];
          if (!m) return { kind: "data" as const, text: `No Sonar data for "${market}".` };
          // Honest empty state (Task #740): if both OTRI and VOTRI are null we
          // explicitly tell the agent that no live data is available rather
          // than emitting just a header line.
          if (m.otri === null && (m.votri === null || m.votri === undefined)) {
            return { kind: "data" as const, text: `Sonar market — ${m.market}: no live OTRI/VOTRI data available right now.` };
          }
          const sig = m.signal === "hot" ? "🔴 Hot" : m.signal === "warm" ? "🟡 Warm" : m.signal === "cool" ? "🟢 Cool" : "⚪";
          const lines = [`Sonar market — ${m.market}:`];
          if (m.otri !== null) lines.push(`OTRI: ${m.otri.toFixed(1)}% ${sig}`);
          if (m.votri !== null && m.votri !== undefined) lines.push(`VOTRI: ${m.votri.toFixed(1)}%`);
          return { kind: "data" as const, text: lines.join("\n") };
        } catch {
          return { kind: "data" as const, text: "Sonar market data temporarily unavailable." };
        }
      });
    },
  },
  {
    name: "query_lane_signal",
    capability: "read.lane",
    description: "Lane intelligence: TRAC direction (Tightening/Stable/Softening), TRAC spot rate, VOTRI when available. Use for 'how tight is X→Y?'.",
    parameters: {
      type: "object",
      properties: { origin: { type: "string" }, destination: { type: "string" } },
      required: ["origin", "destination"],
    },
    async execute(_ctx, args) {
      const origin = String(args.origin || "");
      const destination = String(args.destination || "");
      return withSonarCaller("ai:query_lane_signal", async () => {
        try {
          const [votriMap, tracDir, lmr] = await Promise.all([
            getLaneVotrisBatch([{ origin, destination }]),
            tracLaneDirectionSignal(origin, destination).catch(() => null),
            getLaneMarketRate(origin, destination).catch(() => ({ marketRatePerMile: null as number | null })),
          ]);
          const votri = votriMap.get(buildVotriQualifier(origin, destination));
          const dirLabel = tracDir === "hot" ? "Tightening" : tracDir === "warm" ? "Mild tightening" : tracDir === "stable" ? "Stable" : tracDir === "cool" ? "Softening" : null;
          const lines = [`${origin} → ${destination}`];
          if (dirLabel) lines.push(`TRAC Direction: ${dirLabel}`);
          if (lmr.marketRatePerMile !== null) lines.push(`TRAC Spot: $${lmr.marketRatePerMile.toFixed(2)}/mile`);
          if (votri?.votri !== null && votri?.votri !== undefined) lines.push(`VOTRI: ${votri.votri.toFixed(1)}%`);
          if (lines.length === 1) lines.push("Market data unavailable for this lane.");
          return { kind: "data" as const, text: lines.join("\n") };
        } catch {
          return { kind: "data" as const, text: "Lane signal data temporarily unavailable." };
        }
      });
    },
  },
  {
    name: "get_rate_positioning_summary",
    capability: "read.lane",
    description: "Org-wide rate positioning rollup across the rep's recurring lanes (above/at/below TRAC contract benchmark). No arguments — always summarises the current scope.",
    parameters: { type: "object", properties: {} },
    async execute(ctx, _args) {
      const text = await getCachedRatePositioningContext(ctx.organizationId, ctx.scope === "everyone" ? undefined : ctx.rep.id);
      return { kind: "data", text: text || "No rate positioning data available." };
    },
  },
  {
    name: "list_open_tasks",
    capability: "read.task",
    description: "List the rep's currently open tasks (overdue first). Use when user asks 'what's on my plate', 'open to-dos', etc.",
    parameters: { type: "object", properties: { limit: { type: "number" } } },
    async execute(ctx, args) {
      const limit = Math.min(20, Math.max(1, Number(args.limit || 10)));
      const rows = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.assignedTo, ctx.rep.id), eq(tasks.status, "open")))
        .orderBy(tasks.dueDate)
        .limit(limit);
      if (!rows.length) return { kind: "data", text: "No open tasks." };
      const today = new Date().toISOString().slice(0, 10);
      return {
        kind: "data",
        text: rows.map((t) => {
          const overdue = t.dueDate && t.dueDate < today ? " ⚠ overdue" : "";
          return `• ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}${overdue}`;
        }).join("\n"),
        related: rows.map((t) => ({ type: "task" as const, id: String(t.id), name: t.title })),
      };
    },
  },
  {
    name: "list_recent_touchpoints",
    capability: "read.touchpoint",
    description: "Most recent touchpoints (any company) the rep logged. Use for 'what did I do recently', 'last few calls'.",
    parameters: { type: "object", properties: { limit: { type: "number" } } },
    async execute(ctx, args) {
      const limit = Math.min(20, Math.max(1, Number(args.limit || 10)));
      const rows = await db
        .select({ tp: touchpoints, c: companies })
        .from(touchpoints)
        .leftJoin(companies, eq(touchpoints.companyId, companies.id))
        .where(eq(touchpoints.loggedById, ctx.rep.id))
        .orderBy(desc(touchpoints.date))
        .limit(limit);
      if (!rows.length) return { kind: "data", text: "No recent touchpoints." };
      const seen = new Set<string>();
      const related: RelatedEntityHint[] = [];
      for (const r of rows) {
        if (r.c && !seen.has(r.c.id)) {
          seen.add(r.c.id);
          related.push({ type: "company", id: r.c.id, name: r.c.name });
        }
      }
      return {
        kind: "data",
        text: rows.map((r) => `• ${r.tp.date} ${r.tp.type} @ ${r.c?.name ?? "?"}${r.tp.notes ? `: ${r.tp.notes.slice(0, 80)}` : ""}`).join("\n"),
        related,
      };
    },
  },
  {
    name: "team_touchpoint_tally",
    capability: "read.touchpoint",
    description:
      "Per-rep touchpoint count for a date window. Always call this for ANY question about team-wide activity totals, leaderboards, who's been most active, per-rep tallies, or 'how many touchpoints did each rep make' — never estimate from memory. Defaults to today. Manager-only at execute time; if the viewer is not a manager, the tool returns a polite refusal you should pass through verbatim.",
    parameters: {
      type: "object",
      properties: {
        date_start: { type: "string", description: "ISO date (YYYY-MM-DD). Default: today." },
        date_end: { type: "string", description: "ISO date (YYYY-MM-DD). Default: same as date_start." },
        include_zero: { type: "boolean", description: "Include reps with 0 touchpoints. Default true." },
      },
    },
    async execute(ctx, args) {
      // SECURITY: gate purely on the rep's role. Do NOT honour
      // ctx.scope === "everyone" as a manager equivalence — scope is a UI
      // filter, not an auth signal, and a non-manager could otherwise post
      // {scope:"everyone"} to the chat API to escalate. The channel layer
      // (server/chatbot.ts) also clamps scope, but defense in depth applies.
      const MANAGER_ROLES = ["admin", "director", "sales_director", "national_account_manager", "logistics_manager"];
      const isManager = MANAGER_ROLES.includes(ctx.rep.role);
      if (!isManager) {
        return { kind: "data", text: "This rollup is only available to managers. Ask about your own activity instead." };
      }
      const today = new Date().toISOString().slice(0, 10);
      const start = (args?.date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_start))) ? String(args.date_start) : today;
      const end = (args?.date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_end))) ? String(args.date_end) : start;
      const includeZero = args?.include_zero !== false;

      // Admin sees the entire org; every other manager sees their own
      // managerId subtree only (transitive direct reports, includes self).
      let visibleIds: Set<string> | null = null;
      if (ctx.rep.role !== "admin") {
        const subtree = await storage.getTeamMemberIds(ctx.rep.id, ctx.organizationId);
        visibleIds = new Set(subtree);
      }

      const repRows = await db.select({ id: users.id, name: users.name, username: users.username, role: users.role })
        .from(users)
        .where(eq(users.organizationId, ctx.organizationId));
      const salesRoles = new Set(["account_manager", "national_account_manager", "sales", "sales_director", "director", "admin", "logistics_manager"]);
      const reps = repRows.filter((r) => salesRoles.has(r.role) && (visibleIds === null || visibleIds.has(r.id)));
      if (!reps.length) return { kind: "data", text: "No reps in your team yet." };

      const counts = await db.select({
        loggedById: touchpoints.loggedById,
        n: sql<number>`count(*)::int`,
      })
        .from(touchpoints)
        .where(and(
          inArray(touchpoints.loggedById, reps.map(r => r.id)),
          gte(touchpoints.date, start),
          lte(touchpoints.date, end),
        ))
        .groupBy(touchpoints.loggedById);

      const countMap = new Map<string, number>(counts.map(c => [c.loggedById!, Number(c.n)]));
      const tallied = reps.map(r => ({
        name: r.name || r.username,
        role: r.role,
        count: countMap.get(r.id) ?? 0,
      }));
      const filtered = includeZero ? tallied : tallied.filter(t => t.count > 0);
      filtered.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      const total = filtered.reduce((s, t) => s + t.count, 0);
      const window = start === end ? start : `${start} → ${end}`;
      const lines = filtered.map(t => `• ${t.name} (${t.role}) — ${t.count}`);
      return {
        kind: "data",
        text: `Touchpoints by rep for ${window} (total ${total}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "reps_missing_touchpoints",
    capability: "read.touchpoint",
    description:
      "List sales reps who have logged ZERO touchpoints in a date window. Always call this for ANY question about who's behind on activity, who's dark/quiet, who hasn't logged today/this week, or who needs a nudge — never guess. Defaults to today. Manager-only at execute time; non-managers receive a polite refusal you should pass through verbatim.",
    parameters: {
      type: "object",
      properties: {
        date_start: { type: "string", description: "ISO date (YYYY-MM-DD). Default: today." },
        date_end: { type: "string", description: "ISO date (YYYY-MM-DD). Default: same as date_start." },
      },
    },
    async execute(ctx, args) {
      // SECURITY: gate on role only. See team_touchpoint_tally for rationale.
      const MANAGER_ROLES = ["admin", "director", "sales_director", "national_account_manager", "logistics_manager"];
      const isManager = MANAGER_ROLES.includes(ctx.rep.role);
      if (!isManager) {
        return { kind: "data", text: "This rollup is only available to managers." };
      }
      const today = new Date().toISOString().slice(0, 10);
      const start = (args?.date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_start))) ? String(args.date_start) : today;
      const end = (args?.date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_end))) ? String(args.date_end) : start;

      // Admin sees the entire org; every other manager sees their own
      // managerId subtree only.
      let visibleIds: Set<string> | null = null;
      if (ctx.rep.role !== "admin") {
        const subtree = await storage.getTeamMemberIds(ctx.rep.id, ctx.organizationId);
        visibleIds = new Set(subtree);
      }

      const repRows = await db.select({ id: users.id, name: users.name, username: users.username, role: users.role })
        .from(users)
        .where(eq(users.organizationId, ctx.organizationId));
      const salesRoles = new Set(["account_manager", "national_account_manager", "sales", "sales_director"]);
      const reps = repRows.filter((r) => salesRoles.has(r.role) && (visibleIds === null || visibleIds.has(r.id)));
      if (!reps.length) return { kind: "data", text: "No sales reps in your team yet." };

      const active = await db.select({ loggedById: touchpoints.loggedById })
        .from(touchpoints)
        .where(and(
          inArray(touchpoints.loggedById, reps.map(r => r.id)),
          gte(touchpoints.date, start),
          lte(touchpoints.date, end),
        ))
        .groupBy(touchpoints.loggedById);
      const activeIds = new Set(active.map(a => a.loggedById));

      const missing = reps.filter(r => !activeIds.has(r.id));
      const window = start === end ? start : `${start} → ${end}`;
      if (!missing.length) return { kind: "data", text: `Every sales rep logged at least one touchpoint for ${window}. ✅` };
      const lines = missing
        .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username))
        .map(r => `• ${r.name || r.username} (${r.role})`);
      return {
        kind: "data",
        text: `${missing.length} rep${missing.length === 1 ? "" : "s"} with no touchpoints for ${window}:\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "recall_memory",
    capability: "read.memory",
    description: "Search the rep's prior memories/decisions/preferences. Use proactively when the user references something they told you before.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    async execute(ctx, args) {
      const hits = await searchMemories(ctx.rep.id, String(args.query || ""), Math.min(8, Math.max(1, Number(args.limit || 5))));
      if (!hits.length) return { kind: "data", text: "No prior memories matched." };
      return { kind: "data", text: hits.map((h, i) => `${i + 1}. ${h.content}${h.similarity != null ? ` (sim ${(h.similarity * 100).toFixed(0)}%)` : ""}`).join("\n") };
    },
  },
  // ─── AVAILABLE FREIGHT (Task #366) ───────────────────────────────────────
  {
    name: "list_available_freight",
    capability: "read.opportunity",
    description: "List the rep's open Available Freight opportunities (today's loads owned by, delegated to, or awaiting approval). Use when the rep asks 'what freight do I have', 'what's in my procurement queue', or 'show me my open loads'.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["mine", "delegated", "awaiting_approval", "all"],
          description: "Scope filter: 'mine' = owned by rep, 'delegated' = delegated to rep, 'awaiting_approval' = pending approval, 'all' = any opp the rep can see (owner or delegate). Defaults to 'mine'.",
        },
        limit: { type: "number", description: "Max rows to return (default 10, max 25)" },
      },
    },
    async execute(ctx, args) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const lim = Math.min(25, Math.max(1, Number(args.limit || 10)));
      const filterRaw = String(args.filter ?? "mine");
      const filter: "mine" | "delegated" | "awaiting_approval" | "all" =
        filterRaw === "delegated" || filterRaw === "awaiting_approval" || filterRaw === "all" ? filterRaw : "mine";
      // Scope-aware (matches the read.touchpoint convention used by the
      // touchpoint-rollup tools above): when a manager is in "everyone"
      // scope, drop the per-rep filter on the "all" / "awaiting_approval"
      // branches so the manager sees the team-wide pipeline. "mine" and
      // "delegated" stay literally about the asking rep regardless of
      // scope — they're personal queries.
      const isManager = ["admin", "director", "national_account_manager", "sales_director", "logistics_manager"].includes(ctx.rep.role);
      const teamScope = isManager && ctx.scope === "everyone";
      const conds = [
        eq(freightOpportunities.orgId, ctx.organizationId),
        sql`(${freightOpportunities.pickupWindowEnd} IS NULL OR ${freightOpportunities.pickupWindowEnd} >= ${todayIso})`,
      ];
      if (filter === "mine") {
        conds.push(eq(freightOpportunities.ownerUserId, ctx.rep.id));
      } else if (filter === "delegated") {
        conds.push(eq(freightOpportunities.delegatedToUserId, ctx.rep.id));
      } else if (filter === "awaiting_approval") {
        if (!teamScope) {
          conds.push(sql`(${freightOpportunities.ownerUserId} = ${ctx.rep.id} OR ${freightOpportunities.delegatedToUserId} = ${ctx.rep.id})`);
        }
        conds.push(isNull(freightOpportunities.approvedAt));
      } else {
        // "all": individual rep sees own + delegated; manager-in-everyone
        // sees the whole org's open pipeline.
        if (!teamScope) {
          conds.push(sql`(${freightOpportunities.ownerUserId} = ${ctx.rep.id} OR ${freightOpportunities.delegatedToUserId} = ${ctx.rep.id})`);
        }
      }
      conds.push(inArray(freightOpportunities.status, [
        "pending_approval", "new", "ready_to_send", "sent",
        "awaiting_carrier_reply", "awaiting_customer_confirm", "partially_covered",
      ]));
      const rows = await db.select({
        id: freightOpportunities.id,
        companyId: freightOpportunities.companyId,
        origin: freightOpportunities.origin,
        originState: freightOpportunities.originState,
        destination: freightOpportunities.destination,
        destinationState: freightOpportunities.destinationState,
        equipmentType: freightOpportunities.equipmentType,
        pickupWindowStart: freightOpportunities.pickupWindowStart,
        loadCount: freightOpportunities.loadCount,
        status: freightOpportunities.status,
        urgencyScore: freightOpportunities.urgencyScore,
        approvedAt: freightOpportunities.approvedAt,
      }).from(freightOpportunities)
        .where(and(...conds))
        .orderBy(desc(freightOpportunities.urgencyScore), desc(freightOpportunities.generatedAt))
        .limit(lim);
      if (rows.length === 0) {
        const empty: Record<typeof filter, string> = {
          mine: "You have no open Available Freight opportunities right now.",
          delegated: "Nothing has been delegated to you right now.",
          awaiting_approval: "No freight opportunities are awaiting approval.",
          all: "No open Available Freight opportunities right now.",
        };
        return { kind: "data", text: empty[filter] };
      }
      const companyIds = Array.from(new Set(rows.map(r => r.companyId)));
      const cos = await storage.getCompaniesByIds(companyIds, ctx.organizationId);
      const nameMap = new Map(cos.map(c => [c.id, c.name]));
      const lines = rows.map((r, i) => {
        const o = `${r.origin}${r.originState ? `, ${r.originState}` : ""}`;
        const d = `${r.destination}${r.destinationState ? `, ${r.destinationState}` : ""}`;
        const approved = r.approvedAt ? "✓ approved" : "needs approval";
        return `${i + 1}. ${nameMap.get(r.companyId) ?? r.companyId} — ${o} → ${d} (${r.equipmentType ?? "?"}, ${r.loadCount}L, pickup ${r.pickupWindowStart}, status=${r.status}, ${approved}, urgency=${r.urgencyScore})`;
      });
      const related: RelatedEntityHint[] = rows.map((r) => ({
        type: "lane",
        id: r.id,
        name: `${r.origin}${r.originState ? `, ${r.originState}` : ""} → ${r.destination}${r.destinationState ? `, ${r.destinationState}` : ""}`,
      }));
      return { kind: "data", text: lines.join("\n"), related };
    },
  },
  {
    name: "freight_import_status",
    capability: "read.opportunity",
    description: "Admin/director only. Show the most recent Available Freight import runs (the daily OneDrive pull): when, file name, rows in/updated/expired, unmatched companies, errors. Use when an admin asks 'did the freight upload work', 'when was the last import', or 'why don't I see today's loads'.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Max imports to show (default 5, max 15)" } },
    },
    async execute(ctx, args) {
      // Role-gated even though the capability is read.opportunity — import
      // audit data is operational metadata that only admins/directors should
      // see (it can include file names, error stack snippets, etc.).
      // Strict admin/director only — operational metadata (file paths, error
      // snippets) shouldn't fan out to wider manager roles.
      const isAdminOrDirector = ["admin", "director"].includes(ctx.rep.role);
      if (!isAdminOrDirector) {
        return { kind: "data", text: "Only an admin or director can view freight import status." };
      }
      const lim = Math.min(15, Math.max(1, Number(args.limit || 5)));
      const imports = await listAvailableFreightImports(ctx.organizationId, lim);
      if (imports.length === 0) {
        return { kind: "data", text: "No Available Freight imports have been recorded yet for this org." };
      }
      const lines = imports.map((r, i) => {
        const status = r.error ? `ERROR: ${r.error.slice(0, 120)}` : `${r.inserted} new, ${r.updated} updated, ${r.expired} expired, ${r.unmatchedCompanies} unmatched`;
        return `${i + 1}. ${r.createdAt} (${r.triggeredBy}) — ${r.fileName ?? "?"} — ${status}`;
      });
      return { kind: "data", text: lines.join("\n") };
    },
  },
  // ─── NAVIGATE ────────────────────────────────────────────────────────────
  {
    name: "navigate_to_company",
    capability: "navigate.crm",
    description: "Navigate the user to a company's account page. Use for 'open', 'go to', 'pull up', 'show me' a specific company.",
    parameters: {
      type: "object",
      properties: { company_name: { type: "string" } },
      required: ["company_name"],
    },
    async execute(ctx, args) {
      const company = await findCompanyByName(ctx.organizationId, String(args.company_name || ""));
      if (!company) return { kind: "data", text: `No company found matching "${args.company_name}".` };
      return { kind: "navigate", path: `/companies/${company.id}`, preface: `Opening **${company.name}**…` };
    },
  },
  // ─── HITL WRITES (action cards) ──────────────────────────────────────────
  {
    name: "log_touchpoint",
    capability: "write.touchpoint",
    description: "Log a touchpoint (call/email/text/site_visit) with a contact. Always renders an action card for the rep to confirm.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        contact_name: { type: "string" },
        type: { type: "string", enum: ["call", "email", "text", "site_visit"] },
        note: { type: "string" },
      },
      required: ["type"],
    },
    async execute(_ctx, args) {
      return {
        kind: "action",
        tool: "log_touchpoint",
        args: {
          company_name: String(args.company_name || ""),
          contact_name: String(args.contact_name || ""),
          type: String(args.type || "call"),
          note: String(args.note || ""),
        },
        preface: "Here's the touchpoint to log — review and confirm:",
      };
    },
  },
  {
    name: "create_task",
    capability: "write.task",
    description: "Create a new task/reminder. Renders an action card.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, due_date: { type: "string" } },
      required: ["title"],
    },
    async execute(_ctx, args) {
      return {
        kind: "action",
        tool: "create_task",
        args: { title: String(args.title || ""), due_date: String(args.due_date || "") },
        preface: "Task ready to create — confirm or edit:",
      };
    },
  },
  {
    name: "complete_task",
    capability: "write.task.complete",
    description: "Mark an open task complete. Will look up the task by name and render a confirmation card.",
    parameters: {
      type: "object",
      properties: { task_name: { type: "string" } },
      required: ["task_name"],
    },
    async execute(ctx, args) {
      const name = String(args.task_name || "").toLowerCase().trim();
      if (!name) return { kind: "data", text: "Tell me which task to complete." };
      const open = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.assignedTo, ctx.rep.id), eq(tasks.status, "open")));
      const matched = open.find((t) => t.title.toLowerCase().includes(name)) ?? null;
      if (!matched) return { kind: "data", text: `No open task matching "${args.task_name}".` };
      return {
        kind: "action",
        tool: "complete_task",
        args: { task_id: matched.id, task_title: matched.title, due_date: matched.dueDate || "" },
        preface: "Task ready to mark complete:",
      };
    },
  },
  {
    name: "mark_meaningful",
    capability: "write.touchpoint.meaningful",
    description: "Flag the rep's most recent touchpoint at a company as meaningful.",
    parameters: {
      type: "object",
      properties: { company_name: { type: "string" }, contact_name: { type: "string" } },
      required: ["company_name"],
    },
    async execute(ctx, args) {
      const company = await findCompanyByName(ctx.organizationId, String(args.company_name || ""));
      if (!company) return { kind: "data", text: `No company matching "${args.company_name}".` };
      const recent = await db
        .select()
        .from(touchpoints)
        .where(and(eq(touchpoints.companyId, company.id), eq(touchpoints.loggedById, ctx.rep.id)))
        .orderBy(desc(touchpoints.date))
        .limit(1);
      const tp = recent[0];
      if (!tp) return { kind: "data", text: `No touchpoints found at ${company.name}.` };
      return {
        kind: "action",
        tool: "mark_meaningful",
        args: { touchpoint_id: tp.id, company_name: company.name, type: tp.type, date: tp.date, note: tp.notes || "" },
        preface: "Touchpoint ready to mark meaningful:",
      };
    },
  },
  {
    name: "approve_freight_opportunity",
    capability: "write.opportunity",
    description: "Approve a pending Available Freight opportunity by id (so its outreach can be sent). Manager-only — renders an action card the manager must confirm. Use after the manager has surfaced the specific opportunity (via list_available_freight or the UI) and wants to approve it.",
    parameters: {
      type: "object",
      properties: {
        opportunity_id: { type: "string", description: "freight_opportunities.id of the row to approve" },
      },
      required: ["opportunity_id"],
    },
    async execute(ctx, args) {
      const isManager = ["admin", "director", "national_account_manager", "sales_director", "logistics_manager"].includes(ctx.rep.role);
      if (!isManager) {
        return { kind: "data", text: "Only managers can approve Available Freight opportunities." };
      }
      const oppId = String(args.opportunity_id || "");
      if (!oppId) return { kind: "data", text: "opportunity_id is required." };
      const opp = await storage.getFreightOpportunity(ctx.organizationId, oppId);
      if (!opp) return { kind: "data", text: `No freight opportunity found with id ${oppId}.` };
      if (opp.approvedAt) return { kind: "data", text: "That opportunity is already approved." };
      const co = await storage.getCompany(opp.companyId);
      return {
        kind: "action",
        tool: "approve_freight_opportunity",
        args: {
          opportunity_id: opp.id,
          company_name: co?.name ?? opp.companyId,
          origin: opp.origin,
          destination: opp.destination,
          pickup: opp.pickupWindowStart,
        },
        preface: "Freight opportunity ready to approve — confirm:",
      };
    },
  },
  {
    name: "draft_email",
    capability: "write.email.draft",
    description: "Draft an email to a contact (subject + body). Renders an action card the rep confirms before sending. Use when the rep asks to 'email X', 'draft a note to X', 'follow up with X by email'.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        contact_name: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["subject", "body"],
    },
    async execute(_ctx, args) {
      return {
        kind: "action",
        tool: "draft_email",
        args: {
          company_name: String(args.company_name || ""),
          contact_name: String(args.contact_name || ""),
          subject: String(args.subject || ""),
          body: String(args.body || ""),
        },
        preface: "Email draft ready — review, edit, then send:",
      };
    },
  },
  {
    name: "open_filtered_queue",
    capability: "navigate.crm",
    description: "Open a CRM list pre-filtered by query params (e.g. tasks page filtered to overdue, customers filtered to 'no touch in 30d'). Use 'queue' for one of: tasks, customers, prospects, rfp_awards, touchpoint_history.",
    parameters: {
      type: "object",
      properties: {
        queue: { type: "string", enum: ["tasks", "customers", "prospects", "rfp_awards", "touchpoint_history"] },
        filter: { type: "string", description: "Free-form filter label (e.g. 'overdue', 'no_touch_30d', 'this_week')." },
      },
      required: ["queue"],
    },
    async execute(_ctx, args) {
      const queue = String(args.queue || "tasks");
      const filter = String(args.filter || "").trim();
      const ROUTES: Record<string, string> = {
        tasks: "/tasks",
        customers: "/customers",
        prospects: "/prospects",
        rfp_awards: "/rfp-awards",
        touchpoint_history: "/touchpoint-history",
      };
      const base = ROUTES[queue] ?? "/tasks";
      const path = filter ? `${base}?filter=${encodeURIComponent(filter)}` : base;
      return {
        kind: "action",
        tool: "open_filtered_queue",
        args: { queue, filter, path, label: `${queue.replace(/_/g, " ")}${filter ? ` (${filter.replace(/_/g, " ")})` : ""}` },
        preface: "Open this filtered view?",
      };
    },
  },
  {
    name: "remember_this",
    capability: "write.memory",
    description: "Save a fact, preference, or decision the user wants you to remember across future conversations.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact to remember (1–2 sentences, written in 3rd person about the user)." },
        related_company_name: { type: "string", description: "Optional company this memory relates to." },
      },
      required: ["content"],
    },
    async execute(ctx, args) {
      const content = String(args.content || "").trim();
      if (!content) return { kind: "data", text: "Nothing to remember." };
      const company = args.related_company_name
        ? await findCompanyByName(ctx.organizationId, String(args.related_company_name))
        : null;
      await saveMemory({
        organizationId: ctx.organizationId,
        userId: ctx.rep.id,
        content,
        kind: "preference",
        relatedCompanyId: company?.id ?? null,
        importance: 2,
      });
      return { kind: "data", text: `Saved. I'll remember: "${content}"` };
    },
  },

  // ─── CARRIER INTELLIGENCE (Task #371) ────────────────────────────────────
  {
    name: "recommend_carriers_for_order",
    capability: "read.carrier",
    description: "Carrier Intelligence: return the top ranked carrier candidates for a specific Available load (from carrier_recommendation). Use when the user asks 'who should I call for order X', 'best carriers for load #...', or 'who can cover this load'. Accepts the TMS order id OR the load_fact id.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "TMS order id (load_fact.order_id) or load_fact.id" },
        limit: { type: "number", description: "Max candidates to return (default 5, max 10)" },
      },
      required: ["order_id"],
    },
    async execute(ctx, args) {
      const orderId = String(args.order_id || "").trim();
      if (!orderId) return { kind: "data", text: "order_id is required." };
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
      const [load] = await db.select().from(loadFact)
        .where(and(
          eq(loadFact.orgId, ctx.organizationId),
          sql`(${loadFact.orderId} = ${orderId} OR ${loadFact.id} = ${orderId})`,
        )).limit(1);
      if (!load) return { kind: "data", text: `No Available load found for order ${orderId}.` };
      let recs = await db.select().from(carrierRecommendation)
        .where(and(
          eq(carrierRecommendation.orgId, ctx.organizationId),
          eq(carrierRecommendation.loadFactId, load.id),
        ))
        .orderBy(carrierRecommendation.rank)
        .limit(limit);
      if (recs.length === 0) {
        try {
          const fresh = await recommendCarriersForLoad(ctx.organizationId, load.id, { limit });
          const cands = fresh.candidates ?? [];
          if (cands.length === 0) {
            return { kind: "data", text: `No carrier recommendations available for order ${orderId}.` };
          }
          const lines = [
            `Top ${cands.length} carriers for order ${load.orderId} (${load.originCity ?? load.originState ?? "?"} → ${load.destinationCity ?? load.destinationState ?? "?"}, ${load.equipmentType ?? "ALL"}):`,
            ...cands.map((c, i) => {
              const rate = c.targetBuyRpm != null ? `$${Number(c.targetBuyRpm).toFixed(2)}/mi` : "no rate";
              const conf = c.pricingConfidence ?? "low";
              const urg = c.coverageUrgency ?? "green";
              return `${i + 1}. ${c.carrierName} — score ${c.totalScore ?? "?"} · target ${rate} (${conf} confidence) · urgency ${urg}${c.reason ? ` · ${c.reason}` : ""}`;
            }),
          ];
          return { kind: "data", text: lines.join("\n") };
        } catch (err) {
          return { kind: "data", text: `Could not generate recommendations for order ${orderId}: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      const lines = [
        `Top ${recs.length} carriers for order ${load.orderId} (${load.originCity ?? load.originState ?? "?"} → ${load.destinationCity ?? load.destinationState ?? "?"}, ${load.equipmentType ?? "ALL"}):`,
        ...recs.map((r, i) => {
          const rate = r.targetBuyRpm != null ? `$${Number(r.targetBuyRpm).toFixed(2)}/mi` : "no rate";
          return `${i + 1}. ${r.carrierName} — score ${r.totalScore} (fit ${r.fitScore} · perf ${r.performanceScore}) · target ${rate} (${r.pricingConfidence}) · urgency ${r.coverageUrgency}${r.reason ? ` · ${r.reason}` : ""}`;
        }),
      ];
      return { kind: "data", text: lines.join("\n") };
    },
  },
  {
    name: "suggest_buy_rate_for_lane",
    capability: "read.lane",
    description: "Carrier Intelligence: return the blended target buy rate ($/mi) for a lane, combining Sonar TRAC market and the org's realized history. Use when the user asks 'what should I pay on this lane', 'suggested rate for X to Y', or wants a buy-rate target before quoting.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Origin city or city,ST (e.g. 'Atlanta, GA')" },
        destination: { type: "string", description: "Destination city or city,ST" },
        origin_state: { type: "string", description: "2-letter state code for origin (improves history match)" },
        destination_state: { type: "string", description: "2-letter state code for destination" },
        equipment_type: { type: "string", description: "Trailer type (e.g. VAN, REEFER, FLATBED). Default VAN." },
        customer_name: { type: "string", description: "Customer name for (lane,customer) specificity" },
      },
      required: ["origin", "destination"],
    },
    async execute(ctx, args) {
      const origin = String(args.origin || "").trim();
      const destination = String(args.destination || "").trim();
      if (!origin || !destination) return { kind: "data", text: "origin and destination are required." };
      const result = await getBlendedRate({
        orgId: ctx.organizationId,
        origin,
        destination,
        originState: args.origin_state ? String(args.origin_state).toUpperCase().slice(0, 2) : null,
        destinationState: args.destination_state ? String(args.destination_state).toUpperCase().slice(0, 2) : null,
        equipmentType: args.equipment_type ? String(args.equipment_type).toUpperCase() : null,
        customerName: args.customer_name ? String(args.customer_name) : null,
      });
      if (result.targetBuyRpm == null) {
        return { kind: "data", text: `No buy rate available for ${origin} → ${destination}: ${result.reason}` };
      }
      const lines = [
        `Suggested buy rate for ${origin} → ${destination}${args.equipment_type ? ` (${String(args.equipment_type).toUpperCase()})` : ""}: $${result.targetBuyRpm.toFixed(2)}/mi (${result.confidence} confidence).`,
      ];
      if (result.suggestedSellRpm != null) {
        lines.push(`Suggested sell ask: $${result.suggestedSellRpm.toFixed(2)}/mi.`);
      }
      if (result.expectedMarginPct) {
        lines.push(`Expected margin band: ${result.expectedMarginPct.low.toFixed(1)}% – ${result.expectedMarginPct.high.toFixed(1)}%.`);
      }
      const sonarRate = result.legs.sonar?.ratePerMile;
      const histRate = result.legs.history?.avgCostPerMile;
      lines.push(
        `Legs: Sonar ${sonarRate != null ? `$${Number(sonarRate).toFixed(2)}/mi` : "n/a"} (${(result.weights.sonar * 100).toFixed(0)}%) · History ${histRate != null ? `$${Number(histRate).toFixed(2)}/mi` : "n/a"} (${(result.weights.history * 100).toFixed(0)}%, ${result.legs.history?.loads ?? 0} loads, ${result.historyFallbackTier}).`,
      );
      if (result.sonarWeightAutoBumped) lines.push("⚠ Sonar weight was auto-bumped because history is sparse.");
      if (result.refusedBelowThreshold) lines.push("⚠ Refused: both legs below the minimum confidence threshold.");
      return { kind: "data", text: lines.join("\n") };
    },
  },
  {
    name: "top_carriers_by_realized_margin",
    capability: "read.carrier",
    description: "Carrier Intelligence: list the org's top carriers ranked by realized margin from carrier_scorecard_fact, scoped to the scorecard's rolling window (typically 180 days — NOT current month). Use when the user asks 'who are our best carriers', 'top carriers by margin', or 'who's making us money over the last few months'. The output line states the actual window in days. If the user asks specifically about 'this month' or a custom date range, do NOT use this tool — fall back to a financial query. Optional equipment filter.",
    parameters: {
      type: "object",
      properties: {
        equipment_type: { type: "string", description: "Trailer type filter (default ALL = cross-equipment rollup)" },
        limit: { type: "number", description: "Max carriers to return (default 10, max 25)" },
        min_loads: { type: "number", description: "Minimum realized loads in the window (default 5)" },
      },
    },
    async execute(ctx, args) {
      const equipment = args.equipment_type ? String(args.equipment_type).toUpperCase() : "ALL";
      const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
      const minLoads = Math.max(0, Number(args.min_loads ?? 5));
      const rows = await db.select().from(carrierScorecardFact)
        .where(and(
          eq(carrierScorecardFact.orgId, ctx.organizationId),
          eq(carrierScorecardFact.equipmentType, equipment),
          sql`${carrierScorecardFact.loads} >= ${minLoads}`,
          sql`${carrierScorecardFact.doNotUse} = false`,
        ))
        .orderBy(sql`${carrierScorecardFact.margin} DESC`)
        .limit(limit);
      if (rows.length === 0) {
        return { kind: "data", text: `No carriers in scorecard for equipment=${equipment} with ≥${minLoads} realized loads.` };
      }
      const lines = [
        `Top ${rows.length} carriers by realized margin (equipment=${equipment}, ≥${minLoads} loads, ${rows[0].windowDays}d window):`,
        ...rows.map((r, i) => {
          const margin = Number(r.margin || 0);
          const marginPct = Number(r.marginPct || 0) * 100;
          return `${i + 1}. ${r.carrierName} — $${margin.toLocaleString(undefined, { maximumFractionDigits: 0 })} margin (${marginPct.toFixed(1)}%) · ${r.loads} loads · tier ${r.tier} · score ${r.performanceScore}${r.daysSinceLastLoad != null ? ` · last load ${r.daysSinceLastLoad}d ago` : ""}`;
        }),
      ];
      return { kind: "data", text: lines.join("\n") };
    },
  },

  // ─── Phase 2 — Data & Tools Expansion (Task #422) ────────────────────────
  {
    name: "query_pipeline",
    capability: "read.pipeline",
    description: "Launchpad pipeline query: prospects + linked CRM opportunities scoped to the rep's org. Use for 'what's in my pipeline', 'open opps for X', 'qualifying deals', 'pipeline this month', 'prospects assigned to Sara'. Manager-in-everyone-scope sees the org-wide pipeline; otherwise the rep sees their own owned prospects.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Filter to prospects/opportunities matching this name (partial match)." },
        stage: { type: "string", description: "Filter to a single Launchpad stage (e.g. 'qualification', 'proposal')." },
        owner: { type: "string", enum: ["mine", "team"], description: "'mine' = rep's own prospects; 'team' = the rep's org. Default 'mine' (or 'team' for managers in everyone scope)." },
        limit: { type: "number", description: "Max prospects to list (default 10, max 25)." },
      },
    },
    async execute(ctx, args) {
      const lim = Math.min(25, Math.max(1, Number(args.limit || 10)));
      const isManager = ["admin", "director", "national_account_manager", "sales_director"].includes(ctx.rep.role);
      const teamScope = (args.owner ? args.owner === "team" : isManager && ctx.scope === "everyone");
      const conds = [eq(prospects.organizationId, ctx.organizationId)];
      if (!teamScope) conds.push(eq(prospects.ownerId, ctx.rep.id));
      if (args.stage) conds.push(eq(prospects.stage, String(args.stage)));
      if (args.company_name) conds.push(ilike(prospects.name, `%${String(args.company_name)}%`));
      const rows = await db.select().from(prospects)
        .where(and(...conds))
        .orderBy(desc(prospects.updatedAt))
        .limit(lim);
      if (rows.length === 0) {
        return { kind: "data", text: teamScope
          ? "No prospects match those filters in this org's pipeline."
          : "No prospects in your pipeline match those filters." };
      }
      const ids = rows.map(r => r.id);
      const opps = ids.length
        ? await db.select().from(crmOpportunities)
            .where(and(eq(crmOpportunities.organizationId, ctx.organizationId), inArray(crmOpportunities.prospectId, ids)))
        : [];
      const oppsByProspect = new Map<number, typeof opps>();
      for (const o of opps) {
        if (o.prospectId == null) continue;
        const arr = oppsByProspect.get(o.prospectId) ?? [];
        arr.push(o);
        oppsByProspect.set(o.prospectId, arr);
      }
      const ownerIds = Array.from(new Set(rows.map(r => r.ownerId)));
      const ownerRows = ownerIds.length
        ? await db.select({ id: users.id, name: users.name, username: users.username }).from(users).where(inArray(users.id, ownerIds))
        : [];
      const ownerMap = new Map(ownerRows.map(u => [u.id, u.name || u.username]));
      const lines = rows.map((p, i) => {
        const list = oppsByProspect.get(p.id) ?? [];
        const oppLine = list.length
          ? `\n   Opps: ${list.slice(0, 4).map(o => `${o.name} [${o.stage}${o.amount ? `, $${Number(o.amount).toLocaleString()}` : ""}${o.probability != null ? `, ${o.probability}%` : ""}${o.outcome ? `, ${o.outcome}` : ""}]`).join("; ")}${list.length > 4 ? ` (+${list.length - 4} more)` : ""}`
          : "";
        const owner = ownerMap.get(p.ownerId) ?? p.ownerId;
        const next = p.followUpDate ? ` · follow-up ${p.followUpDate}` : "";
        return `${i + 1}. ${p.name} — stage ${p.stage} · status ${p.accountStatus ?? "?"} · owner ${owner}${next}${oppLine}`;
      });
      return { kind: "data", text: `Pipeline (${rows.length}${teamScope ? ", team" : ", yours"}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "one_on_one_history",
    capability: "read.coaching",
    description: "Coaching history: returns recent 1:1 sessions, topics, replies, morale scores, session summaries for the rep's direct reports. Manager-only — non-managers receive a polite refusal. Use for 'what did we cover with Sara last 1:1', 'open coaching topics on my team', 'morale trend', 'last session summary'.",
    parameters: {
      type: "object",
      properties: {
        rep_name: { type: "string", description: "Filter to a single subordinate by name (partial match)." },
        active_only: { type: "boolean", description: "Only show currently active sessions. Default true." },
        limit: { type: "number", description: "Max sessions to return (default 5, max 15)." },
      },
    },
    async execute(ctx, args) {
      const isManager = ["admin", "director", "sales_director", "national_account_manager", "logistics_manager"].includes(ctx.rep.role);
      if (!isManager) {
        return { kind: "data", text: "1:1 coaching history is only available to managers." };
      }
      const lim = Math.min(15, Math.max(1, Number(args.limit || 5)));
      const activeOnly = args.active_only !== false;
      const subs = await db.select({ id: users.id, name: users.name, username: users.username, role: users.role })
        .from(users)
        .where(and(eq(users.organizationId, ctx.organizationId), eq(users.managerId, ctx.rep.id)));
      let targetSubs = subs;
      if (args.rep_name) {
        const q = String(args.rep_name).toLowerCase();
        targetSubs = subs.filter(s => (s.name || s.username || "").toLowerCase().includes(q));
        if (!targetSubs.length) return { kind: "data", text: `No direct report on your team matches "${args.rep_name}".` };
      }
      if (!targetSubs.length) return { kind: "data", text: "You don't have any direct reports yet — no 1:1 sessions to show." };
      const subIds = targetSubs.map(s => s.id);
      const sessions = await storage.getSessionsForSubordinates(subIds, ctx.organizationId);
      const filtered = (activeOnly ? sessions.filter(s => s.session.status === "active") : sessions).slice(0, lim);
      if (!filtered.length) return { kind: "data", text: activeOnly ? "No active 1:1 sessions on your team." : "No 1:1 history found for your team." };
      const lines = filtered.map((s, i) => {
        const morale = s.session.moraleScore != null ? ` · morale ${s.session.moraleScore}/10` : "";
        const meeting = s.session.meetingDate ? ` · next ${s.session.meetingDate}` : "";
        const topicLines = s.topics.slice(0, 4).map(t => {
          const replies = t.replies.length ? ` (${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"})` : "";
          return `   - [${t.status}${t.tag ? `, ${t.tag}` : ""}] ${t.text.slice(0, 140)}${t.text.length > 140 ? "…" : ""}${replies}`;
        });
        const moreTopics = s.topics.length > 4 ? `\n   …(+${s.topics.length - 4} more topics)` : "";
        const summary = s.session.sessionSummary ? `\n   Summary: ${s.session.sessionSummary.slice(0, 280)}${s.session.sessionSummary.length > 280 ? "…" : ""}` : "";
        return `${i + 1}. ${s.amUser.name} ↔ ${s.namUser.name} — ${s.session.status}${morale}${meeting}${summary}${topicLines.length ? "\n" + topicLines.join("\n") : ""}${moreTopics}`;
      });
      return { kind: "data", text: `1:1 sessions (${filtered.length}):\n${lines.join("\n\n")}` };
    },
  },
  {
    name: "lane_carrier_lookup",
    capability: "read.lane",
    description: "Procurement Rolodex: list carriers contacted on a procurement task or award (lane_carriers rows). Use for 'who have we hit on the Atlanta–Dallas lane for the ACME award', 'carrier rolodex for that task', 'who replied/committed/declined on this procurement'. Provide either an award title (with company) or a task title.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Company that owns the award (used to disambiguate)." },
        award_title: { type: "string", description: "Award title (partial match)." },
        task_title: { type: "string", description: "Task title (partial match) if no award is known." },
        status: { type: "string", description: "Filter by carrier status: contacted | emailed | replied | committed | declined." },
        limit: { type: "number", description: "Max rows (default 15, max 50)." },
      },
    },
    async execute(ctx, args) {
      const lim = Math.min(50, Math.max(1, Number(args.limit || 15)));
      let carriers: Array<typeof laneCarriers.$inferSelect> = [];
      let header = "";
      if (args.award_title) {
        const company = args.company_name ? await findCompanyByName(ctx.organizationId, String(args.company_name)) : null;
        const candidates = company
          ? await db.select().from(awards).where(and(eq(awards.companyId, company.id), ilike(awards.title, `%${String(args.award_title)}%`))).limit(5)
          : await db.select().from(awards).where(ilike(awards.title, `%${String(args.award_title)}%`)).limit(5);
        const orgAwardIds: string[] = [];
        for (const a of candidates) {
          const co = await storage.getCompany(a.companyId);
          if (co?.organizationId === ctx.organizationId) orgAwardIds.push(a.id);
        }
        if (!orgAwardIds.length) return { kind: "data", text: `No award matched "${args.award_title}"${args.company_name ? ` at ${args.company_name}` : ""}.` };
        for (const aid of orgAwardIds) carriers = carriers.concat(await storage.getLaneCarriersByAward(aid));
        header = `Carriers on award "${args.award_title}"${args.company_name ? ` at ${args.company_name}` : ""}`;
      } else if (args.task_title) {
        const q = String(args.task_title).toLowerCase();
        const t = await db.select().from(tasks)
          .where(and(eq(tasks.orgId, ctx.organizationId), ilike(tasks.title, `%${q}%`)))
          .limit(5);
        if (!t.length) return { kind: "data", text: `No procurement task matched "${args.task_title}".` };
        for (const row of t) carriers = carriers.concat(await storage.getLaneCarriersByTask(row.id));
        header = `Carriers on task "${args.task_title}"`;
      } else {
        return { kind: "data", text: "Provide an award_title (and optionally company_name) or a task_title." };
      }
      if (args.status) carriers = carriers.filter(c => c.status === String(args.status));
      if (!carriers.length) return { kind: "data", text: `${header}: no carriers logged yet.` };
      const lines = carriers.slice(0, lim).map((c, i) => {
        const cap = c.capacityPerWeek != null ? ` · ${c.capacityPerWeek}/wk` : "";
        const rate = c.rate ? ` · ${c.rate}` : "";
        const contact = c.contactName ? ` · ${c.contactName}${c.email ? ` <${c.email}>` : ""}${c.phone ? ` ${c.phone}` : ""}` : "";
        return `${i + 1}. ${c.carrierName}${c.mcNumber ? ` (MC ${c.mcNumber})` : ""} — ${c.status}${cap}${rate}${contact}`;
      });
      const more = carriers.length > lim ? `\n…(+${carriers.length - lim} more)` : "";
      return { kind: "data", text: `${header} (${carriers.length}):\n${lines.join("\n")}${more}` };
    },
  },
  {
    name: "available_freight_search",
    capability: "read.opportunity",
    description: "Search Available Freight rows by origin/destination/equipment/customer (today and forward). Use for 'show me reefer loads to TX this week', 'open van loads for ACME', 'what loads do we have out of Atlanta'. The rep's broader 'what freight do I have' query stays on list_available_freight.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        origin: { type: "string", description: "Origin city or state (substring match on origin/originState)." },
        destination: { type: "string", description: "Destination city or state (substring match)." },
        equipment_type: { type: "string", description: "VAN | REEFER | FLATBED | etc." },
        limit: { type: "number", description: "Max rows (default 10, max 25)." },
      },
    },
    async execute(ctx, args) {
      const lim = Math.min(25, Math.max(1, Number(args.limit || 10)));
      const todayIso = new Date().toISOString().slice(0, 10);
      const conds = [
        eq(freightOpportunities.orgId, ctx.organizationId),
        sql`(${freightOpportunities.pickupWindowEnd} IS NULL OR ${freightOpportunities.pickupWindowEnd} >= ${todayIso})`,
      ];
      if (args.equipment_type) conds.push(eq(freightOpportunities.equipmentType, String(args.equipment_type).toUpperCase()));
      if (args.company_name) {
        const co = await findCompanyByName(ctx.organizationId, String(args.company_name));
        if (!co) return { kind: "data", text: `No company matched "${args.company_name}".` };
        conds.push(eq(freightOpportunities.companyId, co.id));
      }
      if (args.origin) {
        const q = `%${String(args.origin)}%`;
        conds.push(sql`(${freightOpportunities.origin} ILIKE ${q} OR ${freightOpportunities.originState} ILIKE ${q})`);
      }
      if (args.destination) {
        const q = `%${String(args.destination)}%`;
        conds.push(sql`(${freightOpportunities.destination} ILIKE ${q} OR ${freightOpportunities.destinationState} ILIKE ${q})`);
      }
      const rows = await db.select().from(freightOpportunities).where(and(...conds))
        .orderBy(desc(freightOpportunities.urgencyScore), desc(freightOpportunities.generatedAt))
        .limit(lim);
      if (!rows.length) return { kind: "data", text: "No Available Freight matched those filters." };
      const cos = await storage.getCompaniesByIds(Array.from(new Set(rows.map(r => r.companyId))), ctx.organizationId);
      const nameMap = new Map(cos.map(c => [c.id, c.name]));
      const lines = rows.map((r, i) => {
        const o = `${r.origin}${r.originState ? `, ${r.originState}` : ""}`;
        const d = `${r.destination}${r.destinationState ? `, ${r.destinationState}` : ""}`;
        return `${i + 1}. ${nameMap.get(r.companyId) ?? r.companyId} — ${o} → ${d} (${r.equipmentType ?? "?"}, ${r.loadCount}L, pickup ${r.pickupWindowStart}, status=${r.status}, urgency=${r.urgencyScore})`;
      });
      return { kind: "data", text: lines.join("\n") };
    },
  },
  {
    name: "email_intelligence_search",
    capability: "read.email",
    description: "Search recent customer/carrier email signals (intent classifications) by intent or by linked account/carrier/lane. Use for 'any replies on the ACME RFP thread', 'latest carrier interest signals on lane X', 'pricing requests this week'. Restricted to messages in the rep's org.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Restrict to signals linked to this account." },
        intent: { type: "string", description: "Filter by intent_type (e.g. 'pricing_request', 'commitment', 'decline')." },
        days: { type: "number", description: "Look back N days (default 14, max 60)." },
        limit: { type: "number", description: "Max signals (default 12, max 30)." },
      },
    },
    async execute(ctx, args) {
      const lim = Math.min(30, Math.max(1, Number(args.limit || 12)));
      const days = Math.min(60, Math.max(1, Number(args.days || 14)));
      const since = new Date(Date.now() - days * 86400000);
      const conds = [
        eq(emailMessages.orgId, ctx.organizationId),
        gte(emailSignals.createdAt, since),
      ];
      if (args.intent) conds.push(eq(emailSignals.intentType, String(args.intent)));
      let companyId: string | null = null;
      if (args.company_name) {
        const co = await findCompanyByName(ctx.organizationId, String(args.company_name));
        if (!co) return { kind: "data", text: `No company matched "${args.company_name}".` };
        companyId = co.id;
        conds.push(eq(emailSignals.linkedAccountId, co.id));
      }
      const rows = await db.select({
        id: emailSignals.id,
        intentType: emailSignals.intentType,
        intentSubtype: emailSignals.intentSubtype,
        actorType: emailSignals.actorType,
        confidence: emailSignals.confidence,
        createdAt: emailSignals.createdAt,
        subject: emailMessages.subject,
        fromEmail: emailMessages.fromEmail,
        direction: emailMessages.direction,
        linkedAccountId: emailSignals.linkedAccountId,
      }).from(emailSignals)
        .innerJoin(emailMessages, eq(emailMessages.id, emailSignals.messageId))
        .where(and(...conds))
        .orderBy(desc(emailSignals.createdAt))
        .limit(lim);
      if (!rows.length) return { kind: "data", text: `No email signals in the last ${days} days${companyId ? " for that account" : ""}${args.intent ? ` with intent ${args.intent}` : ""}.` };
      const lines = rows.map((r, i) => {
        const date = r.createdAt instanceof Date ? r.createdAt.toISOString().slice(0, 10) : String(r.createdAt).slice(0, 10);
        const sub = r.intentSubtype ? `/${r.intentSubtype}` : "";
        return `${i + 1}. [${date}] ${r.intentType}${sub} (${r.actorType}, conf ${r.confidence}) — ${r.direction} "${(r.subject ?? "(no subject)").slice(0, 80)}" from ${r.fromEmail ?? "?"}`;
      });
      return { kind: "data", text: lines.join("\n") };
    },
  },
  {
    name: "next_best_actions",
    capability: "read.nba",
    description: "Return Next Best Action cards for the rep (or for the org when a manager is in everyone scope). Use for 'what's my next best action', 'show urgent NBAs', 'NBA cards for Globex', 'top 5 cards by urgency'.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Filter to cards linked to a specific company." },
        rule_type: { type: "string", description: "Filter to a single rule_type." },
        limit: { type: "number", description: "Max cards (default 5, max 20)." },
      },
    },
    async execute(ctx, args) {
      const lim = Math.min(20, Math.max(1, Number(args.limit || 5)));
      const isManager = ["admin", "director", "national_account_manager", "sales_director", "logistics_manager"].includes(ctx.rep.role);
      const teamScope = isManager && ctx.scope === "everyone";
      let cards: Array<typeof nbaCards.$inferSelect> = teamScope
        ? await storage.getVisibleNbaCardsForOrg(ctx.organizationId, lim * 4)
        : await storage.getVisibleNbaCards(ctx.rep.id, lim * 4);
      // Task #773 — when answering for a single rep (not the whole org),
      // intersect with their visible-company set so a Webex missed-call card
      // attributed to their extension can't surface a foreign account here.
      if (!teamScope) {
        const visibleIds = await getVisibleCompanyIds(ctx.rep);
        if (visibleIds !== null) {
          const visibleSet = new Set(visibleIds);
          cards = cards.filter(c => !c.companyId || visibleSet.has(c.companyId));
        }
      }
      if (args.rule_type) cards = cards.filter(c => c.ruleType === String(args.rule_type));
      if (args.company_name) {
        const q = String(args.company_name).toLowerCase();
        cards = cards.filter(c => (c.companyName || "").toLowerCase().includes(q));
      }
      cards = cards.slice(0, lim);
      if (!cards.length) return { kind: "data", text: "No NBA cards match those filters." };
      const lines = cards.map((c, i) => {
        const stake = c.atStakeAmount ? ` · $${Number(c.atStakeAmount).toLocaleString()} at stake` : "";
        return `${i + 1}. [${c.urgencyScore} ${c.ruleType}] ${c.companyName ?? "—"} → ${c.suggestedAction}\n   Why: ${c.whyThisNow}${stake}`;
      });
      return { kind: "data", text: `${teamScope ? "Org" : "Your"} top NBAs (${cards.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "scorecard_lookup",
    capability: "read.scorecard",
    description: "Return the most recent saved report card snapshots for a rep. Reps can ask about themselves; managers can ask about anyone on their team or anyone in the org (when in everyone scope). Use for 'show my scorecard', 'last month's report card', 'how is Sara tracking'.",
    parameters: {
      type: "object",
      properties: {
        rep_name: { type: "string", description: "Look up someone other than the asking rep (manager-only)." },
        limit: { type: "number", description: "Max snapshots (default 3, max 10)." },
      },
    },
    async execute(ctx, args) {
      const lim = Math.min(10, Math.max(1, Number(args.limit || 3)));
      const isManager = ["admin", "director", "sales_director", "national_account_manager"].includes(ctx.rep.role);
      let targetUserId = ctx.rep.id;
      let targetName = ctx.rep.name || ctx.rep.username || "you";
      if (args.rep_name) {
        if (!isManager) return { kind: "data", text: "Only managers can pull another rep's scorecard. I can show you yours instead." };
        const q = String(args.rep_name).toLowerCase();
        const orgUsers = await db.select({ id: users.id, name: users.name, username: users.username })
          .from(users).where(eq(users.organizationId, ctx.organizationId));
        const match = orgUsers.find(u => (u.name || u.username || "").toLowerCase().includes(q));
        if (!match) return { kind: "data", text: `No teammate matched "${args.rep_name}".` };
        targetUserId = match.id;
        targetName = match.name || match.username || match.id;
      }
      const snaps = await storage.getReportCardSnapshots(targetUserId);
      if (!snaps.length) return { kind: "data", text: `No saved report card snapshots for ${targetName} yet.` };
      const lines = snaps.slice(0, lim).map((s, i) => {
        const payload = s.payload as Record<string, unknown> | null;
        const summary = payload && typeof payload === "object"
          ? Object.entries(payload).slice(0, 6).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v)}`).join(" · ")
          : "(empty payload)";
        return `${i + 1}. [${s.periodLabel}, ${s.periodType}, saved ${s.snapshotDate}] ${summary}`;
      });
      return { kind: "data", text: `Scorecards for ${targetName}:\n${lines.join("\n")}` };
    },
  },
  {
    name: "recurring_freight_pattern",
    capability: "read.lane",
    description: "Return the org's recurring freight lanes (companies + origin/destination/equipment + cadence + ownership + lane score). Use for 'recurring lanes for ACME', 'top recurring lanes by score', 'where do we have recurring freight without preferred carrier coverage'.",
    parameters: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Filter to a single company." },
        without_coverage: { type: "boolean", description: "Only show lanes without a preferred-carrier program. Default false." },
        eligible_only: { type: "boolean", description: "Only show lanes flagged as eligible. Default false." },
        limit: { type: "number", description: "Max lanes (default 10, max 30)." },
      },
    },
    async execute(ctx, args) {
      const lim = Math.min(30, Math.max(1, Number(args.limit || 10)));
      let lanes = await storage.getRecurringLanes(ctx.organizationId);
      if (args.company_name) {
        const q = String(args.company_name).toLowerCase();
        lanes = lanes.filter(l => (l.companyName || "").toLowerCase().includes(q));
      }
      if (args.without_coverage) lanes = lanes.filter(l => !l.hasPreferredCarrierProgram);
      if (args.eligible_only) lanes = lanes.filter(l => l.isEligible);
      lanes = lanes.slice(0, lim);
      if (!lanes.length) return { kind: "data", text: "No recurring lanes match those filters." };
      const lines = lanes.map((l, i) => {
        const equip = l.equipmentType ? ` (${l.equipmentType})` : "";
        const cadence = l.avgLoadsPerWeek ? `${Number(l.avgLoadsPerWeek).toFixed(1)}/wk` : "?";
        const wk = l.weeksActive ? `, ${l.weeksActive}wk active` : "";
        const cov = l.hasPreferredCarrierProgram ? "covered" : "no preferred carrier";
        return `${i + 1}. ${l.companyName ?? "?"} — ${l.origin}${l.originState ? `,${l.originState}` : ""} → ${l.destination}${l.destinationState ? `,${l.destinationState}` : ""}${equip} · ${cadence}${wk} · score ${l.laneScore ?? "?"} · ${cov}${l.isEligible ? " · eligible" : ""}`;
      });
      return { kind: "data", text: `Recurring lanes (${lanes.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "freight_research",
    capability: "read.market",
    description:
      "Look up freight-domain facts the CRM can't answer on its own — DOT/MC carrier records (FMCSA SAFER), national diesel prices (EIA), or general freight-industry context. Returns a short answer plus citations. Use this BEFORE saying 'I don't know' on freight questions.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The freight question to research, in natural language." },
        intent: {
          type: "string",
          enum: ["carrier_lookup", "fuel", "general"],
          description: "Optional intent hint. Leave blank to auto-classify.",
        },
      },
      required: ["question"],
    },
    execute: async (_ctx, args) => {
      const question = String(args.question || "").trim();
      if (!question) return { kind: "data", text: "freight_research called without a question." };
      const intentHint = args.intent && ["carrier_lookup", "fuel", "general"].includes(String(args.intent))
        ? (String(args.intent) as "carrier_lookup" | "fuel" | "general")
        : undefined;
      const r = await freightResearch(question, intentHint);
      const cites = r.citations.length
        ? `\n\nCitations:\n${r.citations.map((c, i) => `${i + 1}. ${c.label}${c.href ? ` — ${c.href}` : ""}`).join("\n")}`
        : "";
      const tag = r.unknown ? " (no confident answer)" : "";
      return { kind: "data", text: `[${r.intent}${tag}] ${r.answer}${cites}` };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function openAiToolSpecs() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
