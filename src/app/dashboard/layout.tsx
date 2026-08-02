import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { onboardingEnabled } from "@/utils/flags";
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
