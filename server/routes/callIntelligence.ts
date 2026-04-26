import type { Express, Request, Response } from "express";
import { pStr, qStr, qOptStr } from "../lib/req";
import { requireAuth, getCurrentUser, canAccessCompany } from "../auth";
import { storage } from "../storage";
import { analyzeTouchpointNote } from "../aiTouchpoint";
import { computeGrowthScore } from "../growthScoreCalculator";
import { checkAndFireMomentumDropNotification } from "../momentumNotifications";
import { getPlayForRuleType, getPlayByLabel, getAllPlayLabels, PLAYS_REGISTRY } from "../playsRegistry";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

let _playbook: any = null;
function getPlaybook() {
  if (!_playbook) {
    try {
      _playbook = require("../../content/playbooks/am-playbook.json");
    } catch { _playbook = {}; }
  }
  return _playbook;
}

export function registerCallIntelligenceRoutes(app: Express) {

  app.post("/api/call-prep/:companyId", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const companyId = pStr(req.params.companyId);
      if (!(await canAccessCompany(user, companyId)))
        return res.status(403).json({ error: "Access denied" });

      const company = await storage.getCompanyInOrg(companyId, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const { contactId, nbaCardId } = req.body || {};

      const [contacts, touchpoints, tasks, rfps, nbaCards] = await Promise.all([
        storage.getContactsByCompany(companyId),
        storage.getTouchpointsByCompany(companyId),
        storage.getTasksByCompany(companyId),
        storage.getRfpsByCompanyId(companyId),
        storage.getVisibleNbaCards(user.id, 10),
      ]);

      const companyNbaCards = nbaCards.filter(c => c.companyId === companyId);

      const focusContact = contactId
        ? contacts.find(c => c.id === contactId) ?? null
        : null;

      const recentTouchpoints = [...touchpoints]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5);

      const openTasks = tasks.filter(t => t.status === "open");

      const activeRfps = rfps.filter(r => r.status === "open" || r.status === "pending");

      let nbaContext = "";
      if (nbaCardId) {
        const nba = companyNbaCards.find(c => c.id === nbaCardId);
        if (nba) {
          nbaContext = `\nContext from NBA card: ${nba.whyThisNow}\nSuggested action: ${nba.suggestedAction}\nPlay: ${nba.playLabel || "General"}`;
        }
      }

      const playbook = getPlaybook();
      const relationshipStages = playbook?.sections?.relationshipStages || [];

      const contactSummaries = contacts.slice(0, 6).map(c => {
        const lastTp = touchpoints
          .filter(t => t.contactId === c.id)
          .sort((a, b) => b.date.localeCompare(a.date))[0];
        const daysSince = lastTp
          ? Math.floor((Date.now() - new Date(lastTp.date + "T12:00:00Z").getTime()) / 86400000)
          : null;
        return {
          name: c.name,
          title: c.title || null,
          relationship: c.relationshipBase || null,
          lanes: c.lanes || [],
          regions: c.regions || [],
          lastTouch: lastTp ? { type: lastTp.type, date: lastTp.date, daysAgo: daysSince } : null,
        };
      });

      let talkingPoints: string[] = [];
      try {
        const contactContext = contactSummaries.map(c =>
          `${c.name}${c.title ? ` (${c.title})` : ""} — Relationship: ${c.relationship || "Unknown"}${c.lastTouch ? `, last ${c.lastTouch.type} ${c.lastTouch.daysAgo}d ago` : ", no recent touch"}`
        ).join("\n");

        const taskContext = openTasks.length > 0
          ? `Open tasks: ${openTasks.slice(0, 5).map(t => `"${t.title}"${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("; ")}`
          : "No open tasks";

        const rfpContext = activeRfps.length > 0
          ? `Active RFPs: ${activeRfps.slice(0, 3).map(r => `"${r.title}" due ${r.dueDate || "TBD"}`).join("; ")}`
          : "";

        const recentNotes = recentTouchpoints
          .filter(t => t.notes)
          .slice(0, 3)
          .map(t => `[${t.date}] ${t.notes!.slice(0, 200)}`)
          .join("\n");

        const stageAdvice = focusContact?.relationshipBase
          ? relationshipStages.find((s: any) => s.stage?.toLowerCase().includes(focusContact.relationshipBase!.toLowerCase().split(" ")[0]))
          : null;

        const nbaCardContext = companyNbaCards.length > 0
          ? `Active NBA recommendations: ${companyNbaCards.map(c => `${c.playLabel || c.ruleType}: "${c.suggestedAction}"`).join("; ")}`
          : "";

        const prompt = `You are a freight brokerage account management coach. Generate exactly 3 focused talking points with questions for an upcoming call with ${company.name}.

Company: ${company.name}${company.industry ? ` (${company.industry})` : ""}
Contacts:
${contactContext}
${focusContact ? `Focus contact for this call: ${focusContact.name}${focusContact.title ? ` — ${focusContact.title}` : ""}` : ""}

Recent touchpoint notes:
${recentNotes || "None available"}

${taskContext}
${rfpContext}
${nbaCardContext}
${nbaContext}

${stageAdvice ? `Playbook guidance for ${focusContact?.relationshipBase || "current"} stage:\nActions: ${(stageAdvice.actions || []).slice(0, 3).join("; ")}` : ""}

Instructions:
- Each talking point should be 1-2 sentences plus a specific question to ask
- Align with the account's current relationship stage and open loops
- Reference specific data (touchpoint gaps, open tasks, RFP deadlines) when available
- If there's an NBA recommendation, incorporate it naturally
- Focus on advancing the relationship and uncovering growth opportunities

Return ONLY a JSON array of 3 strings, no markdown:
["point 1...", "point 2...", "point 3..."]`;

        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 500,
          temperature: 0.4,
        });
        const raw = resp.choices[0]?.message?.content?.trim() || "[]";
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          talkingPoints = JSON.parse(jsonMatch[0]).filter((p: any) => typeof p === "string").slice(0, 3);
        }
      } catch (err) {
        console.error("[call-prep] AI talking points error:", err);
      }

      res.json({
        company: {
          id: company.id,
          name: company.name,
          industry: company.industry,
          estimatedFreightSpend: company.estimatedFreightSpend,
        },
        contacts: contactSummaries,
        focusContact: focusContact ? {
          id: focusContact.id,
          name: focusContact.name,
          title: focusContact.title,
          relationship: focusContact.relationshipBase,
          lanes: focusContact.lanes,
          regions: focusContact.regions,
        } : null,
        recentTouchpoints: recentTouchpoints.map(t => ({
          id: t.id,
          contactId: t.contactId,
          type: t.type,
          date: t.date,
          notes: t.notes,
          sentiment: t.sentiment,
        })),
        openTasks: openTasks.slice(0, 10).map(t => ({
          id: t.id,
          title: t.title,
          dueDate: t.dueDate,
          status: t.status,
        })),
        activeRfps: activeRfps.slice(0, 5).map(r => ({
          id: r.id,
          title: r.title,
          dueDate: r.dueDate,
          status: r.status,
        })),
        nbaCards: companyNbaCards.map(c => ({
          id: c.id,
          ruleType: c.ruleType,
          playLabel: c.playLabel,
          suggestedAction: c.suggestedAction,
          whyThisNow: c.whyThisNow,
        })),
        talkingPoints,
      });
    } catch (err) {
      console.error("[call-prep] error:", err);
      res.status(500).json({ error: "Failed to generate call prep" });
    }
  });

  app.post("/api/post-call-capture", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const { companyId, contactId, notes, touchType } = req.body;
      if (!companyId) return res.status(400).json({ error: "companyId is required" });
      if (!notes || typeof notes !== "string" || notes.trim().length < 5)
        return res.status(400).json({ error: "Notes must be at least 5 characters" });

      if (!(await canAccessCompany(user, companyId)))
        return res.status(403).json({ error: "Access denied" });

      const company = await storage.getCompanyInOrg(companyId, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const validTouchTypes = ["call", "email", "text", "site_visit"];
      if (touchType && !validTouchTypes.includes(touchType))
        return res.status(400).json({ error: "Invalid touchType" });

      let contact = null;
      if (contactId) {
        contact = await storage.getContact(contactId);
        if (!contact || contact.companyId !== companyId)
          return res.status(400).json({ error: "Contact does not belong to this company" });
      }

      const playLabels = getAllPlayLabels();

      const prompt = `You are a freight brokerage CRM assistant. Analyze these post-call notes and generate a structured summary.

Company: ${company.name}
Contact: ${contact ? `${contact.name}${contact.title ? ` (${contact.title})` : ""}` : "Unknown"}
Notes: "${notes.trim()}"

Available play labels (match the closest one if applicable): ${playLabels.join(", ")}

Respond with valid JSON only (no markdown):
{
  "summary": "2-3 sentence structured summary of what was discussed and key outcomes",
  "followUps": [
    {"title": "short task title", "dueDays": number_of_days_from_now, "priority": "high"|"medium"|"low"}
  ],
  "playExecuted": "exact play label from the list above, or null if none clearly applies",
  "suggestedNextTouch": {
    "type": "call"|"email"|"text"|"site_visit",
    "timing": "specific timing suggestion (e.g., 'in 3 days', 'next Tuesday')",
    "dueDays": number_of_days_until_next_touch,
    "reason": "why this timing and type"
  },
  "sentiment": "positive"|"neutral"|"negative",
  "keyIntel": "one-sentence strategic intelligence extracted, or null"
}`;

      let aiResult: any = null;
      try {
        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 600,
          temperature: 0.2,
        });
        const raw = resp.choices[0]?.message?.content?.trim() || "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          aiResult = JSON.parse(jsonMatch[0]);
        }
      } catch (aiErr) {
        console.error("[post-call-capture] AI error:", aiErr);
      }

      const now = new Date();
      const playLabel = aiResult?.playExecuted
        ? (getPlayByLabel(aiResult.playExecuted) ? aiResult.playExecuted : null)
        : null;

      const tp = await storage.createTouchpoint({
        contactId: contactId || null,
        companyId,
        type: touchType || "call",
        date: now.toISOString().split("T")[0],
        notes: notes.trim().slice(0, 2000),
        sentiment: aiResult?.sentiment || null,
        isMeaningful: true,
        loggedById: user.id,
        playLabel,
        createdAt: now.toISOString(),
      });

      const createdTasks: any[] = [];
      if (aiResult?.followUps && Array.isArray(aiResult.followUps)) {
        for (const fu of aiResult.followUps.slice(0, 5)) {
          if (!fu.title) continue;
          try {
            const due = new Date(now);
            due.setDate(due.getDate() + (fu.dueDays || 7));
            const task = await storage.createTask({
              title: fu.title,
              notes: `Auto-created from post-call capture: "${notes.slice(0, 150)}..."`,
              status: "open",
              dueDate: due.toISOString().split("T")[0],
              assignedTo: user.id,
              assignedBy: user.id,
              companyId,
              contactId: contactId || null,
              createdAt: now.toISOString(),
            });
            createdTasks.push(task);
          } catch (taskErr) {
            console.error("[post-call-capture] task creation error:", taskErr);
          }
        }
      }

      try {
        const gs = await computeGrowthScore(companyId, user.organizationId, storage);
        const savedGs = await storage.upsertGrowthScore({
          companyId,
          organizationId: user.organizationId,
          score: gs.score,
          band: gs.band,
          drivers: gs.drivers,
          calculatedAt: new Date().toISOString(),
        });
        checkAndFireMomentumDropNotification(companyId, gs.band, savedGs.previousBand, storage).catch(() => {});
      } catch (gsErr) {
        console.error("[post-call-capture] growth score error:", gsErr);
      }

      res.json({
        touchpoint: tp,
        aiSummary: aiResult?.summary || null,
        followUpTasks: createdTasks,
        playExecuted: playLabel,
        suggestedNextTouch: aiResult?.suggestedNextTouch || null,
        keyIntel: aiResult?.keyIntel || null,
        sentiment: aiResult?.sentiment || null,
      });
    } catch (err) {
      console.error("[post-call-capture] error:", err);
      res.status(500).json({ error: "Failed to process post-call capture" });
    }
  });
}
