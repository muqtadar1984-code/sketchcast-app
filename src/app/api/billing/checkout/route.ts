import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { stripe } from "@/utils/stripe/client";
import { ensureStripeCustomer } from "@/utils/stripe/customer";
import { getPlan, productIdFor, assertMyrPrice, type Plan } from "@/utils/stripe/plans";
import { assertAdultRole, assertBillingEnabled, BillingGuardError } from "@/utils/stripe/guards";
import { resolveBillingCaller, type BillingCaller } from "@/utils/stripe/caller";
import { lemonSqueezyConfigured } from "@/utils/lemonsqueezy/client";
import { createLsCheckout } from "@/utils/lemonsqueezy/checkout";

export const runtime = "nodejs";

// Create a hosted-checkout session (redirect) with the correct provider:
// Stripe (direct merchant, MYR) for school plans; Lemon Squeezy (Merchant of
// Record, USD) for parent/teacher plans. Card data never touches this server:
// we return only the hosted URL. Adults only; flag-gated.

export async function POST(request: Request) {
  try {
    const caller = await resolveBillingCaller();
    assertAdultRole(caller.role);
    assertBillingEnabled(caller.school);

    let body: { planKey?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const plan = getPlan(body.planKey);
    if (!plan) return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
    if (!plan.roles.includes(caller.role)) {
      return NextResponse.json({ error: "This plan isn't available for your role." }, { status: 403 });
    }

    const appUrl = process.env.APP_URL || "https://app.sketchcast.app";
    const backPath = caller.role === "parent" ? "/dashboard/children" : "/dashboard";

    // ── Lemon Squeezy path (parent/teacher, MoR, USD) ────────────────────────
    if (plan.provider === "lemonsqueezy") {
      if (!lemonSqueezyConfigured()) {
        return NextResponse.json({ error: "This plan isn't available yet." }, { status: 503 });
      }
      const url = await createLsCheckout({
        variantId: productIdFor(plan),
        userId: caller.userId,
        planKey: plan.key,
        email: caller.email,
        redirectUrl: `${appUrl}${backPath}?billing=success`,
      });
      console.log("billing.ls.checkout.created", { plan: plan.key, user: caller.userId });
      return NextResponse.json({ url });
    }

    // ── Stripe path (school plans, direct merchant, MYR) ─────────────────────
    return await stripeCheckout(plan, caller, backPath, appUrl);
  } catch (e) {
    if (e instanceof BillingGuardError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("billing.checkout.error", (e as Error).message);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 500 });
  }
}

// Stripe school-plan checkout (MYR, direct merchant). Throws on failure; the
// POST handler owns the try/catch.
async function stripeCheckout(plan: Plan, caller: BillingCaller, backPath: string, appUrl: string): Promise<Response> {
  const s = stripe();
  const admin = createAdminClient();

  // Only school_* plans are school-scoped. (Stripe currently sells only school
  // plans; personal plans go to Lemon Squeezy.) schoolForPlan is NULL for any
  // non-school plan so a personal purchase never credits or leaks to a school.
  const schoolForPlan = plan.key.startsWith("school_") ? caller.schoolId : null;

  // Look up or create the Stripe Customer for this account (provider-scoped) —
  // the mapping the webhook trusts. Shared with the console's invoice path.
  const customerId = await ensureStripeCustomer(admin, s, {
    userId: caller.userId,
    schoolId: caller.schoolId,
    email: caller.email,
    role: caller.role,
  });

  // MYR hard gate — re-check the LIVE price, not just our config.
  const price = await s.prices.retrieve(productIdFor(plan));
  assertMyrPrice(price);

  const meta = {
    user_id: caller.userId,
    school_id: schoolForPlan ?? "", // "" = personal (no school attribution)
    plan_key: plan.key,
  };

  const session = await s.checkout.sessions.create(
    {
      mode: plan.mode,
      customer: customerId,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${appUrl}${backPath}?billing=success`,
      cancel_url: `${appUrl}${backPath}?billing=canceled`,
      metadata: meta,
      ...(plan.mode === "subscription"
        ? { subscription_data: { metadata: meta } }
        : { payment_intent_data: { metadata: meta } }),
    },
    {
      idempotencyKey: `checkout_${caller.userId}_${plan.key}_${Math.floor(Date.now() / 300_000)}`,
    },
  );

  console.log("billing.checkout.created", { session: session.id, plan: plan.key, user: caller.userId });
  return NextResponse.json({ url: session.url });
}
