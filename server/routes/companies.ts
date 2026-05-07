import type { Express } from "express";
import { eq, and, desc, sql, max, ne, or, isNotNull, type SQL } from "drizzle-orm";
import { storage, db } from "../storage";
import { requireAuth, getCurrentUser, getVisibleCompanyIds, canAccessCompany } from "../auth";
import { pStr, qStr } from "../lib/req";
import { isAdmin } from "../lib/roles";
import { fanOutCelebration } from "../lib/fanOutCelebration";
import {
  insertCompanySchema,
  sharedRepSchema,
  onboardingMilestoneToggleSchema,
  type SharedRep,
  type OnboardingMilestones,
  emailSignals,
  emailMessages,
  insertCustomerEmailIdentitySchema,
  CUSTOMER_EMAIL_IDENTITY_KINDS,
  nbaCards,
  accountGrowthScores,
  touchpoints,
  freightDailyUploadFact,
  featureFlags,
} from "@shared/schema";
import { z } from "zod";

// Task #1109 — Profile Safety Labels feature flag key. Default ON: a row is
// only persisted when an admin explicitly disables the surface.
const PROFILE_SAFETY_FLAG_KEY = "profile_safety_labels_enabled";

export function registerCompanyRoutes(app: Express): void {
  // ── List companies ─────────────────────────────────────────────────────────
  app.get("/api/companies", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      // Task #1095 — Customers list hides rows the inbound-email pipeline
      // auto-created unless the caller explicitly opts in.
      const includeEmailDerived = qStr(req.query.includeEmailDerived) === "true";
      let allCompanies = await storage.getCompanies(req.session.organizationId!, { includeEmailDerived });
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        allCompanies = allCompanies.filter(c => visibleIds.includes(c.id));
      }
      const includeArchived = qStr(req.query.includeArchived) === "true";
      if (!includeArchived) {
        allCompanies = allCompanies.filter(c => !c.archivedAt);
      }
      res.json(allCompanies);
    } catch (error) {
      console.error("Error fetching companies:", error);
      res.status(500).json({ error: "Failed to fetch companies" });
    }
  });

  // ── Single company ─────────────────────────────────────────────────────────
  app.get("/api/companies/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg(pStr(req.params.id), currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      if (!(await canAccessCompany(currentUser, company.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      res.json(company);
    } catch (error) {
      console.error("Error fetching company:", error);
      res.status(500).json({ error: "Failed to fetch company" });
    }
  });

  // ── Shared reps ────────────────────────────────────────────────────────────
  app.get("/api/companies/:id/shared-reps", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const company = await storage.getCompanyInOrg(pStr(req.params.id), currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      if (!(await canAccessCompany(currentUser, company.id))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const reps = (company.sharedReps || []) as SharedRep[];
      const allUsers = await storage.getUsers(currentUser.organizationId);
      const result = reps.map(r => {
        const u = allUsers.find(u => u.id === r.userId);
        return { userId: r.userId, territoryNote: r.territoryNote || "", name: u?.name || "Unknown" };
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch shared reps" });
    }
  });

  app.post("/api/companies/:id/shared-reps", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
        return res.status(403).json({ error: "Only admins and NAMs can manage shared reps" });
      }
      const company = await storage.getCompanyInOrg(pStr(req.params.id), currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      const parsed = sharedRepSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const { userId, territoryNote } = parsed.data;
      const targetUser = await storage.getUser(userId);
      if (!targetUser || targetUser.organizationId !== currentUser.organizationId) {
        return res.status(400).json({ error: "User not found in organization" });
      }
      const existing = (company.sharedReps || []) as SharedRep[];
      if (existing.some(r => r.userId === userId)) {
        return res.status(400).json({ error: "User is already a shared rep on this account" });
      }
      const updated = [...existing, { userId, territoryNote: territoryNote || "" }];
      await storage.updateCompany(company.id, currentUser.organizationId, { sharedReps: updated });
      res.json({ userId, territoryNote: territoryNote || "", name: targetUser.name });
    } catch (error) {
      res.status(500).json({ error: "Failed to add shared rep" });
    }
  });

  app.delete("/api/companies/:id/shared-reps/:userId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (currentUser.role !== "admin" && currentUser.role !== "national_account_manager") {
        return res.status(403).json({ error: "Only admins and NAMs can manage shared reps" });
      }
      const company = await storage.getCompanyInOrg(pStr(req.params.id), currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      const existing = (company.sharedReps || []) as SharedRep[];
      const updated = existing.filter(r => r.userId !== pStr(req.params.userId));
      await storage.updateCompany(company.id, currentUser.organizationId, { sharedReps: updated });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to remove shared rep" });
    }
  });

  // ── Team members (scoped to current user's visibility) ─────────────────────
  app.get("/api/team-members", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const allUsers = await storage.getUsers(req.session.organizationId!);
      // Task #970 — annotate every team member with the canonical
      // cockpit team they belong to (per `shared/data/cockpitTeamMap.json`).
      // Surfaces like LWQ thread `teamId`/`teamLabel` into
      // `canAssignLane` so the wrong-team diagnostic actually fires
      // against real data instead of staying theoretical. Users not in
      // any team get `teamId: null` and the predicate skips the team
      // check (matches early-rollout reality).
      const { findCockpitTeamForUser } = await import("@shared/cockpitTeams");
      const safeUsers = allUsers.map(({ password, ...u }) => {
        const team = findCockpitTeamForUser(u.id);
        return {
          ...u,
          teamId: team?.id ?? null,
          teamLabel: team?.name ?? null,
        };
      });
      if (isAdmin(currentUser)) {
        return res.json(safeUsers);
      }
      if (
        currentUser.role === "director" ||
        currentUser.role === "national_account_manager" ||
        currentUser.role === "sales" ||
        currentUser.role === "sales_director"
      ) {
        const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
        const visibleIds = new Set([...teamIds, currentUser.id]);
        if (currentUser.managerId) visibleIds.add(currentUser.managerId);
        safeUsers.filter(u => isAdmin(u)).forEach(u => visibleIds.add(u.id));
        return res.json(safeUsers.filter(u => visibleIds.has(u.id)));
      }
      const visibleIds = new Set<string>([currentUser.id]);
      if (currentUser.managerId) {
        visibleIds.add(currentUser.managerId);
        allUsers.forEach(u => {
          if (u.managerId === currentUser.managerId) visibleIds.add(u.id);
        });
      }
      safeUsers.filter(u => u.role === "admin").forEach(u => visibleIds.add(u.id));
      return res.json(safeUsers.filter(u => visibleIds.has(u.id)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch team members" });
    }
  });

  // ── Create company ─────────────────────────────────────────────────────────
  app.post("/api/companies", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const parsed = insertCompanySchema.omit({ organizationId: true }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const data = { ...parsed.data, organizationId: req.session.organizationId! };
      // Account Owner unification: ownerRepId is set via the dedicated
      // PATCH /api/companies/:id/owner endpoint after creation, not via
      // the generic create. Strip it here so non-privileged callers
      // can't seed an owner that bypasses the /owner RBAC gate.
      delete (data as Record<string, unknown>).ownerRepId;
      if (isAdmin(currentUser)) {
        // admin can assign to anyone — leave assignedTo as-is
      } else if (
        currentUser.role === "director" ||
        currentUser.role === "national_account_manager" ||
        currentUser.role === "sales" ||
        currentUser.role === "sales_director"
      ) {
        if (data.assignedTo) {
          const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
          if (!teamIds.includes(data.assignedTo)) {
            data.assignedTo = currentUser.id;
          }
        } else {
          data.assignedTo = currentUser.id;
        }
      } else {
        data.assignedTo = currentUser.id;
      }
      const company = await storage.createCompany(data);
      fanOutCelebration(
        "new_account",
        `\uD83C\uDF89 New account: ${company.name}`,
        `${currentUser.name} just added a new account to the CRM.`,
        `/companies/${company.id}`,
        company.id,
        currentUser.id,
        req.session.organizationId!
      );
      res.status(201).json(company);
    } catch (error) {
      console.error("Error creating company:", error);
      res.status(500).json({ error: "Failed to create company" });
    }
  });

  // ── Update company ─────────────────────────────────────────────────────────
  app.patch("/api/companies/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = insertCompanySchema.omit({ organizationId: true }).partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const data = { ...parsed.data };
      if (currentUser.role !== "admin") {
        delete (data as Record<string, unknown>).assignedTo;
      }
      // Account Owner unification: ownerRepId is canonical and must
      // ONLY be edited via PATCH /api/companies/:id/owner (which has a
      // stricter RBAC gate than this generic update). Strip it here so
      // the generic update can never bypass that gate or create dual-
      // write hazards. Mirrored in `POST /api/companies` below.
      delete (data as Record<string, unknown>).ownerRepId;
      const company = await storage.updateCompany(pStr(req.params.id), currentUser.organizationId, data);
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      console.error("Error updating company:", error);
      res.status(500).json({ error: "Failed to update company" });
    }
  });

  app.patch("/api/companies/:id/financial-alias", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { financialAlias } = req.body;
      const company = await storage.updateCompany(pStr(req.params.id), currentUser.organizationId, {
        financialAlias: financialAlias || null,
      });
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to update financial alias" });
    }
  });

  app.patch("/api/companies/:id/salesperson", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { salesPersonId } = req.body;
      const company = await storage.updateCompany(pStr(req.params.id), currentUser.organizationId, {
        salesPersonId: salesPersonId || null,
      });
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to update salesperson" });
    }
  });

  app.patch("/api/companies/:id/reassign", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (
        currentUser.role !== "admin" &&
        currentUser.role !== "director" &&
        currentUser.role !== "national_account_manager" &&
        currentUser.role !== "sales" &&
        currentUser.role !== "sales_director"
      ) {
        return res.status(403).json({ error: "Only admins, directors and NAMs can reassign accounts" });
      }
      const { assignedTo } = req.body;
      if (!assignedTo) return res.status(400).json({ error: "assignedTo is required" });
      if (
        currentUser.role === "national_account_manager" ||
        currentUser.role === "director" ||
        currentUser.role === "sales"
      ) {
        const teamIds = await storage.getTeamMemberIds(currentUser.id, currentUser.organizationId);
        if (!teamIds.includes(assignedTo)) {
          return res.status(403).json({ error: "Can only assign to team members" });
        }
      }
      const existing = await storage.getCompanyInOrg(pStr(req.params.id), currentUser.organizationId);
      if (!existing) return res.status(404).json({ error: "Company not found" });
      const company = await storage.updateCompany(pStr(req.params.id), currentUser.organizationId, {
        assignedTo: assignedTo as string,
      });
      if (!company) return res.status(404).json({ error: "Company not found" });
      if (assignedTo !== currentUser.id && assignedTo !== existing.assignedTo) {
        storage
          .createNotification({
            userId: assignedTo,
            type: "account_assigned",
            title: `${currentUser.name} assigned you an account`,
            body: existing.name,
            link: `/companies/${existing.id}`,
            relatedId: existing.id,
            read: false,
          })
          .catch(e => console.error("Notification error:", e));
      }
      res.json(company);
    } catch (error) {
      res.status(500).json({ error: "Failed to reassign company" });
    }
  });

  // ── Owner rep (Task #1011) ─────────────────────────────────────────────────
  // Editable on the customer profile UI. The owner rep is the user who
  // catches inbound email when the inbox-recipient routing falls
  // through (no `findOrCreateRep(toEmail)` match). Persisted on the
  // company row as `ownerRepId`. Restricted to admins, NAMs, directors
  // and sales_directors so individual reps can't reassign account
  // ownership unilaterally.
  app.patch("/api/companies/:id/owner", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (
        currentUser.role !== "admin" &&
        currentUser.role !== "director" &&
        currentUser.role !== "national_account_manager" &&
        currentUser.role !== "sales_director"
      ) {
        return res.status(403).json({ error: "Only admins, directors and NAMs can change account owner" });
      }
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const { ownerRepId } = req.body as { ownerRepId?: string | null };
      if (ownerRepId) {
        const target = await storage.getUser(ownerRepId);
        if (!target || target.organizationId !== currentUser.organizationId) {
          return res.status(400).json({ error: "User not found in organization" });
        }
      }
      const company = await storage.updateCompany(pStr(req.params.id), currentUser.organizationId, {
        ownerRepId: ownerRepId || null,
      });
      if (!company) return res.status(404).json({ error: "Company not found" });
      res.json(company);
    } catch (error) {
      console.error("Error updating owner rep:", error);
      res.status(500).json({ error: "Failed to update owner rep" });
    }
  });

  // ── Customer email identities (Task #1011) ─────────────────────────────────
  // Editable list of explicit email→customer hints that drive ingestion
  // routing precedence (contact → shared_distribution → domain).
  app.get("/api/companies/:id/email-identities", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.id);
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const rows = await storage.listCustomerEmailIdentities(companyId, currentUser.organizationId);
      res.json(rows);
    } catch (error) {
      console.error("Error fetching email identities:", error);
      res.status(500).json({ error: "Failed to fetch email identities" });
    }
  });

  app.post("/api/companies/:id/email-identities", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.id);
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const body = z.object({
        kind: z.enum(CUSTOMER_EMAIL_IDENTITY_KINDS),
        value: z.string().min(1).max(254),
        label: z.string().max(120).optional().nullable(),
        contactId: z.string().optional().nullable(),
      }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: body.error.message });
      // Validate value shape per kind. `domain` is bare host; the
      // others are full email addresses. Normalisation to lower-case
      // happens inside `createCustomerEmailIdentity`.
      const value = body.data.value.trim().toLowerCase();
      if (body.data.kind === "domain") {
        if (value.includes("@") || !value.includes(".")) {
          return res.status(400).json({ error: "Domain must be a bare host (e.g. acme.com)" });
        }
      } else {
        if (!value.includes("@") || !value.includes(".")) {
          return res.status(400).json({ error: "Value must be a valid email address" });
        }
      }
      const parsed = insertCustomerEmailIdentitySchema.safeParse({
        organizationId: currentUser.organizationId,
        companyId,
        kind: body.data.kind,
        value,
        label: body.data.label ?? null,
        contactId: body.data.contactId ?? null,
        active: true,
      });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
      const created = await storage.createCustomerEmailIdentity(parsed.data);
      res.status(201).json(created);
    } catch (error) {
      console.error("Error creating email identity:", error);
      res.status(500).json({ error: "Failed to create email identity" });
    }
  });

  app.delete("/api/companies/:id/email-identities/:identityId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.id);
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const ok = await storage.deleteCustomerEmailIdentity(pStr(req.params.identityId), currentUser.organizationId);
      if (!ok) return res.status(404).json({ error: "Identity not found" });
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting email identity:", error);
      res.status(500).json({ error: "Failed to delete email identity" });
    }
  });

  // ── Customer email signals ─────────────────────────────────────────────────
  app.get("/api/companies/:id/email-signals", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.id);
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const limit = Math.min(parseInt((qStr(req.query.limit)) ?? "50", 10), 200);
      const rows = await db
        .select({
          signalId: emailSignals.id,
          intentType: emailSignals.intentType,
          intentSubtype: emailSignals.intentSubtype,
          actorType: emailSignals.actorType,
          confidence: emailSignals.confidence,
          extractedData: emailSignals.extractedData,
          signalCreatedAt: emailSignals.createdAt,
          messageId: emailMessages.id,
          direction: emailMessages.direction,
          fromEmail: emailMessages.fromEmail,
          toEmail: emailMessages.toEmail,
          subject: emailMessages.subject,
          messageCreatedAt: emailMessages.createdAt,
          threadId: emailMessages.threadId,
        })
        .from(emailSignals)
        .innerJoin(emailMessages, eq(emailSignals.messageId, emailMessages.id))
        .where(
          and(
            eq(emailMessages.linkedAccountId, companyId),
            eq(emailMessages.orgId, currentUser.organizationId)
          )
        )
        .orderBy(desc(emailSignals.createdAt))
        .limit(limit);
      res.json(rows);
    } catch (err) {
      console.error("[email-signals] company route error:", err);
      res.status(500).json({ error: "Failed to fetch email signals" });
    }
  });

  // ── Delete company ─────────────────────────────────────────────────────────
  app.delete("/api/companies/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteCompany(pStr(req.params.id), currentUser.organizationId);
      if (!deleted) return res.status(404).json({ error: "Company not found" });
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting company:", error);
      res.status(500).json({ error: "Failed to delete company" });
    }
  });

  // ── Pinned companies ───────────────────────────────────────────────────────
  app.get("/api/pinned-companies", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const pinned = await storage.getPinnedCompanies(currentUser.id);
      res.json(pinned);
    } catch (error) {
      res.status(500).json({ error: "Failed to get pinned companies" });
    }
  });

  app.post("/api/pinned-companies/:companyId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.companyId);
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const existing = await storage.getPinnedCompanies(currentUser.id);
      const alreadyPinned = existing.some(p => p.companyId === companyId);
      if (!alreadyPinned && existing.length >= 10) {
        return res.status(400).json({ error: "Maximum of 10 pinned accounts allowed" });
      }
      const pinned = await storage.pinCompany(currentUser.id, companyId);
      res.json(pinned);
    } catch (error) {
      res.status(500).json({ error: "Failed to pin company" });
    }
  });

  app.delete("/api/pinned-companies/:companyId", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.companyId);
      await storage.unpinCompany(currentUser.id, companyId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to unpin company" });
    }
  });

  // ── Archive / Unarchive ────────────────────────────────────────────────────
  app.post("/api/companies/:id/archive", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.archiveCompany(pStr(req.params.id), currentUser.organizationId);
      if (!updated) return res.status(404).json({ error: "Company not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to archive company" });
    }
  });

  app.post("/api/companies/:id/unarchive", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const updated = await storage.unarchiveCompany(pStr(req.params.id), currentUser.organizationId);
      if (!updated) return res.status(404).json({ error: "Company not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to unarchive company" });
    }
  });

  // ── Onboarding milestones ──────────────────────────────────────────────────
  app.patch("/api/companies/:id/onboarding-milestones", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.id)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = onboardingMilestoneToggleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid milestone payload", details: parsed.error.flatten() });
      }
      const { milestoneId, completed } = parsed.data;
      const existing = await storage.getCompany(pStr(req.params.id));
      if (!existing) return res.status(404).json({ error: "Company not found" });
      const stored = existing.onboardingMilestones;
      const current: OnboardingMilestones =
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? { ...(stored as OnboardingMilestones) }
          : {};
      current[milestoneId] = completed;
      const updated = await storage.updateCompany(pStr(req.params.id), currentUser.organizationId, {
        onboardingMilestones: current,
      });
      if (!updated) return res.status(404).json({ error: "Company not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update onboarding milestones" });
    }
  });

  // ── Task #1109 — Profile Safety Labels feature flag (default ON) ───────────
  // Distinct from the generic /api/feature-flags GET because we need the
  // client to distinguish "no row → default ON" from "row with enabled=false →
  // explicit OFF". Returns a tiny shape {enabled, configured} that the
  // useProfileSafetyFlag hook keys off.
  app.get("/api/profile-safety-flag", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const [row] = await db
        .select({ enabled: featureFlags.enabled })
        .from(featureFlags)
        .where(and(
          eq(featureFlags.orgId, currentUser.organizationId),
          eq(featureFlags.flagKey, PROFILE_SAFETY_FLAG_KEY),
        ));
      if (!row) {
        return res.json({ enabled: true, configured: false });
      }
      return res.json({ enabled: !!row.enabled, configured: true });
    } catch (err) {
      console.error("[profile-safety-flag] error:", err);
      // Default-ON: do not break the page if the lookup fails.
      res.json({ enabled: true, configured: false });
    }
  });

  // ── Task #1109 — Per-company data freshness ────────────────────────────────
  // Pure SELECTs of the upstream-job timestamps surfaced on the Company
  // Profile. No recomputation is performed here — this is the read-side of
  // the "Updated Xh ago" / "Stale" pills.
  app.get("/api/companies/:id/data-freshness", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.id);
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const company = await storage.getCompanyInOrg(companyId, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const [nbaRow] = await db
        .select({ ts: max(nbaCards.createdAt) })
        .from(nbaCards)
        .where(and(eq(nbaCards.companyId, companyId), eq(nbaCards.orgId, currentUser.organizationId)));

      const [growthRow] = await db
        .select({ ts: accountGrowthScores.calculatedAt })
        .from(accountGrowthScores)
        .where(and(
          eq(accountGrowthScores.companyId, companyId),
          eq(accountGrowthScores.organizationId, currentUser.organizationId),
        ))
        .orderBy(desc(accountGrowthScores.calculatedAt))
        .limit(1);

      // Health is derived from the latest meaningful touchpoint date.
      const [healthRow] = await db
        .select({ ts: max(touchpoints.date) })
        .from(touchpoints)
        .where(eq(touchpoints.companyId, companyId));

      // Financial freshness uses the most recent freight_daily_upload_fact
      // ingest for any row whose customer matches the company name or its
      // financialAlias (case-insensitive). Falls back to NULL when no rows
      // match — which the UI surfaces as "never recomputed".
      const aliasRaw = (company.financialAlias ?? "").trim();
      const nameRaw = (company.name ?? "").trim();
      const orParts: SQL[] = [];
      if (nameRaw) orParts.push(sql`lower(${freightDailyUploadFact.customer}) = lower(${nameRaw})`);
      if (aliasRaw) orParts.push(sql`lower(${freightDailyUploadFact.customer}) = lower(${aliasRaw})`);
      let financials: string | null = null;
      if (orParts.length > 0) {
        const [finRow] = await db
          .select({ ts: max(freightDailyUploadFact.ingestedAt) })
          .from(freightDailyUploadFact)
          .where(and(
            eq(freightDailyUploadFact.orgId, currentUser.organizationId),
            or(...orParts),
          ));
        financials = finRow?.ts ? new Date(finRow.ts as Date).toISOString() : null;
      }

      res.json({
        nba:        nbaRow?.ts ?? null,
        growth:     growthRow?.ts ?? null,
        health:     healthRow?.ts ?? null,
        financials,
      });
    } catch (err) {
      console.error("[data-freshness] error:", err);
      res.status(500).json({ error: "Failed to compute data freshness" });
    }
  });

  // ── Task #1109 — Financial mapping health ──────────────────────────────────
  // Counts freight rows whose `customer` looks like the company's name but is
  // not currently bound to it via name- or financialAlias-equality. Powers
  // the "may be incomplete" hint on the financial card. Read-only — does NOT
  // mutate freight_daily_upload_fact.
  app.get("/api/companies/:id/financial-mapping-health", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const companyId = pStr(req.params.id);
      if (!(await canAccessCompany(currentUser, companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const company = await storage.getCompanyInOrg(companyId, currentUser.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });

      const nameRaw = (company.name ?? "").trim();
      const aliasRaw = (company.financialAlias ?? "").trim();
      const hasFinancialAlias = aliasRaw.length > 0;
      if (nameRaw.length < 3) {
        return res.json({
          unmappedRowCount: 0,
          unmappedCustomerSamples: [],
          hasFinancialAlias,
        });
      }

      // Match: customer ILIKE %name% AND NOT equal to name AND (no alias OR not equal to alias).
      const namePattern = `%${nameRaw.toLowerCase()}%`;
      const conditions: SQL[] = [
        eq(freightDailyUploadFact.orgId, currentUser.organizationId),
        isNotNull(freightDailyUploadFact.customer),
        sql`lower(${freightDailyUploadFact.customer}) like ${namePattern}`,
        sql`lower(${freightDailyUploadFact.customer}) <> lower(${nameRaw})`,
      ].filter((c): c is SQL => c !== undefined);
      if (hasFinancialAlias) {
        conditions.push(sql`lower(${freightDailyUploadFact.customer}) <> lower(${aliasRaw})`);
      }

      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(freightDailyUploadFact)
        .where(and(...conditions));

      const sampleRows = await db
        .selectDistinct({ customer: freightDailyUploadFact.customer })
        .from(freightDailyUploadFact)
        .where(and(...conditions))
        .limit(5);

      res.json({
        unmappedRowCount: countRow?.n ?? 0,
        unmappedCustomerSamples: sampleRows.map(r => r.customer).filter(Boolean) as string[],
        hasFinancialAlias,
      });
    } catch (err) {
      console.error("[financial-mapping-health] error:", err);
      res.status(500).json({ error: "Failed to compute mapping health" });
    }
  });
}
