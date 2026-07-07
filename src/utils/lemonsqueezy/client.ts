import { lemonSqueezySetup } from "@lemonsqueezy/lemonsqueezy.js";

// Server-only Lemon Squeezy setup. LS is the Merchant of Record for the B2C
// plans (parent/teacher) — it is the seller of record, handles global consumer
// tax, and pays Aethel Twin a payout. Card data never touches us (LS hosted
// checkout). NEVER import this from a client component.

let _ready = false;

export function ensureLemonSqueezy(): void {
  if (typeof window !== "undefined") {
    throw new Error("Lemon Squeezy must never be initialised in the browser.");
  }
  if (_ready) return;
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) throw new Error("LEMONSQUEEZY_API_KEY is not configured.");
  lemonSqueezySetup({ apiKey });
  _ready = true;
}

/** True only when the LS provider is fully configured (keys + store). Lets the
 * checkout route return a clean "not available yet" instead of throwing when
 * the LS side hasn't been set up but Stripe billing is on. */
export function lemonSqueezyConfigured(): boolean {
  return !!(process.env.LEMONSQUEEZY_API_KEY && process.env.LEMONSQUEEZY_STORE_ID && process.env.LEMONSQUEEZY_WEBHOOK_SECRET);
}

export function lemonSqueezyStoreId(): string {
  const id = process.env.LEMONSQUEEZY_STORE_ID;
  if (!id) throw new Error("LEMONSQUEEZY_STORE_ID is not configured.");
  return id;
}
