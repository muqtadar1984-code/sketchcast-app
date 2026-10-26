// SK S1 spike engine — the pure parts a reviewer must see hold: asset→board
// mapping, trace sampling with pen lifts, checkpoint choice, and the
// handwriting schedule sharing time by glyph size.
import { describe, expect, it } from "vitest";
import { checkpointFor, glyphSchedule, handwritingPaths, progress, regionBox, toBoard, traceAt, tracePath, wordAt, type AssetFixture, type OpentypeLike } from "../engine";

const asset: AssetFixture = {
  src: "x.png",
  w: 500,
  h: 1000,
  regions: { eye: [[200, 0, 300, 100]], two: [[0, 0, 10, 10], [490, 990, 500, 1000]] },
  trace: [
    [0, 0],
    [10, 0],
    [20, 0],
    [400, 900], // a jump → pen lift
    [410, 900],
  ],
};

describe("coordinates", () => {
  it("maps a region box into the board box the asset was placed in", () => {
    const placed = { x: 10, y: 20, w: 50, h: 100 }; // asset 500×1000 → scale 0.1
    expect(toBoard(placed, asset, regionBox(asset, "eye"))).toEqual({ x: 30, y: 20, w: 10, h: 10 });
    expect(regionBox(asset, "two")).toEqual({ x: 0, y: 0, w: 500, h: 1000 }); // union of two boxes
    expect(regionBox(asset, undefined)).toEqual({ x: 0, y: 0, w: 500, h: 1000 });
  });
});

describe("trace", () => {
  it("samples the walk by fraction and lifts the pen across a jump", () => {
    expect(traceAt(asset.trace, 0)).toEqual([0, 0]);
    expect(traceAt(asset.trace, 1)).toEqual([410, 900]);
    expect(tracePath(asset.trace)).toBe("M0.0 0.0L10.0 0.0L20.0 0.0M400.0 900.0L410.0 900.0");
  });
});

describe("clock helpers", () => {
  it("resumes from the last checkpoint at or before the cursor", () => {
    expect(checkpointFor([0, 2875, 18500, 31888], 20000)).toBe(18500);
    expect(checkpointFor([0, 2875], 1)).toBe(0);
  });
  it("progress is clamped and linear", () => {
    expect(progress(0, 100, 50)).toBe(0);
    expect(progress(125, 100, 50)).toBe(0.5);
    expect(progress(999, 100, 50)).toBe(1);
    expect(progress(100, 100, 0)).toBe(1);
  });
  it("finds the spoken word for the mouth", () => {
    const words = [
      { i: 0, t0: 0, t1: 200, text: "a" },
      { i: 1, t0: 300, t1: 500, text: "b" },
    ];
    expect(wordAt(words, 100)?.text).toBe("a");
    expect(wordAt(words, 250)).toBeNull();
  });
});

describe("handwriting", () => {
  const fakeFont: OpentypeLike = {
    getPaths: (text, x, y, size) =>
      [...text].map((ch, i) => ({
        toPathData: () => (ch === " " ? "" : `M${x + i * size} ${y}L${x + i * size + size / 2} ${y - size}`),
        getBoundingBox: () => ({ x1: x + i * size, y1: y - size, x2: x + i * size + (ch === "m" ? size : size / 2), y2: y }),
      })),
    getAdvanceWidth: (text, size) => text.length * size,
  };
  it("skips spaces but still advances, and gives wider glyphs more time", () => {
    const g = handwritingPaths(fakeFont, "a m", 10, 20, 4);
    expect(g.length).toBe(2); // the space has no outline
    expect(g[1]!.advanceEnd).toBe(10 + 3 * 4);
    const sched = glyphSchedule(g, 1000);
    expect(sched[0]![0]).toBe(0);
    expect(sched[1]![1]).toBeCloseTo(1000, 6);
    expect(sched[1]![1] - sched[1]![0]).toBeGreaterThan(sched[0]![1] - sched[0]![0]); // "m" is wider than "a"
  });
});
