// SK's first-login walkthrough (founder 2026-10-30): the per-role stops, as
// typed DATA. The script ("SK - First-login walkthrough script (draft)
// 2026-10-30.md") is the source of truth for the order, the pages, the anchors
// and the words; the words themselves live in sk.walkthrough.<role>.<line> in
// all ten message files.
//
// SERVER-SAFE and pure (no "use client", no DOM): the facts route reads it to
// know which facts a role needs, the client engine (src/sk/shell/client/
// walkthrough.ts) turns it into a plan, and node tests read both.
//
// Each stop says:
//   route    — where it happens. `{classId}` / `{tutorPath}` are filled from
//              the user's facts; a missing value in a QUERY drops that
//              parameter, a missing value in the PATH skips the stop.
//   anchors  — what to highlight, in order: the first one visible on the page
//              wins, and an anchor may carry its own line (e.g. the empty
//              "My lessons" when nothing is assigned). [] = no highlight.
//   needs    — facts that must hold, else the stop is skipped ("!x" = must
//              NOT hold). Unknown facts count as present (the anchor wait
//              still skips what is not on the page).
//   fallback — what to do instead when a fact is missing (the script's Gaps
//              section): another line and/or other anchors.
//   demo     — a STATIC "Example" card (never a real confirm card: a real one
//              writes an sk_action_tokens row).
//   chips    — sample questions, shown but NEVER sent by the tour.

export type WalkRole = "teacher" | "student" | "parent" | "principal" | "coordinator";

export const WALK_ROLES: readonly WalkRole[] = ["teacher", "student", "parent", "principal", "coordinator"];

/** What the tour knows about the user (GET /api/sk/walkthrough). Every field
 *  is optional: an absent fact never hides a stop by itself. */
export type WalkFacts = {
  /** Teacher: owns a book or the school shelf has one. */
  books?: boolean;
  /** The first class the user teaches (the Library's order). */
  classId?: string | null;
  catalogue?: boolean;
  exam?: boolean;
  diary?: boolean;
  timetable?: boolean;
  notices?: boolean;
  calendar?: boolean;
  analytics?: boolean;
  roleHats?: boolean;
  /** /present is open to this user (presentAllowed). */
  board?: boolean;
  /** Student: the first SK Tutor chapter, `/sk/<product>/<chapter>`. */
  tutorPath?: string | null;
  /** Parent: linked children, and how many of those links are verified. */
  children?: number;
  verifiedChildren?: number;
  /** Parent: at least one link came from a school (parent_links.source). */
  schoolParent?: boolean;
  parentPortal?: boolean;
};

export type WalkNeed =
  | "books"
  | "class"
  | "catalogue"
  | "exam"
  | "diary"
  | "timetable"
  | "notices"
  | "calendar"
  | "analytics"
  | "roleHats"
  | "board"
  | "tutor"
  | "children"
  | "verified"
  | "schoolParent"
  | "parentPortal";

export type WalkNeedSpec = WalkNeed | `!${WalkNeed}`;

/** A selector, optionally with the line to say when IT is the one found. */
export type WalkAnchor = string | { sel: string; line: string };

export type WalkDemo =
  | "lessonPrepare"
  | "assign"
  | "markingGrade"
  | "diaryNote"
  | "diaryParent"
  | "bookActivate"
  | "bookActivateChild"
  | "noticeSchool";

/** Demos whose real card is click-only (it spends credits, or is a school-wide post). */
export const CLICK_ONLY_DEMOS: ReadonlySet<WalkDemo> = new Set<WalkDemo>(["lessonPrepare", "bookActivate", "bookActivateChild", "noticeSchool"]);

export type WalkChip =
  | "lessonOnPhotosynthesis"
  | "howAreMyClasses"
  | "whoIsAtRisk"
  | "whatsNext"
  | "howAmIDoing"
  | "howAreMyKids"
  | "fallingBehind"
  | "whatsOverdue"
  | "schoolNotices"
  | "howIsTheSchool"
  | "atRiskGrade"
  | "markingPilingUp"
  | "howManyPeople"
  | "shelfGaps"
  | "whatsOnNow"
  | "generationCost"
  | "schoolTrend";

export type WalkStopDef = {
  /** Stable id; also the default line key. */
  id: string;
  route: string;
  anchors: WalkAnchor[];
  /** The line key when it differs from `id`. */
  line?: string;
  needs?: WalkNeedSpec[];
  /** First entry whose `unless` fact is missing applies: another line and/or anchors, or skip. */
  fallback?: Array<{ unless: WalkNeedSpec; line?: string; anchors?: WalkAnchor[]; skip?: true }>;
  demo?: WalkDemo;
  chips?: WalkChip[];
};

// 2026-10-30: SK is the corner avatar now (no hero card): "SK here" anchors
// point at the avatar itself.
const HERO = '[data-sk="avatar"]';
const LAUNCHER = '[data-tour="sk-launcher"]';
const UPLOAD = '[data-tour="upload-book"]';

const TEACHER: WalkStopDef[] = [
  { id: "hello", route: "/dashboard", anchors: [HERO, LAUNCHER] },
  { id: "library", route: "/dashboard", anchors: ['[data-tour="book-card"]', UPLOAD], fallback: [{ unless: "books", anchors: [UPLOAD] }] },
  // No book: stops 3–5 have nothing to point at, so ONE line at the upload card stands in for all three.
  { id: "generate", route: "/dashboard", anchors: ['[data-tour="generate-lesson"]'], demo: "lessonPrepare", fallback: [{ unless: "books", line: "noBooks", anchors: [UPLOAD] }] },
  {
    id: "output",
    route: "/dashboard",
    anchors: ['[data-tour="lesson-output"]', '[data-tour="book-tools"]'],
    needs: ["books"],
    fallback: [{ unless: "exam", line: "outputNoExam" }],
  },
  { id: "assign", route: "/dashboard", anchors: ['[data-tour="assign-chapter"]'], needs: ["books"], demo: "assign" },
  { id: "classes", route: "/dashboard", anchors: ['[data-tour="classes"]'] },
  { id: "myBooks", route: "/dashboard", anchors: ['[data-tour="my-books"]', '[data-tour="fair-use"]'] },
  { id: "kits", route: "/dashboard/kits", anchors: ['[data-tour="kits-allowance"]'], needs: ["catalogue"], chips: ["lessonOnPhotosynthesis"] },
  { id: "analytics", route: "/dashboard/analytics", anchors: ['[data-tour="analytics-metrics"]'], chips: ["howAreMyClasses", "whoIsAtRisk"] },
  { id: "gradeQueue", route: "/dashboard/analytics", anchors: ['[data-tour="grade-queue"]'], demo: "markingGrade" },
  { id: "diary", route: "/dashboard/diary?c={classId}", anchors: ['[data-tour="diary-compose"]'], needs: ["diary", "class"], demo: "diaryNote" },
  { id: "timetable", route: "/dashboard/my-timetable", anchors: ['[data-tour="my-timetable"]'], needs: ["timetable"], chips: ["whatsNext"] },
  // No autostart: pressing Start opens a Board session, so the tour only describes it.
  { id: "board", route: "/present?class={classId}", anchors: ['[data-tour="board-bar"]', '[data-sk="launcher"][data-sk-board="true"]'], needs: ["board"] },
  {
    id: "settings",
    route: "/dashboard/settings",
    anchors: ['[data-tour="sk-prefs"]', '[data-tour="sk-memory"]', '[data-sk="mic"]', '[data-sk="input"]', '[data-tour="settings-link"]'],
  },
];

const STUDENT: WalkStopDef[] = [
  { id: "hello", route: "/dashboard", anchors: [HERO, LAUNCHER] },
  { id: "assignments", route: "/dashboard", anchors: ['[data-tour="assignments"]'] },
  // Nothing assigned: say so and show the empty "My lessons".
  { id: "openLesson", route: "/dashboard", anchors: ['[data-tour="open-lesson"]', { sel: '[data-tour="assignments"]', line: "openLessonEmpty" }] },
  { id: "progress", route: "/dashboard", anchors: ['[data-tour="progress"]'] },
  { id: "myBooks", route: "/dashboard", anchors: ['[data-tour="my-books"]'], demo: "bookActivate" },
  // No SK book (or no mapped kit): ONE neutral line instead of stops 6–9 — no selling (founder decision 8).
  { id: "tutorNone", route: "/dashboard", anchors: [], needs: ["!tutor"] },
  { id: "skBooks", route: "/sk", anchors: ['[data-tour="sk-books"]'], needs: ["tutor"] },
  { id: "kitPlayer", route: "{tutorPath}", anchors: ['[data-tour="kit-player"]', '[data-testid="kit-player"]'], needs: ["tutor"] },
  { id: "kitHelp", route: "{tutorPath}", anchors: ['[data-tour="kit-explain"]', '[data-tour="kit-practise"]'], needs: ["tutor"] },
  { id: "kitNext", route: "{tutorPath}", anchors: ['[data-tour="kit-next-move"]'], needs: ["tutor"], chips: ["howAmIDoing"] },
  { id: "diaryTimetable", route: "/dashboard", anchors: ['[data-tour="diary-nav"]', '[data-tour="timetable-nav"]', '[data-tour="mobile-nav"]'], needs: ["diary"] },
  { id: "settings", route: "/dashboard/settings", anchors: ['[data-tour="sk-memory"]', '[data-tour="sk-prefs"]', '[data-sk="mic"]', '[data-sk="input"]'] },
];

const PARENT: WalkStopDef[] = [
  { id: "hello", route: "/dashboard/children", anchors: [HERO, LAUNCHER] },
  // An unverified link: SK answers nothing about that child — say why.
  {
    id: "childCard",
    route: "/dashboard/children",
    anchors: ['[data-tour="child-assignments"]'],
    needs: ["children"],
    fallback: [{ unless: "verified", line: "childUnverified" }],
  },
  { id: "week", route: "/dashboard/children", anchors: ['[data-sk="week-card"]'], needs: ["children", "verified"] },
  { id: "weekSteps", route: "/dashboard/children", anchors: ['[data-sk="week-steps"]'], needs: ["children", "verified"], chips: ["howAreMyKids"] },
  { id: "report", route: "/dashboard/children", anchors: ['[data-tour="child-report"]', '[data-tour="progress-recap"]'], needs: ["children"] },
  { id: "ask", route: "/dashboard/children", anchors: [HERO, LAUNCHER], needs: ["children", "verified"], chips: ["fallingBehind", "whatsOverdue"] },
  { id: "diary", route: "/dashboard/diary", anchors: ['[data-tour="diary-parent-compose"]'], needs: ["diary", "children"], demo: "diaryParent" },
  { id: "calendar", route: "/dashboard/calendar", anchors: ['[data-tour="calendar-grid"]'], needs: ["schoolParent", "calendar"], chips: ["schoolNotices"] },
  // /activate sits outside the dashboard (no SK there): the tour never goes there.
  { id: "bookCode", route: "/dashboard/children", anchors: [HERO, LAUNCHER], needs: ["children"], demo: "bookActivateChild" },
  // Stop 10 branches: a school parent gets Test Papers, a home educator the Library.
  { id: "testPapers", route: "/dashboard/test-papers", anchors: ['[data-tour="test-papers-nav"]', '[data-tour="mobile-nav"]'], needs: ["schoolParent", "parentPortal"] },
  { id: "homeLibrary", route: "/dashboard", anchors: ['[data-tour="book-card"]', UPLOAD], needs: ["!schoolParent"] },
  { id: "consent", route: "/dashboard/settings", anchors: ['[data-tour="sk-children-consent"]'], needs: ["children"] },
  { id: "addChild", route: "/dashboard/children", anchors: ['[data-tour="add-child"]'], fallback: [{ unless: "children", line: "addChildFirst" }] },
];

const PRINCIPAL: WalkStopDef[] = [
  { id: "hello", route: "/dashboard/school", anchors: [HERO, LAUNCHER] },
  { id: "metrics", route: "/dashboard/school", anchors: ['[data-tour="school-metrics"]'], needs: ["analytics"], chips: ["howIsTheSchool"] },
  { id: "worklist", route: "/dashboard/school", anchors: ['[data-tour="school-worklist"]'], needs: ["analytics"], chips: ["atRiskGrade"] },
  { id: "teachers", route: "/dashboard/school/teachers", anchors: ['[data-tour="school-teachers"]'], chips: ["markingPilingUp"] },
  { id: "access", route: "/dashboard/school/access", anchors: ['[data-tour="school-access"]'] },
  { id: "admin", route: "/dashboard/school/admin", anchors: ['[data-tour="school-admin-roles"]'], chips: ["howManyPeople"] },
  { id: "books", route: "/dashboard/school/books", anchors: ['[data-tour="book-health"]'], chips: ["shelfGaps"] },
  { id: "timetable", route: "/dashboard/school/timetable", anchors: ['[data-tour="timetable-grid"]'], needs: ["timetable"], chips: ["whatsOnNow"] },
  { id: "diary", route: "/dashboard/school/diary", anchors: ['[data-tour="school-diary"]'], needs: ["diary"] },
  { id: "notices", route: "/dashboard/calendar", anchors: ['[data-tour="notice-composer"]'], needs: ["notices"], demo: "noticeSchool" },
  { id: "schoolSwitch", route: "/dashboard/settings", anchors: ['[data-tour="sk-school-switch"]'] },
  // Founder decision 6: SK points at the hat switcher and NEVER switches it (that writes the hat cookie).
  { id: "hat", route: "/dashboard/school", anchors: ['[data-tour="hat-switcher"]', HERO], needs: ["roleHats"] },
];

const COORDINATOR: WalkStopDef[] = [
  { id: "hello", route: "/dashboard/school", anchors: ['[data-tour="school-scope"]', HERO, LAUNCHER] },
  { id: "worklist", route: "/dashboard/school", anchors: ['[data-tour="school-worklist"]'], chips: ["whoIsAtRisk"] },
  { id: "teachers", route: "/dashboard/school/teachers", anchors: ['[data-tour="school-teachers"]'], chips: ["markingPilingUp"] },
  { id: "access", route: "/dashboard/school/access", anchors: ['[data-tour="school-access"]'] },
  { id: "books", route: "/dashboard/school/books", anchors: ['[data-tour="book-health"]'], chips: ["shelfGaps"] },
  { id: "timetable", route: "/dashboard/school/timetable", anchors: ['[data-tour="timetable-grid"]'], needs: ["timetable"], chips: ["whatsOnNow"] },
  { id: "diary", route: "/dashboard/school/diary", anchors: ['[data-tour="school-diary"]'], needs: ["diary"] },
  { id: "notices", route: "/dashboard/calendar", anchors: ['[data-tour="notice-composer"]'], needs: ["notices"], demo: "noticeSchool" },
  { id: "costTrend", route: "/dashboard/school", anchors: [HERO, LAUNCHER], chips: ["generationCost", "schoolTrend"] },
  { id: "hatSettings", route: "/dashboard/school", anchors: ['[data-tour="hat-switcher"]', '[data-tour="settings-link"]', HERO] },
];

export const WALK_STOPS: Readonly<Record<WalkRole, readonly WalkStopDef[]>> = {
  teacher: TEACHER,
  student: STUDENT,
  parent: PARENT,
  principal: PRINCIPAL,
  coordinator: COORDINATOR,
};

/** Which tour a user gets: the active hat first (a principal in the teacher
 *  hat gets the teacher tour), then the profile role. */
export function walkRoleFor(role: string | null | undefined, hat: string | null | undefined): WalkRole {
  const r = (role ?? "").toLowerCase();
  if (r === "student") return "student";
  if (hat === "principal" || hat === "coordinator" || hat === "teacher" || hat === "parent") return hat;
  if (r === "parent") return "parent";
  if (r === "school_admin") return "principal";
  if (r === "coordinator") return "coordinator";
  return "teacher";
}

/** Every line key a role's stops can say (the stop ids, their fallback lines
 *  and their anchors' own lines) — the i18n test checks each one exists. */
export function lineKeysFor(role: WalkRole): string[] {
  const keys = new Set<string>();
  for (const s of WALK_STOPS[role]) {
    keys.add(s.line ?? s.id);
    for (const f of s.fallback ?? []) if (f.line) keys.add(f.line);
    for (const a of [...s.anchors, ...(s.fallback ?? []).flatMap((f) => f.anchors ?? [])]) if (typeof a !== "string") keys.add(a.line);
  }
  return [...keys];
}
