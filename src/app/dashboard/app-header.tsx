import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { LogoMark } from "./icons";
import HeaderNav, { type NavTab } from "./header-nav";
import TourReplayButton from "./tour-replay-button";
import HatSwitcher from "./hat-switcher";
import {
  calendarEnabledFor,
  parentPortalEnabled,
  roleHatsEnabled,
  schoolAnalyticsEnabledFor,
  timetableEnabledFor,
} from "@/utils/flags";
import { HAT_LABEL, hatsFor, resolveHat, type Hat } from "@/utils/hats";
import { activeHatCookie } from "@/utils/hats-server";

// One person can wear several hats: every adult (teacher, coordinator,
// school_admin, PARENT) implicitly has the TEACHER capability (the DB already
// permits it — teacher access is ownership-based, not role-based), coordinator
// access is granted via coordinator_scope rows rather than the role enum, and
// admin stays a rank. Parents are full authors too (migration 0035 dropped the
// old test-papers-only trigger): they get the Library + analytics AND their
// My Children + Test Papers tabs, and land on the Library like any adult.
// Students stay exclusive — a minor's account never gains adult capabilities.
// Tabs and the label show the UNION of what a person holds.

// One-hat-at-a-time tabs (FEATURE_ROLE_HATS): only the ACTIVE hat's world
// renders — a principal in Teacher mode sees a plain teacher header, nothing
// leadership. Presentation only; every page keeps its own server-side gates.
function tabsForHat(hat: Hat, analyticsOn: boolean, calendarOn: boolean, timetableOn: boolean): NavTab[] {
  const calendar: NavTab[] = calendarOn ? [{ href: "/dashboard/calendar", label: "Calendar" }] : [];
  if (hat === "teacher")
    return [
      { href: "/dashboard", label: "Library" },
      { href: "/dashboard/analytics", label: "My Analytics" },
      ...calendar,
    ];
  if (hat === "parent")
    return [
      { href: "/dashboard/children", label: "My Children" },
      { href: "/dashboard/test-papers", label: "Test Papers" },
      ...calendar,
    ];
  const tabs: NavTab[] = [];
  if (analyticsOn) {
    tabs.push(
      { href: "/dashboard/school", label: "School" },
      { href: "/dashboard/school/teachers", label: "Teachers" },
      { href: "/dashboard/school/access", label: "Access" },
    );
    if (hat === "principal") tabs.push({ href: "/dashboard/school/admin", label: "Admin" });
  }
  if (timetableOn) tabs.push({ href: "/dashboard/school/timetable", label: "Timetable" });
  tabs.push(...calendar);
  // Invites are the principal's onboarding tool — principal hat only.
  if (hat === "principal") tabs.push({ href: "/dashboard/invites", label: "Invites" });
  return tabs;
}

function tabsFor(
  role: string | null,
  hasScope: boolean,
  hasChildren: boolean,
  analyticsOn: boolean,
  calendarOn: boolean,
  timetableOn: boolean,
): NavTab[] {
  if (!role || role === "student") return [];
  const tabs: NavTab[] = [
    { href: "/dashboard", label: "Library" },
    { href: "/dashboard/analytics", label: "My Analytics" },
  ];
  if (calendarOn) tabs.push({ href: "/dashboard/calendar", label: "Calendar" });
  if (analyticsOn && (role === "school_admin" || hasScope)) {
    tabs.push(
      { href: "/dashboard/school", label: "School" },
      { href: "/dashboard/school/teachers", label: "Teachers" },
      { href: "/dashboard/school/access", label: "Access" },
    );
    if (role === "school_admin") tabs.push({ href: "/dashboard/school/admin", label: "Admin" });
  }
  if (timetableOn && (role === "school_admin" || hasScope))
    tabs.push({ href: "/dashboard/school/timetable", label: "Timetable" });
  // Invites are the school-admin's onboarding tool — available even when the
  // analytics suite is flag-off.
  if (role === "school_admin") tabs.push({ href: "/dashboard/invites", label: "Invites" });
  if (hasChildren) {
    tabs.push({ href: "/dashboard/children", label: "My Children" });
    tabs.push({ href: "/dashboard/test-papers", label: "Test Papers" });
  }
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
  let analyticsOn = false;
  let calendarOn = false;
  let timetableOn = false;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    role = (profile?.role as string | null) ?? null;
    name = profile?.full_name || user.email || "";
    if (role && role !== "student") {
      // Global env flag OR this school's config override (the sales-demo tenant).
      analyticsOn = await schoolAnalyticsEnabledFor(supabase, profile?.school_id as string | null);
      timetableOn = await timetableEnabledFor(supabase, profile?.school_id as string | null);
    }
    if (role === "teacher" || role === "coordinator") {
      // RLS: cs_self_read returns only the viewer's own grant rows.
      const { data: sc } = await supabase.from("coordinator_scope").select("id").limit(1);
      hasScope = (sc?.length ?? 0) > 0;
    }
    if (role && role !== "student") {
      calendarOn = await calendarEnabledFor(supabase, profile?.school_id as string | null);
      // Parents carry no school_id — check their children's school(s) instead
      // (readable via schools_parent_read, 0043).
      if (!calendarOn && !profile?.school_id) {
        const { data: pl } = await supabase
          .from("parent_links")
          .select("profiles:child_id(school_id)")
          .order("created_at")
          .limit(10);
        for (const l of (pl ?? []) as unknown as { profiles: { school_id: string | null } | null }[]) {
          if (l.profiles?.school_id && (await calendarEnabledFor(supabase, l.profiles.school_id))) {
            calendarOn = true;
            break;
          }
        }
      }
    }
    if (parentPortalEnabled() && role && role !== "student") {
      // Any adult with links (a parent, or a teacher who is also a parent):
      // pl_parent_read returns only the viewer's own links. Best-effort — table
      // missing (0018 not applied) just means no tab.
      const { data: pl } = await supabase.from("parent_links").select("id").limit(1);
      hasChildren = (pl?.length ?? 0) > 0;
    }
  }

  // One-hat mode: filter everything to the active hat; legacy union view when off.
  let hats: Hat[] = [];
  let activeHat: Hat | null = null;
  if (roleHatsEnabled() && user) {
    hats = hatsFor({ role, hasScope, hasChildren, analyticsOn });
    activeHat = resolveHat(await activeHatCookie(), hats);
  }
  const tabs = activeHat
    ? tabsForHat(activeHat, analyticsOn, calendarOn, timetableOn)
    : tabsFor(role, hasScope, hasChildren, analyticsOn, calendarOn, timetableOn);
  const label = activeHat ? HAT_LABEL[activeHat].toLowerCase() : labelFor(role, hasScope, hasChildren);
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
          {hats.length > 1 && activeHat && <HatSwitcher hats={hats} active={activeHat} />}
          <span className="text-[#5B6470]">
            {name}
            {label ? ` · ${label}` : ""}
          </span>
          <TourReplayButton />
          <form action="/auth/signout" method="post">
            <button className="btn-ghost h-9 px-3 text-sm">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}
