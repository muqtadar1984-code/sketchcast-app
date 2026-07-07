import { NextResponse } from "next/server";
import { getEntitlement } from "@/utils/stripe/entitlements";
import { assertAdultRole, assertBillingEnabled, BillingGuardError } from "@/utils/stripe/guards";
import { resolveBillingCaller } from "@/utils/stripe/caller";
import { claimLsPurchases } from "@/utils/lemonsqueezy/claim";

export const runtime = "nodejs";

// Current entitlement for the signed-in adult. The app gates paid features on
// THIS (the entitlements table) — never by calling Stripe inline.

export async function GET() {
  try {
    const caller = await resolveBillingCaller();
    assertAdultRole(caller.role);
    assertBillingEnabled(caller.school);

    // Reconcile any LS purchase bought from the public pricing page and parked
    // under this (verified) email before reading — so a marketing-page buyer
    // gets access the first time the app checks their status. Cheap no-op when
    // there is nothing parked; never throws.
    if (caller.emailVerified) {
      await claimLsPurchases(caller.userId, caller.email);
    }

    const entitlement = await getEntitlement(caller.userId);
    return NextResponse.json(entitlement);
  } catch (e) {
    if (e instanceof BillingGuardError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("billing.status.error", (e as Error).message);
    return NextResponse.json({ error: "Could not read billing status." }, { status: 500 });
  }
}
