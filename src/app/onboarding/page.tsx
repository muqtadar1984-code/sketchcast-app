import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { onboardingEnabled } from "@/utils/flags";
import { seedRole, homeForRole, type OnboardingRole } from "@/utils/onboarding";
import OnboardingForm from "./onboarding-form";

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
  // trap them on this page; send them to their role's home.
  if (!profile || profile.onboarded_at != null) {
    redirect(homeForRole(seedRole((profile?.role as string | null) ?? null)));
  }

  // Students are never routed here (the gate exempts them); if one somehow lands,
  // bounce to the dashboard rather than forcing a teacher/parent pick.
  if (profile.role === "student") redirect("/dashboard");

  const seed: OnboardingRole = seedRole((profile.role as string | null) ?? null);
  const initialName = ((profile.full_name as string | null) ?? "").trim();

  return <OnboardingForm seedRole={seed} initialName={initialName} />;
}
