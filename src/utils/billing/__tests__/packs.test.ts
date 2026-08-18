/**
 * Credit-pack config tests — the invariants the webhook and the UI lean on:
 *   * the three founder-approved packs: 6/$8, 18/$20, 36/$36
 *   * product-name matching: exact names work, drift in dashes/spacing is
 *     tolerated, but the prefix and the "(N)" credit count are load-bearing
 *   * unknown names NEVER guess (a mismatched sale must alert, not miscount)
 *   * packs are LIVE: all three carry the SketchCast Credits checkout link
 *     (one product, three variants — LS product created 2026-08-18)
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import { CREDIT_PACKS, CREDIT_PACK_PRODUCT_PREFIX, packForOrderItem, packForProductName, purchasablePacks } from "../packs";

describe("credit pack catalogue", () => {
  it("carries exactly the founder-approved sizes and prices", () => {
    expect(CREDIT_PACKS.map((p) => [p.key, p.credits, p.usd])).toEqual([
      ["pack_6", 6, 8],
      ["pack_18", 18, 20],
      ["pack_36", 36, 36],
    ]);
  });

  it("documents the exact LS product names the founder must create", () => {
    expect(CREDIT_PACKS.map((p) => p.productName)).toEqual([
      "SketchCast Credits — 1 kit (6)",
      "SketchCast Credits — 3 kits (18)",
      "SketchCast Credits — 6 kits (36)",
    ]);
  });

  it("is LIVE: every pack carries the SketchCast Credits checkout link, all purchasable", () => {
    const LIVE = "https://aetheltwin.lemonsqueezy.com/checkout/buy/b71a1f57-fcb7-4117-bd8f-786d4cf52268";
    expect(CREDIT_PACKS.every((p) => p.checkoutUrl === LIVE)).toBe(true);
    expect(purchasablePacks().map((p) => p.key)).toEqual(["pack_6", "pack_18", "pack_36"]);
  });
});

describe("packForProductName", () => {
  it("matches each configured product name to its pack", () => {
    for (const p of CREDIT_PACKS) {
      expect(packForProductName(p.productName)?.key).toBe(p.key);
    }
  });

  it("tolerates dash/spacing drift but keeps prefix + (N) load-bearing", () => {
    expect(packForProductName("SketchCast Credits - 1 kit (6)")?.key).toBe("pack_6"); // hyphen, not em-dash
    expect(packForProductName("  SketchCast Credits — 3 kits (18)  ")?.key).toBe("pack_18"); // padding
    expect(packForProductName("sketchcast credits — 6 kits (36)")?.key).toBe("pack_36"); // case
  });

  it("never guesses: wrong prefix, missing count, or unknown count → null", () => {
    expect(packForProductName("SketchCast Homeschool")).toBeNull(); // a subscription product
    expect(packForProductName("SketchCast Credits — 1 kit")).toBeNull(); // no (N)
    expect(packForProductName("SketchCast Credits — mega (99)")).toBeNull(); // not a configured size
    expect(packForProductName("Credits — 1 kit (6)")).toBeNull(); // prefix gone
    expect(packForProductName(null)).toBeNull();
    expect(packForProductName(undefined)).toBeNull();
    expect(packForProductName("")).toBeNull();
  });

  it("prefix constant matches the documented names", () => {
    for (const p of CREDIT_PACKS) {
      expect(p.productName.startsWith(CREDIT_PACK_PRODUCT_PREFIX)).toBe(true);
    }
  });
});

describe("packForOrderItem (one product, three variants)", () => {
  it("reads the count from the VARIANT name when the product is bare 'SketchCast Credits'", () => {
    expect(packForOrderItem("SketchCast Credits", "1 kit (6)")?.key).toBe("pack_6");
    expect(packForOrderItem("SketchCast Credits", "3 kits (18)")?.key).toBe("pack_18");
    expect(packForOrderItem("SketchCast Credits", "6 kits (36)")?.key).toBe("pack_36");
  });

  it("still matches the three-products shape (count on the product name)", () => {
    for (const p of CREDIT_PACKS) {
      expect(packForOrderItem(p.productName, "Default")?.key).toBe(p.key);
    }
  });

  it("a count on the PRODUCT name is authoritative — an unknown one never falls through to the variant", () => {
    expect(packForOrderItem("SketchCast Credits — mega (99)", "1 kit (6)")).toBeNull();
  });

  it("never guesses: bare product + countless/unknown variant, or wrong prefix → null", () => {
    expect(packForOrderItem("SketchCast Credits", "Default")).toBeNull();
    expect(packForOrderItem("SketchCast Credits", "mega (99)")).toBeNull();
    expect(packForOrderItem("SketchCast Credits", null)).toBeNull();
    expect(packForOrderItem("SketchCast Credits", undefined)).toBeNull();
    expect(packForOrderItem("SketchCast Homeschool", "1 kit (6)")).toBeNull();
  });
});
