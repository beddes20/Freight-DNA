/**
 * Smart router for the DNA Copilot.
 *
 * Sits in front of the agentic LLM loop and resolves cheap intents
 * deterministically — so "open ACH Foods", "go to my tasks", "what's on my
 * plate" don't pay for a model round-trip. Anything we can't confidently
 * resolve falls through to runAgentTurn().
 *
 * Returns:
 *   { handled: false }                          → caller runs the LLM loop
 *   { handled: true, ... }                      → router fully handled the turn;
 *                                                 caller should not invoke the LLM
 */
import { eq } from "drizzle-orm";
import { db, storage } from "../storage";
import { companies, tasks, carriers, recurringLanes, freightOpportunities, prospects, rfps, type User } from "@shared/schema";
import { canInvoke } from "./permissions";
import { rememberEntity, resolveReference, type EntityType } from "./sessionMemo";
import type { AgentEvent, Emit } from "./core";

export interface PageContext {
  route?: string | null;
  entityType?: EntityType | null;
  entityId?: string | null;
  entityName?: string | null;
}

export interface RouterArgs {
  rep: User;
  organizationId: string;
  conversationRef: string | null;
  message: string;
  pageContext?: PageContext | null;
  emit: Emit;
}

export interface RouterResult {
  handled: boolean;
  /** Text to persist as the assistant message (router-handled turns). */
  assistantText?: string;
  surfacedAction?: boolean;
  /** Entities the router deterministically referenced — also written to memo. */
}

const NAVIGATE_PATTERNS: Array<{ re: RegExp; route: string; label: string }> = [
  { re: /^(open|go to|show me|take me to|navigate to)\s+(my\s+)?tasks?\b/i, route: "/tasks", label: "Tasks" },
  { re: /^(open|go to|show me|take me to)\s+(my\s+)?dashboard\b/i, route: "/", label: "Dashboard" },
  { re: /^(open|go to|show me|take me to)\s+customers?\b/i, route: "/customers", label: "Customers" },
  { re: /^(open|go to|show me|take me to)\s+prospects?\b/i, route: "/prospects", label: "Prospects" },
  { re: /^(open|go to|show me|take me to)\s+(rfp\s+awards?|awards?)\b/i, route: "/rfp-awards", label: "RFP Awards" },
  { re: /^(open|go to|show me|take me to)\s+(rfp\s+calendar|calendar)\b/i, route: "/rfp-calendar", label: "RFP Calendar" },
  { re: /^(open|go to|show me|take me to)\s+(carrier\s+hub|carriers)\b/i, route: "/carrier-hub", label: "Carrier Hub" },
  { re: /^(open|go to|show me|take me to)\s+(notifications?|inbox)\b/i, route: "/notifications", label: "Notifications" },
  { re: /^(open|go to|show me|take me to)\s+(coordinators?(?:'s)?\s+corner)\b/i, route: "/coordinators-corner", label: "Coordinators Corner" },
  { re: /^(open|go to|show me|take me to)\s+(value\s*iq|valueiq|intel(?:ligence)?)\b/i, route: "/valueiq", label: "ValueIQ" },
];

const OPEN_RECORD_PATTERNS = [
  /^(open|go to|show me|take me to|pull up|navigate to)\s+(?:the\s+)?(.+?)(?:\s+(?:account|page|company|carrier|profile))?$/i,
];

/** ROLE_PROMPTS — tiny slice of role-aware empty-state seeds.  */
export const ROLE_EMPTY_PROMPTS: Record<string, string[]> = {
  admin: [
    "Which reps are behind on their goals this week?",
    "Show me the team's touchpoint leaderboard",
    "What's the org-wide rate positioning vs market?",
    "Who hasn't logged a touchpoint today?",
  ],
  director: [
    "Which reps are behind on their goals this week?",
    "Show me the team's touchpoint leaderboard",
    "Who hasn't logged a touchpoint today?",
    "Which accounts haven't been touched in 30+ days across my team?",
  ],
  sales_director: [
    "Which reps on my team are behind?",
    "Touchpoint tally for my team this week",
    "Which accounts need attention across my team?",
    "RFPs due this week",
  ],
  national_account_manager: [
    "What's on my plate today?",
    "Which of my accounts haven't been touched in 30+ days?",
    "RFPs due this week",
    "Recent touchpoints I logged",
  ],
  account_manager: [
    "What's on my plate today?",
    "Which contacts haven't been touched in 30+ days?",
    "Show me my open tasks",
    "What accounts should I prioritize today?",
  ],
  sales: [
    "What's on my plate today?",
    "Show my open tasks",
    "Recent touchpoints I logged",
    "What accounts should I prioritize?",
  ],
  logistics_manager: [
    "Show today's check-ins",
    "Lanes I'm working on",
    "Recent activity on my book",
    "Open tasks for me",
  ],
  logistics_coordinator: [
    "What's pending in Coordinators Corner?",
    "Show today's check-ins",
    "Lanes I'm working on",
  ],
};

/** Page-aware prompt packs.  Keyed by entityType. */
export const PAGE_PROMPTS: Record<string, string[]> = {
  company: [
    "Summarize this account",
    "Recommend next actions for this account",
    "Show recent activity on this account",
    "Who are the key contacts here?",
  ],
  carrier: [
    "Summarize this carrier",
    "What lanes do they run for us?",
    "What are we paying them this month?",
    "Recent loads with this carrier",
  ],
  lane: [
    "How tight is this lane right now?",
    "Who's running this corridor?",
    "What's the market rate vs. what we're paying?",
    "Recent awards on this lane",
  ],
  rfp: [
    "Summarize this RFP",
    "Which lanes look most competitive?",
    "Suggest a bid strategy",
    "Recent awards on similar lanes",
  ],
  task: [
    "What's on my plate today?",
    "Mark this task complete",
    "Show overdue tasks",
  ],
  prospect: [
    "Summarize this prospect",
    "Suggest an opening message",
    "Recent activity",
  ],
};

export function getEmptyStatePrompts(role: string, page: PageContext | null | undefined): string[] {
  if (page?.entityType && PAGE_PROMPTS[page.entityType]) return PAGE_PROMPTS[page.entityType];
  return ROLE_EMPTY_PROMPTS[role] || ROLE_EMPTY_PROMPTS.account_manager;
}

async function findCompanyByName(orgId: string, query: string) {
  if (!query || query.length < 2) return null;
  const all = await db.select().from(companies).where(eq(companies.organizationId, orgId));
  const q = query.toLowerCase().trim();
  return (
    all.find((c) => c.name.toLowerCase() === q) ||
    all.find((c) => c.name.toLowerCase().includes(q)) ||
    null
  );
}

function emit(emitFn: Emit, ev: AgentEvent) {
  try { emitFn(ev); } catch {}
}

/**
 * Try to resolve the user's message deterministically.
 * On success, emits content+navigation events and returns { handled: true }.
 * On any uncertainty, returns { handled: false } and the LLM loop runs.
 */
export async function tryRoute(args: RouterArgs): Promise<RouterResult> {
  const { rep, organizationId, conversationRef, message, pageContext, emit: emitFn } = args;
  const trimmed = message.trim();
  if (!trimmed) return { handled: false };
  const lower = trimmed.toLowerCase();

  // ─── 1. Reference resolution: "summarize it", "open the first one" ─────
  const referenced = resolveReference(conversationRef, trimmed);
  if (referenced) {
    // "open it / pull it up / show me that account" → navigate
    if (/^(open|pull up|go to|show me|take me to)\b/i.test(trimmed) && referenced.type === "company") {
      const decision = await canInvoke(rep, "navigate.crm");
      if (decision.allowed) {
        const text = `Opening **${referenced.name}**…`;
        emit(emitFn, { content: text });
        emit(emitFn, { navigate: `/companies/${referenced.id}` });
        rememberEntity(conversationRef, { type: "company", id: referenced.id, name: referenced.name });
        return { handled: true, assistantText: text };
      }
    }
    // Otherwise, let the LLM handle it but seed the memo with the resolved
    // entity by injecting a synthetic mention into the page context downstream.
    // (We don't return handled:true here — the LLM still needs to do work.)
  }

  // ─── 2. Direct navigation: "open my tasks" / "go to dashboard" ─────────
  for (const p of NAVIGATE_PATTERNS) {
    if (p.re.test(lower)) {
      const decision = await canInvoke(rep, "navigate.crm");
      if (!decision.allowed) return { handled: false };
      const text = `Opening **${p.label}**…`;
      emit(emitFn, { content: text });
      emit(emitFn, { navigate: p.route });
      return { handled: true, assistantText: text };
    }
  }

  // ─── 3. Open / show a specific company by name ─────────────────────────
  for (const re of OPEN_RECORD_PATTERNS) {
    const m = trimmed.match(re);
    if (!m) continue;
    const candidate = m[2]?.trim();
    if (!candidate || candidate.length < 2) continue;
    // Skip generic tokens — those go to the navigate patterns above.
    if (/^(my\s+)?(tasks?|dashboard|customers?|prospects?|notifications?|carriers?)$/i.test(candidate)) continue;
    const company = await findCompanyByName(organizationId, candidate);
    if (!company) continue;
    const decision = await canInvoke(rep, "navigate.crm");
    if (!decision.allowed) return { handled: false };
    const text = `Opening **${company.name}**…`;
    emit(emitFn, { content: text });
    emit(emitFn, { navigate: `/companies/${company.id}` });
    rememberEntity(conversationRef, { type: "company", id: company.id, name: company.name });
    return { handled: true, assistantText: text };
  }

  // ─── 4. Quick deterministic counts: "how many open tasks do I have?" ──
  if (/^(how many|what's the count of)\s+(open\s+)?tasks?\b/i.test(lower)) {
    const decision = await canInvoke(rep, "read.task");
    if (!decision.allowed) return { handled: false };
    const rows = await db.select().from(tasks).where(eq(tasks.assignedTo, rep.id));
    const open = rows.filter((t) => t.status === "open");
    const overdue = open.filter((t) => t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10));
    const text = open.length === 0
      ? "You have no open tasks. ✅"
      : `You have **${open.length}** open task${open.length === 1 ? "" : "s"}${overdue.length ? ` (${overdue.length} overdue)` : ""}.`;
    emit(emitFn, { content: text });
    return { handled: true, assistantText: text };
  }

  // Unhandled — fall through to the LLM
  return { handled: false };
}

/**
 * If the user is on a page with a known entity, return a context block to
 * inject into the system prompt. Also seeds the conversation memo so the
 * agent can resolve "this account" naturally.
 */
export async function buildPageContextBlock(
  organizationId: string,
  conversationRef: string | null,
  pageContext: PageContext | null | undefined,
): Promise<string | null> {
  if (!pageContext || !pageContext.entityType) return null;
  // The "task" page is the rep's task list — there's no per-row entity id, but
  // we still want to give the model the hint that they're on /tasks.
  if (pageContext.entityType === "task" && !pageContext.entityId) {
    const route = pageContext.route ? ` (${pageContext.route})` : "";
    return `Current page: the rep is on their **task list**${route}. When they say "this", "these", or refer to "the first/second one", they probably mean a row from that list. Consider calling list_open_tasks before answering.`;
  }
  if (!pageContext.entityId) return null;

  // SECURITY: Re-load the entity through the storage layer with the rep's
  // org/scope filter. The page-context payload from the client is untrusted,
  // so we never trust the supplied name/id alone.
  let label: string | null = null;
  let extra: string | null = null;
  try {
    switch (pageContext.entityType) {
      case "company": {
        const [c] = await db.select().from(companies)
          .where(eq(companies.id, pageContext.entityId)).limit(1);
        if (c && c.organizationId === organizationId) {
          label = c.name;
          if (c.industry) extra = `industry ${c.industry}`;
        }
        break;
      }
      case "carrier": {
        const c = await storage.getCarrier(pageContext.entityId);
        if (c && c.orgId === organizationId) {
          label = c.name;
          const bits = [c.mcDot && `MC/DOT ${c.mcDot}`, c.statesServed?.length && `${c.statesServed.length} states`].filter(Boolean) as string[];
          if (bits.length) extra = bits.join(", ");
        }
        break;
      }
      case "lane": {
        // available-freight URLs key off freightOpportunities.id; recurring
        // lane pages also use the recurring_lanes id. Try both.
        const fo = await storage.getFreightOpportunity(organizationId, pageContext.entityId).catch(() => undefined);
        if (fo) {
          label = `${fo.origin}${fo.originState ? `, ${fo.originState}` : ""} → ${fo.destination}${fo.destinationState ? `, ${fo.destinationState}` : ""}`;
          if (fo.equipmentType) extra = `${fo.equipmentType}, ${fo.loadCount}L`;
        } else {
          const rl = await storage.getRecurringLane(pageContext.entityId).catch(() => undefined);
          if (rl && rl.orgId === organizationId) {
            label = `${rl.origin}${rl.originState ? `, ${rl.originState}` : ""} → ${rl.destination}${rl.destinationState ? `, ${rl.destinationState}` : ""}`;
            extra = rl.companyName ?? null;
          }
        }
        break;
      }
      case "rfp": {
        const r = await storage.getRfpInOrg?.(pageContext.entityId, organizationId).catch(() => undefined);
        if (r) {
          label = r.title;
          if (r.dueDate) extra = `due ${r.dueDate}`;
        } else {
          // Fallback: validate via inner join on companies.organizationId.
          const [row] = await db
            .select({ r: rfps, oid: companies.organizationId })
            .from(rfps)
            .innerJoin(companies, eq(rfps.companyId, companies.id))
            .where(eq(rfps.id, pageContext.entityId))
            .limit(1);
          if (row && row.oid === organizationId) {
            label = row.r.title;
            if (row.r.dueDate) extra = `due ${row.r.dueDate}`;
          }
        }
        break;
      }
      case "contact": {
        const c = await storage.getContact(pageContext.entityId);
        if (c) {
          // Contacts are scoped through their parent company. Verify the
          // company belongs to this org before surfacing the name.
          const [co] = await db.select().from(companies)
            .where(eq(companies.id, c.companyId)).limit(1);
          if (co && co.organizationId === organizationId) {
            label = c.name;
            extra = [c.title, co.name].filter(Boolean).join(" @ ");
          }
        }
        break;
      }
      case "prospect": {
        const idNum = Number(pageContext.entityId);
        if (Number.isFinite(idNum)) {
          const p = await storage.getProspect(idNum).catch(() => undefined);
          if (p && p.organizationId === organizationId) {
            label = p.name;
            extra = `stage ${p.stage}`;
          }
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.warn("[agent.router] page pre-load failed:", err);
  }

  if (!label) return null;

  rememberEntity(conversationRef, {
    type: pageContext.entityType,
    id: pageContext.entityId,
    name: label,
  });

  const route = pageContext.route ? ` (${pageContext.route})` : "";
  const detail = extra ? ` — ${extra}` : "";
  return `Current page: the rep is viewing the ${pageContext.entityType} **${label}**${detail}${route}. When the rep says "this", "it", "this account/carrier/lane/RFP/prospect", they almost certainly mean ${label}. Resolve those references silently and act on them.`;
}
