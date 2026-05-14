/**
 * Email Live Mode Gate
 *
 * A lightweight in-memory switch that controls whether outbound emails
 * are actually dispatched.  When disabled (the default), every email call
 * logs the suppressed message and returns without making any network call.
 *
 * The flag is persisted as a feature-flag row ("email_live_mode") and
 * loaded on server startup.  The in-memory state is refreshed whenever
 * an admin toggles the flag via the API.
 *
 * ── Env precondition (Render-cutover hardening) ──────────────────────────
 * In addition to the DB flag, live mode now requires BOTH:
 *
 *   1. APP_ENV === 'production'
 *   2. EMAIL_LIVE_MODE === 'true'   (env var, case-insensitive)
 *
 * Either condition failing forces live mode OFF regardless of what the
 * DB flag or an admin toggle says. This is what makes
 * `freight-dna.onrender.com` (APP_ENV=staging) email-safe even though it
 * runs against a Neon branch of prod whose `feature_flags` row is
 * `email_live_mode = true`. Without this gate the staging boot would
 * inherit the DB flag and start sending real customer mail. The check is
 * evaluated on every `setEmailLiveMode(...)` call so a misconfigured
 * APP_ENV change is caught at the next reload, not the next reboot.
 */

let _liveMode = false;

function ts() {
  return new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * Returns whether the runtime environment is permitted to send live email.
 * Both APP_ENV=production AND EMAIL_LIVE_MODE=true (env) must hold.
 *
 * APP_ENV defaults to 'production' when unset to preserve back-compat with
 * existing prod deploys that never set APP_ENV explicitly. The
 * EMAIL_LIVE_MODE check has no such default — unset is treated as false,
 * so a fresh prod deploy still has to opt in to live sending.
 */
function envAllowsLiveMode(): { allowed: boolean; reason: string } {
  const appEnv = (process.env.APP_ENV ?? "production").trim().toLowerCase();
  const envFlag = String(process.env.EMAIL_LIVE_MODE ?? "").trim().toLowerCase();
  if (appEnv !== "production") {
    return { allowed: false, reason: `APP_ENV=${appEnv || "(unset)"} (not production)` };
  }
  if (envFlag !== "true") {
    return { allowed: false, reason: `EMAIL_LIVE_MODE=${envFlag || "(unset)"} (not 'true')` };
  }
  return { allowed: true, reason: "APP_ENV=production AND EMAIL_LIVE_MODE=true" };
}

export function isEmailLiveModeOn(): boolean {
  return _liveMode;
}

export function setEmailLiveMode(requested: boolean): void {
  const gate = envAllowsLiveMode();
  const effective = requested && gate.allowed;
  _liveMode = effective;

  // TEMP DIAGNOSTIC (Render cutover): prove which build is running and
  // what env it sees. Safe to print — only env booleans, no secrets.
  console.log(
    `${ts()} [email-gate][diag] APP_ENV_raw=${JSON.stringify(process.env.APP_ENV ?? null)}` +
      ` EMAIL_LIVE_MODE_raw=${JSON.stringify(process.env.EMAIL_LIVE_MODE ?? null)}` +
      ` requested=${requested} envAllowed=${gate.allowed} effective=${effective}` +
      ` build=hardened-2026-05-14`,
  );

  if (effective) {
    console.log(
      `${ts()} [email-gate] ✅ Email live mode ON — outbound emails will be sent`,
    );
  } else if (requested && !gate.allowed) {
    // DB / admin requested ON but env preconditions block it. Log loudly
    // so operators can see WHY staging is suppressing mail despite the
    // DB row saying otherwise.
    console.log(
      `${ts()} [email-gate] Email live mode OFF — outbound emails disabled` +
        ` (env gate blocked: ${gate.reason}; DB/admin requested ON, ignored)`,
    );
  } else {
    console.log(
      `${ts()} [email-gate] Email live mode OFF — outbound emails disabled`,
    );
  }
}

export const EMAIL_LIVE_MODE_FLAG = "email_live_mode";
