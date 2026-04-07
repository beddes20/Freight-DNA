import type { Express } from "express";
import { storage } from "../storage";
import { getCurrentUser, canAccessCompany, requireAuth } from "../auth";

export function registerTaskRoutes(app: Express) {
  // ── Task Assignment ──────────────────────────────────────────────────────────

  app.get("/api/tasks", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allTasks = await storage.getTasks();
      let filtered: typeof allTasks;
      if (user.role === "admin") {
        filtered = allTasks;
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        filtered = allTasks.filter(t => teamIds.includes(t.assignedTo) || teamIds.includes(t.assignedBy));
      } else {
        filtered = allTasks.filter(t => t.assignedTo === user.id || t.assignedBy === user.id);
      }
      const counts = await storage.getTaskCommentCounts(filtered.map(t => t.id));
      return res.json(filtered.map(t => ({ ...t, commentCount: counts[t.id] ?? 0 })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  app.get("/api/tasks/company/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(user, (req.params.companyId as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const companyTasks = await storage.getTasksByCompany((req.params.companyId as string));
      const counts = await storage.getTaskCommentCounts(companyTasks.map(t => t.id));
      res.json(companyTasks.map(t => ({ ...t, commentCount: counts[t.id] ?? 0 })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch company tasks" });
    }
  });

  app.post("/api/tasks", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { title, notes, status, dueDate, assignedTo, companyId, contactId, attachedLaneData } = req.body;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required" });
      }
      if (!assignedTo || typeof assignedTo !== "string") {
        return res.status(400).json({ error: "Assignee is required" });
      }
      const validStatuses = ["open", "in_progress", "completed"];
      const taskStatus = status && validStatuses.includes(status) ? status : "open";
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      const allUsers = await storage.getUsers(req.session.organizationId!);
      let assignableIds: Set<string>;
      if (user.role === "admin") {
        assignableIds = new Set(allUsers.map(u => u.id));
      } else if (user.role === "director" || user.role === "national_account_manager" || user.role === "sales" || user.role === "sales_director") {
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        assignableIds = new Set(teamIds);
        if (user.managerId) assignableIds.add(user.managerId);
        allUsers.filter(u => u.role === "admin").forEach(u => assignableIds.add(u.id));
      } else {
        assignableIds = new Set([user.id]);
        if (user.managerId) {
          assignableIds.add(user.managerId);
          allUsers.forEach(u => {
            if (u.managerId === user.managerId) assignableIds.add(u.id);
          });
        }
        allUsers.filter(u => u.role === "admin").forEach(u => assignableIds.add(u.id));
      }
      if (!assignableIds.has(assignedTo)) {
        return res.status(403).json({ error: "Cannot assign task to that user" });
      }
      if (companyId && !(await canAccessCompany(user, companyId))) {
        return res.status(403).json({ error: "Cannot link task to inaccessible company" });
      }
      const task = await storage.createTask({
        title: title.trim(),
        notes: notes || null,
        status: taskStatus,
        dueDate: dueDate || null,
        assignedTo,
        assignedBy: user.id,
        companyId: companyId || null,
        contactId: contactId || null,
        attachedLaneData: attachedLaneData ?? null,
        createdAt: new Date().toISOString(),
      });
      if (assignedTo !== user.id) {
        storage.createNotification({
          userId: assignedTo,
          type: "task_assigned",
          title: `${user.name} assigned you a task`,
          body: title.trim(),
          link: "/tasks",
          relatedId: task.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.status(201).json(task);
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(500).json({ error: "Failed to create task" });
    }
  });

  app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getTask((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Task not found" });
      if (existing.assignedTo !== user.id && existing.assignedBy !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized to edit this task" });
      }
      const validStatuses = ["open", "in_progress", "completed"];
      const data: any = {};
      if (req.body.title !== undefined) {
        const trimmed = String(req.body.title).trim();
        if (!trimmed) return res.status(400).json({ error: "Title cannot be empty" });
        data.title = trimmed;
      }
      if (req.body.notes !== undefined) data.notes = req.body.notes;
      if (req.body.status !== undefined) {
        if (!validStatuses.includes(req.body.status)) {
          return res.status(400).json({ error: "Invalid status. Must be open, in_progress, or completed" });
        }
        data.status = req.body.status;
      }
      if (req.body.dueDate !== undefined) {
        if (req.body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate)) {
          return res.status(400).json({ error: "Invalid date format" });
        }
        data.dueDate = req.body.dueDate;
      }
      if (req.body.assignedTo !== undefined) {
        data.assignedTo = req.body.assignedTo;
      }
      const task = await storage.updateTask((req.params.id as string), data);
      if (data.assignedTo && data.assignedTo !== existing.assignedTo && data.assignedTo !== user.id) {
        storage.createNotification({
          userId: data.assignedTo,
          type: "task_assigned",
          title: `${user.name} assigned you a task`,
          body: task?.title ?? existing.title,
          link: "/tasks",
          relatedId: existing.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      const justCompleted = data.status === "completed" && existing.status !== "completed";
      const completionNote = typeof req.body.completionNote === "string" ? req.body.completionNote.trim() : "";
      if (justCompleted && existing.assignedBy && existing.assignedBy !== user.id) {
        if (completionNote) {
          await storage.createTaskComment({
            taskId: existing.id,
            authorId: user.id,
            content: completionNote,
            createdAt: new Date().toISOString(),
            parentId: null,
          }).catch((e) => console.error("Completion note comment error:", e));
        }
        const notifyBody = completionNote
          ? `${task?.title ?? existing.title} — "${completionNote}"`
          : task?.title ?? existing.title;
        storage.createNotification({
          userId: existing.assignedBy,
          type: "task_completed",
          title: `${user.name} completed a task`,
          body: notifyBody,
          link: "/tasks",
          relatedId: existing.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.json(task);
    } catch (error) {
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  app.delete("/api/tasks/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getTask((req.params.id as string));
      if (!existing) return res.status(404).json({ error: "Task not found" });
      if (existing.assignedBy !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the creator or admin can delete tasks" });
      }
      await storage.deleteTask((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete task" });
    }
  });

  // ── Task Comments ────────────────────────────────────────────────────────

  app.get("/api/tasks/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comments = await storage.getTaskComments((req.params.id as string));
      res.json(comments);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  });

  app.post("/api/tasks/:id/comments", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { content, parentId } = req.body;
      if (!content?.trim()) return res.status(400).json({ error: "Content is required" });
      const task = await storage.getTask((req.params.id as string));
      if (!task) return res.status(404).json({ error: "Task not found" });
      const comment = await storage.createTaskComment({
        taskId: (req.params.id as string),
        authorId: user.id,
        content: content.trim(),
        createdAt: new Date().toISOString(),
        parentId: parentId || null,
      });
      const existingComments = await storage.getTaskComments((req.params.id as string));
      const threadParticipants = existingComments.map(c => c.authorId);
      const notifyIds = [...new Set([task.assignedTo, task.assignedBy, ...threadParticipants])].filter(
        (id): id is string => !!id && id !== user.id
      );
      for (const uid of notifyIds) {
        storage.createNotification({
          userId: uid,
          type: "task_comment",
          title: `${user.name} commented on a task`,
          body: task.title,
          link: "/tasks",
          relatedId: task.id,
          read: false,
        }).catch((e) => console.error("Notification error:", e));
      }
      res.status(201).json(comment);
    } catch (error) {
      res.status(500).json({ error: "Failed to create comment" });
    }
  });

  app.post("/api/tasks/:id/bump", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const task = await storage.getTask((req.params.id as string));
      if (!task) return res.status(404).json({ error: "Task not found" });
      if (task.assignedBy !== user.id) return res.status(403).json({ error: "Only the task creator can send a reminder" });
      if (task.status === "completed") return res.status(400).json({ error: "Task is already completed" });
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const due = task.dueDate ? new Date(task.dueDate + "T00:00:00") : null;
      if (!due) return res.status(400).json({ error: "Task has no due date" });
      const daysOverdue = Math.floor((today.getTime() - due.getTime()) / 86400000);
      if (daysOverdue < 2) return res.status(400).json({ error: "Task must be at least 2 days overdue to send a reminder" });
      storage.createNotification({
        userId: task.assignedTo,
        type: "task_reminder",
        title: `Reminder from ${user.name}`,
        body: `"${task.title}" is ${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue`,
        link: "/tasks",
        relatedId: task.id,
        read: false,
      }).catch((e) => console.error("Notification error:", e));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to send reminder" });
    }
  });

  app.delete("/api/tasks/:taskId/comments/:commentId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const comments = await storage.getTaskComments((req.params.taskId as string));
      const comment = comments.find(c => c.id === (req.params.commentId as string));
      if (!comment) return res.status(404).json({ error: "Comment not found" });
      if (comment.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Not authorized" });
      }
      await storage.deleteTaskComment((req.params.commentId as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete comment" });
    }
  });
}
