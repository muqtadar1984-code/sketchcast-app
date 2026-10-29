import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemorySkActionSink,
  captionCard,
  createBoardController,
  segmentTarget,
  slidePlan,
  slideTime,
  type BoardManifest,
  type BoardPorts,
  type VideoLike,
} from "../board-controller";
import type { PageBackground, TextCard } from "@/board/model";
import type { StageMode } from "../stage";

/** A video whose seeks land asynchronously, snapped to a 24 fps frame grid. */
class FakeVideo extends EventTarget implements VideoLike {
  private t = 0;
  paused = true;
  duration = 826.56;
  /** "snap" lands on the frame grid; "hang" never fires seeked; "error" fails; "sync" fires at once. */
  behaviour: "snap" | "hang" | "error" | "sync" = "snap";
  /** Whether requestVideoFrameCallback exists, and whether it ever fires. */
  rvfc: "fires" | "never" | "absent" = "fires";
  private frameCbs: ((now: number, md: { mediaTime: number }) => void)[] = [];
  get currentTime() {
    return this.t;
  }
  set currentTime(v: number) {
    if (this.behaviour === "hang") return;
    if (this.behaviour === "error") {
      setTimeout(() => this.dispatchEvent(new Event("error")), 1);
      return;
    }
    const landed = Math.round(v * 24) / 24;
    const land = () => {
      this.t = landed;
      this.dispatchEvent(new Event("seeked"));
      // The decoder presents the frame shortly after the event.
      setTimeout(() => this.present(), 3);
    };
    if (this.behaviour === "sync") land();
    else setTimeout(land, 5);
  }
  private present() {
    if (this.rvfc !== "fires") return;
    const cbs = this.frameCbs;
    this.frameCbs = [];
    // The frame shown is the one whose interval contains t.
    for (const cb of cbs) cb(0, { mediaTime: Math.floor(this.t * 24) / 24 });
  }
  get requestVideoFrameCallback(): VideoLike["requestVideoFrameCallback"] {
    if (this.rvfc === "absent") return undefined;
    return (cb) => {
      this.frameCbs.push(cb);
      return this.frameCbs.length;
    };
  }
  addEventListener(type: string, fn: () => void) {
    super.addEventListener(type, fn);
  }
  removeEventListener(type: string, fn: () => void) {
    super.removeEventListener(type, fn);
  }
}

function harness(over: Partial<BoardPorts> = {}) {
  const video = new FakeVideo();
  const state = { page: 0, count: 1, mode: "away" as StageMode, items: [] as string[] };
  const calls: string[] = [];
  const cards: TextCard[] = [];
  const push = () => {
    state.count++;
    state.page = state.count - 1;
  };
  const ports: BoardPorts = {
    sessionId: () => "s-1",
    actorId: () => "teacher-1",
    generationId: () => "gen-video",
    video: () => video,
    play: async () => {
      calls.push("play");
      state.items.push("video");
      state.mode = "full";
      video.paused = false;
    },
    resume: async () => {
      calls.push("resume");
      state.mode = "full";
      video.paused = false;
    },
    pause: () => {
      calls.push("pause");
      video.paused = true;
    },
    setStage: (m) => {
      state.mode = m;
    },
    freeze: async () => {
      calls.push("freeze");
      video.paused = true;
      push();
      state.mode = "corner";
      return true;
    },
    openWorksheetPage: () => {
      calls.push("worksheet");
      push();
      state.mode = "away";
      return true;
    },
    blankPage: () => {
      calls.push("blank");
      push();
    },
    pushCard: (card) => {
      cards.push(card);
      push();
    },
    loadQuestions: async () => ({
      generationId: "gen-ws",
      cards: [0, 1, 2].map((i) => ({ source: "question" as const, heading: `Q${i + 1}`, body: [], index: i, total: 3 })),
    }),
    goTo: (p) => {
      calls.push(`goTo:${p}`);
      state.page = Math.max(0, Math.min(state.count - 1, p));
    },
    where: () => ({ page: state.page, count: state.count }),
    stageMode: () => state.mode,
    endSession: async () => {
      calls.push("end");
      return true;
    },
    ...over,
  };
  const sink = new MemorySkActionSink();
  const moving: boolean[] = [];
  const c = createBoardController(ports, sink, {
    seekTimeoutMs: 200,
    frameTimeoutMs: 60,
    onMoving: (m) => moving.push(m),
  });
  return { c, video, state, calls, sink, cards, moving };
}

const manifest: BoardManifest = {
  segments: [
    { start_s: 0, end_s: 26.33, heading: "Intro", points: ["a"] },
    { start_s: 26.33, end_s: 56.46, slide_t: 56.398, heading: "Genes", points: ["DNA", " ", "codes"] },
    { start_s: 56.46, end_s: 94.75 },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("BoardController — seeks", () => {
  it("resolves with the LANDED time and the DISPLAYED frame", async () => {
    const { c, video } = harness();
    const r = await c.seekMeasured(26.36);
    expect(r.landed).toBeCloseTo(Math.round(26.36 * 24) / 24, 6);
    expect(video.currentTime).toBe(r.landed);
    expect(r.presentedMediaTime).not.toBeNull();
    expect(r.frameErrorMs!).toBeLessThanOrEqual(1000 / 24 + 0.001);
    expect(r.frameLatencyMs!).toBeGreaterThanOrEqual(r.latencyMs);
  });

  it("seek() returns the landed currentTime", async () => {
    const { c } = harness();
    await expect(c.seek(10)).resolves.toBe(10);
  });

  it("a seek whose seeked fires synchronously still resolves (listeners attached first)", async () => {
    const { c, video } = harness();
    video.behaviour = "sync";
    await expect(c.seek(10)).resolves.toBe(10);
  });

  it("no displayed frame (hidden pane / no rVFC) is reported as null, not faked", async () => {
    for (const mode of ["never", "absent"] as const) {
      const { c, video } = harness();
      video.rvfc = mode;
      const r = await c.seekMeasured(12);
      expect(r.presentedMediaTime).toBeNull();
      expect(r.frameErrorMs).toBeNull();
      expect(r.landed).toBe(12);
    }
  });

  it("moving is true from the seek's start until its frame shows, then false", async () => {
    const { c, moving } = harness();
    const p = c.seekMeasured(30);
    expect(c.getState().moving).toBe(true);
    await p;
    expect(c.getState().moving).toBe(false);
    expect(moving).toEqual([true, false]);
  });

  it("moving clears when a seek fails", async () => {
    const { c, video } = harness();
    video.behaviour = "hang";
    await expect(c.seek(5)).rejects.toThrow(/did not land/);
    expect(c.getState().moving).toBe(false);
  });

  it("clamps out-of-range seeks to [0, duration]", async () => {
    const { c } = harness();
    expect((await c.seekMeasured(-5)).target).toBe(0);
    expect((await c.seekMeasured(99999)).target).toBe(826.56);
  });

  it("a media error rejects; no video rejects rather than hanging", async () => {
    const a = harness();
    a.video.behaviour = "error";
    await expect(a.c.seek(5)).rejects.toThrow(/video error/);
    const b = harness({ video: () => null });
    await expect(b.c.seek(1)).rejects.toThrow(/no video/);
  });

  it("segment edges: start nudges past the boundary keyframe; end backs off before the next segment", () => {
    expect(segmentTarget(manifest, 1, "start")).toBeCloseTo(26.36, 6);
    expect(segmentTarget(manifest, 1, "start", 0.1, 0)).toBe(26.33);
    expect(segmentTarget(manifest, 1, "end")).toBeCloseTo(56.36, 6);
    expect(() => segmentTarget(manifest, 9, "start")).toThrow(RangeError);
    expect(slideTime(manifest, 1)).toBe(56.398);
    expect(slideTime(manifest, 2)).toBeCloseTo(94.65, 6);
  });

  it("seekSegment lands within 150 ms of each edge", async () => {
    const { c, sink } = harness();
    for (const k of [0, 1, 2]) {
      for (const edge of ["start", "end"] as const) {
        const r = await c.seekSegment(k, edge, manifest);
        expect(r.frameErrorMs!).toBeLessThanOrEqual(150);
      }
    }
    const rows = sink.records.filter((r) => r.action === "board.seek_segment");
    expect(rows).toHaveLength(6);
    expect(rows[0].params).toEqual({ k: 0, edge: "start" });
  });
});

describe("BoardController — play vs resume", () => {
  it("play() is the ▶ button: records a video item; resume() records none", async () => {
    const { c, state, calls } = harness();
    await c.play();
    expect(state.items).toEqual(["video"]);
    c.pause();
    await c.resume();
    await c.resume();
    expect(state.items).toEqual(["video"]);
    expect(calls).toEqual(["play", "pause", "resume", "resume"]);
    expect(c.getState()).toMatchObject({ paused: false, stageMode: "full" });
  });
});

describe("BoardController — slide(k) and the visual verdict", () => {
  const vm: BoardManifest = {
    segments: [
      { start_s: 0, end_s: 10, slide_t: 9.9, heading: "Zero", visual: { status: "distinct", show: "frame", reason: "own" } },
      { start_s: 10, end_s: 20, slide_t: 19.9, heading: "One", points: ["p1", "p2"], visual: { status: "reused_relevant", show: "fallback_frame", fallback_k: 0, reason: "same diagram" } },
      { start_s: 20, end_s: 30, slide_t: 29.9, heading: "Two", points: ["x"], visual: { status: "misleading", show: "caption_only", reason: "wrong picture" } },
      { start_s: 30, end_s: 40, slide_t: 39.9, heading: "Three", points: [] },
      { start_s: 40, end_s: 50, slide_t: 49.9, heading: "Four", visual: { status: "misleading", show: "frame", reason: "contradiction" } },
      { start_s: 50, end_s: 60, slide_t: 59.9, heading: "Five", visual: { status: "unknown", show: "fallback_frame", fallback_k: 2, reason: "points at a misleading frame" } },
    ],
  };

  it("show=frame: seeks to slide_t, pauses, stage full", async () => {
    const { c, video, cards } = harness();
    const r = await c.slide(0, vm);
    expect(r).toMatchObject({ shown: "frame", shownK: 0 });
    expect(video.currentTime).toBeCloseTo(Math.round(9.9 * 24) / 24, 6);
    expect(c.getState()).toMatchObject({ paused: true, stageMode: "full" });
    expect(cards).toHaveLength(0);
  });

  it("show=fallback_frame: shows the FALLBACK segment's frame and says so", async () => {
    const { c, video, cards } = harness();
    const r = await c.slide(1, vm);
    expect(r).toMatchObject({ shown: "fallback_frame", shownK: 0 });
    expect(video.currentTime).toBeCloseTo(Math.round(9.9 * 24) / 24, 6);
    expect(cards).toHaveLength(0);
  });

  it("caption_only, unknown and malformed verdicts push a caption card and never seek", async () => {
    for (const k of [2, 3, 4, 5]) {
      const { c, video, cards, state } = harness();
      const r = await c.slide(k, vm);
      expect(r.shown).toBe("caption");
      expect(r.shownK).toBe(k);
      expect(video.currentTime).toBe(0);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ source: "caption", heading: vm.segments[k].heading });
      expect(state.mode).toBe("away");
    }
  });

  it("no verdict at all means caption; the card keeps the points and drops empty ones", () => {
    expect(slidePlan(manifest, 1).show).toBe("caption");
    expect(captionCard(manifest, 1, "g")).toEqual({
      source: "caption",
      heading: "Genes",
      body: ["DNA", "codes"],
      generationId: "g",
      index: 1,
    });
  });

  it("a misleading frame is never shown under a new heading (fallback to a misleading frame degrades)", () => {
    expect(slidePlan(vm, 5)).toMatchObject({ show: "caption" });
    expect(slidePlan(vm, 4)).toMatchObject({ show: "caption" });
  });
});

describe("BoardController — pages and questions", () => {
  it("freeze, worksheet and blank each add one roll page", async () => {
    const { c } = harness();
    await c.freeze();
    expect(c.getState()).toMatchObject({ pageCount: 2, stageMode: "corner" });
    expect(c.openWorksheetPage()).toBe(true);
    expect(c.getState()).toMatchObject({ pageCount: 3, stageMode: "away" });
    c.blankPage();
    expect(c.getState().pageCount).toBe(4);
  });

  it("failures are recorded and thrown", async () => {
    const a = harness({ freeze: async () => false });
    await expect(a.c.freeze()).rejects.toThrow(/nothing to capture/);
    expect(a.sink.records[0]).toMatchObject({ action: "board.freeze", ok: false });
    const b = harness({ openWorksheetPage: () => false });
    expect(() => b.c.openWorksheetPage()).toThrow(/no projectable worksheet/);
  });

  it("pageUp/pageDown move one page and clamp at the ends", () => {
    const { c, state } = harness();
    c.blankPage();
    c.blankPage();
    c.pageUp();
    expect(state.page).toBe(1);
    c.pageDown();
    c.pageDown();
    expect(state.page).toBe(2);
    c.pageUp();
    c.pageUp();
    c.pageUp();
    expect(state.page).toBe(0);
  });

  it("showQuestions / next / prev: one page per question, revisits reuse the page", async () => {
    const { c, cards, state } = harness();
    expect(await c.showQuestions()).toEqual({ index: 0, total: 3 });
    expect(state.count).toBe(2);
    expect(await c.nextQuestion()).toEqual({ index: 1, total: 3 });
    expect(state.count).toBe(3);
    expect(await c.prevQuestion()).toEqual({ index: 0, total: 3 });
    expect(state.page).toBe(1);
    expect(state.count).toBe(3);
    expect(await c.nextQuestion()).toEqual({ index: 1, total: 3 });
    expect(state.page).toBe(2);
    expect(state.count).toBe(3);
    await c.nextQuestion();
    await expect(c.nextQuestion()).rejects.toThrow(RangeError);
    expect(cards.map((x) => x.heading)).toEqual(["Q1", "Q2", "Q3"]);
    expect(c.getState().questions).toEqual({ generationId: "gen-ws", index: 2, total: 3 });
  });

  it("showQuestions with nothing to show rejects", async () => {
    const { c } = harness({ loadQuestions: async () => null });
    await expect(c.showQuestions()).rejects.toThrow(/no questions/);
    await expect(c.nextQuestion()).rejects.toThrow(/no question set/);
  });

  it("endSession closes once; later moves refuse", async () => {
    const { c, calls } = harness();
    await c.endSession();
    expect(c.getState().ended).toBe(true);
    await expect(c.play()).rejects.toThrow(/session ended/);
    expect(() => c.blankPage()).toThrow(/session ended/);
    expect(calls).toEqual(["end"]);
  });

  it("a close that did not land leaves the session open", async () => {
    const { c } = harness({ endSession: async () => false });
    await expect(c.endSession()).rejects.toThrow(/close did not land/);
    expect(c.getState().ended).toBe(false);
  });
});

describe("sk_actions records", () => {
  it("every move becomes one row shaped for sk_actions, in order", async () => {
    const { c, sink } = harness();
    await c.play();
    c.pause();
    await c.resume();
    await c.seek(3);
    await c.freeze();
    c.openWorksheetPage();
    c.blankPage();
    c.pageUp();
    c.pageDown();
    await c.showQuestions();
    await c.endSession();
    expect(sink.records.map((r) => r.action)).toEqual([
      "board.play",
      "board.pause",
      "board.resume",
      "board.seek",
      "board.freeze",
      "board.worksheet_page",
      "board.blank_page",
      "board.page_up",
      "board.page_down",
      "board.show_questions",
      "board.end_session",
    ]);
    for (const r of sink.records) {
      expect(r).toMatchObject({ actor_id: "teacher-1", tier: "immediate", kind: "board", session_id: "s-1", generation_id: "gen-video", ok: true });
      expect(typeof r.ms).toBe("number");
      expect(Number.isNaN(Date.parse(r.at))).toBe(false);
    }
    expect(c.getState().actions).toEqual(sink.records);
  });

  it("SK moves make NO network call — nothing reaches /api/present/items", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { c } = harness();
      await c.play();
      c.pause();
      await c.resume();
      await c.seekSegment(1, "end", manifest);
      await c.slide(1, manifest);
      await c.freeze();
      c.openWorksheetPage();
      c.blankPage();
      c.pageUp();
      c.pageDown();
      await c.showQuestions();
      await c.nextQuestion();
      await c.endSession();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the controller module names no network endpoint", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../board-controller.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/fetch\(/);
    expect(src).not.toMatch(/\/api\/present\/items["'`]/);
  });

  it("a sink that throws or rejects never fails the move", async () => {
    const throwing = harness();
    const c1 = createBoardController(
      { ...portsOf(throwing) },
      { record: () => { throw new Error("down"); } },
    );
    expect(() => c1.blankPage()).not.toThrow();
    const c2 = createBoardController({ ...portsOf(throwing) }, { record: () => Promise.reject(new Error("net")) });
    await expect(c2.seek(2)).resolves.toBeCloseTo(2, 6);
  });
});

/** Minimal ports over a harness's fake video, for building a second controller. */
function portsOf(h: ReturnType<typeof harness>): BoardPorts {
  return {
    sessionId: () => "s",
    actorId: () => null,
    generationId: () => null,
    video: () => h.video,
    play: async () => {},
    resume: async () => {},
    pause: () => {},
    setStage: () => {},
    freeze: async () => true,
    openWorksheetPage: () => true,
    blankPage: () => {},
    pushCard: () => {},
    loadQuestions: async () => null,
    goTo: () => {},
    where: () => ({ page: 0, count: 1 }),
    stageMode: () => "away",
    endSession: async () => true,
  };
}

// ── S1 slice C: the question window and the unit port ────────────────────────

describe("showQuestions(start, count) — a window of the set (S1 slice C)", () => {
  const tenQuestions = async () => ({
    generationId: "gen-ws",
    cards: Array.from({ length: 10 }, (_, i) => ({ source: "question" as const, heading: `Q${i + 1}`, body: [], index: i, total: 10 })),
  });

  it("show 3 of 10 from q3: next stops at the 3rd of the window, prev at its 1st; shown/of are reported", async () => {
    const { c, cards } = harness({ loadQuestions: tenQuestions });
    expect(await c.showQuestions(2, 3)).toEqual({ index: 2, total: 10, shown: 3, of: 10 });
    expect(await c.nextQuestion()).toEqual({ index: 3, total: 10 });
    expect(await c.nextQuestion()).toEqual({ index: 4, total: 10 });
    // The edge holds — the teacher asked for three.
    expect(await c.nextQuestion()).toEqual({ index: 4, total: 10 });
    expect(await c.prevQuestion()).toEqual({ index: 3, total: 10 });
    expect(await c.prevQuestion()).toEqual({ index: 2, total: 10 });
    expect(await c.prevQuestion()).toEqual({ index: 2, total: 10 });
    expect(cards.map((x) => x.heading)).toEqual(["Q3", "Q4", "Q5"]);
    expect(c.getState().questions).toEqual({ generationId: "gen-ws", index: 2, total: 10 });
    const shows = c.getState().actions.filter((a) => a.action === "board.show_questions");
    expect(shows[0].params).toEqual({ start: 2, count: 3 });
    expect(shows[0].result).toEqual({ index: 2, total: 10, shown: 3, of: 10 });
  });

  it("a window past the end is as long as what is left; without count the whole set is open (M2 shape)", async () => {
    const { c } = harness({ loadQuestions: tenQuestions });
    expect(await c.showQuestions(8, 5)).toEqual({ index: 8, total: 10, shown: 2, of: 10 });
    expect(await c.nextQuestion()).toEqual({ index: 9, total: 10 });
    expect(await c.nextQuestion()).toEqual({ index: 9, total: 10 });
    // walkthrough after practise: no window, the old throw-at-the-end behaviour.
    expect(await c.showQuestions(0)).toEqual({ index: 0, total: 10 });
    for (let i = 0; i < 9; i++) await c.nextQuestion();
    await expect(c.nextQuestion()).rejects.toThrow(RangeError);
    expect(c.getState().actions.find((a) => a.action === "board.show_questions" && !("count" in a.params))?.params).toEqual({ start: 0 });
  });

  it("a start outside the set rejects; a non-positive count means no window", async () => {
    const { c } = harness({ loadQuestions: tenQuestions });
    await expect(c.showQuestions(10, 3)).rejects.toThrow(RangeError);
    expect(await c.showQuestions(1, 0)).toEqual({ index: 1, total: 10 });
  });
});

describe("getUnit() — the open unit from BoardSession's port (S1 slice C)", () => {
  it("answers the port, and null when the host gave none", () => {
    const { c } = harness({ unit: () => ({ generationId: "gen-video", part: 2, title: "Cells, part 2" }) });
    expect(c.getUnit()).toEqual({ generationId: "gen-video", part: 2, title: "Cells, part 2" });
    const { c: bare } = harness();
    expect(bare.getUnit()).toBeNull();
    const { c: none } = harness({ unit: () => null });
    expect(none.getUnit()).toBeNull();
  });
  it("is not a move: nothing is recorded", () => {
    const { c, sink } = harness({ unit: () => ({ generationId: "g", part: null, title: null }) });
    c.getUnit();
    expect(sink.records).toEqual([]);
    expect(c.getState().actions).toEqual([]);
  });
});

// ── Board UX (2026-10-28): slides as pages, and the blank page in between ──

describe("loadSlides — every slide onto the roll as pages", () => {
  /** A harness whose freeze records the time it captured and its options. */
  function loadHarness() {
    const shots: { t: number; replaceBlank: boolean }[] = [];
    const h = harness({
      freeze: async (o) => {
        shots.push({ t: h.video.currentTime, replaceBlank: !!o?.replaceBlank });
        h.video.paused = true;
        // A pristine roll's blank page takes the first frame; the rest append.
        if (!(o?.replaceBlank && h.state.count === 1)) {
          h.state.count++;
          h.state.page = h.state.count - 1;
        } else {
          h.state.page = 0;
        }
        h.state.mode = "corner";
        return true;
      },
    });
    return Object.assign(h, { shots });
  }

  it("seeks each segment's completed frame IN ORDER, freezes it, and lands on the first page", async () => {
    const h = loadHarness();
    const progress: [number, number][] = [];
    const r = await h.c.loadSlides!(manifest, { onProgress: (k, n) => progress.push([k, n]) });
    // slide_t where the manifest has one, else end_s − 0.10 — snapped to the 24 fps grid.
    const want = [26.33 - 0.1, 56.398, 94.75 - 0.1].map((t) => Math.round(t * 24) / 24);
    expect(h.shots.map((s) => s.t)).toEqual(want);
    // Only the first slide may take a pristine blank page.
    expect(h.shots.map((s) => s.replaceBlank)).toEqual([true, false, false]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(r).toEqual({ pages: 3, firstPage: 0, lastPage: 2, aborted: false });
    // Afterwards the video steps aside and the first loaded page is on screen.
    expect(h.state.mode).toBe("away");
    expect(h.state.page).toBe(0);
    expect(h.calls.filter((x) => x.startsWith("goTo"))).toEqual(["goTo:0"]);
  });

  it("writes ONE audit row for the whole load, with count/from/to", async () => {
    const h = loadHarness();
    await h.c.loadSlides!(manifest);
    const rows = h.sink.records.filter((a) => a.action === "board.load_slides");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, tier: "immediate", kind: "board", params: { count: 3, from: 0, to: 2 } });
    expect(rows[0].result).toMatchObject({ pages: 3, firstPage: 0, lastPage: 2, aborted: false });
    // No per-frame rows: the load does not go through freeze()/seek() moves.
    expect(h.sink.records.filter((a) => a.action !== "board.load_slides")).toEqual([]);
  });

  it("appends after existing pages (a used roll keeps its page 1) and honours from/to", async () => {
    const h = loadHarness();
    h.state.count = 2;
    h.state.page = 1;
    const r = await h.c.loadSlides!(manifest, { from: 1, to: 2 });
    expect(h.shots).toHaveLength(2);
    expect(r).toEqual({ pages: 2, firstPage: 2, lastPage: 3, aborted: false });
    expect(h.state.page).toBe(2);
    expect(h.sink.records.find((a) => a.action === "board.load_slides")?.params).toEqual({ count: 2, from: 1, to: 2 });
  });

  it("an abort mid-way keeps the pages already made, and still lands on the first", async () => {
    const h = loadHarness();
    const ac = new AbortController();
    const r = await h.c.loadSlides!(manifest, { signal: ac.signal, onProgress: (k) => k === 2 && ac.abort() });
    expect(h.shots).toHaveLength(2);
    expect(r).toEqual({ pages: 2, firstPage: 0, lastPage: 1, aborted: true });
    expect(h.state.count).toBe(2);
    expect(h.state.mode).toBe("away");
    expect(h.state.page).toBe(0);
    const rows = h.sink.records.filter((a) => a.action === "board.load_slides");
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toMatchObject({ pages: 2, aborted: true });
  });

  it("cancelLoad() from another move stops it after the frame in hand", async () => {
    const h = loadHarness();
    const run = h.c.loadSlides!(manifest, { onProgress: (k) => k === 1 && h.c.cancelLoad!() });
    const r = await run;
    expect(r.pages).toBe(1);
    expect(r.aborted).toBe(true);
  });

  it("an empty manifest refuses (and is audited as a failure)", async () => {
    const h = loadHarness();
    await expect(h.c.loadSlides!({ segments: [] })).rejects.toThrow(/no slides/);
    expect(h.sink.records.find((a) => a.action === "board.load_slides")).toMatchObject({ ok: false });
  });

  it("a frame that cannot be captured stops the load with an error; earlier pages stay", async () => {
    let n = 0;
    const h = harness({
      freeze: async () => {
        n++;
        if (n === 2) return false;
        h.state.count++;
        h.state.page = h.state.count - 1;
        return true;
      },
    });
    await expect(h.c.loadSlides!(manifest)).rejects.toThrow(/slide 2/);
    expect(h.state.count).toBe(2);
    expect(h.state.mode).toBe("away");
  });
});

describe("blankPage({ after }) — a page in between", () => {
  it("passes `after` to the port and audits it; no argument is the old append", () => {
    const seen: (number | undefined)[] = [];
    const h = harness({ blankPage: (o) => seen.push(o?.after) });
    h.c.blankPage({ after: 2 });
    h.c.blankPage();
    expect(seen).toEqual([2, undefined]);
    const rows = h.sink.records.filter((a) => a.action === "board.blank_page");
    expect(rows.map((r) => r.params)).toEqual([{ after: 2 }, {}]);
  });
});

describe("loadDeck — the kit's .pptx as pages (founder 2026-10-28)", () => {
  /** A roll the ports can put pages on: backgrounds by index, insert-after semantics. */
  function deckHarness(start: { pages: string[]; page: number; pristine?: boolean }) {
    const roll: Array<string | PageBackground> = [...start.pages];
    const h = harness({
      putPage: (bg, o) => {
        if (o.replaceBlank && start.pristine && roll.length === 1) {
          roll[0] = bg;
          return 0;
        }
        const at = o.after !== undefined && o.after < roll.length - 1 ? o.after + 1 : roll.length;
        roll.splice(at, 0, bg);
        h.state.count = roll.length;
        h.state.page = at;
        return at;
      },
      findDeckPage: (n, g) => {
        const i = roll.findIndex((p) => typeof p !== "string" && p.kind === "deckPage" && p.n === n && (!g || p.generationId === g));
        return i < 0 ? null : i;
      },
    });
    h.state.count = roll.length;
    h.state.page = start.page;
    return { ...h, roll };
  }
  const slides = [1, 2, 3].map((n) => ({ n, path: `o/d/deck_pages/slide_0${n}.png`, w: 1920, h: 1080, title: `T${n}` }));
  const label = (p: string | PageBackground) => (typeof p === "string" ? p : p.kind === "deckPage" ? `S${p.n}` : p.kind);

  it("a pristine roll: slide 1 ON page 1, the rest after it; one audit row; lands on the first; stage away", async () => {
    const h = deckHarness({ pages: ["blank"], page: 0, pristine: true });
    h.state.mode = "corner";
    const progress: number[] = [];
    const r = await h.c.loadDeck!({ generationId: "deck-gen", slides, map: "o/d/deck_pages/pages.json", onProgress: (k) => progress.push(k) });
    expect(r).toEqual({ pages: 3, firstPage: 0, lastPage: 2, aborted: false });
    expect(h.roll.map(label)).toEqual(["S1", "S2", "S3"]);
    expect(h.roll[1]).toEqual({ kind: "deckPage", generationId: "deck-gen", n: 2, src: "o/d/deck_pages/slide_02.png", w: 1920, h: 1080, title: "T2", map: "o/d/deck_pages/pages.json" });
    expect(progress).toEqual([1, 2, 3]);
    expect(h.state.mode).toBe("away");
    expect(h.calls.at(-1)).toBe("goTo:0");
    const rows = h.sink.records.filter((x) => x.action === "board.load_deck");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, params: { generationId: "deck-gen", count: 3, from: 0, to: 2 }, result: { pages: 3, firstPage: 0, lastPage: 2 } });
    expect(h.sink.records).toHaveLength(1);
  });

  it("mid-lesson: inserted right after the page on screen, in order, ahead of what followed", async () => {
    const h = deckHarness({ pages: ["frame", "note", "worksheet"], page: 1 });
    const r = await h.c.loadDeck!({ generationId: "deck-gen", slides });
    expect(h.roll.map(label)).toEqual(["frame", "note", "S1", "S2", "S3", "worksheet"]);
    expect(r).toMatchObject({ firstPage: 2, lastPage: 4 });
    expect(h.calls.at(-1)).toBe("goTo:2");
  });

  it("from/to load a range; abort keeps the pages made", async () => {
    const h = deckHarness({ pages: ["blank"], page: 0, pristine: true });
    expect(await h.c.loadDeck!({ generationId: "g", slides, from: 1, to: 2 })).toMatchObject({ pages: 2 });
    expect(h.roll.map(label)).toEqual(["S2", "S3"]);

    const h2 = deckHarness({ pages: ["blank"], page: 0, pristine: true });
    const ac = new AbortController();
    const r = await h2.c.loadDeck!({ generationId: "g", slides, signal: ac.signal, onProgress: (k) => k === 1 && ac.abort() });
    expect(r).toEqual({ pages: 1, firstPage: 0, lastPage: 0, aborted: true });

    const h3 = deckHarness({ pages: ["blank"], page: 0, pristine: true });
    const run = h3.c.loadDeck!({ generationId: "g", slides, onProgress: (k) => k === 2 && h3.c.cancelLoad!() });
    expect(await run).toMatchObject({ pages: 2, aborted: true });
  });

  it("no slides, or a Board with no putPage port, fails with an audit row and no pages", async () => {
    const h = deckHarness({ pages: ["blank"], page: 0, pristine: true });
    await expect(h.c.loadDeck!({ generationId: "g", slides: [] })).rejects.toThrow(/no slides/);
    const bare = harness();
    await expect(bare.c.loadDeck!({ generationId: "g", slides })).rejects.toThrow(/cannot hold deck pages/);
    expect(bare.sink.records[0]).toMatchObject({ action: "board.load_deck", ok: false });
  });

  it("goToDeckPage winds to slide n of a deck on the roll; with none it throws (audited)", async () => {
    const h = deckHarness({ pages: ["frame"], page: 0 });
    expect(h.c.findDeckPage!()).toBeNull();
    expect(() => h.c.goToDeckPage!()).toThrow(/no deck pages/);
    await h.c.loadDeck!({ generationId: "deck-gen", slides });
    h.c.pageUp();
    expect(h.c.findDeckPage!(2, "deck-gen")).toBe(2);
    expect(h.c.findDeckPage!(1, "another")).toBeNull();
    expect(h.c.goToDeckPage!()).toBe(1);
    expect(h.calls.at(-1)).toBe("goTo:1");
    expect(h.sink.records.at(-1)).toMatchObject({ action: "board.deck_page", ok: true, params: { n: 1 }, result: { page: 1 } });
  });
});
