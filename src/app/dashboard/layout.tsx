import { redirect } from "next/navigation";
import { after } from "next/server";
import { headers } from "next/headers";
import { createClient, currentUser } from "@/utils/supabase/server";
import { onboardingEnabled, skShellEnabledFor } from "@/utils/flags";
import { claimLsPurchases } from "@/utils/lemonsqueezy/claim";
import { stampAssumedCountry } from "@/utils/assumed-country";
import { assertAdultRole } from "@/utils/stripe/guards";
import { activeHatCookie } from "@/utils/hats-server";
import AssistantLauncher from "./assistant-launcher";
import SkLauncher from "./sk-launcher";
import { SkHomeProvider } from "./sk-home";
import TourProvider from "@/tour/TourProvider";
import { tourForRole } from "@/tour/definitions";
import { shouldAutoStart } from "@/tour/logic";
import type { TourSeen } from "@/tour/types";
import { SK_INTRO_TOUR, isHardReload } from "@/sk/shell/tour";
import { skDebugFor } from "@/sk/shell/routing";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// Mounts, once for every dashboard surface: the onboarding TourProvider (which
// wraps the page tree so the header's "Take a tour" button can drive it) and the
// floating AI Teaching Assistant launcher. The tour's role + versioned seen-state
// are resolved here, server-side, and handed to the client provider; both degrade
// to "nothing" if the user is signed out or the 0037 tables aren't applied yet.
//
// SPEED (2026-10-30): this runs on every dashboard page, before anything below
// it can paint, so its round trips are kept to the ones that decide something:
// the user (shared with the page via currentUser), the profile (the onboarding
// gate), then ONE parallel wave for the tour state and the SK gates. The two
// WRITES (country stamp, Lemon Squeezy claim) start at the same point as before
// but are no longer waited on — after() keeps the request alive until they
// settle. The dictionary loads alongside all of it.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The tour's words are needed whatever happens below — fetch them now.
  const dictP = resolveLocale().then(getDictionary);
  dictP.catch(() => {}); // awaited below; a redirect() in between must not leave it unhandled
  const [supabase, user] = await Promise.all([createClient(), currentUser()]);

  let role: string | null = null;
  let seen: TourSeen | null = null;
  // SK Shell (S0): on only when every gate in skShellEnabledFor() passes; the
  // §4.6 intro is due until a user_tour_progress("sk-intro") row carries the
  // current SK_INTRO_TOUR.version (same shouldAutoStart rule as the tours).
  let skOn = false;
  let skIntroDue = false;
  // A tester's hard refresh (SK_DEBUG_EMAILS + Ctrl+Shift+R) replays the
  // first-login walkthrough from stop 1 (src/sk/shell/tour.ts isHardReload).
  let skReplay = false;
  let hat: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, onboarded_at, school_id")
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
    //
    // OFF THE CRITICAL PATH (2026-10-30): started here, exactly where it was
    // awaited before (so it reads this request's headers during the render),
    // and handed to after() rather than awaited. It never throws.
    after(stampAssumedCountry(supabase, user.id));

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
    // OFF THE CRITICAL PATH (2026-10-30): the claim starts here as before but
    // is handed to after(), which holds the request open until it lands. The
    // page already rendered CONCURRENTLY with this layout (Next renders a
    // layout and its page in parallel), so the Library never had a guarantee
    // of seeing a claim made in the same request; credits still bind on this
    // load, and buy-credits-return's router.refresh() shows them.
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
      after(claimLsPurchases(user.id, user.email));
    }

    // Both tours' seen-state — the role tour's and SK's intro — in ONE read of
    // the caller's own user_tour_progress rows (RLS), started now so it runs
    // alongside the SK gates instead of after them. Best-effort: a missing 0037
    // table just returns an error → no rows → seen stays null.
    const def = tourForRole(role);
    const schoolId = (profile?.school_id as string | null | undefined) ?? null;
    const tourKeys = def ? [def.key, SK_INTRO_TOUR.key] : [SK_INTRO_TOUR.key];
    const progP = (async () => {
      const { data } = await supabase
        .from("user_tour_progress")
        .select("tour_key, version, status")
        .in("tour_key", tourKeys);
      return (data ?? []) as { tour_key: string; version: number; status: "completed" | "skipped" }[];
    })();
    const seenFor = (rows: Awaited<typeof progP>, key: string): TourSeen | null => {
      const row = rows.find((r) => r.tour_key === key);
      return row ? { version: row.version as number, status: row.status } : null;
    };

    // SK Shell gates, through the caller's own session (the school-config read
    // inside is RLS-scoped). Nothing here can throw: a missing schools.config
    // or a database behind on 0162 simply reads as "not opted in".
    skOn = await skShellEnabledFor(supabase, user, role, schoolId);
    const progRows = await progP;
    if (def) seen = seenFor(progRows, def.key);
    if (skOn) {
      hat = await activeHatCookie();
      const skSeen: TourSeen | null = seenFor(progRows, SK_INTRO_TOUR.key);
      skIntroDue = shouldAutoStart(skSeen, SK_INTRO_TOUR.version);
      skReplay = skDebugFor(user.email) && isHardReload(await headers());
    }
  }

  // The tour's WORDS (definitions.ts carries only its targets and order), so a
  // parent taking the tour reads it in the language the rest of the app is in.
  // (Started at the top; resolveLocale is React-cached per request.)
  const t = await dictP;

  return (
    // 2026-10-30 (founder decision 1): for SK users the SK walkthrough REPLACES
    // the driver.js role tour — no auto-start, and the header's 🧭 starts SK's.
    <TourProvider role={role} seen={seen} copy={t.app.tour} skWalkthrough={skOn}>
      {/* 2026-10-30: SK is the corner avatar (sk-launcher.tsx) on every page;
          this hands THIS layout's skOn decision down (sk-home.tsx useSkOn) —
          nothing below adds a gate of its own. */}
      <SkHomeProvider on={skOn}>
        {children}
        {/* A principal (school_admin) doesn't teach from books — no teaching
            Assistant. Everyone else keeps it; the launcher also hides itself on
            the leadership School pages, where the School-briefing bot takes over
            the bottom-right slot. */}
        {role !== "school_admin" && (
          <AssistantLauncher t={{ ...t.school.assistant, close: t.common.close }} hidden={skOn} />
        )}
        {/* SK Shell (S0): the portal-wide companion, in the same corner — so the
            Assistant above is handed `hidden` whenever this one renders. */}
        {skOn && <SkLauncher copy={t.sk.shell} walkCopy={t.sk.walkthrough} role={role} hat={hat} introDue={skIntroDue || skReplay} replay={skReplay} />}
      </SkHomeProvider>
    </TourProvider>
  );
}
