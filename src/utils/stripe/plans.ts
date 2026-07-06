// Plan catalogue: internal plan keys → provider + the env var holding that
// provider's product identifier (never hardcoded). TWO providers:
//   * Stripe (direct merchant, Aethel Twin, MYR) — SCHOOL plans.
//   * Lemon Squeezy (Merchant of Record, USD) — PARENT/TEACHER plans. LS is the
//     seller of record for B2C: it handles global VAT/GST/sales tax and pays
//     Aethel Twin a payout, so we never carry consumer-tax liability.
//
// The app gates access on the provider-agnostic `entitlements` table, so the
// provider split is invisible downstream. assertMyrPrice() still hard-gates
// the Stripe path to MYR; the LS path is USD by design.
//
// NOTE: most schools pay by bank transfer against a direct Aethel Twin invoice,
// outside both providers. The school_* Stripe plans exist only for schools that
// choose to pay by card — never force schools through Stripe.

import type Stripe from "stripe";

export type Provider = "stripe" | "lemonsqueezy";
export type PlanKey = "parent_monthly" | "teacher_monthly" | "school_annual" | "school_onetime";

export type Plan = {
  key: PlanKey;
  provider: Provider;
  mode: "subscription" | "payment";
  /** env var holding the provider's product id (Stripe Price ID or LS Variant ID) */
  productEnv: string;
  /** roles allowed to buy this plan */
  roles: readonly string[];
  label: string;
};

export const PLANS: Record<PlanKey, Plan> = {
  parent_monthly: {
    key: "parent_monthly",
    provider: "lemonsqueezy",
    mode: "subscription",
    productEnv: "LEMONSQUEEZY_VARIANT_PARENT_MONTHLY",
    roles: ["parent", "teacher", "school_admin", "coordinator"],
    label: "Parent · monthly",
  },
  teacher_monthly: {
    key: "teacher_monthly",
    provider: "lemonsqueezy",
    mode: "subscription",
    productEnv: "LEMONSQUEEZY_VARIANT_TEACHER_MONTHLY",
    roles: ["teacher", "school_admin", "coordinator"],
    label: "Teacher · monthly",
  },
  school_annual: {
    key: "school_annual",
    provider: "stripe",
    mode: "subscription",
    productEnv: "STRIPE_PRICE_SCHOOL_ANNUAL",
    roles: ["school_admin"],
    label: "School · annual (card)",
  },
  school_onetime: {
    key: "school_onetime",
    provider: "stripe",
    mode: "payment",
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

/** Hard MYR gate — Stripe path only: refuse to sell anything not in MYR. */
export function assertMyrPrice(price: Pick<Stripe.Price, "currency" | "id">): void {
  if ((price.currency || "").toLowerCase() !== "myr") {
    throw new Error(`Price ${price.id} is ${price.currency}, not MYR — refusing to create a session.`);
  }
}
