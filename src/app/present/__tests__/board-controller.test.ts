import { describe, expect, it, vi } from "vitest";
import {
  createBoardController,
  segmentTarget,
  type BoardPorts,
  type SkMove,
  type VideoLike,
} from "../board-controller";
import type { StageMode } from "../stage";

/** A video whose seeks land asynchronously, snapped to a 24 fps frame grid. */
class FakeVideo extends EventTarget implements VideoLike {
  private t = 0;
  paused = true;
  duration = 826.56;
  /** "snap" lands on the frame grid; "hang" never fires seeked; "error" fails. */
  behaviour: "snap" | "hang" | "error" | "sync" = "snap";
  seeks = 0;
  get currentTime() {
    return this.t;
  }
  set currentTime(v: number) {
    this.seeks++;
    if (this.behaviour === "hang") return;
    if (this.behaviour === "error") {
      setTimeout(() => this.dispatchEvent(new Event("error")), 1);
      return;
    }
    const landed = Math.round(v * 24) / 24;
    if (this.behaviour === "sync") {
      this.t = landed;
      this.dispatchEvent(new Event("seeked"));
      return;
    }
    setTimeout(() => {
      this.t = landed;
      this.dispatchEvent(new Event("seeked"));
    }, 5);
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
  const state = { page: 0, count: 1, mode: "away" as StageMode, closed: false };
  const calls: string[] = [];
  const ports: BoardPorts = {
    sessionId: () => "s-1",
    video: () => video,
    play: async () => {
      calls.push("play");
      state.mode = "full";
      video.paused = false;
    },
    pause: () => {
      calls.push("pause");
      video.paused = true;
    },
    freeze: async () => {
      calls.push("freeze");
      video.paused = true;
      state.count++;
      state.page = state.count - 1;
      state.mode = "corner";
      return true;
    },
    openWorksheetPage: () => {
      calls.push("worksheet");
      state.count++;
      state.page = state.count - 1;
      state.mode = "away";
      return true;
    },
    blankPage: () => {
      calls.push("blank");
      state.count++;
      state.page = state.count - 1;
    },
    goTo: (p) => {
      calls.push(`goTo:${p}`);
      state.page = Math.max(0, Math.min(state.count - 1, p));
    },
    where: () => ({ page: state.page, count: state.count }),
    stageMode: () => state.mode,
    endSession: async () => {
      calls.push("end");
      state.closed = true;
      return true;
    },
    ...over,
  };
  const logged: SkMove[] = [];
  const c = createBoardController(ports, (m) => void logged.push(m), { seekTimeoutMs: 200 });
  return { c, video, state, calls, logged };
}

const manifest = {
  segments: [
    { start_s: 0, end_s: 26.33 },
    { start_s: 26.33, end_s: 56.46 },
    { start_s: 56.46, end_s: 94.75 },
  ],
};

describe("BoardController", () => {
  it("seek resolves on seeked with the LANDED time, not the target", async () => {
    const { c, video } = harness();
    const landed = await c.seek(26.33);
    expect(landed).toBeCloseTo(Math.round(26.33 * 24) / 24, 6);
    expect(video.currentTime).toBe(landed);
    expect(Math.abs(landed - 26.33) * 1000).toBeLessThanOrEqual(150);
  });

  it("seekMeasured reports error and latency", async () => {
    const { c } = harness();
    const r = await c.seekMeasured(100.01);
    expect(r.target).toBe(100.01);
    expect(r.errorMs).toBeLessThan(1000 / 48 + 0.001);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("a seek whose seeked fires synchronously still resolves (listener attached first)", async () => {
    const { c, video } = harness();
    video.behaviour = "sync";
    await expect(c.seek(10)).resolves.toBe(10);
  });

  it("clamps out-of-range seeks to [0, duration]", async () => {
    const { c } = harness();
    expect((await c.seekMeasured(-5)).target).toBe(0);
    expect((await c.seekMeasured(99999)).target).toBe(826.56);
  });

  it("a seek that never lands rejects and is logged as failed", async () => {
    const { c, video, logged } = harness();
    video.behaviour = "hang";
    await expect(c.seek(5)).rejects.toThrow(/did not land/);
    expect(logged.at(-1)).toMatchObject({ kind: "sk_move", move: "seek", ok: false });
  });

  it("a media error during a seek rejects", async () => {
    const { c, video } = harness();
    video.behaviour = "error";
    await expect(c.seek(5)).rejects.toThrow(/video error/);
  });

  it("no video: seek rejects rather than hanging", async () => {
    const { c } = harness({ video: () => null });
    await expect(c.seek(1)).rejects.toThrow(/no video/);
  });

  it("segment edges: start nudges past the boundary keyframe; end backs off from the next segment's first frame", () => {
    expect(segmentTarget(manifest, 1, "start")).toBeCloseTo(26.36, 6);
    expect(segmentTarget(manifest, 1, "start", 0.1, 0)).toBe(26.33);
    expect(segmentTarget(manifest, 1, "end")).toBeCloseTo(56.36, 6);
    expect(segmentTarget(manifest, 1, "end", 0)).toBe(56.46);
    expect(() => segmentTarget(manifest, 9, "start")).toThrow(RangeError);
  });

  it("seekSegment lands within 150 ms of the edge and logs k and edge", async () => {
    const { c, logged } = harness();
    for (const k of [0, 1, 2]) {
      for (const edge of ["start", "end"] as const) {
        const r = await c.seekSegment(k, edge, manifest);
        expect(r.errorMs).toBeLessThanOrEqual(150);
      }
    }
    expect(logged.filter((m) => m.move === "seekSegment")).toHaveLength(6);
    expect(logged[0].args).toEqual({ k: 0, edge: "start" });
  });

  it("play / pause call the Board's own ports", async () => {
    const { c, calls } = harness();
    await c.play();
    expect(c.getState()).toMatchObject({ paused: false, stageMode: "full" });
    c.pause();
    expect(c.getState().paused).toBe(true);
    expect(calls).toEqual(["play", "pause"]);
  });

  it("freeze, worksheet and blank each add one roll page", async () => {
    const { c } = harness();
    expect(c.getState().pageCount).toBe(1);
    await c.freeze();
    expect(c.getState()).toMatchObject({ pageCount: 2, stageMode: "corner" });
    expect(c.openWorksheetPage()).toBe(true);
    expect(c.getState()).toMatchObject({ pageCount: 3, stageMode: "away" });
    c.blankPage();
    expect(c.getState().pageCount).toBe(4);
  });

  it("freeze with nothing to capture rejects and is logged as failed", async () => {
    const { c, logged } = harness({ freeze: async () => false });
    await expect(c.freeze()).rejects.toThrow(/nothing to capture/);
    expect(logged[0]).toMatchObject({ move: "freeze", ok: false });
  });

  it("worksheet with none in the unit throws", () => {
    const { c } = harness({ openWorksheetPage: () => false });
    expect(() => c.openWorksheetPage()).toThrow(/no projectable worksheet/);
  });

  it("pageUp/pageDown move one page and clamp at the ends", () => {
    const { c, state } = harness();
    c.blankPage();
    c.blankPage();
    expect(state.page).toBe(2);
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

  it("every move is logged as sk_move, in order, and getState exposes the log", async () => {
    const { c, logged } = harness();
    await c.play();
    c.pause();
    await c.seek(3);
    await c.freeze();
    c.openWorksheetPage();
    c.blankPage();
    c.pageUp();
    c.pageDown();
    await c.endSession();
    expect(logged.map((m) => m.move)).toEqual([
      "play",
      "pause",
      "seek",
      "freeze",
      "openWorksheetPage",
      "blankPage",
      "pageUp",
      "pageDown",
      "endSession",
    ]);
    expect(logged.every((m) => m.kind === "sk_move" && m.ok)).toBe(true);
    expect(c.getState().moves).toEqual(logged);
    expect(c.getState().sessionId).toBe("s-1");
  });

  it("a logger that throws or rejects never fails the move", async () => {
    const video = new FakeVideo();
    const throwing = createBoardController(
      {
        sessionId: () => "s",
        video: () => video,
        play: async () => {},
        pause: () => {},
        freeze: async () => true,
        openWorksheetPage: () => true,
        blankPage: () => {},
        goTo: () => {},
        where: () => ({ page: 0, count: 1 }),
        stageMode: () => "away",
        endSession: async () => true,
      },
      vi.fn(() => {
        throw new Error("logger down");
      }),
    );
    expect(() => throwing.blankPage()).not.toThrow();
    const rejecting = createBoardController(
      {
        sessionId: () => "s",
        video: () => video,
        play: async () => {},
        pause: () => {},
        freeze: async () => true,
        openWorksheetPage: () => true,
        blankPage: () => {},
        goTo: () => {},
        where: () => ({ page: 0, count: 1 }),
        stageMode: () => "away",
        endSession: async () => true,
      },
      () => Promise.reject(new Error("network")),
    );
    await expect(rejecting.seek(2)).resolves.toBeCloseTo(2, 6);
  });
});
