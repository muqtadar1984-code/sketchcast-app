import type Stripe from "stripe";
import type { createAdminClient } from "@/utils/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

// One Stripe Customer per account, remembered in billing_customers. THIS ROW
// IS THE WEBHOOK'S TRUST ANCHOR: verifiedIdentity() cross-checks every Stripe
// object's customer against it and silently skips on a mismatch, so anything
// that creates a Stripe object for a user — checkout, a console-issued
// invoice — must go through here FIRST, or the money arrives and nothing
// activates. Lifted out of the checkout route (Phase 4) so the invoice path
// cannot drift from it.
export async function ensureStripeCustomer(
  admin: Admin,
  s: Stripe,
  who: { userId: string; schoolId: string | null; email: string | null | undefined; role: string },
): Promise<string> {
  const { data: existing } = await admin
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", who.userId)
    .eq("provider", "stripe")
    .maybeSingle();
  const known = existing?.stripe_customer_id as string | undefined;
  if (known) return known;

  const customer = await s.customers.create({
    email: who.email ?? undefined,
    metadata: { user_id: who.userId, school_id: who.schoolId ?? "", role: who.role },
  });
  const { error: insErr } = await admin.from("billing_customers").insert({
    user_id: who.userId,
    school_id: who.schoolId,
    provider: "stripe",
    stripe_customer_id: customer.id,
    role: who.role,
  });
  if (!insErr) return customer.id;
  if (insErr.code === "23505") {
    // Two requests raced; the first insert wins and its customer is the one
    // the webhook will recognise. The customer created above is an orphan on
    // Stripe's side (harmless — never charged, never mapped).
    const { data: winner } = await admin
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", who.userId)
      .eq("provider", "stripe")
      .maybeSingle();
    if (winner?.stripe_customer_id) return winner.stripe_customer_id as string;
    throw new Error("billing_customers race resolved to no row.");
  }
  // Fail closed: never charge without a customer↔user mapping, or the
  // webhook can't attribute the payment.
  throw new Error(`billing_customers insert failed: ${insErr.message}`);
}
