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
//              A later anchor is a FALLBACK: it is taken only once the page
//              has settled without the earlier ones, so a control that
//              streams in late still wins. Each stop points at ONE control;
//              when that control is absent (no book, no generated kit, no
//              class), the fallback anchor says what will appear and how
//              ("Once you generate a kit, ...") instead of skipping silently.
//   scroll   — "start" puts a big section at the TOP of the screen (the
//              Library list); default "center".
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
  /** Teacher: the book the Library stops open (`/dashboard?book=<id>`): their
   *  most recent own book with a finished lesson, else their newest own book. */
  bookId?: string | null;
  /** The SK Tutor tab (/sk) is in this user's header. */
  skTutor?: boolean;
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
  | "parentPortal"
  | "skTutor";

export type WalkNeedSpec = WalkNeed | `!${WalkNeed}`;

/** A selector, optionally with the line to say when IT is the one found. */
export type WalkAnchor = string | { sel: string; line: string };

/** How a stop's anchor is scrolled into view. */
export type WalkScroll = "start" | "center";

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
  /** Default "center". */
  scroll?: WalkScroll;
  needs?: WalkNeedSpec[];
  /** First entry whose `unless` fact is missing applies: another line and/or anchors, or skip. */
  fallback?: Array<{ unless: WalkNeedSpec; line?: string; anchors?: WalkAnchor[]; skip?: true }>;
  demo?: WalkDemo;
  chips?: WalkChip[];
};

// 2026-10-30: SK is the corner avatar now (no hero card): "SK here" anchors
// point at the avatar itself. It is also the anchor of a line with nothing
// else to point at (SK's own menu, a feature that only appears later).
const HERO = '[data-sk="avatar"]';
const LAUNCHER = '[data-tour="sk-launcher"]';
const UPLOAD = '[data-tour="upload-book"]';
const MOBILE_NAV = '[data-tour="mobile-nav"]';
const BELL = '[data-tour="notifications"]';
const LANGUAGE = '[data-tour="language"]';
const TOUR_BUTTON = '[data-tour="tour-replay"]';
const SETTINGS_LINK = '[data-tour="settings-link"]';

// ── the teacher's Library (founder feedback 2026-10-30) ─────────────────────
// Every Library stop is on `/dashboard?book=<bookId>`: the ?book= parameter
// opens that book's row (book-table.tsx), so its chapters, parts and kits are
// on the page. OPEN scopes a control to that open book; the bare selector
// after it is the fallback for any other open book.
const LIB = "/dashboard?book={bookId}";
const OPEN = '[data-tour-book="open"] ';
const BOOK_LIST = '[data-tour="book-card"]';
const BOOK_BADGES = '[data-tour="book-badges"]';
const GENERATE_ALL = '[data-tour="generate-all"]';
const FULL_KIT = '[data-tour="generate-lesson"][data-tour-kit="full"]';
const LESSON_OPTIONS = '[data-tour="lesson-options"]';
const GENERATE_PART = '[data-tour="generate-part"]';
const PART_CARD = '[data-tour="part-card"]';
const PART_PIECES = '[data-tour="part-pieces"]';
const CHAPTER_OUTPUT = '[data-tour="lesson-output"]';
const DOWNLOAD = '[data-tour="download-doc"]';
const DOWNLOAD_WORKSHEET = '[data-tour="download-doc"][data-tour-kind="worksheet"]';
const RERUN = '[data-tour="rerun"]';
const ASSIGN_PART = '[data-tour="assign-part"]';
const ASSIGN_CHAPTER = '[data-tour="assign-chapter"]';
const MORE = '[data-tour="book-tools"]';

/** The trailing fallbacks of a kit stop with no generated kit to point at: the
 *  ungenerated part, else the chapter's Generate full kit, else the book list,
 *  else the upload card, each saying `line` ("Once you generate a kit, ..."). */
const notYet = (line: string): WalkAnchor[] => [
  { sel: OPEN + GENERATE_PART, line },
  { sel: OPEN + FULL_KIT, line },
  { sel: GENERATE_PART, line },
  { sel: FULL_KIT, line },
  { sel: BOOK_LIST, line },
  { sel: UPLOAD, line },
];

const TEACHER: WalkStopDef[] = [
  { id: "hello", route: "/dashboard", anchors: [HERO, LAUNCHER] },
  // The Library at the TOP of the screen, not its middle (founder 2026-10-30).
  { id: "library", route: LIB, scroll: "start", anchors: [BOOK_LIST, { sel: '[data-tour="library-empty"]', line: "libraryEmpty" }, { sel: UPLOAD, line: "libraryEmpty" }] },
  { id: "bookCard", route: LIB, anchors: [OPEN + BOOK_BADGES, BOOK_BADGES], needs: ["books"] },
  {
    id: "generateAll",
    route: LIB,
    anchors: [OPEN + GENERATE_ALL, GENERATE_ALL, { sel: OPEN + BOOK_BADGES, line: "generateAllNone" }, { sel: BOOK_BADGES, line: "generateAllNone" }],
    needs: ["books"],
  },
  {
    id: "chapterKit",
    route: LIB,
    anchors: [OPEN + FULL_KIT, FULL_KIT, { sel: OPEN + ASSIGN_CHAPTER, line: "chapterKitDone" }, { sel: BOOK_LIST, line: "chapterKitClosed" }],
    needs: ["books"],
  },
  {
    id: "lessonOptions",
    route: LIB,
    anchors: [
      OPEN + LESSON_OPTIONS,
      LESSON_OPTIONS,
      { sel: OPEN + BOOK_BADGES, line: "lessonOptionsNone" },
      { sel: BOOK_LIST, line: "lessonOptionsNone" },
      { sel: UPLOAD, line: "lessonOptionsNone" },
    ],
  },
  // A part that is "Not generated yet": ITS Generate kit, never Generate all.
  {
    id: "generate",
    route: LIB,
    anchors: [
      OPEN + GENERATE_PART,
      GENERATE_PART,
      { sel: OPEN + FULL_KIT, line: "generateChapter" },
      { sel: FULL_KIT, line: "generateChapter" },
      { sel: OPEN + PART_CARD, line: "generateAllDone" },
      { sel: BOOK_LIST, line: "generateAllDone" },
    ],
    demo: "lessonPrepare",
    fallback: [{ unless: "books", line: "noBooks", anchors: [UPLOAD] }],
  },
  { id: "pieces", route: LIB, anchors: [OPEN + PART_PIECES, PART_PIECES, OPEN + CHAPTER_OUTPUT, CHAPTER_OUTPUT, ...notYet("piecesNone")] },
  { id: "downloads", route: LIB, anchors: [OPEN + DOWNLOAD_WORKSHEET, OPEN + DOWNLOAD, DOWNLOAD_WORKSHEET, DOWNLOAD, ...notYet("downloadsNone")] },
  { id: "rerun", route: LIB, anchors: [OPEN + RERUN, RERUN, ...notYet("rerunNone")] },
  {
    id: "assign",
    route: LIB,
    anchors: [
      OPEN + ASSIGN_PART,
      ASSIGN_PART,
      { sel: OPEN + ASSIGN_CHAPTER, line: "assignChapter" },
      { sel: ASSIGN_CHAPTER, line: "assignChapter" },
      ...notYet("assignNone"),
    ],
    demo: "assign",
  },
  // Before the tour leaves the kits (founder 2026-10-30): the bridge to the Board.
  { id: "boardBridge", route: LIB, anchors: [OPEN + PART_CARD, PART_CARD, OPEN + CHAPTER_OUTPUT, CHAPTER_OUTPUT, BOOK_LIST, UPLOAD], needs: ["board"] },
  // "More" is a closed menu: the tour points at the button and names what is under it.
  {
    id: "more",
    route: LIB,
    anchors: [OPEN + MORE, MORE, { sel: BOOK_LIST, line: "moreClosed" }],
    needs: ["books"],
    fallback: [{ unless: "exam", line: "moreNoExam" }],
  },
  { id: "upload", route: "/dashboard", anchors: [UPLOAD] },
  { id: "classes", route: "/dashboard", anchors: ['[data-tour="classes"]'] },
  { id: "branding", route: "/dashboard", anchors: ['[data-tour="branding"]'] },
  { id: "myBooks", route: "/dashboard", anchors: ['[data-tour="my-books"]', { sel: HERO, line: "myBooksNone" }] },
  { id: "plan", route: "/dashboard", anchors: ['[data-tour="fair-use"]'] },
  // No autostart: pressing Start opens a Board session, so the tour only describes it.
  { id: "board", route: "/present?class={classId}", anchors: ['[data-tour="board-bar"]', '[data-sk="launcher"][data-sk-board="true"]'], needs: ["board"] },
  { id: "boardSk", route: "/present?class={classId}", anchors: ['[data-sk="launcher"][data-sk-board="true"]', HERO, LAUNCHER], needs: ["board"] },
  { id: "kits", route: "/dashboard/kits", anchors: ['[data-tour="kits-allowance"]'], needs: ["catalogue"], chips: ["lessonOnPhotosynthesis"] },
  { id: "skTutor", route: "/dashboard/kits", anchors: ['[data-tour="sk-nav"]', MOBILE_NAV], needs: ["skTutor"] },
  // No class yet: the diary still says what it is for, at its tab.
  {
    id: "diary",
    route: "/dashboard/diary?c={classId}",
    anchors: ['[data-tour="diary-compose"]'],
    needs: ["diary"],
    demo: "diaryNote",
    fallback: [{ unless: "class", line: "diaryNoClass", anchors: ['[data-tour="diary-nav"]', MOBILE_NAV, HERO] }],
  },
  { id: "analytics", route: "/dashboard/analytics", anchors: ['[data-tour="analytics-metrics"]'], chips: ["howAreMyClasses", "whoIsAtRisk"] },
  { id: "gradeQueue", route: "/dashboard/analytics", anchors: ['[data-tour="grade-queue"]'], demo: "markingGrade" },
  { id: "timetable", route: "/dashboard/my-timetable", anchors: ['[data-tour="my-timetable"]'], needs: ["timetable"], chips: ["whatsNext"] },
  { id: "calendar", route: "/dashboard/calendar", anchors: ['[data-tour="calendar-grid"]'], needs: ["calendar"] },
  { id: "notifications", route: "/dashboard/settings", anchors: [BELL] },
  { id: "language", route: "/dashboard/settings", anchors: [LANGUAGE] },
  {
    id: "settings",
    route: "/dashboard/settings",
    anchors: ['[data-tour="sk-prefs"]', '[data-tour="sk-memory"]', '[data-sk="mic"]', '[data-sk="input"]', SETTINGS_LINK],
  },
  // SK's own menu only exists while it is open: the tour points at the avatar and names what is in it.
  { id: "skMenu", route: "/dashboard/settings", anchors: [HERO, LAUNCHER] },
  { id: "skAsk", route: "/dashboard/settings", anchors: [TOUR_BUTTON, HERO, LAUNCHER] },
];

const STUDENT: WalkStopDef[] = [
  { id: "hello", route: "/dashboard", anchors: [HERO, LAUNCHER] },
  { id: "assignments", route: "/dashboard", anchors: ['[data-tour="assignments"]'] },
  // Nothing assigned: say so and show the empty "My lessons".
  { id: "openLesson", route: "/dashboard", anchors: ['[data-tour="open-lesson"]', { sel: '[data-tour="assignments"]', line: "openLessonEmpty" }] },
  { id: "progress", route: "/dashboard", anchors: ['[data-tour="progress"]', { sel: '[data-tour="assignments"]', line: "progressEmpty" }] },
  { id: "myBooks", route: "/dashboard", anchors: ['[data-tour="my-books"]', { sel: HERO, line: "myBooksNone" }], demo: "bookActivate" },
  // No SK book (or no mapped kit): ONE neutral line instead of stops 6–9 — no selling (founder decision 8).
  { id: "tutorNone", route: "/dashboard", anchors: [], needs: ["!tutor"] },
  { id: "skBooks", route: "/sk", anchors: ['[data-tour="sk-books"]'], needs: ["tutor"] },
  { id: "kitPlayer", route: "{tutorPath}", anchors: ['[data-tour="kit-player"]', '[data-testid="kit-player"]'], needs: ["tutor"] },
  { id: "kitHelp", route: "{tutorPath}", anchors: ['[data-tour="kit-explain"]', '[data-tour="kit-practise"]'], needs: ["tutor"] },
  { id: "kitNext", route: "{tutorPath}", anchors: ['[data-tour="kit-next-move"]'], needs: ["tutor"], chips: ["howAmIDoing"] },
  { id: "diaryTimetable", route: "/dashboard", anchors: ['[data-tour="diary-nav"]', '[data-tour="timetable-nav"]', MOBILE_NAV], needs: ["diary"] },
  { id: "notifications", route: "/dashboard/settings", anchors: [BELL] },
  { id: "language", route: "/dashboard/settings", anchors: [LANGUAGE] },
  { id: "settings", route: "/dashboard/settings", anchors: ['[data-tour="sk-memory"]', '[data-tour="sk-prefs"]', '[data-sk="mic"]', '[data-sk="input"]'] },
  { id: "skMenu", route: "/dashboard/settings", anchors: [HERO, LAUNCHER] },
  { id: "skAsk", route: "/dashboard/settings", anchors: [TOUR_BUTTON, HERO, LAUNCHER] },
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
  { id: "testPapers", route: "/dashboard/test-papers", anchors: ['[data-tour="test-papers-nav"]', MOBILE_NAV], needs: ["schoolParent", "parentPortal"] },
  { id: "homeLibrary", route: "/dashboard", anchors: [BOOK_LIST, UPLOAD], needs: ["!schoolParent"] },
  { id: "homeKits", route: "/dashboard", anchors: ['[data-tour="kits-nav"]', '[data-tour="sk-nav"]', MOBILE_NAV], needs: ["!schoolParent", "catalogue"] },
  { id: "consent", route: "/dashboard/settings", anchors: ['[data-tour="sk-children-consent"]'], needs: ["children"] },
  { id: "notifications", route: "/dashboard/settings", anchors: [BELL] },
  { id: "language", route: "/dashboard/settings", anchors: [LANGUAGE] },
  { id: "skMenu", route: "/dashboard/settings", anchors: [HERO, LAUNCHER] },
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
  { id: "notifications", route: "/dashboard/settings", anchors: [BELL] },
  { id: "language", route: "/dashboard/settings", anchors: [LANGUAGE] },
  // Founder decision 6: SK points at the hat switcher and NEVER switches it (that writes the hat cookie).
  { id: "hat", route: "/dashboard/school", anchors: ['[data-tour="hat-switcher"]', HERO], needs: ["roleHats"] },
  { id: "skAsk", route: "/dashboard/school", anchors: [TOUR_BUTTON, HERO, LAUNCHER] },
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
  { id: "notifications", route: "/dashboard/school", anchors: [BELL] },
  { id: "language", route: "/dashboard/school", anchors: [LANGUAGE] },
  { id: "hatSettings", route: "/dashboard/school", anchors: ['[data-tour="hat-switcher"]', SETTINGS_LINK, HERO] },
  { id: "skAsk", route: "/dashboard/school", anchors: [TOUR_BUTTON, HERO, LAUNCHER] },
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
