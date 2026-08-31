// Which tabs a person sees. Pure: types in, labels out.
//
// Lifted out of app-header.tsx so it can be tested — the header is a server
// component and importing it drags in next/headers and the supabase server
// client. Presentation only, either way: every page keeps its own server-side
// gates, and RLS keeps the real ones.

import type { NavTab } from "@/app/dashboard/header-nav";
import type { Dictionary } from "@/i18n/dictionaries";
import type { Hat } from "@/utils/hats";

type NavMessages = Dictionary["nav"];

// One-hat-at-a-time tabs (FEATURE_ROLE_HATS): only the ACTIVE hat's world
// renders — a principal in Teacher mode sees a plain teacher header, nothing
// leadership. Presentation only; every page keeps its own server-side gates.
export function tabsForHat(
  t: NavMessages["tabs"],
  hat: Hat,
  analyticsOn: boolean,
  calendarOn: boolean,
  timetableOn: boolean,
  diaryOn: boolean,
  /** Was this parent provisioned BY a school (a parent_links row with
   * source='school')? It decides two things that move together: a school parent
   * GAINS Test Papers, the school-portal surface (founder, 2026-08-18), and
   * LOSES the Library and My Analytics, which are authoring surfaces for a
   * person who does not teach (founder, 2026-08-29). Consumer parents — Home
   * Basic and homeschool alike — are the mirror image on both counts. */
  testPapersOn: boolean,
  /** Does this account's plan carry the classroom board? Pro, Pro+ and every
   * school plan do (utils/present/access.ts). Passed in rather than derived
   * here because the answer needs plan_tier(), which only the service role may
   * call — and because this module is pure and stays that way. */
  boardOn: boolean,
): NavTab[] {
  const calendar: NavTab[] = calendarOn ? [{ href: "/dashboard/calendar", label: t.calendar }] : [];
  const diary: NavTab[] = diaryOn ? [{ href: "/dashboard/diary", label: t.diary }] : [];
  // The classroom board. Teacher hat only: it is a surface you STAND at, and a
  // principal in Leadership mode is not teaching a period.
  const board: NavTab[] = boardOn ? [{ href: "/present", label: t.board }] : [];
  if (hat === "teacher")
    return [
      { href: "/dashboard", label: t.library },
      { href: "/dashboard/analytics", label: t.myAnalytics },
      ...board,
      ...diary,
      // School-linked teachers get THEIR schedule (read-only, plus cover duties).
      ...(timetableOn ? [{ href: "/dashboard/my-timetable", label: t.timetable }] : []),
      ...calendar,
    ];
  if (hat === "parent")
    // A CONSUMER parent teaches their own children, so they get the full
    // authoring facilities directly (founder, 2026-07-19) — no switching to a
    // teacher hat to reach the Library.
    //
    // A SCHOOL parent does not (founder, 2026-08-29). The school teaches; this
    // parent watches, and the Library and My Analytics are both authoring
    // surfaces that describe work they will never do. Offering them reads as a
    // product that has not understood who is looking at it, and My Analytics —
    // "your own teaching" — is empty by construction for someone who does not
    // teach. Same predicate the Test Papers tab already uses, inverted: a
    // parent_links row with source='school' means the school provisioned them.
    //
    // A teacher who is ALSO a parent at that school keeps everything — under
    // their TEACHER hat, which is the point of hats. This only shapes the
    // parent one.
    return [
      ...(testPapersOn
        ? []
        : [
            { href: "/dashboard", label: t.library },
            { href: "/dashboard/analytics", label: t.myAnalytics },
          ]),
      { href: "/dashboard/children", label: t.myChildren },
      ...diary,
      ...(testPapersOn ? [{ href: "/dashboard/test-papers", label: t.testPapers }] : []),
      ...calendar,
    ];
  const tabs: NavTab[] = [];
  if (analyticsOn) {
    tabs.push(
      { href: "/dashboard/school", label: t.school },
      { href: "/dashboard/school/teachers", label: t.teachers },
      { href: "/dashboard/school/access", label: t.access },
    );
    if (hat === "principal") tabs.push({ href: "/dashboard/school/admin", label: t.admin });
    // The school's shelf. Leadership holds no Library tab at all, so without
    // this there is nowhere for a principal to see what the school owns.
    tabs.push({ href: "/dashboard/school/books", label: t.books });
  }
  // Leadership's diary is the read-only school surface, not the personal one.
  if (diaryOn) tabs.push({ href: "/dashboard/school/diary", label: t.diary });
  if (timetableOn) tabs.push({ href: "/dashboard/school/timetable", label: t.timetable });
  tabs.push(...calendar);
  // Invites (parents only since 0052 — teacher accounts are staff-managed)
  // live under the Admin surface, not a top-level tab.
  return tabs;
}

export function tabsFor(
  t: NavMessages["tabs"],
  role: string | null,
  hasScope: boolean,
  hasChildren: boolean,
  testPapersOn: boolean,
  analyticsOn: boolean,
  calendarOn: boolean,
  timetableOn: boolean,
  diaryOn: boolean,
  /** The student's own landing page label — `student.title`, "My lessons". It
   * lives outside nav.tabs because the page owns it, so it is passed in rather
   * than duplicated into the tab dictionary. */
  myLessons: string,
  /** Does this account's plan carry the classroom board? Pro, Pro+ and every
   * school plan do (utils/present/access.ts). Passed in rather than derived
   * here because the answer needs plan_tier(), which only the service role may
   * call — and because this module is pure and stays that way. */
  boardOn: boolean,
): NavTab[] {
  if (!role || role === "student") {
    // A student's home IS /dashboard — "My lessons" — and it had NO tab. Every
    // other role gets one for its landing page; students were the exception, so
    // opening the Diary or the timetable left them with no way back but the
    // browser's back button. They are also the least likely of anyone here to
    // work that out.
    return [
      { href: "/dashboard", label: myLessons },
      ...(diaryOn ? [{ href: "/dashboard/diary", label: t.diary }] : []),
      ...(timetableOn ? [{ href: "/dashboard/my-timetable", label: t.timetable }] : []),
    ];
  }
  const tabs: NavTab[] = [
    { href: "/dashboard", label: t.library },
    { href: "/dashboard/analytics", label: t.myAnalytics },
  ];
  // Right after the authoring surfaces and before the school ones: the board is
  // something she opens to teach, not something she administers.
  if (boardOn) tabs.push({ href: "/present", label: t.board });
  if (diaryOn) tabs.push({ href: "/dashboard/diary", label: t.diary });
  if (calendarOn) tabs.push({ href: "/dashboard/calendar", label: t.calendar });
  if (analyticsOn && (role === "school_admin" || hasScope)) {
    tabs.push(
      { href: "/dashboard/school", label: t.school },
      { href: "/dashboard/school/teachers", label: t.teachers },
      { href: "/dashboard/school/access", label: t.access },
    );
    if (role === "school_admin") tabs.push({ href: "/dashboard/school/admin", label: t.admin });
    tabs.push({ href: "/dashboard/school/books", label: t.books });
  }
  if (timetableOn)
    tabs.push(
      role === "school_admin" || hasScope
        ? { href: "/dashboard/school/timetable", label: t.timetable }
        : { href: "/dashboard/my-timetable", label: t.timetable },
    );
  // Union view carries BOTH diary doors: the personal one above, and the
  // leadership read-only surface (distinct label — two "Diary" tabs would be
  // indistinguishable here).
  if (diaryOn && (role === "school_admin" || hasScope))
    tabs.push({ href: "/dashboard/school/diary", label: t.schoolDiary });
  if (hasChildren) {
    tabs.push({ href: "/dashboard/children", label: t.myChildren });
    // School-provisioned parents only — see tabsForHat's note.
    if (testPapersOn) tabs.push({ href: "/dashboard/test-papers", label: t.testPapers });
  }
  return tabs;
}
