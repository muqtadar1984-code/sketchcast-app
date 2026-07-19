import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parentPortalEnabled, roleHatsEnabled, schoolAnalyticsEnabledFor, timetableEnabledFor } from "./flags";
import { HAT_COOKIE, isHat, type Hat } from "./hats";

// Server-side half of the hat model: read the cookie, verify a hat is actually
// held, and decide when a page should bounce the user to their active hat's
// home. Pages call enforceHat() with the surface they belong to; everything
// stays presentation-level — a wrong or stale cookie never grants anything,
// it just fails to redirect and the page's own auth gates take over.
//
// LOOP-SAFETY INVARIANT: enforceHat may only redirect to a page that ACCEPTS
// the verified hat. That's why validity and home are analytics-aware — e.g.
// when a tenant's leadership suite is off, /dashboard/school bounces everyone
// to /dashboard, so the principal hat's home must fall back to /dashboard/invites
// (which has no analytics gate) and the coordinator hat isn't valid at all.

/** The raw active-hat cookie, or null when the feature is off / unset. */
export async function activeHatCookie(): Promise<Hat | null> {
  if (!roleHatsEnabled()) return null;
  const store = await cookies();
  const v = store.get(HAT_COOKIE)?.value;
  return isHat(v) ? v : null;
}

/** Does this user actually hold (and can meaningfully wear) the hat? */
export async function verifyHat(
  supabase: SupabaseClient,
  role: string | null,
  schoolId: string | null,
  hat: Hat,
): Promise<boolean> {
  if (!role || role === "student") return false;
  if (hat === "teacher") return true; // every adult teaches
  if (hat === "principal") return role === "school_admin";
  if (hat === "coordinator") {
    // Meaningful only where a leadership surface exists — analytics OR the
    // timetable (otherwise its home doesn't accept it — see the invariant).
    if (!schoolId) return false;
    const analyticsOn = await schoolAnalyticsEnabledFor(supabase, schoolId);
    if (!analyticsOn && !(await timetableEnabledFor(supabase, schoolId))) return false;
    // RLS cs_self_read + school filter: only grants in the CURRENT school count
    // (a stale grant from a school this user has left must not verify the hat).
    const { data } = await supabase.from("coordinator_scope").select("id").eq("school_id", schoolId).limit(1);
    return (data?.length ?? 0) > 0;
  }
  // parent
  if (!parentPortalEnabled()) return false;
  const { data } = await supabase.from("parent_links").select("id").limit(1);
  return (data?.length ?? 0) > 0;
}

/** Where a verified hat lands — flag-aware (see invariant above). */
export async function hatHome(supabase: SupabaseClient, schoolId: string | null, hat: Hat): Promise<string> {
  if (hat === "parent") return "/dashboard/children";
  if (hat === "teacher") return "/dashboard";
  if (hat === "coordinator") {
    // Valid only when analytics OR timetable is on; land on whichever exists.
    return (await schoolAnalyticsEnabledFor(supabase, schoolId)) ? "/dashboard/school" : "/dashboard/school/timetable";
  }
  // Principal: analytics home first, the timetable when only that surface is
  // on, and the (parent-)invites page as the legacy last resort — it still
  // accepts the principal hat, keeping the loop-safety invariant.
  if (await schoolAnalyticsEnabledFor(supabase, schoolId)) return "/dashboard/school";
  if (await timetableEnabledFor(supabase, schoolId)) return "/dashboard/school/timetable";
  return "/dashboard/invites";
}

export type HatDomain = "teacher" | "leadership" | "principal" | "parent";

/**
 * Returns the path to redirect to when the user's ACTIVE hat doesn't belong on
 * this surface, or null to render normally. Only redirects on a VERIFIED hat —
 * a stale cookie (e.g. a revoked coordinator grant) simply doesn't redirect,
 * avoiding bounce loops, and the page's own auth gates still apply.
 */
export async function enforceHat(
  supabase: SupabaseClient,
  role: string | null,
  schoolId: string | null,
  domain: HatDomain,
): Promise<string | null> {
  if (!role || role === "student") return null; // students have no hats
  const hat = await activeHatCookie();
  if (!hat) return null;
  const fits =
    domain === "teacher"
      ? // Parent-role accounts live in ONE merged world: their (only) parent
        // hat includes the Library and analytics, so teacher surfaces accept
        // it. Multi-role adults wearing the parent hat still bounce — their
        // teacher world is a separate hat.
        hat === "teacher" || (hat === "parent" && role === "parent")
      : domain === "leadership"
        ? hat === "principal" || hat === "coordinator"
        : domain === "principal"
          ? hat === "principal"
          : hat === "parent";
  if (fits) return null;
  if (!(await verifyHat(supabase, role, schoolId, hat))) return null;
  return hatHome(supabase, schoolId, hat);
}
