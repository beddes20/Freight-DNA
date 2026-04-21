/**
 * Task #373 — NBA Ready-to-Act endpoint.
 *
 * GET /api/nba/cards/:id/ready-to-act
 *   Lazily generates an outreach payload for an NBA card:
 *     - shape (email | sms | call | lane_capacity)
 *     - recommended contact (with reason)
 *     - 3–5 talking points pulled from recent emails / touchpoints / notes
 *     - editable draft body (email/SMS) or call talking-points list
 *     - optional quote/price hint for pricing-related triggers
 *     - default touch type for the 1-click "Log this touch" button
 *
 *   Query params:
 *     contactId   — override recommended contact
 *     tone        — warm | concise | firm | curious | default
 *     regenerate  — "1" to bypass cache
 */

import type { Express, Request, Response } from "express";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getCurrentUser } from "../auth";
import { storage, db } from "../storage";
import { emailMessages, touchpoints } from "@shared/schema";
import type { Contact, NbaCard, RecurringLane } from "@shared/schema";
import { getReadyToActSpec, TONE_INSTRUCTIONS } from "../nbaReadyToActMapping";
import { gatherDataAnchors, generateDraft, PLAY_TYPES } from "./emailDrafting";
import { getVoiceProfile } from "../voiceProfileService";

interface ReadyToActPayload {
  shape: "email" | "sms" | "call" | "lane_capacity";
  message?: string;
  draftLabel?: string;
  playLabel?: string;
  defaultTouchType?: string;
  recommendedContact?: {
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    relationshipBase: string | null;
    reason: string;
  } | null;
  talkingPoints?: string[];
  draft?: string;
  callPoints?: string[];
  dataAnchors?: unknown;
  voiceProfileAvailable?: boolean;
  voiceProfileSampleCount?: number;
  quoteHint?: { laneLabel: string; basis: string; suggestedRange: string } | null;
  tone?: string;
  generatedAt?: string;
}

interface CachedPayload {
  expiresAt: number;
  cacheKey: string;
  payload: ReadyToActPayload;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CachedPayload>();

function makeCacheKey(cardId: string, contactId: string | undefined, tone: string): string {
  return `${cardId}|${contactId ?? "default"}|${tone}`;
}

async function pickRecommendedContact(
  companyId: string,
  primaryContactId: string | null | undefined,
  cardContactId: string | null | undefined,
): Promise<{ contact: Contact | null; reason: string }> {
  // Always scope candidates to the card's company so we never return cross-tenant contacts.
  const allContacts = await storage.getContactsByCompany(companyId);
  const byId = new Map(allContacts.map(c => [c.id, c]));

  if (cardContactId && byId.has(cardContactId)) {
    return { contact: byId.get(cardContactId)!, reason: "Tied directly to this signal" };
  }
  if (primaryContactId && byId.has(primaryContactId)) {
    return { contact: byId.get(primaryContactId)!, reason: "Primary contact on this account" };
  }
  if (allContacts.length === 0) return { contact: null, reason: "" };
  const contactIds = allContacts.map(c => c.id);
  const recent = await db.select({
    contactId: touchpoints.contactId,
    date: touchpoints.date,
  })
    .from(touchpoints)
    .where(inArray(touchpoints.contactId, contactIds))
    .orderBy(desc(touchpoints.date))
    .limit(5);
  if (recent.length > 0 && recent[0].contactId) {
    const c = byId.get(recent[0].contactId);
    if (c) return { contact: c, reason: "Most recent person you've talked to here" };
  }
  // Sort by relationship base ranking
  const baseRank: Record<string, number> = { advocate: 4, champion: 4, supporter: 3, neutral: 2, blocker: 0 };
  allContacts.sort((a, b) => (baseRank[b.relationshipBase ?? "neutral"] ?? 1) - (baseRank[a.relationshipBase ?? "neutral"] ?? 1));
  return { contact: allContacts[0], reason: "Strongest relationship in your contacts here" };
}

async function gatherTalkingPoints(
  orgId: string,
  companyId: string,
  contactIds: string[],
): Promise<string[]> {
  const points: string[] = [];
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  // Recent touchpoints with notes
  if (contactIds.length > 0) {
    const tps = await db.select()
      .from(touchpoints)
      .where(and(
        inArray(touchpoints.contactId, contactIds),
        gte(touchpoints.date, since.split("T")[0]),
      ))
      .orderBy(desc(touchpoints.date))
      .limit(8);
    for (const tp of tps) {
      if (tp.notes && typeof tp.notes === "string" && tp.notes.trim()) {
        const snippet = tp.notes.trim().slice(0, 160);
        const dateStr = String(tp.date).slice(0, 10);
        points.push(`${tp.type} (${dateStr}): ${snippet}`);
      }
      if (points.length >= 3) break;
    }
  }
  // Recent inbound emails
  if (points.length < 5) {
    const emails = await db.select({
      subject: emailMessages.subject,
      body: emailMessages.body,
      direction: emailMessages.direction,
      createdAt: emailMessages.createdAt,
    })
      .from(emailMessages)
      .where(and(
        eq(emailMessages.orgId, orgId),
        eq(emailMessages.linkedAccountId, companyId),
      ))
      .orderBy(desc(emailMessages.createdAt))
      .limit(5);
    for (const m of emails) {
      const cleanBody = (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
      if (!cleanBody) continue;
      const dir = m.direction === "outbound" ? "Sent email" : "Received email";
      const subj = m.subject ? ` "${m.subject.slice(0, 50)}"` : "";
      points.push(`${dir}${subj}: ${cleanBody}`);
      if (points.length >= 5) break;
    }
  }
  return points.slice(0, 5);
}

async function generateSmsOrCallDraft(params: {
  shape: "sms" | "call";
  playLabel: string;
  whyThisNow: string;
  suggestedAction: string;
  dataContext: string;
  contactName?: string;
  toneNote: string;
}): Promise<string> {
  const { shape, playLabel, whyThisNow, suggestedAction, dataContext, contactName, toneNote } = params;
  const isSms = shape === "sms";
  const systemPrompt = isSms
    ? `You are an AI assistant for a freight brokerage CRM. Draft a SHORT text message (1-2 sentences, max 280 chars) from the rep to a freight contact. Casual but professional. No greeting. No sign-off. ${toneNote}`
    : `You are an AI assistant for a freight brokerage CRM. Draft 3 sharp, specific call talking-points for a phone call. Each is 1 short sentence. Reference the actual context. Output a numbered list (1. 2. 3.) and nothing else. ${toneNote}`;
  const userPrompt = `Strategic intent: ${playLabel}
Why now: ${whyThisNow}
Suggested action: ${suggestedAction}
${contactName ? `Contact: ${contactName}` : ""}

Context data:
${dataContext || "(no additional data)"}

${isSms ? "Write the text message now:" : "Write the 3 numbered talking-points now:"}`;
  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: isSms ? 120 : 250,
    });
    return completion.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("[nbaReadyToAct] LLM error:", err);
    return isSms ? "Quick check-in — got a minute to chat?" : "1. Reference the recent activity\n2. Ask the open question\n3. Confirm the next step";
  }
}

function buildQuoteHint(card: NbaCard, lane: RecurringLane | null): { laneLabel: string; basis: string; suggestedRange: string } | null {
  if (!lane) return null;
  const laneLabel = `${lane.origin}${lane.originState ? ", " + lane.originState : ""} → ${lane.destination}${lane.destinationState ? ", " + lane.destinationState : ""}`;
  // Heuristic only — the team can wire actual rate engine later. Use atStakeAmount as anchor when present.
  const atStake = card?.atStakeAmount ? Number(card.atStakeAmount) : null;
  const weekly = lane.avgLoadsPerWeek ? Number(lane.avgLoadsPerWeek) : null;
  let basis = "Quote against current lane history";
  let suggestedRange = "Pull current rate-con + last-quoted spot";
  if (atStake && weekly && weekly > 0) {
    const perLoad = atStake / Math.max(weekly * 4, 1);
    if (perLoad > 50 && perLoad < 5000) {
      const lo = Math.round(perLoad * 0.95 / 25) * 25;
      const hi = Math.round(perLoad * 1.05 / 25) * 25;
      suggestedRange = `≈ $${lo.toLocaleString()}–$${hi.toLocaleString()} / load`;
      basis = `Derived from at-stake $${Math.round(atStake).toLocaleString()} ÷ ~${weekly}/wk (4 weeks)`;
    }
  }
  return { laneLabel, basis, suggestedRange };
}

export function registerNbaReadyToActRoutes(app: Express): void {
  app.get("/api/nba/cards/:id/ready-to-act", async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const card = await storage.getNbaCard(String(req.params.id));
      if (!card) return res.status(404).json({ error: "Card not found" });
      if (card.orgId !== user.organizationId) return res.status(403).json({ error: "Not your org" });

      const overrideContactId = typeof req.query.contactId === "string" && req.query.contactId ? req.query.contactId : undefined;
      const tone = typeof req.query.tone === "string" && TONE_INSTRUCTIONS[req.query.tone] !== undefined ? req.query.tone : "default";
      const regenerate = req.query.regenerate === "1" || req.query.regenerate === "true";

      const cacheKey = makeCacheKey(card.id, overrideContactId, tone);
      const now = Date.now();
      if (!regenerate) {
        const hit = cache.get(card.id);
        if (hit && hit.cacheKey === cacheKey && hit.expiresAt > now) {
          return res.json(hit.payload);
        }
      }

      const spec = getReadyToActSpec(card.ruleType);
      if (!card.companyId) return res.status(400).json({ error: "Card has no linked company" });
      if (spec.shape === "lane_capacity") {
        const payload = { shape: "lane_capacity", message: "Use the carrier outreach panel for lane-capacity cards." };
        return res.json(payload);
      }

      // Resolve recommended contact
      const { contact, reason } = await pickRecommendedContact(
        card.companyId,
        card.primaryContactId,
        overrideContactId ?? card.contactId,
      );

      // Talking points + data anchors in parallel
      const contactIdsForTalking = contact ? [contact.id] : (await storage.getContactsByCompany(card.companyId)).slice(0, 5).map(c => c.id);
      const [talkingPoints, voiceProfile, dataResult, lane] = await Promise.all([
        gatherTalkingPoints(user.organizationId, card.companyId, contactIdsForTalking),
        getVoiceProfile(user.id, user.username, user.organizationId),
        gatherDataAnchors(user.organizationId, card.companyId, contact?.id),
        card.primaryLaneId ? storage.getRecurringLane(card.primaryLaneId).catch(() => null) : Promise.resolve(null),
      ]);

      const toneNote = TONE_INSTRUCTIONS[tone] ?? "";
      const additionalContext = [
        `Why this NBA card fired: ${card.whyThisNow}`,
        `Suggested action from the rule engine: ${card.suggestedAction}`,
        toneNote,
      ].filter(Boolean).join(" — ");

      let draftBody = "";
      let callPoints: string[] = [];
      if (spec.shape === "email") {
        draftBody = await generateDraft({
          voiceProfile,
          playType: spec.draftPlayType,
          dataContext: dataResult.context,
          additionalContext,
          contactName: contact?.name?.split(" ")[0],
        });
      } else {
        const text = await generateSmsOrCallDraft({
          shape: spec.shape,
          playLabel: PLAY_TYPES[spec.draftPlayType]?.label ?? spec.draftLabel,
          whyThisNow: card.whyThisNow,
          suggestedAction: card.suggestedAction,
          dataContext: dataResult.context,
          contactName: contact?.name?.split(" ")[0],
          toneNote,
        });
        if (spec.shape === "call") {
          callPoints = text.split(/\n+/).map(l => l.replace(/^\s*\d[\.\)]\s*/, "").trim()).filter(Boolean).slice(0, 5);
          draftBody = callPoints.join("\n");
        } else {
          draftBody = text;
        }
      }

      const quoteHint = spec.includeQuoteHint ? buildQuoteHint(card, lane ?? null) : null;

      const payload = {
        shape: spec.shape,
        draftLabel: spec.draftLabel,
        playLabel: PLAY_TYPES[spec.draftPlayType]?.label ?? spec.draftLabel,
        defaultTouchType: spec.defaultTouchType,
        recommendedContact: contact ? {
          id: contact.id,
          name: contact.name,
          title: contact.title ?? null,
          email: contact.email ?? null,
          phone: contact.phone ?? null,
          relationshipBase: contact.relationshipBase ?? null,
          reason,
        } : null,
        talkingPoints,
        draft: draftBody,
        callPoints,
        dataAnchors: dataResult.anchors,
        voiceProfileAvailable: !!voiceProfile,
        voiceProfileSampleCount: voiceProfile?.sampleCount ?? 0,
        quoteHint,
        tone,
        generatedAt: new Date().toISOString(),
      };

      cache.set(card.id, { cacheKey, expiresAt: now + CACHE_TTL_MS, payload });
      res.json(payload);
    } catch (err) {
      console.error("[nba/ready-to-act GET]", err instanceof Error ? err.stack : err);
      res.status(500).json({ error: "Failed to build ready-to-act payload" });
    }
  });
}
