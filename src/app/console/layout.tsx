import { requirePlatformAdmin } from "@/utils/platform-admin";
import ConsoleHeader from "./console-header";
import AssistantLauncher from "../dashboard/assistant-launcher";

// Staff-only shell. requirePlatformAdmin() bounces everyone else to /dashboard
// (and the whole surface is dark while FEATURE_PLATFORM_CONSOLE is off).
// NOTE: layouts do NOT guard route handlers — every /api/console/* route
// re-checks with isPlatformAdminRequest() itself.
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <ConsoleHeader email={admin.email} />
      {children}
      <AssistantLauncher />
    </div>
  );
}
