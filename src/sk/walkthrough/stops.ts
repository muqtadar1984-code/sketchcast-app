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
//   route    — where it happens. `{classId}` / `{bookId}` are filled from
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
//   parts    — (founder 2026-10-30: "combine them into 1 narration as all the
//              features are available in 1 screen") ONE stop that narrates
//              several controls on the same page, in order. Each part has its
//              own anchors (with their own fallback lines), its own line and
//              its own needs / fallback, exactly like a stop: a part whose
//              fact is missing, or whose anchors are all absent, is left out
//              of the narration; the stop is skipped only when every part is.
//              2026-10-31 (founder: "1 or no more than 3 sentences and avoid
//              repetitions"): when every part plays with its own line, the
//              stop says its PRECOMPOSED line (sk.walkthrough.<role>.<stop
//              id>), one or two sentences with a `{partId}` marker where each
//              later part begins; otherwise the found parts' short clauses
//              (each part's line: one sentence opening with its control's
//              name) are composed into ≤ 3 sentences. The highlight moves to
//              a part as SK reaches its marker (walkthrough.ts partCues /
//              cueDelay); markers are never shown or spoken. A parts stop's
//              own `anchors` stay [] and are not used.
//
// 2026-10-31 (founder: "the tour is approx 6 to 7 minutes … bring it down
// to less than 4 minutes"): every line is one short sentence (two at most
// for a combined stop), and the teacher's same-page neighbours are folded
// into combined stops (kit, classBoard, readyMade, insights, bellLanguage,
// skHelp): 29 stops → 22.
//
// 2026-10-31 (founder: "remove sk tutor, we dont need a separate tutor.
// existing books can be taught on the board itself. that removes 1 step from
// sk tour"): no stop visits or names SK Tutor. The teacher's readyMade stop
// (Ready-made kits + the SK Tutor tab) is the kits stop alone; the student's
// five tutor stops (tutorNone, skBooks, kitPlayer, kitHelp, kitNext) are gone;
// the parent's homeKits no longer points at the tab.

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
  /** Parent: linked children, and how many of those links are verified. */
  children?: number;
  verifiedChildren?: number;
  /** Parent: at least one link came from a school (parent_links.source). */
  schoolParent?: boolean;
  parentPortal?: boolean;
  /** The floating "Report a problem" widget renders (platformConsoleEnabled()). */
  reportIssue?: boolean;
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
  | "children"
  | "verified"
  | "schoolParent"
  | "parentPortal"
  | "reportIssue";

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

/** What to do instead when a fact is missing (a stop's or a part's). */
export type WalkFallback = { unless: WalkNeedSpec; line?: string; anchors?: WalkAnchor[]; skip?: true };

/** One part of a combined stop: a control, its line, its own needs. */
export type WalkPartDef = {
  /** Stable id; also the default line key. */
  id: string;
  anchors: WalkAnchor[];
  /** The line key when it differs from `id`. */
  line?: string;
  needs?: WalkNeedSpec[];
  fallback?: WalkFallback[];
};

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
  fallback?: WalkFallback[];
  demo?: WalkDemo;
  chips?: WalkChip[];
  /** A combined stop: one narration over these controls, in order (see the header). */
  parts?: WalkPartDef[];
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

// "Report a problem" (founder 2026-10-30: "SK missed the report issue feature
// using the bottom left and in line for a failed kit"). The inline "report" on
// a FAILED kit item (report-failure.tsx, content-cell.tsx's error state) when
// one is on screen, else the floating widget (report-issue-form.tsx, bottom
// left; bottom right in RTL). The widget renders only with
// platformConsoleEnabled() (the `reportIssue` fact): without it the stop
// skips (the inline control posts to the same /api/issues, which is off too).
const REPORT_FAILED = '[data-tour="report-failure"]';
const REPORT_WIDGET = '[data-tour="report-issue"]';
/** `inline`: "open" looks in the tour's open book first (the Library), "any"
 *  anywhere on the page, "none" only the widget (the School pages have no kits). */
const reportProblem = (route: string, inline: "open" | "any" | "none"): WalkStopDef => ({
  id: "reportProblem",
  route,
  anchors:
    inline === "none"
      ? [REPORT_WIDGET]
      : [...(inline === "open" ? [OPEN + REPORT_FAILED] : []), REPORT_FAILED, { sel: REPORT_WIDGET, line: "reportProblemWidget" }],
  needs: ["reportIssue"],
});

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
  // Steps 3–6 were four stops on one screen (founder 2026-10-30: "combine
  // steps 3 to 6 into 1 narration as all the features are available in 1
  // screen"): the open book's badges, Generate all, Generate full kit and
  // Lesson options — one narration, the highlight moving part by part.
  {
    id: "openBook",
    route: LIB,
    anchors: [],
    parts: [
      { id: "bookCard", anchors: [OPEN + BOOK_BADGES, BOOK_BADGES], needs: ["books"] },
      {
        id: "generateAll",
        anchors: [OPEN + GENERATE_ALL, GENERATE_ALL, { sel: OPEN + BOOK_BADGES, line: "generateAllNone" }, { sel: BOOK_BADGES, line: "generateAllNone" }],
        needs: ["books"],
      },
      {
        id: "chapterKit",
        anchors: [OPEN + FULL_KIT, FULL_KIT, { sel: OPEN + ASSIGN_CHAPTER, line: "chapterKitDone" }, { sel: BOOK_LIST, line: "chapterKitClosed" }],
        needs: ["books"],
      },
      {
        id: "lessonOptions",
        anchors: [
          OPEN + LESSON_OPTIONS,
          LESSON_OPTIONS,
          { sel: OPEN + BOOK_BADGES, line: "lessonOptionsNone" },
          { sel: BOOK_LIST, line: "lessonOptionsNone" },
          { sel: UPLOAD, line: "lessonOptionsNone" },
        ],
      },
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
  // A finished kit's pieces, its downloads and its pen: one screen, one
  // narration (2026-10-31, folded from three stops).
  {
    id: "kit",
    route: LIB,
    anchors: [],
    parts: [
      { id: "pieces", anchors: [OPEN + PART_PIECES, PART_PIECES, OPEN + CHAPTER_OUTPUT, CHAPTER_OUTPUT, ...notYet("piecesNone")] },
      { id: "downloads", anchors: [OPEN + DOWNLOAD_WORKSHEET, OPEN + DOWNLOAD, DOWNLOAD_WORKSHEET, DOWNLOAD, ...notYet("downloadsNone")] },
      { id: "rerun", anchors: [OPEN + RERUN, RERUN, ...notYet("rerunNone")] },
    ],
  },
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
  // Steps 14–16 were three stops on one screen (founder 2026-10-30: "also on
  // the same screen, combine them all into 1 narration"). Upload is a brief
  // mention here; the closing stop is the invitation to upload.
  {
    id: "setup",
    route: "/dashboard",
    anchors: [],
    parts: [
      { id: "upload", anchors: [UPLOAD] },
      { id: "classes", anchors: ['[data-tour="classes"]'] },
      { id: "branding", anchors: ['[data-tour="branding"]'] },
    ],
  },
  { id: "myBooks", route: "/dashboard", anchors: ['[data-tour="my-books"]', { sel: HERO, line: "myBooksNone" }] },
  // The meter (fair-use-meter.tsx) renders NOTHING for an unlimited plan
  // (my_fair_use().unlimited: staff, school plans with no cap), when the read
  // fails, or without lesson tools — production 2026-10-30: {provider:"plan",
  // why:"missing", error:"/dashboard settled"}. Then SK says so at its avatar.
  { id: "plan", route: "/dashboard", anchors: ['[data-tour="fair-use"]', { sel: HERO, line: "planUnlimited" }] },
  // No autostart: pressing Start opens a Board session, so the tour only
  // describes it. The Board and SK on it: one narration (2026-10-31).
  {
    id: "classBoard",
    route: "/present?class={classId}",
    anchors: [],
    needs: ["board"],
    parts: [
      { id: "board", anchors: ['[data-tour="board-bar"]', '[data-sk="launcher"][data-sk-board="true"]'] },
      { id: "boardSk", anchors: ['[data-sk="launcher"][data-sk-board="true"]', HERO, LAUNCHER] },
    ],
  },
  // Ready-made kits (the SK Tutor tab that shared this page is retired, 2026-10-31).
  { id: "kits", route: "/dashboard/kits", anchors: ['[data-tour="kits-allowance"]'], needs: ["catalogue"], chips: ["lessonOnPhotosynthesis"] },
  // No class yet: the diary still says what it is for, at its tab.
  {
    id: "diary",
    route: "/dashboard/diary?c={classId}",
    anchors: ['[data-tour="diary-compose"]'],
    needs: ["diary"],
    demo: "diaryNote",
    fallback: [{ unless: "class", line: "diaryNoClass", anchors: ['[data-tour="diary-nav"]', MOBILE_NAV, HERO] }],
  },
  // My Analytics and the grade queue: one page, one narration (2026-10-31).
  {
    id: "insights",
    route: "/dashboard/analytics",
    anchors: [],
    chips: ["howAreMyClasses", "whoIsAtRisk"],
    demo: "markingGrade",
    parts: [
      { id: "analytics", anchors: ['[data-tour="analytics-metrics"]'] },
      { id: "gradeQueue", anchors: ['[data-tour="grade-queue"]'] },
    ],
  },
  { id: "timetable", route: "/dashboard/my-timetable", anchors: ['[data-tour="my-timetable"]'], needs: ["timetable"], chips: ["whatsNext"] },
  { id: "calendar", route: "/dashboard/calendar", anchors: ['[data-tour="calendar-grid"]'], needs: ["calendar"] },
  // The bell and the language switch, side by side in the header (2026-10-31).
  {
    id: "bellLanguage",
    route: "/dashboard/settings",
    anchors: [],
    parts: [
      { id: "notifications", anchors: [BELL] },
      { id: "language", anchors: [LANGUAGE] },
    ],
  },
  {
    id: "settings",
    route: "/dashboard/settings",
    anchors: ['[data-tour="sk-prefs"]', '[data-tour="sk-memory"]', '[data-sk="mic"]', '[data-sk="input"]', SETTINGS_LINK],
  },
  // SK's own menu only exists while it is open: the tour points at the
  // avatar and names what is in it; then how to ask, at the Tour button.
  {
    id: "skHelp",
    route: "/dashboard/settings",
    anchors: [],
    parts: [
      { id: "skMenu", anchors: [HERO, LAUNCHER] },
      { id: "skAsk", anchors: [TOUR_BUTTON, HERO, LAUNCHER] },
    ],
  },
  // Near the end, back on the Library (a failed kit's inline report is there).
  reportProblem(LIB, "open"),
  // The close (founder 2026-10-30: "at the end tell SK to get back to library
  // and highlight the upload button and ask the client, click here to upload
  // your textbook if you are ready"). The invitation lives only here: the
  // `setup` narration just names Upload, so it is not said twice.
  { id: "uploadNow", route: LIB, anchors: [UPLOAD] },
];

const STUDENT: WalkStopDef[] = [
  { id: "hello", route: "/dashboard", anchors: [HERO, LAUNCHER] },
  { id: "assignments", route: "/dashboard", anchors: ['[data-tour="assignments"]'] },
  // Nothing assigned: say so and show the empty "My lessons".
  { id: "openLesson", route: "/dashboard", anchors: ['[data-tour="open-lesson"]', { sel: '[data-tour="assignments"]', line: "openLessonEmpty" }] },
  { id: "progress", route: "/dashboard", anchors: ['[data-tour="progress"]', { sel: '[data-tour="assignments"]', line: "progressEmpty" }] },
  { id: "myBooks", route: "/dashboard", anchors: ['[data-tour="my-books"]', { sel: HERO, line: "myBooksNone" }], demo: "bookActivate" },
  { id: "diaryTimetable", route: "/dashboard", anchors: ['[data-tour="diary-nav"]', '[data-tour="timetable-nav"]', MOBILE_NAV], needs: ["diary"] },
  // Near the end, while the tour is still on /dashboard (the widget's page).
  reportProblem("/dashboard", "any"),
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
  { id: "homeKits", route: "/dashboard", anchors: ['[data-tour="kits-nav"]', MOBILE_NAV], needs: ["!schoolParent", "catalogue"] },
  // Near the end, while the tour is still on /dashboard (the widget's page).
  reportProblem("/dashboard", "any"),
  { id: "consent", route: "/dashboard/settings", anchors: ['[data-tour="sk-children-consent"]'], needs: ["children"] },
  { id: "notifications", route: "/dashboard/settings", anchors: [BELL] },
  { id: "language", route: "/dashboard/settings", anchors: [LANGUAGE] },
  { id: "skMenu", route: "/dashboard/settings", anchors: [HERO, LAUNCHER] },
  { id: "addChild", route: "/dashboard/children", anchors: ['[data-tour="add-child"]'], fallback: [{ unless: "children", line: "addChildFirst" }] },
  // A home educator uploads books like a teacher: the same close, at Upload
  // on their Library. A school parent's tour keeps its Add child ending.
  { id: "uploadNow", route: "/dashboard", anchors: [UPLOAD], needs: ["!schoolParent"] },
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
  // The School page carries the widget too (raised for the briefing bot).
  reportProblem("/dashboard/school", "none"),
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
  reportProblem("/dashboard/school", "none"),
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

/** Every anchor a stop names: its own, its fallbacks', and its parts' (theirs
 *  and their fallbacks'). */
export function anchorsOf(d: WalkStopDef | WalkPartDef): WalkAnchor[] {
  const own = [...d.anchors, ...(d.fallback ?? []).flatMap((f) => f.anchors ?? [])];
  const parts = "parts" in d && d.parts ? d.parts.flatMap(anchorsOf) : [];
  return [...own, ...parts];
}

/** Every line key a role's stops can say (the stop ids — for a combined stop,
 *  its parts' ids instead —, their fallback lines and their anchors' own
 *  lines) — the i18n test checks each one exists. */
export function lineKeysFor(role: WalkRole): string[] {
  const keys = new Set<string>();
  const add = (d: WalkStopDef | WalkPartDef) => {
    keys.add(d.line ?? d.id);
    for (const f of d.fallback ?? []) if (f.line) keys.add(f.line);
    for (const a of [...d.anchors, ...(d.fallback ?? []).flatMap((f) => f.anchors ?? [])]) if (typeof a !== "string") keys.add(a.line);
  };
  for (const s of WALK_STOPS[role]) {
    if (s.parts?.length) {
      // Its precomposed line (all parts there), and each part's clauses.
      keys.add(s.line ?? s.id);
      s.parts.forEach(add);
    } else add(s);
  }
  return [...keys];
}
