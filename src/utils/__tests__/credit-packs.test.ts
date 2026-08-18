/**
 * One-time credit packs (homeschool release). The load-bearing decisions:
 *  • the founder-approved catalogue — 6/$8 (1 kit), 18/$20 (3 kits),
 *    36/$36 (6 kits) — LIVE via the SketchCast Credits product-level
 *    checkout link (env vars still override, e.g. for per-variant links);
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

  const BUY = "https://aetheltwin.lemonsqueezy.com/checkout/buy/";
  const LIVE: Record<string, string> = {
    pack_6: `${BUY}b71a1f57-fcb7-4117-bd8f-786d4cf52268`,
    pack_18: `${BUY}34a79a65-4c38-4fc6-b765-9011e40eb14b`,
    pack_36: `${BUY}2e506598-f094-4700-bcb1-dae4effe4148`,
  };

  it("carries each pack's OWN variant checkout link; env overrides per pack, blank falls back", () => {
    expect(creditPacks().every((p) => p.checkoutUrl === LIVE[p.key])).toBe(true);
    process.env.LEMONSQUEEZY_CHECKOUT_PACK_18 = "https://aetheltwin.lemonsqueezy.com/checkout/buy/abc";
    process.env.LEMONSQUEEZY_CHECKOUT_PACK_36 = "   "; // blank ≠ configured → literal stands
    const packs = creditPacks();
    expect(packs.find((p) => p.key === "pack_18")?.checkoutUrl).toBe(
      "https://aetheltwin.lemonsqueezy.com/checkout/buy/abc",
    );
    expect(packs.find((p) => p.key === "pack_36")?.checkoutUrl).toBe(LIVE.pack_36);
  });
});

describe("purchasablePacks — a button to nowhere must not render", () => {
  it("sells all three packs in the live state", () => {
    expect(purchasablePacks(creditPacks()).map((p) => p.key)).toEqual(["pack_6", "pack_18", "pack_36"]);
  });

  it("drops any pack whose URL is null (the ships-dark mechanism still guards)", () => {
    const packs = creditPacks().map((p) => (p.key === "pack_18" ? { ...p, checkoutUrl: null } : p));
    expect(purchasablePacks(packs).map((p) => p.key)).toEqual(["pack_6", "pack_36"]);
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
