/**
 * Clerk environment-aware key resolution.
 *
 * Why this exists
 * ───────────────
 * After the Render cutover we run two long-lived environments off the same
 * codebase:
 *
 *   - staging     — `freight-dna.onrender.com`, expects Clerk **test** keys
 *   - production  — `freight-dna.com`,           expects Clerk **live** keys
 *
 * The selection MUST be driven by an explicit env var (`APP_ENV`), never by
 * sniffing the request `Host` / `X-Forwarded-Host`. Host-based guessing
 * silently swaps modes during health checks, custom-domain verification,
 * and (worst case) a Render rename — landing live keys on staging or
 * vice-versa. An explicit env var fails predictably and is auditable in
 * the Render dashboard.
 *
 * Precedence for each key
 * ───────────────────────
 *   1. Per-env override:
 *        production           → CLERK_PUBLISHABLE_KEY_LIVE / CLERK_SECRET_KEY_LIVE
 *        staging | development→ CLERK_PUBLISHABLE_KEY_TEST / CLERK_SECRET_KEY_TEST
 *   2. Generic fallback (back-compat with the pre-cutover single-key setup):
 *        CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY
 *   3. Empty string + boot warning.
 *
 * The per-env vars let an operator stage BOTH keys on the same Render
 * service for an emergency cutover (flip `APP_ENV` and redeploy without
 * editing key values). The generic fallback means existing dev setups
 * keep working with no env changes.
 *
 * Why we mutate process.env
 * ─────────────────────────
 * `@clerk/express` (`clerkMiddleware`, `clerkClient`) and the
 * `@clerk/express` `verifyToken` SDK read `process.env.CLERK_SECRET_KEY`
 * lazily on every request. Re-writing every callsite to thread an
 * explicit `secretKey` option through the SDK would be invasive and
 * error-prone. Instead `applyClerkEnv()` resolves the env-aware values
 * once at boot and assigns them back onto `process.env.CLERK_*_KEY`, so
 * every downstream reader (the SDK, our own callsites, future code)
 * sees the right value with zero plumbing.
 *
 * Callers should still prefer `getClerkPublishableKey()` /
 * `getClerkSecretKey()` directly — the process.env mutation is a safety
 * net for transitive SDK reads, not the primary contract.
 */

export type AppEnv = "development" | "staging" | "production";

/**
 * Resolve the running environment.
 *
 *   1. If `APP_ENV` is set to a recognised value, use it verbatim.
 *   2. Otherwise fall back to `NODE_ENV === "production"` for back-compat
 *      with pre-cutover deploys that only set NODE_ENV.
 *   3. Else `"development"`.
 *
 * Trimmed and lowercased so common Render-dashboard typos
 * (`Production `, `STAGING`) still resolve correctly.
 */
export function resolveAppEnv(): AppEnv {
  const raw = (process.env.APP_ENV ?? "").trim().toLowerCase();
  if (raw === "production" || raw === "staging" || raw === "development") {
    return raw;
  }
  if (process.env.NODE_ENV === "production") return "production";
  return "development";
}

type KeyKind = "publishable" | "secret";

interface ResolvedKey {
  value: string;
  source: "per-env" | "generic" | "unset";
  perEnvVar: string;
  genericVar: string;
}

function resolveKey(env: AppEnv, kind: KeyKind): ResolvedKey {
  const isLive = env === "production";
  const perEnvVar =
    kind === "publishable"
      ? isLive
        ? "CLERK_PUBLISHABLE_KEY_LIVE"
        : "CLERK_PUBLISHABLE_KEY_TEST"
      : isLive
        ? "CLERK_SECRET_KEY_LIVE"
        : "CLERK_SECRET_KEY_TEST";
  const genericVar =
    kind === "publishable" ? "CLERK_PUBLISHABLE_KEY" : "CLERK_SECRET_KEY";

  const perEnv = (process.env[perEnvVar] ?? "").trim();
  if (perEnv !== "") {
    return { value: perEnv, source: "per-env", perEnvVar, genericVar };
  }
  const generic = (process.env[genericVar] ?? "").trim();
  if (generic !== "") {
    return { value: generic, source: "generic", perEnvVar, genericVar };
  }
  return { value: "", source: "unset", perEnvVar, genericVar };
}

/**
 * Returns the Clerk publishable key appropriate for the current env.
 * Empty string when no key is configured (caller decides whether that
 * is fatal — the boot log will already have warned).
 */
export function getClerkPublishableKey(): string {
  return resolveKey(resolveAppEnv(), "publishable").value;
}

/**
 * Returns the Clerk secret key appropriate for the current env. Empty
 * string when no key is configured.
 */
export function getClerkSecretKey(): string {
  return resolveKey(resolveAppEnv(), "secret").value;
}

function prefix(value: string): string {
  if (value === "") return "(unset)";
  return `${value.slice(0, 8)}…`;
}

function expectedPrefix(env: AppEnv): "pk_live" | "pk_test" {
  return env === "production" ? "pk_live" : "pk_test";
}

function expectedSecretPrefix(env: AppEnv): "sk_live" | "sk_test" {
  return env === "production" ? "sk_live" : "sk_test";
}

export interface ClerkEnvSummary {
  env: AppEnv;
  publishable: { prefix: string; source: ResolvedKey["source"]; var: string };
  secret: { prefix: string; source: ResolvedKey["source"]; var: string };
  warnings: string[];
}

/**
 * Resolve + apply Clerk env-aware keys.
 *
 * Call ONCE near the top of `server/index.ts` boot (before any incoming
 * request can hit `clerkMiddleware`). Mutates `process.env.CLERK_*_KEY`
 * to the resolved values so the `@clerk/express` SDK transparently
 * picks the right key.
 *
 * Returns a summary suitable for a single boot log line. Warnings
 * include cases where the resolved key prefix does not match the
 * env (e.g. `pk_live_…` selected under `APP_ENV=staging`), or where
 * a required key is missing entirely.
 */
export function applyClerkEnv(): ClerkEnvSummary {
  const env = resolveAppEnv();
  const pub = resolveKey(env, "publishable");
  const sec = resolveKey(env, "secret");
  const warnings: string[] = [];

  if (pub.value === "") {
    warnings.push(
      `no publishable key configured (set ${pub.perEnvVar} or ${pub.genericVar})`,
    );
  } else if (!pub.value.startsWith(expectedPrefix(env))) {
    warnings.push(
      `publishable key prefix does not match APP_ENV=${env} (expected ${expectedPrefix(env)}_…, got ${pub.value.slice(0, 7)}…)`,
    );
  }

  if (sec.value === "") {
    warnings.push(
      `no secret key configured (set ${sec.perEnvVar} or ${sec.genericVar})`,
    );
  } else if (!sec.value.startsWith(expectedSecretPrefix(env))) {
    warnings.push(
      `secret key prefix does not match APP_ENV=${env} (expected ${expectedSecretPrefix(env)}_…, got ${sec.value.slice(0, 7)}…)`,
    );
  }

  // Mutate process.env so `@clerk/express`'s lazy reads see the
  // env-aware values without any per-callsite plumbing. Only assign
  // when we actually resolved something — never overwrite a generic
  // value with empty string.
  if (pub.value !== "") process.env.CLERK_PUBLISHABLE_KEY = pub.value;
  if (sec.value !== "") process.env.CLERK_SECRET_KEY = sec.value;

  return {
    env,
    publishable: {
      prefix: prefix(pub.value),
      source: pub.source,
      var: pub.source === "per-env" ? pub.perEnvVar : pub.genericVar,
    },
    secret: {
      prefix: prefix(sec.value),
      source: sec.source,
      var: sec.source === "per-env" ? sec.perEnvVar : sec.genericVar,
    },
    warnings,
  };
}

/** Operator-friendly app env description (for boot logs / debug routes). */
export function describeAppEnv(): AppEnv {
  return resolveAppEnv();
}
