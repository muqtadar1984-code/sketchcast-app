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
import type { TextCard } from "@/board/model";
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
