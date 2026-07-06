/**
 * Idempotent Stripe seed: creates the SketchCast Products and MYR Prices in
 * whatever Stripe account STRIPE_SECRET_KEY points at (use TEST mode).
 *
 *   npx tsx scripts/stripe_seed.ts
 *
 * Amounts below are PLACEHOLDERS (pricing not finalised) — adjust here or in
 * the Dashboard; the app never hardcodes amounts, only Price IDs via env.
 * Re-running finds existing products by metadata.plan_key and reuses any
 * existing MYR price with the same amount/interval instead of duplicating.
 * Prints the env lines to paste into .env.local / Vercel.
 */

import Stripe from "stripe";

const SEED = [
  { planKey: "parent_monthly", name: "SketchCast Parent", amount: 1900, interval: "month" as const, env: "STRIPE_PRICE_PARENT_MONTHLY" },
  { planKey: "teacher_monthly", name: "SketchCast Teacher", amount: 4900, interval: "month" as const, env: "STRIPE_PRICE_TEACHER_MONTHLY" },
  { planKey: "school_annual", name: "SketchCast School (annual, card)", amount: 499000, interval: "year" as const, env: "STRIPE_PRICE_SCHOOL_ANNUAL" },
  { planKey: "school_onetime", name: "SketchCast School (one-off licence, card)", amount: 499000, interval: null, env: "STRIPE_PRICE_SCHOOL_ONETIME" },
];

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set.");
  if (!key.startsWith("sk_test_")) {
    console.warn("⚠ STRIPE_SECRET_KEY is not a test key — this seed is meant for test mode.");
  }
  const stripe = new Stripe(key, { apiVersion: "2026-06-24.dahlia" });

  const envLines: string[] = [];
  for (const item of SEED) {
    // Product: find by metadata.plan_key, else create.
    const products = await stripe.products.search({ query: `metadata["plan_key"]:"${item.planKey}"` });
    let product = products.data[0];
    if (!product) {
      product = await stripe.products.create({
        name: item.name,
        metadata: { plan_key: item.planKey, product_line: "sketchcast" },
      });
      console.log(`created product ${product.id} (${item.planKey})`);
    } else {
      console.log(`found product ${product.id} (${item.planKey})`);
    }

    // Price: reuse an active MYR price with matching amount/interval.
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
    let price = prices.data.find(
      (p) =>
        p.currency === "myr" &&
        p.unit_amount === item.amount &&
        ((item.interval && p.recurring?.interval === item.interval) || (!item.interval && !p.recurring)),
    );
    if (!price) {
      price = await stripe.prices.create({
        product: product.id,
        currency: "myr", // MYR ONLY — Aethel Twin settles pure MYR, no Stripe-side FX
        unit_amount: item.amount,
        ...(item.interval ? { recurring: { interval: item.interval } } : {}),
        metadata: { plan_key: item.planKey },
      });
      console.log(`created price ${price.id} (${item.planKey}, RM ${(item.amount / 100).toFixed(2)})`);
    } else {
      console.log(`found price ${price.id} (${item.planKey})`);
    }
    envLines.push(`${item.env}=${price.id}`);
  }

  console.log("\nPaste into .env.local / Vercel:\n");
  for (const line of envLines) console.log(line);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
