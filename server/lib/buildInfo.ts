/**
 * Build / runtime identity helpers.
 *
 * `getGitSha()` returns the commit SHA the running artifact was built from,
 * resolved from the first env var the host platform sets. Returns
 * `"unavailable"` when nothing is set so callers can render the value
 * unconditionally in /api/health/deep responses without branching.
 *
 * No I/O. No imports. Safe to call from any boot phase, including before
 * route registration.
 */
export function getGitSha(): string {
  return (
    process.env.RENDER_GIT_COMMIT ??
    process.env.REPLIT_GIT_COMMIT ??
    process.env.GIT_SHA ??
    "unavailable"
  );
}
