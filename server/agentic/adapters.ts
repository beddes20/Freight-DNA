/**
 * Adapter layer for the Agentic Brokerage Program.
 *
 * Every external system the workflow agents touch goes through an adapter that
 * has both a real implementation and a deterministic dry-run implementation.
 * The active mode is per-org and controlled via `adapter_status.mode`.
 *
 * Live implementations are stubs at this point — they return a structured
 * "credentials_missing" result so the Rollout view can flag the readiness gap.
 * Dry-run implementations always succeed and return predictable shapes so the
 * agents can run end-to-end without external dependencies.
 */
import { db } from "../storage";
import { adapterStatus } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export type AdapterKey =
  | "dat" | "truckstop" | "sonar"
  | "highway" | "carrier411"
  | "valuetms" | "edi"
  | "graph_mail" | "twilio"
  | "customer_portal" | "payment_portal";

export const ALL_ADAPTERS: AdapterKey[] = [
  "dat", "truckstop", "sonar",
  "highway", "carrier411",
  "valuetms", "edi",
  "graph_mail", "twilio",
  "customer_portal", "payment_portal",
];

export const ADAPTER_LABELS: Record<AdapterKey, string> = {
  dat: "DAT (rates)",
  truckstop: "Truckstop (rates)",
  sonar: "FreightWaves SONAR",
  highway: "Highway (carrier vetting)",
  carrier411: "Carrier411",
  valuetms: "ValueTMS (load build/update)",
  edi: "EDI (tender)",
  graph_mail: "Microsoft Graph (mail)",
  twilio: "Twilio (SMS/voice)",
  customer_portal: "Customer portal submission",
  payment_portal: "Payment / dunning portal",
};

export type AdapterMode = "dry_run" | "live";

export interface AdapterResult<T = unknown> {
  ok: boolean;
  mode: AdapterMode;
  data?: T;
  error?: string;
  /** True when live mode was requested but credentials are not configured. */
  credentialsMissing?: boolean;
}

async function getMode(orgId: string, key: AdapterKey): Promise<AdapterMode> {
  const [row] = await db.select().from(adapterStatus)
    .where(and(eq(adapterStatus.organizationId, orgId), eq(adapterStatus.adapterKey, key)))
    .limit(1);
  return (row?.mode as AdapterMode) ?? "dry_run";
}

/** Stable seed → small int for deterministic dry-run outputs. */
function seedHash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ─── Adapter call shapes ──────────────────────────────────────────────────

export interface RateSnapshot {
  origin: string;
  destination: string;
  equipment: string;
  spotLow: number; spotMid: number; spotHigh: number;
  contractMid: number;
  source: string;
}

export interface CarrierVetting {
  mcNumber: string | null;
  authorityActive: boolean;
  insuranceCompliant: boolean;
  riskScore: number; // 0–100, higher = riskier
  flags: string[];
  source: string;
}

export interface MailSendPayload { to: string; subject: string; html: string; cc?: string[]; }
export interface SmsSendPayload { to: string; body: string; }
export interface TmsLoadShellPayload {
  customerCompanyId: string; origin: string; destination: string;
  equipment: string; pickupAt: string; deliveryAt: string;
  rate: number; reference: string;
}
export interface TenderAcceptPayload { tenderRef: string; shipperId: string; }
export interface PortalSubmitPayload { customerCompanyId: string; portal: string; docs: string[]; payload: Record<string, unknown>; }

// ─── Dispatchers ─────────────────────────────────────────────────────────

export const adapters = {
  async fetchRates(orgId: string, args: { origin: string; destination: string; equipment: string }): Promise<AdapterResult<RateSnapshot>> {
    const mode = await getMode(orgId, "dat");
    if (mode === "live") {
      // Live calls would go to DAT/Truckstop/SONAR clients. Not wired here.
      return { ok: false, mode, credentialsMissing: true, error: "Live DAT adapter not yet enabled — flip in Rollout view once API keys are configured." };
    }
    const h = seedHash(`${args.origin}|${args.destination}|${args.equipment}`);
    const mid = 1.6 + ((h % 80) / 100); // $1.60 – $2.40 / mile
    return {
      ok: true,
      mode,
      data: {
        origin: args.origin, destination: args.destination, equipment: args.equipment,
        spotLow: +(mid - 0.18).toFixed(2),
        spotMid: +mid.toFixed(2),
        spotHigh: +(mid + 0.22).toFixed(2),
        contractMid: +(mid - 0.10).toFixed(2),
        source: "dry_run:dat",
      },
    };
  },

  async vetCarrier(orgId: string, args: { mcNumber: string; carrierName: string }): Promise<AdapterResult<CarrierVetting>> {
    const mode = await getMode(orgId, "highway");
    if (mode === "live") {
      return { ok: false, mode, credentialsMissing: true, error: "Live Highway adapter not yet enabled." };
    }
    const h = seedHash(args.mcNumber || args.carrierName);
    const risk = h % 100;
    const flags: string[] = [];
    if (risk > 70) flags.push("recent_authority");
    if (risk > 80) flags.push("phone_mismatch");
    if (risk > 90) flags.push("vin_not_seen_near_pickup");
    return {
      ok: true,
      mode,
      data: {
        mcNumber: args.mcNumber || null,
        authorityActive: risk < 95,
        insuranceCompliant: risk < 90,
        riskScore: risk,
        flags,
        source: "dry_run:highway",
      },
    };
  },

  async sendMail(orgId: string, payload: MailSendPayload): Promise<AdapterResult<{ messageId: string }>> {
    const mode = await getMode(orgId, "graph_mail");
    if (mode === "live") {
      return { ok: false, mode, credentialsMissing: true, error: "Live mail adapter not yet enabled." };
    }
    return { ok: true, mode, data: { messageId: `dry-${Date.now()}-${seedHash(payload.to)}` } };
  },

  async sendSms(orgId: string, payload: SmsSendPayload): Promise<AdapterResult<{ messageId: string }>> {
    const mode = await getMode(orgId, "twilio");
    if (mode === "live") {
      return { ok: false, mode, credentialsMissing: true, error: "Live Twilio adapter not yet enabled." };
    }
    return { ok: true, mode, data: { messageId: `dry-sms-${Date.now()}-${seedHash(payload.to)}` } };
  },

  async createLoadShell(orgId: string, payload: TmsLoadShellPayload): Promise<AdapterResult<{ loadId: string }>> {
    const mode = await getMode(orgId, "valuetms");
    if (mode === "live") {
      return { ok: false, mode, credentialsMissing: true, error: "Live ValueTMS adapter not yet enabled." };
    }
    return { ok: true, mode, data: { loadId: `dry-load-${seedHash(payload.reference)}` } };
  },

  async acceptTender(orgId: string, payload: TenderAcceptPayload): Promise<AdapterResult<{ accepted: true }>> {
    const mode = await getMode(orgId, "edi");
    if (mode === "live") {
      return { ok: false, mode, credentialsMissing: true, error: "Live EDI adapter not yet enabled." };
    }
    return { ok: true, mode, data: { accepted: true } };
  },

  async submitToPortal(orgId: string, payload: PortalSubmitPayload): Promise<AdapterResult<{ submissionId: string }>> {
    const mode = await getMode(orgId, "customer_portal");
    if (mode === "live") {
      return { ok: false, mode, credentialsMissing: true, error: "Live customer portal adapter not yet enabled." };
    }
    return { ok: true, mode, data: { submissionId: `dry-sub-${seedHash(payload.customerCompanyId + payload.portal)}` } };
  },
};

/** Read all adapter modes for an org. */
export async function listAdapterStatuses(orgId: string) {
  const rows = await db.select().from(adapterStatus).where(eq(adapterStatus.organizationId, orgId));
  const byKey = new Map(rows.map((r) => [r.adapterKey, r]));
  return ALL_ADAPTERS.map((key) => {
    const r = byKey.get(key);
    return {
      key,
      label: ADAPTER_LABELS[key],
      mode: (r?.mode as AdapterMode) ?? "dry_run",
      credentialsConfigured: r?.credentialsConfigured ?? false,
      lastCheckedAt: r?.lastCheckedAt ?? null,
      notes: r?.notes ?? null,
      updatedAt: r?.updatedAt ?? null,
    };
  });
}

/** Upsert mode/credentials for an adapter. */
export async function upsertAdapterStatus(args: {
  organizationId: string; adapterKey: AdapterKey;
  mode?: AdapterMode; credentialsConfigured?: boolean; notes?: string;
  updatedBy: string;
}) {
  const [existing] = await db.select().from(adapterStatus)
    .where(and(eq(adapterStatus.organizationId, args.organizationId), eq(adapterStatus.adapterKey, args.adapterKey)))
    .limit(1);
  if (existing) {
    const [row] = await db.update(adapterStatus).set({
      mode: args.mode ?? existing.mode,
      credentialsConfigured: args.credentialsConfigured ?? existing.credentialsConfigured,
      notes: args.notes ?? existing.notes,
      updatedBy: args.updatedBy,
      updatedAt: new Date(),
      lastCheckedAt: new Date(),
    }).where(eq(adapterStatus.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(adapterStatus).values({
    organizationId: args.organizationId,
    adapterKey: args.adapterKey,
    mode: args.mode ?? "dry_run",
    credentialsConfigured: args.credentialsConfigured ?? false,
    notes: args.notes ?? null,
    updatedBy: args.updatedBy,
    lastCheckedAt: new Date(),
  }).returning();
  return row;
}
