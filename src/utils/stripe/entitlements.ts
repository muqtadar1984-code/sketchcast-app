// Entitlements are THE single source of truth for paid access. The app reads
// this table (written only by the webhook/checkout server code) and never
// calls Stripe inline to decide access.
//
// An account is entitled when it has an active/trialing subscription OR a
// valid one-time purchase whose licence window hasn't ended. `past_due` keeps
// access (grace) until Stripe transitions the subscription to canceled/unpaid.

import { createAdminClient } from "@/utils/supabase/admin";

export type Entitlement = {
  active: boolean;
  plan_key: string | null;
  status: string | null;
  current_period_end: string | null;
};

const NONE: Entitlement = { active: false, plan_key: null, status: null, current_period_end: null };

/** Pure derivation — unit-testable. `active` in the ROW is what the webhook
 * decided; this re-checks the period end so an expired row reads inactive
 * even before the next webhook arrives. */
export function deriveActive(
  row: { active: boolean; status: string | null; current_period_end: string | null } | null,
  now: Date,
): boolean {
  if (!row || !row.active) return false;
  if (row.current_period_end && new Date(row.current_period_end).getTime() < now.getTime()) {
    return false;
  }
  return true;
}

/** The one server helper the app gates paid features on. A user may hold
 * several plan rows (per-plan keying) — return the first that's currently
 * active, else the most recent row's shape as inactive. */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("entitlements")
    .select("active, plan_key, status, current_period_end")
    .eq("user_id", userId)
    .order("current_period_end", { ascending: false, nullsFirst: false });
  const rows = (data ?? []) as { active: boolean; plan_key: string | null; status: string | null; current_period_end: string | null }[];
  const now = new Date();
  const hit = rows.find((r) => deriveActive(r, now));
  if (hit) {
    return { active: true, plan_key: hit.plan_key, status: hit.status, current_period_end: hit.current_period_end };
  }
  return NONE;
}

/** School-wide entitlement: any active school_* plan bought for this school
 * (the purchasing admin holds the row). */
export async function getSchoolEntitlement(schoolId: string): Promise<Entitlement> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("entitlements")
    .select("active, plan_key, status, current_period_end")
    .eq("school_id", schoolId)
    .in("plan_key", ["school_annual", "school_onetime"]);
  const now = new Date();
  const hit = (data ?? []).find((r) => deriveActive(r, now));
  if (!hit) return NONE;
  return {
    active: true,
    plan_key: hit.plan_key ?? null,
    status: hit.status ?? null,
    current_period_end: hit.current_period_end ?? null,
  };
}
