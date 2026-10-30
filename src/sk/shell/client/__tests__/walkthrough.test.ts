/**
 * SK's first-login walkthrough — the pure engine (founder 2026-10-30):
 * the per-role plan against the user's facts (the script's Gaps), the state
 * machine's bounds, the position across remounts (sessionStorage), the anchor
 * search / wait, and the bare tour commands.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/walkthrough.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  ANCHOR_TIMEOUT_MS,
  backStop,
  createWalkStore,
  currentStop,
  findAnchor,
  isActive,
  jumpTo,
  missingStop,
  needHolds,
  nextStop,
  pauseWalk,
  planWalk,
  resolveRoute,
  resumeWalk,
  routePath,
  skipWalk,
  startWalk,
  waitForAnchor,
  walkCommand,
  WALK_STORE_KEY,
  type PlannedStop,
  type WalkState,
} from "../walkthrough";
import { WALK_STOPS, walkRoleFor, type WalkFacts } from "@/sk/walkthrough/stops";

const ids = (stops: PlannedStop[]) => stops.map((s) => s.id);

const TEACHER_ALL: WalkFacts = { books: true, classId: "c1", catalogue: true, exam: true, diary: true, timetable: true, board: true };

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
  it("every role's stop count with everything on (teacher 14, student 11, parent 12, principal 12, coordinator 10)", () => {
    expect(planWalk("teacher", TEACHER_ALL)).toHaveLength(14);
    expect(planWalk("student", { diary: true, tutorPath: "/sk/bio/1" })).toHaveLength(11);
    expect(planWalk("parent", { children: 2, verifiedChildren: 2, schoolParent: true, diary: true, calendar: true, parentPortal: true })).toHaveLength(12);
    expect(planWalk("parent", { children: 1, verifiedChildren: 1, schoolParent: false })).toHaveLength(11); // home educator: Library in, notices + Test Papers out
    expect(planWalk("principal", { analytics: true, timetable: true, diary: true, notices: true, roleHats: true })).toHaveLength(12);
    expect(planWalk("coordinator", { timetable: true, diary: true, notices: true })).toHaveLength(10);
  });
  it("teacher order follows the script and the Board stop carries the first class", () => {
    const p = planWalk("teacher", TEACHER_ALL);
    expect(ids(p)).toEqual(["hello", "library", "generate", "output", "assign", "classes", "myBooks", "kits", "analytics", "gradeQueue", "diary", "timetable", "board", "settings"]);
    expect(p.find((s) => s.id === "diary")?.route).toBe("/dashboard/diary?c=c1");
    expect(p.find((s) => s.id === "board")?.route).toBe("/present?class=c1");
    expect(p.find((s) => s.id === "generate")?.demo).toBe("lessonPrepare");
    expect(p.find((s) => s.id === "kits")?.chips).toEqual(["lessonOnPhotosynthesis"]);
  });
  it("teacher with no book: ONE upload line stands in for stops 3–5", () => {
    const p = planWalk("teacher", { ...TEACHER_ALL, books: false });
    expect(ids(p)).not.toContain("output");
    expect(ids(p)).not.toContain("assign");
    const gen = p.find((s) => s.id === "generate")!;
    expect(gen.line).toBe("noBooks");
    expect(gen.anchors.map((a) => a.sel)).toEqual(['[data-tour="upload-book"]']);
    expect(p.find((s) => s.id === "library")!.anchors.map((a) => a.sel)).toEqual(['[data-tour="upload-book"]']);
  });
  it("teacher with no class skips the diary; no timetable skips 12; the test paper line follows FEATURE_EXAM", () => {
    const p = planWalk("teacher", { ...TEACHER_ALL, classId: null, timetable: false, exam: false });
    expect(ids(p)).not.toContain("diary");
    expect(ids(p)).not.toContain("timetable");
    expect(p.find((s) => s.id === "board")?.route).toBe("/present");
    expect(p.find((s) => s.id === "output")?.line).toBe("outputNoExam");
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
    expect(ids(planWalk("parent", { children: 0 }))).toEqual(["hello", "homeLibrary", "addChild"]);
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
    expect(ids(p)).toEqual(["hello", "teachers", "access", "admin", "books", "schoolSwitch"]);
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
    expect(findAnchor([{ sel: "#a" }, { sel: "#b", line: "empty" }], d)).toEqual({ el: { id: "b", shown: true }, sel: "#b", line: "empty" });
    expect(findAnchor([{ sel: "#zz" }], d)).toBeNull();
    expect(findAnchor([{ sel: "[bad" }], { query: () => { throw new Error("bad selector"); }, visible: () => true })).toBeNull();
  });

  function fakeClock() {
    let fn: (() => void) | null = null;
    let ms = 0;
    return { setTimer: (f: () => void, m: number) => ((fn = f), (ms = m), 1), clearTimer: () => void (fn = null), fire: () => fn?.(), ms: () => ms };
  }

  it("resolves when the anchor appears after a page change", async () => {
    let present: string | null = null;
    let notify = () => {};
    const clock = fakeClock();
    const p = waitForAnchor({ find: () => present, observe: (cb) => ((notify = cb), () => (notify = () => {})), ...clock });
    notify(); // a mutation, still nothing
    present = "here";
    notify();
    await expect(p).resolves.toBe("here");
    expect(clock.ms()).toBe(ANCHOR_TIMEOUT_MS);
  });
  it("gives up with null after the timeout (the stop is then skipped)", async () => {
    const clock = fakeClock();
    let unsubscribed = false;
    const p = waitForAnchor({ find: () => null, observe: () => () => (unsubscribed = true), ...clock });
    clock.fire();
    await expect(p).resolves.toBeNull();
    expect(unsubscribed).toBe(true);
  });
  it("an abort (she pressed Skip, or the page unmounted) ends the wait", async () => {
    const ac = new AbortController();
    const clock = fakeClock();
    const p = waitForAnchor({ find: () => null, observe: () => () => {}, signal: ac.signal, ...clock });
    ac.abort();
    await expect(p).resolves.toBeNull();
  });
});

describe("walkCommand: a bare tour command, never a question", () => {
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
  it("anything longer is a question for SK", () => {
    expect(walkCommand("what's next?")).toBeNull();
    expect(walkCommand("next slide")).toBeNull();
    expect(walkCommand("how are my classes")).toBeNull();
    expect(walkCommand("")).toBeNull();
  });
});
