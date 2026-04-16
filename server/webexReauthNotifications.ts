/**
 * Webex Re-Authorization Notifications
 *
 * Fires once when the stored Webex refresh token transitions into the
 * "needs re-authorization" state. Sends an in-app notification to every
 * admin user across every organization, plus an email when their username
 * looks like an email address and email delivery is enabled.
 */

import { storage, db } from "./storage";
import { users } from "../shared/schema";
import { eq } from "drizzle-orm";
import { sendEmail, emailEnabled, baseEmailTemplate } from "./emailService";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${t} [webex-reauth] ${msg}`);
}

function buildEmailHtml(adminName: string, appUrl: string, reason: string): string {
  const link = `${appUrl.replace(/\/$/, "")}/admin/users`;
  const safeReason = reason.replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;")).slice(0, 300);
  const body = `
    <p>Hi ${adminName || "Admin"},</p>
    <p>Freight DNA's connection to <strong>Webex Calling</strong> has stopped working
    because the stored authorization was revoked or expired. Until an admin
    re-authorizes Webex, call history sync, missed-call alerts, and presence
    will be paused.</p>
    <div class="item">
      <div class="item-title">What to do</div>
      <div class="item-meta">Open the admin settings, find the Webex Calling Integration card,
      and click <strong>Re-authorize Webex</strong>. The whole flow takes about a minute.</div>
    </div>
    <p><a class="cta" href="${link}">Re-authorize Webex</a></p>
    <p style="font-size:12px;color:#6b7280;margin-top:24px">Reason reported by Webex: <code>${safeReason}</code></p>
  `;
  return baseEmailTemplate("Webex needs to be reconnected", body);
}

export async function notifyAdminsOfWebexReauthNeeded(reason: string): Promise<void> {
  try {
    const adminUsers = await db
      .select()
      .from(users)
      .where(eq(users.role, "admin"));

    if (adminUsers.length === 0) {
      log("No admin users found to notify");
      return;
    }

    const appUrl = process.env.APP_URL?.trim() || "";
    let inAppCount = 0;
    let emailCount = 0;

    for (const admin of adminUsers) {
      try {
        const already = await storage.hasUnreadNotification(
          admin.id,
          "webex_needs_reauth",
          "webex",
        );
        if (!already) {
          await storage.createNotification({
            userId: admin.id,
            type: "webex_needs_reauth",
            title: "Webex needs to be reconnected",
            body: "Call sync is paused until an admin re-authorizes Webex from the admin settings.",
            link: "/admin/users",
            relatedId: "webex",
            read: false,
          });
          inAppCount++;
        }
      } catch (notifErr) {
        log(
          `Failed in-app notify for admin ${admin.id}: ${
            notifErr instanceof Error ? notifErr.message : String(notifErr)
          }`,
        );
      }

      if (emailEnabled() && admin.username?.includes("@")) {
        try {
          const ok = await sendEmail({
            to: admin.username,
            subject: "[Freight DNA] Webex needs to be reconnected",
            html: buildEmailHtml(admin.name || admin.username, appUrl, reason),
          });
          if (ok) emailCount++;
        } catch (mailErr) {
          log(
            `Failed email to admin ${admin.username}: ${
              mailErr instanceof Error ? mailErr.message : String(mailErr)
            }`,
          );
        }
      }
    }

    log(
      `Sent Webex re-auth alerts to ${adminUsers.length} admins (${inAppCount} new in-app, ${emailCount} emails)`,
    );
  } catch (err) {
    log(`notifyAdminsOfWebexReauthNeeded error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
