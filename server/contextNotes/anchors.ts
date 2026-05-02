// Task #950 — Context Notes anchor registry.
//
// A "context note" can attach to many different workflow objects (quote,
// conversation, lane, load, customer, carrier, available-freight item). We
// deliberately do NOT introduce a parallel ACL: each anchor type registers
// (1) how to check that a user can see the underlying object, (2) how to
// label it for inbox rows, (3) where to deep-link the rep so the bell can
// take them straight to the relevant surface with the panel open, and (4)
// what extra payload to capture on note creation so inbox rows render a
// meaningful preview without re-fetching the anchor.
//
// New anchor types: add a row here and the rest of the system (routes,
// notifications, inbox) picks them up automatically.

import { and, eq } from "drizzle-orm";
import type { User } from "@shared/schema";
import {
  contextNoteAnchorTypes,
  emailConversationThreads,
  quoteOpportunities,
  quoteCustomers,
  recurringLanes,
  type ContextNoteAnchorType,
} from "@shared/schema";
import { db, storage } from "../storage";
import { canAccessCompany, canSeeRepUser, getVisibleRepUserIds } from "../auth";

export interface AnchorContext {
  /** Optional inferred company id, used by convert-to-task. */
  companyId?: string | null;
  /** Optional inferred opportunity id (quote anchors), used by convert-to-task. */
  opportunityId?: number | null;
  /** Optional inferred lane payload, used by convert-to-task. */
  laneContext?: Record<string, unknown> | null;
}

export interface AnchorDefinition {
  type: ContextNoteAnchorType;
  /** Permission delegation — reuse the anchor's own access check. */
  canAccess: (user: User, anchorId: string) => Promise<boolean>;
  /** Human-readable label snapshot for inbox rows. May be slow → cached on note row. */
  label: (anchorId: string, orgId: string) => Promise<string | null>;
  /** Optional extra payload (lane string, customer name, etc.) cached on the note row. */
  routePayload?: (anchorId: string, orgId: string) => Promise<Record<string, unknown> | null>;
  /** Deep link rendered for notification + inbox click-throughs. */
  deepLink: (anchorId: string) => string | null;
  /** Lift extra context out of the anchor for convert-to-task. */
  buildTaskContext?: (anchorId: string, orgId: string) => Promise<AnchorContext>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const sameOrg = (user: User, orgId: string | null | undefined) =>
  !!orgId && user.organizationId === orgId;

async function loadQuoteOpportunity(anchorId: string) {
  const [row] = await db
    .select({
      id: quoteOpportunities.id,
      organizationId: quoteOpportunities.organizationId,
      customerId: quoteOpportunities.customerId,
      originCity: quoteOpportunities.originCity,
      originState: quoteOpportunities.originState,
      destCity: quoteOpportunities.destCity,
      destState: quoteOpportunities.destState,
      customerName: quoteCustomers.name,
    })
    .from(quoteOpportunities)
    .leftJoin(quoteCustomers, eq(quoteCustomers.id, quoteOpportunities.customerId))
    .where(eq(quoteOpportunities.id, anchorId))
    .limit(1);
  return row ?? null;
}

async function loadConversationThread(anchorId: string) {
  const row = await storage.getEmailConversationThreadById(anchorId).catch(() => undefined);
  return row ?? null;
}

async function loadRecurringLane(anchorId: string) {
  const [row] = await db
    .select({
      id: recurringLanes.id,
      orgId: recurringLanes.orgId,
      ownerUserId: recurringLanes.ownerUserId,
      origin: recurringLanes.origin,
      originState: recurringLanes.originState,
      destination: recurringLanes.destination,
      destinationState: recurringLanes.destinationState,
    })
    .from(recurringLanes)
    .where(eq(recurringLanes.id, anchorId))
    .limit(1);
  return row ?? null;
}

// ── Per-anchor definitions ────────────────────────────────────────────────

const quoteRequestAnchor: AnchorDefinition = {
  type: "quote_request",
  async canAccess(user, anchorId) {
    const opp = await loadQuoteOpportunity(anchorId).catch(() => null);
    if (!opp) return false;
    return sameOrg(user, opp.organizationId);
  },
  async label(anchorId) {
    const opp = await loadQuoteOpportunity(anchorId).catch(() => null);
    if (!opp) return null;
    const lane = `${opp.originCity}, ${opp.originState} → ${opp.destCity}, ${opp.destState}`;
    return opp.customerName ? `${opp.customerName} · ${lane}` : `Quote · ${lane}`;
  },
  async routePayload(anchorId) {
    const opp = await loadQuoteOpportunity(anchorId).catch(() => null);
    if (!opp) return null;
    return {
      customerName: opp.customerName ?? null,
      origin: `${opp.originCity}, ${opp.originState}`,
      dest: `${opp.destCity}, ${opp.destState}`,
    };
  },
  deepLink(anchorId) {
    return `/quote-requests?quote=${encodeURIComponent(anchorId)}`;
  },
  async buildTaskContext() {
    return { companyId: null };
  },
};

// Conversations are visible to: thread owner, the owner's reporting tree
// (managers), admins/sales-directors, and reps assigned to the linked
// account when the thread is unowned. Mirrors `canAccessThread` in
// server/routes/conversations.ts so the two views can never disagree.
const conversationAnchor: AnchorDefinition = {
  type: "conversation",
  async canAccess(user, anchorId) {
    const thread = await loadConversationThread(anchorId);
    if (!thread || thread.orgId !== user.organizationId) return false;
    if (user.role === "admin" || user.role === "sales_director") return true;
    if (thread.ownerUserId && thread.ownerUserId === user.id) return true;
    if (thread.ownerUserId && (await canSeeRepUser(user, thread.ownerUserId))) return true;
    if (!thread.ownerUserId && thread.linkedAccountId) {
      const company = await storage.getCompany(thread.linkedAccountId).catch(() => null);
      if (company?.salesPersonId && (await canSeeRepUser(user, company.salesPersonId))) return true;
    }
    return false;
  },
  async label(anchorId) {
    const thread = await loadConversationThread(anchorId);
    if (!thread) return null;
    return `Email thread · ${thread.threadId.slice(0, 12)}…`;
  },
  async routePayload(anchorId) {
    const thread = await loadConversationThread(anchorId);
    if (!thread) return null;
    return {
      threadId: thread.threadId,
      ownerUserId: thread.ownerUserId ?? null,
      linkedAccountId: thread.linkedAccountId ?? null,
    };
  },
  deepLink(anchorId) {
    return `/conversations?thread=${encodeURIComponent(anchorId)}`;
  },
};

// Available Freight is the org-wide carrier sales board: every rep in the
// org can see every row by design (it's the public marketplace). We still
// require the user be in *some* org so anonymous/unauth callers can't post
// notes.
const availableFreightAnchor: AnchorDefinition = {
  type: "available_freight",
  async canAccess(user) {
    return !!user.organizationId;
  },
  async label(anchorId) {
    return `Available Freight · ${anchorId}`;
  },
  async routePayload(anchorId) {
    return { source: "available_freight", boardId: anchorId };
  },
  deepLink(anchorId) {
    return `/available-freight?lane=${encodeURIComponent(anchorId)}`;
  },
  async buildTaskContext(anchorId) {
    return { laneContext: { source: "available_freight", anchorId } };
  },
};

// Lane Work Queue rows are recurring lanes; rep-scoped via ownerUserId.
// Unowned (eligible/unassigned) lanes are visible to anyone who'd see the
// unassigned bucket on the LWQ page (admin / managers in the same org).
const lwqAnchor: AnchorDefinition = {
  type: "lane_work_queue",
  async canAccess(user, anchorId) {
    const lane = await loadRecurringLane(anchorId).catch(() => null);
    if (!lane || lane.orgId !== user.organizationId) return false;
    if (user.role === "admin" || user.role === "sales_director") return true;
    if (!lane.ownerUserId) {
      // Unassigned bucket → visible to managers & admins; reps cannot post
      // notes on lanes that haven't been claimed.
      return user.role === "director" || user.role === "national_account_manager"
        || user.role === "logistics_manager" || user.role === "sales";
    }
    if (lane.ownerUserId === user.id) return true;
    return await canSeeRepUser(user, lane.ownerUserId);
  },
  async label(anchorId) {
    const lane = await loadRecurringLane(anchorId).catch(() => null);
    if (!lane) return null;
    const o = lane.originState ? `${lane.origin}, ${lane.originState}` : lane.origin;
    const d = lane.destinationState ? `${lane.destination}, ${lane.destinationState}` : lane.destination;
    return `LWQ · ${o} → ${d}`;
  },
  async routePayload(anchorId) {
    const lane = await loadRecurringLane(anchorId).catch(() => null);
    if (!lane) return null;
    return {
      origin: lane.originState ? `${lane.origin}, ${lane.originState}` : lane.origin,
      dest: lane.destinationState ? `${lane.destination}, ${lane.destinationState}` : lane.destination,
      ownerUserId: lane.ownerUserId ?? null,
    };
  },
  deepLink(anchorId) {
    // Route is `/lanes/work-queue` (see client/src/App.tsx) and the page
    // auto-opens a row when `?laneId=` is present (see lane-work-queue.tsx
    // — "Auto-open a specific lane when ?laneId=... is in the URL").
    return `/lanes/work-queue?laneId=${encodeURIComponent(anchorId)}`;
  },
  async buildTaskContext(anchorId) {
    const lane = await loadRecurringLane(anchorId).catch(() => null);
    return {
      laneContext: lane ? {
        source: "lane_work_queue",
        anchorId,
        origin: lane.originState ? `${lane.origin}, ${lane.originState}` : lane.origin,
        dest: lane.destinationState ? `${lane.destination}, ${lane.destinationState}` : lane.destination,
      } : { source: "lane_work_queue", anchorId },
    };
  },
};

const customerAnchor: AnchorDefinition = {
  type: "customer",
  async canAccess(user, anchorId) {
    return canAccessCompany(user, anchorId);
  },
  async label(anchorId) {
    const c = await storage.getCompany(anchorId).catch(() => null);
    return c ? c.name : null;
  },
  async routePayload(anchorId) {
    const c = await storage.getCompany(anchorId).catch(() => null);
    if (!c) return null;
    return { name: c.name, salesPersonId: c.salesPersonId ?? null };
  },
  deepLink(anchorId) {
    return `/companies/${encodeURIComponent(anchorId)}`;
  },
  async buildTaskContext(anchorId) {
    return { companyId: anchorId };
  },
};

type CarrierLike = { name?: string | null; carrierName?: string | null; mc?: string | null };

const carrierAnchor: AnchorDefinition = {
  type: "carrier",
  async canAccess(user, anchorId) {
    const carrier = await storage.getCarrierInOrg(anchorId, user.organizationId).catch(() => null);
    return !!carrier;
  },
  async label(anchorId) {
    const c = (await storage.getCarrier(anchorId).catch(() => null)) as CarrierLike | null;
    return c ? (c.name ?? c.carrierName ?? null) : null;
  },
  async routePayload(anchorId) {
    const c = (await storage.getCarrier(anchorId).catch(() => null)) as CarrierLike | null;
    if (!c) return null;
    return { name: c.name ?? c.carrierName ?? null, mc: c.mc ?? null };
  },
  deepLink(anchorId) {
    // Route is `/carrier-hub` (see client/src/App.tsx) and the page
    // auto-opens a carrier drawer when `?carrierId=` is in the URL
    // (carrier-hub.tsx — "Auto-open a carrier profile when ?carrierId=...").
    return `/carrier-hub?carrierId=${encodeURIComponent(anchorId)}`;
  },
};

// No canonical load-detail route in v1 — and no per-load ACL exists. To
// avoid leaking note existence for arbitrary load IDs, we restrict load
// notes to roles that already see all loads org-wide (admin / sales
// director / managers). v1.1 will add /loads/:id and a real visibility
// check.
const loadAnchor: AnchorDefinition = {
  type: "load",
  async canAccess(user) {
    if (!user.organizationId) return false;
    return user.role === "admin"
      || user.role === "sales_director"
      || user.role === "director"
      || user.role === "national_account_manager"
      || user.role === "logistics_manager";
  },
  async label(anchorId) {
    return `Load ${anchorId}`;
  },
  async routePayload() {
    return null;
  },
  deepLink() {
    return null;
  },
};

const REGISTRY: Record<ContextNoteAnchorType, AnchorDefinition> = {
  quote_request: quoteRequestAnchor,
  conversation: conversationAnchor,
  available_freight: availableFreightAnchor,
  lane_work_queue: lwqAnchor,
  customer: customerAnchor,
  carrier: carrierAnchor,
  load: loadAnchor,
};

export function getAnchorDefinition(type: string): AnchorDefinition | null {
  if (!(contextNoteAnchorTypes as readonly string[]).includes(type)) return null;
  return REGISTRY[type as ContextNoteAnchorType] ?? null;
}

export function listAnchorTypes(): readonly ContextNoteAnchorType[] {
  return contextNoteAnchorTypes;
}

export async function canUserAccessAnchor(
  user: User,
  type: string,
  anchorId: string,
): Promise<boolean> {
  const def = getAnchorDefinition(type);
  if (!def) return false;
  try {
    return await def.canAccess(user, anchorId);
  } catch {
    return false;
  }
}

export async function snapshotAnchorLabel(
  type: string,
  anchorId: string,
  orgId: string,
): Promise<string | null> {
  const def = getAnchorDefinition(type);
  if (!def) return null;
  try {
    return await def.label(anchorId, orgId);
  } catch {
    return null;
  }
}

export async function snapshotAnchorRoutePayload(
  type: string,
  anchorId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  const def = getAnchorDefinition(type);
  if (!def?.routePayload) return null;
  try {
    return await def.routePayload(anchorId, orgId);
  } catch {
    return null;
  }
}

export function anchorDeepLink(type: string, anchorId: string): string | null {
  const def = getAnchorDefinition(type);
  if (!def) return null;
  return def.deepLink(anchorId);
}

export function anchorDeepLinkWithReveal(
  type: string,
  anchorId: string,
  noteId: string,
): string | null {
  const base = anchorDeepLink(type, anchorId);
  if (!base) return null;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}contextNote=${encodeURIComponent(noteId)}`;
}

export async function buildTaskContextForAnchor(
  type: string,
  anchorId: string,
  orgId: string,
): Promise<AnchorContext> {
  const def = getAnchorDefinition(type);
  if (!def?.buildTaskContext) return {};
  try {
    return await def.buildTaskContext(anchorId, orgId);
  } catch {
    return {};
  }
}

export { getVisibleRepUserIds };
