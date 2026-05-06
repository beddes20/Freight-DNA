/**
 * Company Collaborators — manual visibility sharing.
 *
 * A collaborator gets read+act access to all freight/lanes/etc for that
 * specific account. Mutation auth on individual records remains owner-scoped
 * (so a collaborator can't reassign ownership or delete the account).
 *
 * Authorization for managing the sharing list itself:
 *   - admin / director / sales_director  → may manage any account
 *   - account owner                       → may manage their own accounts
 *   - the owner's direct manager          → may manage that owner's accounts
 *
 * Endpoints:
 *   GET    /api/account-sharing/manageable                     — accounts the caller can manage
 *   GET    /api/companies/:companyId/collaborators             — list current collaborators
 *   POST   /api/companies/:companyId/collaborators             — { userId } add a collaborator
 *   DELETE /api/companies/:companyId/collaborators/:userId     — remove a collaborator
 */

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { getCurrentUser } from "../auth";

const ADMIN_ROLES = new Set(["admin", "director", "sales_director"]);

/**
 * Can `viewer` manage the collaborator list for `company`?
 *   admin/director/sales_director → yes (any account in their org)
 *   account owner (assignedTo)    → yes
 *   owner's direct manager        → yes
 */
async function canManageSharing(
  viewer: { id: string; role: string; organizationId: string },
  company: { assignedTo: string | null; organizationId: string },
): Promise<boolean> {
  if (company.organizationId !== viewer.organizationId) return false;
  if (ADMIN_ROLES.has(viewer.role)) return true;
  if (!company.assignedTo) return false;
  if (company.assignedTo === viewer.id) return true;
  const owner = await storage.getUser(company.assignedTo);
  if (owner?.managerId && owner.managerId === viewer.id) return true;
  return false;
}

export function registerCompanyCollaboratorRoutes(app: Express) {
  // ── List all accounts the caller may manage sharing on ──
  app.get("/api/account-sharing/manageable", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    try {
      const accounts = await storage.getAccountsManageableForSharing(
        user.id,
        user.role,
        user.organizationId,
      );
      // Hydrate each with current collaborators
      const enriched = await Promise.all(
        accounts.map(async (a) => ({
          id: a.id,
          name: a.name,
          ownerId: a.assignedTo,
          collaborators: await storage.listCollaboratorsForCompany(a.id, user.organizationId),
        })),
      );
      // Sort by name for predictable UI
      enriched.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ accounts: enriched });
    } catch (err) {
      console.error("[account-sharing/manageable] failed", err);
      res.status(500).json({ error: "Failed to load shareable accounts" });
    }
  });

  // ── List collaborators for one account ──
  app.get("/api/companies/:companyId/collaborators", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const { companyId } = req.params;
    try {
      const company = await storage.getCompanyInOrg(companyId, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      // Anyone in the org who can already SEE the account can list — for now
      // we keep this read open to all org members so the LWQ sharing dialog
      // is fast (no per-row auth). It only returns names + roles, no PII.
      const list = await storage.listCollaboratorsForCompany(companyId, user.organizationId);
      res.json({ collaborators: list });
    } catch (err) {
      console.error("[collaborators GET] failed", err);
      res.status(500).json({ error: "Failed to load collaborators" });
    }
  });

  // ── Add a collaborator ──
  app.post("/api/companies/:companyId/collaborators", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const { companyId } = req.params;
    const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "userId required" });

    try {
      const company = await storage.getCompanyInOrg(companyId, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      if (!(await canManageSharing(user, company))) {
        return res.status(403).json({
          error: "Only the account owner, the owner's manager, or an admin may share this account.",
        });
      }
      // The collaborator must be in the same org (no cross-tenant sharing).
      const target = await storage.getUser(parsed.data.userId);
      if (!target || target.organizationId !== user.organizationId) {
        return res.status(400).json({ error: "Target user not found in your organization" });
      }
      // Don't bother creating a row for the owner themselves — they already see it.
      if (target.id === company.assignedTo) {
        return res.status(400).json({ error: "User is already the account owner" });
      }
      const row = await storage.addCompanyCollaborator({
        organizationId: user.organizationId,
        companyId,
        userId: target.id,
        addedByUserId: user.id,
      });
      res.json({ collaborator: row });
    } catch (err) {
      console.error("[collaborators POST] failed", err);
      res.status(500).json({ error: "Failed to add collaborator" });
    }
  });

  // ── Remove a collaborator ──
  app.delete("/api/companies/:companyId/collaborators/:userId", async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const { companyId, userId: targetUserId } = req.params;
    try {
      const company = await storage.getCompanyInOrg(companyId, user.organizationId);
      if (!company) return res.status(404).json({ error: "Company not found" });
      // Allow self-removal even if the user can't otherwise manage sharing.
      const allowed = targetUserId === user.id || (await canManageSharing(user, company));
      if (!allowed) {
        return res.status(403).json({
          error: "Only the account owner, the owner's manager, an admin, or the collaborator themselves may remove this share.",
        });
      }
      const removed = await storage.removeCompanyCollaborator(companyId, targetUserId, user.organizationId);
      res.json({ removed });
    } catch (err) {
      console.error("[collaborators DELETE] failed", err);
      res.status(500).json({ error: "Failed to remove collaborator" });
    }
  });
}
