import type { Express } from "express";
import { z } from "zod";
import { getCurrentUser } from "../auth";
import { storage, db } from "../storage";
import { getVoiceProfile, refreshVoiceProfile } from "../voiceProfileService";
import { eq, and, desc, gte, inArray, sql } from "drizzle-orm";
import {
  companies, contacts, touchpoints, emailMessages, draftFeedback, sentEmailCorrections,
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
  "thread_reply": { label: "Thread Reply", intent: "Continue the conversation naturally — read the thread, understand what was said, and craft a relevant freight-related response" },
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

async function gatherFeedbackContext(orgId: string, playType: string): Promise<string> {
  try {
    const recent = await db.select({
      rating: draftFeedback.rating,
      notes: draftFeedback.notes,
      draftText: draftFeedback.draftText,
      editedText: draftFeedback.editedText,
      playType: draftFeedback.playType,
    })
      .from(draftFeedback)
      .where(and(
        eq(draftFeedback.orgId, orgId),
        inArray(draftFeedback.rating, ["good", "bad", "needs_work"]),
      ))
      .orderBy(desc(draftFeedback.createdAt))
      .limit(10);

    const lines: string[] = [];
    const good = recent.filter(f => f.rating === "good");
    const bad = recent.filter(f => f.rating === "bad");
    const needsWork = recent.filter(f => f.rating === "needs_work");

    if (good.length > 0) {
      lines.push("EXAMPLES THE USER LIKED:");
      for (const f of good.slice(0, 3)) {
        lines.push(`- "${(f.editedText || f.draftText).slice(0, 200)}"`);
        if (f.notes) lines.push(`  (Why they liked it: ${f.notes})`);
      }
    }

    if (bad.length > 0) {
      lines.push("THINGS TO AVOID (user disliked these):");
      for (const f of bad.slice(0, 3)) {
        lines.push(`- "${f.draftText.slice(0, 200)}"`);
        if (f.notes) lines.push(`  (Issue: ${f.notes})`);
      }
    }

    if (needsWork.length > 0) {
      lines.push("DIRECTION FROM USER FEEDBACK:");
      for (const f of needsWork.slice(0, 3)) {
        if (f.notes) lines.push(`- ${f.notes}`);
        if (f.editedText && f.editedText !== f.draftText) {
          lines.push(`  Preferred version: "${f.editedText.slice(0, 200)}"`);
        }
      }
    }

    const corrections = await db.select({
      originalText: sentEmailCorrections.originalText,
      correctedText: sentEmailCorrections.correctedText,
      correctionNotes: sentEmailCorrections.correctionNotes,
      subject: sentEmailCorrections.subject,
    })
      .from(sentEmailCorrections)
      .where(eq(sentEmailCorrections.orgId, orgId))
      .orderBy(desc(sentEmailCorrections.createdAt))
      .limit(5);

    if (corrections.length > 0) {
      lines.push("REAL EMAIL CORRECTIONS (leadership reviewed sent emails and wrote what SHOULD have been said — learn from these heavily):");
      for (const c of corrections) {
        if (c.subject) lines.push(`  Subject: ${c.subject}`);
        lines.push(`  Original (what was sent): "${c.originalText.slice(0, 300)}"`);
        lines.push(`  Corrected (what should have been said): "${c.correctedText.slice(0, 300)}"`);
        if (c.correctionNotes) lines.push(`  Coach notes: ${c.correctionNotes}`);
        lines.push("");
      }
    }

    return lines.length > 0 ? "\n\nUSER TRAINING FEEDBACK (learn from this):\n" + lines.join("\n") : "";
  } catch (err) {
    console.warn("[emailDrafting] Failed to load feedback context:", err);
    return "";
  }
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

  const isThreadReply = playType === "thread_reply";

  const systemPrompt = isThreadReply
    ? `You are an AI assistant for a freight brokerage CRM. Your job is to draft a reply to an ongoing email thread. Read the conversation history carefully, understand what the other party said or asked, and craft a relevant freight-related response.

${voiceInstructions}

RULES:
1. Keep it to 2-4 sentences max. Freight brokers are brief.
2. Directly address what the other person said or asked — don't ignore their points
3. Reference specific freight details from the thread (lanes, rates, loads, service issues, etc.)
4. Match the rep's greeting and sign-off style
5. Match the rep's sentence length and tone
6. Do NOT include a subject line — just the email body
7. Do NOT include the rep's name/signature — just the message content
8. Sound natural and human — like a real reply, not a template
9. If the last message raised a concern, address it. If they asked a question, answer it. If they shared good news, acknowledge it.
10. If the contact's name is known, use their first name`
    : `You are an AI assistant for a freight brokerage CRM. Your job is to draft a short, personalized email (2-4 sentences) that sounds like the rep wrote it.

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

  const userPrompt = isThreadReply
    ? `Draft a reply to this ongoing conversation thread.

${dataContext || "No specific data available"}

${contactName ? `Recipient name: ${contactName}` : ""}
${additionalContext ? `Additional direction from the rep: ${additionalContext}` : ""}

Write a natural reply (2-4 sentences) that directly responds to what was said:`
    : `Draft a "${play.label}" email.

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

      const feedbackContext = await gatherFeedbackContext(orgId, playType);
      const fullContext = dataResult.context + threadContext + tacticsContext + feedbackContext;

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

    const plays = Object.entries(PLAY_TYPES)
      .filter(([key]) => key !== "thread_reply")
      .map(([key, val]) => ({
        value: key,
        label: val.label,
        intent: val.intent,
      }));
    res.json(plays);
  });

  app.post("/api/email-drafts/feedback", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({
        rating: z.enum(["good", "bad", "needs_work"]),
        notes: z.string().max(1000).optional(),
        draftText: z.string(),
        editedText: z.string().optional(),
        playType: z.string(),
        playLabel: z.string().optional(),
        threadId: z.string().optional(),
        accountId: z.string().optional(),
        accountName: z.string().optional(),
        contactId: z.string().optional(),
        contactName: z.string().optional(),
        voiceProfileUsed: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      const [inserted] = await db.insert(draftFeedback)
        .values({
          orgId: user.organizationId,
          userId: user.id,
          userName: user.name,
          rating: parsed.data.rating,
          notes: parsed.data.notes ?? null,
          draftText: parsed.data.draftText,
          editedText: parsed.data.editedText ?? null,
          playType: parsed.data.playType,
          playLabel: parsed.data.playLabel ?? null,
          threadId: parsed.data.threadId ?? null,
          accountId: parsed.data.accountId ?? null,
          accountName: parsed.data.accountName ?? null,
          contactId: parsed.data.contactId ?? null,
          contactName: parsed.data.contactName ?? null,
          voiceProfileUsed: parsed.data.voiceProfileUsed ?? false,
        })
        .returning();

      console.log(`[draft-feedback] ${user.name} rated draft as "${parsed.data.rating}" (play: ${parsed.data.playType})`);
      res.json({ feedback: inserted });
    } catch (err) {
      console.error("[draft-feedback] create error:", err);
      res.status(500).json({ error: "Failed to save feedback" });
    }
  });

  app.get("/api/email-drafts/feedback", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { rating, limit: limitStr } = req.query;
      const conditions = [eq(draftFeedback.orgId, user.organizationId)];
      if (rating && typeof rating === "string") {
        conditions.push(eq(draftFeedback.rating, rating));
      }

      const rows = await db.select()
        .from(draftFeedback)
        .where(and(...conditions))
        .orderBy(desc(draftFeedback.createdAt))
        .limit(Number(limitStr) || 50);

      res.json({ feedback: rows });
    } catch (err) {
      console.error("[draft-feedback] list error:", err);
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.post("/api/email-corrections", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      if (!["admin", "sales_director", "director", "logistics_manager"].includes(user.role)) {
        return res.status(403).json({ error: "Only admins, directors, and logistics managers can submit corrections" });
      }

      const schema = z.object({
        emailMessageId: z.string().optional(),
        outreachLogId: z.string().optional(),
        originalText: z.string().min(1),
        correctedText: z.string().min(1),
        correctionNotes: z.string().max(1000).optional(),
        threadId: z.string().optional(),
        accountId: z.string().optional(),
        carrierId: z.string().optional(),
        subject: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      const [inserted] = await db.insert(sentEmailCorrections)
        .values({
          orgId: user.organizationId,
          correctedByUserId: user.id,
          correctedByName: user.name,
          emailMessageId: parsed.data.emailMessageId ?? null,
          outreachLogId: parsed.data.outreachLogId ?? null,
          originalText: parsed.data.originalText,
          correctedText: parsed.data.correctedText,
          correctionNotes: parsed.data.correctionNotes ?? null,
          threadId: parsed.data.threadId ?? null,
          accountId: parsed.data.accountId ?? null,
          carrierId: parsed.data.carrierId ?? null,
          subject: parsed.data.subject ?? null,
        })
        .returning();

      console.log(`[email-corrections] ${user.name} submitted correction for message ${parsed.data.emailMessageId || parsed.data.outreachLogId || "manual"}`);
      res.json({ correction: inserted });
    } catch (err) {
      console.error("[email-corrections] create error:", err);
      res.status(500).json({ error: "Failed to save correction" });
    }
  });

  app.get("/api/email-corrections", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const isLeadership = ["admin", "sales_director", "director", "logistics_manager"].includes(user.role);

      const { emailMessageId, threadId, hasOutreachLog, limit: limitStr } = req.query;
      const conditions = [eq(sentEmailCorrections.orgId, user.organizationId)];
      if (emailMessageId && typeof emailMessageId === "string") {
        conditions.push(eq(sentEmailCorrections.emailMessageId, emailMessageId));
      }
      if (threadId && typeof threadId === "string") {
        conditions.push(eq(sentEmailCorrections.threadId, threadId));
      }
      if (hasOutreachLog === "1") {
        conditions.push(sql`${sentEmailCorrections.outreachLogId} IS NOT NULL`);
      }

      if (isLeadership) {
        const rows = await db.select()
          .from(sentEmailCorrections)
          .where(and(...conditions))
          .orderBy(desc(sentEmailCorrections.createdAt))
          .limit(Number(limitStr) || 50);
        res.json({ corrections: rows });
      } else {
        const rows = await db.select({
          emailMessageId: sentEmailCorrections.emailMessageId,
          outreachLogId: sentEmailCorrections.outreachLogId,
        })
          .from(sentEmailCorrections)
          .where(and(...conditions))
          .orderBy(desc(sentEmailCorrections.createdAt))
          .limit(Number(limitStr) || 50);
        res.json({ corrections: rows });
      }
    } catch (err) {
      console.error("[email-corrections] list error:", err);
      res.status(500).json({ error: "Failed to fetch corrections" });
    }
  });

  app.get("/api/email-corrections/stats", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      if (!["admin", "sales_director", "director", "logistics_manager"].includes(user.role)) {
        return res.status(403).json({ error: "Only admins, directors, and logistics managers can view correction stats" });
      }

      const all = await db.select({ id: sentEmailCorrections.id })
        .from(sentEmailCorrections)
        .where(eq(sentEmailCorrections.orgId, user.organizationId));

      res.json({ total: all.length });
    } catch (err) {
      console.error("[email-corrections] stats error:", err);
      res.status(500).json({ error: "Failed to fetch correction stats" });
    }
  });

  app.get("/api/email-drafts/feedback/stats", async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const all = await db.select({
        rating: draftFeedback.rating,
        playType: draftFeedback.playType,
      })
        .from(draftFeedback)
        .where(eq(draftFeedback.orgId, user.organizationId));

      const total = all.length;
      const good = all.filter(f => f.rating === "good").length;
      const bad = all.filter(f => f.rating === "bad").length;
      const needsWork = all.filter(f => f.rating === "needs_work").length;
      const approvalRate = total > 0 ? Math.round((good / total) * 100) : 0;

      res.json({ total, good, bad, needsWork, approvalRate });
    } catch (err) {
      console.error("[draft-feedback] stats error:", err);
      res.status(500).json({ error: "Failed to fetch feedback stats" });
    }
  });
}
