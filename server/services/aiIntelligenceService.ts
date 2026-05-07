import { db } from "../storage";
import { storage } from "../storage";
import {
  companies, contacts, touchpoints, emailMessages, emailSignals,
  meetingPrepBriefs, contactSentimentTracking, followUpRecommendations,
  relationshipCoachingInsights, orgChartGaps, warmIntroSuggestions,
  accountLookAlikes, crossSellOpportunities, walletSharePlays,
  winLossPatterns, competitiveSignals, rfps, awards
} from "@shared/schema";
import { eq, and, desc, sql, inArray, isNull, gte, lte, count } from "drizzle-orm";
import OpenAI from "openai";

function safeParseJSON(raw: string | null | undefined, fallback: any = {}): any {
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (err) {
    console.warn("[ai-intelligence] Failed to parse AI response JSON, using fallback:", err instanceof Error ? err.message : err);
    return fallback;
  }
}

function clampInt(val: any, min: number, max: number, fallback: number): number {
  const n = parseInt(String(val), 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toInt(val: any, fallback: number): number {
  const n = parseInt(String(val), 10);
  return isNaN(n) ? fallback : n;
}

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

async function getCompanyInOrg(companyId: string, orgId: string) {
  const [company] = await db.select().from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, orgId)))
    .limit(1);
  if (!company) throw new Error("Company not found or access denied");
  return company;
}

async function getContactInOrg(contactId: string, orgId: string) {
  const [contact] = await db.select().from(contacts)
    .innerJoin(companies, eq(contacts.companyId, companies.id))
    .where(and(eq(contacts.id, contactId), eq(companies.organizationId, orgId), isNull(contacts.deletedAt)))
    .limit(1);
  if (!contact) throw new Error("Contact not found or access denied");
  return contact.contacts;
}

// ─── 1. Meeting Prep Briefs ─────────────────────────────────────────────────
export async function generateMeetingPrepBrief(orgId: string, companyId: string, userId: string) {
  const company = await getCompanyInOrg(companyId, orgId);

  const companyContacts = await storage.getContactsByCompany(companyId);
  const recentTouchpoints = await db.select()
    .from(touchpoints)
    .where(and(eq(touchpoints.companyId, companyId)))
    .orderBy(desc(touchpoints.date))
    .limit(15);

  const recentEmails = await db.select()
    .from(emailMessages)
    .where(and(eq(emailMessages.linkedAccountId, companyId)))
    .orderBy(desc(sql`${emailMessages.createdAt}::timestamptz`))
    .limit(10);

  const signals = await db.select()
    .from(emailSignals)
    .where(eq(emailSignals.linkedAccountId, companyId))
    .orderBy(desc(sql`${emailSignals.createdAt}::timestamptz`))
    .limit(10);

  const activeRfps = await db.select()
    .from(rfps)
    .where(and(eq(rfps.companyId, companyId), eq(rfps.status, "pending")));

  const recentAwards = await db.select()
    .from(awards)
    .where(eq(awards.companyId, companyId))
    .orderBy(desc(awards.awardDate))
    .limit(5);

  const prompt = `You are a freight brokerage sales intelligence AI. Generate a concise meeting prep brief for a sales rep about to meet with a customer.

COMPANY: ${company.name}
INDUSTRY: ${company.industry || "Unknown"}
ESTIMATED FREIGHT SPEND: ${company.estimatedFreightSpend || "Unknown"}
SHIPPING MODES: ${company.shippingModes?.join(", ") || "Unknown"}
TENDER STYLE: ${company.tenderStyle || "Unknown"}

CONTACTS (${companyContacts.length}):
${companyContacts.slice(0, 10).map(c => `- ${c.name} (${c.title || "No title"}) - Relationship: ${c.relationshipBase || "unknown"}`).join("\n")}

RECENT TOUCHPOINTS (last 15):
${recentTouchpoints.map(t => `- ${t.date}: ${t.type} with ${t.notes?.substring(0, 100) || "no notes"}`).join("\n") || "None"}

RECENT EMAIL SIGNALS:
${signals.map(s => `- ${s.intentType}${s.intentSubtype ? "/" + s.intentSubtype : ""} (confidence: ${s.confidence}) from ${s.actorType}`).join("\n") || "None"}

ACTIVE RFPs: ${activeRfps.length}
RECENT AWARDS: ${recentAwards.length}

Respond in JSON format:
{
  "executiveSummary": "2-3 sentence overview of the account status",
  "keyTalkingPoints": ["point1", "point2", "point3", "point4", "point5"],
  "riskAlerts": ["any concerns to address"],
  "opportunities": ["growth opportunities to mention"],
  "relationshipStatus": "brief assessment of relationship health",
  "recentActivitySummary": "what's happened recently",
  "suggestedAgenda": ["agenda item 1", "agenda item 2", "agenda item 3"]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const briefContent = safeParseJSON(response.choices[0].message.content, {});

  const [brief] = await db.insert(meetingPrepBriefs).values({
    orgId,
    companyId,
    generatedByUserId: userId,
    briefContent,
    recentActivity: recentTouchpoints.slice(0, 5).map(t => ({ date: t.date, type: t.type, notes: t.notes?.substring(0, 200) })),
    laneHighlights: recentAwards.map(a => ({ title: a.title, value: a.value, lanes: a.lanes })),
    talkingPoints: briefContent.keyTalkingPoints || [],
    riskAlerts: briefContent.riskAlerts || [],
  }).returning();

  return brief;
}

export async function getRecentBriefs(orgId: string, companyId?: string, limit = 10) {
  const conditions = [eq(meetingPrepBriefs.orgId, orgId)];
  if (companyId) conditions.push(eq(meetingPrepBriefs.companyId, companyId));
  return db.select().from(meetingPrepBriefs)
    .where(and(...conditions))
    .orderBy(desc(meetingPrepBriefs.createdAt))
    .limit(limit);
}

// ─── 2. Sentiment Tracking ──────────────────────────────────────────────────
export async function analyzeContactSentiment(orgId: string, companyId: string, contactId: string) {
  await getCompanyInOrg(companyId, orgId);
  const contact = await db.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId), isNull(contacts.deletedAt))).limit(1);
  if (!contact.length) throw new Error("Contact not found or does not belong to company");

  const contactEmail = contact[0].email;
  const recentTouches = await db.select()
    .from(touchpoints)
    .where(and(eq(touchpoints.contactId, contactId)))
    .orderBy(desc(touchpoints.date))
    .limit(20);

  let emailActivity: any[] = [];
  if (contactEmail) {
    emailActivity = await db.select()
      .from(emailMessages)
      .where(and(
        eq(emailMessages.linkedAccountId, companyId),
        sql`(${emailMessages.fromEmail} ILIKE ${'%' + contactEmail + '%'} OR ${emailMessages.toEmail}::text ILIKE ${'%' + contactEmail + '%'})`
      ))
      .orderBy(desc(sql`${emailMessages.createdAt}::timestamptz`))
      .limit(20);
  }

  const prompt = `Analyze the sentiment and engagement pattern for this contact at a freight customer.

CONTACT: ${contact[0].name} (${contact[0].title || "Unknown title"})
RELATIONSHIP BASE: ${contact[0].relationshipBase || "unknown"}

RECENT TOUCHPOINTS:
${recentTouches.map(t => `- ${t.date}: ${t.type} - ${t.sentiment || "neutral"} - ${t.notes?.substring(0, 100) || ""}`).join("\n") || "No touchpoints"}

EMAIL ACTIVITY (${emailActivity.length} recent):
${emailActivity.slice(0, 10).map(e => `- ${e.createdAt}: ${e.direction} - Subject: ${e.subject?.substring(0, 60) || ""}`).join("\n") || "No emails"}

Respond in JSON:
{
  "sentimentScore": 1-100,
  "trend": "warming|stable|cooling|disengaged",
  "avgResponseTimeTrend": "faster|stable|slower|unknown",
  "signals": [{"type": "positive|negative|neutral", "detail": "description"}],
  "summary": "one sentence assessment"
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const analysis = safeParseJSON(response.choices[0].message.content, {});

  const [record] = await db.insert(contactSentimentTracking).values({
    orgId,
    contactId,
    companyId,
    sentimentScore: clampInt(analysis.sentimentScore, 1, 100, 50),
    sentimentTrend: analysis.trend || "stable",
    avgResponseTimeHours: analysis.avgResponseTimeTrend === "faster" ? "12" : analysis.avgResponseTimeTrend === "slower" ? "48" : "24",
    signals: analysis.signals || [],
  }).returning();

  return { ...record, summary: analysis.summary };
}

export async function getCompanySentiment(orgId: string, companyId: string) {
  return db.select()
    .from(contactSentimentTracking)
    .where(and(eq(contactSentimentTracking.orgId, orgId), eq(contactSentimentTracking.companyId, companyId)))
    .orderBy(desc(contactSentimentTracking.createdAt));
}

// ─── 3. Smart Follow-Up Timing ──────────────────────────────────────────────
export async function analyzeFollowUpTiming(orgId: string, companyId: string, contactId: string) {
  await getCompanyInOrg(companyId, orgId);
  const contact = await db.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId), isNull(contacts.deletedAt))).limit(1);
  if (!contact.length) throw new Error("Contact not found or does not belong to company");

  const allTouches = await db.select()
    .from(touchpoints)
    .where(eq(touchpoints.contactId, contactId))
    .orderBy(desc(touchpoints.date))
    .limit(30);

  const contactEmail = contact[0].email;
  let emails: any[] = [];
  if (contactEmail) {
    emails = await db.select()
      .from(emailMessages)
      .where(and(
        eq(emailMessages.linkedAccountId, companyId),
        sql`${emailMessages.fromEmail} ILIKE ${'%' + contactEmail + '%'}`
      ))
      .orderBy(desc(sql`${emailMessages.createdAt}::timestamptz`))
      .limit(30);
  }

  const prompt = `Analyze optimal follow-up timing for this freight contact based on their interaction history.

CONTACT: ${contact[0].name} (${contact[0].title || ""})

TOUCHPOINT HISTORY (dates and types):
${allTouches.map(t => `- ${t.date}: ${t.type}`).join("\n") || "None"}

INBOUND EMAIL TIMESTAMPS:
${emails.map(e => `- ${e.createdAt}`).join("\n") || "None"}

Based on the patterns, determine optimal follow-up timing. Respond in JSON:
{
  "recommendedDay": "Monday|Tuesday|...|Friday",
  "recommendedTimeOfDay": "morning|midday|afternoon",
  "optimalCadenceDays": number,
  "maxSilenceDays": number,
  "reasoning": "brief explanation of pattern detected",
  "confidenceScore": 1-100,
  "nextFollowUpDate": "YYYY-MM-DD"
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const timing = safeParseJSON(response.choices[0].message.content, {});

  const existing = await db.select()
    .from(followUpRecommendations)
    .where(and(eq(followUpRecommendations.orgId, orgId), eq(followUpRecommendations.contactId, contactId)))
    .limit(1);

  if (existing.length) {
    const [updated] = await db.update(followUpRecommendations)
      .set({
        recommendedDay: timing.recommendedDay,
        recommendedTimeOfDay: timing.recommendedTimeOfDay,
        optimalCadenceDays: toInt(timing.optimalCadenceDays, 7),
        maxSilenceDays: toInt(timing.maxSilenceDays, 14),
        nextFollowUpDate: timing.nextFollowUpDate,
        reasoning: timing.reasoning,
        confidenceScore: clampInt(timing.confidenceScore, 1, 100, 50),
        dataPoints: allTouches.length + emails.length,
        updatedAt: new Date(),
      })
      .where(eq(followUpRecommendations.id, existing[0].id))
      .returning();
    return updated;
  }

  const [rec] = await db.insert(followUpRecommendations).values({
    orgId,
    contactId,
    companyId,
    recommendedDay: timing.recommendedDay,
    recommendedTimeOfDay: timing.recommendedTimeOfDay,
    optimalCadenceDays: toInt(timing.optimalCadenceDays, 7),
    maxSilenceDays: toInt(timing.maxSilenceDays, 14),
    nextFollowUpDate: timing.nextFollowUpDate,
    reasoning: timing.reasoning,
    confidenceScore: clampInt(timing.confidenceScore, 1, 100, 50),
    dataPoints: allTouches.length + emails.length,
  }).returning();
  return rec;
}

export async function getFollowUpRecommendations(orgId: string, companyId?: string) {
  const conditions = [eq(followUpRecommendations.orgId, orgId)];
  if (companyId) conditions.push(eq(followUpRecommendations.companyId, companyId));
  return db.select().from(followUpRecommendations)
    .where(and(...conditions))
    .orderBy(followUpRecommendations.nextFollowUpDate);
}

// ─── 4. Relationship Health Coaching ────────────────────────────────────────
export async function generateRelationshipCoaching(orgId: string, companyId: string) {
  const company = await getCompanyInOrg(companyId, orgId);

  const companyContacts = await storage.getContactsByCompany(companyId);
  const recentTouches = await db.select()
    .from(touchpoints)
    .where(eq(touchpoints.companyId, companyId))
    .orderBy(desc(touchpoints.date))
    .limit(30);

  const sentiment = await db.select()
    .from(contactSentimentTracking)
    .where(and(eq(contactSentimentTracking.orgId, orgId), eq(contactSentimentTracking.companyId, companyId)))
    .orderBy(desc(contactSentimentTracking.createdAt));

  const prompt = `You are a freight brokerage sales coach. Analyze this account's relationship health and provide actionable coaching insights.

COMPANY: ${company.name}
CONTACTS (${companyContacts.length}):
${companyContacts.map(c => `- ${c.name} (${c.title || "?"}) - Base: ${c.relationshipBase || "?"} - Primary: ${c.isPrimary || false}`).join("\n")}

RECENT TOUCHPOINTS:
${recentTouches.slice(0, 15).map(t => `- ${t.date}: ${t.type} with contact ${t.contactId}`).join("\n") || "None"}

SENTIMENT DATA:
${sentiment.map(s => `- Contact ${s.contactId}: Score ${s.sentimentScore}, Trend: ${s.sentimentTrend}`).join("\n") || "No sentiment data"}

Generate 3-5 coaching insights. Respond in JSON:
{
  "insights": [
    {
      "type": "gap|risk|opportunity|strength",
      "title": "short title",
      "description": "detailed explanation",
      "priority": "critical|high|moderate|low",
      "suggestedAction": "specific actionable step",
      "contactId": "optional contact id if applicable"
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = safeParseJSON(response.choices[0].message.content, { insights: [] });

  await db.delete(relationshipCoachingInsights)
    .where(and(eq(relationshipCoachingInsights.orgId, orgId), eq(relationshipCoachingInsights.companyId, companyId)));

  const validContactIds = new Set(companyContacts.map(c => c.id));

  const insights = [];
  for (const insight of result.insights || []) {
    const rawContactId = typeof insight.contactId === "string" ? insight.contactId.trim() : null;
    let contactId: string | null = null;
    if (rawContactId && validContactIds.has(rawContactId)) {
      contactId = rawContactId;
    } else if (rawContactId) {
      console.warn(`[ai-intelligence] Coaching insight referenced unknown contactId "${rawContactId}" for company ${companyId}; coercing to null`);
    }

    if (!insight.title || !insight.description) {
      console.warn(`[ai-intelligence] Skipping coaching insight missing title/description for company ${companyId}`);
      continue;
    }

    try {
      const [record] = await db.insert(relationshipCoachingInsights).values({
        orgId,
        companyId,
        contactId,
        insightType: insight.type || "opportunity",
        title: insight.title,
        description: insight.description,
        priority: insight.priority || "moderate",
        suggestedAction: insight.suggestedAction,
        dataContext: { sentiment: sentiment.map(s => ({ contactId: s.contactId, score: s.sentimentScore, trend: s.sentimentTrend })) },
      }).returning();
      insights.push(record);
    } catch (err) {
      console.warn(`[ai-intelligence] Skipping coaching insight insert for company ${companyId}:`, err instanceof Error ? err.message : err);
    }
  }

  return insights;
}

export async function getRelationshipCoaching(orgId: string, companyId: string) {
  return db.select()
    .from(relationshipCoachingInsights)
    .where(and(
      eq(relationshipCoachingInsights.orgId, orgId),
      eq(relationshipCoachingInsights.companyId, companyId),
      eq(relationshipCoachingInsights.status, "active"),
    ))
    .orderBy(desc(relationshipCoachingInsights.createdAt));
}

// ─── 5. Org Chart Gap Analysis ──────────────────────────────────────────────
export async function analyzeOrgChartGaps(orgId: string, companyId: string) {
  const company = await getCompanyInOrg(companyId, orgId);

  const companyContacts = await storage.getContactsByCompany(companyId);
  const recentTouches = await db.select()
    .from(touchpoints)
    .where(eq(touchpoints.companyId, companyId))
    .orderBy(desc(touchpoints.date))
    .limit(30);

  const emails = await db.select()
    .from(emailMessages)
    .where(eq(emailMessages.linkedAccountId, companyId))
    .orderBy(desc(sql`${emailMessages.createdAt}::timestamptz`))
    .limit(30);

  const ccPatterns = emails
    .filter(e => e.ccEmail)
    .map(e => e.ccEmail)
    .flat();

  const prompt = `Analyze the org chart coverage for this freight customer and identify gaps.

COMPANY: ${company.name} (${company.industry || "Unknown"})
KNOWN CONTACTS (${companyContacts.length}):
${companyContacts.map(c => `- ${c.name} (${c.title || "?"}) - Email: ${c.email || "?"} - Reports to: ${c.reportsToId || "nobody"}`).join("\n")}

TOUCHPOINT DISTRIBUTION:
${(() => {
  const contactTouchMap: Record<string, number> = {};
  recentTouches.forEach(t => {
    if (t.contactId) contactTouchMap[t.contactId] = (contactTouchMap[t.contactId] || 0) + 1;
  });
  return Object.entries(contactTouchMap).map(([id, cnt]) => `- Contact ${id}: ${cnt} touches`).join("\n") || "No touchpoints";
})()}

CC'd EMAILS (unique addresses seen in CC):
${[...new Set(ccPatterns)].slice(0, 20).join(", ") || "None"}

For a freight shipper, typical key roles include: VP Supply Chain/Logistics, Director of Transportation, Procurement Manager, Operations Manager, Warehouse Manager, Regional Logistics Manager.

Identify gaps. Respond in JSON:
{
  "gaps": [
    {
      "type": "missing_role|untouched_contact|single_threaded|no_executive_sponsor",
      "title": "short title",
      "description": "explanation",
      "suggestedContactName": "name if detected from CC patterns",
      "suggestedContactTitle": "likely role",
      "suggestedContactEmail": "email if found",
      "priority": "critical|high|moderate"
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = safeParseJSON(response.choices[0].message.content, { gaps: [] });

  await db.delete(orgChartGaps)
    .where(and(eq(orgChartGaps.orgId, orgId), eq(orgChartGaps.companyId, companyId)));

  const gaps = [];
  for (const gap of result.gaps || []) {
    const [record] = await db.insert(orgChartGaps).values({
      orgId,
      companyId,
      gapType: gap.type || "missing_role",
      title: gap.title,
      description: gap.description,
      suggestedContactName: gap.suggestedContactName,
      suggestedContactTitle: gap.suggestedContactTitle,
      suggestedContactEmail: gap.suggestedContactEmail,
      priority: gap.priority || "moderate",
    }).returning();
    gaps.push(record);
  }
  return gaps;
}

export async function getOrgChartGaps(orgId: string, companyId: string) {
  return db.select()
    .from(orgChartGaps)
    .where(and(eq(orgChartGaps.orgId, orgId), eq(orgChartGaps.companyId, companyId), eq(orgChartGaps.status, "open")))
    .orderBy(desc(orgChartGaps.createdAt));
}

// ─── 6. Warm Introduction Paths ────────────────────────────────────────────
export async function findWarmIntroPaths(orgId: string, companyId: string) {
  const companyContacts = await storage.getContactsByCompany(companyId);
  const gaps = await getOrgChartGaps(orgId, companyId);

  const recentTouches = await db.select()
    .from(touchpoints)
    .where(eq(touchpoints.companyId, companyId))
    .orderBy(desc(touchpoints.date))
    .limit(30);

  const emails = await db.select()
    .from(emailMessages)
    .where(eq(emailMessages.linkedAccountId, companyId))
    .orderBy(desc(sql`${emailMessages.createdAt}::timestamptz`))
    .limit(50);

  const prompt = `You are a sales relationship strategist for a freight brokerage. Suggest warm introduction paths to reach new contacts at this account.

KNOWN CONTACTS WITH RELATIONSHIP STATUS:
${companyContacts.map(c => `- ${c.name} (${c.title || "?"}) Base: ${c.relationshipBase || "unknown"}`).join("\n")}

IDENTIFIED GAPS/TARGETS:
${gaps.map(g => `- ${g.title}: ${g.suggestedContactName || "Unknown"} (${g.suggestedContactTitle || "?"}) - Email: ${g.suggestedContactEmail || "?"}`).join("\n") || "No specific gaps identified"}

EMAIL CC PATTERNS (who appears together):
${emails.slice(0, 20).map(e => `From: ${e.fromEmail} CC: ${e.ccEmail || "none"}`).join("\n") || "No CC data"}

TOUCHPOINT ACTIVITY:
${(() => {
  const contactActivity: Record<string, number> = {};
  recentTouches.forEach(t => { if (t.contactId) contactActivity[t.contactId] = (contactActivity[t.contactId] || 0) + 1; });
  return companyContacts.map(c => `- ${c.name}: ${contactActivity[c.id] || 0} recent touches`).join("\n");
})()}

Suggest warm intro paths. Respond in JSON:
{
  "suggestions": [
    {
      "targetName": "who to reach",
      "targetTitle": "their role",
      "bridgeName": "who can introduce you",
      "connectionStrength": "strong|moderate|weak",
      "reasoning": "why this path works",
      "suggestedApproach": "specific script/approach"
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = safeParseJSON(response.choices[0].message.content, { suggestions: [] });

  await db.delete(warmIntroSuggestions)
    .where(and(eq(warmIntroSuggestions.orgId, orgId), eq(warmIntroSuggestions.companyId, companyId)));

  const suggestions = [];
  for (const s of result.suggestions || []) {
    const bridgeContact = companyContacts.find(c => c.name.toLowerCase().includes(s.bridgeName?.toLowerCase() || "---"));
    const targetContact = companyContacts.find(c => c.name.toLowerCase().includes(s.targetName?.toLowerCase() || "---"));

    const [record] = await db.insert(warmIntroSuggestions).values({
      orgId,
      companyId,
      targetContactId: targetContact?.id,
      targetContactName: s.targetName,
      bridgeContactId: bridgeContact?.id,
      bridgeContactName: s.bridgeName,
      connectionStrength: s.connectionStrength || "moderate",
      reasoning: s.reasoning,
      suggestedApproach: s.suggestedApproach,
    }).returning();
    suggestions.push(record);
  }
  return suggestions;
}

// ─── 7. Look-Alike Prospecting ──────────────────────────────────────────────
export async function findLookAlikes(orgId: string, sourceCompanyId: string) {
  const source = await getCompanyInOrg(sourceCompanyId, orgId);

  const allCompanies = await db.select()
    .from(companies)
    .where(eq(companies.organizationId, orgId));

  const sourceContacts = await storage.getContactsByCompany(sourceCompanyId);
  const sourceAwards = await db.select().from(awards).where(eq(awards.companyId, sourceCompanyId));

  const prompt = `You are a freight brokerage prospecting AI. Find which other accounts in our CRM most closely resemble our top customer.

SOURCE (TOP CUSTOMER):
- Name: ${source.name}
- Industry: ${source.industry || "Unknown"}
- Freight Spend: ${source.estimatedFreightSpend || "Unknown"}
- Shipping Modes: ${source.shippingModes?.join(", ") || "Unknown"}
- Contact Count: ${sourceContacts.length}
- Award Count: ${sourceAwards.length}
- Lanes: ${sourceAwards.map(a => a.lanes).flat().slice(0, 10).join("; ") || "Unknown"}

OTHER ACCOUNTS IN CRM:
${allCompanies.filter(c => c.id !== sourceCompanyId).slice(0, 50).map(c =>
  `- ${c.name} (ID: ${c.id}) | Industry: ${c.industry || "?"} | Spend: ${c.estimatedFreightSpend || "?"} | Modes: ${c.shippingModes?.join(",") || "?"}`
).join("\n")}

Find the top 5 most similar accounts and score them. Respond in JSON:
{
  "lookAlikes": [
    {
      "companyId": "id from list",
      "companyName": "name",
      "similarityScore": 1-100,
      "matchFactors": ["factor1", "factor2"],
      "expansionOpportunity": "what growth opportunity exists"
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = safeParseJSON(response.choices[0].message.content, { lookAlikes: [] });

  await db.delete(accountLookAlikes)
    .where(and(eq(accountLookAlikes.orgId, orgId), eq(accountLookAlikes.sourceCompanyId, sourceCompanyId)));

  const matches = [];
  for (const la of result.lookAlikes || []) {
    const validTarget = allCompanies.find(c => c.id === la.companyId);
    const [record] = await db.insert(accountLookAlikes).values({
      orgId,
      sourceCompanyId,
      targetCompanyId: validTarget?.id || null,
      targetCompanyName: la.companyName,
      similarityScore: clampInt(la.similarityScore, 1, 100, 50),
      matchFactors: la.matchFactors || [],
      expansionOpportunity: la.expansionOpportunity,
    }).returning();
    matches.push(record);
  }
  return matches;
}

// ─── 8. Cross-Sell / Lane Gap Intelligence ──────────────────────────────────
export async function analyzeCrossSellOpportunities(orgId: string, companyId: string) {
  const company = await getCompanyInOrg(companyId, orgId);

  const companyAwards = await db.select().from(awards).where(eq(awards.companyId, companyId));

  const peerCompanies = await db.select()
    .from(companies)
    .where(and(eq(companies.organizationId, orgId), sql`${companies.industry} = ${company.industry || ""}`))
    .limit(10);

  const peerAwards = [];
  for (const peer of peerCompanies.filter(p => p.id !== companyId)) {
    const pa = await db.select().from(awards).where(eq(awards.companyId, peer.id)).limit(5);
    peerAwards.push({ company: peer.name, awards: pa });
  }

  const prompt = `Analyze cross-sell and lane gap opportunities for this freight customer compared to peers.

CUSTOMER: ${company.name} (${company.industry || "Unknown"})
CURRENT LANES/AWARDS:
${companyAwards.map(a => `- ${a.title}: ${a.lanes?.join(", ") || "no lanes"} (Value: ${a.value || "?"})`).join("\n") || "No current awards"}

PEER COMPANIES (same industry) AND THEIR LANES:
${peerAwards.map(p => `${p.company}: ${p.awards.map(a => a.lanes?.join(", ")).join("; ") || "no data"}`).join("\n") || "No peer data"}

Identify lanes or services this customer SHOULD be shipping but ISN'T, based on peer patterns. Respond in JSON:
{
  "opportunities": [
    {
      "type": "reverse_lane|new_corridor|mode_expansion|volume_growth",
      "title": "short title",
      "description": "detailed explanation",
      "lane": "origin → destination if applicable",
      "estimatedValue": number or null,
      "confidenceScore": 1-100,
      "peerEvidence": ["which peers run this"],
      "suggestedApproach": "how to pitch this"
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = safeParseJSON(response.choices[0].message.content, { opportunities: [] });

  await db.delete(crossSellOpportunities)
    .where(and(eq(crossSellOpportunities.orgId, orgId), eq(crossSellOpportunities.companyId, companyId)));

  const opps = [];
  for (const opp of result.opportunities || []) {
    const [record] = await db.insert(crossSellOpportunities).values({
      orgId,
      companyId,
      opportunityType: opp.type || "new_corridor",
      title: opp.title,
      description: opp.description,
      lane: opp.lane,
      estimatedValue: opp.estimatedValue?.toString(),
      confidenceScore: clampInt(opp.confidenceScore, 1, 100, 50),
      peerEvidence: opp.peerEvidence || [],
      suggestedApproach: opp.suggestedApproach,
    }).returning();
    opps.push(record);
  }
  return opps;
}

// ─── 9. Wallet Share Expansion Playbook ─────────────────────────────────────
export async function generateWalletSharePlay(orgId: string, companyId: string) {
  const company = await getCompanyInOrg(companyId, orgId);

  const companyContacts = await storage.getContactsByCompany(companyId);
  const companyAwards = await db.select().from(awards).where(eq(awards.companyId, companyId));
  const crossSells = await db.select()
    .from(crossSellOpportunities)
    .where(and(eq(crossSellOpportunities.orgId, orgId), eq(crossSellOpportunities.companyId, companyId)));

  const prompt = `Create a detailed account growth playbook for this freight customer.

CUSTOMER: ${company.name}
ESTIMATED FREIGHT SPEND: ${company.estimatedFreightSpend || "Unknown"}
INDUSTRY: ${company.industry || "Unknown"}
SHIPPING MODES: ${company.shippingModes?.join(", ") || "Unknown"}

KEY CONTACTS:
${companyContacts.slice(0, 8).map(c => `- ${c.name} (${c.title || "?"}) - Base: ${c.relationshipBase || "?"}`).join("\n")}

CURRENT BUSINESS:
${companyAwards.map(a => `- ${a.title}: Value ${a.value || "?"}`).join("\n") || "No current awards"}

IDENTIFIED CROSS-SELL OPPORTUNITIES:
${crossSells.map(cs => `- ${cs.title}: ${cs.description?.substring(0, 100)}`).join("\n") || "None identified yet"}

Create a step-by-step growth playbook. Respond in JSON:
{
  "playTitle": "title of the play",
  "playDescription": "overview",
  "targetLanes": [{"lane": "origin → dest", "reason": "why"}],
  "targetContacts": [{"name": "who", "role": "why they matter", "approach": "how to engage"}],
  "pricingStrategy": "pricing approach",
  "estimatedRevenue": number,
  "timelineWeeks": number,
  "steps": [
    {"week": 1, "action": "what to do", "owner": "rep/manager", "outcome": "expected result"}
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const play = safeParseJSON(response.choices[0].message.content, {});

  const [record] = await db.insert(walletSharePlays).values({
    orgId,
    companyId,
    playTitle: play.playTitle || `Growth Play - ${company.name}`,
    playDescription: play.playDescription || "",
    targetLanes: play.targetLanes || [],
    targetContacts: play.targetContacts || [],
    pricingStrategy: play.pricingStrategy,
    estimatedRevenue: play.estimatedRevenue?.toString(),
    timelineWeeks: toInt(play.timelineWeeks, 4),
    steps: play.steps || [],
  }).returning();

  return record;
}

// ─── 10. Win/Loss Pattern Engine ────────────────────────────────────────────
export async function analyzeWinLossPatterns(orgId: string) {
  const orgCompanies = await db.select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.organizationId, orgId));
  const orgCompanyIds = orgCompanies.map(c => c.id);
  if (!orgCompanyIds.length) return [];

  const allRfps = await db.select()
    .from(rfps)
    .where(inArray(rfps.companyId, orgCompanyIds))
    .limit(100);

  const wonRfps = allRfps.filter(r => r.status === "won");
  const lostRfps = allRfps.filter(r => r.status === "lost");

  const companiesData = orgCompanies;
  const companyMap = new Map(companiesData.map(c => [c.id, c]));

  const prompt = `Analyze win/loss patterns across RFPs for a freight brokerage. Identify what predicts success vs failure.

WON RFPs (${wonRfps.length}):
${wonRfps.slice(0, 20).map(r => {
  const co = companyMap.get(r.companyId!);
  return `- ${co?.name || "?"} | Value: ${r.value || "?"} | Lanes: ${r.laneCount || "?"} | Origins: ${r.originStates?.join(",") || "?"} | Dests: ${r.destinationStates?.join(",") || "?"}`;
}).join("\n") || "None"}

LOST RFPs (${lostRfps.length}):
${lostRfps.slice(0, 20).map(r => {
  const co = companyMap.get(r.companyId!);
  return `- ${co?.name || "?"} | Value: ${r.value || "?"} | Lanes: ${r.laneCount || "?"} | Origins: ${r.originStates?.join(",") || "?"} | Dests: ${r.destinationStates?.join(",") || "?"}`;
}).join("\n") || "None"}

Find patterns. Respond in JSON:
{
  "patterns": [
    {
      "type": "pricing|relationship|timing|geography|capacity|size",
      "title": "pattern name",
      "description": "detailed explanation",
      "outcome": "win|loss|mixed",
      "frequency": number,
      "factors": ["contributing factor 1", "factor 2"],
      "recommendations": ["actionable recommendation"],
      "confidenceScore": 1-100
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const result = safeParseJSON(response.choices[0].message.content, { patterns: [] });

  await db.delete(winLossPatterns).where(eq(winLossPatterns.orgId, orgId));

  const patterns = [];
  for (const p of result.patterns || []) {
    const [record] = await db.insert(winLossPatterns).values({
      orgId,
      patternType: p.type || "mixed",
      title: p.title,
      description: p.description,
      outcome: p.outcome || "mixed",
      frequency: toInt(p.frequency, 1),
      factors: p.factors || [],
      recommendations: p.recommendations || [],
      confidenceScore: clampInt(p.confidenceScore, 1, 100, 50),
    }).returning();
    patterns.push(record);
  }
  return patterns;
}

export async function getWinLossPatterns(orgId: string) {
  return db.select()
    .from(winLossPatterns)
    .where(eq(winLossPatterns.orgId, orgId))
    .orderBy(desc(winLossPatterns.confidenceScore));
}

// ─── 11. Competitive Signal Detection ───────────────────────────────────────
export async function detectCompetitiveSignals(orgId: string, companyId: string) {
  const company = await getCompanyInOrg(companyId, orgId);

  const recentEmails = await db.select()
    .from(emailMessages)
    .where(and(eq(emailMessages.linkedAccountId, companyId)))
    .orderBy(desc(sql`${emailMessages.createdAt}::timestamptz`))
    .limit(30);

  const recentSignals = await db.select()
    .from(emailSignals)
    .where(eq(emailSignals.linkedAccountId, companyId))
    .orderBy(desc(sql`${emailSignals.createdAt}::timestamptz`))
    .limit(20);

  const prompt = `Analyze emails and signals from this freight customer for any competitive intelligence — mentions of other brokers, rate shopping, or switching behavior.

COMPANY: ${company.name}

RECENT EMAILS:
${recentEmails.map(e => `- ${e.direction} | ${e.subject || "no subject"} | From: ${e.fromEmail} | Snippet: ${e.body?.substring(0, 150) || ""}`).join("\n") || "No emails"}

DETECTED SIGNALS:
${recentSignals.map(s => `- ${s.intentType}/${s.intentSubtype || ""} from ${s.actorType} (confidence: ${s.confidence})`).join("\n") || "No signals"}

Look for competitive threats. Respond in JSON:
{
  "signals": [
    {
      "type": "competitor_mention|rate_shopping|switching_risk|rfp_to_others|dissatisfaction",
      "competitorName": "name if mentioned",
      "description": "what you detected",
      "severity": "critical|high|moderate|low",
      "suggestedResponse": "how to respond"
    }
  ]
}`;

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const result = safeParseJSON(response.choices[0].message.content, { signals: [] });

  const detected = [];
  for (const sig of result.signals || []) {
    const [record] = await db.insert(competitiveSignals).values({
      orgId,
      companyId,
      signalType: sig.type || "competitor_mention",
      competitorName: sig.competitorName,
      description: sig.description,
      sourceType: "email_analysis",
      severity: sig.severity || "moderate",
      suggestedResponse: sig.suggestedResponse,
    }).returning();
    detected.push(record);
  }
  return detected;
}

export async function getCompetitiveSignals(orgId: string, companyId?: string) {
  const conditions = [eq(competitiveSignals.orgId, orgId), eq(competitiveSignals.status, "active")];
  if (companyId) conditions.push(eq(competitiveSignals.companyId, companyId));
  return db.select()
    .from(competitiveSignals)
    .where(and(...conditions))
    .orderBy(desc(competitiveSignals.detectedAt));
}

// ─── Bulk Analysis (per-company) ─────────────────────────────────────────────
export async function bulkAnalyzeCompanySentiment(orgId: string, companyId: string) {
  await getCompanyInOrg(companyId, orgId);
  const companyContacts = await storage.getContactsByCompany(companyId);
  const results = [];
  for (const contact of companyContacts.slice(0, 10)) {
    try {
      const result = await analyzeContactSentiment(orgId, companyId, contact.id);
      results.push(result);
    } catch (err) {
      console.error(`[ai-intel] sentiment error for contact ${contact.id}:`, err);
    }
  }
  return results;
}

export async function bulkAnalyzeCompanyFollowUps(orgId: string, companyId: string) {
  await getCompanyInOrg(companyId, orgId);
  const companyContacts = await storage.getContactsByCompany(companyId);
  const results = [];
  for (const contact of companyContacts.slice(0, 10)) {
    try {
      const result = await analyzeFollowUpTiming(orgId, companyId, contact.id);
      results.push(result);
    } catch (err) {
      console.error(`[ai-intel] follow-up error for contact ${contact.id}:`, err);
    }
  }
  return results;
}

// ─── Dashboard Summary ─────────────────────────────────────────────────────
export async function getAIIntelligenceDashboard(orgId: string) {
  const [sentimentAlerts] = await db.select({ count: count() })
    .from(contactSentimentTracking)
    .where(and(eq(contactSentimentTracking.orgId, orgId), eq(contactSentimentTracking.sentimentTrend, "cooling")));

  const [openGaps] = await db.select({ count: count() })
    .from(orgChartGaps)
    .where(and(eq(orgChartGaps.orgId, orgId), eq(orgChartGaps.status, "open")));

  const [activeCrossSells] = await db.select({ count: count() })
    .from(crossSellOpportunities)
    .where(and(eq(crossSellOpportunities.orgId, orgId), eq(crossSellOpportunities.status, "identified")));

  const [competitiveAlerts] = await db.select({ count: count() })
    .from(competitiveSignals)
    .where(and(eq(competitiveSignals.orgId, orgId), eq(competitiveSignals.status, "active")));

  const [upcomingFollowUps] = await db.select({ count: count() })
    .from(followUpRecommendations)
    .where(and(
      eq(followUpRecommendations.orgId, orgId),
      sql`${followUpRecommendations.nextFollowUpDate} <= (CURRENT_DATE + INTERVAL '3 days')::text`
    ));

  const recentPatterns = await db.select()
    .from(winLossPatterns)
    .where(eq(winLossPatterns.orgId, orgId))
    .orderBy(desc(winLossPatterns.confidenceScore))
    .limit(3);

  return {
    sentimentAlerts: sentimentAlerts?.count || 0,
    openOrgChartGaps: openGaps?.count || 0,
    crossSellOpportunities: activeCrossSells?.count || 0,
    competitiveAlerts: competitiveAlerts?.count || 0,
    upcomingFollowUps: upcomingFollowUps?.count || 0,
    topPatterns: recentPatterns,
  };
}