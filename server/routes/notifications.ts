import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { pStr } from "../lib/req";

export function registerNotificationRoutes(app: Express): void {
  // ── Notifications ─────────────────────────────────────────────────────────
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const notifs = await storage.getNotifications(user.id);
      res.json(notifs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  app.patch("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await storage.markNotificationRead((pStr(req.params.id)));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark notification read" });
    }
  });

  app.patch("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { types, ids } = (req.body || {}) as { types?: string[]; ids?: string[] };
      if (ids && Array.isArray(ids) && ids.length > 0) {
        await storage.markNotificationsReadByIds(user.id, ids);
      } else if (types && Array.isArray(types) && types.length > 0) {
        await storage.markNotificationsReadByTypes(user.id, types);
      } else {
        await storage.markAllNotificationsRead(user.id);
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark all notifications read" });
    }
  });

  // ── Personal Alerts ──────────────────────────────────────────────────────
  app.get("/api/alerts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      await storage.fireDueAlerts(user.id);
      const alerts = await storage.getPersonalAlerts(user.id);
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch alerts" });
    }
  });

  app.post("/api/alerts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { title, notes, scheduledDate, companyId } = req.body;
      if (!title || !scheduledDate) {
        return res.status(400).json({ error: "Title and scheduled date are required" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) || isNaN(new Date(scheduledDate + "T00:00:00").getTime())) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      }
      const alert = await storage.createPersonalAlert({
        userId: user.id,
        title,
        notes: notes || null,
        scheduledDate,
        companyId: companyId || null,
        fired: false,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(alert);
    } catch (error) {
      res.status(500).json({ error: "Failed to create alert" });
    }
  });

  app.delete("/api/alerts/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const deleted = await storage.deletePersonalAlert((pStr(req.params.id)), user.id);
      if (!deleted) return res.status(404).json({ error: "Alert not found" });
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete alert" });
    }
  });
}
