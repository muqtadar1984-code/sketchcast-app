/**
 * Credit-pack config tests — the invariants the webhook and the UI lean on:
 *   * the three founder-approved packs: 6/$8, 18/$20, 36/$36
 *   * product-name matching: exact names work, drift in dashes/spacing is
 *     tolerated, but the prefix and the "(N)" credit count are load-bearing
 *   * unknown names NEVER guess (a mismatched sale must alert, not miscount)
 *   * packs are LIVE: all three carry their OWN variant checkout link on the
 *     one "SketchCast Credits" product (LIVE-mode slugs since the store was
 *     activated on 2026-08-20; the TEST-mode ones they replaced are dead)
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

  // Each pack must open ITS OWN variant checkout. The three links were once
  // the same slug ("1 kit (6)"), so a $20 or $36 chip opened an $8 checkout
  // and credited 6 — an undercharge no error surfaces. Distinctness is the
  // property that catches a copy-paste repoint, so assert it directly.
  //
  // These literals pin the LIVE CATALOGUE, not a parsing rule: they are the
  // slugs a real card is charged against, so they are updated whenever the
  // catalogue moves — and a slug moves whenever LS re-saves the variant. The
  // assertion cannot know what price a slug opens, so this test is a
  // tripwire against an accidental edit, never proof the links are right;
  // that proof is fetching each URL and reading its subtotal. Verified
  // 2026-08-20: $8 / $20 / $36, test_mode false.
  it("is LIVE: each pack carries its OWN variant checkout link, all purchasable", () => {
    const BUY = "https://aetheltwin.lemonsqueezy.com/checkout/buy/";
    expect(CREDIT_PACKS.map((p) => p.checkoutUrl)).toEqual([
      `${BUY}af3f9267-4dba-4c8f-861d-1a542f0ccc47`, // 1 kit (6)  — $8
      `${BUY}5d248c46-538d-42aa-a5c4-c35c3ef55561`, // 3 kits (18) — $20
      `${BUY}235265c9-7841-4c1a-8b74-db10b2b505e1`, // 6 kits (36) — $36
    ]);
    expect(new Set(CREDIT_PACKS.map((p) => p.checkoutUrl)).size).toBe(CREDIT_PACKS.length);
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
