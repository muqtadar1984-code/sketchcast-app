import { NextResponse } from "next/server";
import { getSubscription } from "@lemonsqueezy/lemonsqueezy.js";
import { createAdminClient } from "@/utils/supabase/admin";
import { stripe } from "@/utils/stripe/client";
import { assertAdultRole, assertBillingEnabled, BillingGuardError } from "@/utils/stripe/guards";
import { resolveBillingCaller } from "@/utils/stripe/caller";
import { ensureLemonSqueezy } from "@/utils/lemonsqueezy/client";

export const runtime = "nodejs";

// Self-service billing management for the caller's OWN account. Dispatches by
// provider: Stripe Billing Portal for school plans, Lemon Squeezy Customer
// Portal for parent/teacher plans. We only ever open the caller's own
// customer (rows are filtered by user_id), so no tenant check is needed — and
// a stale school snapshot must never lock an adult out of cancelling.

export async function POST(request: Request) {
  try {
    const caller = await resolveBillingCaller();
    assertAdultRole(caller.role);
    assertBillingEnabled(caller.school);

    let requested: string | null = null;
    try {
      const body = (await request.json()) as { provider?: string };
      requested = body.provider ?? null;
    } catch {
      // no body → infer from what the caller has
    }

    const admin = createAdminClient();
    const { data: rows } = await admin
      .from("billing_customers")
      .select("provider, stripe_customer_id")
      .eq("user_id", caller.userId);
    const customers = (rows ?? []) as { provider: string; stripe_customer_id: string | null }[];
    if (customers.length === 0) {
      return NextResponse.json({ error: "No billing account yet." }, { status: 404 });
    }

    // Pick the provider: explicit request wins; else the single one they have;
    // else prefer Lemon Squeezy (the B2C case) when they hold both.
    const has = (p: string) => customers.some((c) => c.provider === p);
    const provider =
      requested && has(requested)
        ? requested
        : customers.length === 1
          ? customers[0].provider
          : has("lemonsqueezy")
            ? "lemonsqueezy"
            : "stripe";

    const appUrl = process.env.APP_URL || "https://app.sketchcast.app";
    const backPath = caller.role === "parent" ? "/dashboard/children" : "/dashboard";

    if (provider === "lemonsqueezy") {
      // Fetch a FRESH portal URL from the caller's own LS subscription (the
      // pre-signed URL expires in 24h, so never serve a cached one).
      const { data: sub } = await admin
        .from("subscriptions")
        .select("ls_subscription_id")
        .eq("user_id", caller.userId)
        .eq("provider", "lemonsqueezy")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!sub?.ls_subscription_id) {
        return NextResponse.json({ error: "No subscription to manage yet." }, { status: 404 });
      }
      ensureLemonSqueezy();
      const res = await getSubscription(sub.ls_subscription_id as string);
      const url = res.data?.data?.attributes?.urls?.customer_portal;
      if (res.error || !url) {
        return NextResponse.json({ error: "Could not open the billing portal." }, { status: 500 });
      }
      console.log("billing.ls.portal.opened", { user: caller.userId });
      return NextResponse.json({ url });
    }

    // Stripe
    const stripeRow = customers.find((c) => c.provider === "stripe");
    if (!stripeRow?.stripe_customer_id) {
      return NextResponse.json({ error: "No billing account yet." }, { status: 404 });
    }
    const session = await stripe().billingPortal.sessions.create({
      customer: stripeRow.stripe_customer_id,
      return_url: `${appUrl}${backPath}`,
    });
    console.log("billing.portal.created", { user: caller.userId });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    if (e instanceof BillingGuardError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("billing.portal.error", (e as Error).message);
    return NextResponse.json({ error: "Could not open the billing portal." }, { status: 500 });
  }
}
