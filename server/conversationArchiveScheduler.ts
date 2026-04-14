import cron from "node-cron";
import { db } from "./storage";
import { emailConversationThreads, emailMessages } from "@shared/schema";
import { eq, and, isNull, lte, gt, sql } from "drizzle-orm";

function logMessage(message: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [conversation-archive] ${message}`);
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

export function initConversationArchiveScheduler(): void {
  const cronExpression = "0 2 * * *";
  cron.schedule(cronExpression, () => {
    autoArchiveResolvedThreads().catch(err =>
      logMessage(`Scheduler error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, { timezone: "America/Chicago" });
  logMessage(`Conversation archive scheduler initialized (cron: ${cronExpression})`);
}
