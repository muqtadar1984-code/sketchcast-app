import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { LogoMark } from "./icons";
import HeaderNav, { type NavTab } from "./header-nav";
import { parentPortalEnabled, schoolAnalyticsEnabled } from "@/utils/flags";

// One person can wear several hats: every adult (teacher, coordinator,
// school_admin) implicitly has the TEACHER capability (the DB already permits
// it — teacher access is ownership-based, not role-based), coordinator access
// is granted via coordinator_scope rows rather than the role enum, and admin
// stays a rank. PARENT is the exception among adults: a parent-role account
// gets ONLY the parent surfaces (never Library/analytics — the DB enforces
// test-papers-only too), while a teacher who is also a parent keeps their
// teacher world and gains My Children. Students stay exclusive — a minor's
// account never gains adult capabilities. Tabs and the label show the UNION
// of what a person holds.

function tabsFor(role: string | null, hasScope: boolean, hasChildren: boolean): NavTab[] {
  if (!role || role === "student") return [];
  if (role === "parent") {
    return [
      { href: "/dashboard/children", label: "My Children" },
      { href: "/dashboard/test-papers", label: "Test Papers" },
    ];
  }
  const tabs: NavTab[] = [
    { href: "/dashboard", label: "Library" },
    { href: "/dashboard/analytics", label: "My Analytics" },
  ];
  if (schoolAnalyticsEnabled() && (role === "school_admin" || hasScope)) {
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
  if (hasChildren) tabs.push({ href: "/dashboard/children", label: "My Children" });
  return tabs;
}

function labelFor(role: string | null, hasScope: boolean, hasChildren: boolean): string {
  if (role === "student") return "student";
  if (role === "parent") return "parent";
  let label = "";
  if (role === "school_admin") label = "admin & teacher";
  else if (hasScope) label = "teacher & coordinator";
  else if (role === "teacher" || role === "coordinator") label = "teacher";
  if (label && hasChildren) label += " & parent";
  return label;
}

// Shared app bar for the teacher, student, and leadership dashboards.
// Self-sufficient: derives everything from the session, no props needed.
export default async function AppHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role: string | null = null;
  let name = "";
  let hasScope = false;
  let hasChildren = false;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, role")
      .eq("id", user.id)
      .maybeSingle();
    role = (profile?.role as string | null) ?? null;
    name = profile?.full_name || user.email || "";
    if (role === "teacher" || role === "coordinator") {
      // RLS: cs_self_read returns only the viewer's own grant rows.
      const { data: sc } = await supabase.from("coordinator_scope").select("id").limit(1);
      hasScope = (sc?.length ?? 0) > 0;
    }
    if (parentPortalEnabled() && role && role !== "student" && role !== "parent") {
      // Teacher-parents: pl_parent_read returns only the viewer's own links.
      // Best-effort — table missing (0018 not applied) just means no tab.
      const { data: pl } = await supabase.from("parent_links").select("id").limit(1);
      hasChildren = (pl?.length ?? 0) > 0;
    }
  }

  const tabs = tabsFor(role, hasScope, hasChildren);
  const label = labelFor(role, hasScope, hasChildren);
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
            {label ? ` · ${label}` : ""}
          </span>
          <form action="/auth/signout" method="post">
            <button className="btn-ghost h-9 px-3 text-sm">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}
