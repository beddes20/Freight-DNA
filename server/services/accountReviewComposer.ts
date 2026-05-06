/**
 * Auto Weekly Account Review composer.
 *
 * Gathers a focused snapshot for a (rep, company) pair from existing data
 * sources — momentum (growth score), lane wins/losses (RFPs), contact health
 * (touchpoints + email signals), expansion opportunities (cross-sell), and
 * recent plays (NBA cards) — then asks an LLM to render a one-page
 * markdown review with a fixed section structure.
 *
 * Pure builder: callers (scheduler / on-demand route) persist the result.
 */

import OpenAI from "openai";
import { and, desc, eq } from "drizzle-orm";
import { db, storage } from "../storage";
import {
  rfps,
  awards,
  crossSellOpportunities,
  nbaCards,
  type Company,
  type Touchpoint,
  type Contact,
  type EmailSignal,
} from "@shared/schema";

type RfpRow = typeof rfps.$inferSelect;
type AwardRow = typeof awards.$inferSelect;
type CrossSellRow = typeof crossSellOpportunities.$inferSelect;
type NbaCardRow = typeof nbaCards.$inferSelect;

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

/** ISO yyyy-mm-dd of the Monday that begins the week containing `d`. */
export function weekOfFor(d: Date = new Date()): string {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

export interface ComposeInputs {
  organizationId: string;
  repUserId: string;
  repName: string;
  companyId: string;
  weekOf: string;
}

export interface ReviewSections {
  momentum: {
    score: number | null;
    band: string | null;
    previousScore: number | null;
    delta: number | null;
    drivers: unknown[];
  };
  laneWinsLosses: {
    recentRfps: Array<{ id: string; lane: string; status: string; submittedAt: string | null }>;
    recentAwards: Array<{ id: string; lane: string; awardedAt: string | null; volume: number | null }>;
  };
  contactHealth: {
    contactCount: number;
    touchpointsLast30d: number;
    lastTouchpointAt: string | null;
    sentimentMix: { positive: number; neutral: number; negative: number };
    risks: string[];
  };
  expansion: Array<{
    id: string; type: string; title: string; description: string;
    estimatedValue: string | null; lane: string | null; suggestedApproach: string | null;
  }>;
  recommendedPlays: Array<{ id: string; title: string; rationale: string | null; createdAt: string }>;
}

interface CompanyContext {
  company: Company;
  contacts: Contact[];
  touchpoints: Touchpoint[];
  emailSignals: EmailSignal[];
}

async function gatherCompanyContext(companyId: string): Promise<CompanyContext | null> {
  const company = await storage.getCompany(companyId);
  if (!company) return null;
  const [contacts, touchpoints, emailSignals] = await Promise.all([
    storage.getContactsByCompany(companyId),
    storage.getTouchpointsByCompany(companyId),
    storage.getEmailSignalsForAccount(companyId, 50),
  ]);
  return { company, contacts, touchpoints, emailSignals };
}

async function buildSections(input: ComposeInputs, ctx: CompanyContext): Promise<ReviewSections> {
  const { organizationId, companyId } = input;

  // Momentum from growth score, with delta vs prior calculation.
  const growth = await storage.getGrowthScore(companyId).catch(() => undefined);
  const momentum = {
    score: growth?.score ?? null,
    band: growth?.band ?? null,
    previousScore: growth?.previousScore ?? null,
    delta: growth?.score != null && growth?.previousScore != null
      ? growth.score - growth.previousScore : null,
    drivers: Array.isArray(growth?.drivers) ? (growth!.drivers as unknown[]).slice(0, 5) : [],
  };

  // Lane wins/losses — recent RFPs + Awards for this company. The RFP/Award
  // tables don't carry a createdAt column, so we keep the most recent rows
  // by ID order and let the LLM contextualise.
  const recentRfpRows: RfpRow[] = await db.select().from(rfps)
    .where(eq(rfps.companyId, companyId))
    .limit(50)
    .catch((): RfpRow[] => []);

  const recentAwardRows: AwardRow[] = await db.select().from(awards)
    .where(eq(awards.companyId, companyId))
    .limit(50)
    .catch((): AwardRow[] => []);

  const laneFromStates = (origin: unknown, destination: unknown): string => {
    const parts: string[] = [];
    if (Array.isArray(origin)) parts.push(origin.join("/"));
    if (Array.isArray(destination)) parts.push(destination.join("/"));
    return parts.filter(Boolean).join(" → ");
  };

  const laneWinsLosses = {
    recentRfps: recentRfpRows.slice(0, 10).map((r: RfpRow) => ({
      id: r.id,
      lane: r.title || laneFromStates(r.originStates, r.destinationStates) || "Unknown lane",
      status: r.status ?? "unknown",
      submittedAt: r.dueDate ? new Date(r.dueDate).toISOString() : null,
    })),
    recentAwards: recentAwardRows.slice(0, 10).map((a: AwardRow) => ({
      id: a.id,
      lane: a.title || (Array.isArray(a.lanes) ? a.lanes.slice(0, 2).join(", ") : "Unknown lane"),
      awardedAt: a.awardDate ? new Date(a.awardDate).toISOString() : null,
      volume: a.value != null ? Number(a.value) : null,
    })),
  };

  // Contact health
  const thirtyAgo = new Date(Date.now() - 30 * 86400000);
  const tpLast30 = ctx.touchpoints.filter(t => new Date(t.createdAt) >= thirtyAgo);
  const lastTp = ctx.touchpoints[0]
    ? ctx.touchpoints.reduce((a, b) =>
        new Date(a.createdAt) > new Date(b.createdAt) ? a : b)
    : null;

  // Derive a coarse sentiment-style mix from intent types since the
  // EmailSignal table doesn't carry an explicit sentiment column.
  const positiveIntents = new Set(["expansion", "award", "compliment", "approval", "confirmation"]);
  const negativeIntents = new Set(["complaint", "rejection", "escalation", "dispute", "cancellation"]);
  const sentimentMix = { positive: 0, neutral: 0, negative: 0 };
  for (const sig of ctx.emailSignals) {
    const intent = (sig.intentType || "").toLowerCase();
    if (positiveIntents.has(intent)) sentimentMix.positive++;
    else if (negativeIntents.has(intent)) sentimentMix.negative++;
    else sentimentMix.neutral++;
  }

  const risks: string[] = [];
  if (ctx.contacts.length === 0) risks.push("No contacts on file");
  if (tpLast30.length === 0) risks.push("No touchpoints in the last 30 days");
  if (sentimentMix.negative > sentimentMix.positive && sentimentMix.negative >= 2) {
    risks.push(`Negative email sentiment trending (${sentimentMix.negative} negative vs ${sentimentMix.positive} positive)`);
  }

  const contactHealth = {
    contactCount: ctx.contacts.length,
    touchpointsLast30d: tpLast30.length,
    lastTouchpointAt: lastTp ? new Date(lastTp.createdAt).toISOString() : null,
    sentimentMix,
    risks,
  };

  // Expansion — open cross-sell opportunities for this company.
  const csRows: CrossSellRow[] = await db.select().from(crossSellOpportunities)
    .where(and(
      eq(crossSellOpportunities.orgId, organizationId),
      eq(crossSellOpportunities.companyId, companyId),
    ))
    .orderBy(desc(crossSellOpportunities.confidenceScore), desc(crossSellOpportunities.createdAt))
    .limit(5)
    .catch((): CrossSellRow[] => []);
  const expansion = csRows.map((c: CrossSellRow) => ({
    id: c.id,
    type: c.opportunityType,
    title: c.title,
    description: c.description,
    estimatedValue: c.estimatedValue != null ? String(c.estimatedValue) : null,
    lane: c.lane,
    suggestedApproach: c.suggestedApproach,
  }));

  // Recommended plays — recent NBA cards for this rep + company.
  const playRows: NbaCardRow[] = await db.select().from(nbaCards)
    .where(and(
      eq(nbaCards.orgId, organizationId),
      eq(nbaCards.companyId, companyId),
    ))
    .limit(20)
    .catch((): NbaCardRow[] => []);
  const recommendedPlays = playRows.slice(0, 5).map((p: NbaCardRow) => ({
    id: p.id,
    title: p.playLabel || p.suggestedAction || p.ruleType || "Play",
    rationale: p.whyThisNow ?? p.expectedOutcome ?? null,
    createdAt: p.snoozeUntil ? new Date(p.snoozeUntil).toISOString() : "",
  }));

  return { momentum, laneWinsLosses, contactHealth, expansion, recommendedPlays };
}

function fallbackMarkdown(input: ComposeInputs, company: Company, sections: ReviewSections): string {
  const m = sections.momentum;
  const momentumLine = m.score != null
    ? `**Score ${m.score}** (${m.band ?? "n/a"})${m.delta != null ? ` — Δ ${m.delta >= 0 ? "+" : ""}${m.delta} vs prior` : ""}`
    : "No growth score yet.";
  const lwl = sections.laneWinsLosses;
  const ch = sections.contactHealth;
  const exp = sections.expansion;
  const plays = sections.recommendedPlays;

  return [
    `# Weekly Account Review — ${company.name}`,
    `_Week of ${input.weekOf} • Rep: ${input.repName}_`,
    ``,
    `## Momentum`,
    `- ${momentumLine}`,
    ...m.drivers.slice(0, 3).map(d => `- ${typeof d === "string" ? d : JSON.stringify(d)}`),
    ``,
    `## Lane Wins / Losses (last 90d)`,
    `- Recent RFPs: ${lwl.recentRfps.length}`,
    ...lwl.recentRfps.slice(0, 3).map(r => `  - ${r.lane} — ${r.status}`),
    `- Recent Awards: ${lwl.recentAwards.length}`,
    ...lwl.recentAwards.slice(0, 3).map(a => `  - ${a.lane}${a.volume ? ` (${a.volume} loads)` : ""}`),
    ``,
    `## Contact Health`,
    `- Contacts on file: ${ch.contactCount}`,
    `- Touchpoints in last 30 days: ${ch.touchpointsLast30d}`,
    `- Last touch: ${ch.lastTouchpointAt ? new Date(ch.lastTouchpointAt).toISOString().slice(0, 10) : "—"}`,
    `- Email sentiment: ${ch.sentimentMix.positive}+ / ${ch.sentimentMix.neutral}~ / ${ch.sentimentMix.negative}-`,
    ...ch.risks.map(r => `- ⚠️ ${r}`),
    ``,
    `## Expansion Opportunities`,
    ...(exp.length === 0 ? ["- No open opportunities surfaced."] :
      exp.map(o => `- **${o.title}** — ${o.description}${o.lane ? ` _(lane: ${o.lane})_` : ""}`)),
    ``,
    `## Recommended Plays`,
    ...(plays.length === 0 ? ["- No active recommended plays this week."] :
      plays.map(p => `- **${p.title}** — ${p.rationale ?? ""}`)),
  ].join("\n");
}

async function renderWithLLM(input: ComposeInputs, company: Company, sections: ReviewSections): Promise<string> {
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    return fallbackMarkdown(input, company, sections);
  }
  const system = `You are a senior freight sales coach. Write a concise one-page weekly account review in markdown. Use exactly these H2 sections in order: Momentum, Lane Wins / Losses, Contact Health, Expansion Opportunities, Recommended Plays. Be specific, cite numbers from the data, keep total length under ~350 words, and never invent facts.`;
  const user = `Company: ${company.name}
Rep: ${input.repName}
Week of: ${input.weekOf}

Structured snapshot (JSON):
${JSON.stringify(sections, null, 2)}

Write the review now.`;
  try {
    const resp = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_tokens: 900,
    });
    const text = resp.choices?.[0]?.message?.content?.trim();
    return text || fallbackMarkdown(input, company, sections);
  } catch {
    return fallbackMarkdown(input, company, sections);
  }
}

export interface ComposedReview {
  weekOf: string;
  body: string;
  sections: ReviewSections;
  sourceSnapshots: {
    contactCount: number;
    touchpointCount: number;
    rfpCount: number;
    awardCount: number;
    crossSellCount: number;
    growthScoreId: number | null;
  };
}

export async function composeAccountReview(input: ComposeInputs): Promise<ComposedReview | null> {
  const ctx = await gatherCompanyContext(input.companyId);
  if (!ctx) return null;
  const sections = await buildSections(input, ctx);
  const body = await renderWithLLM(input, ctx.company, sections);
  const growth = await storage.getGrowthScore(input.companyId).catch(() => undefined);
  return {
    weekOf: input.weekOf,
    body,
    sections,
    sourceSnapshots: {
      contactCount: ctx.contacts.length,
      touchpointCount: ctx.touchpoints.length,
      rfpCount: sections.laneWinsLosses.recentRfps.length,
      awardCount: sections.laneWinsLosses.recentAwards.length,
      crossSellCount: sections.expansion.length,
      growthScoreId: growth?.id ?? null,
    },
  };
}
