import cron from "node-cron";
import { db, storage } from "./storage";
import { emailConversationThreads, emailMessages } from "@shared/schema";
import { eq, and, isNull, lte, gt, sql } from "drizzle-orm";
import { wakeSnoozedThread } from "./services/conversationWaitingStateService";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [conversation-archive] ${message}`);
}

function logSnooze(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [conversation-snooze] ${message}`);
}

const AUTO_ARCHIVE_DAYS = 7;

async function autoArchiveResolvedThreads(): Promise<void> {
  const cutoff = new Date(Date.now() - AUTO_ARCHIVE_DAYS * 24 * 60 * 60 * 1000);

  try {
    const resolvedThreads = await db.select({
      id: emailConversationThreads.id,
      orgId: emailConversationThreads.orgId,
      threadId: emailConversationThreads.threadId,
      updatedAt: emailConversationThreads.updatedAt,
    })
    .from(emailConversationThreads)
    .where(
      and(
        eq(emailConversationThreads.waitingState, "resolved"),
        isNull(emailConversationThreads.archivedAt),
        lte(emailConversationThreads.updatedAt, cutoff),
      ),
    );

    if (resolvedThreads.length === 0) {
      logMessage("No resolved threads to check for auto-archive");
      return;
    }

    const idsToArchive: string[] = [];

    for (const thread of resolvedThreads) {
      const [msgAfterResolution] = await db.select({ id: emailMessages.id })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.orgId, thread.orgId),
            eq(emailMessages.threadId, thread.threadId),
            gt(emailMessages.createdAt, thread.updatedAt),
          ),
        )
        .limit(1);

      if (!msgAfterResolution) {
        idsToArchive.push(thread.id);
      }
    }

    if (idsToArchive.length === 0) {
      logMessage("No threads eligible for auto-archive after message check");
      return;
    }

    const result = await db.update(emailConversationThreads)
      .set({
        waitingState: "archived",
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        sql`${emailConversationThreads.id} IN (${sql.join(idsToArchive.map(id => sql`${id}`), sql`, `)})`
      )
      .returning({ id: emailConversationThreads.id });

    logMessage(`Auto-archived ${result.length} thread(s) resolved ${AUTO_ARCHIVE_DAYS}+ days with no messages since resolution`);
  } catch (err) {
    logMessage(`Error during auto-archive: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Snooze wake job (Task #533) ─────────────────────────────────────────────
// Wake every snoozed thread whose snoozed_until has passed back to its prior
// state, then ping the thread owner so the rep doesn't have to manually go
// looking for the thread to land back in their queue.
async function wakeExpiredSnoozes(): Promise<void> {
  try {
    const expired = await storage.findExpiredSnoozedThreads(new Date());
    if (expired.length === 0) {
      return;
    }
    let waked = 0;
    let notified = 0;
    for (const thread of expired) {
      try {
        await wakeSnoozedThread(thread.id, thread.orgId, storage);
        waked++;
        // Notify the owner (or the user who snoozed it, as a fallback) so
        // they know the thread is back in their queue. This stays best-effort
        // — a notification failure must never leave a thread stuck snoozed.
        const recipientId = thread.ownerUserId ?? thread.snoozedByUserId;
        if (recipientId) {
          try {
            await storage.createNotification({
              userId: recipientId,
              type: "conversation_snooze_woke",
              title: "A snoozed conversation is back",
              body: "A conversation you snoozed has returned to your inbox.",
              link: `/conversations?bucket=mine&threadId=${encodeURIComponent(thread.threadId)}`,
              relatedId: thread.id,
            });
            notified++;
          } catch (notifyErr) {
            logSnooze(`Notify failure for thread ${thread.id}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`);
          }
        }
      } catch (wakeErr) {
        logSnooze(`Wake failure for thread ${thread.id}: ${wakeErr instanceof Error ? wakeErr.message : String(wakeErr)}`);
      }
    }
    logSnooze(`Woke ${waked}/${expired.length} thread(s) from snooze; ${notified} notification(s) sent`);
  } catch (err) {
    logSnooze(`Wake sweep error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function initConversationArchiveScheduler(): void {
  const cronExpression = "0 2 * * *";
  cron.schedule(cronExpression, () => {
    autoArchiveResolvedThreads().catch(err =>
      logMessage(`Scheduler error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, { timezone: "America/Chicago" });
  logMessage(`Conversation archive scheduler initialized (cron: ${cronExpression})`);

  // Snooze wake sweep — every 5 minutes. The work is cheap (a single indexed
  // query against snoozed_until) so the cadence trades extra wake-ups for
  // tighter SLA on the "snooze expired" notification.
  const snoozeCron = "*/5 * * * *";
  cron.schedule(snoozeCron, () => {
    wakeExpiredSnoozes().catch(err =>
      logSnooze(`Scheduler error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, { timezone: "America/Chicago" });
  logSnooze(`Conversation snooze wake scheduler initialized (cron: ${snoozeCron})`);

  // Also run once at boot so threads that expired while the server was down
  // don't sit in snooze limbo until the next cron tick.
  setTimeout(() => {
    wakeExpiredSnoozes().catch(err =>
      logSnooze(`Boot wake error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, 30_000);
}
