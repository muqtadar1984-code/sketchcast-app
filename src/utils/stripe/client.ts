import Stripe from "stripe";

// Server-only Stripe SDK instance. NEVER import this from a client component —
// it reads the secret key. All Stripe calls live behind API routes.
//
// Merchant: Aethel Twin Sdn. Bhd. (Malaysia) — one Stripe account, settling
// MYR to a Malaysian bank. Card data never touches our servers: hosted
// Checkout + Billing Portal only, so we stay out of PCI-DSS scope.

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (typeof window !== "undefined") {
    throw new Error("Stripe client must never be constructed in the browser.");
  }
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
    _stripe = new Stripe(key, {
      apiVersion: "2026-06-24.dahlia", // pinned to the SDK's generated version
    });
  }
  return _stripe;
}
