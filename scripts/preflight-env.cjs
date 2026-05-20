#!/usr/bin/env node
/**
 * Freight-DNA pre-boot env validator.
 *
 * Runs before `node dist/index.cjs` on Render (wired via `npm start`). Exits
 * non-zero if critical env is missing or obviously unsafe so the deploy fails
 * loudly instead of silently booting with degraded auth, the wrong Clerk keys,
 * or a `"dev-only-secret"` session cookie.
 *
 * Plain Node CommonJS — no TypeScript, no npm deps, no network. Safe to run
 * inside a production container where devDependencies (including `tsx`) are
 * stripped by `npm install --omit=dev`.
 *
 * Exit codes:
 *   0  PASS — boot may proceed
 *   1  FAIL — one or more critical checks failed
 *
 * The validator NEVER prints secret values. It only prints check names and
 * pass/fail status. Secret-shaped diagnostics (key prefixes etc.) are limited
 * to the first 4 chars when needed.
 */

"use strict";

const env = process.env;
const appEnv = String(env.APP_ENV || "").trim().toLowerCase();
const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();

const results = [];
function pass(name, detail) {
  results.push({ ok: true, name, detail: detail || "" });
}
function fail(name, detail) {
  results.push({ ok: false, name, detail: detail || "" });
}

function isNonTrivial(value, minLen) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < minLen) return false;
  // Reject obvious placeholders / dev fallbacks.
  const lower = v.toLowerCase();
  const banned = [
    "dev-only-secret",
    "changeme",
    "change-me",
    "secret",
    "password",
    "your-secret-here",
    "todo",
    "xxx",
  ];
  if (banned.includes(lower)) return false;
  if (/^(.)\1+$/.test(v)) return false; // all same char
  return true;
}

// ---------- 1. APP_ENV gate ----------
const allowedAppEnv = new Set(["production", "staging", "development"]);
if (!appEnv) {
  fail("APP_ENV", "missing (expected one of production|staging|development)");
} else if (!allowedAppEnv.has(appEnv)) {
  fail("APP_ENV", `invalid value '${appEnv}' (expected production|staging|development)`);
} else {
  pass("APP_ENV", appEnv);
}

const isRenderTarget = appEnv === "production" || appEnv === "staging";

// Short-circuit: if APP_ENV is dev or absent, skip the Render-only checks but
// still report what we have so local-dev runs of this script are useful.
if (!isRenderTarget) {
  if (appEnv === "development") {
    pass("Render-target checks", "skipped (APP_ENV=development)");
  }
} else {
  // ---------- 2. NODE_ENV ----------
  if (nodeEnv !== "production") {
    fail("NODE_ENV", `expected 'production' on Render target, got '${nodeEnv || "(unset)"}'`);
  } else {
    pass("NODE_ENV", "production");
  }

  // ---------- 3. DATABASE_URL ----------
  if (!env.DATABASE_URL || !env.DATABASE_URL.trim()) {
    fail("DATABASE_URL", "missing");
  } else if (!/^postgres(ql)?:\/\//i.test(env.DATABASE_URL.trim())) {
    fail("DATABASE_URL", "does not look like a postgres:// URL");
  } else {
    pass("DATABASE_URL", "postgres URL present");
  }

  // ---------- 4. SESSION_SECRET ----------
  if (!env.SESSION_SECRET || !env.SESSION_SECRET.trim()) {
    fail("SESSION_SECRET", "missing — server/auth.ts would silently fall back to 'dev-only-secret'");
  } else if (!isNonTrivial(env.SESSION_SECRET, 16)) {
    fail("SESSION_SECRET", "too short (<16 chars) or matches a known placeholder");
  } else {
    pass("SESSION_SECRET", `present (length=${env.SESSION_SECRET.trim().length})`);
  }

  // ---------- 5. Clerk keys ----------
  // clerkConfig.ts prefers _LIVE/_TEST then falls back to the generic name,
  // so accept either the env-specific pair OR the generic pair as valid.
  const wantsLive = appEnv === "production";
  const pubSpecific = wantsLive ? env.CLERK_PUBLISHABLE_KEY_LIVE : env.CLERK_PUBLISHABLE_KEY_TEST;
  const secSpecific = wantsLive ? env.CLERK_SECRET_KEY_LIVE : env.CLERK_SECRET_KEY_TEST;
  const pub = (pubSpecific || env.CLERK_PUBLISHABLE_KEY || "").trim();
  const sec = (secSpecific || env.CLERK_SECRET_KEY || "").trim();

  if (!pub) {
    fail("CLERK_PUBLISHABLE_KEY", `missing (expected ${wantsLive ? "_LIVE" : "_TEST"} or generic)`);
  } else {
    const expectPrefix = wantsLive ? "pk_live_" : "pk_test_";
    if (!pub.startsWith(expectPrefix)) {
      fail(
        "CLERK_PUBLISHABLE_KEY",
        `prefix mismatch: APP_ENV=${appEnv} expects '${expectPrefix}…', got '${pub.slice(0, 8)}…'`,
      );
    } else {
      pass("CLERK_PUBLISHABLE_KEY", `${expectPrefix}…`);
    }
  }

  if (!sec) {
    fail("CLERK_SECRET_KEY", `missing (expected ${wantsLive ? "_LIVE" : "_TEST"} or generic)`);
  } else {
    const expectPrefix = wantsLive ? "sk_live_" : "sk_test_";
    if (!sec.startsWith(expectPrefix)) {
      fail(
        "CLERK_SECRET_KEY",
        `prefix mismatch: APP_ENV=${appEnv} expects '${expectPrefix}…', got '${sec.slice(0, 8)}…'`,
      );
    } else {
      pass("CLERK_SECRET_KEY", `${expectPrefix}…`);
    }
  }

  // ---------- 6. EMAIL_LIVE_MODE (must be EXPLICIT on Render) ----------
  const rawEmail = env.EMAIL_LIVE_MODE;
  if (rawEmail === undefined || String(rawEmail).trim() === "") {
    fail(
      "EMAIL_LIVE_MODE",
      "must be set EXPLICITLY on Render (use 'on' for prod, 'off' for staging) — fail-closed default would block all email",
    );
  } else {
    pass("EMAIL_LIVE_MODE", String(rawEmail).trim());
  }

  // ---------- 7. Staging-specific sanity ----------
  if (appEnv === "staging") {
    // Belt-and-suspenders: re-assert APP_ENV literal in case a future caller
    // bypasses the top-level gate. (Cheap; user-required.)
    if (appEnv !== "staging") {
      fail("APP_ENV(staging)", "expected literal 'staging'");
    } else {
      pass("APP_ENV(staging)", "staging");
    }
  }

  // ---------- 8. Forbidden dev-only bypasses ----------
  if (env.DEV_AUTH_BYPASS && String(env.DEV_AUTH_BYPASS).trim().toLowerCase() !== "false") {
    fail("DEV_AUTH_BYPASS", "MUST NOT be set on Render — would disable Clerk auth entirely");
  } else {
    pass("DEV_AUTH_BYPASS", "unset");
  }
  if (env.DEV_AUTH_BYPASS_USER_ID && String(env.DEV_AUTH_BYPASS_USER_ID).trim()) {
    fail("DEV_AUTH_BYPASS_USER_ID", "MUST NOT be set on Render");
  } else {
    pass("DEV_AUTH_BYPASS_USER_ID", "unset");
  }
}

// ---------- Print + exit ----------
let failedCount = 0;
for (const r of results) {
  const tag = r.ok ? "PASS" : "FAIL";
  const stream = r.ok ? process.stdout : process.stderr;
  stream.write(`[preflight-env] ${tag}  ${r.name}${r.detail ? " — " + r.detail : ""}\n`);
  if (!r.ok) failedCount += 1;
}

if (failedCount === 0) {
  process.stdout.write(`[preflight-env] OVERALL: PASS (${results.length} checks)\n`);
  process.exit(0);
} else {
  process.stderr.write(
    `[preflight-env] OVERALL: FAIL (${failedCount} failed of ${results.length}) — refusing to boot\n`,
  );
  process.exit(1);
}
