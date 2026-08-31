import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { onboardingEnabled } from "@/utils/flags";
import { claimLsPurchases } from "@/utils/lemonsqueezy/claim";
import { stampAssumedCountry } from "@/utils/assumed-country";
import { assertAdultRole } from "@/utils/stripe/guards";
import AssistantLauncher from "./assistant-launcher";
import TourProvider from "@/tour/TourProvider";
import { tourForRole } from "@/tour/definitions";
import type { TourSeen } from "@/tour/types";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// Mounts, once for every dashboard surface: the onboarding TourProvider (which
// wraps the page tree so the header's "Take a tour" button can drive it) and the
// floating AI Teaching Assistant launcher. The tour's role + versioned seen-state
// are resolved here, server-side, and handed to the client provider; both degrade
// to "nothing" if the user is signed out or the 0037 tables aren't applied yet.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role: string | null = null;
  let seen: TourSeen | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, onboarded_at")
      .eq("id", user.id)
      .maybeSingle();
    // Blocking new-joiner gate: an adult self-signup that was never onboarded is
    // sent to /onboarding to confirm Teacher/Parent + fill the required fields,
    // so nobody uses the app as a silently-defaulted teacher. Exemptions:
    //  • students — provisioned/self-signup as "student"; they have their own
    //    (must_reset_password) first-run flow on the page and no picker option, so
    //    forcing them here would trap them.
    //  • deliberately-provisioned adults (invited teacher/coordinator/admin,
    //    school_admin) — those flows stamp onboarded_at at creation, so they never
    //    reach here.
    // `profile == null` (0038 not applied, or row missing) falls through untouched.
    if (
      onboardingEnabled() &&
      profile &&
      profile.onboarded_at == null &&
      profile.role !== "student"
    ) {
      redirect("/onboarding");
    }
    role = (profile?.role as string | null) ?? null;

    // Backstop the country capture (0098) for every account that predates it,
    // and for anyone the trigger couldn't reach. Placed BELOW the redirect for
    // the same reason the claim below is — redirect() throws, and nothing
    // should sit between that decision and the throw.
    //
    // Not read-then-written, and deliberately not folded into the profile read
    // above: the helper's own `.is("country", null)` filter is the guard, so a
    // stated country can never be clobbered, and the gate's query keeps working
    // unchanged on a database behind on 0085. The cost of asking every time is
    // one primary-key UPDATE matching zero rows on a hard load — a shared
    // layout does not re-run on soft navigation (see the note below).
    if (user) await stampAssumedCountry(supabase, user.id);

    // Bind any Lemon Squeezy purchase parked under this verified email. A
    // public-link checkout carries no custom_data, so the webhook can only park
    // the sale by the buyer's email and claim.ts is what binds it.
    //
    // THIS IS THE ONLY CALL SITE THAT ACTUALLY RUNS for a password sign-in, and
    // that is the whole point of it being here. The two that existed could not:
    // /api/billing/status has ZERO callers anywhere in src (a live endpoint
    // nothing fetches), and /auth/callback bails out before the claim unless a
    // PKCE `code` is present, making it OAuth-only. A real buyer was charged in
    // production (LS order 9251234), the row landed parked, and the credits
    // never bound. This layout wraps EVERY authenticated adult surface, so it is
    // the first server render after any sign-in, by any method.
    //
    // ORDERING — deliberately BELOW the /onboarding redirect, and that is a
    // decision, not an accident. redirect() works by THROWING NEXT_REDIRECT, so
    // any awaited work inserted above it both delays every onboarding bounce and
    // puts foreign code between the decision and the throw. Nothing is lost by
    // claiming after: an un-onboarded adult is sent to /onboarding and comes
    // straight back through this same layout the moment they finish, the claim
    // is idempotent, and it simply lands one navigation later. Credits arriving
    // a redirect late is strictly better than risking the onboarding gate.
    //
    // ADULTS ONLY, via the billing guard's own notion of "adult" rather than a
    // second copy of that list drifting out of sync with it. assertAdultRole
    // signals by throwing (it guards route handlers), so it is converted to a
    // boolean here — the layout must not throw.
    //
    // VERIFIED EMAIL ONLY: a buyer can type any address at LS checkout, so the
    // binding key is trustworthy only once Supabase has confirmed the account
    // holder controls it. Same precedent as /auth/callback.
    //
    // NOTHING HERE CAN THROW. claimLsPurchases is total — it returns 0 rather
    // than raising, including when the service-role client cannot be built
    // (that gap was closed in claim.ts on 2026-08-19, precisely because this
    // call site is a page render and not a route handler).
    //
    // COST, per FULL document load, in the steady state where nothing is
    // parked: two reads that return no rows, and zero writes. The
    // credit_purchases probe is index-covered (credit_purchases_claim_idx
    // (claim_email) WHERE owner_id IS NULL). The subscriptions probe is NOT,
    // and saying otherwise would mislead the next reader: 0023's index is on
    // lower(claim_email) and .eq() emits a bare-column equality the planner
    // cannot match to it, so that read is a SEQ SCAN until 0092 adds the
    // plain-column index — one more reason to apply 0092 before this ships.
    // Writes happen only when there is genuinely a purchase to bind.
    //
    // A SHARED LAYOUT DOES NOT RE-RUN ON SOFT NAVIGATION. Next.js preserves this
    // segment across client-side navigations, so the claim fires on sign-in and
    // on any hard load, but NOT when a buyer returns to a still-open app tab
    // from the target="_blank" checkout tab and clicks around. That case is
    // covered from the client instead — dashboard/buy-credits-return.tsx calls
    // router.refresh() when the tab regains focus after a buy chip was clicked,
    // which re-renders this layout on the server and lands here.
    let adult = false;
    try {
      assertAdultRole(role);
      adult = true;
    } catch {
      adult = false; // student, or no profile role — never claims a purchase
    }
    if (adult && user.email && user.email_confirmed_at) {
      await claimLsPurchases(user.id, user.email);
    }

    const def = tourForRole(role);
    if (def) {
      // Best-effort: a missing 0037 table just returns an error → seen stays null.
      const { data: prog } = await supabase
        .from("user_tour_progress")
        .select("version, status")
        .eq("tour_key", def.key)
        .maybeSingle();
      if (prog) seen = { version: prog.version as number, status: prog.status as "completed" | "skipped" };
    }
  }

  // The tour's WORDS (definitions.ts carries only its targets and order), so a
  // parent taking the tour reads it in the language the rest of the app is in.
  const t = await getDictionary(await resolveLocale());

  return (
    <TourProvider role={role} seen={seen} copy={t.app.tour}>
      {children}
      {/* A principal (school_admin) doesn't teach from books — no teaching
          Assistant. Everyone else keeps it; the launcher also hides itself on
          the leadership School pages, where the School-briefing bot takes over
          the bottom-right slot. */}
      {role !== "school_admin" && (
        <AssistantLauncher t={{ ...t.school.assistant, close: t.common.close }} />
      )}
    </TourProvider>
  );
}
