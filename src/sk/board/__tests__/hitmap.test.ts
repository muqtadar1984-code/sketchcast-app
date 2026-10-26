// SK B2 — the hit map is DATA from the renderer's export (or, one day, a
// bucket): numeric clamped boxes, allow-listed ids and verbs, bounded counts,
// every timeline target an element the map declares. The real six Chapter 2
// maps and the S1 U4 map pass unchanged; each adversarial case is refused
// whole (SegmentError) or, for an out-of-world box, clamped.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { drawnAt, hitBox, hitTargets, lastDrawnAt, LIMITS, SegmentError, validateHitMap, type HitMap } from "../engine";

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8")) as HitMap;
const UNITS = ["s1", "s2", "s3", "s4", "s5", "s6"];
const ch02 = (u: string) => load(`../../../../public/sk-s1/ch02/${u}/explain-main/hitmap.json`);
const clone = (h: HitMap): HitMap => JSON.parse(JSON.stringify(h));
const refuses = (mutate: (h: HitMap) => void, from: HitMap = ch02("s2")) => {
  const h = clone(from);
  mutate(h);
  expect(() => validateHitMap(h)).toThrow(SegmentError);
};

describe("the real hit maps pass", () => {
  it.each(UNITS)("ch02 %s validates and normalises to itself", (u) => {
    const h = ch02(u);
    const v = validateHitMap(h);
    expect(Object.keys(v.elements)).toEqual(Object.keys(h.elements));
    expect(v.timeline.length).toBe(h.timeline.length);
    expect(v.world).toEqual({ w: 1280, h: 720 });
  });
  it("the S1 U4 Option S map validates", () => {
    expect(() => validateHitMap(load("../../../../public/sk-s1/u4/optionS.hitmap.json"))).not.toThrow();
  });
});

describe("numeric boxes, clamped into the world", () => {
  it("clamps an element box that leaves the world and orders its corners", () => {
    const h = clone(ch02("s1"));
    h.elements.w1!.box = [1400, -20, 100, 800];
    const v = validateHitMap(h);
    expect(v.elements.w1!.box).toEqual([100, 0, 1280, 720]);
  });
  it("refuses NaN, Infinity, strings and huge numbers in boxes", () => {
    refuses((h) => (h.elements.w1!.box = [Number.NaN, 0, 10, 10]));
    refuses((h) => (h.elements.w1!.box = [0, Number.POSITIVE_INFINITY, 10, 10]));
    refuses((h) => ((h.elements.w1 as { box: unknown }).box = ["0", 0, 10, 10]));
    refuses((h) => (h.elements.w1!.box = [0, 0, 1e9, 10]));
    refuses((h) => ((h.elements.w1 as { box: unknown }).box = [0, 0, 10]));
    refuses((h) => (h.asset.ill!.regions["stage"] = [0, 0, Number.NaN, 1]));
  });
  it("refuses a world that is absent, zero or absurd", () => {
    refuses((h) => ((h as { world: unknown }).world = undefined));
    refuses((h) => (h.world.w = 0));
    refuses((h) => (h.world.h = LIMITS.world + 1));
    refuses((h) => (h.duration_ms = -1));
  });
});

describe("allow-listed ids and verbs", () => {
  it("refuses element, asset and region names that are not tokens", () => {
    refuses((h) => (h.elements['w1" onload="alert(1)'] = { box: [0, 0, 1, 1] }));
    refuses((h) => (h.elements["<svg>"] = { box: [0, 0, 1, 1] }));
    refuses((h) => Object.defineProperty(h.elements, "__proto__", { value: { box: [0, 0, 1, 1] }, enumerable: true }));
    refuses((h) => (h.asset["mic<svg>"] = { box: [0, 0, 1, 1], regions: {} }));
    refuses((h) => (h.asset.ill!.regions["eye‮piece"] = [0, 0, 1, 1])); // RTL override
    refuses((h) => (h.asset.ill!.regions["a.b"] = [0, 0, 1, 1])); // would be ambiguous as "ill.a.b"
    refuses((h) => (h.asset.ill!.regions["x".repeat(65)] = [0, 0, 1, 1]));
  });
  it("refuses unknown verbs and timeline targets that are not elements", () => {
    refuses((h) => (h.timeline[0]!.verb = "script"));
    refuses((h) => (h.timeline[0]!.target = "nope"));
    refuses((h) => (h.timeline[0]!.target = "ill.arm"));
    refuses((h) => (h.timeline[0]!.end_ms = h.timeline[0]!.start_ms - 1));
    refuses((h) => (h.timeline[0]!.start_ms = Number.NaN));
  });
});

describe("resource exhaustion", () => {
  it("refuses more elements, regions or timeline entries than the limits", () => {
    refuses((h) => {
      for (let i = 0; i <= LIMITS.elements; i++) h.elements[`e${i}`] = { box: [0, 0, 1, 1] };
    });
    refuses((h) => {
      for (let i = 0; i <= LIMITS.regions; i++) h.asset.ill!.regions[`r${i}`] = [0, 0, 1, 1];
    });
    refuses((h) => {
      const t = h.timeline[0]!;
      for (let i = 0; i <= LIMITS.timeline; i++) h.timeline.push({ ...t });
    });
  });
});

describe("what the overlay and the avatar read from a map", () => {
  const s2 = validateHitMap(ch02("s2"));
  it("resolves elements, assets and regions in world pixels", () => {
    expect(hitBox(s2, "w1")).toEqual({ x: 544, y: 592.1, w: 390, h: 42 });
    expect(hitBox(s2, "ill")).toEqual({ x: 126, y: 92, w: 348, h: 560 });
    expect(hitBox(s2, "ill.eyepiece lens")).toMatchObject({ x: 320.2, y: 100.4 });
    expect(hitBox(s2, "ill.nothing")).toBeNull();
    expect(hitBox(s2, "ghost")).toBeNull();
    expect(hitTargets(s2)).toContain("ill.eyepiece lens");
    expect(hitTargets(s2)).toContain("l3");
  });
  it("knows what is on the board at a time, in drawing order", () => {
    expect(drawnAt(s2, 0)).toEqual([]);
    expect(drawnAt(s2, 100)).toEqual(["ill"]);
    expect(drawnAt(s2, 21_000)).toEqual(["ill", "a1"]);
    expect(lastDrawnAt(s2, 30_000)).toBe("w1");
    expect(drawnAt(s2, 30_000).length).toBe(10);
  });
});
