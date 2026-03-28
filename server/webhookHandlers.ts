import { getStripeSync, getUncachableStripeClient } from './stripeClient';
import { storage } from './storage';

interface StripeEventObject {
  id?: string;
  customer?: string;
  subscription?: string;
  status?: string;
}

interface StripeEvent {
  type: string;
  data: { object: StripeEventObject };
}

/**
 * Derive org billing fields from a live Stripe subscription and persist them.
 */
async function syncSubscriptionToOrg(customerId: string, subscriptionId: string): Promise<void> {
  const org = await storage.getOrganizationByStripeCustomerId(customerId);
  if (!org) return;

  const stripe = await getUncachableStripeClient();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);

  let planName = org.planName ?? "Freight DNA Subscription";
  const priceItem = sub.items.data[0];
  if (priceItem?.price?.id) {
    const price = await stripe.prices.retrieve(priceItem.price.id, { expand: ["product"] });
    const product = price.product as { name?: string } | null;
    if (product && typeof product === "object" && "name" in product && product.name) {
      planName = product.name;
    }
  }

  // In Stripe API v2025+, current_period_end lives on the subscription item, not the root
  const itemPeriodEnd = sub.items.data[0]?.current_period_end;
  const periodEnd = itemPeriodEnd ? new Date(itemPeriodEnd * 1000) : null;

  let billingStatus: string;
  switch (sub.status) {
    case "active":
    case "trialing":
      billingStatus = "active";
      break;
    case "past_due":
      billingStatus = "past_due";
      break;
    case "canceled":
    case "unpaid":
    case "paused":
      billingStatus = "cancelled";
      break;
    default:
      billingStatus = "pending";
  }

  await storage.updateOrganizationBilling(org.id, {
    stripeSubscriptionId: subscriptionId,
    billingStatus,
    planName,
    currentPeriodEnd: periodEnd,
  });

  console.log(`[webhook] Synced subscription ${subscriptionId} → org "${org.name}" (${billingStatus})`);
}

/**
 * Derive plan name from a Stripe price/product lookup.
 */
async function resolvePlanName(priceId: string): Promise<string> {
  try {
    const stripe = await getUncachableStripeClient();
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    const product = price.product as { name?: string } | null;
    if (product && typeof product === "object" && "name" in product && product.name) {
      return product.name;
    }
  } catch {
    // Fall through to default
  }
  return "Freight DNA Subscription";
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'Received type: ' + typeof payload + '. ' +
        'This usually means express.json() parsed the body before reaching this handler. ' +
        'FIX: Ensure webhook route is registered BEFORE app.use(express.json()).'
      );
    }

    // Let stripe-replit-sync persist the raw Stripe objects to the stripe.* schema
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // Parse the raw payload — signature already verified by stripe-replit-sync above
    let event: StripeEvent;
    try {
      event = JSON.parse(payload.toString("utf8")) as StripeEvent;
    } catch {
      return; // Malformed payload
    }

    const obj = event.data.object;

    switch (event.type) {
        case "checkout.session.completed": {
          // This is the primary trigger for org provisioning.
          // We create the org here (webhook) — this fires even if the buyer
          // closes the tab before reaching the success redirect URL.
          const customerId = typeof obj.customer === "string" ? obj.customer : null;
          const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
          if (!customerId) break;

          let org = await storage.getOrganizationByStripeCustomerId(customerId);

          if (!org) {
            // Pull company name / email from session metadata (set at checkout creation time)
            // The raw Stripe event includes metadata on the session object
            const companyName = (obj as Record<string, unknown>).metadata
              ? ((obj as Record<string, Record<string, string>>).metadata.companyName || "New Organization")
              : "New Organization";

            const slug = companyName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/(^-|-$)/g, "")
              .slice(0, 60);
            const uniqueSlug = `${slug}-${Date.now().toString(36)}`;

            org = await storage.createOrganization({ name: companyName, slug: uniqueSlug });
            console.log(`[webhook] Provisioned new org "${companyName}" (${org.id}) for customer ${customerId}`);
          }

          // Link the Stripe customer to this org
          let planName = "Freight DNA Subscription";
          let periodEnd: Date | null = null;

          if (subscriptionId) {
            const stripe = await getUncachableStripeClient();
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            const priceId = sub.items.data[0]?.price?.id;
            if (priceId) planName = await resolvePlanName(priceId);
            // In Stripe API v2025+, current_period_end is on the subscription item
            const itemEnd = sub.items.data[0]?.current_period_end;
            periodEnd = itemEnd ? new Date(itemEnd * 1000) : null;
          }

          await storage.updateOrganizationBilling(org.id, {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            billingStatus: "active",
            planName,
            currentPeriodEnd: periodEnd,
          });
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const customerId = typeof obj.customer === "string" ? obj.customer : null;
          const subscriptionId = typeof obj.id === "string" ? obj.id : null;
          if (customerId && subscriptionId) {
            await syncSubscriptionToOrg(customerId, subscriptionId);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const customerId = typeof obj.customer === "string" ? obj.customer : null;
          if (customerId) {
            const org = await storage.getOrganizationByStripeCustomerId(customerId);
            if (org) {
              await storage.updateOrganizationBilling(org.id, {
                billingStatus: "cancelled",
                stripeSubscriptionId: null,
                currentPeriodEnd: null,
              });
              console.log(`[webhook] Subscription cancelled → org "${org.name}"`);
            }
          }
          break;
        }

        case "invoice.payment_succeeded": {
          const customerId = typeof obj.customer === "string" ? obj.customer : null;
          const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
          if (customerId && subscriptionId) {
            await syncSubscriptionToOrg(customerId, subscriptionId);
          }
          break;
        }

        case "invoice.payment_failed": {
          const customerId = typeof obj.customer === "string" ? obj.customer : null;
          if (customerId) {
            const org = await storage.getOrganizationByStripeCustomerId(customerId);
            if (org) {
              await storage.updateOrganizationBilling(org.id, { billingStatus: "past_due" });
              console.log(`[webhook] Invoice payment failed → org "${org.name}" marked past_due`);
            }
          }
          break;
        }

        default:
          break;
    }
    // Errors propagate to the caller; the HTTP handler returns 500 so Stripe retries
  }
}
