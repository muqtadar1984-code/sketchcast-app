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
  READ_MIN_MS,
  READ_MS_PER_CHAR,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
  advanceDelay,
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
  readingMs,
  waitForSettledAnchor,
  waitForSettledPage,
  waitForStableRect,
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
  it("the tour's start waits for the home page to settle", async () => {
    const p = fakePage({ loading: true });
    let started = false;
    const wait = waitForSettledPage({ ...p }).then((v) => ((started = v), v));
    p.advance(5000);
    await Promise.resolve();
    expect(started).toBe(false);
    p.page.loading = false;
    p.advance(SETTLE_QUIET_MS + 200);
    await expect(wait).resolves.toBe(true);
    const ac = new AbortController();
    const p2 = fakePage({ loading: true });
    const w2 = waitForSettledPage({ ...p2, signal: ac.signal });
    ac.abort();
    await expect(w2).resolves.toBe(false);
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
