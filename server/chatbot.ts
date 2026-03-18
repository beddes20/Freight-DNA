import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, desc, gte, inArray, sql } from "drizzle-orm";
import {
  companies, contacts, touchpoints, rfps, goals, tasks, users,
  chatConversations, chatMessages, appSuggestions, notifications,
} from "@shared/schema";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function buildEveryoneContext(requestingUserId: string): Promise<string> {
  try {
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

    const [allUsers, allCompanies, allContacts, allTouchpoints, allGoals, allTasks, allRfps] = await Promise.all([
      db.select().from(users).limit(200),
      db.select().from(companies).limit(500),
      db.select().from(contacts).limit(2000),
      db.select().from(touchpoints).where(gte(touchpoints.date, thirtyDaysAgo)).limit(2000),
      db.select().from(goals).limit(200),
      db.select().from(tasks).where(eq(tasks.status, "open")).limit(200),
      db.select().from(rfps).where(eq(rfps.status, "open")).limit(100),
    ]);

    const accountManagerUsers = allUsers.filter(u =>
      u.role === "account_manager" || u.role === "national_account_manager" || u.role === "director" || u.role === "sales"
    );

    let ctx = `Today's date: ${today}\nData scope: EVERYONE (all teams)\n\n`;

    ctx += `=== TEAM MEMBERS (${accountManagerUsers.length}) ===\n`;
    accountManagerUsers.forEach(u => {
      const myCompanies = allCompanies.filter(c => c.assignedTo === u.id);
      const myContactIds = allContacts.filter(c => myCompanies.some(co => co.id === c.companyId)).map(c => c.id);
      const contactsThisMonth = allContacts.filter(c =>
        myCompanies.some(co => co.id === c.companyId) && c.createdAt && c.createdAt >= firstOfMonth
      ).length;
      const touchpointsThisMonth = allTouchpoints.filter(tp =>
        myContactIds.includes(tp.contactId) && tp.date >= firstOfMonth
      ).length;
      const touchpoints30d = allTouchpoints.filter(tp => myContactIds.includes(tp.contactId)).length;
      ctx += `- ${u.name} (${u.role.replace(/_/g, " ")}): ${myCompanies.length} accounts, ${myContactIds.length} contacts total, ${contactsThisMonth} new contacts this month, ${touchpointsThisMonth} touchpoints this month, ${touchpoints30d} touchpoints last 30d\n`;
    });

    ctx += `\n=== ALL ACCOUNTS (${allCompanies.length}) ===\n`;
    allCompanies.slice(0, 120).forEach(c => {
      const rep = allUsers.find(u => u.id === c.assignedTo);
      ctx += `- ${c.name}${c.financialAlias ? ` (alias: ${c.financialAlias})` : ""} → ${rep?.name || "Unassigned"}\n`;
    });
    if (allCompanies.length > 120) ctx += `  ...and ${allCompanies.length - 120} more accounts\n`;

    ctx += `\n=== ALL CONTACTS (${allContacts.length}) ===\n`;
    allContacts.slice(0, 200).forEach(c => {
      const company = allCompanies.find(co => co.id === c.companyId);
      const rep = allUsers.find(u => u.id === company?.assignedTo);
      const lastTouch = allTouchpoints.find(tp => tp.contactId === c.id);
      const daysAgo = lastTouch ? Math.floor((Date.now() - new Date(lastTouch.date).getTime()) / 86400000) : null;
      ctx += `- ${c.name}${c.title ? ` (${c.title})` : ""} @ ${company?.name || "Unknown"} [Rep: ${rep?.name || "?"}]`;
      if (daysAgo !== null) ctx += ` | Last touch: ${daysAgo}d ago (${lastTouch!.type})`;
      else ctx += ` | Last touch: >30 days or never`;
      if (c.createdAt && c.createdAt >= firstOfMonth) ctx += ` | NEW THIS MONTH`;
      ctx += "\n";
    });
    if (allContacts.length > 200) ctx += `  ...and ${allContacts.length - 200} more contacts\n`;

    ctx += `\n=== OPEN RFPs (${allRfps.length}) ===\n`;
    allRfps.forEach(r => {
      const company = allCompanies.find(co => co.id === r.companyId);
      const rep = allUsers.find(u => u.id === company?.assignedTo);
      ctx += `- ${r.name} @ ${company?.name || "Unknown"} [Rep: ${rep?.name || "?"}] | Due: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "No due date"}\n`;
    });

    ctx += `\n=== OPEN TASKS (${allTasks.length}) ===\n`;
    allTasks.slice(0, 60).forEach(t => {
      const assignee = allUsers.find(u => u.id === t.assignedTo);
      const assigner = allUsers.find(u => u.id === t.assignedBy);
      ctx += `- ${t.title} | Assigned to: ${assignee?.name || "?"} | By: ${assigner?.name || "?"} | Due: ${t.dueDate ? new Date(t.dueDate).toLocaleDateString() : "None"}\n`;
    });
    if (allTasks.length > 60) ctx += `  ...and ${allTasks.length - 60} more tasks\n`;

    ctx += `\n=== GOALS (${allGoals.length}) ===\n`;
    allGoals.slice(0, 60).forEach(g => {
      const nam = allUsers.find(u => u.id === g.namId);
      const am = allUsers.find(u => u.id === g.amId);
      const pct = g.targetValue > 0 ? Math.round(((g.currentValue || 0) / g.targetValue) * 100) : 0;
      ctx += `- ${am?.name || "?"} | ${g.metricType}${g.customLabel ? ` (${g.customLabel})` : ""}: ${g.currentValue || 0}/${g.targetValue} (${pct}%) | Set by: ${nam?.name || "?"}\n`;
    });

    return ctx;
  } catch (err) {
    console.error("Error building everyone context:", err);
    return "CRM data temporarily unavailable.";
  }
}

async function buildMyTeamContext(userId: string, userRole: string): Promise<string> {
  try {
    let visibleCompanies: (typeof companies.$inferSelect)[] = [];

    if (userRole === "admin") {
      visibleCompanies = await db.select().from(companies).limit(300);
    } else if (userRole === "national_account_manager" || userRole === "director" || userRole === "sales") {
      const subordinates = await db.select({ id: users.id }).from(users).where(eq(users.managerId, userId));
      const subIds = [userId, ...subordinates.map((s) => s.id)];
      visibleCompanies = await db.select().from(companies).where(inArray(companies.assignedTo, subIds)).limit(300);
    } else {
      visibleCompanies = await db.select().from(companies).where(eq(companies.assignedTo, userId)).limit(200);
    }

    const companyIds = visibleCompanies.map((c) => c.id);

    let contactList: (typeof contacts.$inferSelect)[] = [];
    if (companyIds.length > 0) {
      contactList = await db.select().from(contacts).where(inArray(contacts.companyId, companyIds)).limit(500);
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    let recentTouchpoints: (typeof touchpoints.$inferSelect)[] = [];
    if (contactList.length > 0) {
      const contactIds = contactList.map((c) => c.id);
      recentTouchpoints = await db.select().from(touchpoints)
        .where(and(inArray(touchpoints.contactId, contactIds), gte(touchpoints.date, thirtyDaysAgo.toISOString())))
        .orderBy(desc(touchpoints.date))
        .limit(200);
    }

    let openRfps: (typeof rfps.$inferSelect)[] = [];
    if (companyIds.length > 0) {
      openRfps = await db.select().from(rfps).where(and(inArray(rfps.companyId, companyIds), eq(rfps.status, "open"))).limit(50);
    }

    let activeGoals: (typeof goals.$inferSelect)[] = [];
    if (userRole === "national_account_manager" || userRole === "admin" || userRole === "director" || userRole === "sales") {
      activeGoals = await db.select().from(goals).where(eq(goals.namId, userId)).limit(30);
    } else {
      activeGoals = await db.select().from(goals).where(eq(goals.amId, userId)).limit(20);
    }

    let openTasks: (typeof tasks.$inferSelect)[] = [];
    openTasks = await db.select().from(tasks).where(and(eq(tasks.assignedTo, userId), eq(tasks.status, "open"))).limit(30);

    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    let ctx = `Today's date: ${today}\nData scope: MY TEAM\n\n`;

    ctx += `=== ACCOUNTS (${visibleCompanies.length}) ===\n`;
    visibleCompanies.slice(0, 80).forEach((c) => {
      ctx += `- ${c.name}${c.financialAlias ? ` (alias: ${c.financialAlias})` : ""}\n`;
    });
    if (visibleCompanies.length > 80) ctx += `  ...and ${visibleCompanies.length - 80} more accounts\n`;

    ctx += `\n=== CONTACTS (${contactList.length}) ===\n`;
    contactList.slice(0, 150).forEach((c) => {
      const company = visibleCompanies.find((co) => co.id === c.companyId);
      const lastTouch = recentTouchpoints.find((tp) => tp.contactId === c.id);
      ctx += `- ${c.name}${c.title ? ` (${c.title})` : ""} @ ${company?.name || "Unknown"}`;
      if (c.relationshipBase) ctx += ` | Relationship: ${c.relationshipBase}`;
      if (lastTouch) {
        const daysAgo = Math.floor((Date.now() - new Date(lastTouch.date).getTime()) / 86400000);
        ctx += ` | Last touch: ${daysAgo}d ago (${lastTouch.type})`;
      } else {
        ctx += ` | Last touch: >30 days or never`;
      }
      if (c.createdAt && c.createdAt >= firstOfMonth) ctx += ` | NEW THIS MONTH`;
      ctx += "\n";
    });
    if (contactList.length > 150) ctx += `  ...and ${contactList.length - 150} more contacts\n`;

    ctx += `\n=== OPEN RFPs (${openRfps.length}) ===\n`;
    openRfps.forEach((r) => {
      const company = visibleCompanies.find((co) => co.id === r.companyId);
      ctx += `- ${r.name} @ ${company?.name || "Unknown"} | Due: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "No due date"}\n`;
    });

    ctx += `\n=== OPEN TASKS (${openTasks.length}) ===\n`;
    openTasks.forEach((t) => {
      ctx += `- ${t.title}${t.dueDate ? ` | Due: ${new Date(t.dueDate).toLocaleDateString()}` : ""}\n`;
    });

    ctx += `\n=== GOALS (${activeGoals.length}) ===\n`;
    activeGoals.forEach((g) => {
      const pct = g.targetValue > 0 ? Math.round(((g.currentValue || 0) / g.targetValue) * 100) : 0;
      ctx += `- ${g.metricType}${g.customLabel ? ` (${g.customLabel})` : ""}: ${g.currentValue || 0}/${g.targetValue} (${pct}%)\n`;
    });

    return ctx;
  } catch (err) {
    console.error("Error building my-team context:", err);
    return "CRM data temporarily unavailable.";
  }
}

async function buildCrmContext(userId: string, userRole: string, scope: string): Promise<string> {
  const useEveryone = userRole === "admin" || userRole === "director" || scope === "everyone";
  if (useEveryone) {
    return buildEveryoneContext(userId);
  }
  return buildMyTeamContext(userId, userRole);
}

export function registerChatbotRoutes(app: Express): void {
  app.get("/api/chatbot/conversations", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const convos = await db.select().from(chatConversations)
        .where(eq(chatConversations.userId, req.session.userId))
        .orderBy(desc(chatConversations.id))
        .limit(20);
      res.json(convos);
    } catch (err) {
      res.status(500).json({ error: "Failed to load conversations" });
    }
  });

  app.post("/api/chatbot/conversations", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const [convo] = await db.insert(chatConversations).values({
        userId: req.session.userId,
        title: req.body.title || "New Chat",
        createdAt: new Date().toISOString(),
      }).returning();
      res.json(convo);
    } catch (err) {
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  app.delete("/api/chatbot/conversations/:id", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const id = parseInt(req.params.id);
      await db.delete(chatMessages).where(eq(chatMessages.conversationId, id));
      await db.delete(chatConversations).where(and(
        eq(chatConversations.id, id),
        eq(chatConversations.userId, req.session.userId),
      ));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  app.get("/api/chatbot/conversations/:id/messages", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const msgs = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, parseInt(req.params.id)))
        .orderBy(chatMessages.id);
      res.json(msgs);
    } catch (err) {
      res.status(500).json({ error: "Failed to load messages" });
    }
  });

  app.post("/api/chatbot/conversations/:id/messages", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    const { content, scope = "my_team" } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Message content required" });

    const conversationId = parseInt(req.params.id);
    try {
      await db.insert(chatMessages).values({
        conversationId,
        role: "user",
        content: content.trim(),
        createdAt: new Date().toISOString(),
      });

      const [user] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (!user) return res.status(401).json({ error: "User not found" });

      const history = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, conversationId))
        .orderBy(chatMessages.id)
        .limit(30);

      const effectiveScope = (user.role === "admin" || user.role === "director") ? "everyone" : scope;
      const crmContext = await buildCrmContext(user.id, user.role, effectiveScope);

      const scopeLabel = effectiveScope === "everyone" ? "the entire organization (all reps and teams)" : "the current user's team only";

      const systemPrompt = `You are GrowthBot, an AI assistant built into the OrgChart CRM for Value Truck transportation brokerage. You have access to live CRM data.

Current user: ${user.name} (${user.role.replace(/_/g, " ")})
Data scope: ${scopeLabel}

Here is the current CRM data:
${crmContext}

Guidelines:
- Answer questions about accounts, contacts, RFPs, touchpoints, tasks, and goals using the data above
- For ranking questions (e.g. "who has the most contacts this month"), use the TEAM MEMBERS section which has per-rep stats
- Be concise and direct — reps are busy
- Format lists clearly with bullet points
- When referencing contacts marked "NEW THIS MONTH", use that to answer questions about contacts added this month
- If you don't have specific data, say so honestly rather than guessing
- You can suggest follow-up actions when appropriate
- Keep responses friendly but professional`;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const chatHistory = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, ...chatHistory],
        stream: true,
        max_tokens: 1200,
      });

      let fullResponse = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || "";
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      await db.insert(chatMessages).values({
        conversationId,
        role: "assistant",
        content: fullResponse,
        createdAt: new Date().toISOString(),
      });

      if (history.length <= 1) {
        const shortTitle = content.trim().slice(0, 50);
        await db.update(chatConversations).set({ title: shortTitle }).where(eq(chatConversations.id, conversationId));
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err: any) {
      console.error("Chatbot error:", err);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Something went wrong. Please try again." })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to process message" });
      }
    }
  });

  app.post("/api/chatbot/suggest", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: "Suggestion content required" });

    try {
      const [submitter] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (!submitter) return res.status(401).json({ error: "User not found" });

      const [suggestion] = await db.insert(appSuggestions).values({
        submittedById: req.session.userId,
        content: content.trim(),
        status: "new",
      }).returning();

      const admins = await db.select().from(users).where(eq(users.role, "admin"));
      for (const admin of admins) {
        await db.insert(notifications).values({
          userId: admin.id,
          type: "app_suggestion",
          title: `App Suggestion from ${submitter.name}`,
          body: content.trim().length > 120 ? content.trim().slice(0, 120) + "…" : content.trim(),
          read: false,
          relatedId: suggestion.id,
        });
      }

      res.json({ ok: true, suggestionId: suggestion.id });
    } catch (err) {
      console.error("Suggestion error:", err);
      res.status(500).json({ error: "Failed to submit suggestion" });
    }
  });

  app.get("/api/chatbot/suggestions", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const [currentUser] = await db.select().from(users).where(eq(users.id, req.session.userId));
      if (!currentUser || currentUser.role !== "admin") return res.status(403).json({ error: "Admins only" });

      const results = await db
        .select({
          id: appSuggestions.id,
          content: appSuggestions.content,
          status: appSuggestions.status,
          createdAt: appSuggestions.createdAt,
          submitterName: users.name,
          submitterRole: users.role,
        })
        .from(appSuggestions)
        .innerJoin(users, eq(users.id, appSuggestions.submittedById))
        .orderBy(desc(appSuggestions.createdAt))
        .limit(100);

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: "Failed to load suggestions" });
    }
  });
}
