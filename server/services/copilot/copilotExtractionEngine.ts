/**
 * Copilot Extraction Engine — Task #926 step 2.
 *
 * Orchestrates per-class document field extraction. Called from
 * `documentIngestion.ts` immediately after classification, and from the
 * `extract_document_fields` agent tool / admin retry endpoint.
 *
 * Idempotent: re-running for the same `(documentId, schemaVersion)` no-ops
 * via the unique index. Re-uploading the same document (same hash) doesn't
 * re-extract — the original ingestion path dedupes upstream.
 */
import { db } from "../../storage";
import { sql, eq, and, desc } from "drizzle-orm";
import {
  documentExtractions,
  documents,
  documentPages,
  type Document,
  type DocumentExtraction,
} from "@shared/schema";
import { extractorForClass } from "./extractors";
import { resolveEntities } from "./copilotEntityResolution";

export interface RunExtractionResult {
  extraction: DocumentExtraction | null;
  reason: "ok" | "no_extractor" | "no_pages" | "skipped_existing" | "failed";
  message?: string;
}

/**
 * Run the extractor matching `document.classLabel`. Returns the persisted
 * extraction row, or `null` when the class has no registered extractor
 * (this is normal — `unknown` and other long-tail classes stay text-only).
 */
export async function runExtractionForDocument(
  document: Document,
  opts: { force?: boolean } = {},
): Promise<RunExtractionResult> {
  const extractor = extractorForClass(document.classLabel);
  if (!extractor) {
    return { extraction: null, reason: "no_extractor", message: `No extractor registered for class '${document.classLabel}'.` };
  }

  // Dedup — unless forced, reuse the existing row.
  if (!opts.force) {
    const [existing] = await db
      .select()
      .from(documentExtractions)
      .where(and(
        eq(documentExtractions.documentId, document.id),
        eq(documentExtractions.schemaVersion, extractor.schemaVersion),
      ))
      .limit(1);
    if (existing) return { extraction: existing, reason: "skipped_existing" };
  }

  const pages = await db
    .select()
    .from(documentPages)
    .where(eq(documentPages.documentId, document.id))
    .orderBy(documentPages.pageNumber);
  if (!pages.length) {
    return { extraction: null, reason: "no_pages", message: "Document has no parsed pages yet." };
  }

  let extracted: ReturnType<typeof extractor.extract>;
  try {
    extracted = extractor.extract({ document, pages });
  } catch (err) {
    return {
      extraction: null,
      reason: "failed",
      message: `Extractor '${extractor.extractor}' threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Resolve entities — best-effort, never blocks the extraction write.
  let resolvedEntities: unknown = null;
  try {
    resolvedEntities = await resolveEntities({
      organizationId: document.organizationId,
      classLabel: document.classLabel,
      payload: extracted.payload,
      uploadContext: (document.uploadContext as Record<string, unknown> | null) ?? null,
    });
  } catch (err) {
    console.warn("[copilotExtractionEngine] entity resolution failed:", err);
  }

  // Upsert by (documentId, schemaVersion).
  const [row] = await db
    .insert(documentExtractions)
    .values({
      documentId: document.id,
      organizationId: document.organizationId,
      classLabel: document.classLabel,
      schemaVersion: extractor.schemaVersion,
      extractor: extractor.extractor,
      payload: extracted.payload as object,
      resolvedEntities: (resolvedEntities ?? null) as object | null,
      needsHumanReview: extracted.needsHumanReview,
    })
    .onConflictDoUpdate({
      target: [documentExtractions.documentId, documentExtractions.schemaVersion],
      set: {
        payload: sql`excluded.payload`,
        resolvedEntities: sql`excluded.resolved_entities`,
        needsHumanReview: sql`excluded.needs_human_review`,
        extractor: sql`excluded.extractor`,
        extractedAt: sql`now()`,
      },
    })
    .returning();

  return { extraction: row ?? null, reason: "ok" };
}

export async function getLatestExtractionForDocument(
  organizationId: string,
  documentId: string,
): Promise<DocumentExtraction | null> {
  const [row] = await db
    .select()
    .from(documentExtractions)
    .where(and(
      eq(documentExtractions.organizationId, organizationId),
      eq(documentExtractions.documentId, documentId),
    ))
    .orderBy(desc(documentExtractions.schemaVersion))
    .limit(1);
  return row ?? null;
}
