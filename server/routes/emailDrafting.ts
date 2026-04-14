import type { Express } from "express";
import { z } from "zod";
import { getCurrentUser } from "../auth";
import { storage, db } from "../storage";
import { getVoiceProfile, refreshVoiceProfile } from "../voiceProfileService";
import { eq, and, desc, gte, inArray } from "drizzle-orm";
import {
  companies, contacts, touchpoints, emailMessages,
} from "@shared/schema";

const PLAY_TYPES: Record<string, { label: string; intent: string }> = {
  "check_in": { label: "Relationship Check-In", intent: "Maintain the relationship with a casual, helpful touchpoint" },
  "stale_reactivation": { label: "Stale Account Reactivation", intent: "Re-engage a contact who hasn't been touched in 30+ days" },
  "lane_expansion": { label: "Lane Expansion", intent: "Pitch a new lane or corridor based on freight data" },
  "spot_to_contract": { label: "Spot → Contract Conversion", intent: "Propose converting recurring spot freight to a contracted rate" },
  "service_recovery": { label: "Service Recovery", intent: "Acknowledge a service issue and rebuild trust" },
  "referral_ask": { label: "Referral Ask", intent: "Request a warm introduction to another contact or company" },
  "competitive_displacement": { label: "Competitive Displacement", intent: "Position for a lane where the incumbent is underperforming" },
  "qbr_followup": { label: "QBR Follow-Up", intent: "Recap a business review and outline next steps" },
  "carrier_capacity": { label: "Carrier Capacity Outreach", intent: "Check carrier capacity for a specific lane or corridor" },
  "carrier_rate_discussion": { label: "Carrier Rate Discussion", intent: "Discuss rate positioning or negotiate carrier pricing" },
  "general": { label: "General Outreach", intent: "General-purpose professional email" },
};

const draftRequestSchema = z.object({
  accountId: z.string().optional(),
  contactId: z.string().optional(),
  playType: z.string().default("general"),
  threadId: z.string().optional(),
  additionalContext: z.string().max(500).optional(),
});

interface DataAnchor {
  type: string;
  label: string;
  value: string;
}

async function gatherDataAnchors(
  orgId: string,
  accountId?: string,
  contactId?: string,
): Promise<{ context: string; anchors: DataAnchor[] }> {
  const anchors: DataAnchor[] = [];
  const parts: string[] = [];

  if (accountId) {
    const company = await storage.getCompanyInOrg(accountId, orgId);
    if (company) {
      parts.push(`Account: ${company.name}`);
      anchors.push({ type: "account", label: "Account", value: company.name });

      if (company.industry) {
        anchors.push({ type: "industry", label: "Industry", value: company.industry });
      }

      const companyContacts = await storage.getContactsByCompany(accountId);

      if (companyContacts.length > 0) {
        parts.push(`Contacts at account: ${companyContacts.slice(0, 20).map(c => `${c.name}${c.title ? ` (${c.title})` : ""}`).join(", ")}`);
      }

      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      const contactIds = companyContacts.map(c => c.id);
      let recentTouchpoints: any[] = [];
      if (contactIds.length > 0) {
        recentTouchpoints = await db.select().from(touchpoints)
          .where(and(
            inArray(touchpoints.contactId, contactIds),
            gte(touchpoints.date, thirtyDaysAgo)
          ))
          .orderBy(desc(touchpoints.date))
          .limit(10);
      }

      if (recentTouchpoints.length > 0) {
        const lastTouch = recentTouchpoints[0];
        const daysAgo = Math.floor((Date.now() - new Date(lastTouch.date).getTime()) / 86400000);
        anchors.push({ type: "last_touch", label: "Last Touch", value: `${daysAgo} days ago (${lastTouch.type})` });

        const topics = recentTouchpoints
          .filter((tp: any) => tp.notes)
          .slice(0, 3)
          .map((tp: any) => (tp.notes as string).slice(0, 100));
        if (topics.length > 0) {
          parts.push(`Recent touchpoint topics: ${topics.join("; ")}`);
          anchors.push({ type: "recent_topics", label: "Recent Topics", value: topics.join("; ") });
        }
      } else {
        anchors.push({ type: "last_touch", label: "Last Touch", value: "No recent touches (30+ days)" });
      }

      const uploads = await storage.getFinancialUploadsForOrg(orgId);
      if (uploads.length > 0) {
        try {
          const latestUpload = uploads[0];
          const rows = (latestUpload.rows as any[]) || [];
          const companyNames = [company.name.toLowerCase()];
          if (company.financialAlias) companyNames.push(company.financialAlias.toLowerCase());

          let loadCount = 0;
          let totalRevenue = 0;
          const lanes = new Map<string, number>();

          for (const row of rows) {
            const customer = String(row["Customer"] || row["customer"] || row["Customer Name"] || "").toLowerCase();
            if (!companyNames.some(cn => customer.includes(cn))) continue;

            loadCount++;
            const rev = Number(row["Revenue"] || row["Total Charges"] || row["revenue"] || row["totalCharges"] || 0);
            totalRevenue += rev;

            const origCity = String(row["Shipper City"] || row["Origin City"] || row["shipperCity"] || row["originCity"] || "").trim();
            const origState = String(row["Shipper State"] || row["Origin State"] || row["shipperState"] || row["originState"] || "").trim();
            const destCity = String(row["Consignee City"] || row["Destination City"] || row["consigneeCity"] || row["destinationCity"] || "").trim();
            const destState = String(row["Consignee State"] || row["Destination State"] || row["consigneeState"] || row["destinationState"] || "").trim();

            if (origCity && destCity) {
              const lane = `${origCity}, ${origState} → ${destCity}, ${destState}`;
              lanes.set(lane, (lanes.get(lane) || 0) + 1);
            }
          }

          if (loadCount > 0) {
            anchors.push({ type: "load_count", label: "Total Loads", value: `${loadCount}` });
            anchors.push({ type: "revenue", label: "Total Revenue", value: `$${Math.round(totalRevenue).toLocaleString()}` });
            parts.push(`Freight data: ${loadCount} loads, $${Math.round(totalRevenue).toLocaleString()} total revenue`);
          }

          const topLanes = [...lanes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          if (topLanes.length > 0) {
            const laneStr = topLanes.map(([l, c]) => `${l} (${c} loads)`).join("; ");
            anchors.push({ type: "top_lanes", label: "Top Lanes", value: laneStr });
            parts.push(`Top lanes: ${laneStr}`);
          }
        } catch (err) {
          console.error("[emailDrafting] freight data error:", err);
        }
      }
    }
  }

  if (contactId) {
    const contact = await storage.getContact(contactId);
    if (contact) {
      parts.push(`Contact: ${contact.name}${contact.title ? ` (${contact.title})` : ""}`);
      anchors.push({ type: "contact", label: "Contact", value: `${contact.name}${contact.title ? ` - ${contact.title}` : ""}` });

      if (contact.email) anchors.push({ type: "contact_email", label: "Contact Email", value: contact.email });
      if (contact.relationshipBase) {
        anchors.push({ type: "relationship", label: "Relationship Stage", value: contact.relationshipBase });
        parts.push(`Relationship stage: ${contact.relationshipBase}`);
      }
      if (contact.regions && contact.regions.length > 0) {
        anchors.push({ type: "regions", label: "Contact Regions", value: contact.regions.join(", ") });
      }
      if (contact.lanes && contact.lanes.length > 0) {
        anchors.push({ type: "contact_lanes", label: "Contact Lanes", value: contact.lanes.join(", ") });
        parts.push(`Contact's lanes: ${contact.lanes.join(", ")}`);
      }
    }
  }

  return { context: parts.join("\n"), anchors };
}

async function generateDraft(params: {
  voiceProfile: Awaited<ReturnType<typeof getVoiceProfile>>;
  playType: string;
  dataContext: string;
  additionalContext?: string;
  contactName?: string;
}): Promise<string> {
  const { voiceProfile, playType, dataContext, additionalContext, contactName } = params;
  const play = PLAY_TYPES[playType] || PLAY_TYPES.general;

  const voiceInstructions = voiceProfile
    ? `VOICE PROFILE (mimic this rep's writing style):
- Average sentence length: ~${voiceProfile.avgSentenceLength} words
- Typical greetings: ${voiceProfile.greetingPatterns.join(", ")}
- Typical sign-offs: ${voiceProfile.signOffPatterns.join(", ")}
- Tone: ${voiceProfile.toneDescriptors.join(", ")}
- Common phrases they use: ${voiceProfile.commonPhrases.length > 0 ? voiceProfile.commonPhrases.join("; ") : "none identified"}
- Based on ${voiceProfile.sampleCount} recent emails`
    : `VOICE PROFILE: No email history available. Use a professional, friendly, and direct tone.`;

  const systemPrompt = `You are an AI assistant for a freight brokerage CRM. Your job is to draft a short, personalized email (2-4 sentences) that sounds like the rep wrote it.

${voiceInstructions}

STRATEGIC INTENT: "${play.label}" — ${play.intent}

RULES:
1. Keep it to 2-4 sentences max. Freight brokers are brief.
2. Reference specific data points from the context (lane names, load counts, dates, etc.)
3. Match the rep's greeting and sign-off style
4. Match the rep's sentence length and tone
5. Do NOT include a subject line — just the email body
6. Do NOT include the rep's name/signature — just the message content
7. Sound natural and human — not like a template
8. If the contact's name is known, use their first name in the greeting`;

  const userPrompt = `Draft a "${play.label}" email.

CONTEXT DATA:
${dataContext || "No specific data available"}

${contactName ? `Recipient name: ${contactName}` : ""}
${additionalContext ? `Additional context from the rep: ${additionalContext}` : ""}

Write the email body now (2-4 sentences, matching the voice profile):`;

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
      max_tokens: 300,
    });

    return completion.choices[0]?.message?.content?.trim() || "Unable to generate draft. Please try again.";
  } catch (err) {
    console.error("[emailDrafting] OpenAI error:", err);
    return "Unable to generate draft due to an AI service error. Please try again.";
  }
}

export function registerEmailDraftingRoutes(app: Express): void {

  app.post("/api/email-drafts/generate", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const parsed = draftRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { accountId, contactId, playType, threadId, additionalContext } = parsed.data;
      const orgId = user.organizationId;

      if (accountId) {
        const company = await storage.getCompanyInOrg(accountId, orgId);
        if (!company) return res.status(404).json({ error: "Account not found in your organization" });
      }

      if (contactId) {
        const contact = await storage.getContact(contactId);
        if (!contact) return res.status(404).json({ error: "Contact not found" });
        if (accountId && contact.companyId !== accountId) {
          return res.status(403).json({ error: "Contact does not belong to the specified account" });
        }
      }

      const play = PLAY_TYPES[playType] || PLAY_TYPES.general;

      const [voiceProfile, dataResult] = await Promise.all([
        getVoiceProfile(user.id, user.username, orgId),
        gatherDataAnchors(orgId, accountId, contactId),
      ]);

      let contactName: string | undefined;
      if (contactId) {
        const contact = await storage.getContact(contactId);
        if (contact) contactName = contact.name.split(" ")[0];
      }

      let threadContext = "";
      if (threadId) {
        const threadEmails = await db.select({
          body: emailMessages.body,
          subject: emailMessages.subject,
          direction: emailMessages.direction,
          fromEmail: emailMessages.fromEmail,
        })
          .from(emailMessages)
          .where(and(
            eq(emailMessages.orgId, orgId),
            eq(emailMessages.threadId, threadId),
          ))
          .orderBy(desc(emailMessages.createdAt))
          .limit(5);

        if (threadEmails.length > 0) {
          threadContext = "\nCONVERSATION HISTORY:\n" + threadEmails.map(e => {
            const dir = e.direction === "outbound" ? "SENT" : "RECEIVED";
            const body = (e.body || "").replace(/<[^>]+>/g, " ").trim().slice(0, 200);
            return `[${dir}] ${e.subject || "(no subject)"}\n${body}`;
          }).join("\n---\n");
        }
      }

      let tacticsContext = "";
      let suggestedTactics: { label: string; summary: string; successRate: number; outcome: string }[] = [];
      try {
        const { getProvenTacticsForSignal } = await import("../services/tacticalLearningService");
        const signalMap: Record<string, string> = {
          check_in: "positive_feedback",
          stale_reactivation: "stalled_thread",
          lane_expansion: "new_opportunity",
          service_recovery: "service_complaint",
          competitive_displacement: "objection",
          carrier_rate_discussion: "pricing_request",
        };
        const mappedSignal = signalMap[playType];
        if (mappedSignal) {
          const tactics = await getProvenTacticsForSignal(orgId, mappedSignal, 3);
          if (tactics.length > 0) {
            suggestedTactics = tactics.map(t => ({
              label: t.tacticLabel,
              summary: t.tacticSummary,
              successRate: t.successRate ?? 0,
              outcome: t.outcome,
            }));
            tacticsContext = "\n\nPROVEN TACTICS (approaches that have worked before for this type of situation):\n" +
              tactics.map((t, i) => `${i + 1}. "${t.tacticLabel}" — ${t.tacticSummary} (success rate: ${t.successRate ?? 0}%)`).join("\n");
          }
        }
      } catch (tacticsErr) {
        console.warn("[emailDrafting] Failed to load proven tactics for draft context:", tacticsErr);
      }

      const fullContext = dataResult.context + threadContext + tacticsContext;

      const draft = await generateDraft({
        voiceProfile,
        playType,
        dataContext: fullContext,
        additionalContext,
        contactName,
      });

      res.json({
        draft,
        playLabel: play.label,
        playType,
        dataAnchors: dataResult.anchors,
        voiceProfileAvailable: !!voiceProfile,
        voiceProfileSampleCount: voiceProfile?.sampleCount ?? 0,
        suggestedTactics,
      });
    } catch (err) {
      console.error("[emailDrafting] generate error:", err);
      res.status(500).json({ error: "Failed to generate email draft" });
    }
  });

  app.get("/api/voice-profiles/me", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const profile = await getVoiceProfile(user.id, user.username, user.organizationId);
      res.json({ profile });
    } catch (err) {
      console.error("[voiceProfile] get error:", err);
      res.status(500).json({ error: "Failed to get voice profile" });
    }
  });

  app.post("/api/voice-profiles/refresh", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const profile = await refreshVoiceProfile(user.id, user.username, user.organizationId);
      res.json({ profile, refreshed: true });
    } catch (err) {
      console.error("[voiceProfile] refresh error:", err);
      res.status(500).json({ error: "Failed to refresh voice profile" });
    }
  });

  app.get("/api/email-drafts/play-types", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const plays = Object.entries(PLAY_TYPES).map(([key, val]) => ({
      value: key,
      label: val.label,
      intent: val.intent,
    }));
    res.json(plays);
  });
}
