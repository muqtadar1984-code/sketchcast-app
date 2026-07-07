// Claim-on-sign-in: bind any Lemon Squeezy subscriptions that were bought from
// the public pricing page (parked "unclaimed" by the buyer's email) to the
// account holder once they are authenticated with that same VERIFIED email —
// and only then create the entitlement that grants access.
//
// SECURITY: the caller MUST pass the Supabase-verified session email (never a
// value from the request body). A buyer can type any email at LS checkout, so
// binding happens only when the real account holder proves control of the email
// by signing in with it. Emails are stored lower-cased on both sides, so this is
// an exact match — no wildcard/ilike surprises.

import { createAdminClient } from "@/utils/supabase/admin";
import { lsActiveFromStored } from "./handlers";

// Minimal shape of the (Supabase) query client we use — injectable for tests.
type ClaimFilter<T> = {
  eq(col: string, v: unknown): ClaimFilter<T>;
  is(col: string, v: unknown): ClaimFilter<T>;
} & PromiseLike<T>;
export type ClaimDb = {
  from(table: string): {
    select(cols: string): ClaimFilter<{ data: Record<string, unknown>[] | null }>;
    update(row: Record<string, unknown>): ClaimFilter<{ error: { message: string } | null }>;
    upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
  };
};

type ParkedSub = {
  ls_subscription_id: string;
  plan_key: string | null;
  status: string | null;
  current_period_end: string | null;
};

/** Caller entry point — creates the service-role client and reconciles. */
export async function claimLsPurchases(userId: string | null | undefined, verifiedEmail: string | null | undefined): Promise<number> {
  return claimLsPurchasesWith(createAdminClient() as unknown as ClaimDb, userId, verifiedEmail);
}

/** Testable core. Returns the number of subscriptions claimed (0 when there is
 * nothing to do — the cheap common case). Never throws: reconciliation must not
 * break sign-in or a billing-status read. */
export async function claimLsPurchasesWith(db: ClaimDb, userId: string | null | undefined, verifiedEmail: string | null | undefined): Promise<number> {
  const email = (verifiedEmail ?? "").trim().toLowerCase();
  if (!userId || !email) return 0;

  try {
    const { data } = await db
      .from("subscriptions")
      .select("ls_subscription_id, plan_key, status, current_period_end")
      .eq("provider", "lemonsqueezy")
      .is("user_id", null)
      .eq("claim_email", email);
    const parked = (data ?? []) as ParkedSub[];
    if (parked.length === 0) return 0;

    // Bind the customer mapping (portal URL etc.). Best-effort — access comes
    // from the subscription/entitlement below, so don't fail the claim on it.
    await db
      .from("billing_customers")
      .update({ user_id: userId })
      .eq("provider", "lemonsqueezy")
      .is("user_id", null)
      .eq("email", email);

    let claimed = 0;
    for (const s of parked) {
      // Race-safe: only take it if it's still unclaimed.
      const { error: subErr } = await db
        .from("subscriptions")
        .update({ user_id: userId, claim_email: null, updated_at: new Date().toISOString() })
        .eq("ls_subscription_id", s.ls_subscription_id)
        .is("user_id", null);
      if (subErr || !s.plan_key) continue;

      const active = lsActiveFromStored(s.status ?? "", s.current_period_end);
      const { error: entErr } = await db.from("entitlements").upsert(
        {
          user_id: userId,
          school_id: null, // personal (B2C) — never school-scoped
          provider: "lemonsqueezy",
          plan_key: s.plan_key,
          active,
          status: s.status,
          current_period_end: s.current_period_end,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,plan_key" },
      );
      if (!entErr) claimed++;
    }

    if (claimed > 0) console.log("billing.ls.claimed", { user: userId, count: claimed });
    return claimed;
  } catch (e) {
    console.error("billing.ls.claim_failed", { user: userId, err: (e as Error).message });
    return 0;
  }
}
