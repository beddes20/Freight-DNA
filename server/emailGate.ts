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

export function isEmailLiveModeOn(): boolean {
  return _liveMode;
}

export function setEmailLiveMode(enabled: boolean): void {
  _liveMode = enabled;
  if (enabled) {
    console.log(`${ts()} [email-gate] ✅ Email live mode ON — outbound emails will be sent`);
  } else {
    console.log(`${ts()} [email-gate] 🔇 Email live mode OFF — all outbound emails are suppressed`);
  }
}

export const EMAIL_LIVE_MODE_FLAG = "email_live_mode";
