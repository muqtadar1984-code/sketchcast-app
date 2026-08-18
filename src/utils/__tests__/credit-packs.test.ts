/**
 * One-time credit packs (homeschool release). The load-bearing decisions:
 *  • the founder-approved catalogue — 6/$8 (1 kit), 18/$20 (3 kits),
 *    36/$36 (6 kits) — with checkout URLs from env, null while the LS
 *    products don't exist (the affordance ships dark);
 *  • purchasablePacks — a null checkoutUrl must never render a button;
 *  • packsAllowedForTier — paid tiers only, NEVER trial/free/promo, and
 *    unknown tiers fail closed.
 * Run: npx vitest run src/utils/__tests__/credit-packs.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { creditPacks, packsAllowedForTier, purchasablePacks } from "@/utils/credit-packs";

const ENVS = [
  "LEMONSQUEEZY_CHECKOUT_PACK_6",
  "LEMONSQUEEZY_CHECKOUT_PACK_18",
  "LEMONSQUEEZY_CHECKOUT_PACK_36",
] as const;

afterEach(() => {
  for (const e of ENVS) delete process.env[e];
});

describe("creditPacks — the founder-approved catalogue", () => {
  it("carries exactly the three approved packs, in ascending size", () => {
    const packs = creditPacks();
    expect(packs.map((p) => [p.key, p.credits, p.priceUsd, p.kits])).toEqual([
      ["pack_6", 6, 8, 1],
      ["pack_18", 18, 20, 3],
      ["pack_36", 36, 36, 6],
    ]);
  });

  it("resolves checkout URLs from env — null (dark) when unset or blank", () => {
    expect(creditPacks().every((p) => p.checkoutUrl === null)).toBe(true);
    process.env.LEMONSQUEEZY_CHECKOUT_PACK_18 = "https://aetheltwin.lemonsqueezy.com/checkout/buy/abc";
    process.env.LEMONSQUEEZY_CHECKOUT_PACK_36 = "   "; // blank ≠ configured
    const packs = creditPacks();
    expect(packs.find((p) => p.key === "pack_18")?.checkoutUrl).toBe(
      "https://aetheltwin.lemonsqueezy.com/checkout/buy/abc",
    );
    expect(packs.find((p) => p.key === "pack_36")?.checkoutUrl).toBeNull();
  });
});

describe("purchasablePacks — a button to nowhere must not render", () => {
  it("is empty while no product exists (the ship-dark state)", () => {
    expect(purchasablePacks(creditPacks())).toEqual([]);
  });

  it("keeps exactly the packs with a URL", () => {
    process.env.LEMONSQUEEZY_CHECKOUT_PACK_6 = "https://example.com/6";
    const vis = purchasablePacks(creditPacks());
    expect(vis.map((p) => p.key)).toEqual(["pack_6"]);
  });
});

describe("packsAllowedForTier — paid tiers only", () => {
  it("allows every paying personal tier, homeschool included", () => {
    for (const t of ["pro", "pro_plus", "family", "homeschool"]) {
      expect(packsAllowedForTier(t)).toBe(true);
    }
  });

  it("never sells to trial/promo (they get the upgrade prompt), school, or the unknown", () => {
    for (const t of ["trial", "promo", "school", "unlimited", "", null, undefined, "PRO"]) {
      expect(packsAllowedForTier(t as string | null | undefined)).toBe(false);
    }
  });
});
