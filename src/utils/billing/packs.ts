// Credit packs — one-time Lemon Squeezy purchases that top up a PERSISTENT
// generation balance (no monthly expiry; consumed only after the monthly plan
// quota — see migration 0086). This module is the single source of truth the
// app AND the webhook read:
//
//   * checkoutUrl — the LS hosted-checkout link for the pack. The LS products
//     DO NOT EXIST yet, so every URL ships null; a null URL means the pack's
//     buy button simply does not render (the feature ships dark). When the
//     founder creates the products, set the pack's env var
//     (LEMONSQUEEZY_CHECKOUT_PACK_6/18/36 — swaps test/live without a code
//     change, same pattern as LEMONSQUEEZY_VARIANT_*) or paste the "Share"
//     checkout URL into the literal here; resolvedPacks() prefers env. The
//     dashboard UI consumes this catalogue through src/utils/credit-packs.ts.
//   * productName — the EXACT product name the founder must use in Lemon
//     Squeezy. The webhook identifies a pack order by the product-name prefix
//     "SketchCast Credits" plus the trailing "(N)" credit count, so the names
//     below are load-bearing, not decorative:
//
//       "SketchCast Credits — 1 kit (6)"
//       "SketchCast Credits — 3 kits (18)"
//       "SketchCast Credits — 6 kits (36)"
//
// Packs are purchasable on any PAID tier (pro, pro_plus, family/Home Basic,
// homeschool) — never trial/free. That gate lives where the button renders;
// the webhook credits whoever verifiably paid.

export type CreditPackKey = "pack_6" | "pack_18" | "pack_36";

export type CreditPack = {
  key: CreditPackKey;
  credits: number;
  usd: number;
  /** Marketing size — a kit is 6 generations (lesson + 5 documents). */
  label: string;
  /** Exact LS product name (webhook matches on it — keep verbatim). */
  productName: string;
  /** Env var that may carry the LS hosted-checkout URL (test/live swap). */
  urlEnv: string;
  /** Literal LS hosted-checkout URL fallback; null until the product exists. */
  checkoutUrl: string | null;
};

/** Product-name prefix that marks an LS order as a credit pack. */
export const CREDIT_PACK_PRODUCT_PREFIX = "SketchCast Credits";

export const CREDIT_PACKS: readonly CreditPack[] = [
  {
    key: "pack_6",
    credits: 6,
    usd: 8,
    label: "1 kit",
    productName: "SketchCast Credits — 1 kit (6)",
    urlEnv: "LEMONSQUEEZY_CHECKOUT_PACK_6",
    checkoutUrl: null,
  },
  {
    key: "pack_18",
    credits: 18,
    usd: 20,
    label: "3 kits",
    productName: "SketchCast Credits — 3 kits (18)",
    urlEnv: "LEMONSQUEEZY_CHECKOUT_PACK_18",
    checkoutUrl: null,
  },
  {
    key: "pack_36",
    credits: 36,
    usd: 36,
    label: "6 kits",
    productName: "SketchCast Credits — 6 kits (36)",
    urlEnv: "LEMONSQUEEZY_CHECKOUT_PACK_36",
    checkoutUrl: null,
  },
] as const;

/** The catalogue with each checkoutUrl resolved: env var first (blank ≠
 * configured), then the literal, else null (= that pack ships dark). */
export function resolvedPacks(): CreditPack[] {
  return CREDIT_PACKS.map((p) => {
    const fromEnv = process.env[p.urlEnv];
    return { ...p, checkoutUrl: fromEnv && fromEnv.trim() ? fromEnv.trim() : p.checkoutUrl };
  });
}

/** Packs the UI may sell right now (URL configured). */
export function purchasablePacks(): CreditPack[] {
  return resolvedPacks().filter((p) => p.checkoutUrl !== null);
}

/**
 * Identify a pack from an LS order's product name. Matching is deliberately
 * tolerant of dash/spacing drift (an em-dash typed as a hyphen must not drop
 * a real sale) but strict about the two things that matter: the
 * "SketchCast Credits" prefix and the trailing "(N)" credit count, which must
 * equal a configured pack's size. Returns null for anything else — the
 * webhook treats that as "not a pack order", never as a guess.
 */
export function packForProductName(name: string | null | undefined): CreditPack | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().startsWith(CREDIT_PACK_PRODUCT_PREFIX.toLowerCase())) return null;
  const m = trimmed.match(/\((\d{1,4})\)\s*$/);
  if (!m) return null;
  const credits = Number(m[1]);
  return CREDIT_PACKS.find((p) => p.credits === credits) ?? null;
}
