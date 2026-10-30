/**
 * The SK ⇄ Board bridge (S1 slice B): every move → the expected controller
 * calls on a fake controller, the segment watcher pausing at end_s, the
 * practise subset, the collector state, the manifest adapter and the
 * building→ready polling.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/sk-board-bridge.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardController, BoardState } from "../board-controller";
import { createBoardBridge, loadManifest, practiseStart, segmentAt, toBridgeManifest, type BridgeManifest, type KitManifestLike, type ManifestReply } from "../sk-board-bridge";
import { activeSelection, createAskChannel, type HeldSelection } from "../highlight-select";

// ── a fake controller that records calls and simulates a playhead ──────────

function fakeController() {
  const calls: Array<[string, ...unknown[]]> = [];
  const st: BoardState = { sessionId: "sess-1", t: 0, duration: 120, paused: true, moving: false, stageMode: "away", page: 0, pageCount: 1, ended: false, questions: null, actions: [] };
  const c: BoardController = {
    play: async () => {
      calls.push(["play"]);
      st.paused = false;
    },
    resume: async () => {
      calls.push(["resume"]);
      st.paused = false;
    },
    pause: () => {
      calls.push(["pause"]);
      st.paused = true;
    },
    seek: async (t) => {
      calls.push(["seek", t]);
      st.t = t;
      return t;
    },
    seekMeasured: async (t) => {
      calls.push(["seekMeasured", t]);
      st.t = t;
      return { target: t, landed: t, errorMs: 0, latencyMs: 1, presentedMediaTime: t, frameErrorMs: 0, frameLatencyMs: 1 };
    },
    seekSegment: async (k, edge, m) => {
      calls.push(["seekSegment", k, edge]);
      st.t = edge === "start" ? m.segments[k].start_s : m.segments[k].end_s;
      return { target: st.t, landed: st.t, errorMs: 0, latencyMs: 1, presentedMediaTime: st.t, frameErrorMs: 0, frameLatencyMs: 1 };
    },
    slide: async (k, m) => {
      calls.push(["slide", k]);
      st.paused = true;
      st.t = m.segments[k].slide_t ?? m.segments[k].end_s;
      const v = m.segments[k].visual;
      return v?.show === "frame" ? { shown: "frame", shownK: k, reason: "" } : v?.show === "fallback_frame" ? { shown: "fallback_frame", shownK: v.fallback_k ?? k, reason: "" } : { shown: "caption", shownK: k, reason: "" };
    },
    freeze: async () => {
      calls.push(["freeze"]);
      st.paused = true;
      st.pageCount++;
      st.page = st.pageCount - 1;
      return true;
    },
    openWorksheetPage: () => {
      calls.push(["openWorksheetPage"]);
      return true;
    },
    blankPage: () => {
      calls.push(["blankPage"]);
      st.pageCount++;
      st.page = st.pageCount - 1;
    },
    pageUp: () => {
      calls.push(["pageUp"]);
      st.page = Math.max(0, st.page - 1);
    },
    pageDown: () => {
      calls.push(["pageDown"]);
    },
    showQuestions: async (start = 0, count?: number) => {
      calls.push(count === undefined ? ["showQuestions", start] : ["showQuestions", start, count]);
      st.questions = { generationId: "ws", index: start, total: 6 };
      return count === undefined ? { index: start, total: 6 } : { index: start, total: 6, shown: Math.min(count, 6 - start), of: 6 };
    },
    nextQuestion: async () => {
      calls.push(["nextQuestion"]);
      return { index: 1, total: 6 };
    },
    prevQuestion: async () => {
      calls.push(["prevQuestion"]);
      return { index: 0, total: 6 };
    },
    getState: () => ({ ...st, actions: [] }),
    endSession: async () => {
      calls.push(["endSession"]);
      st.ended = true;
      return true;
    },
    getUnit: () => unit,
  };
  let unit: ReturnType<BoardController["getUnit"]> = { generationId: "gen-1", part: 1, title: "Cells" };
  return { c, calls, st, setUnit: (u: typeof unit) => (unit = u) };
}

const KIT: KitManifestLike = {
  manifest_id: "man-1",
  segments: [
    { segment_id: "s1", part: 1, k: 0, start_s: 0, end_s: 20, slide_t: 19.9, heading: "Introduction", points: [], visual: { status: "distinct", show: "frame", reason: "ok" } },
    { segment_id: "s2", part: 1, k: 1, start_s: 20, end_s: 50, slide_t: 49.9, heading: "Red blood cells", points: ["Carry oxygen", ""], visual: { status: "reused_relevant", show: "fallback_frame", fallback_k: 0, reason: "same frame" } },
    { segment_id: "s3", part: 1, k: 2, start_s: 50, end_s: 80, slide_t: 79.9, heading: "Nerve cells", points: ["Carry signals"], visual: { status: "misleading", show: "caption_only", reason: "unrelated" } },
    { segment_id: "s4", part: 2, k: 3, start_s: 0, end_s: 30, slide_t: 29.9, heading: "Part two", points: [], visual: { status: "unknown", show: "fallback_frame", fallback_k: 0, reason: "cross-part" } },
  ],
  concepts: [{ concept_id: "c-rbc", name: "red blood cell", segment_ids: ["s2"] }],
  items: [
    { q_id: "ws:q1", source: "worksheet", generation_id: "ws", segment_ids: ["s1"] },
    { q_id: "ws:q4", source: "worksheet", generation_id: "ws", segment_ids: ["s3"] },
    { q_id: "ws:q3", source: "worksheet", generation_id: "ws", segment_ids: ["s3", "s2"] },
    { q_id: "quiz:q2", source: "quiz", generation_id: "qz", segment_ids: ["s3"] },
  ],
};

describe("toBridgeManifest (structural adapter)", () => {
  it("keeps one part in play order, remaps fallback frames to local indices, drops empty points", () => {
    const m = toBridgeManifest(KIT, 1);
    expect(m.manifestId).toBe("man-1");
    expect(m.ids).toEqual(["s1", "s2", "s3"]);
    expect(m.segments.map((s) => s.heading)).toEqual(["Introduction", "Red blood cells", "Nerve cells"]);
    expect(m.segments[1].points).toEqual(["Carry oxygen"]);
    expect(m.segments[1].visual).toEqual({ status: "reused_relevant", show: "fallback_frame", fallback_k: 0, reason: "same frame" });
    expect(m.segments[2].visual?.show).toBe("caption_only");
    expect(m.concepts).toEqual([{ id: "c-rbc", name: "red blood cell", segmentIds: ["s2"] }]);
    expect(m.items).toHaveLength(4);
  });
  it("a fallback outside the unit degrades to a caption; part null takes every segment", () => {
    const p2 = toBridgeManifest(KIT, 2);
    expect(p2.ids).toEqual(["s4"]);
    expect(p2.segments[0].visual?.show).toBe("caption_only");
    expect(toBridgeManifest(KIT, null).segments).toHaveLength(4);
  });
});

describe("segmentAt / practiseStart (pure)", () => {
  const m = toBridgeManifest(KIT, 1);
  it("finds the segment under the playhead, else the last one passed", () => {
    expect(segmentAt(m, 0)).toBe(0);
    expect(segmentAt(m, 25)).toBe(1);
    expect(segmentAt(m, 79.99)).toBe(2);
    expect(segmentAt(m, 95)).toBe(2);
    expect(segmentAt({ segments: [] }, 5)).toBeUndefined();
  });
  it("first worksheet question mapped to the segment (q_ids are 1-based), else 0", () => {
    expect(practiseStart(m, "s3")).toBe(2); // ws:q3 before ws:q4; quiz items ignored
    expect(practiseStart(m, "s1")).toBe(0);
    expect(practiseStart(m, "s9")).toBe(0);
    expect(practiseStart(null, "s3")).toBe(0);
    expect(practiseStart(m, undefined)).toBe(0);
  });
});

describe("createBoardBridge — moves → controller calls", () => {
  let fc: ReturnType<typeof fakeController>;
  let manifest: BridgeManifest | null;
  let ctl: BoardController | null;
  // No `generationId` dep: the unit comes from the controller's getUnit() (slice C).
  const bridge = () =>
    createBoardBridge({
      controller: () => ctl,
      manifest: () => manifest,
      mapStatus: () => (manifest ? "ready" : "building"),
      pollMs: 250,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    fc = fakeController();
    ctl = fc.c;
    manifest = toBridgeManifest(KIT, 1);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("state(): session, playhead, segment, manifest id, headings/points/ids and concepts for the server", () => {
    fc.st.t = 25.26;
    fc.st.paused = false;
    fc.st.page = 2;
    const s = bridge().state();
    expect(s).toMatchObject({ sessionId: "sess-1", t: 25.3, paused: false, rollPage: 2, k: 1, segmentId: "s2", manifestId: "man-1", generationId: "gen-1" });
    expect(s?.segments).toEqual([
      { k: 0, heading: "Introduction", id: "s1" },
      { k: 1, heading: "Red blood cells", id: "s2", points: ["Carry oxygen"] },
      { k: 2, heading: "Nerve cells", id: "s3", points: ["Carry signals"] },
    ]);
    expect(s?.concepts).toEqual([{ id: "c-rbc", name: "red blood cell", segmentIds: ["s2"] }]);
  });
  it("state() is undefined with no controller or an ended session; status follows the map", () => {
    ctl = null;
    const b = bridge();
    expect(b.state()).toBeUndefined();
    ctl = fc.c;
    fc.st.ended = true;
    expect(bridge().state()).toBeUndefined();
    manifest = null;
    expect(bridge().status()).toBe("building");
  });
  it("without a manifest the state still names the session (no k / segments)", () => {
    manifest = null;
    const s = bridge().state();
    expect(s).toEqual({ sessionId: "sess-1", t: 0, paused: true, rollPage: 0, rollCount: 1, generationId: "gen-1" });
  });
  it("unit(): the controller's getUnit() wins; the host's generationId dep is only a fallback", () => {
    expect(bridge().unit()).toEqual({ generationId: "gen-1", part: 1, title: "Cells" });
    fc.setUnit(null);
    expect(bridge().unit()).toBeNull();
    expect(bridge().state()?.generationId).toBeUndefined();
    const withFallback = createBoardBridge({ controller: () => ctl, generationId: () => "gen-old", manifest: () => manifest, mapStatus: () => "ready" });
    expect(withFallback.unit()).toEqual({ generationId: "gen-old", part: null, title: null });
    expect(withFallback.state()?.generationId).toBe("gen-old");
    fc.setUnit({ generationId: "gen-2", part: 2, title: null });
    expect(withFallback.unit()).toEqual({ generationId: "gen-2", part: 2, title: null });
  });

  it("intro → seek(0) + play, leaves the video playing", async () => {
    const r = await bridge().run("intro", {});
    expect(r).toMatchObject({ ok: true, plays: true });
    expect(fc.calls).toEqual([["seek", 0], ["play"]]);
  });
  it("segment k → seekSegment(k, start) + resume, then pauses at end_s via the watcher", async () => {
    const b = bridge();
    const r = await b.run("segment", { k: 1 });
    expect(r).toMatchObject({ ok: true, plays: true });
    expect(fc.calls).toEqual([["seekSegment", 1, "start"], ["resume"]]);
    // The playhead advances; nothing happens before the end.
    fc.st.t = 35;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fc.calls.filter((c) => c[0] === "pause")).toHaveLength(0);
    fc.st.t = 49.97; // within SEGMENT_END_SLACK_S of 50
    await vi.advanceTimersByTimeAsync(300);
    expect(fc.calls.filter((c) => c[0] === "pause")).toHaveLength(1);
    expect(fc.st.paused).toBe(true);
    // And the watcher is gone: a later playhead past the end pauses nothing more.
    fc.st.t = 70;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fc.calls.filter((c) => c[0] === "pause")).toHaveLength(1);
  });
  it("another move cancels the segment watcher", async () => {
    const b = bridge();
    await b.run("segment", { k: 0 });
    await b.run("slide", { k: 2 });
    fc.st.t = 19.99;
    await vi.advanceTimersByTimeAsync(1000);
    // slide() itself pauses in the fake; the watcher must not add a second pause.
    expect(fc.calls.filter((c) => c[0] === "pause")).toHaveLength(0);
    expect(fc.calls.map((c) => c[0])).toEqual(["seekSegment", "resume", "slide"]);
  });
  it("the watcher gives up after the deadline instead of polling for ever", async () => {
    const b = bridge();
    await b.run("segment", { k: 0 }); // 20 s segment → deadline 45 s
    fc.st.t = 5; // stalled
    await vi.advanceTimersByTimeAsync(46_000);
    expect(fc.calls.filter((c) => c[0] === "pause")).toHaveLength(1);
  });
  it("segment / slide refuse without a manifest or with a bad k", async () => {
    expect(await bridge().run("slide", { k: 7 })).toEqual({ ok: false, summary: "This lesson has 3 slides." });
    expect(await bridge().run("segment", {})).toEqual({ ok: false, summary: "This lesson has 3 slides." });
    manifest = null;
    expect(await bridge().run("slide", { k: 0 })).toEqual({ ok: false, summary: "The lesson map is still being prepared." });
    expect(fc.calls).toEqual([]);
  });
  it("slide k → slide(k, manifest) and reports how it was shown", async () => {
    expect(await bridge().run("slide", { k: 0 })).toEqual({ ok: true, summary: "Slide 1." });
    expect(await bridge().run("slide", { k: 1 })).toEqual({ ok: true, summary: "Slide 2 with slide 1's frame." });
    expect(await bridge().run("slide", { k: "2" })).toEqual({ ok: true, summary: "Slide 3 as a caption." });
    expect(fc.calls).toEqual([["slide", 0], ["slide", 1], ["slide", 2]]);
  });
  it("explain / compare arrive resolved (slide with k); unresolved ones have no slide", async () => {
    expect((await bridge().run("explain", { k: 1, concept: "rbc" })).ok).toBe(true);
    expect((await bridge().run("compare", { k: 1, next: 2 })).ok).toBe(true);
    expect(await bridge().run("explain", { concept: "x" })).toEqual({ ok: false, summary: "I couldn't match that to a slide." });
    expect(fc.calls).toEqual([["slide", 1], ["slide", 1]]);
  });
  it("practise n → showQuestions(first question of the current segment, n): a window of n", async () => {
    fc.st.t = 60; // in s3
    const r = await bridge().run("practise", { n: 3 });
    expect(r.ok).toBe(true);
    expect(fc.calls).toEqual([["showQuestions", 2, 3]]);
    expect(r.summary).toBe("Showing 3 of 6 questions (q3–q5).");
    // The server's segmentId wins over the playhead.
    await bridge().run("practise", { n: 2, segmentId: "s1" });
    expect(fc.calls[1]).toEqual(["showQuestions", 0, 2]);
    // A window that runs past the set is as long as what is left.
    const tail = await bridge().run("practise", { n: 5 });
    expect(tail.summary).toBe("Showing 4 of 6 questions (q3–q6).");
    // One question → a single id, no range.
    expect((await bridge().run("practise", { n: 1, segmentId: "s1" })).summary).toBe("Showing 1 of 6 questions (q1).");
  });
  it("practise without a manifest starts at the first question (default 3)", async () => {
    manifest = null;
    await bridge().run("practise", {});
    expect(fc.calls).toEqual([["showQuestions", 0, 3]]);
  });
  it("walkthrough → showQuestions(0), the whole set (no window)", async () => {
    expect(await bridge().run("walkthrough", {})).toEqual({ ok: true, summary: "Worksheet question 1 of 6 on the roll." });
    expect(fc.calls).toEqual([["showQuestions", 0]]);
  });
  it("freeze / blank / back / resume / pause / recap → the matching controller call", async () => {
    const b = bridge();
    expect((await b.run("freeze", {})).ok).toBe(true);
    expect((await b.run("blank", {})).ok).toBe(true);
    expect((await b.run("back", {})).ok).toBe(true);
    expect(await b.run("resume", {})).toMatchObject({ ok: true, plays: true });
    expect(await b.run("pause", {})).toEqual({ ok: true, summary: "Paused." });
    expect((await b.run("recap", {})).ok).toBe(true);
    expect(fc.calls.map((c) => c[0])).toEqual(["freeze", "blankPage", "pageUp", "resume", "pause", "endSession"]);
    expect(fc.st.ended).toBe(true);
  });
  it("a controller error becomes an ok:false report, never a throw", async () => {
    fc.c.freeze = async () => {
      throw new Error("nothing to capture");
    };
    expect(await bridge().run("freeze", {})).toEqual({ ok: false, summary: "nothing to capture" });
  });
  it("no controller → Open the Board first", async () => {
    ctl = null;
    expect(await bridge().run("pause", {})).toEqual({ ok: false, summary: "Open the Board first." });
  });
});

describe("loadManifest — slice A's contract, polled", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  beforeEach(() => sleeps.splice(0));

  it("building → building → ready, every 3 s, reporting status", async () => {
    const replies: ManifestReply[] = [{ status: "building" }, { status: "building" }, { status: "ready", manifest: KIT }];
    const calls: string[] = [];
    const statuses: string[] = [];
    let t = 0;
    const r = await loadManifest(
      async (id, method) => {
        calls.push(`${method} ${id}`);
        t += 3000;
        return replies.shift()!;
      },
      "gen-1",
      { sleep, now: () => t, onStatus: (s) => statuses.push(s) },
    );
    expect(r).toEqual({ status: "ready", manifest: KIT });
    expect(calls).toEqual(["GET gen-1", "GET gen-1", "GET gen-1"]);
    expect(sleeps).toEqual([3000, 3000]);
    expect(statuses).toEqual(["building", "building", "ready"]);
  });
  it("missing → asks once (POST) then polls; missing again → failed", async () => {
    const replies: ManifestReply[] = [{ status: "missing" }, { status: "building" }, { status: "missing" }];
    const calls: string[] = [];
    const r = await loadManifest(
      async (id, method) => {
        calls.push(method);
        return replies.shift()!;
      },
      "gen-1",
      { sleep, now: () => 0 },
    );
    expect(calls).toEqual(["GET", "POST", "GET"]);
    expect(r).toEqual({ status: "failed", reason: "missing" });
  });
  it("stale → rebuild requested (POST) then ready", async () => {
    const replies: ManifestReply[] = [{ status: "stale" }, { status: "ready", manifest: KIT }];
    const calls: string[] = [];
    const r = await loadManifest(
      async (_id, method) => {
        calls.push(method);
        return replies.shift()!;
      },
      "gen-1",
      { sleep, now: () => 0 },
    );
    expect(calls).toEqual(["GET", "POST"]);
    expect(r.status).toBe("ready");
  });
  it("failed is final; a thrown fetch is 'error'; two minutes of building is a timeout", async () => {
    expect(await loadManifest(async () => ({ status: "failed" }), "g", { sleep })).toEqual({ status: "failed", reason: "failed" });
    expect(
      await loadManifest(
        async () => {
          throw new Error("net");
        },
        "g",
        { sleep },
      ),
    ).toEqual({ status: "failed", reason: "error" });
    let t = 0;
    const r = await loadManifest(
      async () => {
        t += 30_000;
        return { status: "building" };
      },
      "g",
      { sleep, now: () => t },
    );
    expect(r).toEqual({ status: "failed", reason: "timeout" });
  });
});

describe("the segment stop survives a pause/resume pair (slice E's coordinator speaks mid-segment)", () => {
  let fc: ReturnType<typeof fakeController>;
  let manifest: BridgeManifest;
  const bridge = () => createBoardBridge({ controller: () => fc.c, manifest: () => manifest, mapStatus: () => "ready", pollMs: 250 });
  beforeEach(() => {
    vi.useFakeTimers();
    fc = fakeController();
    manifest = toBridgeManifest(KIT, 1);
  });
  afterEach(() => vi.useRealTimers());
  const pauses = () => fc.calls.filter((c) => c[0] === "pause").length;

  it("segment → pause → resume → still stops at end_s", async () => {
    const b = bridge();
    await b.run("segment", { k: 1 }); // 20–50 s
    fc.st.t = 30;
    await b.run("pause", {});
    expect(pauses()).toBe(1); // the explicit pause only
    // Paused for a while: the watcher is idle, nothing fires.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pauses()).toBe(1);
    await b.run("resume", {});
    fc.st.t = 40;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pauses()).toBe(1);
    fc.st.t = 49.98;
    await vi.advanceTimersByTimeAsync(300);
    expect(pauses()).toBe(2); // the watcher's pause at end_s
    expect(fc.st.paused).toBe(true);
    // Reached: a later resume is a plain resume, no stop re-armed.
    await b.run("resume", {});
    fc.st.t = 70;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pauses()).toBe(2);
  });
  it("freeze / practise keep the stop for a later resume; a new segment, slide and intro replace it", async () => {
    const b = bridge();
    await b.run("segment", { k: 1 });
    await b.run("freeze", {});
    await b.run("practise", { n: 2 });
    await b.run("resume", {});
    fc.st.t = 49.99;
    await vi.advanceTimersByTimeAsync(300);
    expect(pauses()).toBe(1);
    expect(fc.st.paused).toBe(true);
    // slide replaces the target: a resume after it runs free.
    await b.run("segment", { k: 0 }); // 0–20 s
    await b.run("slide", { k: 2 });
    await b.run("resume", {});
    fc.st.t = 19.99;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pauses()).toBe(1); // slide() in the fake does not call pause(); no watcher fired
    // intro likewise.
    await b.run("segment", { k: 0 });
    await b.run("intro", {});
    fc.st.t = 19.99;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pauses()).toBe(1);
  });
  it("a plain resume with no segment move behind it arms nothing", async () => {
    const b = bridge();
    await b.run("resume", {});
    fc.st.t = 49.99;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pauses()).toBe(0);
  });
});

// ── Board UX (2026-10-28): the rail port, blank-after-current, slides as pages ──

describe("Board UX — rail, blank in between, load_slides", () => {
  const m = toBridgeManifest(KIT, 1);

  it("rail(open) drives the host's rail without a session or an audit; toggle reads railOpen", async () => {
    let open = false;
    const seen: boolean[] = [];
    const b = createBoardBridge({
      controller: () => null,
      manifest: () => null,
      mapStatus: () => "none",
      rail: (o) => {
        open = o;
        seen.push(o);
      },
      railOpen: () => open,
    });
    // No controller (no lesson running) — the rail still opens.
    expect(await b.run("rail", { open: true })).toEqual({ ok: true, summary: "Unit rail open." });
    expect(await b.run("rail", { open: false })).toEqual({ ok: true, summary: "Unit rail closed." });
    expect(await b.run("rail", {})).toMatchObject({ ok: true });
    b.rail("toggle");
    b.rail("toggle");
    b.rail("close");
    expect(seen).toEqual([true, false, true, false, true, false]);
  });

  it("a Board with no rail says so instead of pretending", async () => {
    const b = createBoardBridge({ controller: () => null, manifest: () => null, mapStatus: () => "none" });
    expect(await b.run("rail", { open: true })).toEqual({ ok: false, summary: "This Board has no unit rail." });
  });

  it("the rail move neither needs nor cancels a slides load", async () => {
    const fc = fakeController();
    const cancel = vi.fn();
    fc.c.cancelLoad = cancel;
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready", rail: () => {} });
    await b.run("rail", { open: true });
    expect(cancel).not.toHaveBeenCalled();
    await b.run("pause", {});
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("blank inserts AFTER the page on screen", async () => {
    const fc = fakeController();
    const after: (number | undefined)[] = [];
    fc.c.blankPage = (o) => {
      after.push(o?.after);
    };
    fc.st.pageCount = 5;
    fc.st.page = 2;
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready" });
    const r = await b.run("blank", {});
    expect(r).toEqual({ ok: true, summary: "Blank page added after page 3." });
    expect(after).toEqual([2]);
  });

  it("load_slides runs the controller's load over the unit's manifest, reports progress, and returns where the pages landed", async () => {
    const fc = fakeController();
    const progress: Array<{ k: number; n: number } | null> = [];
    let mid: { k: number; n: number } | null = null;
    let bridge: ReturnType<typeof createBoardBridge> | null = null;
    fc.c.loadSlides = async (mm, o) => {
      fc.calls.push(["loadSlides", mm.segments.length]);
      for (let k = 1; k <= mm.segments.length; k++) {
        o?.onProgress?.(k, mm.segments.length);
        if (k === 2) mid = bridge!.loading();
      }
      return { pages: mm.segments.length, firstPage: 4, lastPage: 6, aborted: false };
    };
    bridge = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready", onLoading: (p) => progress.push(p) });
    const r = await bridge.run("load_slides", {});
    expect(fc.calls).toContainEqual(["loadSlides", 3]);
    expect(r.ok).toBe(true);
    expect(r.loaded).toEqual({ n: 3, a: 5, b: 7, aborted: false });
    expect(r.summary).toMatch(/^3 slides are on the roll as pages 5–7\. Page up and page down/);
    expect(mid).toEqual({ k: 2, n: 3 });
    expect(progress).toEqual([{ k: 0, n: 3 }, { k: 1, n: 3 }, { k: 2, n: 3 }, { k: 3, n: 3 }, null]);
    // Done: nothing in the tray.
    expect(bridge.loading()).toBeNull();
  });

  it("load_slides without a map, or on a controller that cannot load, refuses", async () => {
    const fc = fakeController();
    const noMap = createBoardBridge({ controller: () => fc.c, manifest: () => null, mapStatus: () => "building" });
    expect((await noMap.run("load_slides", {})).ok).toBe(false);
    const old = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready" });
    expect(await old.run("load_slides", {})).toEqual({ ok: false, summary: "This Board cannot load slides as pages." });
  });

  it("an aborted load says how far it got; a load stopped before any page is not a success", async () => {
    const fc = fakeController();
    let pages = 2;
    fc.c.loadSlides = async () => ({ pages, firstPage: pages ? 0 : -1, lastPage: pages - 1, aborted: true });
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready" });
    const r = await b.run("load_slides", {});
    expect(r.summary).toContain("(stopped after 2 of 3)");
    expect(r.loaded).toEqual({ n: 2, a: 1, b: 2, aborted: true });
    pages = 0;
    expect(await b.run("load_slides", {})).toEqual({ ok: false, summary: "Stopped before the first slide." });
    expect(b.loading()).toBeNull();
  });
});

describe("the kit's .pptx as pages (founder 2026-10-28)", () => {
  const m = toBridgeManifest(KIT, 1);
  const TEMPLATE = "The deck is on the roll as pages {a}–{b}. Say 'blank page' to add one in between.";

  it("load_deck runs the host's deck load (no lesson map needed) and fills the server's closing line", async () => {
    const fc = fakeController();
    const load = vi.fn(async () => ({ ok: true, summary: "The deck is on the roll as pages 2–9.", loaded: { n: 8, a: 2, b: 9, aborted: false } }));
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => null, mapStatus: () => "none", deck: { status: () => "missing", load } });
    const r = await b.run("load_deck", { done: TEMPLATE });
    expect(load).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, loaded: { n: 8, a: 2, b: 9 }, done: "The deck is on the roll as pages 2–9. Say 'blank page' to add one in between." });
    // Without a template the result is the host's as-is (the panel falls back to its own line).
    expect((await b.run("load_deck", {})).done).toBeUndefined();
  });

  it("load_deck on a unit with no deck refuses; it does not cancel itself", async () => {
    const fc = fakeController();
    const cancel = vi.fn();
    fc.c.cancelLoad = cancel;
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready" });
    expect(await b.run("load_deck", {})).toEqual({ ok: false, summary: "This lesson has no slide deck." });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("state() reports the deck's status for the server; absent when the unit has none", () => {
    const fc = fakeController();
    let status: "none" | "missing" | "building" | "ready" | "loaded" | "failed" = "ready";
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready", deck: { status: () => status, load: async () => ({ ok: true, summary: "" }) } });
    expect(b.state()?.deck).toBe("ready");
    status = "none";
    expect(b.state()?.deck).toBeUndefined();
    const plain = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready" });
    expect(plain.state()).not.toHaveProperty("deck");
  });

  it("'skip to the PowerPoint' (slide deck:true) winds to the deck's first page when it is on the roll, else slide 1 of the frames", async () => {
    const fc = fakeController();
    let onRoll: number | null = null;
    fc.c.findDeckPage = () => onRoll;
    fc.c.goToDeckPage = () => {
      fc.calls.push(["goToDeckPage"]);
      return onRoll!;
    };
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => m, mapStatus: () => "ready" });
    await b.run("slide", { k: 0, deck: true });
    expect(fc.calls).toContainEqual(["slide", 0]);
    onRoll = 3;
    fc.calls.length = 0;
    expect(await b.run("slide", { k: 0, deck: true })).toEqual({ ok: true, summary: "Slide 1 of the deck (page 4)." });
    expect(fc.calls).toEqual([["goToDeckPage"]]);
    // A plain slide move never goes to the deck.
    fc.calls.length = 0;
    await b.run("slide", { k: 0 });
    expect(fc.calls).toContainEqual(["slide", 0]);
  });
});

describe("highlight a portion and ask SK (founder 2026-10-28)", () => {
  const SEL = { generationId: "deck-1", n: 3, text: "high concentration to low", title: "Diffusion" };

  it("state() carries the live highlight; absent once the 60 s window closes or there is none", () => {
    const fc = fakeController();
    let held: HeldSelection | null = { selection: SEL, at: 1_000 };
    let now = 30_000;
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => null, mapStatus: () => "none", highlight: () => activeSelection(held, now) });
    expect(b.state()?.selection).toEqual(SEL);
    now = 62_000;
    expect(b.state()).not.toHaveProperty("selection");
    held = null;
    now = 1_000;
    expect(b.state()).not.toHaveProperty("selection");
    // No highlight port at all: the state is as before.
    expect(createBoardBridge({ controller: () => fc.c, manifest: () => null, mapStatus: () => "none" }).state()).not.toHaveProperty("selection");
  });

  it("asks(): the host's channel; a post made before the panel opened is held until taken", () => {
    const fc = fakeController();
    const asks = createAskChannel();
    const b = createBoardBridge({ controller: () => fc.c, manifest: () => null, mapStatus: () => "none", asks });
    expect(b.asks()).toBe(asks);
    const seen: string[] = [];
    const off = b.asks()!.subscribe((a) => seen.push(a));
    asks.post("explain_selection");
    expect(seen).toEqual(["explain_selection"]);
    expect(b.asks()!.take()).toBe("explain_selection");
    expect(b.asks()!.take()).toBeNull();
    off();
    asks.post("explain_selection");
    expect(seen).toHaveLength(1);
    expect(createBoardBridge({ controller: () => fc.c, manifest: () => null, mapStatus: () => "none" }).asks()).toBeNull();
  });
});
