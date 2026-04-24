import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import { execSync } from "child_process";
import { registerRoutes } from "./routes";
import { setupAuth } from "./auth";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initMonthlyGoalScheduler } from "./monthlyGoalScheduler";
import { initMonthlyDataRefreshScheduler } from "./monthlyDataRefreshScheduler";
import { initAvailableFreightImportScheduler } from "./availableFreightScheduler";
import { initLoadFactScheduler } from "./loadFactScheduler";
import { initRfpDeadlineScheduler } from "./rfpDeadlineScheduler";
import { initDailyDigestScheduler } from "./dailyDigestScheduler";
import { initRepReportScheduler } from "./repReportScheduler";
import { initOneOnOneReminderScheduler } from "./oneOnOneReminderScheduler";
import { initHealthAlertScheduler } from "./healthAlertScheduler";
import { initCallVolumeDropScheduler } from "./callVolumeDropScheduler";
import { initPlayOutcomeWindowScheduler } from "./playOutcomeWindowScheduler";
import { initNbaOutcomeClassifier } from "./nbaOutcomeClassifier";
import { initValueIQTodayScheduler } from "./valueiqTodayScheduler";
import { initPtoReturnScheduler } from "./ptoReturnScheduler";
import { initWeeklyGoalRecapScheduler } from "./weeklyGoalRecapScheduler";
import { initWeeklyAccountReviewScheduler } from "./weeklyAccountReviewScheduler";
import { initCoachingDigestScheduler } from "./coachingDigestScheduler";
import { initMissedInboundRecapScheduler } from "./missedInboundRecapScheduler";
import { initLmCheckinScheduler } from "./lmCheckinScheduler";
import { initNbaPhase1Scheduler } from "./nbaPhase1Scheduler";
import { initSonarDailyRefreshScheduler } from "./sonarDailyRefreshScheduler";
import { initMarketSignalScheduler } from "./marketSignalScheduler";
import { initMomentumDropScheduler } from "./momentumDropScheduler";
import { initReplyLatencyRegressionScheduler } from "./replyLatencyRegressionScheduler";
import { initConversationArchiveScheduler } from "./conversationArchiveScheduler";
import { initSuggestionFeedbackLearningScheduler } from "./suggestionFeedbackLearningScheduler";
import { initPafoeWaveScheduler } from "./pafoeWaveScheduler";
import { scoreAllEligibleLanes } from "./laneScoringService";
import { startIntelEmailScheduler } from "./intelEmailScheduler";
import { startEmailIntelligenceScheduler } from "./emailIntelligenceScheduler";
import { startQuoteRequestSlaScheduler } from "./quoteRequestSlaService";
import { initGraphSubscriptionService } from "./graphSubscriptionService";
import { initDeltaSyncScheduler } from "./services/mailboxDeltaSyncService";
import { initWebexSyncScheduler } from "./routes/webex";
import { runMigrations } from "./runMigrations";
import { assertNoSchemaDrift } from "./checkSchemaDrift";
import { Pool as SchemaCheckPool } from "pg";
import { storage } from "./storage";
import { WebhookHandlers } from "./webhookHandlers";
import { setEmailLiveMode, EMAIL_LIVE_MODE_FLAG } from "./emailGate";

const app = express();
const httpServer = createServer(app);

const MIRROR_PORT = 23636;
const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * Pre-flight: kill any stale process holding the port we want to bind.
 * Workflow restarts occasionally leave the prior `tsx server/index.ts` process
 * holding port 5000, which causes the new process to fail with EADDRINUSE
 * (reusePort doesn't help when the original holder didn't set it). Dev-only.
 */
function killStalePortHolders(port: number): void {
  if (!IS_DEV) return;
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: "utf8" });
    const pids = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((pid) => Number(pid) !== process.pid);
    for (const pid of pids) {
      // Only target our own dev server processes — never kill an unrelated
      // tool that happens to be bound to the same port (postgres, debugger…).
      let cmdline = "";
      try {
        cmdline = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, { encoding: "utf8" }).trim();
      } catch {
        /* ps may fail under odd permissions */
      }
      const looksLikeOurServer =
        cmdline.includes("server/index.ts") ||
        cmdline.includes("tsx ") ||
        cmdline.includes("node");
      if (!looksLikeOurServer) {
        console.warn(`[startup] port ${port} held by foreign pid=${pid} (${cmdline}) — refusing to kill`);
        continue;
      }
      try {
        // Polite shutdown first, then SIGKILL only if it didn't release the port.
        execSync(`kill -15 ${pid} 2>/dev/null || true`);
        execSync("sleep 0.3");
        const stillThere = execSync(`kill -0 ${pid} 2>/dev/null && echo y || echo n`, { encoding: "utf8" }).trim();
        if (stillThere === "y") {
          execSync(`kill -9 ${pid}`);
        }
        console.log(`[startup] cleared stale port ${port} holder pid=${pid}`);
      } catch {
        /* may have exited already */
      }
    }
    if (pids.length > 0) {
      // Brief wait so the OS releases the port before we try to bind.
      execSync("sleep 0.3");
    }
  } catch {
    // lsof not available — best-effort only.
  }
}

killStalePortHolders(parseInt(process.env.PORT || "5000", 10));
let earlyClaimBound = false;
let earlyClaimServer: ReturnType<typeof createServer> | null = null;
if (IS_DEV) {
  earlyClaimServer = createServer((_req, res) => {
    res.writeHead(503);
    res.end("Starting…");
  });
  earlyClaimServer.listen({ port: MIRROR_PORT, host: "0.0.0.0" }, () => {
    earlyClaimBound = true;
    console.log(`[mirror] pre-claimed port ${MIRROR_PORT}`);
  });
  earlyClaimServer.on("error", (err: NodeJS.ErrnoException) => {
    console.warn(`[mirror] pre-claim failed (${err.code || err.message}) — will retry after main server starts`);
  });
}

app.set("trust proxy", 1);

app.use(compression());

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Stripe webhook route MUST be registered BEFORE express.json() parses the body
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature' });
    }
    const sig = Array.isArray(signature) ? signature[0] : signature;
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Stripe webhook error:', message);
      // Return 500 (not 400) so Stripe retries transient failures
      res.status(500).json({ error: 'Webhook processing error' });
    }
  }
);

// Microsoft Graph webhook — registered BEFORE express.json() so malformed JSON
// does not cause Express to reject with 400 before reaching the route handler.
// Graph requires HTTP 200 acknowledgement even for bad payloads.
app.post(
  '/api/webhooks/graph/email',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    // Subscription validation handshake — Graph POSTs with ?validationToken=xxx
    // and expects a 200 response with Content-Type: text/plain and the raw
    // token as the body. Must respond within 10 seconds.
    const validationToken = req.query.validationToken as string | undefined;
    if (validationToken) {
      res.set('Content-Type', 'text/plain');
      return res.status(200).send(validationToken);
    }

    // Immediately acknowledge — Graph times out if response is slow
    res.status(200).json({ received: true });

    let body: unknown;
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      body = JSON.parse(raw);
    } catch {
      // Malformed payload — safely ignore after 200 acknowledgement
      return;
    }

    // Defer to the full handler in graphWebhook.ts via dynamic import
    try {
      const { processGraphNotifications } = await import('./routes/graphWebhook');
      await processGraphNotifications(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[graphWebhook] processNotifications error:', message);
    }
  }
);

app.use(
  express.json({
    limit: "15mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ─── Boot-readiness gate ─────────────────────────────────────────────────────
// Replit Autoscale's promote stage runs an HTTP health check shortly after the
// container starts. Our boot sequence (runMigrations + persona backfill +
// route registration + Stripe init) can exceed that window on a large prod
// database, causing promote to fail with no app logs.
//
// Fix: bind httpServer.listen() *immediately* (further down) and have this
// middleware respond 503 for every request until the rest of the boot
// completes and flips `isReady = true`. /healthz returns 200 unconditionally
// so the platform health check passes even mid-boot.
let isReady = false;

// Always-200 endpoints so any platform health check (Replit Autoscale's
// promote stage, an external uptime monitor, a load balancer, etc.) passes
// during the boot window even before migrations + route registration finish.
// Multiple paths are covered because different platforms hit different
// conventions (/, /healthz, /health, /_health).
const HEALTH_PATHS = new Set(["/", "/healthz", "/health", "/_health", "/readyz"]);
app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain").send(isReady ? "ok" : "starting");
});
app.use((req, res, next) => {
  if (isReady) return next();
  // Health probes (any method): respond 2xx so promote sees a live app.
  if (HEALTH_PATHS.has(req.path)) {
    return res.status(200).type("text/plain").send("starting");
  }
  // Everything else: 503 until boot completes so we don't half-serve traffic.
  res.status(503).type("text/plain").send("Server starting…");
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

async function initStripe() {
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      log("DATABASE_URL not set — skipping Stripe initialization", "stripe");
      return;
    }
    const { runMigrations: stripeRunMigrations } = await import("stripe-replit-sync");
    await stripeRunMigrations({ databaseUrl, schema: "stripe" });
    log("Stripe schema ready", "stripe");

    const { getStripeSync } = await import("./stripeClient");
    const stripeSync = await getStripeSync();

    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0] || "localhost"}`;
    await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
    log("Stripe webhook configured", "stripe");

    stripeSync.syncBackfill()
      .then(() => log("Stripe data synced", "stripe"))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`Stripe backfill error: ${message}`, "stripe");
      });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Stripe initialization warning: ${message}`, "stripe");
  }
}

// Process-level safety nets.
//
// Modern Node exits the process on an unhandled promise rejection or an
// uncaught exception by default, which means a single misbehaving scheduler
// or one bad migration would kill the whole server during boot — and on
// Replit Autoscale that translates to "Promote failed: app failed to start"
// with no app logs.
//
// We log + keep running. The readiness gate above still gates traffic
// behind `isReady`, and the platform health check still gets 200 from the
// HEALTH_PATHS handler, so the deploy can complete and the failing surface
// is investigatable instead of opaque.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
  console.error("[process] Unhandled promise rejection (kept process alive):", message);
});
process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception (kept process alive):", err);
});

(async () => {
  // Bind the port FIRST so Replit Autoscale's promote health check passes
  // immediately. The readiness gate (declared above) holds requests at 503
  // until the rest of boot completes and we set `isReady = true`.
  const port = parseInt(process.env.PORT || "5000", 10);
  await new Promise<void>((resolve) => {
    httpServer.listen(
      { port, host: "0.0.0.0", reusePort: true },
      () => {
        log(`listening on port ${port} (boot in progress)`);
        resolve();
      },
    );
  });

  await runMigrations();

  // Schema-drift guard: after migrations run, verify the live DB has every
  // table/column that `shared/schema.ts` declares. Catches the failure mode
  // where a feature adds columns to the schema but forgets the matching
  // ALTER in `runMigrations.ts` — which broke the Conversations tab in
  // production twice (Tasks #532, #533, fixed reactively in #573).
  // Production refuses to boot on drift; dev logs a loud warning.
  const schemaDriftPool = new SchemaCheckPool({
    connectionString: process.env.DATABASE_URL,
  });
  try {
    await assertNoSchemaDrift(schemaDriftPool);
  } finally {
    await schemaDriftPool.end().catch(() => {});
  }

  await storage.deleteEmptyFinancialUploads();

  // Load email live mode flag from DB and initialize the in-memory gate.
  // Default is OFF (safe) — emails are suppressed until an admin enables live mode.
  try {
    const rows = await storage.getEmailLiveModeAcrossOrgs();
    setEmailLiveMode(rows);
  } catch {
    setEmailLiveMode(false);
  }

  setupAuth(app);

  // Backfill DNA agent + base persona for every existing org so the loader
  // never has to seed lazily on the first user turn (Task #290).
  try {
    const { backfillDefaultAgentsForAllOrgs, migrateLegacyDefaultPersonas } = await import("./agent/persona");
    await backfillDefaultAgentsForAllOrgs();
    // Phase 2A: supersede legacy stock persona bodies so live orgs pick up
    // built-in routing improvements (e.g. team-activity tool guidance)
    // without operator action. Customised persona bodies are left alone.
    await migrateLegacyDefaultPersonas();
  } catch (err) {
    console.error("[startup] DNA agent backfill failed:", err);
  }

  await registerRoutes(httpServer, app);
  await initStripe();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Boot complete — flip the readiness gate so real handlers serve traffic.
  isReady = true;
  log(`ready — serving on port ${port}`);

  if (IS_DEV) {
    const startMirror = () => {
      const mirrorServer = createServer(app);
      mirrorServer.listen({ port: MIRROR_PORT, host: "0.0.0.0" }, () => {
        log(`mirror serving on port ${MIRROR_PORT} (public URL)`);
      });
      mirrorServer.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") log(`mirror port ${MIRROR_PORT} in use — skipping`);
        else console.error("[mirror]", err);
      });
    };
    if (earlyClaimBound && earlyClaimServer) {
      earlyClaimServer.close(startMirror);
    } else {
      startMirror();
    }
  }
  initMonthlyGoalScheduler();
  initMonthlyDataRefreshScheduler();
      initAvailableFreightImportScheduler();
      initLoadFactScheduler();
      initRfpDeadlineScheduler();
      initDailyDigestScheduler();
      initRepReportScheduler();
      initOneOnOneReminderScheduler();
      initHealthAlertScheduler();
      initCallVolumeDropScheduler();
      initPlayOutcomeWindowScheduler();
      initNbaOutcomeClassifier();
      initValueIQTodayScheduler().catch((e) => console.error("[valueiq-today] init error:", e));
      initPtoReturnScheduler();
      initWeeklyGoalRecapScheduler();
      initWeeklyAccountReviewScheduler();
      initCoachingDigestScheduler();
      initMissedInboundRecapScheduler();
      initLmCheckinScheduler();

      setTimeout(() => {
        initNbaPhase1Scheduler();
        initSonarDailyRefreshScheduler();
        initMarketSignalScheduler();
        initMomentumDropScheduler();
        initReplyLatencyRegressionScheduler();
        initConversationArchiveScheduler();
        initSuggestionFeedbackLearningScheduler();
      }, 2000);

      // PAFOE Phase 4 — scheduled-wave dispatcher.
      // Lifted into server/pafoeWaveScheduler.ts so it has a proper module
      // boundary like the other init*Scheduler() callers above.
      initPafoeWaveScheduler();

      setTimeout(() => {
        startIntelEmailScheduler();
        startEmailIntelligenceScheduler();
        startQuoteRequestSlaScheduler();
        initGraphSubscriptionService().catch(err => {
          console.error("[graph-sub] Startup error:", err instanceof Error ? err.message : String(err));
        });
        initDeltaSyncScheduler();
        initWebexSyncScheduler();
        // Task #435: periodic self-heal sweep that pulls missing rep
        // replies from Microsoft Graph SentItems for any conversation
        // thread stuck in "Waiting on us".
        import("./services/conversationReplyCaptureService")
          .then(({ initReplyCaptureSelfHealScheduler }) => initReplyCaptureSelfHealScheduler())
          .catch(err => console.error("[reply-capture] scheduler init error:", err));
      }, 4000);
      // Pre-warm the financial uploads cache so the first carrier-suggestions
      // request doesn't trigger a cold full-table JSONB scan in production.
      setTimeout(() => {
        storage.preWarmFinancialUploadsCache().catch(() => {});
      }, 5000); // 5-second delay so migrations complete and pool is settled

      // Task #285: One-time-on-startup backfill so any orphan email threads
      // (messages/signals without an email_conversation_threads row) get
      // materialised and become assignable. Idempotent across restarts.
      // Task #286: Also start a periodic safety sweep cron so any future
      // ingestion path that bypasses the inline thread upsert still gets
      // its orphans rescued within one cadence interval.
      setTimeout(async () => {
        try {
          const { backfillMissingConversationThreads } = await import(
            "./services/conversationThreadBackfillService"
          );
          const result = await backfillMissingConversationThreads();
          if (result.scanned > 0 || result.inserted > 0) {
            console.log(
              `[conv-thread-backfill] startup pass: scanned=${result.scanned} inserted=${result.inserted} (${result.durationMs}ms)`,
            );
          }
        } catch (err) {
          console.error("[conv-thread-backfill] startup error:", err);
        }
        try {
          const { initConversationThreadBackfillScheduler } = await import(
            "./conversationThreadBackfillScheduler"
          );
          initConversationThreadBackfillScheduler();
        } catch (err) {
          console.error("[conv-thread-backfill-cron] init error:", err);
        }
      }, 6000);

      // Warm lane_summary_cache so the cache-first work-queue path is active
      // before the first rep loads the Lane Work Queue. Runs non-blocking in
      // the background; errors per org are logged but never crash the server.
      setTimeout(async () => {
        try {
          const orgs = await storage.getOrganizations();
          if (!orgs.length) return;
          log(`[lane-cache] Warming lane_summary_cache for ${orgs.length} org(s)…`, "startup");
          for (const org of orgs) {
            try {
              await scoreAllEligibleLanes(org.id, storage);
            } catch (err) {
              log(`[lane-cache] Error warming org ${org.id}: ${err instanceof Error ? err.message : String(err)}`, "startup");
            }
          }
          log("[lane-cache] lane_summary_cache warm-up complete", "startup");
        } catch (err) {
          log(`[lane-cache] Warm-up aborted: ${err instanceof Error ? err.message : String(err)}`, "startup");
        }
      }, 20_000); // 20s: after HF cache and DB pool are fully settled
})().catch((err) => {
  // Last-ditch safety net for the boot IIFE itself. We DO NOT exit the
  // process — Replit Autoscale interprets a crashed process as a failed
  // promote, and the readiness gate above (with HEALTH_PATHS returning 200)
  // is enough to keep the app technically alive while the failure is
  // surfaced via logs. Critically, this also prevents a single failing
  // dynamic import (e.g. one stale persona migration) from killing the
  // whole deploy.
  console.error("[startup] Boot IIFE failed:", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err);
});
