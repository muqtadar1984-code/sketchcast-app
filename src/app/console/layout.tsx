import { requirePlatformAdmin } from "@/utils/platform-admin";
import ConsoleHeader from "./console-header";
import AssistantLauncher from "../dashboard/assistant-launcher";
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
  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <ConsoleHeader email={admin.email} />
      {children}
      <AssistantLauncher t={{ ...t.school.assistant, close: t.common.close }} />
    </div>
  );
}
