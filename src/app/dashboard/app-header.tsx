import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { LogoMark } from "./icons";
import HeaderNav from "./header-nav";
import MobileNav from "./mobile-nav";
import TourReplayButton from "./tour-replay-button";
import HatSwitcher from "./hat-switcher";
import LanguageSwitcher from "./language-switcher";
import NotificationsBell, { type IssueNotification, type NoticeNotification } from "./notifications-bell";
import {
  calendarEnabledFor,
  diaryEnabled,
  i18nEnabled,
  noticesEnabledFor,
  parentPortalEnabled,
  roleHatsEnabled,
  schoolAnalyticsEnabledFor,
  timetableEnabledFor,
} from "@/utils/flags";
import { hatsFor, resolveHat, type Hat } from "@/utils/hats";
import { headerFit } from "@/utils/header-fit";
import { tabsFor, tabsForHat } from "@/utils/nav-tabs";
import { presentEntitled } from "@/utils/present/entitlement";
import { createAdminClient } from "@/utils/supabase/admin";
import { activeHatCookie } from "@/utils/hats-server";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

// One person can wear several hats: every adult (teacher, coordinator,
// school_admin, PARENT) implicitly has the TEACHER capability (the DB already
// permits it — teacher access is ownership-based, not role-based), coordinator
// access is granted via coordinator_scope rows rather than the role enum, and
// admin stays a rank. Parents are full authors too (migration 0035 dropped the
// old test-papers-only trigger): they get the Library + analytics AND their
// My Children + Test Papers tabs, and land on the Library like any adult.
// Students stay exclusive — a minor's account never gains adult capabilities.
// Tabs and the label show the UNION of what a person holds.

// Every tab label and role word comes from the request's dictionary, so the two
// tab builders take the `nav` slice rather than repeating the strings: one tab
// exists in exactly one place, in ten languages.
type NavMessages = Dictionary["nav"];

// The union-view descriptor beside the name ("teacher & coordinator"). The
// combinations are whole messages rather than words glued with "&": the
// conjunction, and the order the two roles read in, are a translator's call.
function labelFor(t: NavMessages["roleLabel"], role: string | null, hasScope: boolean, hasChildren: boolean): string {
  if (role === "student") return t.student;
  if (role === "parent") return t.parent;
  let label = "";
  if (role === "school_admin") label = t.adminAndTeacher;
  else if (hasScope) label = t.teacherAndCoordinator;
  else if (role === "teacher" || role === "coordinator") label = t.teacher;
  if (label && hasChildren) label = fmt(t.alsoParent, { role: label });
  return label;
}

// Shared app bar for the teacher, student, and leadership dashboards.
// Self-sufficient: derives everything from the session, no props needed — the
// interface language included. resolveLocale() is React-cached per request, so
// asking here costs nothing beyond what the root layout already paid, and the
// dictionary stays on the server: each client control below is handed the
// handful of strings it renders, never the whole file.
export default async function AppHeader() {
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role: string | null = null;
  let name = "";
  let schoolName = "";
  let hasScope = false;
  let hasChildren = false;
  let hasSchoolParentLinks = false;
  let analyticsOn = false;
  let calendarOn = false;
  let timetableOn = false;
  // The classroom board is carried by the plan (Pro, Pro+, school). Resolving it
  // needs plan_tier(), which carries EXECUTE for the service role alone — so a
  // deployment with no service key simply shows no tab, which is the same answer
  // /present itself would give.
  let boardOn = false;
  // Which school decides the NOTICES gate for this viewer — their own for a
  // member, a child's for a parent (resolved by the calendar walk below).
  let noticeSchoolId: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, role, school_id")
      .eq("id", user.id)
      .maybeSingle();
    role = (profile?.role as string | null) ?? null;
    noticeSchoolId = (profile?.school_id as string | null) ?? null;
    name = profile?.full_name || user.email || "";
    if (role && role !== "student") {
      // Global env flag OR this school's config override (the sales-demo tenant).
      analyticsOn = await schoolAnalyticsEnabledFor(supabase, profile?.school_id as string | null);
      try {
        boardOn = (await presentEntitled(createAdminClient(), user.id, user)).ok;
      } catch {
        boardOn = false;
      }
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
            // The same child school answers "are notices live for me?".
            noticeSchoolId = l.profiles.school_id;
            break;
          }
        }
      }
    }
    if (parentPortalEnabled() && role && role !== "student") {
      // Any adult with links (a parent, or a teacher who is also a parent):
      // pl_parent_read returns only the viewer's own links. Best-effort — table
      // missing (0018 not applied) just means no tab. `source` decides the
      // Test Papers tab: 'school' = the school provisioned this portal.
      const { data: pl } = await supabase.from("parent_links").select("source").limit(20);
      hasChildren = (pl?.length ?? 0) > 0;
      hasSchoolParentLinks = ((pl ?? []) as { source: string | null }[]).some((l) => l.source === "school");
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

  // The bell's SECOND feed: the school's live notices (0068 — notices ARE
  // school_events rows, so se_read already delivers exactly the viewer's slice,
  // parents included). "Live" is three arms OR'd: either clock still ahead (the
  // deadline or the event date — which is what drops a lapsed pure-deadline
  // notice off the bell), or simply posted in the last week, so a notice about
  // something happening THIS MORNING can't expire before the reader ever opens
  // the bell. Ordinary school-wide calendar entries (a holiday an admin posted
  // to everyone) share the notice audiences and ride along — that IS an
  // announcement, so it belongs here.
  //
  // Its unread rule is NOT the issue one: a notice counts as unread while it is
  // NEW (created_at > notices_seen_at), never because someone edited it. So it
  // reads its OWN watermark, in its OWN query — folding notices_seen_at into
  // the select above would, on a pre-0068 database, fail that select and mark
  // every issue unread instead.
  let bellNotices: NoticeNotification[] = [];
  let bellNoticesUnread = 0;
  let noticesOn = false;
  if (user) {
    noticesOn = await noticesEnabledFor(supabase, noticeSchoolId);
    if (noticesOn) {
      const now = new Date();
      const nowIso = now.toISOString();
      const freshIso = new Date(now.getTime() - 7 * 86400000).toISOString();
      const { data: notRaw } = await supabase
        .from("school_events")
        .select("id, title, audience, importance, starts_at, action_by, action_label, created_at")
        .eq("status", "published") // a revoked notice leaves every reader surface
        .in("audience", ["school", "staff"])
        .or(`starts_at.gte.${nowIso},action_by.gte.${nowIso},created_at.gte.${freshIso}`)
        .order("created_at", { ascending: false })
        .limit(10);
      bellNotices = (notRaw ?? []) as NoticeNotification[];
      if (bellNotices.length) {
        const { data: nSeenRow } = await supabase
          .from("profiles")
          .select("notices_seen_at")
          .eq("id", user.id)
          .maybeSingle();
        const nSeen = (nSeenRow as { notices_seen_at?: string | null } | null)?.notices_seen_at ?? null;
        bellNoticesUnread = bellNotices.filter((n) => !nSeen || n.created_at > nSeen).length;
      }
    }
  }

  // One-hat mode: filter everything to the active hat; legacy union view when off.
  const diaryOn = diaryEnabled() && !!user && !!role;
  let hats: Hat[] = [];
  let activeHat: Hat | null = null;
  if (roleHatsEnabled() && user) {
    // The diary counts as a leadership surface: with only FEATURE_DIARY on, a
    // coordinator still holds their hat (the school diary is behind it).
    hats = hatsFor({ role, hasScope, hasChildren, analyticsOn, timetableOn, diaryOn });
    activeHat = resolveHat(await activeHatCookie(), hats);
  }
  const tabs = activeHat
    ? tabsForHat(t.nav.tabs, activeHat, analyticsOn, calendarOn, timetableOn, diaryOn, hasSchoolParentLinks, boardOn)
    : tabsFor(t.nav.tabs, role, hasScope, hasChildren, hasSchoolParentLinks, analyticsOn, calendarOn, timetableOn, diaryOn, t.student.title, boardOn);
  // The hat name reads as a descriptor here ("Ayu · teacher"), not a title, so
  // it is lower-cased — a no-op in the scripts that have no case at all.
  const label = activeHat ? t.nav.hats[activeHat].toLowerCase() : labelFor(t.nav.roleLabel, role, hasScope, hasChildren);

  // Where this viewer's tab row gives way to the hamburger. It is not the flat
  // `sm` it used to be: the bar's crowding varies by role, and the language
  // picker joining the right-hand cluster is what pushed a principal's seven
  // tabs into overlapping their neighbours. See header-fit for the geometry.
  const i18nOn = i18nEnabled();
  const { navShow, navHide } = headerFit({
    tabs: tabs.length,
    hatSwitcher: hats.length > 1 && !!activeHat,
    languagePicker: i18nOn,
  });

  return (
    <header className="relative border-b border-[#E6E8E4] bg-gradient-to-b from-[#F5F6F3] to-white">
      {/* Full-width bar: the logo alone anchors the left, the tabs float in
          the center (no dead gap), controls sit right, and the SCHOOL identity
          holds the extreme right (its logo joins the name later). On phones
          the tabs are hidden, so a hamburger (far left) opens them as a
          dropdown — every role's tabs, same source. */}
      <div className="px-5 h-16 flex items-center gap-3 sm:gap-5">
        {tabs.length > 0 && (
          <MobileNav tabs={tabs} openLabel={t.nav.openMenu} closeLabel={t.nav.closeMenu} className={navHide} />
        )}
        {/* The product name is a name, in every language — never translated. */}
        <Link href="/dashboard" className="flex items-center gap-2.5 text-xl font-display shrink-0">
          <LogoMark size={30} />
          SketchCast <span className="text-[#0C8175]">AI</span>
        </Link>
        <div className="flex-1 min-w-0 flex justify-center">
          {tabs.length > 0 && <HeaderNav tabs={tabs} className={navShow} />}
        </div>
        <div className="flex items-center gap-3 text-sm shrink-0">
          {hats.length > 1 && activeHat && (
            <HatSwitcher
              hats={hats}
              active={activeHat}
              labels={t.nav.hats}
              viewingAs={t.nav.viewingAs}
              switchLabel={t.nav.switchRoleView}
            />
          )}
          {/* Deliberately NOT hidden on phones like the name beside it: a reader
              who can't read the current language has to be able to reach this
              from the device they actually use. */}
          {i18nEnabled() && <LanguageSwitcher locale={locale} t={t.common} />}
          {/* The two purely INFORMATIONAL items in this cluster — who you are,
              and which school you're in — are the ones that yield when the bar
              is tight, because everything else beside them is a control you
              act on. Their breakpoints are deliberately not the device-ish
              md/xl they were: what they compete with is the tab row's width,
              not a phone or a laptop, so each returns only once the viewport
              has grown enough to pay for it (measured: the name is 171px, the
              school badge 105px). */}
          <span
            className="text-[#5B6470] hidden min-[1800px]:inline max-w-[14rem] truncate whitespace-nowrap"
            title={`${name}${label ? ` · ${label}` : ""}`}
          >
            {name}
            {label ? ` · ${label}` : ""}
          </span>
          {user && (
            <NotificationsBell
              userId={user.id}
              issues={bellIssues}
              initialUnread={bellUnread}
              notices={bellNotices}
              noticesUnread={bellNoticesUnread}
              noticesOn={noticesOn}
              // Where the board lives for THIS viewer. Taken from the tabs we
              // just built rather than hard-coded, so it is by construction a
              // route they actually hold: /dashboard/diary for a teacher,
              // parent or student, /dashboard/school/diary for leadership, and
              // the calendar when they have no Diary tab at all.
              noticesHref={tabs.find((tab) => tab.href.endsWith("/diary"))?.href ?? "/dashboard/calendar"}
              t={t.nav.bell}
            />
          )}
          <TourReplayButton label={t.nav.tour} hint={t.nav.takeATour} />
          <form action="/auth/signout" method="post">
            <button className="btn-ghost h-9 px-3 text-sm whitespace-nowrap">{t.nav.signOut}</button>
          </form>
          {/* Logical inset/border (ps-/ms-/border-s) so the school's divider sits
              on the correct side once <html dir="rtl"> mirrors the bar. */}
          {schoolName && (
            <span className="hidden min-[1600px]:inline-flex items-center ps-4 ms-1 border-s border-[#E6E8E4] font-display text-[#14181F] whitespace-nowrap max-w-[14rem] truncate">
              {schoolName}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
