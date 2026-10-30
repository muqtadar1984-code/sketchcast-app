import { requirePlatformAdmin } from "@/utils/platform-admin";
import { createClient } from "@/utils/supabase/server";
import { skShellEnabledFor } from "@/utils/flags";
import { activeHatCookie } from "@/utils/hats-server";
import ConsoleHeader from "./console-header";
import AssistantLauncher from "../dashboard/assistant-launcher";
import SkLauncher from "../dashboard/sk-launcher";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// Staff-only shell. requirePlatformAdmin() bounces everyone else to /dashboard
// (and the whole surface is dark while FEATURE_PLATFORM_CONSOLE is off).
// NOTE: layouts do NOT guard route handlers — every /api/console/* route
// re-checks with isPlatformAdminRequest() itself.
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  // The console chrome itself is staff-only and stays English; the shared
  // Assistant launcher is a portal component, so it is handed its words like
  // everywhere else rather than carrying its own.
  const t = await getDictionary(await resolveLocale());

  // SK Shell (S0) on the console too (Final Plan §6: "SK Shell on dashboard and
  // console layouts"). Same three gates as the dashboard, decided from the
  // staff member's OWN profile role — staff are not a role, so the Shell stays
  // dark here unless FEATURE_SK + SK_ROLES admit the account's role (and the
  // allow-list, when set, names its address). The §4.6 intro is a dashboard
  // moment: the console never offers it.
  let skOn = false;
  let role: string | null = null;
  let hat: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
      role = (profile?.role as string | null) ?? null;
      skOn = await skShellEnabledFor(supabase, user, role, (profile?.school_id as string | null) ?? null);
      if (skOn) hat = await activeHatCookie();
    }
  } catch {
    skOn = false; // a layout must not throw over a companion widget
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <ConsoleHeader email={admin.email} />
      {children}
      <AssistantLauncher t={{ ...t.school.assistant, close: t.common.close }} hidden={skOn} />
      {skOn && <SkLauncher copy={t.sk.shell} walkCopy={t.sk.walkthrough} role={role} hat={hat} introDue={false} />}
    </div>
  );
}
