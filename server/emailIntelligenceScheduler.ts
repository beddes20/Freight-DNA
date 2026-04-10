/**
 * Email Intelligence Scheduler (Task #190)
 *
 * Background cron processor that picks up unprocessed email_messages rows,
 * runs OpenAI intent extraction, and writes email_signals. Also calls the
 * NBA engine integration to generate action cards from signals.
 *
 * Runs every 10 minutes via node-cron (matching the established platform pattern).
 * Batch size: 50 messages per run (configurable via EMAIL_INTEL_BATCH_SIZE).
 */

import cron from "node-cron";
import { storage } from "./storage";
import { extractEmailSignals, deduplicateSignals } from "./emailIntelligenceService";
import { generateNbasFromEmailSignals } from "./nextBestActionEngine";
import type { InsertEmailSignal } from "@shared/schema";

const BATCH_SIZE = parseInt(process.env.EMAIL_INTEL_BATCH_SIZE ?? "50", 10);

async function runEmailIntelligenceBatch(): Promise<void> {
  const messages = await storage.getUnprocessedEmailMessages(BATCH_SIZE);
  if (messages.length === 0) return;

  console.log(`[emailIntelligenceScheduler] processing ${messages.length} unprocessed messages`);

  for (const msg of messages) {
    try {
      let result;
      try {
        result = await extractEmailSignals(msg);
      } catch (extractionErr) {
        console.error(`[emailIntelligenceScheduler] extraction error for message ${msg.id}:`, extractionErr);
        await storage.markEmailMessageProcessed(msg.id);
        continue;
      }

      const deduped = await deduplicateSignals(result.signals, msg);

      const inserts: InsertEmailSignal[] = deduped.map(s => ({
        messageId: msg.id,
        intentType: s.intentType,
        intentSubtype: s.intentSubtype ?? null,
        actorType: result.actorType,
        entityType: msg.linkedCarrierId ? "carrier" : msg.linkedAccountId ? "account" : null,
        entityId: msg.linkedCarrierId ?? msg.linkedAccountId ?? null,
        confidence: s.confidence,
        extractedData: s.extractedData ?? {},
      }));

      const saved = inserts.length > 0 ? await storage.insertEmailSignals(inserts) : [];
      await storage.markEmailMessageProcessed(msg.id);

      // Trigger NBA card generation for any high-confidence signals
      if (saved.length > 0 && msg.orgId) {
        try {
          await generateNbasFromEmailSignals(msg.orgId, msg, saved);
        } catch (nbaErr) {
          console.error(`[emailIntelligenceScheduler] NBA generation error for message ${msg.id}:`, nbaErr);
        }
      }
    } catch (err) {
      console.error(`[emailIntelligenceScheduler] fatal error for message ${msg.id}:`, err);
      // Mark processed so the same message doesn't stall the queue
      try {
        await storage.markEmailMessageProcessed(msg.id);
      } catch {
        // ignore secondary error
      }
    }
  }
}

export function startEmailIntelligenceScheduler(): void {
  console.log(`[emailIntelligenceScheduler] starting — every 10 min (cron: */10 * * * *), batch=${BATCH_SIZE}`);

  // Run an initial pass shortly after startup (30s delay to let DB settle)
  const initTimeout = setTimeout(() => {
    runEmailIntelligenceBatch().catch(err =>
      console.error("[emailIntelligenceScheduler] initial batch error:", err)
    );
  }, 30_000);
  initTimeout.unref?.();

  cron.schedule("*/10 * * * *", () => {
    runEmailIntelligenceBatch().catch(err =>
      console.error("[emailIntelligenceScheduler] batch error:", err)
    );
  }, { timezone: "America/Chicago" });
}
