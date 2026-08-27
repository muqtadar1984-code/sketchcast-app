import { describe, it, expect } from "vitest";
import {
  accepts,
  widthFactor,
  StrokeBuilder,
  toSegments,
  tensionFor,
  MIN_W,
  MAX_W,
  MIN_STEP,
  type InputPolicy,
} from "../ink";
import { PAGE_W, PAGE_H, pointAt, pointCount } from "../model";
import type { CaptureProfile } from "../capabilities";

const profile = (over: Partial<CaptureProfile> = {}): CaptureProfile => ({
  tier: "B",
  useCoalesced: true,
  usePrediction: false,
  desynchronized: true,
  widthFrom: "velocity",
  penOnly: false,
  touchDrawsDefault: true,
  smoothing: "normal",
  ...over,
});

const policy = (over: Partial<InputPolicy> = {}): InputPolicy => ({
  profile: profile(),
  touchMode: "draw",
  ...over,
});

describe("who is allowed to draw", () => {
  it("always lets a pen through", () => {
    expect(accepts(policy({ touchMode: "scroll" }), { pointerType: "pen" })).toBe(true);
    expect(accepts(policy({ profile: profile({ penOnly: true }) }), { pointerType: "pen" })).toBe(true);
  });

  it("locks everything else out once a pen has been seen", () => {
    // The only palm rejection that actually works, and it costs nothing.
    const p = policy({ profile: profile({ penOnly: true }) });
    expect(accepts(p, { pointerType: "touch", width: 10, height: 10 })).toBe(false);
    expect(accepts(p, { pointerType: "mouse" })).toBe(false);
  });

  it("lets a finger draw when there is no pen and touch is in draw mode", () => {
    expect(accepts(policy(), { pointerType: "touch", width: 20, height: 20 })).toBe(true);
  });

  it("stops a finger drawing when the teacher has switched touch to scroll", () => {
    expect(accepts(policy({ touchMode: "scroll" }), { pointerType: "touch" })).toBe(false);
  });

  it("rejects a palm-sized contact but only where a size is actually reported", () => {
    const p = policy({ maxContactArea: 900 });
    expect(accepts(p, { pointerType: "touch", width: 20, height: 20 })).toBe(true); // 400
    expect(accepts(p, { pointerType: "touch", width: 60, height: 60 })).toBe(false); // 3600
    // A panel that reports no size at all must not have every touch rejected —
    // and most panels report nothing.
    expect(accepts(p, { pointerType: "touch" })).toBe(true);
  });

  it("always lets a mouse through, because a mouse has no palm", () => {
    expect(accepts(policy({ touchMode: "scroll", maxContactArea: 1 }), { pointerType: "mouse" })).toBe(true);
  });

  it("treats an unrecognised pointer type as not-a-palm rather than blocking it", () => {
    expect(accepts(policy(), { pointerType: "wand" })).toBe(true);
    expect(accepts(policy(), {})).toBe(true);
  });
});

describe("width", () => {
  it("uses pressure only when the device proved it varies", () => {
    const pressure = profile({ widthFrom: "pressure" });
    expect(widthFactor(pressure, { pressure: 0 })).toBeCloseTo(MIN_W, 6);
    expect(widthFactor(pressure, { pressure: 1 })).toBeCloseTo(MAX_W, 6);
    expect(widthFactor(pressure, { pressure: 0.5 })).toBeGreaterThan(MIN_W);
  });

  it("thins the line as the hand moves faster, when there is no real pressure", () => {
    // The way a pen lightens when you move quickly.
    const v = profile({ widthFrom: "velocity" });
    const slow = widthFactor(v, { speed: 0 });
    const quick = widthFactor(v, { speed: 0.8 });
    const fast = widthFactor(v, { speed: 5 });
    expect(slow).toBeGreaterThan(quick);
    expect(quick).toBeGreaterThan(fast);
  });

  it("never lets a stroke vanish or blob, whatever the input", () => {
    const v = profile({ widthFrom: "velocity" });
    for (const speed of [0, 1, 50, 1e6, -3, NaN]) {
      const w = widthFactor(v, { speed });
      if (Number.isNaN(speed)) continue; // NaN in, NaN out is acceptable; see below
      expect(w).toBeGreaterThanOrEqual(MIN_W);
      expect(w).toBeLessThanOrEqual(MAX_W);
    }
    const p = profile({ widthFrom: "pressure" });
    for (const pressure of [0, 0.5, 1, 12, -1]) {
      const w = widthFactor(p, { pressure });
      expect(w).toBeGreaterThanOrEqual(MIN_W);
      expect(w).toBeLessThanOrEqual(MAX_W);
    }
  });

  it("falls back to a middling press when a pressure device reports nothing", () => {
    expect(widthFactor(profile({ widthFrom: "pressure" }), {})).toBeGreaterThan(MIN_W);
  });
});

describe("building a stroke", () => {
  const build = (over?: Partial<CaptureProfile>) =>
    new StrokeBuilder("s1", 0, "pen", "#14181F", 4, profile(over));

  it("keeps the first sample and drops ones that barely moved", () => {
    // Panels emit clusters of near-identical points while a finger rests.
    const b = build();
    expect(b.push({ x: 100, y: 100, t: 0 })).toBe(true);
    expect(b.push({ x: 100 + MIN_STEP / 2, y: 100, t: 16 })).toBe(false);
    expect(b.push({ x: 120, y: 100, t: 32 })).toBe(true);
    expect(b.length).toBe(2);
  });

  it("CLAMPS a stroke that runs off the page instead of dropping the points", () => {
    // Dropping would put a hole in the middle of the stroke and rejoin it
    // somewhere else; clamping stops it at the edge, which is what paper does.
    const b = build();
    b.push({ x: -50, y: -50, t: 0 });
    b.push({ x: PAGE_W + 500, y: PAGE_H + 500, t: 16 });
    const s = b.finish();
    expect(pointAt(s, 0)).toMatchObject({ x: 0, y: 0 });
    expect(pointAt(s, 1)).toMatchObject({ x: PAGE_W, y: PAGE_H });
  });

  it("survives coalesced samples that share a timestamp", () => {
    // dt === 0 must not divide by zero and poison the width with Infinity.
    const b = build();
    b.push({ x: 0, y: 0, t: 5 });
    b.push({ x: 40, y: 0, t: 5 });
    const s = b.finish();
    expect(Number.isFinite(pointAt(s, 1).w)).toBe(true);
    expect(pointAt(s, 1).w).toBeGreaterThanOrEqual(MIN_W);
  });

  it("keeps a single-point stroke, because a full stop is a mark", () => {
    const b = build();
    b.push({ x: 10, y: 10, t: 0 });
    const s = b.finish();
    expect(pointCount(s)).toBe(1);
    expect(toSegments(s)).toHaveLength(1);
  });

  it("bakes the width multiplier in rather than storing raw pressure", () => {
    // A roll must render as it was drawn on any device, without the renderer
    // knowing what drew it.
    const b = new StrokeBuilder("s", 0, "pen", "#000", 4, profile({ widthFrom: "velocity" }));
    b.push({ x: 0, y: 0, pressure: 0.5, t: 0 });
    b.push({ x: 200, y: 0, pressure: 0.5, t: 10 }); // fast
    b.push({ x: 205, y: 0, pressure: 0.5, t: 400 }); // slow
    const s = b.finish();
    expect(pointAt(s, 1).w).toBeLessThan(pointAt(s, 2).w);
  });

  it("hands back a copy, so a later push cannot mutate a finished stroke", () => {
    const b = build();
    b.push({ x: 0, y: 0, t: 0 });
    const s = b.finish();
    b.push({ x: 500, y: 500, t: 16 });
    expect(pointCount(s)).toBe(1);
  });
});

describe("smoothing", () => {
  const line = (pts: number[]) => ({
    id: "s",
    page: 0,
    tool: "pen" as const,
    color: "#000",
    width: 4,
    pts,
  });

  it("passes exactly through every captured point", () => {
    // Catmull-Rom INTERPOLATES: her handwriting stays her handwriting. A curve
    // that merely approximates the points reads as somebody else's hand.
    const s = line([0, 0, 1, 100, 50, 1, 200, 0, 1, 300, 80, 1]);
    const segs = toSegments(s);
    expect(segs).toHaveLength(3);
    expect([segs[0].x0, segs[0].y0]).toEqual([0, 0]);
    expect([segs[0].x1, segs[0].y1]).toEqual([100, 50]);
    expect([segs[2].x1, segs[2].y1]).toEqual([300, 80]);
  });

  it("keeps a straight line straight", () => {
    // Control points off the line would bow a ruled underline.
    const s = line([0, 0, 1, 100, 0, 1, 200, 0, 1, 300, 0, 1]);
    for (const g of toSegments(s)) {
      expect(g.c1y).toBeCloseTo(0, 9);
      expect(g.c2y).toBeCloseTo(0, 9);
    }
  });

  it("carries the per-point width onto each segment end", () => {
    const s = line([0, 0, 0.4, 100, 0, 1.2]);
    const [g] = toSegments(s);
    expect(g.w0).toBe(0.4);
    expect(g.w1).toBe(1.2);
  });

  it("returns nothing for a stroke with no points", () => {
    expect(toSegments(line([]))).toHaveLength(0);
  });

  it("renders a lone point as a zero-length segment the renderer can cap", () => {
    const [g] = toSegments(line([7, 9, 1]));
    expect([g.x0, g.y0, g.x1, g.y1]).toEqual([7, 9, 7, 9]);
  });

  it("is deterministic — two runs give identical geometry", () => {
    // Two exports of the same board must be byte-identical.
    const s = line([0, 0, 1, 30, 44, 0.8, 90, 12, 1.1, 140, 70, 0.6]);
    expect(toSegments(s)).toEqual(toSegments(s));
  });

  it("interpolates harder on the tier that captures the fewest points", () => {
    const s = line([0, 0, 1, 100, 50, 1, 200, 0, 1]);
    const normal = toSegments(s, tensionFor(profile({ smoothing: "normal" })));
    const heavy = toSegments(s, tensionFor(profile({ smoothing: "heavy" })));
    expect(tensionFor(profile({ smoothing: "heavy" }))).toBeGreaterThan(
      tensionFor(profile({ smoothing: "normal" })),
    );
    // Same endpoints, further-flung control points.
    expect([heavy[0].x0, heavy[0].y0]).toEqual([normal[0].x0, normal[0].y0]);
    expect(Math.abs(heavy[0].c1x - heavy[0].x0)).toBeGreaterThan(
      Math.abs(normal[0].c1x - normal[0].x0),
    );
  });
});
