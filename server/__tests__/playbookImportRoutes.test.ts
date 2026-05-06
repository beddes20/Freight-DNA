/**
 * Playbook Import — Route-level integration tests (Task #439).
 *
 * Mounts registerPlaybookRoutes() onto a fresh Express app with mocked
 * auth + db so we can exercise the actual HTTP handlers (template
 * download, parse, preview, import) end-to-end without a real Postgres.
 *
 * Coverage:
 *   - Template download: 200 + xlsx Content-Type for an author role
 *   - Template download: 403 for a non-author role
 *   - Preview: flags rows whose name collides with an existing org play
 *   - Import: creates drafts in the caller's org with per-row counts
 *   - Import (overwrite): existing play is updated as a NEW DRAFT VERSION
 *     (currentVersion bumped, status reset to draft, new playVersions row),
 *     NOT inserted as a sibling.
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

// In-memory plays + playVersions tables, indexed by id.
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

// Minimal mock of the drizzle-style chained query builder our routes use.
// Each call returns thenables that resolve to row arrays so `await` works.
function makeDbMock() {
  return {
    select: (_cols?: any) => ({
      from: (table: any) => ({
        where: (_pred: any) => Promise.resolve(table === "plays" ? [...playsRows] : []),
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
        // Some insert call sites (playVersions on import) do not chain
        // .returning(); make the .values() result itself awaitable.
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

// drizzle-orm helpers used by the route module — return marker objects so
// our update() mock can still recognize "where(eq(plays.id, X))".
vi.mock("drizzle-orm", () => ({
  and: (...xs: any[]) => ({ __op: "and", xs }),
  desc: (x: any) => x,
  eq: (col: any, val: any) => (col === "__plays.id" ? { id: val } : { col, val }),
  sql: (s: any) => s,
}));

vi.mock("@shared/schema", async () => {
  const { z } = await import("zod");
  // A permissive stand-in for insertPlaySchema — playbookImport.ts only
  // needs `.omit({orgId,createdBy}).safeParse(...)` to succeed for valid
  // shapes, so an open passthrough object schema is sufficient for these
  // route tests (the dedicated unit tests in playbookImport.test.ts run
  // against the real schema).
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

// Bring in the route registrar AFTER mocks are set up.
const { registerPlaybookRoutes } = await import("../routes/playbook");

// ── Test helpers ─────────────────────────────────────────────────────────

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

beforeEach(() => {
  playsRows.length = 0;
  versionsRows.length = 0;
  idSeq = 1;
  currentUser = { id: "user-1", organizationId: "org-1", role: "admin" };
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("GET /api/playbook/import/template", () => {
  it("returns an .xlsx attachment for an author role", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/playbook/import/template`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
      expect(res.headers.get("content-disposition") ?? "").toContain("playbook-import-template.xlsx");
      const buf = Buffer.from(await res.arrayBuffer());
      const wb = XLSX.read(buf, { type: "buffer" });
      expect(wb.SheetNames).toContain("Plays");
      const aoa: any[][] = XLSX.utils.sheet_to_json(wb.Sheets["Plays"], { header: 1 });
      // Header row + at least one example row
      expect(aoa.length).toBeGreaterThanOrEqual(2);
      expect(aoa[0].map(String)).toEqual(expect.arrayContaining(["Name", "Audience", "Channel", "Trigger Type"]));
    } finally { await srv.close(); }
  });

  it("403s for a non-author role", async () => {
    currentUser = { id: "u2", organizationId: "org-1", role: "rep" };
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/playbook/import/template`);
      expect(res.status).toBe(403);
    } finally { await srv.close(); }
  });
});

describe("POST /api/playbook/import/preview", () => {
  it("flags rows whose name collides with an existing org play", async () => {
    // Seed an existing play in the caller's org
    playsRows.push({
      id: "play-existing", orgId: "org-1", name: "Re-engage stalled quote",
      description: null, audience: "customer", channel: "email", triggerType: "manual",
      triggerConfig: {}, signalType: null, recommendedSteps: [], templateBody: null,
      successMetric: null, outcomeWindowHours: null, status: "published",
      currentVersion: 1, createdBy: "u0", updatedAt: new Date(),
    });
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/playbook/import/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [
            {
              name: "Re-engage stalled quote",
              description: "Nudge",
              audience: "customer",
              channel: "email",
              triggerType: "manual",
              recommendedSteps: "1) Open\n2) Send",
              templateBody: "hi",
              successMetric: "Reply within 96h",
              outcomeWindowHours: "96",
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.preview).toHaveLength(1);
      expect(json.preview[0].isDuplicate).toBe(true);
    } finally { await srv.close(); }
  });
});

describe("POST /api/playbook/import", () => {
  it("creates new drafts in the caller's org with per-row counts", async () => {
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/playbook/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [
            { name: "Play A", audience: "customer", channel: "email", triggerType: "manual",
              recommendedSteps: "1) Do thing", successMetric: "Reply" },
            { name: "Play B", audience: "carrier", channel: "call", triggerType: "manual",
              recommendedSteps: "1) Call", successMetric: "Call back" },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.created).toBe(2);
      expect(json.skipped).toBe(0);
      expect(playsRows).toHaveLength(2);
      expect(playsRows.every(p => p.orgId === "org-1")).toBe(true);
      expect(playsRows.every(p => p.status === "draft")).toBe(true);
      // Each new play gets an initial v1 version row
      expect(versionsRows.filter(v => v.version === 1)).toHaveLength(2);
    } finally { await srv.close(); }
  });

  it("overwrite=true updates existing play as a NEW DRAFT VERSION (no sibling row)", async () => {
    playsRows.push({
      id: "play-existing", orgId: "org-1", name: "Re-engage stalled quote",
      description: "old desc", audience: "customer", channel: "email", triggerType: "manual",
      triggerConfig: {}, signalType: null, recommendedSteps: ["old step"], templateBody: null,
      successMetric: "old metric", outcomeWindowHours: 24, status: "published",
      currentVersion: 3, createdBy: "u0", updatedAt: new Date(),
    });
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/playbook/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          overwriteDuplicates: true,
          rows: [{
            name: "Re-engage stalled quote",
            description: "fresh desc",
            audience: "customer",
            channel: "email",
            triggerType: "manual",
            recommendedSteps: "1) New step",
            successMetric: "new metric",
            outcomeWindowHours: "96",
          }],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.updated).toBe(1);
      expect(json.created).toBe(0);

      // Still exactly one play row — NOT a sibling
      expect(playsRows).toHaveLength(1);
      const p = playsRows[0];
      expect(p.id).toBe("play-existing");
      expect(p.status).toBe("draft");
      expect(p.currentVersion).toBe(4); // bumped from 3
      expect(p.description).toBe("fresh desc");
      expect(p.successMetric).toBe("new metric");
      expect(p.recommendedSteps).toEqual(["New step"]);

      // A new playVersions snapshot at v4 was appended
      expect(versionsRows).toHaveLength(1);
      expect(versionsRows[0]).toMatchObject({ playId: "play-existing", version: 4, publishedAt: null });
    } finally { await srv.close(); }
  });

  it("overwrite=false (default) skips existing-name rows", async () => {
    playsRows.push({
      id: "play-existing", orgId: "org-1", name: "Dup Name",
      description: null, audience: "customer", channel: "email", triggerType: "manual",
      triggerConfig: {}, signalType: null, recommendedSteps: [], templateBody: null,
      successMetric: null, outcomeWindowHours: null, status: "published",
      currentVersion: 1, createdBy: "u0", updatedAt: new Date(),
    });
    const app = buildApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/playbook/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [{
            name: "Dup Name", audience: "customer", channel: "email", triggerType: "manual",
            recommendedSteps: "1) x", successMetric: "y",
          }],
        }),
      });
      const json = await res.json();
      expect(json.created).toBe(0);
      expect(json.skipped).toBe(1);
      expect(playsRows).toHaveLength(1); // unchanged
    } finally { await srv.close(); }
  });
});
