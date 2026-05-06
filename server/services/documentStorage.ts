/**
 * Task #910 — Document storage abstraction.
 *
 * Single module that owns reading/writing raw document bytes. Two backends:
 *   1. Replit Object Storage (preferred) — keeps Postgres compact.
 *   2. PostgreSQL fallback (`document_blobs` ad-hoc table) — only used in
 *      local/test environments where Object Storage isn't available.
 *
 * The picker is fail-safe: if `@replit/object-storage` cannot construct a
 * client (e.g. missing REPLIT_DB_URL in unit tests) we degrade to the
 * Postgres fallback automatically and log once. Never throws on init.
 *
 * Storage keys are content-addressed (`<orgId>/<sha256>.<ext>`) so we never
 * write the same blob twice. Callers should hash up-front and treat the key
 * as deterministic.
 */
import { db } from "../storage";
import { sql } from "drizzle-orm";

// ─── Typed shim for @replit/object-storage ────────────────────────────────
//
// We only use the four operations below; modeling the full SDK surface here
// would buy us nothing and would have to be re-synced on every minor bump.
// `OkResult<T>` mirrors the SDK's `{ ok, value, error }` shape.

interface OkResult<T> { ok: boolean; value?: T; error?: { message?: string } }
interface ObjectStorageClient {
  uploadFromBytes(name: string, data: Buffer): Promise<OkResult<unknown>>;
  downloadAsBytes(name: string): Promise<OkResult<Buffer | Uint8Array | Buffer[]>>;
  exists?(name: string): Promise<OkResult<boolean>>;
  delete?(name: string): Promise<OkResult<unknown>>;
}
interface ObjectStorageModule {
  Client?: new () => ObjectStorageClient;
}

let objectClientChecked = false;
let objectClient: ObjectStorageClient | null = null;
let blobTableEnsured = false;

async function getObjectClient(): Promise<ObjectStorageClient | null> {
  if (objectClientChecked) return objectClient;
  objectClientChecked = true;
  try {
    const mod = (await import("@replit/object-storage")) as unknown as ObjectStorageModule;
    const Client = mod?.Client;
    if (!Client) {
      console.warn("[documentStorage] @replit/object-storage has no Client export — using DB fallback.");
      return (objectClient = null);
    }
    objectClient = new Client();
    return objectClient;
  } catch (err) {
    console.warn("[documentStorage] Object Storage unavailable, falling back to Postgres blob table:", err instanceof Error ? err.message : err);
    return (objectClient = null);
  }
}

async function ensureBlobTable(): Promise<void> {
  if (blobTableEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS document_blobs (
      key TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      content_type TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  blobTableEnsured = true;
}

function extFromMime(mime: string, fallbackName?: string): string {
  const m = mime.toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m === "message/rfc822" || m.includes("eml")) return "eml";
  if (m.includes("spreadsheetml")) return "xlsx";
  if (m === "application/vnd.ms-excel") return "xls";
  if (m === "text/csv") return "csv";
  if (m.startsWith("image/png")) return "png";
  if (m.startsWith("image/jpeg") || m.startsWith("image/jpg")) return "jpg";
  if (m.startsWith("image/")) return m.split("/")[1] ?? "bin";
  if (m.includes("wordprocessingml")) return "docx";
  if (m === "application/msword") return "doc";
  if (m === "text/plain") return "txt";
  // Last-ditch — pull extension from filename.
  const idx = (fallbackName ?? "").lastIndexOf(".");
  if (idx >= 0) return (fallbackName ?? "").slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  return "bin";
}

export function buildStorageKey(organizationId: string, sha256: string, mimeType: string, filename?: string): string {
  return `${organizationId}/${sha256}.${extFromMime(mimeType, filename)}`;
}

export interface PutResult {
  key: string;
  url: string | null; // present when Object Storage backend is in use
  backend: "object_storage" | "postgres";
}

/** Idempotent put — writing the same key twice is a no-op. */
export async function putDocumentBytes(
  key: string,
  bytes: Buffer,
  mimeType: string,
): Promise<PutResult> {
  const client = await getObjectClient();
  if (client) {
    try {
      // Check whether the object already exists to make this idempotent.
      let exists = false;
      try {
        const e = await client.exists?.(key);
        exists = !!(e && (e.ok === true || e.value === true));
      } catch { /* ignore */ }
      if (!exists) {
        // Replit Object Storage SDK exposes uploadFromBytes(name, buffer).
        const r = await client.uploadFromBytes(key, bytes);
        if (r && r.ok === false) {
          throw new Error(`object-storage upload failed: ${r.error?.message ?? "unknown"}`);
        }
      }
      return { key, url: `replit-object://${key}`, backend: "object_storage" };
    } catch (err) {
      console.warn("[documentStorage] object-storage put failed, falling back to DB:", err);
    }
  }
  // Postgres fallback
  await ensureBlobTable();
  await db.execute(sql`
    INSERT INTO document_blobs (key, data, content_type)
    VALUES (${key}, ${bytes}, ${mimeType})
    ON CONFLICT (key) DO NOTHING
  `);
  return { key, url: null, backend: "postgres" };
}

export async function getDocumentBytes(key: string): Promise<{ bytes: Buffer; contentType: string | null } | null> {
  const client = await getObjectClient();
  if (client) {
    try {
      const r = await client.downloadAsBytes(key);
      if (r && r.ok && r.value) {
        // SDK returns Buffer or Uint8Array — normalize.
        const v = Array.isArray(r.value) ? r.value[0] : r.value;
        const buf = Buffer.isBuffer(v) ? v : Buffer.from(v);
        return { bytes: buf, contentType: null };
      }
    } catch (err) {
      console.warn("[documentStorage] object-storage download failed, falling back to DB:", err);
    }
  }
  await ensureBlobTable();
  const row = await db.execute<{ data: Buffer | Uint8Array; content_type: string | null }>(sql`
    SELECT data, content_type FROM document_blobs WHERE key = ${key} LIMIT 1
  `);
  const r = row.rows[0];
  if (!r) return null;
  const data = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data);
  return { bytes: data, contentType: r.content_type };
}

export async function deleteDocumentBytes(key: string): Promise<void> {
  const client = await getObjectClient();
  if (client) {
    try { await client.delete?.(key); } catch { /* best-effort */ }
  }
  await ensureBlobTable();
  await db.execute(sql`DELETE FROM document_blobs WHERE key = ${key}`);
}

export function activeBackendDescription(): "object_storage_or_fallback" {
  // Diagnostic helper for /api/admin endpoints; we don't expose the concrete
  // backend so the frontend doesn't depend on it.
  return "object_storage_or_fallback";
}
