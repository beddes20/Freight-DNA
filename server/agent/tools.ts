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
import {
  companies, contacts, tasks, touchpoints, users, freightOpportunities, type User,
} from "@shared/schema";
import { listAvailableFreightImports } from "../availableFreightImporter";
import {
  getNationalMarketSummary, getMarketOtris, getLaneVotrisBatch,
  getLaneMarketRate, buildVotriQualifier,
} from "../sonarClient";
import { tracLaneDirectionSignal } from "../tracAlertEngine";
import {
  runCarrierLaneSearch, getCompanyDetails, getCachedRatePositioningContext,
} from "../chatbot";
import { saveMemory, searchMemories, listFacts } from "./memory";
import type { Capability } from "./permissions";

export interface AgentContext {
  rep: User;
  organizationId: string;
  channel: "in_app" | "email" | "teams" | "sms" | "voice";
  conversationRef: string | null;
  scope: "my_team" | "everyone";
}

export type ToolOutput =
  | { kind: "data"; text: string; relatedCompanyId?: string | null }
  | { kind: "action"; tool: string; args: Record<string, unknown>; preface?: string }
  | { kind: "navigate"; path: string; preface?: string };

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
      try {
        const pulse = await getNationalMarketSummary();
        const has = pulse.otri !== null;
        const sig = !has ? "⚪ No Data" : pulse.otri! > 20 ? "🔴 Hot" : pulse.otri! > 8 ? "🟡 Warm" : "🟢 Cool";
        const lines = [`FreightWaves Sonar — National Pulse${pulse.isStale ? " ⚠ Stale" : ""}`];
        if (has) lines.push(`National OTRI: ${pulse.otri!.toFixed(2)}% (${(pulse.otriWoWDelta ?? 0) >= 0 ? "+" : ""}${(pulse.otriWoWDelta ?? 0).toFixed(1)}pp WoW) — ${sig}`);
        else lines.push(`National OTRI: unavailable`);
        lines.push(pulse.ntiPerMove !== null ? `NTI Spot: $${pulse.ntiPerMove.toFixed(2)}/move` : "NTI Spot: unavailable");
        lines.push(pulse.ntiPerMile !== null ? `Contract (VCRPM1): $${pulse.ntiPerMile.toFixed(2)}/mile` : "Contract: unavailable");
        return { kind: "data", text: lines.join("\n") };
      } catch {
        return { kind: "data", text: "Sonar national data temporarily unavailable." };
      }
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
      try {
        const otris = await getMarketOtris([market]);
        const m = otris[0];
        if (!m) return { kind: "data", text: `No Sonar data for "${market}".` };
        const sig = m.signal === "hot" ? "🔴 Hot" : m.signal === "warm" ? "🟡 Warm" : m.signal === "cool" ? "🟢 Cool" : "⚪";
        const lines = [`Sonar market — ${m.market}:`];
        if (m.otri !== null) lines.push(`OTRI: ${m.otri.toFixed(1)}% ${sig}`);
        if (m.votri !== null && m.votri !== undefined) lines.push(`VOTRI: ${m.votri.toFixed(1)}%`);
        return { kind: "data", text: lines.join("\n") };
      } catch {
        return { kind: "data", text: "Sonar market data temporarily unavailable." };
      }
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
        return { kind: "data", text: lines.join("\n") };
      } catch {
        return { kind: "data", text: "Lane signal data temporarily unavailable." };
      }
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
      return {
        kind: "data",
        text: rows.map((r) => `• ${r.tp.date} ${r.tp.type} @ ${r.c?.name ?? "?"}${r.tp.notes ? `: ${r.tp.notes.slice(0, 80)}` : ""}`).join("\n"),
      };
    },
  },
  {
    name: "team_touchpoint_tally",
    capability: "read.touchpoint",
    description:
      "Manager-only: per-rep touchpoint count for a date window. Use for questions like 'how many touchpoints has each rep made today/this week', 'who's been most active', 'team activity rollup'. Defaults to today. Only available to admin/director/sales_director or when the viewer is in 'everyone' scope.",
    parameters: {
      type: "object",
      properties: {
        date_start: { type: "string", description: "ISO date (YYYY-MM-DD). Default: today." },
        date_end: { type: "string", description: "ISO date (YYYY-MM-DD). Default: same as date_start." },
        include_zero: { type: "boolean", description: "Include reps with 0 touchpoints. Default true." },
      },
    },
    async execute(ctx, args) {
      const isManager = ["admin", "director", "sales_director"].includes(ctx.rep.role) || ctx.scope === "everyone";
      if (!isManager) {
        return { kind: "data", text: "This rollup is only available to managers (admin / director / sales director). Ask about your own activity instead." };
      }
      const today = new Date().toISOString().slice(0, 10);
      const start = (args?.date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_start))) ? String(args.date_start) : today;
      const end = (args?.date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_end))) ? String(args.date_end) : start;
      const includeZero = args?.include_zero !== false;

      const repRows = await db.select({ id: users.id, name: users.name, username: users.username, role: users.role })
        .from(users)
        .where(eq(users.organizationId, ctx.organizationId));
      const salesRoles = new Set(["account_manager", "national_account_manager", "sales", "sales_director", "director", "admin"]);
      const reps = repRows.filter((r) => salesRoles.has(r.role));
      if (!reps.length) return { kind: "data", text: "No reps found in this organization." };

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
      "Manager-only: list sales reps who have logged ZERO touchpoints in a date window. Use for 'who hasn't logged a touchpoint today', 'which reps are dark this week', 'who needs a nudge'. Defaults to today.",
    parameters: {
      type: "object",
      properties: {
        date_start: { type: "string", description: "ISO date (YYYY-MM-DD). Default: today." },
        date_end: { type: "string", description: "ISO date (YYYY-MM-DD). Default: same as date_start." },
      },
    },
    async execute(ctx, args) {
      const isManager = ["admin", "director", "sales_director"].includes(ctx.rep.role) || ctx.scope === "everyone";
      if (!isManager) {
        return { kind: "data", text: "This rollup is only available to managers (admin / director / sales director)." };
      }
      const today = new Date().toISOString().slice(0, 10);
      const start = (args?.date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_start))) ? String(args.date_start) : today;
      const end = (args?.date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(args.date_end))) ? String(args.date_end) : start;

      const repRows = await db.select({ id: users.id, name: users.name, username: users.username, role: users.role })
        .from(users)
        .where(eq(users.organizationId, ctx.organizationId));
      const salesRoles = new Set(["account_manager", "national_account_manager", "sales", "sales_director"]);
      const reps = repRows.filter((r) => salesRoles.has(r.role));
      if (!reps.length) return { kind: "data", text: "No sales reps found in this organization." };

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
        "new", "ready_to_send", "sent",
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
      return { kind: "data", text: lines.join("\n") };
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
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function openAiToolSpecs() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
