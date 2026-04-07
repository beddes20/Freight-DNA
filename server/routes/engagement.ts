import type { Express } from "express";
import { storage } from "../storage";
import { getCurrentUser, canAccessCompany, getVisibleCompanyIds, requireAuth } from "../auth";
import { type Callout, internalPosts as internalPostsTable } from "@shared/schema";
import { db } from "../storage";
import { eq } from "drizzle-orm";

type UserSlim = { id: string; role: string; managerId: string | null; organizationId: string };

async function getVisibleFeedAuthorIds(user: UserSlim): Promise<string[]> {
  if (user.role === "admin") {
    const orgUsers = await storage.getUsers(user.organizationId);
    return orgUsers.map(u => u.id);
  }
  if (user.role === "director" || user.role === "sales_director") {
    const ids = await storage.getTeamMemberIds(user.id, user.organizationId);
    ids.push(user.id);
    return ids;
  }
  if (user.role === "national_account_manager" || user.role === "sales") {
    const ids = await storage.getTeamMemberIds(user.id, user.organizationId);
    if (user.managerId) ids.push(user.managerId);
    ids.push(user.id);
    return ids;
  }
  const ids = new Set<string>([user.id]);
  if (user.managerId) ids.add(user.managerId);
  return Array.from(ids);
}

export function registerEngagementRoutes(app: Express) {
  // ── Callouts ─────────────────────────────────────────────────────────────

  app.get("/api/callouts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const allCallouts = await storage.getCallouts();
      const visibleIds = await getVisibleCompanyIds(user);
      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      const filtered = visibleIds === null
        ? allCallouts
        : allCallouts.filter(c => {
            const companyOk = !c.companyId || visibleIds.includes(c.companyId);
            const authorOk = !visibleAuthorIds || visibleAuthorIds.includes(c.authorId);
            return companyOk && authorOk;
          });
      res.json(filtered);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch callouts" });
    }
  });

  app.get("/api/callouts/company/:companyId", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(user, (req.params.companyId as string)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const companyCallouts = await storage.getCalloutsByCompany((req.params.companyId as string));
      res.json(companyCallouts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch company callouts" });
    }
  });

  app.post("/api/callouts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { title, body, tag, companyId, parentId } = req.body;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Title is required" });
      }
      const validTags = ["Trend", "Callout", "Idea"];
      if (tag && !validTags.includes(tag)) {
        return res.status(400).json({ error: "Invalid tag" });
      }
      let parentCallout: Awaited<ReturnType<typeof storage.getCallout>> = undefined;
      if (parentId) {
        parentCallout = await storage.getCallout(parentId);
        if (!parentCallout) return res.status(404).json({ error: "Parent callout not found" });
      }
      if (companyId) {
        if (!(await canAccessCompany(user, companyId))) {
          return res.status(403).json({ error: "Cannot link callout to inaccessible company" });
        }
      }
      const callout = await storage.createCallout({
        title: title.trim(),
        body: body || null,
        tag: tag || null,
        companyId: companyId || null,
        authorId: user.id,
        parentId: parentId || null,
        createdAt: new Date().toISOString(),
      });
      if (parentCallout) {
        const allCallouts = await storage.getCallouts();
        const threadReplies = allCallouts.filter(c => c.parentId === parentCallout!.id);
        const threadParticipants = new Set([
          parentCallout.authorId,
          ...threadReplies.map(c => c.authorId),
        ]);
        threadParticipants.delete(user.id);
        for (const uid of threadParticipants) {
          const isOriginalAuthor = uid === parentCallout.authorId;
          storage.createNotification({
            userId: uid,
            type: "post_reply",
            title: isOriginalAuthor
              ? `${user.name} replied to your callout`
              : `${user.name} replied to a thread you're in`,
            body: (title.trim()).length > 80 ? title.trim().slice(0, 80) + "…" : title.trim(),
            link: "/",
            relatedId: callout.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        }
      }
      res.status(201).json(callout);
    } catch (error) {
      console.error("Error creating callout:", error);
      res.status(500).json({ error: "Failed to create callout" });
    }
  });

  app.delete("/api/callouts/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const callout = await storage.getCallout((req.params.id as string));
      if (!callout) return res.status(404).json({ error: "Callout not found" });
      if (callout.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the author or admin can delete callouts" });
      }
      await storage.deleteCallout((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete callout" });
    }
  });

  // ── Opportunity / Win Logs ────────────────────────────────────────────────

  app.get("/api/opportunity-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { repId, companyId, type, startDate, endDate } = req.query as Record<string, string>;
      const logs = await storage.getOpportunityLogs(req.session.organizationId!, {
        repId: repId || undefined,
        companyId: companyId || undefined,
        type: type || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch opportunity logs" });
    }
  });

  app.get("/api/opportunity-logs/summary", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { repIds, startDate, endDate } = req.query as Record<string, string>;
      const ids = repIds ? repIds.split(",") : [];
      const summary = await storage.getOpportunityLogSummary(
        ids,
        startDate || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
        endDate || new Date().toISOString().split("T")[0]
      );
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch opportunity log summary" });
    }
  });

  app.post("/api/opportunity-logs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { type, category, title, description, companyId, estimatedLoads, estimatedValue, loggedAt } = req.body;
      if (!type || !title) return res.status(400).json({ error: "type and title are required" });

      const log = await storage.createOpportunityLog({
        organizationId: req.session.organizationId!,
        repId: user.id,
        companyId: companyId || null,
        type,
        category: category || "other",
        title,
        description: description || null,
        estimatedLoads: estimatedLoads != null ? Number(estimatedLoads) : null,
        estimatedValue: estimatedValue != null ? String(estimatedValue) : null,
        loggedAt: loggedAt || new Date().toISOString().split("T")[0],
        createdAt: new Date().toISOString(),
      });

      if (type === "win") {
        const categoryLabels: Record<string, string> = {
          spot_batch: "Batch of Spot Loads",
          dedicated_contracted: "Spot to Contracted Conversion",
          mini_bid: "Mini-Bid",
          project: "Project",
          other: "New Site, First Opp",
        };
        const catLabel = categoryLabels[category] || category || "Win";
        const parts = [`🏆 ${user.name} logged a win: ${title}`, `Category: ${catLabel}`];
        if (description) parts.push(description);
        const extras: string[] = [];
        if (estimatedLoads) extras.push(`${estimatedLoads} loads`);
        if (estimatedValue) extras.push(`$${Number(estimatedValue).toLocaleString()} est. value`);
        if (extras.length) parts.push(extras.join(" · "));
        await storage.createCallout({
          title: `${user.name}: ${title}`,
          body: parts.slice(1).join("\n"),
          tag: "win",
          companyId: companyId || null,
          authorId: user.id,
          parentId: null,
          createdAt: new Date().toISOString(),
        });
      }

      res.status(201).json({ ...log });
    } catch (error) {
      res.status(500).json({ error: "Failed to create opportunity log" });
    }
  });

  app.delete("/api/opportunity-logs/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const logs = await storage.getOpportunityLogs(req.session.organizationId!);
      const log = logs.find(l => l.id === req.params.id);
      if (!log) return res.status(404).json({ error: "Not found" });
      if (log.repId !== user.id && user.role !== "admin") return res.status(403).json({ error: "Not authorized" });
      await storage.deleteOpportunityLog(req.params.id as string);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete opportunity log" });
    }
  });

  // ── Feed Posts (Trends / Growth / Ideas) ─────────────────────────────────

  app.get("/api/feed-posts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      const topLevel = await storage.getFeedPosts(visibleAuthorIds);
      const parentIds = topLevel.map((p: any) => p.id);
      const replies = await storage.getFeedReplies(parentIds);
      const replyMap: Record<string, any[]> = {};
      for (const r of replies) {
        if (!replyMap[r.parentId!]) replyMap[r.parentId!] = [];
        replyMap[r.parentId!].push(r);
      }
      return res.json(topLevel.map((p: any) => ({ ...p, replies: replyMap[p.id] || [] })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feed posts" });
    }
  });

  app.post("/api/feed-posts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { content, category, parentId } = req.body;
      const trimmed = typeof content === "string" ? content.trim() : "";
      if (!trimmed) return res.status(400).json({ error: "Content is required" });

      if (parentId) {
        const parent = await storage.getFeedPost(parentId);
        if (!parent) return res.status(404).json({ error: "Parent post not found" });
        const post = await storage.createFeedPost({
          content: trimmed,
          category: parent.category,
          authorId: user.id,
          createdAt: new Date().toISOString(),
          parentId,
        });
        if (parent.authorId !== user.id) {
          storage.createNotification({
            userId: parent.authorId,
            type: "post_reply",
            title: `${user.name} replied to your post`,
            body: trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed,
            link: "/",
            relatedId: post.id,
            read: false,
          }).catch((e) => console.error("Notification error:", e));
        }
        return res.status(201).json(post);
      }

      const validCategories = ["trend", "growth", "idea", "celebrate"];
      if (!validCategories.includes(category)) return res.status(400).json({ error: "Invalid category" });
      const post = await storage.createFeedPost({
        content: trimmed,
        category,
        authorId: user.id,
        createdAt: new Date().toISOString(),
        parentId: null,
      });
      (async () => {
        try {
          const allUsers = await storage.getUsers(req.session.organizationId!);
          const directReports = allUsers.filter(u => u.managerId === user.id).map(u => u.id);
          const grandReports = allUsers.filter(u => directReports.includes(u.managerId ?? "")).map(u => u.id);
          let recipientIds: string[];
          if (user.role === "admin") {
            recipientIds = allUsers.filter(u => u.id !== user.id).map(u => u.id);
          } else if (user.role === "director" || user.role === "sales_director") {
            recipientIds = [...new Set([...directReports, ...grandReports])];
          } else {
            recipientIds = [...new Set([...directReports, ...grandReports])];
            if (user.managerId) recipientIds.push(user.managerId);
          }
          const categoryLabel = category === "growth" ? "Growth Win" : category === "trend" ? "Trend" : "Idea";
          const preview = trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
          await Promise.all(
            recipientIds
              .filter(id => id !== user.id)
              .map(id =>
                storage.createNotification({
                  userId: id,
                  type: "new_post",
                  title: `${user.name} posted a ${categoryLabel}`,
                  body: preview,
                  link: "/",
                  relatedId: post.id,
                  read: false,
                }).catch(() => {})
              )
          );
        } catch (e) {
          console.error("Feed notification fan-out error:", e);
        }
      })();
      res.status(201).json(post);
    } catch (error) {
      res.status(500).json({ error: "Failed to create feed post" });
    }
  });

  app.delete("/api/feed-posts/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const post = await storage.getFeedPost((req.params.id as string));
      if (!post) return res.status(404).json({ error: "Post not found" });
      if (post.authorId !== user.id && user.role !== "admin") {
        return res.status(403).json({ error: "Only the author or admin can delete posts" });
      }
      await storage.deleteFeedPost((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete feed post" });
    }
  });

  app.patch("/api/feed-posts/:id/pin", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const canPin = ["admin", "director", "national_account_manager", "sales_director"].includes(user.role);
      if (!canPin) return res.status(403).json({ error: "Only admins and managers can pin posts" });
      const post = await storage.getFeedPost((req.params.id as string));
      if (!post) return res.status(404).json({ error: "Post not found" });
      const updated = await storage.pinFeedPost((req.params.id as string), !!req.body.pinned);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to pin post" });
    }
  });

  // ── Internal Posts (Leadership → Team Direct Messages) ────────────────────

  app.get("/api/internal-posts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const orgUsers = await storage.getUsers(user.organizationId);
      const orgUserIds = orgUsers.map(u => u.id);
      const posts = await storage.getInternalPosts(user.id, user.role, orgUserIds);
      res.json(posts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch internal posts" });
    }
  });

  app.post("/api/internal-posts", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { content, recipientIds, parentId } = req.body;
      const isLeadership = user.role === "admin" || user.role === "director";
      const isNam = user.role === "national_account_manager";
      if (!parentId && !isLeadership) {
        return res.status(403).json({ error: "Only admins and directors can start new threads" });
      }
      if (parentId && !isLeadership) {
        const [parentPost] = await db.select().from(internalPostsTable).where(eq(internalPostsTable.id, parentId));
        if (!parentPost) return res.status(404).json({ error: "Parent post not found" });
        const rootPost = parentPost.parentId
          ? (await db.select().from(internalPostsTable).where(eq(internalPostsTable.id, parentPost.parentId)))[0] ?? parentPost
          : parentPost;
        const recipientList: string[] = Array.isArray(rootPost.recipientIds) ? rootPost.recipientIds : [];
        if (!isNam || !recipientList.includes(user.id)) {
          return res.status(403).json({ error: "You are not authorized to reply to this thread" });
        }
      }
      const post = await storage.createInternalPost({
        content: content.trim(),
        authorId: user.id,
        recipientIds: Array.isArray(recipientIds) ? recipientIds : [],
        parentId: parentId || null,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(post);
    } catch (error) {
      res.status(500).json({ error: "Failed to create internal post" });
    }
  });

  app.delete("/api/internal-posts/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const isLeadership = user.role === "admin" || user.role === "director";
      if (!isLeadership) return res.status(403).json({ error: "Only admins and directors can delete posts" });
      await storage.deleteInternalPost((req.params.id as string));
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete internal post" });
    }
  });

  // ── Callout Reactions ──────────────────────────────────────────────────────

  app.get("/api/callouts/reactions", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const ids = req.query.ids;
      if (!ids || typeof ids !== "string") return res.json([]);
      const requestedIds = ids.split(",").filter(Boolean);
      if (requestedIds.length === 0) return res.json([]);

      let visibleCallouts: Callout[];
      if (user.role === "admin") {
        visibleCallouts = await storage.getCallouts();
      } else {
        visibleCallouts = await storage.getCallouts();
        const teamIds = await storage.getTeamMemberIds(user.id, user.organizationId);
        const teamSet = new Set(teamIds);
        visibleCallouts = visibleCallouts.filter(c => teamSet.has(c.authorId));
      }

      const visibleCalloutIds = new Set(visibleCallouts.map(c => c.id));
      const filteredIds = requestedIds.filter(id => visibleCalloutIds.has(id));
      if (filteredIds.length === 0) return res.json([]);

      const reactions = await storage.getReactionsByCalloutIds(filteredIds);
      res.json(reactions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch reactions" });
    }
  });

  app.post("/api/callouts/:id/reactions", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "admin" && user.role !== "director" && user.role !== "sales_director") {
        return res.status(403).json({ error: "Only admins and directors can react" });
      }
      const { emoji } = req.body;
      const validEmojis = ["👍", "❤️", "🔥", "💡", "✅"];
      if (!emoji || !validEmojis.includes(emoji)) {
        return res.status(400).json({ error: "Invalid emoji" });
      }
      const callout = await storage.getCallout((req.params.id as string));
      if (!callout) return res.status(404).json({ error: "Callout not found" });
      const result = await storage.toggleReaction((req.params.id as string), user.id, emoji);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to toggle reaction" });
    }
  });

  // ── Feed Post Reactions ─────────────────────────────────────────────────────

  app.get("/api/feed/reactions", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const ids = req.query.ids;
      if (!ids || typeof ids !== "string") return res.json([]);
      const requestedIds = ids.split(",").filter(Boolean);
      if (requestedIds.length === 0) return res.json([]);

      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      const visiblePosts = await storage.getFeedPosts(visibleAuthorIds);
      const visiblePostIds = new Set(visiblePosts.map(p => p.id));
      const filteredIds = requestedIds.filter(id => visiblePostIds.has(id));
      if (filteredIds.length === 0) return res.json([]);

      const reactions = await storage.getReactionsByFeedPostIds(filteredIds);
      res.json(reactions);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feed reactions" });
    }
  });

  app.post("/api/feed/:id/reactions", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      const { emoji } = req.body;
      const validEmojis = ["👍", "🔥", "💡", "❤️", "✅"];
      if (!emoji || !validEmojis.includes(emoji)) {
        return res.status(400).json({ error: "Invalid emoji" });
      }
      const post = await storage.getFeedPost((req.params.id as string));
      if (!post) return res.status(404).json({ error: "Feed post not found" });
      if (post.parentId) return res.status(400).json({ error: "Reactions are only allowed on top-level posts" });

      const visibleAuthorIds = await getVisibleFeedAuthorIds(user);
      if (visibleAuthorIds && !visibleAuthorIds.includes(post.authorId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const result = await storage.toggleFeedPostReaction((req.params.id as string), user.id, emoji);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to toggle feed reaction" });
    }
  });
}
