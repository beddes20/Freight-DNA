/**
 * Tracked Webex per-call enrichment worker (Task #466).
 *
 * Replaces the prior fire-and-forget chain that called fetchCallDetail in the
 * background and silently dropped analytics on transient failures. Now every
 * enrichment is a row in `webex_call_enrichment_jobs` with status, attempts,
 * nextRetryAt, and lastError. A cron-driven sweep claims due rows atomically
 * (FOR UPDATE SKIP LOCKED), calls fetchCallDetail via the resilient
 * webexFetch helper, and exponentially backs off transient failures up to
 * MAX_ATTEMPTS before dead-lettering.
 */
import { storage } from "./storage";
import {
  fetchCallDetail,
  getWebexAccessToken,
  gradeCallQuality,
  hasWebexTokens,
  webexNeedsReauth,
} from "./webexService";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [webex-enrich] ${msg}`);
}

const MAX_ATTEMPTS = 6;
/** Backoff schedule (ms) — 1m, 5m, 25m, 2h, 12h, terminal. */
const BACKOFF_MS = [60_000, 5 * 60_000, 25 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
const SWEEP_BATCH = 25;

let _sweeping = false;

export async function enqueueEnrichmentJob(orgId: string, callId: string, userId: string | null) {
  if (!orgId || !callId) return;
  try {
    await storage.enqueueWebexEnrichmentJob({
      orgId,
      callId,
      userId: userId ?? null,
      status: "pending",
      attempts: 0,
      nextRetryAt: new Date(),
      lastError: null,
      completedAt: null,
    });
  } catch (err) {
    log(`enqueue failed (orgId=${orgId} callId=${callId}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Claim up to SWEEP_BATCH due jobs, fetch their detail, persist analytics on
 * success, exp-backoff on transient failures. Concurrency-safe via FOR
 * UPDATE SKIP LOCKED in claimDueWebexEnrichmentJobs.
 */
export async function runEnrichmentSweep(): Promise<{ processed: number; succeeded: number; failed: number; deadLettered: number }> {
  if (_sweeping) return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
  _sweeping = true;
  let processed = 0, succeeded = 0, failed = 0, deadLettered = 0;
  try {
    if (!hasWebexTokens() || webexNeedsReauth()) {
      // No usable org token — leave jobs queued; the sweep will pick them up
      // once an admin reconnects.
      return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
    }
    const claimed = await storage.claimDueWebexEnrichmentJobs(SWEEP_BATCH);
    if (claimed.length === 0) return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };

    const token = await getWebexAccessToken();
    for (const job of claimed) {
      processed++;
      try {
        const detail = await fetchCallDetail(job.callId, token);
        if (!detail) {
          // No detail returned — treat as transient unless we've exhausted attempts.
          throw new Error("no_detail");
        }
        // Merge enrichment-only metrics into the existing analytics row so we
        // don't clobber direction/remoteNumber/startTime/contactId that the
        // inline persistCallAnalytics already wrote during the main sync loop.
        const grade = gradeCallQuality(detail);
        await storage.mergeWebexCallEnrichment(job.orgId, job.callId, {
          talkTimeSeconds: detail.talkTimeSeconds ?? undefined,
          holdTimeSeconds: detail.holdTimeSeconds ?? undefined,
          silenceSeconds: detail.silenceSeconds ?? undefined,
          ringTimeSeconds: detail.ringTimeSeconds ?? undefined,
          mosScore: detail.mosScore != null ? String(detail.mosScore) : null,
          jitterMs: detail.jitterMs != null ? String(detail.jitterMs) : null,
          packetLossPct: detail.packetLossPct != null ? String(detail.packetLossPct) : null,
          qualityGrade: grade,
        });
        await storage.completeWebexEnrichmentJob(job.id);
        succeeded++;
      } catch (err) {
        const nextAttempt = job.attempts + 1;
        const terminal = nextAttempt >= MAX_ATTEMPTS;
        const backoff = BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, job.attempts)];
        const nextRetryAt = terminal ? null : new Date(Date.now() + backoff);
        const msg = err instanceof Error ? err.message : String(err);
        await storage.failWebexEnrichmentJob(job.id, nextAttempt, nextRetryAt, msg, terminal);
        if (terminal) deadLettered++;
        failed++;
      }
    }
    if (processed > 0) {
      log(`sweep processed=${processed} succeeded=${succeeded} failed=${failed} dead=${deadLettered}`);
    }
  } catch (err) {
    log(`sweep error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    _sweeping = false;
  }
  return { processed, succeeded, failed, deadLettered };
}
