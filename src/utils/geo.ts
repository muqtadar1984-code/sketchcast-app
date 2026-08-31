// Where the CDN says this request came from — the ONLY country signal available
// before a user has told us anything.
//
// This exists because country was captured in exactly one place (the blocking
// onboarding step) and therefore only ever existed for people who FINISHED it.
// Measured in prod 2026-08-31: 63/63 onboarded adults had a country and 19
// other rows had none — 12 self-signup students (deliberately exempt from the
// onboarding gate), 4 adults who abandoned the form, and 3 who never signed in
// at all. None of those can be recovered retroactively: Supabase prunes
// auth.audit_log_entries, which was empty, so no IP survives anywhere.
//
// Everything derived from this header is written as country_source='assumed'
// (0085), rendered "≈ EG" on the console, and is overwritten the moment the
// user states their own on the onboarding step. A guess we can SEE is the point;
// a guess indistinguishable from an answer is what 0085 exists to prevent.
//
// PURE — takes a Headers, returns a code or null. No next/*, no DB, so the
// signup page, the OAuth callback, the students route and the tests can all use
// the same rule.

import { isCountryCode } from "@/utils/countries";

/** The edge headers that carry a two-letter country, best first. Vercel is the
 * host; the Cloudflare one is read too because the landing site sits behind
 * Cloudflare and a future proxy in front of the app would otherwise silently
 * stop the capture. */
const GEO_HEADERS = ["x-vercel-ip-country", "cf-ipcountry"] as const;

/**
 * The request's country as an assigned ISO 3166-1 alpha-2 code, or null.
 *
 * Null is a completely ordinary answer and every caller must treat it as one:
 * localhost sends no such header, and the edge emits placeholders for addresses
 * it cannot place ("XX" unknown, "T1" Tor). Those fail isCountryCode along with
 * anything else unassigned, so no junk can reach the column — the placeholders
 * need no special case, they simply aren't countries.
 */
export function countryFromHeaders(h: Headers): string | null {
  for (const name of GEO_HEADERS) {
    const raw = h.get(name);
    if (!raw) continue;
    const code = raw.trim().toUpperCase();
    if (isCountryCode(code)) return code;
  }
  return null;
}
