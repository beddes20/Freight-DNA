/**
 * Email Intelligence v1.5 — Consumer routes (Task #943).
 *
 * Single read surface (HTTP) into `EmailFactsAdapter`. These endpoints are
 * the supported way for the account view, conversation view, coaching
 * dashboards, and any other consumer to surface v1.5 fact data — they
 * MUST NOT poke at `email_signals.extractedData` directly.
 *
 * All routes are org-scoped via the request user; cross-org access is
 * denied at the storage layer (every fact table is filtered by `org_id`).
 * The single `POST /api/admin/email-facts/run-sweeps` privilege escalation
 * is gated by an explicit admin-role check.
 */

import type { Express, Request, Response } from "express";
import { emailFactsAdapter } from "../services/emailFacts";
import { runEmailFactsSweepsOnce } from "../emailFactsScheduler";
import { pStr, qOptStr, qStrArr } from "../lib/req";

interface RequestUser {
  organizationId?: string;
  role?: string | null;
}

function getUser(req: Request): RequestUser | null {
  return (req as Request & { user?: RequestUser }).user ?? null;
}

function requireOrg(req: Request, res: Response): string | null {
  const u = getUser(req);
  const id = u?.organizationId ?? null;
  if (!id) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return id;
}

function isAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}

export function registerEmailFactsRoutes(app: Express): void {
  // ── Per-account snapshot (account view "facts" panel) ────────────────────
  app.get("/api/email-facts/accounts/:companyId", async (req, res) => {
    try {
      const org = requireOrg(req, res); if (!org) return;
      const companyId = pStr(req.params.companyId);
      if (!companyId) return res.status(400).json({ error: "companyId_required" });

      const [stakeholders, sentiment, openQuestions, recentPromises, recentQuality] = await Promise.all([
        emailFactsAdapter.getStakeholderGraphForAccount(org, companyId),
        emailFactsAdapter.getSentimentTrendForAccount(org, companyId),
        emailFactsAdapter.getQuestionsForAccount(org, companyId),
        emailFactsAdapter.getPromisesForAccount(org, companyId),
        emailFactsAdapter.getQualityScoresForAccount(org, companyId, 30),
      ]);

      res.json({
        stakeholders,
        sentiment,
        openQuestionCount: openQuestions.length,
        openQuestions: openQuestions.slice(0, 5),
        promises: recentPromises.slice(0, 5),
        outboundQuality: recentQuality,
      });
    } catch (err) {
      console.error("[emailFacts.routes] account snapshot failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ── Per-thread snapshot (conversation drawer) ────────────────────────────
  app.get("/api/email-facts/threads/:threadId", async (req, res) => {
    try {
      const org = requireOrg(req, res); if (!org) return;
      const threadId = pStr(req.params.threadId);
      if (!threadId) return res.status(400).json({ error: "threadId_required" });

      const [participants, slots] = await Promise.all([
        emailFactsAdapter.getParticipantsForThread(org, threadId),
        emailFactsAdapter.getSlotsForThread(org, threadId),
      ]);

      res.json({
        participants,
        slots: Object.fromEntries(slots),
      });
    } catch (err) {
      console.error("[emailFacts.routes] thread snapshot failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ── Contact bounce + sentiment status (compose form badges) ──────────────
  app.get("/api/email-facts/contacts/:email/status", async (req, res) => {
    try {
      const org = requireOrg(req, res); if (!org) return;
      const email = pStr(req.params.email);
      if (!email) return res.status(400).json({ error: "email_required" });
      const status = await emailFactsAdapter.getBounceStatusForContact(org, email.toLowerCase());
      res.json(status);
    } catch (err) {
      console.error("[emailFacts.routes] contact status failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ── Per-rep coaching roll-up (open questions / promises / quality) ───────
  app.get("/api/email-facts/reps/:repUserId/coaching", async (req, res) => {
    try {
      const org = requireOrg(req, res); if (!org) return;
      const repUserId = pStr(req.params.repUserId);
      if (!repUserId) return res.status(400).json({ error: "repUserId_required" });
      // `addresses` accepts either a comma-separated single value or repeated
      // ?addresses=foo&addresses=bar — qStrArr normalises both.
      const addresses = qStrArr(req.query.addresses).map((s) => s.toLowerCase()).filter(Boolean);
      // tolerate `?since=30` — currently unused, just narrowed for parity.
      qOptStr(req.query.since);

      const [openPromises, openQuestions, qualityRollup] = await Promise.all([
        emailFactsAdapter.getPromisesForRep(org, repUserId, "open"),
        addresses.length > 0 ? emailFactsAdapter.getUnansweredQuestionsForRep(org, addresses) : Promise.resolve([]),
        emailFactsAdapter.getQualityScoresForRep(org, repUserId, 30),
      ]);

      res.json({
        openPromiseCount: openPromises.length,
        openPromises: openPromises.slice(0, 10),
        openQuestionCount: openQuestions.length,
        openQuestions: openQuestions.slice(0, 10),
        outboundQuality: qualityRollup,
      });
    } catch (err) {
      console.error("[emailFacts.routes] coaching rollup failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ── Operator escape hatch — manual sweep run (ADMIN ONLY) ────────────────
  app.post("/api/admin/email-facts/run-sweeps", async (req, res) => {
    try {
      const u = getUser(req);
      if (!u?.organizationId) return res.status(401).json({ error: "unauthorized" });
      if (!isAdmin(u.role)) return res.status(403).json({ error: "admin_only" });
      // Run async — the operator doesn't wait for cross-org work.
      void runEmailFactsSweepsOnce();
      res.json({ ok: true, queued: true });
    } catch (err) {
      console.error("[emailFacts.routes] manual sweep failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  });
}
