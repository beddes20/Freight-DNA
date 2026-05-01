/**
 * Task #912 — Play Matcher.
 *
 * Maps overlay signals → suggested plays for the Fit & Intelligence Card.
 *
 * Three-stage match (Phase 5 will tune these against real reactions):
 *   1. Deterministic — hard-coded rules over overlay tags. These are the
 *      always-true plays ("carrier doesn't serve destination state →
 *      suggest pre-bid disqualification") that should never be skipped.
 *   2. Scored — rank `agentPlays` rows by keyword overlap between
 *      `whenToUse` and the overlay tag set. Returns the top N above a
 *      threshold.
 *   3. Model — *intentionally not implemented in this slice*. The reasoner
 *      will fall back to deterministic-only when the org has no plays
 *      matching the threshold; we don't synthesize plays from a model
 *      yet because the card MUST cite a source.
 *
 * Each returned play carries the source chips that justified its match.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../storage";
import { agentPlays, type AgentPlay, type IntelligenceCardPlay, type IntelligenceCardSource } from "@shared/schema";
import type { IntelligenceOverlay } from "./intelligenceOverlay";

const MAX_SUGGESTED_PLAYS = 5;
const SCORED_MATCH_THRESHOLD = 0.15;

interface DeterministicRule {
  /** Lower-cased synthetic play ID (returned as `playId: null` in payload). */
  id: string;
  /** Tag(s) that, if all present, fire this rule. */
  whenAll: string[];
  /** Tag(s) that prevent firing. */
  unless?: string[];
  name: string;
  why: (overlay: IntelligenceOverlay) => string;
  action: string;
  pickSources: (overlay: IntelligenceOverlay) => IntelligenceCardSource[];
}

const DETERMINISTIC_RULES: DeterministicRule[] = [
  {
    id: "block_finding_review",
    whenAll: ["block_finding"],
    name: "Resolve blocking inconsistency before responding",
    why: (o) => {
      const blockers = o.findings.filter((f) => f.finding.severity === "block")
        .map((f) => f.finding.ruleCode).join(", ");
      return `Slice 2 found blocking inconsistencies (${blockers}); the rate-con cannot be acted on until they are resolved.`;
    },
    action: "Open the document review panel and reconcile each blocking finding before quoting or dispatching.",
    pickSources: (o) =>
      o.findings.filter((f) => f.finding.severity === "block").map((f) => f.source),
  },
  {
    id: "carrier_does_not_serve_lane",
    whenAll: ["carrier_lane_mismatch"],
    name: "Confirm carrier lane authority before committing",
    why: (o) => {
      const c = o.carrier?.carrier.name ?? "this carrier";
      return `${c}'s claimed states-served does not include this origin or destination state.`;
    },
    action: "Call the dispatcher to confirm coverage on this lane before issuing a confirmation.",
    pickSources: (o) => (o.carrier ? [o.carrier.source] : []),
  },
  {
    id: "carrier_equipment_mismatch",
    whenAll: ["carrier_equipment_mismatch"],
    name: "Confirm equipment fit",
    why: (o) =>
      `Carrier's equipment types do not include the equipment on this rate-con (${o.carrier?.carrier.equipmentTypes?.join(", ") ?? "—"}).`,
    action: "Verify equipment availability with the carrier before locking the load.",
    pickSources: (o) => (o.carrier ? [o.carrier.source] : []),
  },
  {
    id: "carrier_do_not_use",
    whenAll: ["carrier_do_not_use"],
    name: "Carrier is on the do-not-use list",
    why: () => "This carrier's status is `do_not_use` in the carrier registry.",
    action: "Do not dispatch this carrier; raise with the carrier ops lead and pick a replacement from the bench.",
    pickSources: (o) => (o.carrier ? [o.carrier.source] : []),
  },
  {
    id: "ambiguous_customer",
    whenAll: ["ambiguous_customer"],
    name: "Disambiguate customer before posting opportunity",
    why: () => "Slice 2 entity resolver returned multiple customer candidates; the card cannot anchor downstream actions safely.",
    action: "Open the document and pick the correct customer link, then re-run the card.",
    pickSources: (o) => (o.customer ? [o.customer.source] : []),
  },
  {
    id: "ambiguous_carrier",
    whenAll: ["ambiguous_carrier"],
    name: "Disambiguate carrier before dispatch",
    why: () => "Slice 2 entity resolver returned multiple carrier candidates; we won't auto-pick.",
    action: "Open the document and pick the correct carrier link, then re-run the card.",
    pickSources: (o) => (o.carrier ? [o.carrier.source] : []),
  },
  {
    id: "open_capture_failure",
    whenAll: ["open_capture_failure"],
    name: "Resolve open won-quote capture failure",
    why: (o) =>
      `${o.captureFailures.length} open won-quote capture failure(s) for this customer — likely the same lane is leaking into spot.`,
    action: "Open the freight capture failure queue and resolve the matching row before opening a new opportunity.",
    pickSources: (o) => o.captureFailures.slice(0, 2).map((c) => c.source),
  },
  {
    id: "open_opportunity_overlap",
    whenAll: ["open_opportunity_overlap"],
    name: "Attach to existing open opportunity",
    why: (o) =>
      `${o.openOpportunities.length} open freight opportunit${o.openOpportunities.length === 1 ? "y" : "ies"} already exist for this lane.`,
    action: "Link the rate-con to the existing opportunity instead of creating a duplicate.",
    pickSources: (o) => o.openOpportunities.slice(0, 2).map((p) => p.source),
  },
  {
    id: "recurring_lane_no_carrier_program",
    whenAll: ["recurring_lane"],
    unless: ["carrier_lane_mismatch"],
    name: "Bind to recurring lane carrier program",
    why: (o) => {
      const lane = o.recurringLanes[0]?.lane;
      if (!lane) return "This lane is recognised as recurring.";
      const cadence = lane.avgLoadsPerWeek ? `${Number(lane.avgLoadsPerWeek).toFixed(1)} loads/wk` : "an active cadence";
      return `Recurring lane (${cadence}); the carrier program covers it.`;
    },
    action: "Quote off the recurring-lane carrier program rather than spot.",
    pickSources: (o) => o.recurringLanes.slice(0, 1).map((l) => l.source),
  },
  {
    id: "freight_stale",
    whenAll: ["freight_stale"],
    name: "Refresh freight signal before quoting",
    why: (o) =>
      `Freight freshness signal is ${o.freshness?.freshnessMinutes ?? "?"} minutes old — older than the 4 hour quoting window.`,
    action: "Open the freight refresh runner before sending a quote so today's volumes are live.",
    pickSources: (o) => (o.freshness ? [o.freshness.source] : []),
  },
];

function fireDeterministic(overlay: IntelligenceOverlay): IntelligenceCardPlay[] {
  const tagSet = new Set(overlay.tags);
  const out: IntelligenceCardPlay[] = [];
  for (const rule of DETERMINISTIC_RULES) {
    if (!rule.whenAll.every((t) => tagSet.has(t))) continue;
    if (rule.unless && rule.unless.some((t) => tagSet.has(t))) continue;
    const sources = rule.pickSources(overlay);
    if (sources.length === 0) continue; // refuse to fire without source
    out.push({
      playId: null,
      name: rule.name,
      why: rule.why(overlay),
      action: rule.action,
      matchScore: 1,
      matchKind: "deterministic",
      sources,
    });
  }
  return out;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/g).filter((t) => t.length >= 3);
}

function scorePlay(play: AgentPlay, overlay: IntelligenceOverlay): number {
  const haystack = new Set([...tokenize(play.whenToUse), ...tokenize(play.name)]);
  if (haystack.size === 0) return 0;
  const needles = new Set(overlay.tags.map((t) => t.toLowerCase()));
  // Add lane / customer / carrier facets so a play that says "do_not_use" or
  // "recurring_lane" or "ambiguous" matches even without exact tag tokens.
  if (overlay.customer) tokenize(overlay.customer.company.name).forEach((t) => needles.add(t));
  if (overlay.carrier) tokenize(overlay.carrier.carrier.name).forEach((t) => needles.add(t));
  let hits = 0;
  for (const n of needles) if (haystack.has(n)) hits++;
  // Score is fraction of needles hit, capped to play-keyword density so
  // tiny `whenToUse` strings don't dominate.
  return needles.size === 0 ? 0 : hits / Math.max(needles.size, haystack.size / 2);
}

async function fireScored(
  agentId: string | null,
  overlay: IntelligenceOverlay,
): Promise<IntelligenceCardPlay[]> {
  if (!agentId) return [];
  const rows = await db.select().from(agentPlays)
    .where(and(eq(agentPlays.agentId, agentId), eq(agentPlays.enabled, true)))
    .catch(() => [] as AgentPlay[]);
  if (rows.length === 0) return [];
  const scored = (rows as AgentPlay[]).map((p) => ({ play: p, score: scorePlay(p, overlay) }))
    .filter((r) => r.score >= SCORED_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTED_PLAYS);

  return scored.map((r): IntelligenceCardPlay => {
    // Source chip for a scored play — point at the play row itself; the
    // reasoner adds overlay sources in addition where they support the play.
    const sources: IntelligenceCardSource[] = [{
      kind: "agent_play" as const,
      ref: r.play.id,
      label: `Play: ${r.play.name}`,
      href: null,
      updatedAt: r.play.updatedAt ? new Date(r.play.updatedAt as Date).toISOString() : null,
    }];
    if (overlay.recurringLanes[0]) sources.push(overlay.recurringLanes[0].source);
    else if (overlay.carrier) sources.push(overlay.carrier.source);
    else if (overlay.customer) sources.push(overlay.customer.source);
    return {
      playId: r.play.id,
      name: r.play.name,
      why: r.play.whenToUse,
      action: r.play.body.slice(0, 400),
      matchScore: Number(r.score.toFixed(3)),
      matchKind: "scored",
      sources,
    };
  });
}

export interface MatchPlaysArgs {
  agentId?: string | null;
  overlay: IntelligenceOverlay;
}

export async function matchPlays(args: MatchPlaysArgs): Promise<IntelligenceCardPlay[]> {
  const det = fireDeterministic(args.overlay);
  const scored = await fireScored(args.agentId ?? null, args.overlay);
  // Dedup by name (deterministic wins over scored).
  const seen = new Set<string>();
  const out: IntelligenceCardPlay[] = [];
  for (const p of [...det, ...scored]) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_SUGGESTED_PLAYS) break;
  }
  return out;
}
