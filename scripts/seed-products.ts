import { getUncachableStripeClient } from '../server/stripeClient';

/**
 * Script to create/update Freight DNA products and prices in Stripe.
 * Run with: npx tsx scripts/seed-products.ts
 *
 * This script is idempotent — it checks if products exist before creating them.
 *
 * Pricing strategy:
 *   - Monthly: $1,500/month (introductory — first ~5 customers)
 *   - Annual:  $14,400/year (20% off $1,500 × 12 = $18,000 → saves $3,600)
 *
 * When ready to raise prices to $2,000:
 *   1. Create a new $2,000/month price in Stripe (or re-run this with MONTHLY_PRICE_CENTS=200000)
 *   2. Archive the old $1,500 price (existing subscribers keep their current price)
 *   3. Update ANNUAL_PRICE_CENTS to 1920000 ($19,200 = $2,000 × 12 × 0.8)
 */

const MONTHLY_PRICE_CENTS = 150000;   // $1,500.00/month
const ANNUAL_PRICE_CENTS  = 1440000;  // $14,400.00/year (20% off $1,500 × 12 = $18,000)
const ADDON_PRICE_CENTS   = 500000;   // $5,000.00 one-time (Custom Feature Buildout)

async function createProducts() {
  try {
    const stripe = await getUncachableStripeClient();

    console.log('Seeding Freight DNA products in Stripe...\n');

    // ── Monthly Subscription ────────────────────────────────────────────────────
    const existingProducts = await stripe.products.search({
      query: "name:'Freight DNA Subscription' AND active:'true'"
    });

    let subscriptionProductId: string;

    if (existingProducts.data.length > 0) {
      subscriptionProductId = existingProducts.data[0].id;
      console.log(`ℹ  Subscription product already exists: ${subscriptionProductId}`);
    } else {
      const product = await stripe.products.create({
        name: 'Freight DNA Subscription',
        description: 'Full platform access for your freight brokerage team. Includes all modules: org charts, touchpoint tracking, RFP intelligence, team performance, career progression, and AI-powered analysis.',
        metadata: {
          type: 'subscription',
        },
      });
      subscriptionProductId = product.id;
      console.log(`✓  Created product: ${product.name} (${subscriptionProductId})`);
    }

    // Fetch all active prices for the product and split by interval
    const allPrices = await stripe.prices.list({ product: subscriptionProductId, active: true, limit: 100 });
    const monthlyPrices = allPrices.data.filter(p => p.recurring?.interval === "month");
    const annualPrices  = allPrices.data.filter(p => p.recurring?.interval === "year");

    // ── Monthly price ──────────────────────────────────────────────────────────
    if (monthlyPrices.length === 0) {
      const monthly = await stripe.prices.create({
        product: subscriptionProductId,
        unit_amount: MONTHLY_PRICE_CENTS,
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: { billing_period: 'monthly' },
      });
      console.log(`✓  Created monthly price: $${(MONTHLY_PRICE_CENTS / 100).toLocaleString()}/month (${monthly.id})`);
    } else {
      const existing = monthlyPrices[0];
      if (existing.unit_amount !== MONTHLY_PRICE_CENTS) {
        await stripe.prices.update(existing.id, { active: false });
        const monthly = await stripe.prices.create({
          product: subscriptionProductId,
          unit_amount: MONTHLY_PRICE_CENTS,
          currency: 'usd',
          recurring: { interval: 'month' },
          metadata: { billing_period: 'monthly' },
        });
        console.log(`✓  Updated monthly price → $${(MONTHLY_PRICE_CENTS / 100).toLocaleString()}/month (${monthly.id})`);
      } else {
        console.log(`ℹ  Monthly price already correct: $${(MONTHLY_PRICE_CENTS / 100).toLocaleString()}/month (${existing.id})`);
      }
    }

    // ── Annual price ───────────────────────────────────────────────────────────
    if (annualPrices.length === 0) {
      const annual = await stripe.prices.create({
        product: subscriptionProductId,
        unit_amount: ANNUAL_PRICE_CENTS,
        currency: 'usd',
        recurring: { interval: 'year' },
        metadata: { billing_period: 'annual', discount_pct: '20' },
      });
      const monthlyEquiv = Math.round(ANNUAL_PRICE_CENTS / 12 / 100);
      console.log(`✓  Created annual price: $${(ANNUAL_PRICE_CENTS / 100).toLocaleString()}/year (~$${monthlyEquiv}/month, 20% off) (${annual.id})`);
    } else {
      const existing = annualPrices[0];
      if (existing.unit_amount !== ANNUAL_PRICE_CENTS) {
        await stripe.prices.update(existing.id, { active: false });
        const annual = await stripe.prices.create({
          product: subscriptionProductId,
          unit_amount: ANNUAL_PRICE_CENTS,
          currency: 'usd',
          recurring: { interval: 'year' },
          metadata: { billing_period: 'annual', discount_pct: '20' },
        });
        console.log(`✓  Updated annual price → $${(ANNUAL_PRICE_CENTS / 100).toLocaleString()}/year (${annual.id})`);
      } else {
        console.log(`ℹ  Annual price already correct: $${(ANNUAL_PRICE_CENTS / 100).toLocaleString()}/year (${existing.id})`);
      }
    }

    // ── One-time Add-On: Custom Feature Buildout ────────────────────────────────
    const existingAddonProducts = await stripe.products.search({
      query: "name:'Custom Feature Buildout' AND active:'true'"
    });

    let addonProductId: string;

    if (existingAddonProducts.data.length > 0) {
      addonProductId = existingAddonProducts.data[0].id;
      console.log(`ℹ  Add-on product already exists: ${addonProductId}`);
    } else {
      const addonProduct = await stripe.products.create({
        name: 'Custom Feature Buildout',
        description: 'A custom feature built specifically for your brokerage\'s unique workflow. Scoped, designed, developed, and deployed by the Freight DNA team.',
        metadata: { type: 'one_time' },
      });
      addonProductId = addonProduct.id;
      console.log(`✓  Created add-on product: ${addonProduct.name} (${addonProductId})`);
    }

    // Fetch existing active one-time prices for the add-on product
    const allAddonPrices = await stripe.prices.list({ product: addonProductId, active: true, limit: 100 });
    const existingAddonPrice = allAddonPrices.data.find(p => p.type === 'one_time' && p.unit_amount === ADDON_PRICE_CENTS);

    if (!existingAddonPrice) {
      // Archive any stale one-time prices before creating the new one
      for (const oldPrice of allAddonPrices.data.filter(p => p.type === 'one_time')) {
        await stripe.prices.update(oldPrice.id, { active: false });
      }
      const addonPrice = await stripe.prices.create({
        product: addonProductId,
        unit_amount: ADDON_PRICE_CENTS,
        currency: 'usd',
        metadata: { billing_period: 'one_time' },
      });
      console.log(`✓  Created add-on price: $${(ADDON_PRICE_CENTS / 100).toLocaleString()} one-time (${addonPrice.id})`);
    } else {
      console.log(`ℹ  Add-on price already correct: $${(ADDON_PRICE_CENTS / 100).toLocaleString()} one-time (${existingAddonPrice.id})`);
    }

    console.log('\n✅  All products and prices are in sync with Stripe.');
    console.log('\nTo raise prices later, update the price constants at the top of this file and re-run.');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error seeding products:', message);
    process.exit(1);
  }
}

createProducts();
