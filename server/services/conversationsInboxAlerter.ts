/**
 * Conversations Inbox health → admin alert.
 *
 * Background: the existing `integrationDegradedNotifier` covers the seven
 * generic integration probes (graph, sonar, webex, …). It does NOT cover
 * the per-org "Conversations Inbox" health rollup that drives the inbox
 * status pill — that rollup is computed from `monitored_mailboxes` SentItems
 * subscriptions and lives in its own service. As a result, the inbox can
 * silently roll to "Webhook unhealthy" with NO admin notification firing.
 * That's how the previous fixture-pollution bug hid for five iterations.
 *
 * This module closes that gap. It mirrors the proven pattern from
 * `integrationDegradedNotifier`:
 *   - 24h throttle per org keyed on a synthetic source id
 *   - Postgres advisory lock around the throttle check + fanout so two
 *     concurrent admin pill polls cannot both fire
 *   - In-app notification to every admin in the org (link to the
 *     /admin/integrations-health page)
 *   - Plus an out-of-band Resend email (the inbox is mission-critical
 *     enough that an in-app feed entry alone may be missed)
 *
 * Called fire-and-forget from the GET /capture-audit-health route every
 * time the pill polls. Safe to call repeatedly — the throttle prevents
 * duplicate notifications.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { notifications, users } from "@shared/schema";
import { sendEmail } from "../emailService";

const NOTIFICATION_TYPE = "conversations_inbox_unhealthy";
const RELATED_ID = "conversations-inbox";
const THROTTLE_MS = 24 * 60 * 60 * 1000;
/**
 * Postgres advisory-lock namespace for this alerter. We use the
 * two-int variant `pg_advisory_xact_lock(ns, key)` rather than the
 * single-int `hashtext(...)` form so this lock cannot collide with the
 * other alerters in the codebase (integrationDegradedNotifier,
 * carrierContactLocks, perfBudgetBreachScheduler, …) — every alerter
 * uses its own namespace and `hashtext(orgId)` as the key.
 *
 * Pick any unused 32-bit constant; 0x434E4258 ("CNBX" — Conversations
 * iNBoX) is mnemonic and unlikely to collide with future namespaces.
 */
const ADVISORY_LOCK_NS = 0x434e4258;

export interface InboxHealthAlertInput {
  organizationId: string;
  /** Snapshot.status === "unhealthy" gates the call upstream — we still
   * accept the literal so the caller doesn't need to interpret it. */
  status: "healthy" | "recovering" | "unhealthy";
  webhookFailureCount: number;
  pendingRecoveryThreadCount: number;
  /** Total mailboxes the rollup observed (for context in the email). */
  totalMailboxes: number;
  /** Optional: human-readable reason for the failure (first
   * mailbox-health.reason that triggered the unhealthy state). */
  detail?: string | null;
}

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Notify admins on the first time *this org* observes an unhealthy
 * Conversations Inbox snapshot within a rolling 24h window. Returns true
 * iff a fresh notification fanned out (mainly for tests / debugging).
 *
 * Race-safe: throttle check + fanout runs inside one transaction holding
 * a `(orgId, "conversations-inbox")` advisory lock so concurrent admin
 * pill polls cannot double-fire.
 */
export async function notifyOnInboxUnhealthy(
  input: InboxHealthAlertInput,
): Promise<boolean> {
  if (input.status !== "unhealthy") return false;
  const orgId = input.organizationId;
  try {
    return await db.transaction(async (tx) => {
      // Two-int advisory lock: (namespace, hashtext(orgId)). Namespace
      // isolates this alerter from other system locks; hashtext(orgId)
      // gives us per-org concurrency without holding a global lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NS}::int, hashtext(${orgId})::int)`);
      if (await wasNotifiedRecently(orgId, tx)) return false;
      await fanOutToAdmins(input, tx);
      return true;
    });
  } catch (err) {
    console.warn(
      `[conversations-inbox-alerter] failed for org ${orgId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function wasNotifiedRecently(organizationId: string, tx: TxLike): Promise<boolean> {
  const cutoff = new Date(Date.now() - THROTTLE_MS);
  const [row] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(
      eq(notifications.type, NOTIFICATION_TYPE),
      eq(notifications.relatedId, RELATED_ID),
      eq(users.organizationId, organizationId),
      gte(notifications.createdAt, cutoff),
    ))
    .limit(1);
  return !!row;
}

async function fanOutToAdmins(input: InboxHealthAlertInput, tx: TxLike): Promise<void> {
  const admins = await tx
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.organizationId, input.organizationId)));
  if (admins.length === 0) return;

  const title = "Conversations Inbox webhook unhealthy";
  const body = buildBody(input);

  // In-app notifications first (cheap, transactional via storage). Email is
  // intentionally fire-and-forget after — a Resend outage must not block the
  // in-app fanout that admins rely on.
  for (const admin of admins) {
    await storage.createNotification({
      userId: admin.id,
      type: NOTIFICATION_TYPE,
      title,
      body,
      link: "/admin/integrations-health",
      relatedId: RELATED_ID,
    });
  }

  // Out-of-band email — the inbox is mission-critical, so an admin away
  // from the app needs a louder signal. Resend goes through the existing
  // sendEmail() helper which honors Email Live Mode.
  void Promise.allSettled(admins
    .filter(a => !!a.username)
    .map(a => sendEmail({
      to: a.username!,
      subject: `[Freight DNA] ${title}`,
      html: buildEmailHtml(input, a.name ?? "Admin"),
      text: `${title}\n\n${body}\n\nOpen the integrations health page: /admin/integrations-health`,
    })),
  ).then(results => {
    const failed = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && !r.value)).length;
    if (failed > 0) {
      console.warn(`[conversations-inbox-alerter] ${failed}/${results.length} admin emails failed for org ${input.organizationId}`);
    }
  });
}

function buildBody(input: InboxHealthAlertInput): string {
  const parts: string[] = [];
  if (input.webhookFailureCount > 0) {
    parts.push(`${input.webhookFailureCount} of ${input.totalMailboxes} monitored mailboxes have an expired or missing Outlook subscription.`);
  } else {
    parts.push(`Conversations Inbox rolled up to UNHEALTHY across ${input.totalMailboxes} monitored mailboxes.`);
  }
  if (input.pendingRecoveryThreadCount > 0) {
    parts.push(`${input.pendingRecoveryThreadCount} thread(s) pending recovery.`);
  }
  if (input.detail) parts.push(`Detail: ${input.detail.slice(0, 280)}`);
  parts.push("Reply tracking is degraded until the Graph subscriptions are re-registered.");
  return parts.join(" ");
}

function buildEmailHtml(input: InboxHealthAlertInput, adminName: string): string {
  const body = buildBody(input);
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
      <p>Hi ${escapeHtml(adminName)},</p>
      <p><strong>The Conversations Inbox webhook health just rolled up to UNHEALTHY for your organization.</strong></p>
      <p>${escapeHtml(body)}</p>
      <p>
        Open the
        <a href="/admin/integrations-health" style="color:#1d4ed8">Integrations Health</a>
        page to see which mailboxes are affected and re-register their subscriptions.
      </p>
      <p style="color:#6b7280;font-size:12px">
        This alert fires at most once per 24h. You will not receive another email about this issue
        unless inbox health recovers and then degrades again.
      </p>
    </div>
  `.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Test hooks
export const _internals = { NOTIFICATION_TYPE, RELATED_ID, THROTTLE_MS };
