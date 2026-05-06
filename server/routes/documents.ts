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
import { runRateConPipeline } from "../services/rateConPipeline";
import { calibrateRateConConfidence } from "../services/rateConConfidenceCalibrator";
import { pStr, qOptStr, qInt, qBool } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import { z } from "zod";
import { RATE_CON_FIELD_PATHS, rateConExtractionSchema } from "@shared/schema";

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

  // ── Task #911 — typed extraction surfaces ───────────────────────────
  // GET the typed extraction + entity links + findings + corrections.
  app.get("/api/copilot/documents/:id/extraction", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const docId = pStr(req.params.id);
      const doc = await storage.getDocumentInOrg(docId, currentUser.organizationId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const visible = await getVisibleCompanyIds(currentUser);
      const linkedCompanyId = (doc.uploadContext as { companyId?: string } | null)?.companyId ?? null;
      // Strict policy (Task #911): for docs anchored to a company, the
      // current account-visibility check is the ONLY source of truth.
      // Uploader bypass is removed so a rep loses access to a rate con
      // after the linked account is reassigned away. For docs that are
      // not anchored to any company (rare scratch uploads) the uploader
      // can still read their own.
      const hasAccountAccess =
        isAdminish(currentUser.role) ||
        visible === null ||
        (linkedCompanyId && visible.includes(linkedCompanyId));
      const allowed = hasAccountAccess || (!linkedCompanyId && doc.uploaderId === currentUser.id);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });

      const [extraction, links, findings, corrections] = await Promise.all([
        storage.getDocumentExtraction(doc.id),
        storage.getDocumentEntityLinks(doc.id),
        storage.getDocumentExtractionFindings(doc.id),
        storage.getDocumentExtractionCorrections(doc.id),
      ]);
      res.json({
        document: doc,
        extraction: extraction ?? null,
        links,
        findings,
        corrections,
      });
    } catch (err) {
      console.error("[copilot/documents/:id/extraction GET]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to load extraction" });
    }
  });

  // POST a single-field correction. The card re-renders with the corrected
  // value and the "edited by rep" chip; the corrections feed the nightly
  // confidence calibrator.
  //
  // Per-field value validation: each rate-con leaf is typed (string, number,
  // or the accessorials object). We reject a correction whose value doesn't
  // match the field's inner type BEFORE persisting, AND we re-parse the
  // patched payload against `rateConExtractionSchema` after merging — so a
  // valid field write that happens to break a structural invariant (e.g.
  // wrong shape under accessorials) still fails closed instead of poisoning
  // the typed envelope downstream tools rely on.
  const NUMERIC_RATE_CON_FIELDS = new Set<string>([
    "weightLbs", "allInRate", "lineHaulRate", "fuelSurcharge",
  ]);
  const accessorialsCorrectionSchema = z.object({
    items: z.array(z.object({
      description: z.string().min(1),
      amount: z.number().nullable().optional(),
      confidence: z.number().min(0).max(1),
      source: z.unknown().nullable().optional(),
    })),
    confidence: z.number().min(0).max(1),
  });
  function validateCorrectionValue(
    fieldPath: typeof RATE_CON_FIELD_PATHS[number],
    value: unknown,
  ): { ok: true } | { ok: false; reason: string } {
    if (fieldPath === "accessorials") {
      const r = accessorialsCorrectionSchema.safeParse(value);
      return r.success
        ? { ok: true }
        : { ok: false, reason: `accessorials shape invalid: ${r.error.issues.slice(0,2).map(i => i.message).join("; ")}` };
    }
    // Rep clearing a field is allowed.
    if (value === null || value === undefined) return { ok: true };
    if (NUMERIC_RATE_CON_FIELDS.has(fieldPath)) {
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true }
        : { ok: false, reason: `${fieldPath} must be a finite number or null` };
    }
    return typeof value === "string"
      ? { ok: true }
      : { ok: false, reason: `${fieldPath} must be a string or null` };
  }
  const correctionBodySchema = z.object({
    fieldPath: z.enum(RATE_CON_FIELD_PATHS),
    originalValue: z.unknown().optional(),
    correctedValue: z.unknown(),
  });
  app.post("/api/copilot/documents/:id/corrections", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      const docId = pStr(req.params.id);
      const doc = await storage.getDocumentInOrg(docId, currentUser.organizationId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const visible = await getVisibleCompanyIds(currentUser);
      const linkedCompanyId = (doc.uploadContext as { companyId?: string } | null)?.companyId ?? null;
      // Same strict policy as the GET — uploader bypass is removed for
      // company-anchored docs so reassignment revokes correction access.
      const hasAccountAccess =
        isAdminish(currentUser.role) ||
        visible === null ||
        (linkedCompanyId && visible.includes(linkedCompanyId));
      const allowed = hasAccountAccess || (!linkedCompanyId && doc.uploaderId === currentUser.id);
      if (!allowed) return res.status(403).json({ error: "Forbidden" });

      const parsed = correctionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid correction payload", issues: parsed.error.issues });
      }

      // Per-field type check on `correctedValue`. Without this the rep (or
      // a malicious caller) could drop a non-string into `carrierName`, an
      // arbitrary object into `weightLbs`, or a malformed accessorials
      // array — which would silently break the typed `RateConExtraction`
      // contract that the agent tool, the rep card, and the calibrator
      // all read from.
      const fieldCheck = validateCorrectionValue(parsed.data.fieldPath, parsed.data.correctedValue);
      if (!fieldCheck.ok) {
        return res.status(400).json({ error: "Invalid corrected value", reason: fieldCheck.reason });
      }

      // Build the patched payload up-front so we can re-validate against
      // the full Zod schema BEFORE writing — catches structural breakage
      // even if the per-field type check passes.
      const existing = await storage.getDocumentExtraction(doc.id);
      let patched: Record<string, unknown> | null = null;
      if (existing && typeof existing.payload === "object" && existing.payload) {
        const base = { ...(existing.payload as Record<string, unknown>) };
        const prior = base[parsed.data.fieldPath] as Record<string, unknown> | undefined;
        const sourceRef = prior?.source ?? null;
        base[parsed.data.fieldPath] = parsed.data.fieldPath === "accessorials"
          ? parsed.data.correctedValue
          : { value: parsed.data.correctedValue, confidence: 1, source: sourceRef, repCorrected: true };
        const reparse = rateConExtractionSchema.safeParse(base);
        if (!reparse.success) {
          return res.status(400).json({
            error: "Patched payload failed schema validation",
            issues: reparse.error.issues.slice(0, 3),
          });
        }
        patched = base;
      }

      const correction = await storage.addDocumentExtractionCorrection({
        documentId: doc.id,
        organizationId: currentUser.organizationId,
        fieldPath: parsed.data.fieldPath,
        classLabel: doc.classLabel,
        originalValue: (parsed.data.originalValue ?? null) as Record<string, unknown> | null,
        correctedValue: (parsed.data.correctedValue ?? null) as Record<string, unknown> | null,
        correctedById: currentUser.id,
      });

      // Patch the in-place payload so the next read returns the corrected
      // value with confidence pinned to 1.0 (rep is the authority). We
      // deliberately do NOT bump payloadVersion — the extractor row stays
      // at its original version; only the field was overridden.
      if (existing && patched) {
        await storage.upsertDocumentExtraction({
          documentId: doc.id,
          organizationId: currentUser.organizationId,
          classLabel: existing.classLabel,
          payloadVersion: existing.payloadVersion,
          payload: patched,
          extractionStatus: existing.extractionStatus,
          needsReviewReason: existing.needsReviewReason,
          extractorModel: existing.extractorModel,
        });
      }
      res.json({ correction });
    } catch (err) {
      console.error("[copilot/documents/:id/corrections POST]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to record correction" });
    }
  });

  // Admin force-extract — re-run the rate-con pipeline (or run it for the
  // first time on a doc that was misclassified into rate_con manually).
  app.post("/api/admin/copilot/documents/:id/extract", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdminish(currentUser.role)) return res.status(403).json({ error: "Admin access required" });
      const docId = pStr(req.params.id);
      const doc = await storage.getDocumentInOrg(docId, currentUser.organizationId);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const result = await runRateConPipeline({
        documentId: doc.id,
        organizationId: currentUser.organizationId,
        force: true,
      });
      res.json({
        documentId: doc.id,
        status: result.status,
        reason: result.reason,
        linkCount: result.links.length,
        findingCount: result.findings.length,
      });
    } catch (err) {
      console.error("[admin/copilot/documents/:id/extract POST]", getErrorMessage(err));
      res.status(500).json({ error: "Force-extract failed" });
    }
  });

  // Admin — list current confidence overrides.
  app.get("/api/admin/copilot/extraction-overrides", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdminish(currentUser.role)) return res.status(403).json({ error: "Admin access required" });
      const overrides = await storage.listFieldConfidenceOverrides(currentUser.organizationId);
      res.json({ overrides });
    } catch (err) {
      console.error("[admin/copilot/extraction-overrides GET]", getErrorMessage(err));
      res.status(500).json({ error: "Failed to load overrides" });
    }
  });

  // Admin — recompute confidence overrides on demand.
  app.post("/api/admin/copilot/extraction-overrides/recompute", requireAuth, async (req, res) => {
    try {
      const currentUser = await getCurrentUser(req);
      if (!currentUser) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdminish(currentUser.role)) return res.status(403).json({ error: "Admin access required" });
      const result = await calibrateRateConConfidence({ organizationId: currentUser.organizationId });
      res.json(result);
    } catch (err) {
      console.error("[admin/copilot/extraction-overrides/recompute POST]", getErrorMessage(err));
      res.status(500).json({ error: "Recompute failed" });
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
