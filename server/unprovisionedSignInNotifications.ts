/**
 * Unprovisioned Sign-In Notifications
 *
 * When a Clerk-authenticated user has no row in our `users` table, the
 * `/api/auth/me` endpoint returns `{ unprovisioned: true, email }`. The
 * first such hit per email should alert every org admin via in-app
 * notification (and email when configured) so they can create the account.
 *
 * Spam protection works in two layers:
 *   1. An in-memory cooldown map keyed by lowercased email, which absorbs
 *      bursty page reloads from the same browser within a single process.
 *   2. A durable DB check via `storage.hasAnyNotification` on each admin —
 *      if ANY admin already has an `unprovisioned_signin` notification
 *      whose `relatedId` matches the normalized email, the entire fan-out
 *      (both in-app rows AND email sends) is skipped. This survives server
 *      restarts and ensures admins are alerted at most once per email.
 */

import type { IStorage } from "./storage";
import { sendEmail, baseEmailTemplate, emailEnabled } from "./emailService";

const NOTIFICATION_TYPE = "unprovisioned_signin";

// In-process cooldown — absorbs rapid reloads before the DB-level check
// completes. Configurable via env for tests.
const COOLDOWN_MS = Number(process.env.UNPROVISIONED_SIGNIN_COOLDOWN_MS) || 60 * 60 * 1000;

const recentlyNotified = new Map<string, number>();

function logMessage(msg: string): void {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [unprovisioned-signin] ${msg}`);
}

/** Clears the in-memory cooldown cache. Exposed for tests. */
export function _resetUnprovisionedSignInCache(): void {
  recentlyNotified.clear();
}

/**
 * Fire admin notifications (in-app + email) when a Clerk-authenticated user
 * with no DB row hits `/api/auth/me`. Safe to call from the request handler;
 * always returns void and never throws.
 */
export async function notifyAdminsOfUnprovisionedSignIn(
  email: string | null | undefined,
  storage: IStorage,
): Promise<void> {
  try {
    if (!email) return;
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) return;

    const last = recentlyNotified.get(normalized);
    const now = Date.now();
    if (last && now - last < COOLDOWN_MS) return;
    // Reserve the in-process slot immediately so concurrent requests
    // don't double-fire while we're awaiting the DB.
    recentlyNotified.set(normalized, now);

    const org = await storage.getDefaultOrganization();
    if (!org) {
      logMessage(`No default organization — cannot notify admins about ${normalized}.`);
      return;
    }

    const users = await storage.getUsers(org.id);
    const admins = users.filter(u => u.role === "admin");
    if (admins.length === 0) {
      logMessage(`No admin users in org ${org.id} — skipping notification for ${normalized}.`);
      return;
    }

    // Durable dedup: if ANY admin already has a notification for this
    // email, skip both in-app AND email fan-out. This survives restarts
    // and prevents repeat-alert spam beyond the first sign-in attempt.
    for (const admin of admins) {
      const exists = await storage.hasAnyNotification(admin.id, NOTIFICATION_TYPE, normalized);
      if (exists) {
        logMessage(`Already alerted admins for ${normalized} previously — skipping.`);
        return;
      }
    }

    const portalUrl = process.env.APP_URL || "https://sales-org-builder.replit.app";
    const link = `/admin/users?provisionEmail=${encodeURIComponent(normalized)}`;
    const title = `New sign-in needs provisioning: ${normalized}`;
    const body = `${normalized} signed in via Clerk but has no Freight DNA account yet. Create their user record so they can access the app.`;

    let inAppCreated = 0;
    for (const admin of admins) {
      try {
        await storage.createNotification({
          userId:    admin.id,
          type:      NOTIFICATION_TYPE,
          title,
          body,
          link,
          relatedId: normalized,
          read:      false,
        });
        inAppCreated++;
      } catch (err) {
        console.error(`[unprovisioned-signin] Failed to create notification for admin ${admin.id}:`, err);
      }
    }

    let emailsSent = 0;
    if (emailEnabled()) {
      const html = baseEmailTemplate(
        "Unprovisioned sign-in",
        `
          <p><strong>${normalized}</strong> just signed in via Clerk but does not yet have a Freight DNA user record.</p>
          <p>They are currently seeing the "account not provisioned" screen and cannot access the app until you create their user.</p>
          <a class="cta" href="${portalUrl}${link}">Create user in Admin →</a>
          <p style="font-size:12px;color:#6b7280;margin-top:16px;">You will only receive this alert once per unprovisioned email.</p>
        `,
      );
      const subject = `[Freight DNA] Provision needed: ${normalized}`;
      for (const admin of admins) {
        // `username` is the canonical email address for users in this
        // system (see `users.username` in shared/schema.ts).
        const adminEmail = admin.username;
        if (!adminEmail || !adminEmail.includes("@")) continue;
        try {
          const ok = await sendEmail({ to: adminEmail, subject, html });
          if (ok) emailsSent++;
        } catch (err) {
          console.error(`[unprovisioned-signin] Failed to email admin ${admin.id}:`, err);
        }
      }
    }

    logMessage(`Notified ${inAppCreated} admin(s) in-app and ${emailsSent} via email about unprovisioned sign-in: ${normalized}`);
  } catch (err) {
    console.error("[unprovisioned-signin] Unexpected error:", err);
  }
}
