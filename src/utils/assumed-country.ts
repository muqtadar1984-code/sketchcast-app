import "server-only";
import { headers } from "next/headers";
import type { createClient } from "@/utils/supabase/server";
import { countryFromHeaders } from "@/utils/geo";

// Fills in profiles.country for a signed-in user who hasn't got one — the
// backstop behind 0098's trigger.
//
// The trigger covers every path that creates an account with metadata we
// control (the email signup form, admin.createUser for provisioned students).
// Two paths it cannot cover reach this instead:
//
//   • Google OAuth, where raw_user_meta_data comes from Google and carries no
//     country — /auth/callback calls this straight after the code exchange.
//   • every account that already existed before 0098 — the dashboard layout
//     calls this on the first authenticated render, so the 12 students and 3
//     dormant adults measured on 2026-08-31 get a country the next time any of
//     them signs in. There is nothing to be done for one who never returns:
//     Supabase prunes auth.audit_log_entries, so no IP survives to geolocate.
//
// Two properties matter more than anything else here.
//
// IT CAN NEVER OVERWRITE A STATED ANSWER. The update carries `.is("country",
// null)`, so the filter — not a read-then-write in application code — is what
// guarantees it. A user who chose their country at onboarding, or one a staff
// member corrected from the console, is untouchable by this even if it runs
// concurrently with their write.
//
// IT CAN NEVER BREAK THE PAGE. Every caller is on a hot path (the layout wraps
// every authenticated surface; the callback is the last step of signing in). A
// missing header, a pre-0085 database, a Supabase blip — all of them mean "we
// still don't know where they are", which is precisely the state we were
// already in.

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * Stamp an assumed country on `userId` IF the row has none. Silent no-op when
 * the edge can't place the request. Never throws.
 *
 * The write goes through the CALLER'S authenticated session: 0085 granted
 * update(country, country_source) to `authenticated`, and the
 * profiles_update_self row policy confines it to their own row — the same
 * posture /api/onboarding and /api/locale use. No service role is involved, so
 * this cannot touch anybody else's profile.
 */
export async function stampAssumedCountry(supabase: Client, userId: string): Promise<void> {
  try {
    const country = countryFromHeaders(await headers());
    if (!country) return;
    const { error } = await supabase
      .from("profiles")
      .update({ country, country_source: "assumed" })
      .eq("id", userId)
      .is("country", null);
    // 42703 (no column) / 42501 (no grant) on a database behind on 0085. Worth
    // a line in the log, never worth a failed sign-in.
    if (error) console.error("country.assumed:", error.code, error.message);
  } catch {
    // Never take a sign-in or a dashboard render down for a guess.
  }
}
