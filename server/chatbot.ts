import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, desc, gte, inArray } from "drizzle-orm";
import {
  companies, contacts, touchpoints, rfps, goals, tasks, users,
  chatConversations, chatMessages,
} from "@shared/schema";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

async function buildCrmContext(userId: string, userRole: string): Promise<string> {
  try {
    let visibleCompanies: (typeof companies.$inferSelect)[] = [];

    if (userRole === "admin") {
      visibleCompanies = await db.select().from(companies).limit(200);
    } else if (userRole === "national_account_manager") {
      const subordinates = await db.select({ id: users.id }).from(users).where(eq(users.managerId, userId));
      const subIds = [userId, ...subordinates.map((s) => s.id)];
      visibleCompanies = await db.select().from(companies).where(inArray(companies.accountManagerId, subIds)).limit(200);
    } else {
      visibleCompanies = await db.select().from(companies).where(eq(companies.accountManagerId, userId)).limit(200);
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
        .where(and(inArray(touchpoints.contactId, contactIds), gte(touchpoints.touchedAt, thirtyDaysAgo.toISOString())))
        .orderBy(desc(touchpoints.touchedAt))
        .limit(100);
    }

    let openRfps: (typeof rfps.$inferSelect)[] = [];
    if (companyIds.length > 0) {
      openRfps = await db.select().from(rfps).where(and(inArray(rfps.companyId, companyIds), eq(rfps.status, "open"))).limit(50);
    }

    let activeGoals: (typeof goals.$inferSelect)[] = [];
    if (userRole === "national_account_manager" || userRole === "admin") {
      activeGoals = await db.select().from(goals).where(eq(goals.namId, userId)).limit(20);
    } else {
      activeGoals = await db.select().from(goals).where(eq(goals.amId, userId)).limit(20);
    }

    let openTasks: (typeof tasks.$inferSelect)[] = [];
    openTasks = await db.select().from(tasks).where(and(eq(tasks.assignedToId, userId), eq(tasks.status, "open"))).limit(20);

    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    let ctx = `Today's date: ${today}\n\n`;

    ctx += `=== ACCOUNTS (${visibleCompanies.length}) ===\n`;
    visibleCompanies.slice(0, 60).forEach((c) => {
      ctx += `- ${c.name}${c.financialAlias ? ` (alias: ${c.financialAlias})` : ""}${c.city ? `, ${c.city}` : ""}${c.state ? ` ${c.state}` : ""}\n`;
    });
    if (visibleCompanies.length > 60) ctx += `  ...and ${visibleCompanies.length - 60} more accounts\n`;

    ctx += `\n=== CONTACTS (${contactList.length}) ===\n`;
    contactList.slice(0, 120).forEach((c) => {
      const company = visibleCompanies.find((co) => co.id === c.companyId);
      const lastTouch = recentTouchpoints.find((tp) => tp.contactId === c.id);
      ctx += `- ${c.name}${c.title ? ` (${c.title})` : ""} @ ${company?.name || "Unknown"}`;
      if (c.relationshipBase) ctx += ` | Relationship: ${c.relationshipBase}`;
      if (lastTouch) {
        const daysAgo = Math.floor((Date.now() - new Date(lastTouch.touchedAt).getTime()) / 86400000);
        ctx += ` | Last touch: ${daysAgo}d ago (${lastTouch.type})`;
      } else {
        ctx += ` | Last touch: >30 days or never`;
      }
      ctx += "\n";
    });
    if (contactList.length > 120) ctx += `  ...and ${contactList.length - 120} more contacts\n`;

    ctx += `\n=== OPEN RFPs (${openRfps.length}) ===\n`;
    openRfps.forEach((r) => {
      const company = visibleCompanies.find((co) => co.id === r.companyId);
      const dueDate = r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "No due date";
      ctx += `- ${r.name} @ ${company?.name || "Unknown"} | Due: ${dueDate}\n`;
    });

    ctx += `\n=== OPEN TASKS (${openTasks.length}) ===\n`;
    openTasks.forEach((t) => {
      ctx += `- ${t.title}${t.dueDate ? ` | Due: ${new Date(t.dueDate).toLocaleDateString()}` : ""}\n`;
    });

    ctx += `\n=== GOALS (${activeGoals.length}) ===\n`;
    activeGoals.forEach((g) => {
      ctx += `- ${g.metricType}${g.customLabel ? ` (${g.customLabel})` : ""}: Target ${g.targetValue}, Current ${g.currentValue || 0}\n`;
    });

    return ctx;
  } catch (err) {
    console.error("Error building CRM context:", err);
    return "CRM data temporarily unavailable.";
  }
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
    const { content } = req.body;
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

      const crmContext = await buildCrmContext(user.id, user.role);

      const systemPrompt = `You are GrowthBot, an AI assistant built into the OrgChart CRM for Value Truck transportation brokerage. You have access to live CRM data for the current user.

Current user: ${user.name} (${user.role.replace(/_/g, " ")})

Here is the current CRM data you have access to:
${crmContext}

Guidelines:
- Answer questions about accounts, contacts, RFPs, touchpoints, tasks, and goals using the data above
- Be concise and direct — reps are busy and usually on calls
- When asked about contacts who haven't been touched, look at the "Last touch" info in the contacts section
- Format lists clearly with bullet points
- If you don't have specific data, say so honestly rather than guessing
- You can suggest actions like "Consider logging a touchpoint" or "This RFP is due soon"
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
        max_tokens: 1000,
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
}
