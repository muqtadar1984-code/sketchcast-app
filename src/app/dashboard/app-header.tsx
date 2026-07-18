import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { LogoMark } from "./icons";
import HeaderNav, { type NavTab } from "./header-nav";
import TourReplayButton from "./tour-replay-button";
import HatSwitcher from "./hat-switcher";
import NotificationsBell, { type IssueNotification } from "./notifications-bell";
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
      // School-linked teachers get THEIR schedule (read-only, plus cover duties).
      ...(timetableOn ? [{ href: "/dashboard/my-timetable", label: "Timetable" }] : []),
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
  // Invites (parents only since 0052 — teacher accounts are staff-managed)
  // live under the Admin surface, not a top-level tab.
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
  if (!role || role === "student") {
    // School-linked students get their class timetable — nothing else.
    return timetableOn ? [{ href: "/dashboard/my-timetable", label: "Timetable" }] : [];
  }
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
  if (timetableOn)
    tabs.push(
      role === "school_admin" || hasScope
        ? { href: "/dashboard/school/timetable", label: "Timetable" }
        : { href: "/dashboard/my-timetable", label: "Timetable" },
    );
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
  let schoolName = "";
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
    }
    // Timetable reaches every school member — students see their class grid.
    if (role && profile?.school_id) {
      timetableOn = await timetableEnabledFor(supabase, profile.school_id as string);
      // The school's identity badge (far right; logo joins it later).
      // schools_read (0001): every member reads their own school row.
      const { data: sch } = await supabase
        .from("schools")
        .select("name, display_name")
        .eq("id", profile.school_id as string)
        .maybeSingle();
      schoolName = (sch?.display_name as string | null) || (sch?.name as string | null) || "";
    }
    if ((role === "teacher" || role === "coordinator") && profile?.school_id) {
      // RLS cs_self_read + school filter: only grants in the CURRENT school
      // count (stale grants from a former school must not surface the tabs).
      const { data: sc } = await supabase
        .from("coordinator_scope")
        .select("id")
        .eq("school_id", profile.school_id as string)
        .limit(1);
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

  // Issue-status notifications: the user's own reports (pi_report_read RLS)
  // and the seen-watermark for the badge. Both best-effort — a pre-0055
  // deploy or a missing console table must never break the header.
  let bellIssues: IssueNotification[] = [];
  let bellUnread = 0;
  if (user) {
    const { data: issRaw } = await supabase
      .from("platform_issues")
      .select("id, title, category, status, resolution_note, created_at, updated_at")
      .eq("reporter_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(20);
    bellIssues = (issRaw ?? []) as IssueNotification[];
    if (bellIssues.length) {
      let seen: string | null = null;
      const { data: seenRow } = await supabase
        .from("profiles")
        .select("notifications_seen_at")
        .eq("id", user.id)
        .maybeSingle();
      if (seenRow) seen = (seenRow as { notifications_seen_at?: string | null }).notifications_seen_at ?? null;
      bellUnread = bellIssues.filter((i) => !seen || i.updated_at > seen).length;
    }
  }

  // One-hat mode: filter everything to the active hat; legacy union view when off.
  let hats: Hat[] = [];
  let activeHat: Hat | null = null;
  if (roleHatsEnabled() && user) {
    hats = hatsFor({ role, hasScope, hasChildren, analyticsOn, timetableOn });
    activeHat = resolveHat(await activeHatCookie(), hats);
  }
  const tabs = activeHat
    ? tabsForHat(activeHat, analyticsOn, calendarOn, timetableOn)
    : tabsFor(role, hasScope, hasChildren, analyticsOn, calendarOn, timetableOn);
  const label = activeHat ? HAT_LABEL[activeHat].toLowerCase() : labelFor(role, hasScope, hasChildren);
  return (
    <header className="border-b border-[#E6E8E4] bg-gradient-to-b from-[#F5F6F3] to-white">
      {/* Full-width bar: the logo alone anchors the left, the tabs float in
          the center (no dead gap), controls sit right, and the SCHOOL identity
          holds the extreme right (its logo joins the name later). */}
      <div className="px-5 h-16 flex items-center gap-5">
        <Link href="/dashboard" className="flex items-center gap-2.5 text-xl font-display shrink-0">
          <LogoMark size={30} />
          SketchCast <span className="text-[#0C8175]">AI</span>
        </Link>
        <div className="flex-1 min-w-0 flex justify-center">{tabs.length > 0 && <HeaderNav tabs={tabs} />}</div>
        <div className="flex items-center gap-3 text-sm shrink-0">
          {hats.length > 1 && activeHat && <HatSwitcher hats={hats} active={activeHat} />}
          <span className="text-[#5B6470] hidden xl:inline max-w-[14rem] truncate whitespace-nowrap" title={`${name}${label ? ` · ${label}` : ""}`}>
            {name}
            {label ? ` · ${label}` : ""}
          </span>
          {user && <NotificationsBell userId={user.id} issues={bellIssues} initialUnread={bellUnread} />}
          <TourReplayButton />
          <form action="/auth/signout" method="post">
            <button className="btn-ghost h-9 px-3 text-sm whitespace-nowrap">Sign out</button>
          </form>
          {schoolName && (
            <span className="hidden md:inline-flex items-center pl-4 ml-1 border-l border-[#E6E8E4] font-display text-[#14181F] whitespace-nowrap max-w-[14rem] truncate">
              {schoolName}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
