/**
 * Task #911 — Background worker that auto-extracts rate cons.
 *
 * Two entry points:
 *   - `enqueueRateConAfterIngest(documentId, orgId)` — fired from
 *     `documentIngestion.ts` once a doc reaches status='parsed' and class
 *     'rate_con'. We schedule the run on the next tick so the HTTP request
 *     that uploaded the doc returns immediately.
 *   - `runDueRateConExtractions(orgId?, limit?)` — periodic sweep that
 *     picks up anything classifications missed (e.g. the rep manually
 *     reclassified a misclassified doc to rate_con).
 *
 * Failures are logged but never thrown into the caller — the typed
 * extraction row already records the reason for surfacing in the admin
 * queue.
 */
import { storage } from "../storage";
import { runRateConPipeline } from "./rateConPipeline";

const MAX_AUTO_EXTRACT_BATCH = 25;

export function enqueueRateConAfterIngest(documentId: string, organizationId: string): void {
  // Fire-and-forget on next tick. We deliberately don't await — this is
  // called from the ingest hot-path and the user-facing response should
  // not wait for an LLM round-trip.
  setImmediate(() => {
    runRateConPipeline({ documentId, organizationId })
      .then((res) => {
        if (res.status === "failed") {
          console.warn(`[rateConAutoExtract] ${documentId} failed: ${res.reason ?? "?"}`);
        } else {
          console.log(`[rateConAutoExtract] ${documentId} → ${res.status} (${res.findings.length} findings, ${res.links.length} links)`);
        }
      })
      .catch((err) => {
        console.error(`[rateConAutoExtract] ${documentId} threw:`, err);
      });
  });
}

export async function runDueRateConExtractions(
  organizationId: string | null,
  limit = MAX_AUTO_EXTRACT_BATCH,
): Promise<{ processed: number; ok: number; failed: number }> {
  const docs = await storage.listDocumentsAwaitingExtraction(organizationId, "rate_con", limit);
  let ok = 0;
  let failed = 0;
  for (const doc of docs) {
    try {
      const res = await runRateConPipeline({ documentId: doc.id, organizationId: doc.organizationId });
      if (res.status === "failed") failed++;
      else ok++;
    } catch (err) {
      failed++;
      console.error(`[rateConAutoExtract] sweep doc ${doc.id} threw:`, err);
    }
  }
  return { processed: docs.length, ok, failed };
}
