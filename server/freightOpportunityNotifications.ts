/**
 * Freight Opportunity Notifications (task #356)
 *
 * Fires in-app notifications when an Available Freight opportunity is
 * delegated to a rep, or approved by a manager (unblocking the Send action
 * for the owner / delegate).
 *
 * Notification copy includes the customer (company name) + lane
 * (origin → destination) so the recipient can act without opening the page
 * first. All links deep-link into /available-freight/:id.
 */

import type { IStorage } from "./storage";
import type { FreightOpportunity } from "@shared/schema";

function formatLane(opp: Pick<FreightOpportunity, "origin" | "originState" | "destination" | "destinationState">): string {
  const o = opp.originState ? `${opp.origin}, ${opp.originState}` : opp.origin;
  const d = opp.destinationState ? `${opp.destination}, ${opp.destinationState}` : opp.destination;
  return `${o} → ${d}`;
}

async function customerLabel(storage: IStorage, companyId: string): Promise<string> {
  try {
    const company = await storage.getCompany(companyId);
    return company?.name ?? "Customer";
  } catch {
    return "Customer";
  }
}

/**
 * Fire when an opportunity is (re)delegated. Notifies the new delegate so
 * they can pick it up. Skips when the delegate is the actor (e.g. a rep
 * reassigning to themselves) or when delegation was cleared.
 */
export async function notifyFreightDelegated(params: {
  storage: IStorage;
  opportunity: FreightOpportunity;
  newDelegateUserId: string | null;
  actorUserId: string;
  actorName?: string | null;
}): Promise<void> {
  const { storage, opportunity, newDelegateUserId, actorUserId, actorName } = params;
  if (!newDelegateUserId) return;
  if (newDelegateUserId === actorUserId) return;

  try {
    const customer = await customerLabel(storage, opportunity.companyId);
    const lane = formatLane(opportunity);
    const who = actorName?.trim() || "A teammate";
    await storage.createNotification({
      userId:    newDelegateUserId,
      type:      "freight_delegated",
      title:     `${who} delegated freight to you — ${customer}`,
      body:      `${customer} · ${lane}. Open Available Freight to review and send.`,
      link:      `/available-freight/${opportunity.id}`,
      relatedId: opportunity.id,
      read:      false,
    });
  } catch (err) {
    console.error("[freightOpportunityNotifications] delegate notify failed:", err);
  }
}

/**
 * Fire when a manager approves an opportunity. Notifies the delegate (if
 * any) otherwise the owner so they know they can now Send. Skips when the
 * recipient is the approver themselves.
 */
export async function notifyFreightApproved(params: {
  storage: IStorage;
  opportunity: FreightOpportunity;
  approverUserId: string;
  approverName?: string | null;
}): Promise<void> {
  const { storage, opportunity, approverUserId, approverName } = params;
  const recipientId = opportunity.delegatedToUserId ?? opportunity.ownerUserId;
  if (!recipientId) return;
  if (recipientId === approverUserId) return;

  try {
    const customer = await customerLabel(storage, opportunity.companyId);
    const lane = formatLane(opportunity);
    const who = approverName?.trim() || "Your manager";
    await storage.createNotification({
      userId:    recipientId,
      type:      "freight_approved",
      title:     `Approved — you can send ${customer}`,
      body:      `${who} approved ${customer} · ${lane}. You're clear to Send from Available Freight.`,
      link:      `/available-freight/${opportunity.id}`,
      relatedId: opportunity.id,
      read:      false,
    });
  } catch (err) {
    console.error("[freightOpportunityNotifications] approve notify failed:", err);
  }
}
