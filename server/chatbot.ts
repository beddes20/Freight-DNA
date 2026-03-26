import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { sendEmail, buildFeedbackEmail } from "./emailService";
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

const anthropic = new Anthropic({
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
});

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
        tp.contactId !== null && myContactIds.includes(tp.contactId) && tp.date >= firstOfMonth
      ).length;
      const touchpoints30d = allTouchpoints.filter(tp => tp.contactId !== null && myContactIds.includes(tp.contactId)).length;
      ctx += `- ${u.name} (${u.role.replace(/_/g, " ")}): ${myCompanies.length} accounts, ${myContactIds.length} contacts total, ${contactsThisMonth} new contacts this month, ${touchpointsThisMonth} touchpoints this month, ${touchpoints30d} touchpoints last 30d\n`;
    });

    ctx += `\n=== ALL ACCOUNTS (${allCompanies.length}) ===\n`;
    allCompanies.slice(0, 120).forEach(c => {
      const rep = allUsers.find(u => u.id === c.assignedTo);
      const modes = (c as any).shippingModes?.length ? ` [Modes: ${(c as any).shippingModes.join(", ")}]` : "";
      ctx += `- ${c.name}${c.financialAlias ? ` (alias: ${c.financialAlias})` : ""}${modes} → ${rep?.name || "Unassigned"}\n`;
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
      ctx += `- ${r.title} @ ${company?.name || "Unknown"} [Rep: ${rep?.name || "?"}] | Due: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "No due date"}\n`;
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
      const tgt = parseFloat(g.target) || 0;
      const cur = parseFloat(g.currentValue || "0") || 0;
      const pct = tgt > 0 ? Math.round((cur / tgt) * 100) : 0;
      ctx += `- ${am?.name || "?"} | ${g.metric}${g.customLabel ? ` (${g.customLabel})` : ""}: ${cur}/${tgt} (${pct}%) | Set by: ${nam?.name || "?"}\n`;
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
      const modes = (c as any).shippingModes?.length ? ` [Modes: ${(c as any).shippingModes.join(", ")}]` : "";
      ctx += `- ${c.name}${c.financialAlias ? ` (alias: ${c.financialAlias})` : ""}${modes}\n`;
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
      ctx += `- ${r.title} @ ${company?.name || "Unknown"} | Due: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "No due date"}\n`;
    });

    ctx += `\n=== OPEN TASKS (${openTasks.length}) ===\n`;
    openTasks.forEach((t) => {
      ctx += `- ${t.title}${t.dueDate ? ` | Due: ${new Date(t.dueDate).toLocaleDateString()}` : ""}\n`;
    });

    ctx += `\n=== GOALS (${activeGoals.length}) ===\n`;
    activeGoals.forEach((g) => {
      const tgt = parseFloat(g.target) || 0;
      const cur = parseFloat(g.currentValue || "0") || 0;
      const pct = tgt > 0 ? Math.round((cur / tgt) * 100) : 0;
      ctx += `- ${g.metric}${g.customLabel ? ` (${g.customLabel})` : ""}: ${cur}/${tgt} (${pct}%)\n`;
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
      console.error("Failed to create chatbot conversation:", err);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  app.delete("/api/chatbot/conversations/:id", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
    try {
      const id = parseInt(req.params.id as string);
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
        .where(eq(chatMessages.conversationId, parseInt(req.params.id as string)))
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

    const conversationId = parseInt(req.params.id as string);
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

      const systemPrompt = `You are DNA Guru, an AI assistant built into the OrgChart CRM for Value Truck transportation brokerage. You have access to live CRM data.

Current user: ${user.name} (${user.role.replace(/_/g, " ")})
Data scope: ${scopeLabel}

Here is the current CRM data:
${crmContext}

Keep it short and casual — reps are busy. No fluff, no filler.
- Use the data above to answer questions about accounts, contacts, RFPs, touchpoints, tasks, and goals
- For ranking questions use the TEAM MEMBERS section for per-rep stats
- Bullet points for lists, plain sentences otherwise
- If data isn't there, just say so
- Talk like a sharp colleague, not a corporate assistant
- When the user says they want to LOG A CALL, LOG AN EMAIL, LOG A TEXT, LOG A VISIT, or LOG A TOUCHPOINT — use the log_touchpoint tool
- When the user says they want to CREATE A TASK, SET A REMINDER, or ADD A TO-DO — use the create_task tool`;

      const tools: any[] = [
        {
          type: "function",
          function: {
            name: "log_touchpoint",
            description: "Log a touchpoint/interaction (call, email, text, or site visit) with a contact. Use this when the user wants to log or record a call, email, text, or meeting.",
            parameters: {
              type: "object",
              properties: {
                company_name: { type: "string", description: "Name of the company/account (as it appears in the CRM)" },
                contact_name: { type: "string", description: "Name of the contact person (leave empty if not specified)" },
                type: { type: "string", enum: ["call", "email", "text", "site_visit"], description: "Type of interaction" },
                note: { type: "string", description: "Brief note about what was discussed or the outcome" },
              },
              required: ["type"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "create_task",
            description: "Create a new task or reminder. Use this when the user wants to set a reminder, create a to-do, or follow up on something.",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "Clear, actionable task title" },
                due_date: { type: "string", description: "Due date in YYYY-MM-DD format (optional, omit if not mentioned)" },
              },
              required: ["title"],
            },
          },
        },
      ];

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
        tools,
        tool_choice: "auto",
        stream: true,
        max_tokens: 1200,
      });

      let fullResponse = "";
      let toolCallName = "";
      let toolCallArgs = "";

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        // Streaming text content
        if (delta?.content) {
          fullResponse += delta.content;
          res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
        }

        // Accumulate tool call data
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.function?.name) toolCallName += tc.function.name;
            if (tc.function?.arguments) toolCallArgs += tc.function.arguments;
          }
        }

        // Tool call complete — emit action event
        if (choice?.finish_reason === "tool_calls" && toolCallName) {
          try {
            const args = JSON.parse(toolCallArgs);
            const actionResponse = `I can do that for you. Here's what I'll log:`;
            fullResponse += actionResponse;
            res.write(`data: ${JSON.stringify({ content: actionResponse })}\n\n`);
            res.write(`data: ${JSON.stringify({ action: { tool: toolCallName, args } })}\n\n`);
            toolCallName = "";
            toolCallArgs = "";
          } catch (parseErr) {
            console.error("Tool call parse error:", parseErr);
          }
        }
      }

      await db.insert(chatMessages).values({
        conversationId,
        role: "assistant",
        content: fullResponse || "(action proposed)",
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

      // Determine type label from content prefix
      const trimmed = content.trim();
      const firstLine = trimmed.split("\n")[0].toUpperCase();
      const isBug = firstLine.includes("BUG");
      const isImprovement = firstLine.includes("IMPROVEMENT");
      const typeLabel = isBug ? "Bug Report" : isImprovement ? "Improvement Request" : "Feature Request";
      const typeEmoji = isBug ? "🐛" : isImprovement ? "🔧" : "✨";
      const taskTitle = `${typeEmoji} ${typeLabel} from ${submitter.name}`;
      const bodyPreview = trimmed; // store full content so admin can read the whole request
      const now = new Date().toISOString();

      const allAdmins = await db.select().from(users).where(eq(users.role, "admin"));
      const admins = allAdmins.filter((a) => a.username !== "jordan.baumgart@valuetruck.com");
      const feedbackType: "bug" | "improvement" | "feature" = isBug ? "bug" : isImprovement ? "improvement" : "feature";
      const portalUrl = process.env.APP_URL || "https://sales-org-builder.replit.app";

      for (const admin of admins) {
        await db.insert(notifications).values({
          userId: admin.id,
          type: "app_suggestion",
          title: taskTitle,
          body: bodyPreview,
          link: "/tasks",
          read: false,
          relatedId: suggestion.id,
        });

        await db.insert(tasks).values({
          title: taskTitle,
          notes: trimmed,
          status: "open",
          assignedTo: admin.id,
          assignedBy: req.session.userId,
          createdAt: now,
        });

        // Send branded email notification to admin (ValueTruck + freight-dna)
        if (admin.username) {
          const html = buildFeedbackEmail({
            submitterName: submitter.name,
            submitterEmail: submitter.username,
            type: feedbackType,
            content: trimmed,
            portalUrl,
          });
          const subject = `[Freight DNA] ${taskTitle}`;
          sendEmail({ to: admin.username, subject, html })
            .catch((e) => console.error("Feedback email error:", e));
          sendEmail({ to: "info@freight-dna.com", subject, html })
            .catch((e) => console.error("Feedback email (freight-dna) error:", e));
        }
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

  app.post("/api/analyze/stream", async (req: Request, res: Response) => {
    if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });

    const { contextType, contextData, messages: history = [], question } = req.body as {
      contextType: "rfp" | "financial" | "historical";
      contextData: string;
      messages: { role: "user" | "assistant"; content: string }[];
      question: string;
    };

    if (!question?.trim()) return res.status(400).json({ error: "Question required" });

    const ANALYST_RULES = `
## How to analyze this data

You are a senior spreadsheet analyst. Apply these rules to every question:

**Inspection rules**
- Work through the data sheet by sheet (or section by section when the context groups data that way).
- Treat text values as exact strings. Do not normalize unless the user explicitly asks.
- When grouping names, categories, or labels, first normalize them yourself: trim whitespace, standardize case, and identify obvious variants (e.g. "Spot" vs "spot" vs "SPOT" are the same). Explain the normalization you applied before presenting the rollup.
- Analyze records individually before aggregating them.
- If a column contains mixed formats, detect each format separately and report them.
- Do not guess. If the data is ambiguous, show the competing interpretations side by side.
- If the dataset is large, tell the user which rows, sheets, or ranges you examined in this pass.

**Required output structure**
Always reason through these steps in order — do not skip to a final answer first:

Step 1 — Data structure map: what columns/fields are present, their types, and any irregularities.
Step 2 — Data quality issues: nulls, duplicates, mixed formats, encoding problems, outliers.
Step 3 — Row-level observations: what you see at the individual record level before any grouping.
Step 4 — Pattern detection after normalization: rollups, trends, rankings — computed after applying the normalization described above.
Step 5 — Exceptions and edge cases: rows that do not fit the dominant pattern; anomalies worth flagging.
Step 6 — Final answer with evidence: your direct answer to the user's question, citing specific rows, columns, or computed values from the steps above.

Do not produce a single polished summary first. Show your intermediate reasoning so the user can verify each step.`;

    const systemPrompts: Record<string, string> = {
      rfp: `You are a freight brokerage sales analyst specializing in RFP analysis. You have deep expertise in transportation lanes, freight volumes, equipment types, and carrier networks. Your job is to analyze RFP data and help the sales team identify opportunities, prioritize lanes, and develop winning strategies.

The context includes the RFP metadata, high-volume lanes, a column listing from the actual RFP spreadsheet, top lanes by volume, and a RAW RFP DATA SAMPLE section with up to 150 actual rows in pipe-delimited format. Use the raw rows to answer questions about specific lanes, equipment types, or column values not captured in the summary.

Be specific and actionable. Reference actual lane data, volumes, origin/destination states, and column values from the context. When you identify an opportunity or recommendation, make it concrete enough that it could become a task.
${ANALYST_RULES}`,

      financial: `You are a freight brokerage financial analyst with direct access to the full spreadsheet data. You have deep expertise in load data, revenue trends, rep performance, lane economics, and customer analysis.

The context includes:
(1) Column names from the actual uploaded spreadsheet
(2) Unique values for categorical columns (Order Type, Tender Method, etc.)
(3) MONTHLY BREAKDOWN sections — one per detected date column — computed from EVERY row in the file. Each month shows total loads, revenue, and breakdowns by order type (e.g. Spot, Contract) and by rep. USE THESE SECTIONS to answer any question involving a specific month, date range, or order type filter. These are exact counts, not estimates.
(4) Aggregated summaries (top reps/customers/lanes, computed from all rows)
(5) A RAW DATA SAMPLE (up to 3,000 rows) for record-level lookups

When asked about a specific month (e.g. "how many spot loads in March"), look in the MONTHLY BREAKDOWN section for that month and read the "Order Types" line. Give the exact number. Never say you can't filter by date — the monthly breakdowns provide this data for every month in the dataset.
${ANALYST_RULES}`,

      historical: `You are a freight network analyst specializing in historical delivery pattern analysis for transportation brokers. You have deep expertise in lane density, delivery zone mapping, hub analysis, and identifying freight opportunities from historical data.

The context includes: (1) ALL unique delivery destinations (up to 200) with total loads, average weekly frequency, and peak weekly loads — hot zones are marked 🔥, and (2) CITY-TO-CITY LANE CORRIDORS (up to 200 top corridors) showing every origin → destination pair and how many loads moved on that lane. Use both sections to answer questions about specific lanes, cities, states, or shipping patterns.

Be specific and insight-driven. Reference actual cities, states, corridors, and load counts from the context. Identify patterns, hot zones, and underserved lanes. When you find an opportunity, make it actionable.
${ANALYST_RULES}`,
    };

    const systemPrompt = systemPrompts[contextType] || systemPrompts.rfp;

    const chatMessages: { role: "user" | "assistant"; content: string }[] = [
      ...history,
      { role: "user", content: question.trim() },
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: `${systemPrompt}\n\n=== DATA CONTEXT ===\n${contextData}`,
        messages: chatMessages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          const content = event.delta.text;
          if (content) {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      console.error("Analyze stream error:", err);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Analysis failed. Please try again." })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to analyze data" });
      }
    }
  });

  app.post("/api/ai/talking-points", async (req: Request, res: Response) => {
    try {
      const { company, contacts: contactList, touchpoints: tps, tasks: tsks, rfps: rfpList, financialSummary, accountIntelligence } = req.body;
      if (!company) return res.status(400).json({ error: "Company data required" });

      const lastTouches = (contactList || []).slice(0, 6).map((c: any) => {
        const last = (tps || []).filter((t: any) => t.contactId === c.id).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
        return `${c.name}${c.title ? ` (${c.title})` : ""}: last touch ${last ? `${last.type} on ${last.date}` : "never"}`;
      }).join("\n");

      const openRfps = (rfpList || []).filter((r: any) => r.status === "open" || r.status === "pending");
      const overdueTasks = (tsks || []).filter((t: any) => t.status === "open" && t.dueDate && new Date(t.dueDate) < new Date());

      const rfpsWithDeadlines = (rfpList || []).map((r: any) => {
        const daysLeft = r.dueDate ? Math.ceil((new Date(r.dueDate).getTime() - Date.now()) / 86400000) : null;
        return { ...r, daysLeft };
      });
      const urgentRfps = rfpsWithDeadlines.filter((r: any) => r.daysLeft !== null && r.daysLeft <= 14 && r.daysLeft >= 0);
      const openTasksList = (tsks || []).filter((t: any) => t.status === "open");

      const prompt = `You are a freight broker sales coach. Help prep for a call with ${company.name}${company.industry ? ` (${company.industry})` : ""}.

${(req.body.accountSummary) ? `Current account status: ${req.body.accountSummary}\n` : ""}Key contacts:\n${lastTouches || "None on file"}
${financialSummary ? `\nFinancials YTD: ${financialSummary.ytdLoads ?? "?"} loads, $${Number(financialSummary.ytdMargin ?? 0).toLocaleString()} margin` : ""}
${urgentRfps.length > 0 ? `\nURGENT — RFPs due soon: ${urgentRfps.map((r: any) => `${r.title} (${r.daysLeft}d)`).join(", ")}` : openRfps.length > 0 ? `\nOpen RFPs: ${openRfps.map((r: any) => r.title).join(", ")}` : ""}
${overdueTasks.length > 0 ? `\nOverdue tasks: ${overdueTasks.map((t: any) => t.title).join(", ")}` : openTasksList.length > 0 ? `\nOpen tasks: ${openTasksList.slice(0, 3).map((t: any) => t.title).join(", ")}` : ""}
${accountIntelligence?.quirks ? `\nAccount quirks: ${accountIntelligence.quirks}` : ""}
${accountIntelligence?.spotProcess ? `\nSpot process: ${accountIntelligence.spotProcess}` : ""}
${accountIntelligence?.tenderStyle ? `\nTender style: ${accountIntelligence.tenderStyle}` : ""}

Generate exactly 3 sharp, specific talking points for this call. Each is 1-2 sentences. Be direct and actionable — reference the specific account details above. No generic freight advice. Numbered list.`;

      const message = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });

      const text = message.content[0].type === "text" ? message.content[0].text : "";
      const lines = text.split(/\n/).map((l: string) => l.trim()).filter(Boolean);
      const points = lines.filter((l: string) => l.match(/^\d[\.\)]/)).map((l: string) => l.replace(/^\d[\.\)]\s*/, ""));
      res.json({ points: points.length >= 2 ? points.slice(0, 3) : lines.slice(0, 3) });
    } catch (err: any) {
      console.error("Talking points error:", err);
      res.status(500).json({ error: "Failed to generate talking points" });
    }
  });
}
