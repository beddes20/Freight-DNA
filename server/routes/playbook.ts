/**
 * Playbook Module Routes (Task #300)
 *
 * Plays as first-class objects: managers author/version/publish, reps run them,
 * outcomes roll up to per-play analytics.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  plays,
  playVersions,
  playRuns,
  playOutcomes,
  tasks,
  type Play,
} from "@shared/schema";
import {
  PLAYBOOK_IMPORT_FIELDS,
  buildPlaybookImportPreview,
  validateRow,
  type ParsedPlayRow,
} from "../lib/playbookImport";
import * as XLSX from "xlsx";
import multer from "multer";

const playbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

/**
 * Parse a raw .xlsx or .csv buffer into header-keyed string rows.
 * Header normalization: trims whitespace and drops empty header columns.
 * Exposed for route handlers and tests.
 */
export function parsePlaybookSpreadsheet(buffer: Buffer | ArrayBuffer): {
  headers: string[];
  rows: Array<Record<string, string>>;
} {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const ws = wb.Sheets[sheetName];
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as unknown[][];
  if (!aoa || aoa.length < 1) return { headers: [], rows: [] };
  const headerCells = (aoa[0] ?? []).map((h) => String(h ?? "").trim());
  const headers: string[] = [];
  const colIdxs: number[] = [];
  headerCells.forEach((h, i) => { if (h) { headers.push(h); colIdxs.push(i); } });
  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    const hasAny = row.some((c) => c != null && String(c).trim() !== "");
    if (!hasAny) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = row[colIdxs[i]];
      obj[h] = v == null ? "" : String(v).trim();
    });
    rows.push(obj);
  }
  return { headers, rows };
}

const AUTHOR_ROLES = new Set(["admin", "director", "national_account_manager", "sales_director", "logistics_manager"]);
const isAuthor = (role: string | null | undefined) => AUTHOR_ROLES.has(String(role));

const stepSchema = z.string().min(1).max(500);
const triggerTypeSchema = z.enum(["manual", "quote_no_response", "award_no_carrier", "sentiment_drop", "signal_match"]);
const playInputSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(1000).optional().nullable(),
  audience: z.enum(["customer", "carrier"]).default("customer"),
  channel: z.enum(["email", "call", "in_person"]).default("email"),
  triggerType: triggerTypeSchema.default("manual"),
  triggerConfig: z.record(z.any()).optional().default({}),
  signalType: z.string().max(80).optional().nullable(),
  recommendedSteps: z.array(stepSchema).max(20).default([]),
  templateBody: z.string().max(8000).default(""),
  successMetric: z.string().max(400).default(""),
  outcomeWindowHours: z.number().int().min(1).max(24 * 60).default(96),
});

function snapshotOf(p: Play): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    audience: p.audience,
    channel: p.channel,
    triggerType: p.triggerType,
    triggerConfig: p.triggerConfig,
    signalType: p.signalType,
    recommendedSteps: p.recommendedSteps,
    templateBody: p.templateBody,
    successMetric: p.successMetric,
    outcomeWindowHours: p.outcomeWindowHours,
  };
}

/**
 * Evaluate triggers for an org's published plays — produces idempotent
 * `suggested` play_runs across all four trigger types:
 *
 *   • signal_match       → email_signals matching play.signalType
 *   • quote_no_response  → CRM opportunities in a quote-like stage with no
 *                          status change inside triggerConfig.windowHours
 *   • award_no_carrier   → open carrier_procurement tasks older than
 *                          triggerConfig.windowHours
 *   • sentiment_drop     → contactSentimentTracking rows with declining trend
 *                          or score below triggerConfig.minScore
 *
 * Idempotency: each branch joins LEFT to play_runs on (play_id, reference_type,
 * reference_id) and skips matches already seeded.
 */
export async function evaluatePlayTriggersForOrg(orgId: string): Promise<{ created: number }> {
  const published = await db.select().from(plays)
    .where(and(eq(plays.orgId, orgId), eq(plays.status, "published")));
  if (!published.length) return { created: 0 };

  let created = 0;
  for (const p of published) {
    const cfg = (p.triggerConfig ?? {}) as Record<string, unknown>;
    const windowHours = Number(cfg.windowHours ?? cfg.window_hours ?? 72);
    const minScore = Number(cfg.minScore ?? cfg.min_score ?? 40);

    if (p.triggerType === "signal_match" && p.signalType) {
      type SignalRow = { id: string; contact_id: string | null; signal_subtype: string | null };
      const recent = await db.execute<SignalRow>(sql`
        SELECT s.id, s.contact_id, s.signal_subtype
        FROM email_signals s
        WHERE s.org_id = ${orgId}
          AND s.signal_type = ${p.signalType}
          AND s.created_at > NOW() - INTERVAL '14 days'
          AND NOT EXISTS (
            SELECT 1 FROM play_runs r
            WHERE r.play_id = ${p.id}
              AND r.reference_type = 'email_signal'
              AND r.reference_id = s.id
          )
        LIMIT 50
      `);
      for (const row of recent.rows ?? []) {
        await db.insert(playRuns).values({
          orgId,
          playId: p.id,
          playVersion: p.currentVersion,
          repUserId: null,
          accountId: null,
          accountName: null,
          contactId: row.contact_id,
          referenceType: "email_signal",
          referenceId: row.id,
          status: "suggested",
          triggerSnapshot: { signalType: p.signalType, signalSubtype: row.signal_subtype },
        }).onConflictDoNothing();
        created++;
      }
      continue;
    }

    if (p.triggerType === "quote_no_response") {
      // Opportunities sitting in a quote-style stage past window without an outcome.
      type OppRow = { id: number; company_id: string | null; name: string; updated_at: string };
      const stale = await db.execute<OppRow>(sql`
        SELECT o.id, o.company_id, o.name, o.updated_at::text AS updated_at
        FROM crm_opportunities o
        WHERE o.organization_id = ${orgId}
          AND o.outcome IS NULL
          AND o.stage IN ('proposal','quoted','quote_sent','negotiation')
          AND o.updated_at < NOW() - (${windowHours}::int * INTERVAL '1 hour')
          AND NOT EXISTS (
            SELECT 1 FROM play_runs r
            WHERE r.play_id = ${p.id}
              AND r.reference_type = 'crm_opportunity'
              AND r.reference_id = o.id::text
          )
        LIMIT 50
      `);
      for (const row of stale.rows ?? []) {
        await db.insert(playRuns).values({
          orgId,
          playId: p.id,
          playVersion: p.currentVersion,
          repUserId: null,
          accountId: row.company_id,
          accountName: row.name,
          contactId: null,
          referenceType: "crm_opportunity",
          referenceId: String(row.id),
          status: "suggested",
          triggerSnapshot: { triggerType: "quote_no_response", windowHours, lastUpdatedAt: row.updated_at },
        }).onConflictDoNothing();
        created++;
      }
      continue;
    }

    if (p.triggerType === "award_no_carrier") {
      // Open carrier_procurement tasks past window.
      type TaskRow = { id: string; company_id: string | null; company_name: string | null; created_at: string };
      const stale = await db.execute<TaskRow>(sql`
        SELECT t.id, t.company_id, t.company_name, t.created_at
        FROM tasks t
        WHERE t.org_id = ${orgId}
          AND t.status = 'open'
          AND t.attached_lane_data @> '[{"type":"carrier_procurement"}]'::jsonb
          AND t.created_at < (NOW() - (${windowHours}::int * INTERVAL '1 hour'))::text
          AND NOT EXISTS (
            SELECT 1 FROM play_runs r
            WHERE r.play_id = ${p.id}
              AND r.reference_type = 'task'
              AND r.reference_id = t.id
          )
        LIMIT 50
      `);
      for (const row of stale.rows ?? []) {
        await db.insert(playRuns).values({
          orgId,
          playId: p.id,
          playVersion: p.currentVersion,
          repUserId: null,
          accountId: row.company_id,
          accountName: row.company_name,
          contactId: null,
          referenceType: "task",
          referenceId: row.id,
          status: "suggested",
          triggerSnapshot: { triggerType: "award_no_carrier", windowHours, taskCreatedAt: row.created_at },
        }).onConflictDoNothing();
        created++;
      }
      continue;
    }

    if (p.triggerType === "sentiment_drop") {
      type SentRow = { id: string; contact_id: string; org_id: string; sentiment_score: number; sentiment_trend: string };
      const drops = await db.execute<SentRow>(sql`
        SELECT id, contact_id, org_id, sentiment_score, sentiment_trend
        FROM contact_sentiment_tracking
        WHERE org_id = ${orgId}
          AND (sentiment_trend = 'declining' OR sentiment_score < ${minScore})
          AND updated_at > NOW() - INTERVAL '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM play_runs r
            WHERE r.play_id = ${p.id}
              AND r.reference_type = 'contact_sentiment'
              AND r.reference_id = contact_sentiment_tracking.id
          )
        LIMIT 50
      `);
      for (const row of drops.rows ?? []) {
        await db.insert(playRuns).values({
          orgId,
          playId: p.id,
          playVersion: p.currentVersion,
          repUserId: null,
          accountId: null,
          accountName: null,
          contactId: row.contact_id,
          referenceType: "contact_sentiment",
          referenceId: row.id,
          status: "suggested",
          triggerSnapshot: { triggerType: "sentiment_drop", score: row.sentiment_score, trend: row.sentiment_trend, minScore },
        }).onConflictDoNothing();
        created++;
      }
      continue;
    }
  }
  return { created };
}

export function registerPlaybookRoutes(app: Express): void {
  // ── Import: download .xlsx template ──────────────────────────────────────
  app.get("/api/playbook/import/template", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });

      const headers = PLAYBOOK_IMPORT_FIELDS.map(f => f.label.replace(" *", ""));
      const example = [
        "Re-engage stalled quote",
        "Re-open conversation when a quote has gone quiet for 3+ days.",
        "customer",
        "email",
        "quote_no_response",
        "1) Open the original quote\n2) Send a friendly nudge\n3) Offer a 15-min call",
        "Hi {{contactName}}, checking in on the quote we sent for {{laneOrigin}} → {{laneDest}}. Anything we can adjust?",
        "Reply within 96h",
        "96",
      ];
      const ws = XLSX.utils.aoa_to_sheet([headers, example]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Plays");
      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="playbook-import-template.xlsx"`);
      res.send(buffer);
    } catch (err: any) {
      console.error("[playbook] template error:", err);
      res.status(500).json({ error: "Failed to build template" });
    }
  });

  // ── Import: server-side parse of uploaded .xlsx/.csv ─────────────────────
  // Accepts a multipart upload, normalizes headers, and returns the parsed
  // header list + raw rows so the client can drive its mapping UI without
  // having to also implement spreadsheet parsing in the browser.
  app.post(
    "/api/playbook/import/parse",
    requireAuth,
    playbookUpload.single("file"),
    async (req, res) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });
        const file = (req as unknown as { file?: { buffer: Buffer; originalname?: string } }).file;
        if (!file?.buffer) return res.status(400).json({ error: "Missing file" });
        const parsed = parsePlaybookSpreadsheet(file.buffer);
        if (parsed.headers.length === 0) return res.status(400).json({ error: "No header row detected" });
        if (parsed.rows.length === 0) return res.status(400).json({ error: "No data rows detected" });
        res.json({ headers: parsed.headers, rows: parsed.rows });
      } catch (err: any) {
        console.error("[playbook] parse error:", err);
        res.status(500).json({ error: "Failed to parse file" });
      }
    },
  );

  // ── Import: preview parsed rows w/ validation + dup detection ────────────
  const previewSchema = z.object({
    rows: z.array(z.record(z.any())).max(2000),
  });
  app.post("/api/playbook/import/preview", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });
      const { rows } = previewSchema.parse(req.body);

      const existing = await db.select({ name: plays.name, status: plays.status })
        .from(plays)
        .where(and(eq(plays.orgId, user.organizationId)));
      const existingNames = existing.filter(p => p.status !== "archived").map(p => p.name);

      const stringRows = rows.map(r => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) out[k] = v == null ? "" : String(v);
        return out;
      });
      const preview = buildPlaybookImportPreview(stringRows, existingNames);
      res.json({ preview });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] import preview error:", err);
      res.status(500).json({ error: "Failed to preview import" });
    }
  });

  // ── Import: bulk-create plays as drafts ──────────────────────────────────
  const importSchema = z.object({
    rows: z.array(z.record(z.any())).max(2000),
    overwriteDuplicates: z.boolean().optional().default(false),
  });
  app.post("/api/playbook/import", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });
      const { rows, overwriteDuplicates } = importSchema.parse(req.body);

      const existing = await db.select().from(plays)
        .where(eq(plays.orgId, user.organizationId));
      const existingByName = new Map<string, typeof existing[number]>();
      for (const p of existing) {
        if (p.status !== "archived") existingByName.set(p.name.toLowerCase(), p);
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      const errors: Array<{ row: number; error: string }> = [];
      const seenInBatch = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i];
        const stringRow: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) stringRow[k] = v == null ? "" : String(v);

        const { parsed, errors: rowErrors } = validateRow(stringRow);
        if (!parsed) {
          errors.push({ row: i + 1, error: rowErrors.join("; ") });
          skipped++;
          continue;
        }
        const key = parsed.name.toLowerCase();
        if (seenInBatch.has(key)) {
          skipped++;
          errors.push({ row: i + 1, error: "Duplicate name within file" });
          continue;
        }
        const existingMatch = existingByName.get(key);
        if (existingMatch && !overwriteDuplicates) {
          skipped++;
          continue;
        }
        seenInBatch.add(key);

        try {
          if (existingMatch && overwriteDuplicates) {
            // Overwrite as a NEW DRAFT VERSION of the existing play
            // (mirrors the PATCH flow when a published play is edited):
            // bump current_version, flip status back to draft, replace
            // play fields, and append a new play_versions snapshot.
            const newVersion = existingMatch.currentVersion + 1;
            const [updatedPlay] = await db.update(plays).set({
              name: parsed.name,
              description: parsed.description,
              audience: parsed.audience,
              channel: parsed.channel,
              triggerType: parsed.triggerType,
              recommendedSteps: parsed.recommendedSteps,
              templateBody: parsed.templateBody,
              successMetric: parsed.successMetric,
              outcomeWindowHours: parsed.outcomeWindowHours,
              status: "draft",
              currentVersion: newVersion,
              updatedAt: new Date(),
            }).where(eq(plays.id, existingMatch.id)).returning();
            await db.insert(playVersions).values({
              playId: updatedPlay.id,
              version: newVersion,
              snapshot: snapshotOf(updatedPlay),
              publishedAt: null,
              createdBy: user.id,
            });
            updated++;
          } else {
            const [createdPlay] = await db.insert(plays).values({
              orgId: user.organizationId,
              name: parsed.name,
              description: parsed.description,
              audience: parsed.audience,
              channel: parsed.channel,
              triggerType: parsed.triggerType,
              triggerConfig: {},
              signalType: null,
              recommendedSteps: parsed.recommendedSteps,
              templateBody: parsed.templateBody,
              successMetric: parsed.successMetric,
              outcomeWindowHours: parsed.outcomeWindowHours,
              status: "draft",
              createdBy: user.id,
            }).returning();
            await db.insert(playVersions).values({
              playId: createdPlay.id,
              version: 1,
              snapshot: snapshotOf(createdPlay),
              publishedAt: null,
              createdBy: user.id,
            });
            created++;
          }
        } catch (e: any) {
          console.error("[playbook] import insert error row", i + 1, e);
          errors.push({ row: i + 1, error: String(e?.message ?? e) });
          skipped++;
        }
      }

      res.json({ created, updated, skipped, errors });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] import error:", err);
      res.status(500).json({ error: "Failed to import" });
    }
  });

  // ── List plays ────────────────────────────────────────────────────────────
  app.get("/api/playbook/plays", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { triggerType, channel, audience, status } = req.query as Record<string, string | undefined>;
      const conds = [eq(plays.orgId, user.organizationId)];
      if (triggerType) conds.push(eq(plays.triggerType, triggerType));
      if (channel) conds.push(eq(plays.channel, channel));
      if (audience) conds.push(eq(plays.audience, audience));
      // Authz: non-authors are HARD-LOCKED to published plays regardless of any
      // status filter they send (prevents draft/archived disclosure via query
      // param manipulation). Authors may filter by any status.
      if (!isAuthor(user.role)) {
        conds.push(eq(plays.status, "published"));
      } else if (status) {
        conds.push(eq(plays.status, status));
      }

      const rows = await db.select().from(plays)
        .where(and(...conds))
        .orderBy(desc(plays.updatedAt));
      res.json({ plays: rows, canAuthor: isAuthor(user.role) });
    } catch (err: any) {
      console.error("[playbook] list error:", err);
      res.status(500).json({ error: "Failed to load plays" });
    }
  });

  // ── Get one play with versions ────────────────────────────────────────────
  app.get("/api/playbook/plays/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const [play] = await db.select().from(plays)
        .where(and(eq(plays.id, String(req.params.id)), eq(plays.orgId, user.organizationId)));
      if (!play) return res.status(404).json({ error: "Play not found" });
      if (!isAuthor(user.role) && play.status !== "published") {
        return res.status(404).json({ error: "Play not found" });
      }
      const versions = await db.select().from(playVersions)
        .where(eq(playVersions.playId, play.id))
        .orderBy(desc(playVersions.version));
      res.json({ play, versions, canAuthor: isAuthor(user.role) });
    } catch (err: any) {
      console.error("[playbook] get error:", err);
      res.status(500).json({ error: "Failed to load play" });
    }
  });

  // ── Create play (drafts v1) ───────────────────────────────────────────────
  app.post("/api/playbook/plays", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });
      const parsed = playInputSchema.parse(req.body);
      const [created] = await db.insert(plays).values({
        orgId: user.organizationId,
        name: parsed.name,
        description: parsed.description ?? null,
        audience: parsed.audience,
        channel: parsed.channel,
        triggerType: parsed.triggerType,
        triggerConfig: parsed.triggerConfig ?? {},
        signalType: parsed.signalType ?? null,
        recommendedSteps: parsed.recommendedSteps,
        templateBody: parsed.templateBody,
        successMetric: parsed.successMetric,
        outcomeWindowHours: parsed.outcomeWindowHours,
        status: "draft",
        createdBy: user.id,
      }).returning();
      await db.insert(playVersions).values({
        playId: created.id,
        version: 1,
        snapshot: snapshotOf(created),
        publishedAt: null,
        createdBy: user.id,
      });
      res.json({ play: created });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] create error:", err);
      res.status(500).json({ error: "Failed to create play" });
    }
  });

  // ── Update play (bumps version when previously published) ─────────────────
  app.patch("/api/playbook/plays/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });
      const [existing] = await db.select().from(plays)
        .where(and(eq(plays.id, String(req.params.id)), eq(plays.orgId, user.organizationId)));
      if (!existing) return res.status(404).json({ error: "Play not found" });

      const parsed = playInputSchema.partial().parse(req.body);
      const merged: Partial<typeof plays.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (parsed.name !== undefined) merged.name = parsed.name;
      if (parsed.description !== undefined) merged.description = parsed.description ?? null;
      if (parsed.audience !== undefined) merged.audience = parsed.audience;
      if (parsed.channel !== undefined) merged.channel = parsed.channel;
      if (parsed.triggerType !== undefined) merged.triggerType = parsed.triggerType;
      if (parsed.triggerConfig !== undefined) merged.triggerConfig = parsed.triggerConfig;
      if (parsed.signalType !== undefined) merged.signalType = parsed.signalType ?? null;
      if (parsed.recommendedSteps !== undefined) merged.recommendedSteps = parsed.recommendedSteps;
      if (parsed.templateBody !== undefined) merged.templateBody = parsed.templateBody;
      if (parsed.successMetric !== undefined) merged.successMetric = parsed.successMetric;
      if (parsed.outcomeWindowHours !== undefined) merged.outcomeWindowHours = parsed.outcomeWindowHours;

      const willBumpVersion = existing.status === "published";
      if (willBumpVersion) {
        merged.currentVersion = existing.currentVersion + 1;
        merged.status = "draft";
      }

      const [updated] = await db.update(plays).set(merged)
        .where(eq(plays.id, existing.id))
        .returning();

      if (willBumpVersion) {
        await db.insert(playVersions).values({
          playId: updated.id,
          version: updated.currentVersion,
          snapshot: snapshotOf(updated),
          publishedAt: null,
          createdBy: user.id,
        });
      } else {
        // Patch the existing draft version snapshot.
        await db.update(playVersions)
          .set({ snapshot: snapshotOf(updated) })
          .where(and(eq(playVersions.playId, updated.id), eq(playVersions.version, updated.currentVersion)));
      }

      res.json({ play: updated });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] update error:", err);
      res.status(500).json({ error: "Failed to update play" });
    }
  });

  // ── Publish ───────────────────────────────────────────────────────────────
  app.post("/api/playbook/plays/:id/publish", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });
      const [existing] = await db.select().from(plays)
        .where(and(eq(plays.id, String(req.params.id)), eq(plays.orgId, user.organizationId)));
      if (!existing) return res.status(404).json({ error: "Play not found" });
      const [updated] = await db.update(plays)
        .set({ status: "published", updatedAt: new Date() })
        .where(eq(plays.id, existing.id))
        .returning();
      await db.update(playVersions)
        .set({ publishedAt: new Date() })
        .where(and(eq(playVersions.playId, updated.id), eq(playVersions.version, updated.currentVersion)));
      res.json({ play: updated });
    } catch (err: any) {
      console.error("[playbook] publish error:", err);
      res.status(500).json({ error: "Failed to publish play" });
    }
  });

  // ── Archive ───────────────────────────────────────────────────────────────
  app.post("/api/playbook/plays/:id/archive", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });
      const [updated] = await db.update(plays)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(plays.id, String(req.params.id)), eq(plays.orgId, user.organizationId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Play not found" });
      res.json({ play: updated });
    } catch (err: any) {
      console.error("[playbook] archive error:", err);
      res.status(500).json({ error: "Failed to archive play" });
    }
  });

  // ── Run play ─────────────────────────────────────────────────────────────
  // Anyone in the org can run a published play. Returns a draft email body for
  // channel=email, or a structured task list for call/in_person.
  const runSchema = z.object({
    accountId: z.string().optional().nullable(),
    accountName: z.string().optional().nullable(),
    laneId: z.string().optional().nullable(),
    contactId: z.string().optional().nullable(),
    referenceType: z.string().optional().nullable(),
    referenceId: z.string().optional().nullable(),
    suggestedRunId: z.string().optional().nullable(), // promote a 'suggested' run
    variables: z.record(z.string()).optional().default({}),
  });
  app.post("/api/playbook/plays/:id/run", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const [play] = await db.select().from(plays)
        .where(and(eq(plays.id, String(req.params.id)), eq(plays.orgId, user.organizationId)));
      if (!play || play.status !== "published") return res.status(404).json({ error: "Play not found" });

      const parsed = runSchema.parse(req.body);

      // Promote an existing suggestion to open, or create a fresh open run.
      let runId: string;
      if (parsed.suggestedRunId) {
        // Authz: only promote runs that are still in 'suggested' status, scoped
        // to org+play. This prevents hijacking another rep's open/completed run.
        //
        // Context preservation: the trigger evaluator seeded this row with
        // account/lane/contact/reference context. On promotion we only OVERRIDE
        // those fields when the rep explicitly provides a new value — otherwise
        // we preserve the existing trigger-detected context so analytics can
        // attribute outcomes to the original play+account+rep tuple.
        const promoteSet: Partial<typeof playRuns.$inferInsert> = {
          status: "open",
          startedAt: new Date(),
          repUserId: user.id,
        };
        if (parsed.accountId !== undefined && parsed.accountId !== null) promoteSet.accountId = parsed.accountId;
        if (parsed.accountName !== undefined && parsed.accountName !== null) promoteSet.accountName = parsed.accountName;
        if (parsed.laneId !== undefined && parsed.laneId !== null) promoteSet.laneId = parsed.laneId;
        if (parsed.contactId !== undefined && parsed.contactId !== null) promoteSet.contactId = parsed.contactId;

        const [promoted] = await db.update(playRuns)
          .set(promoteSet)
          .where(and(
            eq(playRuns.id, parsed.suggestedRunId),
            eq(playRuns.orgId, user.organizationId),
            eq(playRuns.playId, play.id),
            eq(playRuns.status, "suggested"),
          ))
          .returning();
        if (!promoted) return res.status(404).json({ error: "Suggested run not found or already claimed" });
        runId = promoted.id;
        // Back-fill parsed.* from the promoted row so downstream task creation
        // (below) uses the preserved trigger context.
        if (!parsed.accountId) parsed.accountId = promoted.accountId ?? null;
        if (!parsed.accountName) parsed.accountName = promoted.accountName ?? null;
        if (!parsed.contactId) parsed.contactId = promoted.contactId ?? null;
      } else {
        const [created] = await db.insert(playRuns).values({
          orgId: user.organizationId,
          playId: play.id,
          playVersion: play.currentVersion,
          repUserId: user.id,
          accountId: parsed.accountId ?? null,
          accountName: parsed.accountName ?? null,
          laneId: parsed.laneId ?? null,
          contactId: parsed.contactId ?? null,
          referenceType: parsed.referenceType ?? null,
          referenceId: parsed.referenceId ?? null,
          status: "open",
          startedAt: new Date(),
        }).returning();
        runId = created.id;
      }

      // Render template with provided variables (best-effort {{var}} substitution).
      const vars = parsed.variables ?? {};
      const rendered = String(play.templateBody ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => {
        return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{{${k}}}`;
      });

      // Run play wiring (Task #300):
      //   • channel=email → return renderedBody so the client opens the existing
      //     compose/draft pathway prefilled with the play body
      //   • channel=call|in_person → create a structured Task in the existing
      //     tasks surface so the rep gets a concrete action item
      let createdTaskId: string | null = null;
      if (play.channel === "call" || play.channel === "in_person") {
        try {
          const nowIso = new Date().toISOString();
          const stepsBlock = (play.recommendedSteps ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n");
          const description = [
            rendered,
            stepsBlock ? `\n\nSteps:\n${stepsBlock}` : "",
            play.successMetric ? `\n\nSuccess metric: ${play.successMetric}` : "",
          ].join("");
          const [task] = await db.insert(tasks).values({
            title: `Play: ${play.name}`,
            description,
            status: "open",
            assignedTo: user.id,
            assignedBy: user.id,
            companyId: parsed.accountId ?? null,
            companyName: parsed.accountName ?? null,
            contactId: parsed.contactId ?? null,
            orgId: user.organizationId,
            lever: `play:${play.id}`,
            createdAt: nowIso,
            updatedAt: nowIso,
          }).returning();
          createdTaskId = task.id;
          await db.update(playRuns)
            .set({ referenceType: "task", referenceId: task.id })
            .where(eq(playRuns.id, runId));
        } catch (taskErr) {
          console.warn("[playbook] task creation failed (non-fatal):", taskErr);
        }
      }

      res.json({
        runId,
        play: { id: play.id, name: play.name, channel: play.channel, audience: play.audience },
        renderedBody: rendered,
        recommendedSteps: play.recommendedSteps ?? [],
        successMetric: play.successMetric,
        outcomeWindowHours: play.outcomeWindowHours,
        taskId: createdTaskId,
        // Hint for client: where to redirect after run starts.
        nextAction: play.channel === "email"
          ? { type: "compose_email", body: rendered }
          : { type: "open_task", taskId: createdTaskId },
      });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] run error:", err);
      res.status(500).json({ error: "Failed to start play run" });
    }
  });

  // ── Mark a play run's email as sent (Task #302) ──────────────────────────
  // Client calls this after the rep actually sends the play email so we can
  // (a) stamp the Outlook conversationId/messageId for inbound matching,
  // (b) seed the pending play_outcome row whose window_expires_at drives the
  //     no_response sweep when nobody replies in the configured window.
  const sentSchema = z.object({
    threadId: z.string().min(1).max(512),
    providerMessageId: z.string().min(1).max(512),
    sentAt: z.string().datetime().optional(),
  });
  app.post("/api/playbook/runs/:runId/sent", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const [run] = await db.select().from(playRuns)
        .where(and(eq(playRuns.id, String(req.params.runId)), eq(playRuns.orgId, user.organizationId)));
      if (!run) return res.status(404).json({ error: "Run not found" });
      if (run.repUserId && run.repUserId !== user.id && !isAuthor(user.role)) {
        return res.status(403).json({ error: "Only the assigned rep or a manager can mark this run sent" });
      }
      const parsed = sentSchema.parse(req.body);
      const sentAt = parsed.sentAt ? new Date(parsed.sentAt) : new Date();

      const [play] = await db.select().from(plays).where(eq(plays.id, run.playId));
      if (!play) return res.status(404).json({ error: "Play not found" });

      await db.update(playRuns).set({
        threadId: parsed.threadId,
        providerMessageId: parsed.providerMessageId,
        sentAt,
      }).where(eq(playRuns.id, run.id));

      const windowExpiresAt = new Date(sentAt.getTime() + play.outcomeWindowHours * 36e5);
      const [existing] = await db.select().from(playOutcomes).where(eq(playOutcomes.playRunId, run.id));
      if (existing) {
        // Only re-arm if still pending; never reset a classified/overridden row.
        if (existing.status === "pending") {
          await db.update(playOutcomes).set({ windowExpiresAt }).where(eq(playOutcomes.id, existing.id));
        }
      } else {
        await db.insert(playOutcomes).values({
          playRunId: run.id,
          outcome: "no_response",
          status: "pending",
          windowExpiresAt,
        });
      }
      res.json({ ok: true, runId: run.id, windowExpiresAt: windowExpiresAt.toISOString() });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] sent error:", err);
      res.status(500).json({ error: "Failed to mark run sent" });
    }
  });

  // ── Override a classifier-assigned outcome (Task #302) ───────────────────
  const overrideSchema = z.object({
    label: z.enum(["won", "lost", "partial", "no_response", "bounced"]),
    reason: z.string().max(1000).optional().nullable(),
  });
  app.post("/api/playbook/runs/:runId/override", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const [run] = await db.select().from(playRuns)
        .where(and(eq(playRuns.id, String(req.params.runId)), eq(playRuns.orgId, user.organizationId)));
      if (!run) return res.status(404).json({ error: "Run not found" });
      const isOwner = run.repUserId === user.id;
      if (!isOwner && !isAuthor(user.role)) {
        return res.status(403).json({ error: "Only the rep who started this run or a manager can override its outcome" });
      }
      const parsed = overrideSchema.parse(req.body);

      // Map to legacy outcome enum so existing analytics keep working.
      const legacyOutcome = parsed.label === "won" || parsed.label === "partial"
        ? "success"
        : parsed.label === "lost"
          ? "fail"
          : "no_response";

      const [existing] = await db.select().from(playOutcomes).where(eq(playOutcomes.playRunId, run.id));
      if (existing) {
        await db.update(playOutcomes).set({
          status: "overridden",
          overrideLabel: parsed.label,
          overrideUserId: user.id,
          overrideReason: parsed.reason ?? null,
          overrideAt: new Date(),
          outcome: legacyOutcome,
          recordedBy: user.id,
        }).where(eq(playOutcomes.id, existing.id));
      } else {
        await db.insert(playOutcomes).values({
          playRunId: run.id,
          outcome: legacyOutcome,
          status: "overridden",
          overrideLabel: parsed.label,
          overrideUserId: user.id,
          overrideReason: parsed.reason ?? null,
          overrideAt: new Date(),
          recordedBy: user.id,
        });
      }
      await db.update(playRuns).set({
        status: "completed",
        completedAt: run.completedAt ?? new Date(),
      }).where(eq(playRuns.id, run.id));
      res.json({ ok: true, runId: run.id, label: parsed.label });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] override error:", err);
      res.status(500).json({ error: "Failed to override outcome" });
    }
  });

  // ── Record outcome on a run ──────────────────────────────────────────────
  const outcomeSchema = z.object({
    outcome: z.enum(["success", "fail", "no_response"]),
    notes: z.string().max(2000).optional().nullable(),
  });
  app.post("/api/playbook/runs/:runId/outcome", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const [run] = await db.select().from(playRuns)
        .where(and(eq(playRuns.id, String(req.params.runId)), eq(playRuns.orgId, user.organizationId)));
      if (!run) return res.status(404).json({ error: "Run not found" });

      // Authz: only the rep who owns the run, or a manager/admin, can record an outcome.
      // Status must be 'open' (or 'completed' for an upsert correction).
      const isOwner = run.repUserId === user.id;
      if (!isOwner && !isAuthor(user.role)) {
        return res.status(403).json({ error: "Only the rep who started this run or a manager can record its outcome" });
      }
      if (run.status !== "open" && run.status !== "completed") {
        return res.status(409).json({ error: "Run must be started before recording an outcome" });
      }
      const parsed = outcomeSchema.parse(req.body);

      const startedAt = run.startedAt ?? run.suggestedAt;
      const hours = startedAt ? Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime()) / 36e5)) : null;

      // Upsert outcome (one outcome per run). Setting status='recorded'
      // here is critical (Task #302): it takes the row out of the 'pending'
      // bucket so the window-expiry sweep can never overwrite a manually
      // recorded success/fail with no_response when the window elapses.
      const [existing] = await db.select().from(playOutcomes).where(eq(playOutcomes.playRunId, run.id));
      if (existing) {
        await db.update(playOutcomes).set({
          outcome: parsed.outcome,
          notes: parsed.notes ?? null,
          timeToOutcomeHours: hours,
          recordedBy: user.id,
          recordedAt: new Date(),
          status: "recorded",
        }).where(eq(playOutcomes.id, existing.id));
      } else {
        await db.insert(playOutcomes).values({
          playRunId: run.id,
          outcome: parsed.outcome,
          notes: parsed.notes ?? null,
          timeToOutcomeHours: hours,
          recordedBy: user.id,
          status: "recorded",
        });
      }

      await db.update(playRuns).set({
        status: "completed",
        completedAt: new Date(),
      }).where(eq(playRuns.id, run.id));

      res.json({ ok: true, runId: run.id });
    } catch (err: any) {
      if (err?.issues) return res.status(400).json({ error: err.issues });
      console.error("[playbook] outcome error:", err);
      res.status(500).json({ error: "Failed to record outcome" });
    }
  });

  // ── My runs (rep's plays in flight or recently completed) ────────────────
  app.get("/api/playbook/runs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const requestedScope = String(req.query.scope ?? "me");
      // Only managers/admins can request 'org' scope; everyone else is forced to 'me'.
      const scope = requestedScope === "org" && isAuthor(user.role) ? "org" : "me";
      const status = req.query.status ? String(req.query.status) : null;

      const conds = [eq(playRuns.orgId, user.organizationId)];
      if (scope === "me") conds.push(eq(playRuns.repUserId, user.id));
      if (status) conds.push(eq(playRuns.status, status));

      const rows = await db.select({
        run: playRuns,
        play: { id: plays.id, name: plays.name, channel: plays.channel, audience: plays.audience },
        outcome: playOutcomes,
      })
        .from(playRuns)
        .innerJoin(plays, eq(plays.id, playRuns.playId))
        .leftJoin(playOutcomes, eq(playOutcomes.playRunId, playRuns.id))
        .where(and(...conds))
        .orderBy(desc(playRuns.suggestedAt))
        .limit(200);

      res.json({ runs: rows });
    } catch (err: any) {
      console.error("[playbook] runs error:", err);
      res.status(500).json({ error: "Failed to load runs" });
    }
  });

  // ── Triggered plays for current user (suggested runs) ────────────────────
  // Used by My Procurement / LWQ to show "Run play" prompts.
  app.get("/api/playbook/triggered", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      // Best-effort evaluate before reading.
      await evaluatePlayTriggersForOrg(user.organizationId).catch(() => {});

      const rows = await db.select({
        run: playRuns,
        play: { id: plays.id, name: plays.name, channel: plays.channel, audience: plays.audience, signalType: plays.signalType },
      })
        .from(playRuns)
        .innerJoin(plays, eq(plays.id, playRuns.playId))
        .where(and(
          eq(playRuns.orgId, user.organizationId),
          eq(playRuns.status, "suggested"),
        ))
        .orderBy(desc(playRuns.suggestedAt))
        .limit(50);
      res.json({ triggered: rows });
    } catch (err: any) {
      console.error("[playbook] triggered error:", err);
      res.status(500).json({ error: "Failed to evaluate triggered plays" });
    }
  });

  // ── Analytics: per-play win rate, median time-to-outcome, top reps ───────
  // Manager/admin only — reps see plays + their own runs but not org analytics.
  app.get("/api/playbook/analytics", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAuthor(user.role)) return res.status(403).json({ error: "Manager/Admin only" });

      type AnalyticsRow = {
        play_id: string;
        name: string;
        audience: string;
        channel: string;
        status: string;
        completed_runs: number;
        success_count: number;
        fail_count: number;
        no_response_count: number;
        median_hours: number | null;
      };
      // Bounced outcomes are intentionally excluded from win-rate math
      // (Task #302) — they reflect contact-data hygiene, not play quality.
      const result = await db.execute<AnalyticsRow>(sql`
        SELECT
          p.id AS play_id,
          p.name,
          p.audience,
          p.channel,
          p.status,
          COUNT(r.id) FILTER (WHERE r.status = 'completed' AND COALESCE(o.status, '') <> 'bounced')::int AS completed_runs,
          COUNT(o.id) FILTER (WHERE o.outcome = 'success' AND o.status <> 'bounced')::int AS success_count,
          COUNT(o.id) FILTER (WHERE o.outcome = 'fail' AND o.status <> 'bounced')::int AS fail_count,
          COUNT(o.id) FILTER (WHERE o.outcome = 'no_response' AND o.status <> 'bounced')::int AS no_response_count,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.time_to_outcome_hours) FILTER (WHERE o.status <> 'bounced')::int AS median_hours
        FROM plays p
        LEFT JOIN play_runs r ON r.play_id = p.id
        LEFT JOIN play_outcomes o ON o.play_run_id = r.id
        WHERE p.org_id = ${user.organizationId}
        GROUP BY p.id
        ORDER BY p.updated_at DESC
      `);
      const playRows = result.rows ?? [];

      // Per-rep stats: same exclusion rule as play-level analytics —
      // status='bounced' rows are contact-data hygiene events, not play
      // results, so they don't count as a run OR a win for the rep.
      type RepRow = { play_id: string; rep_user_id: string; rep_name: string; runs: number; wins: number };
      const reps = await db.execute<RepRow>(sql`
        SELECT
          r.play_id,
          r.rep_user_id,
          u.name AS rep_name,
          COUNT(*) FILTER (WHERE COALESCE(o.status, '') <> 'bounced')::int AS runs,
          COUNT(o.id) FILTER (WHERE o.outcome = 'success' AND o.status <> 'bounced')::int AS wins
        FROM play_runs r
        JOIN users u ON u.id = r.rep_user_id
        LEFT JOIN play_outcomes o ON o.play_run_id = r.id
        WHERE r.org_id = ${user.organizationId} AND r.rep_user_id IS NOT NULL
        GROUP BY r.play_id, r.rep_user_id, u.name
        HAVING COUNT(*) FILTER (WHERE COALESCE(o.status, '') <> 'bounced') > 0
        ORDER BY wins DESC, runs DESC
      `);
      const repRows = reps.rows ?? [];
      const topRepsByPlay = new Map<string, Array<{ repUserId: string; repName: string; runs: number; wins: number }>>();
      for (const r of repRows) {
        const list = topRepsByPlay.get(r.play_id) ?? [];
        if (list.length < 3) list.push({ repUserId: r.rep_user_id, repName: r.rep_name, runs: r.runs, wins: r.wins });
        topRepsByPlay.set(r.play_id, list);
      }

      const analytics = playRows.map((p) => {
        const decided = (p.success_count ?? 0) + (p.fail_count ?? 0) + (p.no_response_count ?? 0);
        const winRate = decided > 0 ? Math.round(((p.success_count ?? 0) / decided) * 100) : null;
        return {
          playId: p.play_id,
          name: p.name,
          audience: p.audience,
          channel: p.channel,
          status: p.status,
          completedRuns: p.completed_runs ?? 0,
          successCount: p.success_count ?? 0,
          failCount: p.fail_count ?? 0,
          noResponseCount: p.no_response_count ?? 0,
          winRate,
          medianHours: p.median_hours,
          topReps: topRepsByPlay.get(p.play_id) ?? [],
        };
      });

      // CSV export option.
      if (String(req.query.format ?? "json") === "csv") {
        const header = "play,audience,channel,status,completed_runs,success,fail,no_response,win_rate_pct,median_hours";
        const csv = [header].concat(
          analytics.map((a) => [
            JSON.stringify(a.name), a.audience, a.channel, a.status,
            a.completedRuns, a.successCount, a.failCount, a.noResponseCount,
            a.winRate ?? "", a.medianHours ?? "",
          ].join(",")),
        ).join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="playbook-analytics.csv"`);
        return res.send(csv);
      }

      res.json({ analytics });
    } catch (err: any) {
      console.error("[playbook] analytics error:", err);
      res.status(500).json({ error: "Failed to load analytics" });
    }
  });
}
