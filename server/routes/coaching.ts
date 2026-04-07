import type { Express } from "express";
import { storage } from "../storage";
import { getCurrentUser, requireAuth } from "../auth";

export function registerCoachingRoutes(app: Express) {
  // ── 1-on-1 Sessions ────────────────────────────────────────────────────────

  app.get("/api/1on1/session", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId, repId } = req.query as { managerId?: string; repId?: string };
      if (!managerId || !repId) return res.status(400).json({ error: "managerId and repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === managerId || user.id === repId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const session = await storage.getOrCreateActiveSession(managerId, repId);
      const topics = await storage.getTopicsBySession(session.id);
      res.json({ session, topics });
    } catch (error) {
      res.status(500).json({ error: "Failed to get session" });
    }
  });

  app.post("/api/1on1/session/:id/topics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { text, tag } = req.body;
      if (!text?.trim()) return res.status(400).json({ error: "Text required" });
      const topic = await storage.createTopic({
        sessionId: (req.params.id as string),
        addedById: user.id,
        text: text.trim(),
        tag: tag || "fyi",
        status: "pending",
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(topic);
    } catch (error) {
      res.status(500).json({ error: "Failed to add topic" });
    }
  });

  app.patch("/api/1on1/topics/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: "Status required" });
      const updated = await storage.updateTopicStatus((req.params.id as string), status);
      if (!updated) return res.status(404).json({ error: "Topic not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update topic" });
    }
  });

  app.delete("/api/1on1/topics/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const deleted = await storage.deleteTopic((req.params.id as string));
      if (!deleted) return res.status(404).json({ error: "Topic not found" });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete topic" });
    }
  });

  app.post("/api/1on1/session/:id/close", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { carryForwardTopicIds, moraleScore, sessionSummary, sendSummaryEmail } = req.body || {};
      const oldSession = await storage.getSession((req.params.id as string));
      const newSession = await storage.closeSession((req.params.id as string), {
        carryForwardTopicIds: Array.isArray(carryForwardTopicIds) ? carryForwardTopicIds : undefined,
        moraleScore: typeof moraleScore === "number" ? moraleScore : undefined,
        sessionSummary: typeof sessionSummary === "string" && sessionSummary.trim() ? sessionSummary.trim() : undefined,
      });
      if (sendSummaryEmail && oldSession) {
        try {
          const { build1on1SummaryEmail, sendEmail } = await import("../emailService");
          const topics = await storage.getTopicsBySession((req.params.id as string));
          const allUsers = await storage.getUsers(user.organizationId);
          const nam = allUsers.find(u => u.id === oldSession.namId);
          const am = allUsers.find(u => u.id === oldSession.amId);
          if (nam?.username && am?.username) {
            const html = build1on1SummaryEmail({ session: { ...oldSession, moraleScore: moraleScore ?? null, sessionSummary: sessionSummary ?? null }, topics, namName: nam.name, amName: am.name });
            await sendEmail({ to: nam.username, subject: `1:1 Session Recap — ${am.name}`, html });
            await sendEmail({ to: am.username, subject: `1:1 Session Recap — with ${nam.name}`, html });
          }
        } catch (emailErr) {
          console.error("[1on1] summary email error:", emailErr);
        }
      }
      res.json({ ...newSession });
    } catch (error) {
      res.status(500).json({ error: "Failed to close session" });
    }
  });

  app.get("/api/1on1/archived", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId, repId } = req.query as { managerId?: string; repId?: string };
      if (!managerId || !repId) return res.status(400).json({ error: "managerId and repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === managerId || user.id === repId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const sessions = await storage.getArchivedSessions(managerId, repId);
      const sessionsWithTopics = await Promise.all(
        sessions.map(async (s) => ({
          ...s,
          topics: await storage.getTopicsBySession(s.id),
        }))
      );
      res.json(sessionsWithTopics);
    } catch (error) {
      res.status(500).json({ error: "Failed to get archived sessions" });
    }
  });

  app.patch("/api/1on1/session/:id/meeting-date", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { meetingDate } = req.body;
      const session = await storage.getSession((req.params.id as string));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionMeetingDate((req.params.id as string), meetingDate || null);
      if (!updated) return res.status(404).json({ error: "Session not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update meeting date" });
    }
  });

  app.patch("/api/1on1/session/:id/meeting-link", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { meetingLink } = req.body;
      if (meetingLink !== undefined && meetingLink !== null && meetingLink !== "" && typeof meetingLink !== "string") {
        return res.status(400).json({ error: "meetingLink must be a string or null" });
      }
      let normalizedLink: string | null = null;
      if (meetingLink && typeof meetingLink === "string" && meetingLink.trim()) {
        const trimmed = meetingLink.trim();
        try {
          const url = new URL(trimmed);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return res.status(400).json({ error: "Meeting link must use http or https" });
          }
        } catch {
          return res.status(400).json({ error: "Invalid URL format" });
        }
        if (trimmed.length > 2048) {
          return res.status(400).json({ error: "Meeting link is too long" });
        }
        normalizedLink = trimmed;
      }
      const session = await storage.getSession((req.params.id as string));
      if (!session) return res.status(404).json({ error: "Session not found" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionMeetingLink((req.params.id as string), normalizedLink);
      if (!updated) return res.status(404).json({ error: "Session not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update meeting link" });
    }
  });

  app.patch("/api/1on1/session/:id/notes", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { notes } = req.body;
      if (typeof notes !== "string") return res.status(400).json({ error: "Notes must be a string" });
      const session = await storage.getSession((req.params.id as string));
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.status !== "active") return res.status(400).json({ error: "Cannot update notes on an archived session" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === session.namId || user.id === session.amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const updated = await storage.updateSessionNotes((req.params.id as string), notes);
      if (!updated) return res.status(404).json({ error: "Session not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update notes" });
    }
  });

  app.get("/api/1on1/action-items", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId, repId } = req.query as { managerId?: string; repId?: string };
      if (!managerId || !repId) return res.status(400).json({ error: "managerId and repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === managerId || user.id === repId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const actionItems = await storage.getActionItemsByPairing(managerId, repId);
      res.json(actionItems);
    } catch (error) {
      res.status(500).json({ error: "Failed to get action items" });
    }
  });

  app.get("/api/1on1/manager-overview", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { managerId } = req.query as { managerId?: string };
      if (!managerId) return res.status(400).json({ error: "managerId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isSelf = user.id === managerId;
      if (!isAdmin && !isSelf) return res.status(403).json({ error: "Access denied" });
      const activeSessions = await storage.getActiveSessionsForManager(managerId);
      const overview = await Promise.all(
        activeSessions.map(async (s) => {
          const topics = await storage.getTopicsBySession(s.id);
          const archived = await storage.getArchivedSessions(managerId, s.amId);
          const lastClosed = archived.length > 0
            ? archived.sort((a, b) => new Date(b.closedAt || b.startDate).getTime() - new Date(a.closedAt || a.startDate).getTime())[0]
            : null;
          const daysSinceClose = lastClosed?.closedAt
            ? Math.round((Date.now() - new Date(lastClosed.closedAt).getTime()) / 86400000)
            : null;
          return {
            amId: s.amId,
            sessionId: s.id,
            startDate: s.startDate,
            pendingCount: topics.filter(t => t.status === "pending").length,
            discussedCount: topics.filter(t => t.status === "discussed").length,
            totalCount: topics.length,
            lastClosedAt: lastClosed?.closedAt ?? null,
            daysSinceClose,
          };
        })
      );
      res.json(overview);
    } catch (error) {
      res.status(500).json({ error: "Failed to get manager overview" });
    }
  });

  // ── Suggested topics for 1:1 based on rep's account data ──────────────────

  app.get("/api/1on1/suggested-topics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { repId } = req.query as { repId?: string };
      if (!repId) return res.status(400).json({ error: "repId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director" || user.role === "national_account_manager";
      const isSelf = user.id === repId;
      if (!isAdmin && !isSelf) return res.status(403).json({ error: "Access denied" });

      const suggestions: { type: string; text: string; account?: string }[] = [];
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000).toISOString();
      const fourteenDaysFromNow = new Date(today.getTime() + 14 * 86400000).toISOString().split("T")[0];

      const repUser = await storage.getUser(repId);
      if (!repUser) return res.status(404).json({ error: "User not found" });

      const allCompanies = await storage.getCompanies(repUser.organizationId || "");
      const repCompanies = allCompanies.filter(c => c.salesPersonId === repId || c.assignedTo === repId);

      const meaningfulTouchpoints = await storage.getTouchpointsByUser(repId, thirtyDaysAgo);
      const recentMeaningfulIds = new Set(meaningfulTouchpoints.filter(tp => tp.isMeaningful).map(tp => tp.companyId).filter(Boolean));
      const overdueAccounts = repCompanies.filter(c => !recentMeaningfulIds.has(c.id)).slice(0, 3);
      for (const co of overdueAccounts) {
        suggestions.push({
          type: "attention",
          text: `${co.name} hasn't had a meaningful conversation in 30+ days — what's the current status?`,
          account: co.name,
        });
      }

      const allRfps = await storage.getRfps();
      const repCompanyIds = new Set(repCompanies.map(c => c.id));
      const urgentRfps = allRfps
        .filter(r => repCompanyIds.has(r.companyId || "") && r.status === "open" && r.dueDate && r.dueDate <= fourteenDaysFromNow && r.dueDate >= todayStr)
        .slice(0, 2);
      for (const rfp of urgentRfps) {
        const company = repCompanies.find(c => c.id === rfp.companyId);
        const daysLeft = rfp.dueDate ? Math.round((new Date(rfp.dueDate + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
        suggestions.push({
          type: "rfp",
          text: `RFP for ${company?.name ?? "an account"} is due in ${daysLeft !== null ? `${daysLeft} day${daysLeft !== 1 ? "s" : ""}` : "soon"} — are we ready to submit?`,
          account: company?.name,
        });
      }

      const allTasks = await storage.getTasks();
      const overdueTasks = allTasks
        .filter(t => t.assignedTo === repId && t.status !== "completed" && t.dueDate && t.dueDate < todayStr)
        .slice(0, 3);
      if (overdueTasks.length > 0) {
        suggestions.push({
          type: "tasks",
          text: `You have ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""} — let's pick one to close out this week`,
        });
      }

      res.json(suggestions);
    } catch (error) {
      res.status(500).json({ error: "Failed to get suggested topics" });
    }
  });

  // ── Development Goals ──────────────────────────────────────────────────────

  app.get("/api/1on1/dev-goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { namId, amId } = req.query as { namId?: string; amId?: string };
      if (!namId || !amId) return res.status(400).json({ error: "namId and amId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === namId || user.id === amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const record = await storage.getDevelopmentGoals(namId, amId);
      res.json({ content: record?.content ?? "", updatedAt: record?.updatedAt ?? null });
    } catch (error) {
      res.status(500).json({ error: "Failed to get development goals" });
    }
  });

  app.patch("/api/1on1/dev-goals", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { namId, amId } = req.query as { namId?: string; amId?: string };
      if (!namId || !amId) return res.status(400).json({ error: "namId and amId required" });
      const isAdmin = user.role === "admin" || user.role === "director" || user.role === "sales_director";
      const isInvolved = user.id === namId || user.id === amId;
      if (!isAdmin && !isInvolved) return res.status(403).json({ error: "Access denied" });
      const { content } = req.body;
      if (typeof content !== "string") return res.status(400).json({ error: "Content must be a string" });
      const record = await storage.upsertDevelopmentGoals(namId, amId, content, user.id);
      res.json({ content: record.content, updatedAt: record.updatedAt });
    } catch (error) {
      res.status(500).json({ error: "Failed to save development goals" });
    }
  });

  // ── 1:1 Prep Summary ──────────────────────────────────────────────────────

  app.get("/api/1on1/prep-summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const amId = req.query.amId as string;
      if (!amId) return res.status(400).json({ error: "amId required" });

      const allUsers = await storage.getUsers(user.organizationId);
      const amUser = allUsers.find(u => u.id === amId);
      if (!amUser) return res.status(404).json({ error: "User not found" });

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const [allCompanies, allTouchpoints, allTasks, amGoals, allSessions] = await Promise.all([
        storage.getCompanies(user.organizationId),
        storage.getTouchpoints(),
        storage.getTasks(),
        storage.getGoals({ amId }),
        storage.getAllSessions(),
      ]);

      const myCompanies = allCompanies.filter(c => !c.archivedAt && c.assignedTo === amId);
      const companyMap: Record<string, string> = Object.fromEntries(allCompanies.map(c => [c.id, c.name]));

      const lastTouchMap: Record<string, { date: string; type: string }> = {};
      for (const tp of allTouchpoints) {
        if (!lastTouchMap[tp.companyId] || tp.date > lastTouchMap[tp.companyId].date) {
          lastTouchMap[tp.companyId] = { date: tp.date, type: tp.type };
        }
      }

      const staleAccounts = myCompanies
        .filter(c => !lastTouchMap[c.id] || lastTouchMap[c.id].date < thirtyAgo)
        .map(c => ({ name: c.name, daysSince: lastTouchMap[c.id] ? Math.floor((new Date(todayStr).getTime() - new Date(lastTouchMap[c.id].date).getTime()) / (1000 * 60 * 60 * 24)) : null }))
        .sort((a, b) => (b.daysSince ?? 999) - (a.daysSince ?? 999))
        .slice(0, 8);

      const touchesThisWeek = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= weekAgo).length;
      const touchesThisMonth = allTouchpoints.filter(tp => tp.loggedById === amId && tp.date >= monthStart).length;

      const recentTouchpoints = allTouchpoints
        .filter(tp => tp.loggedById === amId && tp.date >= weekAgo)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 10)
        .map(tp => ({ companyName: companyMap[tp.companyId] ?? "Unknown", type: tp.type, date: tp.date, note: tp.notes ?? null }));

      const openTasks = allTasks.filter(t => t.assignedTo === amId && t.status === "open");

      let openTopics = 0;
      try {
        openTopics = 0;
      } catch {}

      let lastSessionDate: string | null = null;
      let daysSinceSession: number | null = null;
      try {
        const mySessions = Array.isArray(allSessions) ? allSessions.filter((s: any) => (s.repId === amId || s.managerId === amId) && s.closedAt) : [];
        if (mySessions.length > 0) {
          const lastClosed = mySessions.sort((a: any, b: any) => b.closedAt.localeCompare(a.closedAt))[0];
          lastSessionDate = lastClosed.closedAt!.slice(0, 10);
          daysSinceSession = Math.floor((new Date(todayStr).getTime() - new Date(lastSessionDate).getTime()) / (1000 * 60 * 60 * 24));
        }
      } catch {}

      const activeGoals = amGoals.filter(g => g.startDate <= todayStr && g.endDate >= todayStr);
      const goalSummary = activeGoals.map(g => ({
        metric: g.metric,
        label: (g as any).customLabel || g.metric,
        current: Number(g.currentValue ?? 0),
        target: Number(g.target ?? 0),
        pct: g.target && Number(g.target) > 0 ? Math.min(Math.round((Number(g.currentValue ?? 0) / Number(g.target)) * 100), 100) : 0,
      }));

      res.json({
        amName: amUser.name || amUser.username,
        openTopics,
        openActionItems: openTasks.length,
        touchesThisWeek,
        touchesThisMonth,
        coldAccounts: staleAccounts.length,
        lastSessionDate,
        daysSinceSession,
        goalSummary,
        recentTouchpoints,
        staleAccounts,
      });
    } catch (error) {
      console.error("Prep summary error:", error);
      res.status(500).json({ error: "Failed to load prep summary" });
    }
  });

  // ── LM Development Milestones ──────────────────────────────────────────────
  // Stored in developmentGoals table as JSON { milestones: [...] }

  app.get("/api/lm-milestones/:lmId", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { lmId } = req.params as Record<string, string>;
      const lm = await storage.getUser(lmId);
      if (!lm) return res.status(404).json({ error: "User not found" });
      const managerId = lm.managerId;
      const isSelfOrManager = viewer.id === lmId || viewer.id === managerId;
      const isAdminOrDirector = viewer.role === "admin" || viewer.role === "director" || viewer.role === "sales_director";
      let isInChain = false;
      if (!isSelfOrManager && !isAdminOrDirector) {
        const teamIds = await storage.getTeamMemberIds(viewer.id, viewer.organizationId);
        isInChain = teamIds.includes(lmId);
      }
      if (!isSelfOrManager && !isAdminOrDirector && !isInChain) return res.status(403).json({ error: "Access denied" });
      if (!managerId) return res.json({ milestones: [] });
      const row = await storage.getDevelopmentGoals(managerId, lmId);
      if (!row) return res.json({ milestones: [] });
      try {
        const parsed = JSON.parse(row.content || "{}");
        return res.json({ milestones: parsed.milestones || [] });
      } catch {
        return res.json({ milestones: [] });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to get milestones" });
    }
  });

  app.put("/api/lm-milestones/:lmId", requireAuth, async (req, res) => {
    try {
      const viewer = await getCurrentUser(req);
      if (!viewer) return res.status(401).json({ error: "Not authenticated" });
      const { lmId } = req.params as Record<string, string>;
      const lm = await storage.getUser(lmId);
      if (!lm) return res.status(404).json({ error: "User not found" });
      const managerId = lm.managerId;
      const canUpdate =
        viewer.id === managerId ||
        viewer.role === "admin" ||
        viewer.id === lmId ||
        viewer.role === "director";
      if (!canUpdate) return res.status(403).json({ error: "Access denied" });
      if (!managerId) return res.status(400).json({ error: "LM has no manager assigned" });
      const { milestones } = req.body;
      const content = JSON.stringify({ milestones: milestones || [] });
      const row = await storage.upsertDevelopmentGoals(managerId, lmId, content, viewer.id);
      const parsed = JSON.parse(row.content || "{}");
      return res.json({ milestones: parsed.milestones || [] });
    } catch (error) {
      res.status(500).json({ error: "Failed to save milestones" });
    }
  });
}
