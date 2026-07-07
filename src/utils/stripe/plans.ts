// Plan catalogue: internal plan keys → provider + the env var holding that
// provider's product identifier (never hardcoded). TWO providers:
//   * Stripe (direct merchant, Aethel Twin, MYR) — SCHOOL plans.
//   * Lemon Squeezy (Merchant of Record, USD) — PARENT/TEACHER plans. LS is the
//     seller of record for B2C: it handles global VAT/GST/sales tax and pays
//     Aethel Twin a payout, so we never carry consumer-tax liability.
//
// The LS store sells three PRODUCTS (Teacher Pro, Teacher Pro+, Family), each
// with a monthly and an annual variant, so there are six LS plan keys. Each key
// maps to one LS variant id (via env). The public pricing page links straight
// to LS hosted checkout, so the webhook identifies which plan was bought by the
// variant id on the subscription — see planKeyForVariant().
//
// The app gates access on the provider-agnostic `entitlements` table, so the
// provider split is invisible downstream. assertMyrPrice() still hard-gates the
// Stripe path to MYR; the LS path is USD by design.
//
// NOTE: most schools pay by bank transfer against a direct Aethel Twin invoice,
// outside both providers. The school_* Stripe plans exist only for schools that
// choose to pay by card — never force schools through Stripe.

import type Stripe from "stripe";

export type Provider = "stripe" | "lemonsqueezy";

export type PlanKey =
  | "teacher_pro_monthly"
  | "teacher_pro_annual"
  | "teacher_pro_plus_monthly"
  | "teacher_pro_plus_annual"
  | "family_monthly"
  | "family_annual"
  | "school_annual"
  | "school_onetime";

/** The product family — capability gating and the founding cohort key on this,
 * not on the billing cycle. */
export type PlanTier = "teacher_pro" | "teacher_pro_plus" | "family" | "school";

export type Plan = {
  key: PlanKey;
  provider: Provider;
  tier: PlanTier;
  mode: "subscription" | "payment";
  interval: "month" | "year" | null;
  /** env var holding the provider's product id (Stripe Price ID or LS Variant ID) */
  productEnv: string;
  /** roles allowed to buy this plan */
  roles: readonly string[];
  label: string;
};

const TEACHER_ROLES = ["teacher", "school_admin", "coordinator"] as const;
// Family is a personal/home plan; parents primarily, but any adult may buy it.
const FAMILY_ROLES = ["parent", "teacher", "school_admin", "coordinator"] as const;

export const PLANS: Record<PlanKey, Plan> = {
  teacher_pro_monthly: {
    key: "teacher_pro_monthly",
    provider: "lemonsqueezy",
    tier: "teacher_pro",
    mode: "subscription",
    interval: "month",
    productEnv: "LEMONSQUEEZY_VARIANT_TEACHER_PRO_MONTHLY",
    roles: TEACHER_ROLES,
    label: "Teacher Pro · monthly",
  },
  teacher_pro_annual: {
    key: "teacher_pro_annual",
    provider: "lemonsqueezy",
    tier: "teacher_pro",
    mode: "subscription",
    interval: "year",
    productEnv: "LEMONSQUEEZY_VARIANT_TEACHER_PRO_ANNUAL",
    roles: TEACHER_ROLES,
    label: "Teacher Pro · annual",
  },
  teacher_pro_plus_monthly: {
    key: "teacher_pro_plus_monthly",
    provider: "lemonsqueezy",
    tier: "teacher_pro_plus",
    mode: "subscription",
    interval: "month",
    productEnv: "LEMONSQUEEZY_VARIANT_TEACHER_PRO_PLUS_MONTHLY",
    roles: TEACHER_ROLES,
    label: "Teacher Pro+ · monthly",
  },
  teacher_pro_plus_annual: {
    key: "teacher_pro_plus_annual",
    provider: "lemonsqueezy",
    tier: "teacher_pro_plus",
    mode: "subscription",
    interval: "year",
    productEnv: "LEMONSQUEEZY_VARIANT_TEACHER_PRO_PLUS_ANNUAL",
    roles: TEACHER_ROLES,
    label: "Teacher Pro+ · annual",
  },
  family_monthly: {
    key: "family_monthly",
    provider: "lemonsqueezy",
    tier: "family",
    mode: "subscription",
    interval: "month",
    productEnv: "LEMONSQUEEZY_VARIANT_FAMILY_MONTHLY",
    roles: FAMILY_ROLES,
    label: "Family · monthly",
  },
  family_annual: {
    key: "family_annual",
    provider: "lemonsqueezy",
    tier: "family",
    mode: "subscription",
    interval: "year",
    productEnv: "LEMONSQUEEZY_VARIANT_FAMILY_ANNUAL",
    roles: FAMILY_ROLES,
    label: "Family · annual",
  },
  school_annual: {
    key: "school_annual",
    provider: "stripe",
    tier: "school",
    mode: "subscription",
    interval: "year",
    productEnv: "STRIPE_PRICE_SCHOOL_ANNUAL",
    roles: ["school_admin"],
    label: "School · annual (card)",
  },
  school_onetime: {
    key: "school_onetime",
    provider: "stripe",
    tier: "school",
    mode: "payment",
    interval: null,
    productEnv: "STRIPE_PRICE_SCHOOL_ONETIME",
    roles: ["school_admin"],
    label: "School · one-off annual licence (card)",
  },
};

/** One-time school licences entitle for this window (days). */
export const ONETIME_LICENCE_DAYS = 365;

export function getPlan(planKey: unknown): Plan | null {
  if (typeof planKey !== "string") return null;
  return (PLANS as Record<string, Plan>)[planKey] ?? null;
}

/** Provider product id (Stripe Price ID or LS Variant ID) from env. */
export function productIdFor(plan: Plan): string {
  const id = process.env[plan.productEnv];
  if (!id) throw new Error(`${plan.productEnv} is not configured.`);
  return id;
}

/** Reverse lookup used by the LS webhook: which plan_key does this LS variant id
 * belong to? The public pricing page checkout carries no plan_key, so the
 * variant id on the subscription is the trusted source. Returns null for an
 * unknown/unmapped variant (the webhook alerts rather than guessing). Reads env
 * so test/live variant ids swap without code changes. */
export function planKeyForVariant(variantId: string | number | null | undefined): PlanKey | null {
  if (variantId === null || variantId === undefined || variantId === "") return null;
  const vid = String(variantId);
  for (const plan of Object.values(PLANS)) {
    if (plan.provider !== "lemonsqueezy") continue;
    const configured = process.env[plan.productEnv];
    if (configured && configured === vid) return plan.key;
  }
  return null;
}

/** Hard MYR gate — Stripe path only: refuse to sell anything not in MYR. */
export function assertMyrPrice(price: Pick<Stripe.Price, "currency" | "id">): void {
  if ((price.currency || "").toLowerCase() !== "myr") {
    throw new Error(`Price ${price.id} is ${price.currency}, not MYR — refusing to create a session.`);
  }
}
