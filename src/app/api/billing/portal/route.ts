import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { stripe } from "@/utils/stripe/client";
import { assertAdultRole, assertBillingEnabled, BillingGuardError } from "@/utils/stripe/guards";
import { resolveBillingCaller } from "@/utils/stripe/caller";

export const runtime = "nodejs";

// Stripe Billing Customer Portal session: parents/teachers update their card,
// view invoices, cancel their own subscription — all on Stripe's hosted
// surface. We only mint the redirect URL for the caller's OWN customer.

export async function POST() {
  try {
    const caller = await resolveBillingCaller();
    assertAdultRole(caller.role);
    assertBillingEnabled(caller.school);

    const admin = createAdminClient();
    // The row is already the caller's OWN customer (filtered by user_id) — no
    // tenant check needed. A stale school snapshot must NOT lock an adult out
    // of the only self-service cancel / card-update surface after a school move.
    const { data: row } = await admin
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", caller.userId)
      .maybeSingle();
    if (!row?.stripe_customer_id) {
      return NextResponse.json({ error: "No billing account yet." }, { status: 404 });
    }

    const appUrl = process.env.APP_URL || "https://app.sketchcast.app";
    const backPath = caller.role === "parent" ? "/dashboard/children" : "/dashboard";
    const session = await stripe().billingPortal.sessions.create({
      customer: row.stripe_customer_id,
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
