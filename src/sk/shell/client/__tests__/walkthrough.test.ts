/**
 * SK's first-login walkthrough — the pure engine (founder 2026-10-30):
 * the per-role plan against the user's facts (the script's Gaps), the state
 * machine's bounds, the position across remounts (sessionStorage), the anchor
 * search and the settled-page wait (2026-10-30: no fixed clock), the strict
 * sequence's auto-advance, and the tour commands in natural phrasing.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/walkthrough.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ADVANCE_AFTER_SPEECH_MS,
  ANCHOR_STABLE_MS,
  FACTS_TIMEOUT_MS,
  LOADING_CAP_MS,
  READ_MIN_MS,
  READ_MS_PER_CHAR,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
  START_SETTLE_CAP_MS,
  advanceDelay,
  atRoute,
  backStop,
  createWalkStarter,
  createWalkStore,
  currentStop,
  firstStopRoute,
  findAnchor,
  findParts,
  isActive,
  jumpTo,
  missingStop,
  needHolds,
  nextStop,
  joinParts,
  partAtSentence,
  partReadingStarts,
  partSentenceStarts,
  pauseWalk,
  planWalk,
  resolveRoute,
  resumeWalk,
  routePath,
  skipWalk,
  startWalk,
  readingMs,
  waitForSettledAnchor,
  waitForSettledPage,
  waitForStableRect,
  walkCommand,
  walkStartCommand,
  WALK_STORE_KEY,
  type PlannedStop,
  type WalkState,
} from "../walkthrough";
import { WALK_STOPS, walkRoleFor, type WalkFacts, type WalkRole } from "@/sk/walkthrough/stops";
import { splitSentences } from "../speech";

const ids = (stops: PlannedStop[]) => stops.map((s) => s.id);

const TEACHER_ALL: WalkFacts = { books: true, bookId: "b1", classId: "c1", catalogue: true, exam: true, diary: true, timetable: true, calendar: true, board: true, skTutor: true };

/** The teacher's tour in order (founder feedback 2026-10-30: precise and
 *  complete; then "combine steps 3 to 6" → openBook, "14, 15 and 16" → setup). */
const TEACHER_ORDER = [
  "hello", "library", "openBook", "generate", "pieces", "downloads", "rerun", "assign", "boardBridge", "more",
  "setup", "myBooks", "plan", "board", "boardSk", "kits", "skTutor", "diary", "analytics", "gradeQueue", "timetable", "calendar",
  "notifications", "language", "settings", "skMenu", "skAsk", "reportProblem", "uploadNow",
];
const partIds = (s: PlannedStop | undefined) => (s?.parts ?? []).map((p) => p.id);

describe("walkRoleFor: the hat first, then the role", () => {
  it("maps roles and hats to the five tours", () => {
    expect(walkRoleFor("student", "teacher")).toBe("student");
    expect(walkRoleFor("teacher", null)).toBe("teacher");
    expect(walkRoleFor("parent", null)).toBe("parent");
    expect(walkRoleFor("school_admin", null)).toBe("principal");
    expect(walkRoleFor("school_admin", "teacher")).toBe("teacher");
    expect(walkRoleFor("teacher", "coordinator")).toBe("coordinator");
    expect(walkRoleFor("coordinator", null)).toBe("coordinator");
    expect(walkRoleFor("teacher", "parent")).toBe("parent");
    expect(walkRoleFor(null, null)).toBe("teacher");
  });
});

describe("needHolds / resolveRoute", () => {
  it("unknown facts count as present, except the ones a stop cannot exist without", () => {
    expect(needHolds("diary", {})).toBe(true);
    expect(needHolds("diary", { diary: false })).toBe(false);
    expect(needHolds("class", {})).toBe(false);
    expect(needHolds("tutor", {})).toBe(false);
    expect(needHolds("children", {})).toBe(false);
    expect(needHolds("!tutor", {})).toBe(true);
    expect(needHolds("!schoolParent", { schoolParent: true })).toBe(false);
  });
  it("fills the tokens; a missing query value drops the parameter, a missing path value kills the route", () => {
    expect(resolveRoute("/dashboard/diary?c={classId}", { classId: "a b" })).toBe("/dashboard/diary?c=a%20b");
    expect(resolveRoute("/present?class={classId}", {})).toBe("/present");
    expect(resolveRoute("{tutorPath}", { tutorPath: "/sk/bio/3" })).toBe("/sk/bio/3");
    expect(resolveRoute("{tutorPath}", {})).toBeNull();
    expect(routePath("/dashboard/diary?c=1")).toBe("/dashboard/diary");
  });
});

describe("planWalk: per-role stops as built", () => {
  it("every role's stop count with everything on (teacher 14 → 32 → 27 combined → 29 with Report a problem and the Upload close, student 11 → 16, parent 12 → 16 (home 17), principal 12 → 16, coordinator 10 → 14)", () => {
    expect(planWalk("teacher", TEACHER_ALL)).toHaveLength(29);
    expect(planWalk("student", { diary: true, tutorPath: "/sk/bio/1" })).toHaveLength(16);
    expect(planWalk("parent", { children: 2, verifiedChildren: 2, schoolParent: true, diary: true, calendar: true, parentPortal: true })).toHaveLength(16);
    // Home educator: Library + kits in, notices + Test Papers out.
    expect(planWalk("parent", { children: 1, verifiedChildren: 1, schoolParent: false, catalogue: true })).toHaveLength(17);
    expect(planWalk("principal", { analytics: true, timetable: true, diary: true, notices: true, roleHats: true })).toHaveLength(16);
    expect(planWalk("coordinator", { timetable: true, diary: true, notices: true })).toHaveLength(14);
  });
  it("teacher order: the Library and its kits first (the Board bridge, then More), then the page, the Board, the other pages, the header and SK", () => {
    const p = planWalk("teacher", TEACHER_ALL);
    expect(ids(p)).toEqual(TEACHER_ORDER);
    // The Library stops open the tour's book (?book= opens its row); the rest of the page needs no hop.
    for (const id of TEACHER_ORDER.slice(1, 10)) expect(p.find((s) => s.id === id)?.route, id).toBe("/dashboard?book=b1");
    for (const id of ["setup", "myBooks", "plan"]) expect(p.find((s) => s.id === id)?.route, id).toBe("/dashboard");
    // The combined stops' parts, in narration order.
    expect(partIds(p.find((s) => s.id === "openBook"))).toEqual(["bookCard", "generateAll", "chapterKit", "lessonOptions"]);
    expect(partIds(p.find((s) => s.id === "setup"))).toEqual(["upload", "classes", "branding"]);
    expect(p.find((s) => s.id === "diary")?.route).toBe("/dashboard/diary?c=c1");
    expect(p.find((s) => s.id === "board")?.route).toBe("/present?class=c1");
    expect(p.find((s) => s.id === "generate")?.demo).toBe("lessonPrepare");
    expect(p.find((s) => s.id === "kits")?.chips).toEqual(["lessonOnPhotosynthesis"]);
    // The bridge comes right before More (founder 2026-10-30).
    expect(ids(p).indexOf("boardBridge")).toBe(ids(p).indexOf("more") - 1);
    // No book id: the parameter drops and the Library stops stay on /dashboard.
    expect(planWalk("teacher", { ...TEACHER_ALL, bookId: null }).find((s) => s.id === "library")?.route).toBe("/dashboard");
  });
  it("the Library is scrolled to the TOP of the screen; every other stop centres its control", () => {
    const p = planWalk("teacher", TEACHER_ALL);
    expect(p.find((s) => s.id === "library")?.scroll).toBe("start");
    for (const s of p) if (s.id !== "library") expect(s.scroll, s.id).toBeUndefined();
    for (const defs of Object.values(WALK_STOPS)) for (const d of defs) expect([undefined, "start", "center"]).toContain(d.scroll);
  });
  it("each Library stop points at ONE control in the open book: Generate kit on a part (never Generate all), Assign on a part, a pen on one chip, one download, More", () => {
    const p = planWalk("teacher", TEACHER_ALL);
    const first = (id: string) => p.find((s) => s.id === id)!.anchors[0]!.sel;
    expect(first("generate")).toBe('[data-tour-book="open"] [data-tour="generate-part"]');
    expect(p.find((s) => s.id === "generate")!.anchors.map((a) => a.sel)).not.toContain('[data-tour="generate-all"]');
    const part = (id: string) => p.find((s) => s.id === "openBook")!.parts!.find((x) => x.id === id)!.anchors[0]!.sel;
    expect(part("bookCard")).toBe('[data-tour-book="open"] [data-tour="book-badges"]');
    expect(part("generateAll")).toBe('[data-tour-book="open"] [data-tour="generate-all"]');
    expect(part("chapterKit")).toBe('[data-tour-book="open"] [data-tour="generate-lesson"][data-tour-kit="full"]');
    expect(part("lessonOptions")).toBe('[data-tour-book="open"] [data-tour="lesson-options"]');
    expect(first("assign")).toBe('[data-tour-book="open"] [data-tour="assign-part"]');
    expect(first("rerun")).toBe('[data-tour-book="open"] [data-tour="rerun"]');
    expect(first("downloads")).toBe('[data-tour-book="open"] [data-tour="download-doc"][data-tour-kind="worksheet"]');
    expect(first("more")).toBe('[data-tour-book="open"] [data-tour="book-tools"]');
    expect(first("library")).toBe('[data-tour="book-card"]');
  });
  it("no kit yet: assign, re-run, downloads and the pieces say 'once you generate a kit' at the ungenerated part (ordered fallbacks)", () => {
    const p = planWalk("teacher", TEACHER_ALL);
    const lines = { assign: "assignNone", rerun: "rerunNone", downloads: "downloadsNone", pieces: "piecesNone" } as const;
    for (const [id, line] of Object.entries(lines)) {
      const a = p.find((s) => s.id === id)!.anchors;
      const fb = a.filter((x) => x.line === line).map((x) => x.sel);
      expect(fb[0], id).toBe('[data-tour-book="open"] [data-tour="generate-part"]');
      expect(fb, id).toContain('[data-tour="upload-book"]');
      // The control itself comes first, with the stop's own line.
      expect(a[0]!.line, id).toBeUndefined();
    }
    // A page with only an ungenerated part: Assign's fallback is the one found, with its line.
    const dom = {
      query: (sel: string) => (sel === '[data-tour-book="open"] [data-tour="generate-part"]' ? { sel } : null),
      visible: () => true,
    };
    const hit = findAnchor(p.find((s) => s.id === "assign")!.anchors, dom)!;
    expect(hit.line).toBe("assignNone");
    expect(hit.index).toBeGreaterThan(0);
    // A generated part on the page: its Assign, with the stop's own line.
    const dom2 = { query: (sel: string) => (sel.endsWith('[data-tour="assign-part"]') || sel.endsWith('[data-tour="generate-part"]') ? { sel } : null), visible: () => true };
    const hit2 = findAnchor(p.find((s) => s.id === "assign")!.anchors, dom2)!;
    expect(hit2.sel).toBe('[data-tour-book="open"] [data-tour="assign-part"]');
    expect(hit2.line).toBeUndefined();
  });
  it("teacher with no book: the Library and the kit stops say what to do first, at the upload card", () => {
    const p = planWalk("teacher", { ...TEACHER_ALL, books: false, bookId: null });
    expect(ids(p)).not.toContain("more");
    // The open-book narration keeps only the part that needs no book: Lesson options.
    expect(partIds(p.find((s) => s.id === "openBook"))).toEqual(["lessonOptions"]);
    const gen = p.find((s) => s.id === "generate")!;
    expect(gen.line).toBe("noBooks");
    expect(gen.anchors.map((a) => a.sel)).toEqual(['[data-tour="upload-book"]']);
    const lib = p.find((s) => s.id === "library")!;
    expect(lib.anchors.slice(1)).toEqual([
      { sel: '[data-tour="library-empty"]', line: "libraryEmpty" },
      { sel: '[data-tour="upload-book"]', line: "libraryEmpty" },
    ]);
    // Assign, re-run, downloads and the pieces still explain themselves (their last fallback is the upload card).
    for (const id of ["pieces", "downloads", "rerun", "assign", "openBook"]) expect(ids(p)).toContain(id);
  });
  it("teacher with no class: the diary says what it is for at its tab; no timetable or calendar drops those; More follows FEATURE_EXAM", () => {
    const p = planWalk("teacher", { ...TEACHER_ALL, classId: null, timetable: false, calendar: false, exam: false });
    const diary = p.find((s) => s.id === "diary")!;
    expect(diary.line).toBe("diaryNoClass");
    expect(diary.route).toBe("/dashboard/diary");
    expect(diary.anchors[0]!.sel).toBe('[data-tour="diary-nav"]');
    expect(ids(p)).not.toContain("timetable");
    expect(ids(p)).not.toContain("calendar");
    expect(p.find((s) => s.id === "board")?.route).toBe("/present");
    expect(p.find((s) => s.id === "more")?.line).toBe("moreNoExam");
    // No Board: neither the bridge nor the Board stops.
    const nb = ids(planWalk("teacher", { ...TEACHER_ALL, board: false }));
    for (const id of ["boardBridge", "board", "boardSk"]) expect(nb).not.toContain(id);
  });
  it("student with no SK book: one neutral line instead of stops 6–9", () => {
    const p = planWalk("student", { diary: true });
    expect(ids(p)).toContain("tutorNone");
    for (const id of ["skBooks", "kitPlayer", "kitHelp", "kitNext"]) expect(ids(p)).not.toContain(id);
    const q = planWalk("student", { diary: true, tutorPath: "/sk/bio/2" });
    expect(ids(q)).not.toContain("tutorNone");
    expect(q.find((s) => s.id === "kitPlayer")?.route).toBe("/sk/bio/2");
  });
  it("student with nothing assigned: the empty My lessons, with its own line", () => {
    const s = planWalk("student", {}).find((x) => x.id === "openLesson")!;
    expect(s.anchors[1]).toEqual({ sel: '[data-tour="assignments"]', line: "openLessonEmpty" });
  });
  it("parent: no child → straight to Add child; unverified → say why; home educator → Library, no notices or Test Papers", () => {
    expect(ids(planWalk("parent", { children: 0, catalogue: false }))).toEqual(["hello", "homeLibrary", "reportProblem", "notifications", "language", "skMenu", "addChild", "uploadNow"]);
    expect(planWalk("parent", { children: 0 }).find((s) => s.id === "addChild")?.line).toBe("addChildFirst");
    const un = planWalk("parent", { children: 1, verifiedChildren: 0, schoolParent: true, parentPortal: true });
    expect(un.find((s) => s.id === "childCard")?.line).toBe("childUnverified");
    expect(ids(un)).not.toContain("week");
    expect(ids(un)).not.toContain("ask");
    const home = ids(planWalk("parent", { children: 1, verifiedChildren: 1, schoolParent: false, calendar: true }));
    expect(home).toContain("homeLibrary");
    expect(home).not.toContain("calendar");
    expect(home).not.toContain("testPapers");
    const school = ids(planWalk("parent", { children: 1, verifiedChildren: 1, schoolParent: true, parentPortal: true, calendar: true }));
    expect(school).toContain("testPapers");
    expect(school).not.toContain("homeLibrary");
  });
  it("leaders: a school feature that is off drops its stop; the principal's hat stop only points", () => {
    const p = planWalk("principal", { analytics: false, timetable: false, diary: false, notices: false, roleHats: false });
    expect(ids(p)).toEqual(["hello", "teachers", "access", "admin", "books", "schoolSwitch", "notifications", "language", "reportProblem", "skAsk"]);
    const hat = planWalk("principal", { roleHats: true }).find((s) => s.id === "hat")!;
    expect(hat.anchors[0].sel).toBe('[data-tour="hat-switcher"]');
    expect(hat.demo).toBeUndefined();
  });
  it("no stop anywhere ever goes to /activate or autostarts the Board", () => {
    for (const defs of Object.values(WALK_STOPS)) {
      for (const d of defs) {
        expect(d.route).not.toMatch(/activate|autostart/);
      }
    }
  });
});

// Founder 2026-10-30: "Can we combine steps 3 to 6 into 1 narration as all
// the features are available in 1 screen?" (and 14–16 likewise).
describe("combined stops: one narration, the highlight moving part by part", () => {
  const openBook = () => planWalk("teacher", TEACHER_ALL).find((s) => s.id === "openBook")!;
  const OPEN = '[data-tour-book="open"] ';
  it("a part whose fact is missing is left out, not the stop; no part at all = no stop", () => {
    const defs = [
      {
        id: "combo",
        route: "/dashboard",
        anchors: [],
        parts: [
          { id: "a", anchors: ["#a"], needs: ["books" as const] },
          { id: "b", anchors: ["#b"], needs: ["exam" as const] },
          { id: "c", anchors: ["#c"], fallback: [{ unless: "class" as const, line: "cNoClass" }] },
        ],
      },
    ];
    const all = planWalk("teacher", { books: true, exam: true, classId: "x" }, defs)[0]!;
    expect(all.parts!.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(all.line).toBe("a");
    expect(all.anchors.map((a) => a.sel)).toEqual(["#a", "#b", "#c"]);
    const some = planWalk("teacher", { books: false, exam: true }, defs)[0]!;
    expect(some.parts!.map((p) => [p.id, p.line])).toEqual([["b", "b"], ["c", "cNoClass"]]);
    expect(planWalk("teacher", { books: false, exam: false }, [{ ...defs[0]!, parts: defs[0]!.parts.slice(0, 2) }])).toEqual([]);
  });
  it("on the page: each part's own control, a fallback with its own line, a missing part dropped", () => {
    const on = new Set([OPEN + '[data-tour="book-badges"]', OPEN + '[data-tour="lesson-options"]', '[data-tour="book-card"]']);
    const dom = { query: (sel: string) => (on.has(sel) ? { sel } : null), visible: () => true };
    const hit = findParts(openBook().parts!, dom)!;
    // No Generate all: its fallback (the badges, "generateAllNone"); no chapter
    // kit nor Assign chapter: the book list ("chapterKitClosed").
    expect(hit.parts.map((p) => [p.id, p.line, (p.el as { sel: string }).sel])).toEqual([
      ["bookCard", "bookCard", OPEN + '[data-tour="book-badges"]'],
      ["generateAll", "generateAllNone", OPEN + '[data-tour="book-badges"]'],
      ["chapterKit", "chapterKitClosed", '[data-tour="book-card"]'],
      ["lessonOptions", "lessonOptions", OPEN + '[data-tour="lesson-options"]'],
    ]);
    // A fallback in play: provisional (taken only once the page has settled).
    expect(hit.index).toBe(1);
    expect((hit.el as { sel: string }).sel).toBe(OPEN + '[data-tour="book-badges"]');
    // Every part's own control: complete, taken as soon as it holds still.
    const full = { query: (sel: string) => (sel.startsWith(OPEN) ? { sel } : null), visible: () => true };
    expect(findParts(openBook().parts!, full)!.index).toBe(0);
    // A part with nothing on the page is left out of the narration.
    const two = { query: (sel: string) => (sel === OPEN + '[data-tour="lesson-options"]' || sel === OPEN + '[data-tour="generate-all"]' ? { sel } : null), visible: () => true };
    expect(findParts(openBook().parts!, two)!.parts.map((p) => p.id)).toEqual(["generateAll", "lessonOptions"]);
    expect(findParts(openBook().parts!, { query: () => null, visible: () => true })).toBeNull();
  });
  it("the highlight sequence: the part whose first sentence SK is starting", () => {
    const texts = ["One. Two.", "Three", "Four! Five? Six."];
    // A part that does not end a sentence gets a full stop in the ONE line.
    expect(joinParts(texts)).toBe("One. Two. Three. Four! Five? Six.");
    const starts = partSentenceStarts(texts, splitSentences);
    expect(starts).toEqual([0, 2, 3]);
    expect([0, 1, 2, 3, 4, 5].map((i) => partAtSentence(starts, i))).toEqual([0, 0, 1, 2, 2, 2]);
    expect(splitSentences(joinParts(texts))).toHaveLength(6);
    // The real lines: every sentence of the joined line belongs to one part, in order.
    const en = ["Each book shows its badges. Tap a book.", "Generate all makes them all.", "Generate full kit makes one.", "Lesson options set the voice."];
    const st = partSentenceStarts(en, splitSentences);
    const seq = splitSentences(joinParts(en)).map((_, i) => partAtSentence(st, i));
    expect(seq).toEqual([0, 0, 1, 2, 3]);
    // A part with no words shares the next part's start (never highlighted alone).
    expect(partSentenceStarts(["A.", "", "B."], splitSentences)).toEqual([0, 1, 1]);
    // Without sound: each part's share of the reading time, starting at 0.
    const t = partReadingStarts(["x".repeat(100), "y".repeat(100)]);
    expect(t[0]).toBe(0);
    expect(t[1]).toBe(Math.round(readingMs(joinParts(["x".repeat(100), "y".repeat(100)])) / 2));
  });
  it("Step N of M counts a combined stop once; next / back move over it as one stop", () => {
    const p = planWalk("teacher", TEACHER_ALL);
    const i = ids(p).indexOf("openBook");
    let s = jumpTo(startWalk("teacher", p, { record: false, runId: "c" }), i);
    expect(currentStop(s)!.id).toBe("openBook");
    s = nextStop(s);
    expect(currentStop(s)!.id).toBe("generate");
    s = backStop(backStop(s));
    expect(currentStop(s)!.id).toBe("library");
    expect(s.stops).toHaveLength(29);
  });
  it("a combined stop survives the sessionStorage round trip; a broken parts list reads as none", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const store = createWalkStore(storage);
    const w = startWalk("teacher", planWalk("teacher", TEACHER_ALL), { record: false, runId: "p" });
    store.save(jumpTo(w, 2));
    expect(currentStop(store.load()!)!.parts!.map((x) => x.id)).toEqual(["bookCard", "generateAll", "chapterKit", "lessonOptions"]);
    const bad = { ...w, stops: w.stops.map((x) => (x.parts ? { ...x, parts: [{ id: 1 }] } : x)) };
    mem.set(WALK_STORE_KEY, JSON.stringify(bad));
    expect(store.load()).toBeNull();
  });
});

// Founder 2026-10-30: "SK missed the report issue feature using the bottom
// left and in line for a failed kit."
describe("Report a problem: the inline report on a failed kit first, else the bottom-left widget", () => {
  const OPEN = '[data-tour-book="open"] ';
  const FAILED = '[data-tour="report-failure"]';
  const WIDGET = '[data-tour="report-issue"]';
  const stop = (role: Parameters<typeof planWalk>[0], facts: WalkFacts) => planWalk(role, facts).find((s) => s.id === "reportProblem");
  it("teacher: on the Library, the open book's failed kit, any failed kit, then the widget with its own line", () => {
    const s = stop("teacher", TEACHER_ALL)!;
    expect(s.route).toBe("/dashboard?book=b1");
    expect(s.anchors).toEqual([{ sel: OPEN + FAILED }, { sel: FAILED }, { sel: WIDGET, line: "reportProblemWidget" }]);
    expect(s.line).toBe("reportProblem");
    // A failed kit on screen: its inline report, with the stop's own line.
    const both = { query: (sel: string) => (sel === FAILED || sel === WIDGET ? { sel } : null), visible: () => true };
    const hit = findAnchor(s.anchors, both)!;
    expect(hit.sel).toBe(FAILED);
    expect(hit.line).toBeUndefined();
    expect(hit.index).toBe(1);
    // None: the widget, with the widget line (a fallback: taken once the page has settled).
    const widget = { query: (sel: string) => (sel === WIDGET ? { sel } : null), visible: () => true };
    expect(findAnchor(s.anchors, widget)).toMatchObject({ sel: WIDGET, line: "reportProblemWidget", index: 2 });
    // Neither on the page: nothing (the settled wait then passes the stop over).
    expect(findAnchor(s.anchors, { query: () => null, visible: () => true })).toBeNull();
  });
  it("skipped when the widget is off (platformConsoleEnabled() false); unknown counts as present", () => {
    for (const role of ["teacher", "student", "parent", "principal", "coordinator"] as const) {
      expect(stop(role, { reportIssue: false, children: 1, verifiedChildren: 1 }), role).toBeUndefined();
      expect(stop(role, { children: 1, verifiedChildren: 1 }), role).toBeDefined();
    }
  });
  it("every role gets it near the end, on a page that renders the widget, before the closing stop", () => {
    const routes = { student: "/dashboard", parent: "/dashboard", principal: "/dashboard/school", coordinator: "/dashboard/school" } as const;
    for (const [role, route] of Object.entries(routes) as Array<[keyof typeof routes, string]>) {
      const p = planWalk(role, { children: 1, verifiedChildren: 1, diary: true, tutorPath: "/sk/a/1", roleHats: true });
      const s = p.find((x) => x.id === "reportProblem")!;
      expect(s.route, role).toBe(route);
      expect(ids(p).indexOf("reportProblem"), role).toBeGreaterThan(p.length / 2);
      expect(ids(p).at(-1), role).not.toBe("reportProblem");
    }
    // The School pages have no kits: the widget only.
    expect(stop("principal", {})!.anchors).toEqual([{ sel: WIDGET }]);
    expect(stop("coordinator", {})!.anchors).toEqual([{ sel: WIDGET }]);
    // The student's and the parent's dashboards: any failed kit, then the widget.
    expect(stop("student", {})!.anchors.map((a) => a.sel)).toEqual([FAILED, WIDGET]);
    expect(stop("parent", {})!.anchors.map((a) => a.sel)).toEqual([FAILED, WIDGET]);
  });
});

// Founder 2026-10-30: "at the end tell SK to get back to library and
// highlight the upload button and ask the client, click here to upload your
// textbook if you are ready."
describe("the close: back on the Library, at Upload", () => {
  const UPLOAD = '[data-tour="upload-book"]';
  it("teacher: the LAST stop, on the Library route, pointing at Upload, with or without a book", () => {
    for (const facts of [TEACHER_ALL, { ...TEACHER_ALL, books: false, bookId: null }, { ...TEACHER_ALL, board: false, diary: false, reportIssue: false }]) {
      const p = planWalk("teacher", facts);
      const last = p.at(-1)!;
      expect(last.id).toBe("uploadNow");
      expect(last.route).toBe(facts.bookId ? `/dashboard?book=${facts.bookId}` : "/dashboard");
      expect(last.anchors).toEqual([{ sel: UPLOAD }]);
      expect(last.line).toBe("uploadNow");
      // Report a problem comes right before it.
      if (facts.reportIssue !== false) expect(ids(p).at(-2)).toBe("reportProblem");
    }
    // The old /dashboard `upload` stop is gone: Upload is only a part of the setup narration.
    const p = planWalk("teacher", TEACHER_ALL);
    expect(ids(p)).not.toContain("upload");
    expect(p.filter((s) => s.anchors[0]?.sel === UPLOAD).map((s) => s.id)).toEqual(["setup", "uploadNow"]);
  });
  it("a home educator parent closes the same way; a school parent, the student and the leaders keep their endings", () => {
    const home = planWalk("parent", { children: 1, verifiedChildren: 1, schoolParent: false });
    expect(ids(home).at(-1)).toBe("uploadNow");
    expect(home.at(-1)!.route).toBe("/dashboard");
    expect(ids(home).at(-2)).toBe("addChild");
    const school = planWalk("parent", { children: 1, verifiedChildren: 1, schoolParent: true, parentPortal: true });
    expect(ids(school).at(-1)).toBe("addChild");
    expect(ids(school)).not.toContain("uploadNow");
    for (const role of ["student", "principal", "coordinator"] as const) {
      const p = planWalk(role, { roleHats: true });
      expect(ids(p).at(-1), role).toBe("skAsk");
      expect(ids(p), role).not.toContain("uploadNow");
    }
  });
});

const plan = (n: number): PlannedStop[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, route: i < 2 ? "/dashboard" : "/dashboard/kits", line: `s${i}`, anchors: [{ sel: `#s${i}` }] }));
const run = (n = 4, record = true) => startWalk("teacher", plan(n), { record, runId: "r1" });

describe("the state machine", () => {
  it("next walks in order and finishes after the last stop", () => {
    let s = run(3);
    expect(s.status).toBe("running");
    expect(currentStop(s)?.id).toBe("s0");
    s = nextStop(s);
    s = nextStop(s);
    expect(currentStop(s)?.id).toBe("s2");
    s = nextStop(s);
    expect(s.status).toBe("done");
    expect(currentStop(s)).toBeNull();
    expect(nextStop(s)).toBe(s); // a finished tour does not move
  });
  it("back stops at the first stop", () => {
    let s = backStop(run());
    expect(s.index).toBe(0);
    s = backStop(nextStop(nextStop(s)));
    expect(s.index).toBe(1);
    expect(s.dir).toBe(-1);
  });
  it("pause holds the stop; resume carries on from it; next while paused moves and runs", () => {
    let s = nextStop(run());
    s = pauseWalk(s, "question");
    expect(s.status).toBe("paused");
    expect(s.pausedBy).toBe("question");
    expect(currentStop(s)?.id).toBe("s1");
    expect(pauseWalk(s)).toBe(s);
    s = resumeWalk(s);
    expect(s.status).toBe("running");
    expect(s.pausedBy).toBeUndefined();
    expect(currentStop(s)?.id).toBe("s1");
    s = nextStop(pauseWalk(s));
    expect(s.status).toBe("running");
    expect(s.index).toBe(2);
  });
  it("jump clamps to the plan; skip ends it as skipped", () => {
    expect(jumpTo(run(), 99).index).toBe(3);
    expect(jumpTo(run(), -3).index).toBe(0);
    const s = skipWalk(run());
    expect(s.status).toBe("skipped");
    expect(isActive(s)).toBe(false);
    expect(nextStop(s)).toBe(s);
  });
  it("an empty plan is done at once", () => {
    expect(startWalk("teacher", [], { record: true, runId: "x" }).status).toBe("done");
  });
  it("a missing anchor is passed over silently, in the direction of travel", () => {
    let s = nextStop(run(4)); // at s1, going forward
    s = missingStop(s);
    expect(currentStop(s)?.id).toBe("s2");
    expect(s.stops).toHaveLength(3);
    s = backStop(s); // at s0? no: s2 → back → s0 (s1 is gone)
    expect(currentStop(s)?.id).toBe("s0");
    s = jumpTo(s, 1); // s2
    s = backStop(s); // s0, dir -1
    s = missingStop(s); // s0 missing going back → the first that exists, now forward
    expect(currentStop(s)?.id).toBe("s2");
    expect(s.dir).toBe(1);
    // the last stop missing going forward finishes the tour
    let t = jumpTo(run(2), 1);
    t = missingStop(t);
    expect(t.status).toBe("done");
  });
});

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("the position survives page moves and remounts (sessionStorage)", () => {
  it("a second store over the same storage (the /present or /sk launcher) reads the same position", () => {
    const st = memStorage();
    const a = createWalkStore(st);
    const s = pauseWalk(nextStop(nextStop(run(4))), "user");
    a.save(s);
    const b = createWalkStore(st);
    const back = b.load() as WalkState;
    expect(back.index).toBe(2);
    expect(back.status).toBe("paused");
    expect(back.record).toBe(true);
    expect(back.stops.map((x) => x.id)).toEqual(["s0", "s1", "s2", "s3"]);
  });
  it("an ended run is not kept, so nothing resumes it", () => {
    const st = memStorage();
    const a = createWalkStore(st);
    a.save(run());
    expect(st.m.has(WALK_STORE_KEY)).toBe(true);
    a.save(skipWalk(run()));
    expect(st.m.has(WALK_STORE_KEY)).toBe(false);
    expect(a.load()).toBeNull();
  });
  it("garbage, a bad index or no storage read as none", () => {
    const st = memStorage();
    st.setItem(WALK_STORE_KEY, "{nope");
    expect(createWalkStore(st).load()).toBeNull();
    st.setItem(WALK_STORE_KEY, JSON.stringify({ ...run(2), index: 5 }));
    expect(createWalkStore(st).load()).toBeNull();
    st.setItem(WALK_STORE_KEY, JSON.stringify({ ...run(2), role: "janitor" }));
    expect(createWalkStore(st).load()).toBeNull();
    st.setItem(WALK_STORE_KEY, JSON.stringify({ ...run(2), stops: [{ id: "x", route: "https://evil.example", line: "x", anchors: [] }] }));
    expect(createWalkStore(st).load()).toBeNull();
    expect(createWalkStore(null).load()).toBeNull();
    expect(() => createWalkStore(null).save(run())).not.toThrow();
  });
});

describe("anchors", () => {
  type El = { id: string; shown: boolean };
  const dom = (els: Record<string, El>) => ({ query: (sel: string) => els[sel] ?? null, visible: (e: El) => e.shown });

  it("the first VISIBLE anchor wins, with its own line", () => {
    const d = dom({ "#a": { id: "a", shown: false }, "#b": { id: "b", shown: true } });
    expect(findAnchor([{ sel: "#a" }, { sel: "#b", line: "empty" }], d)).toEqual({ el: { id: "b", shown: true }, sel: "#b", line: "empty", index: 1 });
    expect(findAnchor([{ sel: "#b" }], d)).toEqual({ el: { id: "b", shown: true }, sel: "#b", index: 0 });
    expect(findAnchor([{ sel: "#zz" }], d)).toBeNull();
    expect(findAnchor([{ sel: "[bad" }], { query: () => { throw new Error("bad selector"); }, visible: () => true })).toBeNull();
  });

  it("with queryAll, the first VISIBLE match of a selector wins (a collapsed book's control does not hide an open one's)", () => {
    const hidden = { id: "closed", shown: false };
    const open = { id: "open", shown: true };
    const d = { query: () => hidden, queryAll: () => [hidden, open], visible: (e: El) => e.shown };
    expect(findAnchor([{ sel: "#x" }], d)?.el).toBe(open);
    expect(findAnchor([{ sel: "#x" }], { query: () => hidden, visible: (e: El) => e.shown })).toBeNull();
  });

  /** A fake page: a clock, one pending timer at a time, a probe and an observer. */
  function fakePage(init: { pathOk?: boolean; ready?: boolean; loading?: boolean } = {}) {
    let t = 0;
    const timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let nextId = 1;
    let notify: () => void = () => {};
    let unsubscribed = false;
    const page = { pathOk: init.pathOk ?? true, ready: init.ready ?? true, loading: init.loading ?? false };
    return {
      page,
      now: () => t,
      setTimer: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.push({ at: t + ms, fn, id });
        return id;
      },
      clearTimer: (h: unknown) => {
        const i = timers.findIndex((x) => x.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
      probe: { pathOk: () => page.pathOk, ready: () => page.ready, loading: () => page.loading },
      observe: (cb: () => void) => {
        notify = cb;
        return () => {
          unsubscribed = true;
          notify = () => {};
        };
      },
      /** A DOM change now. */
      mutate: () => notify(),
      unsubscribed: () => unsubscribed,
      /** Run the clock forward, firing timers in order. */
      advance(ms: number) {
        const end = t + ms;
        for (;;) {
          timers.sort((a, b) => a.at - b.at);
          const next = timers[0];
          if (!next || next.at > end) break;
          timers.shift();
          t = next.at;
          next.fn();
        }
        t = end;
      },
    };
  }
  const box = (top = 10) => ({ top, left: 0, width: 100, height: 40 });

  it("a slow page: the anchor appears late (after the old 4 s) and is found once it holds still", async () => {
    const p = fakePage({ loading: true });
    let el: { id: string } | null = null;
    let rect = box(10);
    const wait = waitForSettledAnchor({ find: () => el, rect: () => rect, ...p });
    // Six seconds of a loading page with no anchor: never "missing" (the old clock gave up at 4 s).
    for (let i = 0; i < 30; i++) {
      p.mutate();
      p.advance(200);
    }
    el = { id: "book-card" };
    p.advance(200); // seen once
    rect = box(80); // still moving (the page above it streamed in)
    p.advance(200);
    p.page.loading = false;
    p.advance(200); // the same box twice, 200 ms apart
    await expect(wait).resolves.toEqual({ id: "book-card" });
    expect(p.unsubscribed()).toBe(true);
  });
  it("a FALLBACK anchor waits for the page to settle, so a control that streams in late still wins", async () => {
    const p = fakePage({ loading: true });
    type Hit = { id: string; index: number };
    let hit: Hit = { id: "upload-card", index: 1 }; // the fallback is on the page first
    let done = false;
    const wait = waitForSettledAnchor<Hit>({ find: () => hit, rect: () => box(10), same: (a, b) => a.id === b.id, provisional: (h) => h.index > 0, ...p }).then(
      (v) => ((done = true), v),
    );
    for (let i = 0; i < 10; i++) {
      p.mutate();
      p.advance(200);
    }
    await Promise.resolve();
    expect(done).toBe(false); // stable, but the page is still loading: not taken
    hit = { id: "book-list", index: 0 }; // the stop's own control streams in
    p.page.loading = false;
    p.advance(400);
    await expect(wait).resolves.toEqual({ id: "book-list", index: 0 });
    // A page that settles with only the fallback takes it.
    const q = fakePage();
    const w2 = waitForSettledAnchor<Hit>({ find: () => ({ id: "upload-card", index: 1 }), rect: () => box(10), same: (a, b) => a.id === b.id, provisional: (h) => h.index > 0, ...q });
    q.advance(SETTLE_QUIET_MS + 400);
    await expect(w2).resolves.toEqual({ id: "upload-card", index: 1 });
  });
  it("an invisible (zero-size) anchor is not found", async () => {
    const p = fakePage();
    const el = { id: "hidden" };
    const wait = waitForSettledAnchor({ find: () => el, rect: () => ({ top: 0, left: 0, width: 0, height: 0 }), ...p });
    p.advance(SETTLE_CAP_MS + 200);
    await expect(wait).resolves.toBeNull(); // in the DOM but showing nothing, even at the cap
    const p2 = fakePage();
    let gone = false;
    const wait2 = waitForSettledAnchor({ find: () => (gone ? null : el), rect: () => ({ top: 0, left: 0, width: 0, height: 0 }), ...p2 });
    p2.advance(400);
    gone = true;
    p2.advance(SETTLE_QUIET_MS + 400);
    await expect(wait2).resolves.toBeNull();
  });
  it("settles empty: missing is decided only after the page is loaded, without loading UI, quiet for ~800 ms", async () => {
    const p = fakePage({ pathOk: false, ready: false, loading: true });
    let done = false;
    const wait = waitForSettledAnchor({ find: () => null, rect: () => box(), ...p }).then((v) => ((done = true), v));
    p.advance(3000);
    p.page.pathOk = true; // the navigation landed
    p.advance(3000);
    p.page.ready = true;
    p.advance(3000);
    await Promise.resolve();
    expect(done).toBe(false); // the loading ring is still up
    p.page.loading = false;
    p.mutate(); // the page swapped in
    p.advance(SETTLE_QUIET_MS - 200);
    await Promise.resolve();
    expect(done).toBe(false); // not quiet long enough
    p.advance(400);
    await expect(wait).resolves.toBeNull();
  });
  it("the cap (~20 s): an anchor that keeps moving is taken as it is", async () => {
    const p = fakePage({ loading: true });
    const el = { id: "carousel" };
    let top = 0;
    const wait = waitForSettledAnchor({ find: () => el, rect: () => box((top += 7)), ...p });
    p.advance(SETTLE_CAP_MS + 200);
    await expect(wait).resolves.toBe(el);
  });
  it("the cap (~20 s): a page that never settles gives up with what it has", async () => {
    const p = fakePage({ loading: true });
    const wait = waitForSettledAnchor({ find: () => null, rect: () => box(), ...p });
    p.advance(SETTLE_CAP_MS - 400);
    let settled = false;
    void wait.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    p.advance(600);
    await expect(wait).resolves.toBeNull();
  });
  it("abort ends the wait at once (Skip, a move, the page unmounted)", async () => {
    const ac = new AbortController();
    const p = fakePage({ loading: true });
    const wait = waitForSettledAnchor({ find: () => null, rect: () => box(), ...p, signal: ac.signal });
    p.advance(1000);
    ac.abort();
    await expect(wait).resolves.toBeNull();
    const pre = new AbortController();
    pre.abort();
    await expect(waitForSettledAnchor({ find: () => ({}), rect: () => box(), ...fakePage(), signal: pre.signal })).resolves.toBeNull();
  });
  it("a stop with nothing to point at plays once the page has settled", async () => {
    const p = fakePage({ loading: true });
    const hit = { el: null };
    const wait = waitForSettledAnchor({ find: () => hit, rect: () => null, ...p });
    p.advance(2000);
    p.page.loading = false;
    p.advance(SETTLE_QUIET_MS + 200);
    await expect(wait).resolves.toBe(hit);
  });
  it("two finds of the same element are the same anchor (the browser compares elements)", async () => {
    const p = fakePage();
    const el = { id: "x" };
    const wait = waitForSettledAnchor({ find: () => ({ el }), rect: () => box(), same: (a, b) => a.el === b.el, ...p });
    p.advance(ANCHOR_STABLE_MS);
    await expect(wait).resolves.toEqual({ el });
  });
  it("the start's own wait for the page she is on is capped (START_SETTLE_CAP_MS, ~2 s), even on a page that never stops loading", async () => {
    const p = fakePage({ loading: true });
    let started = false;
    const wait = waitForSettledPage({ ...p, capMs: START_SETTLE_CAP_MS }).then((v) => ((started = v), v));
    for (let i = 0; i < 9; i++) {
      p.mutate(); // streaming
      p.advance(200);
    }
    await Promise.resolve();
    expect(started).toBe(false);
    p.advance(START_SETTLE_CAP_MS - 1800 + 200);
    await expect(wait).resolves.toBe(true);
    expect(START_SETTLE_CAP_MS).toBeLessThanOrEqual(2000);
    const ac = new AbortController();
    const p2 = fakePage({ loading: true });
    const w2 = waitForSettledPage({ ...p2, signal: ac.signal });
    ac.abort();
    await expect(w2).resolves.toBe(false);
  });
  // Production 2026-10-30: the library stop's log said still-loading:aria-busy —
  // the Library keeps aria-busy while it streams kit chunks.
  it("a long-lived aria-busy (a streaming Library) no longer holds a stop with something to show past LOADING_CAP_MS", async () => {
    // A fallback anchor, the page loaded and quiet, aria-busy forever.
    const p = fakePage({ loading: true });
    type Hit = { id: string; index: number };
    let at = -1;
    const wait = waitForSettledAnchor<Hit>({ find: () => ({ id: "badges", index: 1 }), rect: () => box(10), same: (a, b) => a.id === b.id, provisional: (h) => h.index > 0, ...p }).then(
      (v) => ((at = p.now()), v),
    );
    p.advance(LOADING_CAP_MS - 200);
    await Promise.resolve();
    expect(at).toBe(-1); // before the cap the loading UI still counts
    p.advance(600);
    await expect(wait).resolves.toEqual({ id: "badges", index: 1 });
    expect(at).toBeGreaterThanOrEqual(LOADING_CAP_MS);
    expect(at).toBeLessThan(LOADING_CAP_MS + 1000); // not the old 20 s cap
    // A stop with no anchor at all (rect null) likewise.
    const q = fakePage({ loading: true });
    const hit = { el: null };
    const w2 = waitForSettledAnchor({ find: () => hit, rect: () => null, ...q });
    q.advance(LOADING_CAP_MS + 400);
    await expect(w2).resolves.toBe(hit);
    // Quiet is still required: a page still changing is not settled.
    const r = fakePage({ loading: true });
    let done = false;
    const w3 = waitForSettledAnchor({ find: () => hit, rect: () => null, ...r }).then(() => (done = true));
    for (let i = 0; i < 25; i++) {
      r.mutate();
      r.advance(200);
    }
    await Promise.resolve();
    expect(done).toBe(false);
    r.advance(SETTLE_QUIET_MS + 200);
    await w3;
  });
  it("…but a stop with NOTHING found keeps waiting while the page is loading (skipping on a streaming page was the old bug)", async () => {
    const p = fakePage({ loading: true });
    let done = false;
    const wait = waitForSettledAnchor({ find: () => null, rect: () => box(), ...p }).then((v) => ((done = true), v));
    p.advance(LOADING_CAP_MS * 3);
    await Promise.resolve();
    expect(done).toBe(false);
    p.page.loading = false;
    p.advance(SETTLE_QUIET_MS + 200);
    await expect(wait).resolves.toBeNull();
  });
  it("the scroll has finished when the box stops moving", async () => {
    const p = fakePage();
    let top = 500;
    let resolved = false;
    const w = waitForStableRect({ rect: () => box(top), setTimer: p.setTimer }).then(() => (resolved = true));
    top = 300; // scrolling
    p.advance(100);
    top = 120;
    p.advance(100);
    await Promise.resolve();
    expect(resolved).toBe(false);
    p.advance(100); // 120 twice: the scroll has finished
    await w;
    expect(resolved).toBe(true);
  });
});

describe("strict sequence: when the tour may move on by itself", () => {
  it("sound on: ~1 s after the line has FULLY been spoken; never while it is still being spoken", () => {
    expect(advanceDelay({ status: "running", soundOn: true, outcome: "spoken", text: "Hello." })).toBe(ADVANCE_AFTER_SPEECH_MS);
    expect(ADVANCE_AFTER_SPEECH_MS).toBe(1000);
    expect(advanceDelay({ status: "running", soundOn: true, outcome: null, text: "Hello." })).toBeNull();
  });
  it("a line cut off (barge-in, Stop, an error) never advances: Next or Resume", () => {
    expect(advanceDelay({ status: "running", soundOn: true, outcome: "stopped", text: "Hello." })).toBeNull();
  });
  it("sound off (or read-aloud off): the reading time, 55 ms a character, at least 5 s", () => {
    const long = "x".repeat(200);
    expect(advanceDelay({ status: "running", soundOn: false, text: long })).toBe(200 * READ_MS_PER_CHAR);
    expect(advanceDelay({ status: "running", soundOn: false, text: "Short." })).toBe(READ_MIN_MS);
    expect(advanceDelay({ status: "running", soundOn: true, outcome: "silent", text: long })).toBe(11_000);
    expect(readingMs("")).toBe(5000);
  });
  it("a pause or a question holds it", () => {
    expect(advanceDelay({ status: "paused", soundOn: true, outcome: "spoken", text: "Hi." })).toBeNull();
    expect(advanceDelay({ status: "paused", soundOn: false, text: "Hi." })).toBeNull();
    expect(advanceDelay({ status: "done", soundOn: false, text: "Hi." })).toBeNull();
  });
});

describe("walkCommand: tour commands, never a question", () => {
  it("knows next / back / pause / continue / skip in several languages", () => {
    expect(walkCommand("Next")).toBe("next");
    expect(walkCommand("next.")).toBe("next");
    expect(walkCommand("seterusnya")).toBe("next");
    expect(walkCommand("التالي")).toBe("next");
    expect(walkCommand("go back")).toBe("back");
    expect(walkCommand("pause")).toBe("pause");
    expect(walkCommand("Continue the tour")).toBe("resume");
    expect(walkCommand("teruskan")).toBe("resume");
    expect(walkCommand("skip")).toBe("skip");
  });
  it("natural phrasing: greetings and fillers stripped, the command anywhere in a short message about the tour", () => {
    expect(walkCommand("Hi, continue with the tour?")).toBe("resume");
    expect(walkCommand("go to the next one")).toBe("next");
    expect(walkCommand("skip this tour please")).toBe("skip");
    expect(walkCommand("ok next")).toBe("next");
    expect(walkCommand("Okay SK, let's go back")).toBe("back");
    expect(walkCommand("can you continue the tour")).toBe("resume");
    expect(walkCommand("Hey, end the tour")).toBe("skip");
    expect(walkCommand("please pause the tour")).toBe("pause");
    expect(walkCommand("sila teruskan lawatan")).toBe("resume");
    expect(walkCommand("مرحبا، تابع الجولة")).toBe("resume");
    expect(walkCommand("Salut, continuer la visite")).toBe("resume");
    expect(walkCommand("hola, siguiente por favor")).toBe("next");
  });
  it("a real question stays a question", () => {
    expect(walkCommand("how do I continue a lesson?")).toBeNull();
    expect(walkCommand("what's next?")).toBeNull();
    expect(walkCommand("next slide")).toBeNull();
    expect(walkCommand("how are my classes")).toBeNull();
    expect(walkCommand("stop")).toBeNull(); // "stop" alone is not "end the tour"
    expect(walkCommand("don't skip the tour")).toBeNull();
    expect(walkCommand("continue writing the diary note for 7B please")).toBeNull();
    expect(walkCommand("Hi, could you please continue with the tour you were giving me just now")).toBeNull(); // > 8 words
    expect(walkCommand("")).toBeNull();
  });
  it("loose (the server, while a tour is on): longer, but the tour must be named", () => {
    expect(walkCommand("Hi SK, could you please continue with the tour you were giving me", { loose: true })).toBe("resume");
    expect(walkCommand("go to the next one", { loose: true })).toBeNull();
    expect(walkCommand("how do I end a lesson in the tour", { loose: true })).toBeNull();
  });
});

// 2026-10-30 (founder: "Continue with the tour." with NO tour running went to
// the model, which said there is no tour): with no run, it starts one.
describe("walkStartCommand: 'continue / start the tour' with no tour running", () => {
  it("natural phrasing that names the tour, in the app languages", () => {
    for (const t of [
      "Continue with the tour.",
      "continue the tour",
      "Hi, continue with the tour?",
      "Hi SK, could you please continue with the tour you were giving me",
      "resume the tour",
      "carry on with the tour please",
      "start the tour",
      "Ok, start the tour now",
      "can you begin the tour",
      "restart the tour",
      "sila teruskan lawatan",
      "مرحبا، تابع الجولة",
      "Salut, continuer la visite",
    ]) {
      expect(walkStartCommand(t), t).toBe(true);
    }
  });
  it("the tour must be named; questions and other commands are not a start", () => {
    for (const t of [
      "continue",
      "carry on",
      "resume the video",
      "continue writing the diary note for 7B please",
      "how do I continue the tour?",
      "what is the tour about",
      "don't start the tour",
      "skip the tour",
      "next",
      "",
    ]) {
      expect(walkStartCommand(t), t).toBe(false);
    }
  });
});

// 2026-10-31 (founder: "SK show me around still didn't start the tour").
// Production: "Show me around" at 18:46:49, stop 1 at 18:47:32 — the start
// fetched the facts, then waited for the Library (aria-busy while streaming)
// to settle before stop 1 even began.
describe("the start: at once, never waiting for a page stop 1 is not on", () => {
  type Ctx = { record: boolean };
  function harness(o: { here?: string; role?: WalkRole; facts?: () => Promise<{ role?: string; facts?: WalkFacts } | null>; settle?: (capMs: number) => Promise<boolean> } = {}) {
    const log: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let id = 0;
    const ready: Array<{ role: WalkRole; stops: string[]; ctx: Ctx }> = [];
    const starter = createWalkStarter<Ctx>({
      roleGuess: () => o.role ?? "teacher",
      here: () => o.here ?? "/dashboard?book=b1",
      navigate: (r) => log.push(`navigate ${r}`),
      loadFacts: () => (log.push("facts"), o.facts ? o.facts() : Promise.resolve({ role: o.role ?? "teacher", facts: TEACHER_ALL })),
      settle: (capMs) => (log.push(`settle ${capMs}`), o.settle ? o.settle(capMs) : Promise.resolve(true)),
      onStarting: (on) => log.push(on ? "starting" : "started"),
      onReady: (role, stops, ctx) => ready.push({ role, stops: stops.map((s) => s.id), ctx }),
      setTimer: (fn, ms) => (timers.push({ fn, ms, id: ++id }), id),
      clearTimer: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return { starter, log, timers, ready, flush };
  }

  it("says it is starting and opens stop 1's page at once, before the facts are back", async () => {
    let answer: (v: { role?: string; facts?: WalkFacts }) => void = () => {};
    const h = harness({ role: "parent", here: "/dashboard", facts: () => new Promise((r) => (answer = r)) });
    expect(h.starter.start({ record: false })).toBe(true);
    // Synchronously: the bubble, then the parent's stop 1 page — the facts still pending.
    expect(h.log).toEqual(["starting", "navigate /dashboard/children", "facts"]);
    answer({ role: "parent", facts: { children: 1, verifiedChildren: 1 } });
    await h.flush();
    // Stop 1 is on another page than the one she started on: no settle wait at all.
    expect(h.log).not.toContain(`settle ${START_SETTLE_CAP_MS}`);
    expect(h.log.some((l) => l.startsWith("settle"))).toBe(false);
    expect(h.ready).toHaveLength(1);
    expect(h.ready[0]!.stops[0]).toBe("hello");
    expect(h.log[h.log.length - 1]).toBe("started");
  });

  it("stop 1 on the page she is on (the teacher on the Library, /dashboard?book=…): no navigation, a settle capped at ~2 s", async () => {
    const h = harness();
    h.starter.start({ record: true });
    await h.flush();
    expect(h.log.some((l) => l.startsWith("navigate"))).toBe(false);
    expect(h.log).toContain(`settle ${START_SETTLE_CAP_MS}`);
    expect(h.ready).toEqual([expect.objectContaining({ role: "teacher", ctx: { record: true } })]);
    expect(atRoute("/dashboard", "/dashboard?book=b1")).toBe(true);
    expect(atRoute("/dashboard?book=b1", "/dashboard")).toBe(false);
    expect(atRoute("/present?class=c1", "/present?class=c1")).toBe(true);
    expect(firstStopRoute("principal")).toBe("/dashboard/school");
  });

  it("a second start while one is starting joins it: ONE tour", async () => {
    let answer: (v: { role?: string; facts?: WalkFacts }) => void = () => {};
    const h = harness({ facts: () => new Promise((r) => (answer = r)) });
    expect(h.starter.start({ record: true })).toBe(true);
    expect(h.starter.starting).toBe(true);
    // She taps "Take the tour" during the delay.
    expect(h.starter.start({ record: false })).toBe(false);
    expect(h.log.filter((l) => l === "facts")).toHaveLength(1);
    answer({ role: "teacher", facts: TEACHER_ALL });
    await h.flush();
    expect(h.ready).toHaveLength(1);
    expect(h.ready[0]!.ctx).toEqual({ record: true });
    expect(h.starter.starting).toBe(false);
    // …and once started, a new start works again (a replay).
    expect(h.starter.start({ record: false })).toBe(true);
    answer({ role: "teacher", facts: TEACHER_ALL });
    await h.flush();
    expect(h.ready).toHaveLength(2);
  });

  it("never stuck starting: a facts request that hangs gives up after FACTS_TIMEOUT_MS, a failed one starts with no facts, Skip cancels", async () => {
    const h = harness({ facts: () => new Promise(() => {}) });
    h.starter.start({ record: false });
    expect(h.timers.map((t) => t.ms)).toEqual([FACTS_TIMEOUT_MS]);
    h.timers.shift()!.fn();
    await h.flush();
    expect(h.ready).toHaveLength(1); // started without the facts (the stops that need one drop out)
    expect(h.starter.starting).toBe(false);

    const f = harness({ facts: () => Promise.reject(new Error("offline")) });
    f.starter.start({ record: false });
    await f.flush();
    expect(f.ready).toHaveLength(1);
    expect(f.starter.starting).toBe(false);

    const c = harness({ facts: () => new Promise(() => {}) });
    c.starter.start({ record: false });
    c.starter.cancel();
    expect(c.starter.starting).toBe(false);
    expect(c.log[c.log.length - 1]).toBe("started");
    await c.flush();
    expect(c.ready).toHaveLength(0);
    expect(c.starter.start({ record: false })).toBe(true); // she can ask again
  });
});
