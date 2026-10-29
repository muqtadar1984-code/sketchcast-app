// The graph's per-gender clips (packager 2026-10-27): parsed and resolved
// like `clip`, refused when the key is not a gender, and carried through to
// the session view so the student page can pick the clip for the look.
import { describe, expect, it } from "vitest";
import { GraphError, parseGraph } from "@/sk/graph";
import { boardFor } from "@/sk/loop";
import { CELLS_BASE, CELLS_GRAPH_JSON } from "./fixtures";

const base = (clips: unknown) => ({
  graph_id: "g",
  product: "p",
  chapter: 2,
  version: 1,
  units: [{ unit_key: "s1", title: "T", assets: [{ asset_id: "s1-explain-main", kind: "explain", style: "main", segment: "s1/explain-main/segment.json", clip: "s1/explain-main/clip.mp4", clips }] }],
});

describe("graph asset clips", () => {
  it("resolves relative clips against the base and keeps absolute ones", () => {
    const g = parseGraph(base({ female: "s1/explain-main/clip.mp4", male: "/elsewhere/clip-male.mp4" }), "/lessons/ch02/");
    expect(g.units[0]!.assets[0]!.clips).toEqual({ female: "/lessons/ch02/s1/explain-main/clip.mp4", male: "/elsewhere/clip-male.mp4" });
    expect(g.units[0]!.assets[0]!.clip).toBe("/lessons/ch02/s1/explain-main/clip.mp4");
  });
  it("is optional and refuses a non-gender key or a non-string path", () => {
    expect(parseGraph(base(undefined), "/lessons/ch02/").units[0]!.assets[0]!.clips).toBeUndefined();
    expect(parseGraph(base({}), "/lessons/ch02/").units[0]!.assets[0]!.clips).toBeUndefined();
    expect(() => parseGraph(base({ robot: "x.mp4" }), "/")).toThrow(GraphError);
    expect(() => parseGraph(base({ male: 3 }), "/")).toThrow(GraphError);
    expect(() => parseGraph(base(["a"]), "/")).toThrow(GraphError);
  });
  it("the Chapter 2 graph names both clips for every unit", () => {
    const g = parseGraph(JSON.parse(JSON.stringify(CELLS_GRAPH_JSON)), CELLS_BASE);
    expect(g.units.map((u) => u.unit_key)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
    for (const u of g.units) {
      const a = u.assets[0]!;
      expect(a.clips).toEqual({ female: `/lessons/ch02/${u.unit_key}/explain-main/clip.mp4`, male: `/lessons/ch02/${u.unit_key}/explain-main/clip-male.mp4` });
      expect(a.clip).toBe(a.clips!.female);
      expect(a.hitmap).toBe(`/lessons/ch02/${u.unit_key}/explain-main/hitmap.json`);
    }
  });
  it("the board behind a check carries the clips; a graph without them adds no key", () => {
    const g = parseGraph(base({ female: "a.mp4", male: "b.mp4" }), "/x/");
    expect(boardFor(g.units[0]!, undefined)).toEqual({ assetId: "s1-explain-main", segment: "/x/s1/explain-main/segment.json", clip: "/x/s1/explain-main/clip.mp4", hitmap: undefined, clips: { female: "/x/a.mp4", male: "/x/b.mp4" } });
    const plain = parseGraph(base(undefined), "/x/");
    expect(boardFor(plain.units[0]!, undefined)).toEqual({ assetId: "s1-explain-main", segment: "/x/s1/explain-main/segment.json", clip: "/x/s1/explain-main/clip.mp4", hitmap: undefined });
  });
});
