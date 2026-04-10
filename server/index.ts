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
import { startIntelEmailScheduler } from "./intelEmailScheduler";
import { runMigrations } from "./runMigrations";
import { storage } from "./storage";
import { WebhookHandlers } from "./webhookHandlers";
import { setEmailLiveMode, EMAIL_LIVE_MODE_FLAG } from "./emailGate";

const app = express();
const httpServer = createServer(app);

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
      initNbaPhase1Scheduler();
      startIntelEmailScheduler();
    },
  );
})();
