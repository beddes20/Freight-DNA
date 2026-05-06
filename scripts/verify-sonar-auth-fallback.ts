/**
 * Task #465 — verify SONAR_USERNAME/PASSWORD fallback engages when the
 * direct bearer token is rejected.
 *
 * Strategy:
 *   1. Replace FREIGHTWAVES_TOKEN with an obviously-invalid value before
 *      importing sonarClient (so the module reads the bad value).
 *   2. Issue a real Sonar GET. The first attempt returns 401, the client
 *      should mark the bearer invalid and retry with the username/password
 *      auth flow.
 *   3. Probe the health endpoint and assert authMode flipped to
 *      "username_password".
 *
 * Run:  npx tsx scripts/verify-sonar-auth-fallback.ts
 */

const realToken = process.env.FREIGHTWAVES_TOKEN;
process.env.FREIGHTWAVES_TOKEN = "deliberately.invalid.token";

(async () => {
  const sonar = await import("../server/sonarClient");

  console.log("[verify] forcing a Sonar GET with invalid bearer token…");
  // Trigger by asking for the national summary (calls sonarGet under the hood).
  await sonar.getNationalMarketSummary();

  const report = await sonar.probeSonarHealth();
  console.log("[verify] auth mode now reported as:", report.authMode);
  console.log("[verify] daily.lastSuccessAt:", report.daily.lastSuccessAt);
  console.log("[verify] national probe ok:", report.national.ok);
  console.log("[verify] lane probe elapsedMs:", report.laneProbe.elapsedMs);

  if (process.env.SONAR_USERNAME && process.env.SONAR_PASSWORD) {
    if (report.authMode === "username_password") {
      console.log("[verify] ✅ FALLBACK ENGAGED — bearer was rejected and SONAR_USERNAME/PASSWORD auth is active");
    } else if (report.authMode === "bearer_token") {
      console.log("[verify] ❌ FALLBACK DID NOT ENGAGE — auth mode still reports bearer_token");
      process.exitCode = 1;
    } else {
      console.log("[verify] ❌ Unexpected auth mode:", report.authMode);
      process.exitCode = 1;
    }
  } else {
    console.log("[verify] (SONAR_USERNAME/PASSWORD not configured — would have reported authMode=none)");
  }

  process.env.FREIGHTWAVES_TOKEN = realToken;
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
})().catch((err) => {
  console.error("[verify] FATAL:", err);
  process.exit(2);
});
