// Plan catalogue: internal plan keys → Stripe Price IDs (from env, never
// hardcoded). ALL prices are denominated in MYR — Aethel Twin settles pure
// MYR; foreign customers' own banks bear any conversion (Adaptive Pricing /
// presentment-currency conversion stays OFF in the Stripe Dashboard — see
// BILLING.md). assertMyrPrice() re-checks the live Price at session time.
//
// NOTE: most schools pay by bank transfer against a direct Aethel Twin
// invoice, handled entirely outside Stripe. The school_* plans below exist
// only for schools that CHOOSE to pay by card — never force schools through
// Stripe.

import type Stripe from "stripe";

export type PlanKey = "parent_monthly" | "teacher_monthly" | "school_annual" | "school_onetime";

export type Plan = {
  key: PlanKey;
  mode: "subscription" | "payment";
  /** env var holding the Stripe Price ID */
  priceEnv: string;
  /** roles allowed to buy this plan */
  roles: readonly string[];
  label: string;
};

export const PLANS: Record<PlanKey, Plan> = {
  parent_monthly: {
    key: "parent_monthly",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_PARENT_MONTHLY",
    roles: ["parent", "teacher", "school_admin", "coordinator"],
    label: "Parent · monthly",
  },
  teacher_monthly: {
    key: "teacher_monthly",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_TEACHER_MONTHLY",
    roles: ["teacher", "school_admin", "coordinator"],
    label: "Teacher · monthly",
  },
  school_annual: {
    key: "school_annual",
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_SCHOOL_ANNUAL",
    roles: ["school_admin"],
    label: "School · annual (card)",
  },
  school_onetime: {
    key: "school_onetime",
    mode: "payment",
    priceEnv: "STRIPE_PRICE_SCHOOL_ONETIME",
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

export function priceIdFor(plan: Plan): string {
  const id = process.env[plan.priceEnv];
  if (!id) throw new Error(`${plan.priceEnv} is not configured.`);
  return id;
}

/** Hard MYR gate: refuse to sell anything not denominated in MYR. */
export function assertMyrPrice(price: Pick<Stripe.Price, "currency" | "id">): void {
  if ((price.currency || "").toLowerCase() !== "myr") {
    throw new Error(`Price ${price.id} is ${price.currency}, not MYR — refusing to create a session.`);
  }
}
