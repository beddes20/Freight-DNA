/**
 * Task #910 — Copilot Doc Ingestion routes.
 *
 * Endpoints (all require auth; admin-only ones gate on role):
 *   POST   /api/copilot/documents              upload via drop-zone (multipart, field=files)
 *   GET    /api/copilot/documents              filtered list scoped to the rep
 *   GET    /api/copilot/documents/:id          one doc + its pages (org-scoped)
 *   GET    /api/copilot/documents/:id/raw      streamed bytes from object storage
 *   GET    /api/admin/copilot/documents/queue  in-flight + failed (admin / director)
 *   POST   /api/admin/copilot/documents/:id/retry  re-run extraction + classification
 */
import type { Express } from "express";
import multer from "multer";
import { requireAuth, getCurrentUser, getVisibleCompanyIds } from "../auth";
import { storage } from "../storage";
import { ingestDocument, retryDocument } from "../services/documentIngestion";
import { getDocumentBytes } from "../services/documentStorage";
import { pStr, qOptStr, qInt, qBool } from "../lib/req";
import { getErrorMessage } from "../lib/errors";

const COPILOT_DOC_UPLOAD_LIMIT = 25 * 1024 * 1024; // 25 MB per file
const COPILOT_DOC_FIELD = "files";

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: COPILOT_DOC_UPLOAD_LIMIT, files: 10 },
});

function isAdminish(role: string): boolean {
  return role === "admin" || role === "director" || role === "sales_director";
}

export function registerDocumentRoutes(app: Express): void {
  app.post("/api/copilot/documents", requireAuth, docUpload.array(COPILOT_DOC_FIELD, 10), async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) return res.status(400).json({ error: "No files uploaded (field: files)" });

      // Free-form context — the drop-zone passes the page path + any
      // company / contact / prospect anchor it knows about.
      const ctx = (() => {
        try {
          const raw = typeof req.body?.context === "string" ? req.body.context : null;
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          return typeof parsed === "object" && parsed !== null ? parsed : null;
        } catch {
          return null;
        }
      })();

      const results = [];
      for (const f of files) {
        const r = await ingestDocument({
          source: "drag_drop",
          file: { filename: f.originalname, mimeType: f.mimetype, bytes: f.buffer },
          uploader: { id: currentUser.id, organizationId: currentUser.organizationId },
          context: ctx ?? undefined,
        });
        results.push({
          documentId: r.document.id,
          filename: r.document.filename,
          classLabel: r.document.classLabel,
          status: r.document.status,
          deduped: r.deduped,
          failed: r.failed,
          errorReason: r.errorReason,
          pagesWritten: r.pagesWritten,
        });
      }
      res.json({ uploaded: results.length, results });
    } catch (err) {
      console.error("[copilot/documents POST]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to ingest document" });
    }
  });

  app.get("/api/copilot/documents", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const visible = await getVisibleCompanyIds(currentUser);
      const visibleCompanyIds: string[] | "all" = visible === null ? "all" : visible;

      const classLabel = qOptStr(req.query.class) ?? null;
      const daysRaw = qInt(req.query.days_back, 0);
      const sinceIso = daysRaw > 0 ? new Date(Date.now() - Math.min(daysRaw, 365) * 86400000).toISOString() : null;
      const contains = qOptStr(req.query.contains) ?? null;
      const mineOnly = qBool(req.query.mine);

      const docs = await storage.findDocumentsForUser({
        organizationId: currentUser.organizationId,
        visibleCompanyIds,
        // Always pass uploaderId so the storage union includes the
        // caller's own uploads even on accounts they were just removed
        // from. mineOnly hard-restricts to self when the UI toggle is on.
        uploaderId: currentUser.id,
        mineOnly,
        classLabel,
        sinceIso,
        contentMatch: contains,
        limit: 50,
      });
      res.json({ documents: docs });
    } catch (err) {
      console.error("[copilot/documents GET]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to load documents" });
    }
  });

  app.get("/api/copilot/documents/:id", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const docId = pStr(req.params.id);
      const doc = await storage.getDocumentInOrg(docId, currentUser.organizationId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      // Visibility: uploader OR admin-ish OR linked to a visible company.
      const visible = await getVisibleCompanyIds(currentUser);
      const linkedCompanyId = (doc.uploadContext as { companyId?: string } | null)?.companyId ?? null;
      const allowed =
        isAdminish(currentUser.role) ||
        doc.uploaderId === currentUser.id ||
        visible === null ||
        (linkedCompanyId && visible.includes(linkedCompanyId));
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
      const pages = await storage.getDocumentPages(doc.id);
      res.json({ document: doc, pages });
    } catch (err) {
      console.error("[copilot/documents/:id GET]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to load document" });
    }
  });

  app.get("/api/copilot/documents/:id/raw", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const docId = pStr(req.params.id);
      const doc = await storage.getDocumentInOrg(docId, currentUser.organizationId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const visible = await getVisibleCompanyIds(currentUser);
      const linkedCompanyId = (doc.uploadContext as { companyId?: string } | null)?.companyId ?? null;
      const allowed =
        isAdminish(currentUser.role) ||
        doc.uploaderId === currentUser.id ||
        visible === null ||
        (linkedCompanyId && visible.includes(linkedCompanyId));
      if (!allowed) return res.status(403).json({ error: "Forbidden" });
      const blob = await getDocumentBytes(doc.storageKey);
      if (!blob) return res.status(410).json({ error: "Stored bytes missing" });
      res.setHeader("Content-Type", doc.mimeType);
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.filename)}"`);
      res.send(blob.bytes);
    } catch (err) {
      console.error("[copilot/documents/:id/raw GET]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to fetch document bytes" });
    }
  });

  app.get("/api/admin/copilot/documents/queue", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdminish(currentUser.role)) return res.status(403).json({ error: "Admin access required" });
      const statusRaw = qOptStr(req.query.status) ?? "parsing,failed";
      const status = statusRaw.split(",") as Array<"parsing" | "parsed" | "failed">;
      const validStatuses = status.filter((s) => s === "parsing" || s === "parsed" || s === "failed");
      const docs = await storage.listDocumentsByStatus(currentUser.organizationId, validStatuses, 200);
      res.json({ documents: docs });
    } catch (err) {
      console.error("[admin/copilot/documents/queue GET]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to load processing queue" });
    }
  });

  app.post("/api/admin/copilot/documents/:id/retry", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdminish(currentUser.role)) return res.status(403).json({ error: "Admin access required" });
      const docId = pStr(req.params.id);
      const r = await retryDocument(docId, currentUser.organizationId);
      if (!r) return res.status(404).json({ error: "Document not found or bytes missing" });
      res.json({
        documentId: r.document.id,
        status: r.document.status,
        classLabel: r.document.classLabel,
        pagesWritten: r.pagesWritten,
        failed: r.failed,
        errorReason: r.errorReason,
      });
    } catch (err) {
      console.error("[admin/copilot/documents/:id/retry POST]", getErrorMessage(err));
      res.status(500).json({ error: "Retry failed" });
    }
  });
}
