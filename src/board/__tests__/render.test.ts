import { describe, it, expect } from "vitest";
import { deviceRect, clipRect, unionRect, segmentBounds } from "../render";
import { fitPage } from "../model";
import { toSegments } from "../ink";

const seg = (pts: number[]) =>
  toSegments({ id: "s", page: 0, tool: "pen", color: "#000", width: 4, pts });

describe("dirty rects", () => {
  it("rounds OUTWARDS, never to nearest", () => {
    // A dirty rect rounded to nearest can land half a pixel inside the mark it
    // is meant to erase, and on an opaque canvas the leftover hairline never
    // goes away — there is no transparent clear to rescue it.
    const proj = fitPage(1600, 900); // scale 1, no offset
    const r = deviceRect({ x: 10.4, y: 10.4, w: 5.2, h: 5.2 }, proj, 1);
    expect(r.x).toBeLessThanOrEqual(10);
    expect(r.y).toBeLessThanOrEqual(10);
    expect(r.x + r.w).toBeGreaterThanOrEqual(16);
    expect(r.y + r.h).toBeGreaterThanOrEqual(16);
  });

  it("applies scale, offset and device pixel ratio together", () => {
    const proj = fitPage(800, 900); // scale 0.5, letterboxed vertically
    const r = deviceRect({ x: 0, y: 0, w: 1600, h: 900 }, proj, 2);
    // The whole page maps to the full 800 CSS px width => 1600 device px.
    expect(r.x).toBeLessThanOrEqual(0);
    expect(r.w).toBeGreaterThanOrEqual(1600);
  });

  it("clips to the bitmap and reports when nothing is left", () => {
    // Blitting a rect that starts off-canvas is a silent no-op in some engines
    // and an exception in others.
    expect(clipRect({ x: -10, y: -10, w: 30, h: 30 }, 100, 100)).toEqual({ x: 0, y: 0, w: 20, h: 20 });
    expect(clipRect({ x: 90, y: 90, w: 30, h: 30 }, 100, 100)).toEqual({ x: 90, y: 90, w: 10, h: 10 });
    expect(clipRect({ x: 200, y: 0, w: 10, h: 10 }, 100, 100)).toBeNull();
    expect(clipRect({ x: 0, y: 0, w: 0, h: 10 }, 100, 100)).toBeNull();
  });

  it("unions two rects, and tolerates either being absent", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 20, y: 5, w: 10, h: 10 };
    expect(unionRect(a, b)).toEqual({ x: 0, y: 0, w: 30, h: 15 });
    expect(unionRect(null, b)).toBe(b);
    expect(unionRect(a, null)).toBe(a);
    expect(unionRect(null, null)).toBeNull();
  });
});

describe("segment bounds", () => {
  it("contains the curve by including its control points", () => {
    // The curve stays inside the control hull, so this over-estimates and never
    // under-estimates — the safe direction for something used to erase.
    const segs = seg([0, 0, 1, 100, 100, 1, 200, 0, 1]);
    const b = segmentBounds(segs, 4)!;
    for (const s of segs) {
      for (const [x, y] of [[s.x0, s.y0], [s.c1x, s.c1y], [s.c2x, s.c2y], [s.x1, s.y1]]) {
        expect(x).toBeGreaterThanOrEqual(b.x);
        expect(x).toBeLessThanOrEqual(b.x + b.w);
        expect(y).toBeGreaterThanOrEqual(b.y);
        expect(y).toBeLessThanOrEqual(b.y + b.h);
      }
    }
  });

  it("grows by the widest point of the stroke, not the base width", () => {
    const thin = segmentBounds(seg([0, 0, 0.4, 100, 0, 0.4]), 10)!;
    const fat = segmentBounds(seg([0, 0, 1.5, 100, 0, 1.5]), 10)!;
    expect(fat.h).toBeGreaterThan(thin.h);
  });

  it("returns null for nothing to draw", () => {
    expect(segmentBounds([], 4)).toBeNull();
  });

  it("covers a lone dot", () => {
    const b = segmentBounds(seg([50, 50, 1]), 8)!;
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
    expect(b.x).toBeLessThan(50);
    expect(b.x + b.w).toBeGreaterThan(50);
  });
});
