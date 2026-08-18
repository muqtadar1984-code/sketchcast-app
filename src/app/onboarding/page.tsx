import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { onboardingEnabled } from "@/utils/flags";
import { seedRole, homeForRole, type OnboardingRole } from "@/utils/onboarding";
import OnboardingForm from "./onboarding-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// The blocking new-joiner step. A signed-in user whose profile has never been
// onboarded (onboarded_at IS NULL) is funnelled here by the dashboard layout to
// CONFIRM whether they're a Teacher or Parent and fill a short profile, so nobody
// runs the app as a silently-defaulted teacher. Once done, /api/onboarding stamps
// onboarded_at and the gate never fires again.
export default async function OnboardingPage() {
  // Flag off → this route shouldn't be reachable; send them home rather than 404.
  if (!onboardingEnabled()) redirect("/dashboard");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name, onboarded_at")
    .eq("id", user.id)
    .maybeSingle();

  // Already onboarded (or 0038 not applied so the column reads back as set) — don't
  // trap them on this page; send them to their role's home. A home-educator
  // parent (0087) homes on the Library; separate best-effort query so a
  // pre-0087 database can't break the main select above.
  if (!profile || profile.onboarded_at != null) {
    const { data: he } = await supabase
      .from("profiles")
      .select("home_educator")
      .eq("id", user.id)
      .maybeSingle();
    const homeEducator = (he as { home_educator?: boolean | null } | null)?.home_educator === true;
    redirect(homeForRole(seedRole((profile?.role as string | null) ?? null), { homeEducator }));
  }

  // Students are never routed here (the gate exempts them); if one somehow lands,
  // bounce to the dashboard rather than forcing a teacher/parent pick.
  if (profile.role === "student") redirect("/dashboard");

  const seed: OnboardingRole = seedRole((profile.role as string | null) ?? null);
  const initialName = ((profile.full_name as string | null) ?? "").trim();

  const locale = await resolveLocale();
  const t = await getDictionary(locale);

  return (
    <OnboardingForm seedRole={seed} initialName={initialName} locale={locale} t={t.app.onboarding} common={t.common} />
  );
}
