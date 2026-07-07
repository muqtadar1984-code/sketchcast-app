/**
 * Sketch spec authoring/validation + cache-key invariants (Phase 2):
 *   * the model's JSON is clamped to what the native renderer can actually draw
 *   * an unusable/short visual degrades gracefully (cycle→flow, else → bullets)
 *   * the cache key is stable + key-order-independent (that equality IS the $0
 *     cross-student replay) but busts on any real content/narration/voice change
 * Run: npx vitest run src/utils/tutor
 */

import { describe, expect, it } from "vitest";
import { parseSketchSpec, canonicalSpecHash, buildSketchPrompt } from "../sketch";
import type { Grounding } from "../models";

describe("parseSketchSpec — validate + clamp the model's JSON", () => {
  it("parses a bullet slide", () => {
    const r = parseSketchSpec(
      JSON.stringify({ heading: "The Water Cycle", points: ["Evaporation", "Condensation", "Precipitation"], visual: null, narration: "Water goes up and comes back down." }),
    );
    expect(r).not.toBeNull();
    expect(r!.spec.heading).toBe("The Water Cycle");
    expect(r!.spec.points).toHaveLength(3);
    expect(r!.narration).toMatch(/Water goes up/);
  });
  it("caps points to 4", () => {
    const r = parseSketchSpec(JSON.stringify({ heading: "H", points: ["a", "b", "c", "d", "e", "f"], narration: "n" }));
    expect(r!.spec.points).toHaveLength(4);
  });
  it("accepts a flow visual", () => {
    const r = parseSketchSpec(JSON.stringify({ heading: "Steps", points: [], visual: { kind: "flow", nodes: ["one", "two", "three"] }, narration: "n" }));
    expect(r!.spec.visual?.kind).toBe("flow");
    expect(r!.spec.visual?.nodes).toEqual(["one", "two", "three"]);
  });
  it("downgrades a too-short cycle to a flow (matches the worker)", () => {
    const r = parseSketchSpec(JSON.stringify({ heading: "H", visual: { kind: "cycle", nodes: ["a", "b"] }, narration: "n" }));
    expect(r!.spec.visual?.kind).toBe("flow");
  });
  it("drops an unusable visual to null (caller falls back to bullets)", () => {
    const r = parseSketchSpec(JSON.stringify({ heading: "H", points: ["p"], visual: { kind: "flow", nodes: [] }, narration: "n" }));
    expect(r!.spec.visual).toBeNull();
  });
  it("strips code fences", () => {
    const r = parseSketchSpec("```json\n{\"heading\":\"H\",\"points\":[\"p\"],\"narration\":\"n\"}\n```");
    expect(r?.spec.heading).toBe("H");
  });
  it("returns null for garbage, empty heading, or nothing to draw", () => {
    expect(parseSketchSpec("not json")).toBeNull();
    expect(parseSketchSpec(JSON.stringify({ heading: "", points: ["p"], narration: "n" }))).toBeNull();
    expect(parseSketchSpec(JSON.stringify({ heading: "H", points: [], visual: null, narration: "" }))).toBeNull();
  });
});

describe("canonicalSpecHash — the cross-student cache key", () => {
  const spec = { heading: "The Water Cycle", points: ["Evaporation", "Condensation"], visual: null };
  it("is stable for identical inputs", () => {
    expect(canonicalSpecHash(spec, "n", "edge-aria")).toBe(canonicalSpecHash(spec, "n", "edge-aria"));
  });
  it("ignores object key order (so identical slides share one clip)", () => {
    const reordered = { visual: null, points: ["Evaporation", "Condensation"], heading: "The Water Cycle" } as typeof spec;
    expect(canonicalSpecHash(reordered, "n", "edge-aria")).toBe(canonicalSpecHash(spec, "n", "edge-aria"));
  });
  it("busts when the narration or voice changes", () => {
    const base = canonicalSpecHash(spec, "n", "edge-aria");
    expect(canonicalSpecHash(spec, "different narration", "edge-aria")).not.toBe(base);
    expect(canonicalSpecHash(spec, "n", "el-rachel")).not.toBe(base);
  });
  it("busts when bullet order changes (a different slide)", () => {
    const flipped = { ...spec, points: ["Condensation", "Evaporation"] };
    expect(canonicalSpecHash(flipped, "n", "edge-aria")).not.toBe(canonicalSpecHash(spec, "n", "edge-aria"));
  });
});

describe("buildSketchPrompt — grounded + JSON-only", () => {
  const G: Grounding = { chapterTitle: "Water Cycle", concepts: null, scriptText: "Rivers flow to the sea." };
  it("injects the chapter grounding and demands strict JSON", () => {
    const { instructions, context } = buildSketchPrompt(G, "evaporation");
    expect(instructions).toMatch(/STRICT JSON/);
    expect(instructions).toMatch(/Water Cycle/);
    expect(instructions).toMatch(/evaporation/);
    expect(context).toMatch(/Rivers flow to the sea|Water Cycle/);
  });
});
