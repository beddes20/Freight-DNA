// Capacity Matches API (Task #844) — Available Freight tab.

import type { Express, Request, Response } from "express";
import { z } from "zod";
import multer from "multer";
import { storage } from "../storage";
import { requireAuth, requireUser, getCurrentUser } from "../auth";
import { qOptStr, qInt, pStr } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import {
  insertTruckPostingSchema,
  TRUCK_LOAD_MATCH_STATES,
  type TruckLoadMatchState,
} from "@shared/schema";
import { matchPosting, matchPostingsBatch, rematchAllForOrg } from "../truckLoadMatchingService";
import { parseAttachment } from "../truckListParser";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const STATE_VALUES = TRUCK_LOAD_MATCH_STATES as unknown as readonly TruckLoadMatchState[];

const stateChangeSchema = z.object({
  state: z.enum(STATE_VALUES as unknown as [TruckLoadMatchState, ...TruckLoadMatchState[]]),
  dismissedReason: z.string().max(500).optional(),
});

const manualPostingSchema = insertTruckPostingSchema
  .omit({ orgId: true, source: true, status: true })
  .extend({
    availableDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    availableThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  });

const TEAM_ROLES = new Set([
  "admin",
  "director",
  "national_account_manager",
  "logistics_manager",
  "logistics_coordinator",
  "sales_director",
]);

const ADMIN_ROLES = new Set(["admin", "director"]);

export function registerCapacityMatchesRoutes(app: Express): void {
  app.use("/api/capacity-matches", requireAuth);

  // GET /api/capacity-matches?scope=mine|team&states=...&minScore=N&limit=N
  app.get("/api/capacity-matches", requireUser, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthenticated" });
      const scope = (qOptStr(req.query.scope) ?? "auto").toLowerCase();
      const teamCapable = TEAM_ROLES.has(user.role ?? "");
      const wantsTeam = (scope === "team" && teamCapable) || (scope === "auto" && teamCapable);

      const statesRaw = qOptStr(req.query.states);
      const requested = (statesRaw ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(s => (STATE_VALUES as readonly string[]).includes(s)) as TruckLoadMatchState[];
      const states: TruckLoadMatchState[] = requested.length > 0 ? requested : ["new", "contacted"];

      const minScore = qInt(req.query.minScore, 0);
      const limit = qInt(req.query.limit, 250);
      const equipmentFilter = (qOptStr(req.query.equipment) ?? "").trim().toLowerCase();
      const originFilter = (qOptStr(req.query.origin) ?? "").trim().toLowerCase();

      const matches = await storage.listTruckLoadMatchesByOrg(user.organizationId, {
        states,
        assignedRepIds: wantsTeam ? undefined : [user.id],
        minScore: minScore > 0 ? minScore : undefined,
        limit,
      });

      // Side-load posting + opportunity for each match. Small N (<= 250) so
      // serial fetches are fine; the storage interface deliberately exposes
      // single-row getters to keep auth/scoping consistent.
      const withDetails = await Promise.all(matches.map(async m => {
        const [posting, opp] = await Promise.all([
          storage.getTruckPosting(m.truckPostingId),
          storage.getFreightOpportunity(user.organizationId, m.freightOpportunityId),
        ]);
        return { match: m, posting, opportunity: opp };
      }));

      let filtered = withDetails.filter(r => r.posting && r.opportunity && r.opportunity.orgId === user.organizationId);
      // Equipment filter — substring match on either side (carrier truck or
      // load equipment) so "reefer" matches "Reefer 53"/"Reefer Step Deck".
      if (equipmentFilter) {
        filtered = filtered.filter(r => {
          const truck = (r.posting?.equipment ?? "").toLowerCase();
          const load = (r.opportunity?.equipmentType ?? "").toLowerCase();
          return truck.includes(equipmentFilter) || load.includes(equipmentFilter);
        });
      }
      // Origin region filter — matches state code OR city substring on the
      // truck posting (capacity supply side).
      if (originFilter) {
        filtered = filtered.filter(r => {
          const state = (r.posting?.originState ?? "").toLowerCase();
          const city = (r.posting?.originCity ?? "").toLowerCase();
          return state === originFilter || city.includes(originFilter);
        });
      }

      const teamCounts = wantsTeam
        ? await storage.countTruckLoadMatchesByRep(user.organizationId, { states: ["new", "contacted"] })
        : [];

      res.json({
        scope: wantsTeam ? "team" : "mine",
        teamCapable,
        items: filtered,
        teamRollup: teamCounts,
      });
    } catch (err) {
      console.error("[capacityMatches:list] error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // GET /api/capacity-matches/postings — recent truck postings for visibility.
  app.get("/api/capacity-matches/postings", requireUser, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthenticated" });
      const status = qOptStr(req.query.status);
      const items = await storage.listTruckPostingsByOrg(user.organizationId, { status, limit: 100 });
      res.json({ items });
    } catch (err) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // PATCH /api/capacity-matches/:id — state change (booked/contacted/dismissed)
  app.patch("/api/capacity-matches/:id", requireUser, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthenticated" });
      const id = pStr(req.params.id);
      const parsed = stateChangeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

      const existing = await storage.getTruckLoadMatch(id);
      if (!existing || existing.orgId !== user.organizationId) return res.status(404).json({ error: "not_found" });

      const isAdmin = ADMIN_ROLES.has(user.role ?? "");
      const isAssigned = existing.assignedRepId === user.id;
      const opp = await storage.getFreightOpportunity(user.organizationId, existing.freightOpportunityId);
      const isOwner = !!opp && (opp.ownerUserId === user.id || opp.delegatedToUserId === user.id || opp.createdById === user.id);
      if (!isAdmin && !isAssigned && !isOwner) return res.status(403).json({ error: "forbidden" });

      const updated = await storage.updateTruckLoadMatchState(id, {
        state: parsed.data.state,
        actorUserId: user.id,
        dismissedReason: parsed.data.dismissedReason ?? null,
      });
      res.json({ match: updated });
    } catch (err) {
      console.error("[capacityMatches:patch] error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // POST /api/capacity-matches/postings/manual — single posting for phone-call capacity.
  app.post("/api/capacity-matches/postings/manual", requireUser, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthenticated" });
      const parsed = manualPostingSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });

      const [posting] = await storage.insertTruckPostings([{
        ...parsed.data,
        orgId: user.organizationId,
        source: "manual",
        status: "active",
      }]);
      const result = await matchPosting(posting, { notify: true });
      res.status(201).json({ posting, ...result });
    } catch (err) {
      console.error("[capacityMatches:manualPosting] error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // POST /api/capacity-matches/postings/upload — xlsx/csv attachment ingestion.
  app.post(
    "/api/capacity-matches/postings/upload",
    requireUser,
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "unauthenticated" });
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) return res.status(400).json({ error: "missing_file" });
        const filename = file.originalname || "upload";
        const ext = filename.toLowerCase().split(".").pop() ?? "";
        if (!["xlsx", "xls", "csv"].includes(ext)) {
          return res.status(400).json({ error: "unsupported_extension", allowed: ["xlsx", "xls", "csv"] });
        }
        const carrierNameRaw = qOptStr(req.body?.carrierName) ?? null;
        const carrierIdRaw = qOptStr(req.body?.carrierId) ?? null;
        const rows = parseAttachment(file.buffer, filename);
        if (rows.length === 0) return res.status(422).json({ error: "no_rows_parsed" });
        const source = ext === "csv" ? "email_attachment_csv" : "email_attachment_xlsx";
        const persisted = await storage.insertTruckPostings(rows.map(r => ({
          orgId: user.organizationId,
          carrierId: carrierIdRaw,
          carrierNameRaw,
          source,
          attachmentName: filename,
          originCity: r.originCity,
          originState: r.originState,
          destCity: r.destCity,
          destState: r.destState,
          destPreference: r.destPreference,
          availableDate: r.availableDate,
          availableThrough: r.availableThrough,
          equipment: r.equipment,
          rateAsk: r.rateAsk,
          notes: r.notes,
          rawText: r.rawText,
          status: "active" as const,
        })));
        const result = await matchPostingsBatch(persisted, { notify: true, source: "upload" });
        res.status(201).json({ postings: persisted.length, ...result });
      } catch (err) {
        console.error("[capacityMatches:upload] error:", err);
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // GET /api/capacity-matches/stats — org-scoped pipeline counters surfaced
  // on the Capacity Matches page header. Available to any authenticated
  // user in the org (read-only summary; no PII or per-rep data).
  app.get("/api/capacity-matches/stats", requireUser, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthenticated" });
      const stats = await storage.getTruckLoadMatchStats(user.organizationId);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // POST /api/capacity-matches/rematch — admin-only org-wide rematch.
  app.post("/api/capacity-matches/rematch", requireUser, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "unauthenticated" });
      if (!ADMIN_ROLES.has(user.role ?? "")) return res.status(403).json({ error: "forbidden" });
      const result = await rematchAllForOrg(user.organizationId, { notify: false });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
