// Resolve the billing caller SERVER-SIDE from the Supabase session — role and
// school are read from the database, never trusted from the request body.

import { createClient } from "@/utils/supabase/server";
import { BillingGuardError } from "./guards";

export type BillingCaller = {
  userId: string;
  email: string | null;
  /** true only when Supabase has confirmed this email — required before we may
   * claim an LS purchase parked under it (a buyer can type any email at LS). */
  emailVerified: boolean;
  role: string;
  schoolId: string | null;
  school: { billing_enabled: boolean | null } | null;
};

export async function resolveBillingCaller(): Promise<BillingCaller> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new BillingGuardError("Not signed in.", 401);

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.role) throw new BillingGuardError("No profile.", 403);

  let school: { billing_enabled: boolean | null } | null = null;
  if (profile.school_id) {
    const { data: s } = await supabase
      .from("schools")
      .select("billing_enabled")
      .eq("id", profile.school_id)
      .maybeSingle();
    school = (s as { billing_enabled: boolean | null } | null) ?? null;
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    emailVerified: Boolean(user.email_confirmed_at),
    role: profile.role as string,
    schoolId: (profile.school_id as string | null) ?? null,
    school,
  };
}
