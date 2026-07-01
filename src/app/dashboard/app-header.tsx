import Link from "next/link";
import { LogoMark } from "./icons";
import HeaderNav, { type NavTab } from "./header-nav";
import { schoolAnalyticsEnabled } from "@/utils/flags";

// Tabs are role-derived. Leadership (admin/principal/coordinator) only sees the
// School tab when the feature flag is on; teachers keep Library/Analytics.
function tabsFor(role: string | null): NavTab[] {
  if (role === "teacher") {
    return [
      { href: "/dashboard", label: "Library" },
      { href: "/dashboard/analytics", label: "Analytics" },
    ];
  }
  if (role === "school_admin" || role === "coordinator") {
    const tabs: NavTab[] = [];
    if (schoolAnalyticsEnabled()) {
      tabs.push(
        { href: "/dashboard/school", label: "School" },
        { href: "/dashboard/school/teachers", label: "Teachers" },
        { href: "/dashboard/school/access", label: "Access" },
      );
      if (role === "school_admin") tabs.push({ href: "/dashboard/school/admin", label: "Admin" });
    }
    // Invites are the school-admin's onboarding tool — available even when the
    // analytics suite is flag-off.
    if (role === "school_admin") tabs.push({ href: "/dashboard/invites", label: "Invites" });
    return tabs;
  }
  return [];
}

// Shared app bar for the teacher, student, and leadership dashboards.
export default function AppHeader({ name, role }: { name: string; role: string | null }) {
  const tabs = tabsFor(role);
  return (
    <header className="border-b border-[#E6E8E4] bg-gradient-to-b from-[#F5F6F3] to-white">
      <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
        <span className="flex items-center gap-5">
          <Link href="/dashboard" className="flex items-center gap-2.5 text-xl font-display">
            <LogoMark size={30} />
            SketchCast <span className="text-[#0C8175]">AI</span>
          </Link>
          {tabs.length > 0 && <HeaderNav tabs={tabs} />}
        </span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-[#5B6470]">
            {name}
            {role ? ` · ${role}` : ""}
          </span>
          <form action="/auth/signout" method="post">
            <button className="btn-ghost h-9 px-3 text-sm">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}
