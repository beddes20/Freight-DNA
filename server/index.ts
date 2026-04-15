import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import { registerRoutes } from "./routes";
import { setupAuth } from "./auth";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initMonthlyGoalScheduler } from "./monthlyGoalScheduler";
import { initMonthlyDataRefreshScheduler } from "./monthlyDataRefreshScheduler";
import { initRfpDeadlineScheduler } from "./rfpDeadlineScheduler";
import { initDailyDigestScheduler } from "./dailyDigestScheduler";
import { initRepReportScheduler } from "./repReportScheduler";
import { initOneOnOneReminderScheduler } from "./oneOnOneReminderScheduler";
import { initHealthAlertScheduler } from "./healthAlertScheduler";
import { initPtoReturnScheduler } from "./ptoReturnScheduler";
import { initWeeklyGoalRecapScheduler } from "./weeklyGoalRecapScheduler";
import { initLmCheckinScheduler } from "./lmCheckinScheduler";
import { initNbaPhase1Scheduler } from "./nbaPhase1Scheduler";
import { initMarketSignalScheduler } from "./marketSignalScheduler";
import { initMomentumDropScheduler } from "./momentumDropScheduler";
import { initConversationArchiveScheduler } from "./conversationArchiveScheduler";
import { scoreAllEligibleLanes } from "./laneScoringService";
import { startIntelEmailScheduler } from "./intelEmailScheduler";
import { startEmailIntelligenceScheduler } from "./emailIntelligenceScheduler";
import { startQuoteRequestSlaScheduler } from "./quoteRequestSlaService";
import { initGraphSubscriptionService } from "./graphSubscriptionService";
import { initDeltaSyncScheduler } from "./services/mailboxDeltaSyncService";
import { initWebexSyncScheduler } from "./routes/webex";
import { runMigrations } from "./runMigrations";
import { storage } from "./storage";
import { WebhookHandlers } from "./webhookHandlers";
import { setEmailLiveMode, EMAIL_LIVE_MODE_FLAG } from "./emailGate";

const app = express();
const httpServer = createServer(app);

const MIRROR_PORT = 23636;
const IS_DEV = process.env.NODE_ENV !== "production";
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

(async () => {
  await runMigrations();
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

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

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
      initRfpDeadlineScheduler();
      initDailyDigestScheduler();
      initRepReportScheduler();
      initOneOnOneReminderScheduler();
      initHealthAlertScheduler();
      initPtoReturnScheduler();
      initWeeklyGoalRecapScheduler();
      initLmCheckinScheduler();

      setTimeout(() => {
        initNbaPhase1Scheduler();
        initMarketSignalScheduler();
        initMomentumDropScheduler();
        initConversationArchiveScheduler();
      }, 2000);

      setTimeout(() => {
        startIntelEmailScheduler();
        startEmailIntelligenceScheduler();
        startQuoteRequestSlaScheduler();
        initGraphSubscriptionService().catch(err => {
          console.error("[graph-sub] Startup error:", err instanceof Error ? err.message : String(err));
        });
        initDeltaSyncScheduler();
        initWebexSyncScheduler();
      }, 4000);
      // Pre-warm the financial uploads cache so the first carrier-suggestions
      // request doesn't trigger a cold full-table JSONB scan in production.
      setTimeout(() => {
        storage.preWarmFinancialUploadsCache().catch(() => {});
      }, 5000); // 5-second delay so migrations complete and pool is settled

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
    },
  );
})();
