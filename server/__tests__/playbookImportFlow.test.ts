/**
 * Playbook Import — End-to-End Flow Test (Task #444).
 *
 * Where playbookImport.test.ts covers the parser/validator and
 * playbookImportRoutes.test.ts covers each route in isolation, this file
 * stitches the full import pipeline together as it happens in the UI:
 *
 *   1. POST /api/playbook/import/parse  — multipart .xlsx upload
 *   2. POST /api/playbook/import/preview — validation + duplicate detection
 *   3. POST /api/playbook/import          — bulk insert (default skip dups)
 *   4. GET  /api/playbook/plays           — list reflects the new drafts
 *
 * The uploaded sheet intentionally contains a mix of:
 *   • a clean valid row
 *   • a row with an invalid trigger value (hard error)
 *   • a row whose name collides with an existing org play (duplicate)
 *
 * Asserts the same guarantees the dialog wiring relies on:
 *   • preview surfaces the row error AND the duplicate
 *   • import default-skips both, only the valid row is created
 *   • non-author roles can't reach the import endpoints
 *   • the new draft is returned by the plays list afterwards
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import * as XLSX from "xlsx";

// ── Mocks ────────────────────────────────────────────────────────────────

let currentUser: { id: string; organizationId: string; role: string } | null = null;

vi.mock("../auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getCurrentUser: vi.fn(async () => currentUser),
}));

type PlayRow = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  audience: string;
  channel: string;
  triggerType: string;
  triggerConfig: any;
  signalType: string | null;
  recommendedSteps: string[];
  templateBody: string | null;
  successMetric: string | null;
  outcomeWindowHours: number | null;
  status: string;
  currentVersion: number;
  createdBy: string;
  updatedAt: Date;
};
type VersionRow = {
  playId: string;
  version: number;
  snapshot: any;
  publishedAt: Date | null;
  createdBy: string;
};

const playsRows: PlayRow[] = [];
const versionsRows: VersionRow[] = [];
let idSeq = 1;
const nextId = () => `play-${idSeq++}`;

// Extends the mock used by playbookImportRoutes.test.ts with .orderBy()
// chaining so the GET /plays handler (select().from().where().orderBy())
// can run end-to-end against the same in-memory store.
function makeDbMock() {
  const wherePromise = (table: any) => {
    const rows = table === "plays" ? [...playsRows] : [];
    const p: any = Promise.resolve(rows);
    p.orderBy = () => Promise.resolve(rows);
    return p;
  };
  return {
    select: (_cols?: any) => ({
      from: (table: any) => ({
        where: (_pred: any) => wherePromise(table),
      }),
    }),
    insert: (table: any) => ({
      values: (vals: any) => ({
        returning: () => {
          if (table === "plays") {
            const row: PlayRow = {
              id: nextId(),
              orgId: vals.orgId,
              name: vals.name,
              description: vals.description ?? null,
              audience: vals.audience,
              channel: vals.channel,
              triggerType: vals.triggerType,
              triggerConfig: vals.triggerConfig ?? {},
              signalType: vals.signalType ?? null,
              recommendedSteps: vals.recommendedSteps ?? [],
              templateBody: vals.templateBody ?? null,
              successMetric: vals.successMetric ?? null,
              outcomeWindowHours: vals.outcomeWindowHours ?? null,
              status: vals.status ?? "draft",
              currentVersion: 1,
              createdBy: vals.createdBy,
              updatedAt: new Date(),
            };
            playsRows.push(row);
            return Promise.resolve([row]);
          }
          if (table === "playVersions") {
            const row: VersionRow = {
              playId: vals.playId,
              version: vals.version,
              snapshot: vals.snapshot ?? {},
              publishedAt: vals.publishedAt ?? null,
              createdBy: vals.createdBy,
            };
            versionsRows.push(row);
            return Promise.resolve([row]);
          }
          return Promise.resolve([]);
        },
        then: (resolve: any, reject: any) => {
          try {
            if (table === "playVersions") {
              const row: VersionRow = {
                playId: vals.playId,
                version: vals.version,
                snapshot: vals.snapshot ?? {},
                publishedAt: vals.publishedAt ?? null,
                createdBy: vals.createdBy,
              };
              versionsRows.push(row);
            }
            resolve(undefined);
          } catch (e) { reject(e); }
        },
      }),
    }),
    update: (_table: any) => ({
      set: (vals: any) => ({
        where: (pred: { val: string }) => ({
          returning: () => {
            const idx = playsRows.findIndex(p => p.id === pred.val);
            if (idx === -1) return Promise.resolve([]);
            playsRows[idx] = { ...playsRows[idx], ...vals };
            return Promise.resolve([playsRows[idx]]);
          },
        }),
      }),
    }),
  };
}

vi.mock("drizzle-orm", () => ({
  and: (...xs: any[]) => ({ __op: "and", xs }),
  desc: (x: any) => x,
  eq: (col: any, val: any) => (col === "__plays.id" ? { id: val } : { col, val }),
  sql: (s: any) => s,
}));

vi.mock("@shared/schema", async () => {
  const { z } = await import("zod");
  return {
    plays: "plays" as any,
    playVersions: "playVersions" as any,
    playRuns: "playRuns" as any,
    playOutcomes: "playOutcomes" as any,
    tasks: "tasks" as any,
    insertPlaySchema: z.object({}).passthrough(),
  };
});

vi.mock("../storage", () => ({
  db: makeDbMock(),
  storage: {},
}));

const { registerPlaybookRoutes } = await import("../routes/playbook");

// ── Helpers ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  registerPlaybookRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Build an .xlsx buffer that matches the layout the dialog expects:
 * the canonical template headers + a mix of valid / invalid / duplicate
 * rows so the full pipeline has something to surface at every stage.
 */
function buildSampleXlsx(): Buffer {
  const headers = [
    "Name",
    "Description",
    "Audience",
    "Channel",
    "Trigger Type",
    "Recommended Steps",
    "Template Body",
    "Success Metric",
    "Outcome Window Hours",
  ];
  const rows = [
    // Valid new play
    [
      "Welcome new shipper",
      "Reach out within 24h of first quote.",
      "customer",
      "email",
      "manual",
      "1) Pull recent activity\n2) Send welcome",
      "Hi {{contactName}}, welcome aboard!",
      "Reply within 96h",
      "96",
    ],
    // Invalid trigger value → hard error in preview, skipped on import
    [
      "Bad trigger row",
      "",
      "customer",
      "email",
      "not_a_real_trigger",
      "1) noop",
      "",
      "n/a",
      "96",
    ],
    // Name collision with the seeded existing play → duplicate flag,
    // default skip behavior on import.
    [
      "Re-engage stalled quote",
      "Should be flagged as duplicate.",
      "customer",
      "email",
      "manual",
      "1) Open the original quote",
      "Checking in.",
      "Reply within 96h",
      "96",
    ],
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Plays");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// node 20+ supports global FormData/Blob.
function multipartUpload(url: string, fileBuf: Buffer, filename: string) {
  const fd = new FormData();
  fd.append("file", new Blob([fileBuf]), filename);
  return fetch(url, { method: "POST", body: fd as any });
}

beforeEach(() => {
  playsRows.length = 0;
  versionsRows.length = 0;
  idSeq = 1;
  currentUser = { id: "user-1", organizationId: "org-1", role: "admin" };
  // Seed an existing published play to exercise the duplicate path.
  playsRows.push({
    id: "play-existing", orgId: "org-1", name: "Re-engage stalled quote",
    description: null, audience: "customer", channel: "email", triggerType: "manual",
    triggerConfig: {}, signalType: null, recommendedSteps: [], templateBody: null,
    successMetric: null, outcomeWindowHours: null, status: "published",
    currentVersion: 1, createdBy: "u0", updatedAt: new Date(),
  });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("Playbook import — full upload → map → preview → import → list flow", () => {
  it("walks the dialog pipeline and surfaces errors, duplicates, and created drafts", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      // 1) Upload the .xlsx — server parses headers + rows.
      const xlsx = buildSampleXlsx();
      const parseRes = await multipartUpload(`${srv.url}/api/playbook/import/parse`, xlsx, "plays.xlsx");
      expect(parseRes.status).toBe(200);
      const parsed = await parseRes.json() as { headers: string[]; rows: Record<string, string>[] };
      expect(parsed.headers).toEqual(expect.arrayContaining([
        "Name", "Audience", "Channel", "Trigger Type",
      ]));
      expect(parsed.rows).toHaveLength(3);

      // 2) Map columns. The dialog auto-detects synonyms and remaps each
      //    row to canonical field keys before calling /preview, so do the
      //    same translation here so the test mirrors UI behavior.
      const synonyms: Record<string, string> = {
        name: "Name",
        description: "Description",
        audience: "Audience",
        channel: "Channel",
        triggerType: "Trigger Type",
        recommendedSteps: "Recommended Steps",
        templateBody: "Template Body",
        successMetric: "Success Metric",
        outcomeWindowHours: "Outcome Window Hours",
      };
      const mappedRows = parsed.rows.map(r => {
        const out: Record<string, string> = {};
        for (const [field, header] of Object.entries(synonyms)) {
          out[field] = r[header] ?? "";
        }
        return out;
      });

      // 3) Preview must surface the row error AND the duplicate.
      const previewRes = await fetch(`${srv.url}/api/playbook/import/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: mappedRows }),
      });
      expect(previewRes.status).toBe(200);
      const { preview } = await previewRes.json() as { preview: Array<{
        rowIndex: number; errors: string[]; isDuplicate: boolean; duplicateReason: string | null;
      }> };
      expect(preview).toHaveLength(3);

      const valid = preview[0];
      const invalid = preview[1];
      const duplicate = preview[2];

      expect(valid.errors).toEqual([]);
      expect(valid.isDuplicate).toBe(false);

      expect(invalid.errors.length).toBeGreaterThan(0);
      expect(invalid.errors.join(" ")).toMatch(/trigger/i);

      expect(duplicate.errors).toEqual([]);
      expect(duplicate.isDuplicate).toBe(true);
      expect(duplicate.duplicateReason).toMatch(/existing play/i);

      // 4) Import — mirror the dialog's default behavior of skipping rows
      //    with hard errors AND duplicates (overwriteDuplicates unset).
      //    Send all rows so we exercise the server's own skip logic too.
      const importRes = await fetch(`${srv.url}/api/playbook/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: mappedRows }),
      });
      expect(importRes.status).toBe(200);
      const result = await importRes.json() as {
        created: number; updated?: number; skipped: number;
        errors: Array<{ row: number; error: string }>;
      };
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(2);
      // The invalid row should be reported with its 1-based index.
      expect(result.errors.some(e => e.row === 2 && /trigger/i.test(e.error))).toBe(true);

      // 5) List reflects the new draft alongside the seeded existing play.
      const listRes = await fetch(`${srv.url}/api/playbook/plays`);
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json() as { plays: Array<{ name: string; status: string }>; canAuthor: boolean };
      expect(listJson.canAuthor).toBe(true);
      const names = listJson.plays.map(p => p.name);
      expect(names).toContain("Welcome new shipper");
      expect(names).toContain("Re-engage stalled quote");
      const newDraft = listJson.plays.find(p => p.name === "Welcome new shipper");
      expect(newDraft?.status).toBe("draft");
      // An initial v1 versions row was appended for the new draft.
      expect(versionsRows.some(v => v.version === 1)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("blocks the upload pipeline for non-author roles (role-gating)", async () => {
    currentUser = { id: "rep-1", organizationId: "org-1", role: "rep" };
    const app = buildApp();
    const srv = await listen(app);
    try {
      const xlsx = buildSampleXlsx();
      const parseRes = await multipartUpload(`${srv.url}/api/playbook/import/parse`, xlsx, "plays.xlsx");
      expect(parseRes.status).toBe(403);

      const previewRes = await fetch(`${srv.url}/api/playbook/import/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: [{ name: "x" }] }),
      });
      expect(previewRes.status).toBe(403);

      const importRes = await fetch(`${srv.url}/api/playbook/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: [{ name: "x" }] }),
      });
      expect(importRes.status).toBe(403);
    } finally {
      await srv.close();
    }
  });
});
