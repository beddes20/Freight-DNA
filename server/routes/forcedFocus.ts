import type { Express } from "express";
import { storage } from "../storage";
import { getCurrentUser, requireAuth } from "../auth";

const LEADERSHIP_ROLES = new Set([
  "admin",
  "director",
  "national_account_manager",
  "sales_director",
]);

export function registerForcedFocusRoutes(app: Express) {
  app.post("/api/forced-focus", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!LEADERSHIP_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers/directors can assign a Forced Focus" });
      }
      const {
        assignedToUserId,
        companyId,
        companyName,
        contactId,
        contactName,
        lever,
        actionText,
        contextReason,
        dueDate,
        relatedOpportunityId,
        relatedTaskId,
      } = req.body;
      if (!assignedToUserId || typeof assignedToUserId !== "string") {
        return res.status(400).json({ error: "assignedToUserId is required" });
      }
      if (!actionText || typeof actionText !== "string" || !actionText.trim()) {
        return res.status(400).json({ error: "actionText is required" });
      }
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      // Validate assignee is in the same org
      const orgUsers = await storage.getUsers(user.organizationId);
      const assigneeInOrg = orgUsers.some(u => u.id === assignedToUserId);
      if (!assigneeInOrg) {
        return res.status(403).json({ error: "Cannot assign to a user outside your organization" });
      }
      const ff = await storage.createForcedFocus({
        assignedToUserId,
        assignedByUserId: user.id,
        orgId: user.organizationId,
        companyId: companyId || null,
        companyName: companyName || null,
        contactId: contactId || null,
        contactName: contactName || null,
        lever: lever || null,
        actionText: actionText.trim(),
        contextReason: contextReason || null,
        dueDate: dueDate || null,
        relatedOpportunityId: relatedOpportunityId || null,
        relatedTaskId: relatedTaskId || null,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: null,
      });
      storage.createNotification({
        userId: assignedToUserId,
        type: "forced_focus_assigned",
        title: `${user.name} assigned you a Leadership Priority`,
        body: actionText.trim(),
        link: "/",
        relatedId: ff.id,
        read: false,
      }).catch((e) => console.error("Forced focus notification error:", e));
      res.status(201).json(ff);
    } catch (error) {
      console.error("Error creating forced focus:", error);
      res.status(500).json({ error: "Failed to create forced focus" });
    }
  });

  app.get("/api/forced-focus/my", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const ff = await storage.getActiveForcedFocusForUser(user.id);
      res.json(ff ?? null);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch forced focus" });
    }
  });

  app.get("/api/forced-focus/team", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!LEADERSHIP_ROLES.has(user.role)) {
        return res.status(403).json({ error: "Only managers/directors can view team priorities" });
      }
      let teamMemberIds: string[] | undefined;
      if (user.role !== "admin") {
        const ids = await storage.getTeamMemberIds(user.id, user.organizationId);
        teamMemberIds = ids.length > 0 ? ids : [];
      }
      const items = await storage.getTeamForcedFocus(user.organizationId, teamMemberIds);
      res.json(items);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch team forced focus" });
    }
  });

  app.patch("/api/forced-focus/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getForcedFocus(req.params.id as string);
      if (!existing) return res.status(404).json({ error: "Forced focus not found" });
      const isAdmin = user.role === "admin";
      if (!isAdmin && existing.orgId !== user.organizationId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const isAssignee = existing.assignedToUserId === user.id;
      const isAssigner = existing.assignedByUserId === user.id;
      if (!isAssignee && !isAssigner && !isAdmin) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const { status, actionText, contextReason, dueDate, lever, companyId, companyName } = req.body;
      if (status !== undefined) {
        const validStatuses = ["active", "completed", "dismissed"];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ error: "Invalid status" });
        }
        if (!isAssignee && !isAssigner && !isAdmin) {
          return res.status(403).json({ error: "Not authorized to change status" });
        }
        const updated = await storage.updateForcedFocusStatus(existing.id, status);
        return res.json(updated);
      }
      if (!isAssigner && !isAdmin) {
        return res.status(403).json({ error: "Only the assigner can edit details" });
      }
      if (actionText !== undefined && (!String(actionText).trim())) {
        return res.status(400).json({ error: "actionText cannot be empty" });
      }
      if (dueDate !== undefined && dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      const data: {
        actionText?: string;
        contextReason?: string | null;
        dueDate?: string | null;
        lever?: string | null;
        companyId?: string | null;
        companyName?: string | null;
      } = {};
      if (actionText !== undefined) data.actionText = String(actionText).trim();
      if (contextReason !== undefined) data.contextReason = contextReason ?? null;
      if (dueDate !== undefined) data.dueDate = dueDate ?? null;
      if (lever !== undefined) data.lever = lever ?? null;
      if (companyId !== undefined) data.companyId = companyId ?? null;
      if (companyName !== undefined) data.companyName = companyName ?? null;
      const updated = await storage.updateForcedFocus(existing.id, data);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update forced focus" });
    }
  });
}
