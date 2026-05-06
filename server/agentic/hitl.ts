/**
 * HITL (Human-In-The-Loop) inbox for staged actions.
 *
 * Workflow agents stage their proposed actions here when autonomy = draft or
 * auto_hitl. Humans approve/reject/edit; the outcome is recorded for the
 * learning loop and (on approve) the action is executed via the adapter layer.
 */
import { db } from "../storage";
import { hitlActions, type InsertHitlAction, type HitlAction } from "@shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";

export type HitlStatus = "pending" | "approved" | "rejected" | "edited" | "expired" | "executed" | "failed";

export async function stageHitlAction(input: InsertHitlAction): Promise<HitlAction> {
  const [row] = await db.insert(hitlActions).values(input).returning();
  return row;
}

export async function listInbox(orgId: string, opts: { status?: HitlStatus[]; userId?: string; podId?: string; limit?: number } = {}) {
  const conds = [eq(hitlActions.organizationId, orgId)];
  if (opts.status?.length) conds.push(inArray(hitlActions.status, opts.status));
  if (opts.userId) conds.push(eq(hitlActions.routedToUserId, opts.userId));
  if (opts.podId) conds.push(eq(hitlActions.podId, opts.podId));
  return db.select().from(hitlActions).where(and(...conds)).orderBy(desc(hitlActions.createdAt)).limit(opts.limit ?? 100);
}

export async function decide(args: {
  id: string;
  organizationId: string;
  decidedByUserId: string;
  decision: "approved" | "rejected" | "edited";
  decisionNote?: string;
  payloadOverride?: Record<string, unknown>;
}) {
  const updates: Partial<HitlAction> = {
    status: args.decision,
    decidedByUserId: args.decidedByUserId,
    decisionNote: args.decisionNote ?? null,
    decidedAt: new Date(),
  };
  if (args.decision === "edited" && args.payloadOverride) {
    updates.payload = args.payloadOverride;
  }
  const [row] = await db.update(hitlActions)
    .set(updates as any)
    .where(and(eq(hitlActions.id, args.id), eq(hitlActions.organizationId, args.organizationId)))
    .returning();
  return row;
}

export async function markExecuted(id: string, ok: boolean, note?: string) {
  const [row] = await db.update(hitlActions).set({
    status: ok ? "executed" : "failed",
    decisionNote: note ?? null,
  } as any).where(eq(hitlActions.id, id)).returning();
  return row;
}

export async function inboxCounts(orgId: string) {
  const rows = await db.select().from(hitlActions).where(eq(hitlActions.organizationId, orgId));
  const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, edited: 0, executed: 0, failed: 0, expired: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}
