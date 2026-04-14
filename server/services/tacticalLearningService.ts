import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../storage";
import { provenTactics, emailSignals, emailMessages } from "@shared/schema";
import type { ProvenTactic } from "@shared/schema";

const SIGNAL_LABELS: Record<string, string> = {
  objection: "Objection Handling",
  pricing_request: "Pricing Response",
  service_complaint: "Service Recovery",
  urgency_signal: "Urgency Response",
  new_opportunity: "Opportunity Capture",
  stalled_thread: "Re-engagement",
  positive_feedback: "Relationship Deepening",
  closed_won_indicator: "Closing Move",
  closed_lost_indicator: "Loss Recovery",
  conversation_spark_geography_expansion: "Geography Expansion",
  conversation_spark_new_stakeholder: "New Stakeholder Approach",
};

function labelForSignal(signalType: string): string {
  return SIGNAL_LABELS[signalType] ?? signalType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export async function getProvenTacticsForSignal(
  orgId: string,
  signalType: string,
  limit = 5,
): Promise<ProvenTactic[]> {
  return db.select()
    .from(provenTactics)
    .where(
      and(
        eq(provenTactics.orgId, orgId),
        eq(provenTactics.signalType, signalType),
        eq(provenTactics.outcome, "won"),
      )
    )
    .orderBy(desc(provenTactics.successRate), desc(provenTactics.timesUsed))
    .limit(limit);
}

export async function getAllProvenTactics(
  orgId: string,
  filters?: { outcome?: string; signalType?: string },
): Promise<ProvenTactic[]> {
  const conditions = [eq(provenTactics.orgId, orgId)];
  if (filters?.outcome) conditions.push(eq(provenTactics.outcome, filters.outcome));
  if (filters?.signalType) conditions.push(eq(provenTactics.signalType, filters.signalType));

  return db.select()
    .from(provenTactics)
    .where(and(...conditions))
    .orderBy(desc(provenTactics.successRate), desc(provenTactics.timesUsed), desc(provenTactics.createdAt))
    .limit(100);
}

export async function getTacticStats(orgId: string): Promise<{
  totalTactics: number;
  wonTactics: number;
  pendingTactics: number;
  topSignalTypes: { signalType: string; count: number; avgSuccessRate: number }[];
}> {
  const all = await db.select().from(provenTactics).where(eq(provenTactics.orgId, orgId));
  const won = all.filter(t => t.outcome === "won");
  const pending = all.filter(t => t.outcome === "pending");

  const bySignal = new Map<string, { count: number; totalRate: number }>();
  for (const t of all) {
    const entry = bySignal.get(t.signalType) ?? { count: 0, totalRate: 0 };
    entry.count++;
    entry.totalRate += t.successRate ?? 0;
    bySignal.set(t.signalType, entry);
  }

  const topSignalTypes = Array.from(bySignal.entries())
    .map(([signalType, data]) => ({
      signalType,
      count: data.count,
      avgSuccessRate: Math.round(data.totalRate / data.count),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalTactics: all.length,
    wonTactics: won.length,
    pendingTactics: pending.length,
    topSignalTypes,
  };
}

export async function recordTacticOutcome(
  tacticId: string,
  outcome: "won" | "lost",
  orgId: string,
): Promise<ProvenTactic | null> {
  const [existing] = await db.select()
    .from(provenTactics)
    .where(and(eq(provenTactics.id, tacticId), eq(provenTactics.orgId, orgId)));
  if (!existing) return null;

<<<<<<< HEAD
  if (existing.outcome !== "pending") {
    return existing;
  }

=======
>>>>>>> dfcc757 (Saved your changes before starting work)
  const newSuccessCount = outcome === "won" ? existing.successCount + 1 : existing.successCount;
  const newFailureCount = outcome === "lost" ? existing.failureCount + 1 : existing.failureCount;
  const total = newSuccessCount + newFailureCount;
  const newSuccessRate = total > 0 ? Math.round((newSuccessCount / total) * 100) : 0;

  const [updated] = await db.update(provenTactics)
    .set({
      outcome,
      outcomeConfidence: 90,
      successCount: newSuccessCount,
      failureCount: newFailureCount,
      successRate: newSuccessRate,
      resolvedAt: new Date(),
    })
    .where(eq(provenTactics.id, tacticId))
    .returning();

  return updated ?? null;
}

export async function captureTacticFromResponse(params: {
  orgId: string;
  signalType: string;
  signalSubtype?: string;
  tacticLabel: string;
  tacticSummary: string;
  exampleResponse: string;
  sourceMessageId?: string;
  sourceSignalId?: string;
  linkedAccountId?: string;
  accountName?: string;
  repUserId?: string;
  repName?: string;
  outcome?: string;
}): Promise<ProvenTactic> {
  const [inserted] = await db.insert(provenTactics)
    .values({
      orgId: params.orgId,
      signalType: params.signalType,
      signalSubtype: params.signalSubtype ?? null,
      tacticLabel: params.tacticLabel,
      tacticSummary: params.tacticSummary,
      exampleResponse: params.exampleResponse,
      sourceMessageId: params.sourceMessageId ?? null,
      sourceSignalId: params.sourceSignalId ?? null,
      linkedAccountId: params.linkedAccountId ?? null,
      accountName: params.accountName ?? null,
      repUserId: params.repUserId ?? null,
      repName: params.repName ?? null,
      outcome: params.outcome ?? "pending",
      successCount: params.outcome === "won" ? 1 : 0,
      failureCount: params.outcome === "lost" ? 1 : 0,
      successRate: params.outcome === "won" ? 100 : 0,
      resolvedAt: params.outcome && params.outcome !== "pending" ? new Date() : null,
    })
    .returning();
  return inserted;
}

export async function seedDemoTactics(orgId: string): Promise<void> {
  const existing = await db.select({ id: provenTactics.id })
    .from(provenTactics)
    .where(eq(provenTactics.orgId, orgId))
    .limit(1);

  if (existing.length > 0) return;

  const demoTactics = [
    {
      orgId,
      signalType: "objection",
      signalSubtype: "rate_pushback",
      tacticLabel: "Anchor on Service Value",
      tacticSummary: "When a customer pushes back on rates, acknowledge the concern but redirect to service reliability and on-time delivery metrics. Reference specific recent loads where service was strong.",
      exampleResponse: "Hey Mike, I hear you on the rate — totally get it. But I want to make sure we're looking at the full picture. Our on-time delivery on your CHI→LAX lane has been 98.5% over the last 90 days. That consistency is saving you a ton on detention and redelivery costs. Let me pull exact numbers and we can talk through it?",
      outcome: "won",
      outcomeConfidence: 95,
      timesUsed: 7,
      successCount: 5,
      failureCount: 2,
      successRate: 71,
      accountName: "Pacific Coast Distribution",
      repName: "Ben Beddes",
      resolvedAt: new Date(),
    },
    {
      orgId,
      signalType: "objection",
      signalSubtype: "competitor_mention",
      tacticLabel: "Competitor Comparison Deflection",
      tacticSummary: "When a customer mentions a competitor's lower rate, avoid direct comparison. Instead, ask about the competitor's coverage on their harder lanes to expose gaps.",
      exampleResponse: "Hey, appreciate you letting me know. Quick question — are they covering your OR→TX lanes too? That corridor has been tight lately and I know we've kept you moving. Happy to look at a package rate if we're covering the full network.",
      outcome: "won",
      outcomeConfidence: 85,
      timesUsed: 4,
      successCount: 3,
      failureCount: 1,
      successRate: 75,
      accountName: "MidWest Food Group",
      repName: "Ben Beddes",
      resolvedAt: new Date(),
    },
    {
      orgId,
      signalType: "service_complaint",
      tacticLabel: "Immediate Ownership + Solution",
      tacticSummary: "When a service complaint comes in, immediately acknowledge the issue, take ownership, and present a concrete corrective action within the same message. Don't just apologize — show the fix.",
      exampleResponse: "Hey Sarah, that's on us — I'm really sorry about the late delivery on load #4521. I've already spoken to our dispatch team and we're switching to a dedicated carrier for your WI→IL loads going forward. I'll personally monitor the next 5 loads. Can I give you a call this afternoon to walk through what happened?",
      outcome: "won",
      outcomeConfidence: 90,
      timesUsed: 6,
      successCount: 5,
      failureCount: 1,
      successRate: 83,
      accountName: "Summit Frozen Foods",
      repName: "Ben Beddes",
      resolvedAt: new Date(),
    },
    {
      orgId,
      signalType: "pricing_request",
      tacticLabel: "Volume Tier Proposal",
      tacticSummary: "When a customer asks for better rates, propose a volume commitment structure rather than simply cutting the rate. Frame it as a partnership: more predictable volume = better carrier rates = savings passed through.",
      exampleResponse: "Hi Tom, happy to sharpen the pencil here. What if we set up a weekly commitment of 3-5 loads on your ATL→DAL lane? That lets me lock in capacity at a better rate. I'm thinking we could get you down to $2.15/mi if we hit 4+ loads/week consistently. Want to try a 30-day pilot?",
      outcome: "won",
      outcomeConfidence: 88,
      timesUsed: 5,
      successCount: 4,
      failureCount: 1,
      successRate: 80,
      accountName: "Heartland Building Products",
      repName: "Ben Beddes",
      resolvedAt: new Date(),
    },
    {
      orgId,
      signalType: "urgency_signal",
      tacticLabel: "Immediate Capacity Lock",
      tacticSummary: "When an urgency signal is detected, respond within minutes with a specific truck/carrier already in mind. Don't say 'let me check' — come with the answer.",
      exampleResponse: "Hey, just saw this come through. I've got a driver sitting empty in Memphis right now who can pick up tomorrow AM. Shoot me the PO and I'll get this locked in within the hour.",
      outcome: "won",
      outcomeConfidence: 92,
      timesUsed: 8,
      successCount: 7,
      failureCount: 1,
      successRate: 88,
      accountName: "Pacific Coast Distribution",
      repName: "Ben Beddes",
      resolvedAt: new Date(),
    },
    {
      orgId,
      signalType: "stalled_thread",
      tacticLabel: "Data-Driven Re-engagement",
      tacticSummary: "When a thread goes cold, re-engage with fresh data about their market or lane. Don't ask 'just checking in' — bring a reason to respond.",
      exampleResponse: "Hey Mark, heads up — I've been watching the DAL→PHX corridor and rates just dropped 8% this week. Given your volume there, this could save you $2K/month. Want me to run the numbers?",
      outcome: "pending",
      timesUsed: 3,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      accountName: "Mohawk Industries",
      repName: "Ben Beddes",
    },
    {
      orgId,
      signalType: "new_opportunity",
      tacticLabel: "Adjacent Lane Opener",
      tacticSummary: "When a new opportunity signal appears (e.g., geography expansion), offer to cover adjacent lanes they haven't tried yet. Use existing performance data as proof of capability.",
      exampleResponse: "Hi Lisa, I noticed you mentioned expanding into the Southeast. We've been running a solid CHI→ATL program for Pacific Coast — 97% on-time, zero claims in 6 months. I'd love to set up something similar for your team. What does your volume look like on those lanes?",
      outcome: "pending",
      timesUsed: 2,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      accountName: "MidWest Food Group",
      repName: "Ben Beddes",
    },
    {
      orgId,
      signalType: "positive_feedback",
      tacticLabel: "Deepen with New Stakeholder Intro",
      tacticSummary: "When positive feedback comes in, use the goodwill to ask for introductions to other decision-makers or departments. Strike while the iron is hot.",
      exampleResponse: "Hey, really glad to hear the service has been solid! Quick thought — is there anyone on your procurement team handling the outbound side that I should connect with? I'd love to see if we can help there too. Happy to jump on a call.",
      outcome: "won",
      outcomeConfidence: 78,
      timesUsed: 3,
      successCount: 2,
      failureCount: 1,
      successRate: 67,
      accountName: "Heartland Building Products",
      repName: "Ben Beddes",
      resolvedAt: new Date(),
    },
  ];

  for (const t of demoTactics) {
    await db.insert(provenTactics).values(t);
  }

  console.log(`[tacticalLearning] Seeded ${demoTactics.length} demo tactics for org ${orgId}`);
}

export { labelForSignal };
