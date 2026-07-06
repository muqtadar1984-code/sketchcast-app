import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { stripe } from "@/utils/stripe/client";
import { getPlan, priceIdFor, assertMyrPrice } from "@/utils/stripe/plans";
import { assertAdultRole, assertBillingEnabled, BillingGuardError } from "@/utils/stripe/guards";
import { resolveBillingCaller } from "@/utils/stripe/caller";

export const runtime = "nodejs";

// Create a Stripe hosted-Checkout session (redirect). Card data never touches
// this server: we return only the session URL. Adults only; MYR only;
// flag-gated; idempotent per (user, plan, 5-minute window).

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

    const s = stripe();
    const admin = createAdminClient();

    // Only school_* plans are school-scoped. Personal plans (teacher/parent)
    // carry NO school_id, so they never credit or leak to a school.
    const schoolForPlan = plan.key.startsWith("school_") ? caller.schoolId : null;

    // Look up or create the Stripe Customer for this account.
    const { data: existing } = await admin
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", caller.userId)
      .maybeSingle();
    let customerId = existing?.stripe_customer_id as string | undefined;
    if (!customerId) {
      const customer = await s.customers.create({
        email: caller.email ?? undefined,
        metadata: {
          user_id: caller.userId,
          school_id: caller.schoolId ?? "",
          role: caller.role,
        },
      });
      customerId = customer.id;
      const { error: insErr } = await admin.from("billing_customers").insert({
        user_id: caller.userId,
        school_id: caller.schoolId,
        stripe_customer_id: customerId,
        role: caller.role,
      });
      if (insErr) {
        if (insErr.code === "23505") {
          // Raced with another request — use the stored one and discard ours.
          const { data: winner } = await admin
            .from("billing_customers")
            .select("stripe_customer_id")
            .eq("user_id", caller.userId)
            .maybeSingle();
          if (winner?.stripe_customer_id) customerId = winner.stripe_customer_id;
          else throw new Error("billing_customers race resolved to no row.");
        } else {
          // Fail closed: never charge without a customer↔user mapping, or the
          // webhook can't attribute the payment.
          throw new Error(`billing_customers insert failed: ${insErr.message}`);
        }
      }
    }

    // MYR hard gate — re-check the LIVE price, not just our config.
    const price = await s.prices.retrieve(priceIdFor(plan));
    assertMyrPrice(price);

    const appUrl = process.env.APP_URL || "https://app.sketchcast.app";
    // Adults land back on their own surface (parents have no library).
    const backPath = caller.role === "parent" ? "/dashboard/children" : "/dashboard";
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
        // Dedupe accidental double-submits without blocking a genuine retry
        // a few minutes later.
        idempotencyKey: `checkout_${caller.userId}_${plan.key}_${Math.floor(Date.now() / 300_000)}`,
      },
    );

    console.log("billing.checkout.created", { session: session.id, plan: plan.key, user: caller.userId });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    if (e instanceof BillingGuardError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("billing.checkout.error", (e as Error).message);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 500 });
  }
}
