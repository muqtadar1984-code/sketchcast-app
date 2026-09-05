// One-time credit packs (homeschool release, founder-approved 2026-08):
// 6 credits $8 ("1 kit"), 18 credits $20 ("3 kits"), 36 credits $36 ("6 kits").
// Purchased credits do not expire monthly; the DB consumes the monthly quota
// FIRST, then the purchased balance. Purchasable on ANY paid tier — never on
// trial/free/promo (those see an upgrade prompt instead).
//
// PURE module (no React, no next/*, no DB — same doctrine as onboarding.ts):
// the catalogue, the tier rule and the visibility rule are all unit-testable
// and safe to import from client and server alike.
//
// SHIPS DARK BY DESIGN. The Lemon Squeezy products for the packs do not exist
// yet, so each pack's checkoutUrl resolves from env and is null until the
// founder creates the product and sets the variable. purchasablePacks() drops
// URL-less packs, so with nothing configured the "Buy credits" affordance
// simply does not render — no flag needed, no broken button possible.
//
// SINGLE CATALOGUE: src/utils/billing/packs.ts (per the release contract) owns
// the pack sizes/prices, the exact LS product names the webhook matches, and
// checkout-URL resolution (env LEMONSQUEEZY_CHECKOUT_PACK_* first, literal
// fallback). This module is the thin dashboard-facing adapter over it — the
// UI shape (priceUsd, kits) plus the tier/visibility rules live here so the
// meter never imports webhook machinery.

import { resolvedPacks, type CreditPackKey } from "@/utils/billing/packs";

export type CreditPack = {
  /** Stable pack key — also how a webhook names the product mapping. */
  key: CreditPackKey;
  /** Generation credits granted by the pack (a credit = ONE generation, 0075). */
  credits: number;
  /** One-time price, USD (Lemon Squeezy is the USD/consumer provider). */
  priceUsd: number;
  /** How many kits the credits amount to — the founder's shorthand. A kit is
   * seven pieces but costs 6 credits, so the divisor is 6, not the kit size. */
  kits: number;
  /** LS hosted-checkout URL, or null while the product doesn't exist yet. */
  checkoutUrl: string | null;
};

export function creditPacks(): CreditPack[] {
  return resolvedPacks().map((p) => ({
    key: p.key,
    credits: p.credits,
    priceUsd: p.usd,
    kits: Math.round(p.credits / 6),
    checkoutUrl: p.checkoutUrl,
  }));
}

/** Only packs that can actually be bought today: a null checkoutUrl is a
 * product that doesn't exist yet, and a button to nowhere must not render. */
export function purchasablePacks(packs: CreditPack[]): CreditPack[] {
  return packs.filter((p) => p.checkoutUrl != null);
}

/**
 * May THIS tier buy packs? Tier strings are my_fair_use()'s vocabulary
 * (plan_tier, 0047/0060 + homeschool from 0086): packs are for accounts that
 * already pay — pro, pro_plus, family (sold as "Home Basic"), homeschool.
 *  - trial/promo: no — they see an upgrade prompt instead (a pack would be a
 *    way to pay without ever subscribing).
 *  - school: unmetered, so a pack is meaningless (the meter never renders).
 *  - unknown/null: no — fail closed, never sell into a state we can't name.
 */
export function packsAllowedForTier(tier: string | null | undefined): boolean {
  return tier === "pro" || tier === "pro_plus" || tier === "family" || tier === "homeschool";
}
