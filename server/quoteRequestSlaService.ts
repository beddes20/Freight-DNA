import cron from "node-cron";
import { storage, db } from "./storage";
import { notifications } from "@shared/schema";
import { and, eq, lt } from "drizzle-orm";
import type { InsertNotification, UserRole } from "@shared/schema";

const QUOTE_SLA_MINUTES = 7;
const ESCALATION_MINUTES = 5;

const AM_NAM_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  "account_manager",
  "national_account_manager",
]);

/**
 * Resolve the appropriate Quote SLA recipient for a company.
 * Prefers the company's salesperson if their role is AM or NAM; otherwise
 * walks up the manager chain and returns the first ancestor with an AM/NAM
 * role. Returns null when no AM/NAM can be resolved. Uses a `seen` set to
 * guard against manager-chain cycles.
 */
export async function resolveQuoteSlaRecipient(
  salesPersonId: string | null | undefined,
): Promise<string | null> {
  if (!salesPersonId) return null;

  const seen = new Set<string>();
  let currentId: string | null = salesPersonId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const user = await storage.getUser(currentId);
    if (!user) return null;
    if (AM_NAM_ROLES.has(user.role as UserRole)) {
      return user.id;
    }
    currentId = user.managerId ?? null;
  }

  return null;
}

export async function fireQuoteRequestAlert(
  orgId: string,
  accountId: string,
  signalId: string,
  messageSubject: string | null,
): Promise<void> {
  const company = await storage.getCompany(accountId);
  if (!company) return;

  const salesPersonId = (company as any).salesPersonId as string | null;
  const repId = await resolveQuoteSlaRecipient(salesPersonId);
  if (!repId) {
    console.warn(
      `[quote-sla] ⚠️ Skipped alert for account ${company.name} (${accountId}) — no AM/NAM resolvable from salesPersonId=${salesPersonId ?? "null"} (signal ${signalId})`,
    );
    return;
  }

  const alreadySent = await storage.hasUnreadNotification(repId, "quote_request_alert", signalId);
  if (alreadySent) return;

  const title = `⚡ Quote Request — ${company.name}`;
  const body = messageSubject
    ? `Customer is asking for a quote: "${messageSubject.slice(0, 80)}". Respond within ${QUOTE_SLA_MINUTES} minutes!`
    : `Customer is asking for a quote. Respond within ${QUOTE_SLA_MINUTES} minutes!`;

  const notif: InsertNotification = {
    userId: repId,
    type: "quote_request_alert",
    title,
    body,
    link: `/companies/${accountId}`,
    read: false,
    relatedId: signalId,
  };

  await storage.createNotification(notif);
  console.log(`[quote-sla] 🔔 Alert sent to rep ${repId} for account ${company.name} (signal ${signalId})`);
}

async function runEscalationCheck(): Promise<void> {
  const cutoff = new Date(Date.now() - ESCALATION_MINUTES * 60 * 1000);

  const unread = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.type, "quote_request_alert"),
        eq(notifications.read, false),
        lt(notifications.createdAt, cutoff),
      )
    );

  if (unread.length === 0) return;

  for (const notif of unread) {
    const repId = notif.userId;

    const rep = await storage.getUser(repId);
    if (!rep) continue;

    const managerId = (rep as any).managerId as string | null;
    if (!managerId) continue;

    const escalationRelatedId = `esc-${notif.relatedId}`;
    const alreadyEscalated = await storage.hasAnyNotification(managerId, "quote_request_escalation", escalationRelatedId);
    if (alreadyEscalated) continue;

    const escalationNotif: InsertNotification = {
      userId: managerId,
      type: "quote_request_escalation",
      title: `🚨 Quote SLA Breach — ${notif.title.replace("⚡ Quote Request — ", "")}`,
      body: `${rep.name || rep.email} has not responded to a customer quote request within ${ESCALATION_MINUTES} minutes. Original: ${notif.body}`,
      link: notif.link,
      read: false,
      relatedId: escalationRelatedId,
    };

    await storage.createNotification(escalationNotif);
    console.log(`[quote-sla] 🚨 Escalated to manager ${managerId} — rep ${repId} did not respond in ${ESCALATION_MINUTES}min`);
  }
}

export function startQuoteRequestSlaScheduler(): void {
  console.log(`[quote-sla] Quote request SLA scheduler initialized (escalation check every 1 min, SLA=${QUOTE_SLA_MINUTES}min, escalation=${ESCALATION_MINUTES}min)`);

  cron.schedule("* * * * *", () => {
    runEscalationCheck().catch(err =>
      console.error("[quote-sla] escalation check error:", err)
    );
  }, { timezone: "America/Chicago" });
}
