import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth, getCurrentUser, canAccessCompany, getVisibleCompanyIds } from "../auth";
import { pStr } from "../lib/req";
import { fanOutCelebration } from "../lib/fanOutCelebration";
import { computeGrowthScore } from "../growthScoreCalculator";
import { insertContactSchema } from "@shared/schema";

function getBaseRank(base: string | null | undefined): number {
  if (!base) return 0;
  const s = base.toLowerCase().replace(/\s+/g, "");
  if (s.includes("home") || s === "hr" || s === "homerun") return 4;
  if (s.includes("3rd") || s.includes("third")) return 3;
  if (s.includes("2nd") || s.includes("second")) return 2;
  if (s.includes("1st") || s.includes("first")) return 1;
  return 0;
}

export function registerContactRoutes(app: Express): void {
  app.get("/api/contacts", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      let contacts = await storage.getContactsByOrg(currentUser.organizationId);
      const visibleIds = await getVisibleCompanyIds(currentUser);
      if (visibleIds !== null) {
        contacts = contacts.filter(c => visibleIds.includes(c.companyId));
      }
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.get("/api/companies/:companyId/contacts", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.companyId)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const contacts = await storage.getContactsByCompany(pStr(req.params.companyId));
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.post("/api/companies/:companyId/contacts", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.companyId)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const contactData = {
        ...req.body,
        companyId: pStr(req.params.companyId),
        createdAt: new Date().toISOString(),
        createdBy: currentUser.id,
      };
      const parsed = insertContactSchema.safeParse(contactData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const contact = await storage.createContact(parsed.data);
      const orgId = req.session.organizationId!;
      storage
        .getCompanyInOrg(pStr(req.params.companyId), orgId)
        .then(co => {
          fanOutCelebration(
            "new_contact",
            `\uD83C\uDF89 New contact: ${contact.name}`,
            `${currentUser.name} added ${contact.name}${contact.title ? ` (${contact.title})` : ""} at ${co?.name ?? "an account"}.`,
            `/companies/${pStr(req.params.companyId)}`,
            contact.id,
            currentUser.id,
            orgId
          );
        })
        .catch(() => {});
      res.status(201).json(contact);
    } catch (error) {
      console.error("Error creating contact:", error);
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.post("/api/companies/:companyId/contacts/bulk-import", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!(await canAccessCompany(currentUser, pStr(req.params.companyId)))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const rows: unknown[] = req.body.contacts;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No contacts provided" });
      }
      const now = new Date().toISOString();
      const toInsert = rows
        .map((r: unknown) => {
          const row = r as Record<string, unknown>;
          return {
            companyId: pStr(req.params.companyId),
            name: String(row.name ?? "").trim(),
            title: typeof row.title === "string" ? row.title.trim() || null : null,
            email: typeof row.email === "string" ? row.email.trim() || null : null,
            phone: typeof row.phone === "string" ? row.phone.trim() || null : null,
            notes: typeof row.notes === "string" ? row.notes.trim() || null : null,
            nextSteps: typeof row.nextSteps === "string" ? row.nextSteps.trim() || null : null,
            createdAt: now,
            createdBy: currentUser.id,
          };
        })
        .filter(r => r.name.length > 0);
      if (toInsert.length === 0) {
        return res.status(400).json({ error: "No valid contacts (name is required)" });
      }
      const created = await storage.bulkCreateContacts(toInsert);
      res.status(201).json({ count: created.length, contacts: created });
    } catch (error) {
      console.error("Error bulk importing contacts:", error);
      res.status(500).json({ error: "Failed to import contacts" });
    }
  });

  app.patch("/api/contacts/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getContact(pStr(req.params.id));
      if (!existing) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const newCompanyId =
        req.body.companyId && req.body.companyId !== existing.companyId
          ? req.body.companyId
          : existing.companyId;
      if (newCompanyId !== existing.companyId) {
        if (!(await canAccessCompany(currentUser, newCompanyId))) {
          return res.status(403).json({ error: "Access denied to destination company" });
        }
      }
      const contactData = { ...req.body, companyId: newCompanyId };
      const parsed = insertContactSchema.safeParse(contactData);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }
      const baseChanged =
        parsed.data.relationshipBase &&
        parsed.data.relationshipBase !== existing.relationshipBase;
      const oldRank = getBaseRank(existing.relationshipBase);
      const newRank = baseChanged ? getBaseRank(parsed.data.relationshipBase) : 0;
      if (baseChanged) {
        parsed.data.baseAdvancedAt = new Date().toISOString().split("T")[0];
        if (newRank > oldRank && newRank > 0) {
          const orgId = req.session.organizationId!;
          storage
            .getCompanyInOrg(existing.companyId, orgId)
            .then(co => {
              fanOutCelebration(
                "base_advanced",
                `\uD83C\uDF89 Relationship advanced: ${parsed.data.name ?? existing.name}`,
                `${currentUser.name} moved ${parsed.data.name ?? existing.name} at ${co?.name ?? "an account"} from ${existing.relationshipBase ?? "no base"} \u2192 ${parsed.data.relationshipBase}.`,
                `/companies/${existing.companyId}`,
                pStr(req.params.id),
                currentUser.id,
                orgId
              );
            })
            .catch(() => {});
        }
        storage
          .logContactBaseHistory(
            pStr(req.params.id),
            existing.relationshipBase ?? null,
            parsed.data.relationshipBase!,
            currentUser.id
          )
          .catch(() => {});
      }
      const contact = await storage.updateContact(pStr(req.params.id), parsed.data);
      if (newCompanyId !== existing.companyId) {
        try {
          await storage.updateTouchpointCompanyByContact(pStr(req.params.id), newCompanyId);
        } catch (err) {
          console.error("[contact-update] touchpoint company cascade failed:", err);
        }
        const orgId = req.session.organizationId!;
        Promise.all([
          computeGrowthScore(existing.companyId, orgId, storage).then(gs =>
            storage.upsertGrowthScore({
              companyId: existing.companyId,
              organizationId: orgId,
              score: gs.score,
              band: gs.band,
              drivers: gs.drivers,
              calculatedAt: new Date().toISOString(),
            })
          ),
          computeGrowthScore(newCompanyId, orgId, storage).then(gs =>
            storage.upsertGrowthScore({
              companyId: newCompanyId,
              organizationId: orgId,
              score: gs.score,
              band: gs.band,
              drivers: gs.drivers,
              calculatedAt: new Date().toISOString(),
            })
          ),
        ]).catch(err => {
          console.error("[contact-update] growth score refresh after company change failed:", err);
        });
      }
      res.json({ ...contact });
    } catch (error) {
      console.error("Error updating contact:", error);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/contacts/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const existing = await storage.getContact(pStr(req.params.id));
      if (!existing) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (!(await canAccessCompany(currentUser, existing.companyId))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const deleted = await storage.deleteContact(pStr(req.params.id));
      if (!deleted) {
        return res.status(404).json({ error: "Contact not found" });
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting contact:", error);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  app.get("/api/contacts/:id/base-history", requireAuth, async (req, res) => {
    try {
      const history = await storage.getContactBaseHistory(pStr(req.params.id));
      res.json(history);
    } catch (e) {
      console.error("Error fetching base history:", e);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });
}
