import { createClient } from "@/utils/supabase/server";
import AssistantLauncher from "./assistant-launcher";
import TourProvider from "@/tour/TourProvider";
import { tourForRole } from "@/tour/definitions";
import type { TourSeen } from "@/tour/types";

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
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
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

  return (
    <TourProvider role={role} seen={seen}>
      {children}
      <AssistantLauncher />
    </TourProvider>
  );
}
