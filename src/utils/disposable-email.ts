// Disposable-address pre-check for the signup forms — the FRIENDLY half of
// migration 0117.
//
// The hard gate is the database: a BEFORE INSERT trigger on auth.users refuses
// any address whose domain is in public.disposable_email_domains, so a burner
// cannot become an account no matter who calls GoTrue. But a trigger's RAISE
// reaches the browser only as "Database error saving new user", which tells a
// person nothing. So the forms ask the SAME rule first — email_domain_is_disposable
// is the one function the trigger uses, granted to anon for exactly this — and
// show a sentence in the reader's language instead.
//
// Fail OPEN on purpose: if the RPC itself errors (network, a DB not yet
// migrated), the form proceeds to signUp and the trigger still decides. A
// pre-check that could block a legitimate signup on its own outage would be a
// second gate, and there must be only one.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function isDisposableEmail(supabase: SupabaseClient, email: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("email_domain_is_disposable", { p_email: email });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
