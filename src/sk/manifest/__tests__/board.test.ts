import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KitManifest } from "../derive";
import { itemsForSegment, partsOf, segmentByKey, segmentForConcept, segmentIndexFor, segmentsOfPart, toBoardManifest } from "../board";

// Real M1 manifests (derived data from the spike, committed as fixtures).
const load = (f: string): KitManifest => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8")) as KitManifest;
const BIO = load("eef426bd-523b-4fed-827c-95421263d89a.json"); // one part, 19 segments, article objectives o1…o6
const THREE = load("2063bcc4-7d4c-4cad-8fc1-934880d1d3f3.json"); // three parts, 27 segments
const FALLBACK = load("b8f6d34c-01f5-4746-b6ba-f8553b8c39eb.json"); // one fallback_frame (p1:s013 → k 10)

describe("toBoardManifest", () => {
  it("one-part kit: every segment, in order, with the Board's fields and every visual.show preserved", () => {
    const b = toBoardManifest(BIO);
    expect(b.part).toBe(1);
    expect(b.generation_id).toBe(BIO.generation_id);
    expect(b.video_path).toMatch(/\/lesson\.mp4$/);
    expect(b.segments).toHaveLength(19);
    expect(b.keys).toEqual(BIO.segments.map((s) => s.key));
    for (let i = 0; i < b.segments.length; i++) {
      const s = b.segments[i];
      const src = BIO.segments[i];
      expect(s.start_s).toBe(src.start_s);
      expect(s.end_s).toBe(src.end_s);
      expect(s.slide_t).toBe(src.slide_t);
      expect(s.heading).toBe(src.heading);
      expect(s.points).toEqual(src.points);
      expect(s.visual?.show).toBe(src.visual.show);
      expect(s.visual?.status).toBe(src.visual.status);
      if (i > 0) expect(s.start_s).toBeCloseTo(b.segments[i - 1].end_s, 3);
    }
    // no foreign fields leak into the Board contract (narration stays server-side)
    expect(Object.keys(b.segments[0]).sort()).toEqual(["end_s", "heading", "points", "slide_t", "start_s", "visual"]);
    expect(b.segments.filter((s) => s.visual?.show === "frame")).toHaveLength(14);
  });

  it("three-part kit: slices one part and keeps that part's own timeline", () => {
    expect(partsOf(THREE)).toEqual([1, 2, 3]);
    const p2 = toBoardManifest(THREE, 2);
    expect(p2.part).toBe(2);
    expect(p2.segments).toHaveLength(7);
    expect(p2.segments[0].start_s).toBe(0);
    expect(p2.keys.every((k) => k.startsWith("p2:"))).toBe(true);
    expect(p2.video_path).toMatch(/lesson_part2\.mp4$/);
    expect(toBoardManifest(THREE, 3).segments).toHaveLength(11);
    expect(toBoardManifest(THREE).part).toBe(1);
    expect(toBoardManifest(THREE, 1).segments).toHaveLength(9);
    // an unknown part → empty, not a throw
    expect(toBoardManifest(THREE, 9).segments).toEqual([]);
  });

  it("re-bases fallback_k to the part's index and keeps the fallback pointing at a shown frame", () => {
    const b = toBoardManifest(FALLBACK);
    const i = FALLBACK.segments.findIndex((s) => s.visual.show === "fallback_frame");
    expect(i).toBeGreaterThan(-1);
    const v = b.segments[i].visual!;
    expect(v.show).toBe("fallback_frame");
    expect(v.fallback_k).toBe(FALLBACK.segments[i].visual.fallback_k); // one part: kit-wide k === part index
    expect(b.segments[v.fallback_k!].visual?.show).toBe("frame");
  });

  it("a fallback into another part degrades to caption_only", () => {
    const m: KitManifest = JSON.parse(JSON.stringify(THREE));
    const target = m.segments.find((s) => s.part === 1 && s.visual.show === "frame")!;
    const victim = m.segments.find((s) => s.part === 2 && s.slide_k !== null)!;
    victim.visual = { status: "misleading", show: "fallback_frame", fallback_k: target.k, reason: "test", judged_by: { model: "m", prompt_version: "v" } };
    const b = toBoardManifest(m, 2);
    const v = b.segments[b.keys.indexOf(victim.key)].visual!;
    expect(v.show).toBe("caption_only");
    expect(v.reason).toMatch(/another video part/);
    expect(v.fallback_k).toBeUndefined();
  });
});

describe("lookups the moves slice uses", () => {
  it("segmentForConcept by id and by name → the first available segment in kit order", () => {
    const byId = segmentForConcept(BIO, "o1");
    expect(byId?.key).toBe("p1:s002");
    const byName = segmentForConcept(BIO, BIO.concepts[0].name.toUpperCase());
    expect(byName?.key).toBe("p1:s002");
    expect(segmentForConcept(BIO, "o999")).toBeNull();
    expect(segmentForConcept(BIO, "")).toBeNull();
    // every concept with segments resolves to one of them
    for (const c of BIO.concepts.filter((c) => c.segment_ids.length)) {
      const s = segmentForConcept(BIO, c.concept_id);
      expect(s).not.toBeNull();
      expect(c.segment_ids).toContain(s!.key);
    }
  });

  it("segmentForConcept never returns an unavailable link", () => {
    const m: KitManifest = JSON.parse(JSON.stringify(BIO));
    for (const s of m.segments) if (s.concept.concept_id === "o1" || s.concept.secondary.includes("o1")) s.concept = { ...s.concept, availability: "unavailable" };
    expect(segmentForConcept(m, "o1")).toBeNull();
    // with the primaries gone, an AVAILABLE secondary link is the last resort
    const m2: KitManifest = JSON.parse(JSON.stringify(BIO));
    for (const s of m2.segments) if (s.concept.concept_id === "o1") s.concept = { ...s.concept, availability: "unavailable" };
    expect(segmentForConcept(m2, "o1")?.key).toBe("p1:s017");
  });

  it("itemsForSegment accepts a key or a bare segment id and returns only available items", () => {
    const viaKey = itemsForSegment(BIO, "p1:s002");
    expect(viaKey.map((i) => i.q_id)).toContain("ws:q1");
    expect(itemsForSegment(BIO, "s002").map((i) => i.q_id)).toEqual(viaKey.map((i) => i.q_id));
    expect(itemsForSegment(BIO, "p1:s990")).toEqual([]);
    expect(itemsForSegment(BIO, "")).toEqual([]);
    const m: KitManifest = JSON.parse(JSON.stringify(BIO));
    for (const i of m.items) if (i.q_id === "ws:q1") i.availability = "unavailable";
    expect(itemsForSegment(m, "p1:s002").map((i) => i.q_id)).not.toContain("ws:q1");
    // every item's segment_ids point at real segments
    const keys = new Set(BIO.segments.map((s) => s.key));
    for (const i of BIO.items) for (const k of i.segment_ids) expect(keys.has(k)).toBe(true);
  });

  it("segmentIndexFor maps kit-wide k to (part, index) across parts", () => {
    const p2first = segmentsOfPart(THREE, 2)[0];
    expect(segmentIndexFor(THREE, p2first.k)).toEqual({ part: 2, index: 0, key: p2first.key });
    const p3last = segmentsOfPart(THREE, 3).slice(-1)[0];
    expect(segmentIndexFor(THREE, p3last.k)).toEqual({ part: 3, index: 10, key: p3last.key });
    expect(segmentIndexFor(THREE, 999)).toBeNull();
    expect(segmentByKey(THREE, p2first.key)?.k).toBe(p2first.k);
    expect(segmentByKey(THREE, "nope")).toBeNull();
    // round trip with toBoardManifest
    const b = toBoardManifest(THREE, 3);
    expect(b.keys[10]).toBe(p3last.key);
  });
});
