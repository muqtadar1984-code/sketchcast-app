import { describe, expect, it } from "vitest";
import {
  acceptConcept,
  acceptItem,
  assemble,
  buildSegments,
  headingMatches,
  isStale,
  mechanicalItem,
  parseModelJson,
  SLIDE_EPS_S,
  type ArtifactRow,
  type KitInput,
  type ScriptFile,
} from "../derive";

const GID = "11111111-1111-1111-1111-111111111111";
const seg = (id: string, heading: string, text = "") => ({ segment_id: id, type: "explore", slide_heading: heading, text, scene: { elements: [{ id: "a", asset: "plant_cell" }, { id: "__teach_av", asset: "avatar" }] } });
const part1: ScriptFile = {
  part: 1,
  of: 2,
  script: { script_id: "S1", segments: [seg("s001", "Hook"), seg("s002", "Composition of Air")] },
  video: { manifest_id: "V1", segments: [{ segment_id: "s001", clip_duration_seconds: 10.5 }, { segment_id: "s002", clip_duration_seconds: 20.25 }] },
};
const part2: ScriptFile = {
  part: 2,
  of: 2,
  script: { script_id: "S2", segments: [seg("s001", "Wind power")] },
  video: { manifest_id: "V2", segments: [{ segment_id: "s001", clip_duration_seconds: 5 }, { segment_id: "s990", clip_duration_seconds: 3 }] },
};
const rows: ArtifactRow[] = [
  { id: "a1", generation_id: GID, kind: "video_mp4", storage_path: `o/${GID}/lesson.mp4`, created_at: "2026-10-01T00:00:00Z" },
  { id: "a2", generation_id: GID, kind: "video_mp4", storage_path: `o/${GID}/lesson_part2.mp4`, created_at: "2026-10-01T00:00:00Z" },
];
const concepts = [
  { concept_id: "c001", name: "Air", definition: "gases" },
  { concept_id: "c002", name: "Wind", definition: "moving air" },
  { concept_id: "c003", name: "Composition of Air", definition: "mixture" },
];
const kit = (over: Partial<KitInput> = {}): KitInput => ({
  generation_id: GID,
  book_id: "b",
  chapter_ref: "0",
  article_id: null,
  format_version: 3,
  language: "en",
  scripts: [part2, part1],
  artifacts: rows,
  concepts,
  concept_source: "chapter_grounding",
  items: [],
  has_video: { 1: true, 2: true },
  ...over,
});

describe("segments (T1–T3)", () => {
  it("derives absolute times per part from cumulative clip durations, in part order", () => {
    const s = buildSegments([part2, part1], rows, GID);
    expect(s.map((x) => x.key)).toEqual(["p1:s001", "p1:s002", "p2:s001", "p2:s990"]);
    expect(s[1]).toMatchObject({ start_s: 10.5, end_s: 30.75, slide_k: 2, video_path: `o/${GID}/lesson.mp4` });
    expect(s[2]).toMatchObject({ start_s: 0, end_s: 5, slide_k: 1, video_path: `o/${GID}/lesson_part2.mp4` });
    expect(s[1].slide_t).toBeCloseTo(30.75 - SLIDE_EPS_S, 3);
  });
  it("gives the video-only outro no slide and drops avatar assets", () => {
    const s = buildSegments([part2], rows, GID);
    expect(s[1]).toMatchObject({ segment_id: "s990", slide_k: null, type: "outro" });
    expect(s[0].assets).toEqual(["plant_cell"]);
  });
});

describe("concept mapping (C1/C2)", () => {
  it("matches a heading only on a multi-word concept name, never a one-word one", () => {
    expect(headingMatches("What is Air Made Of? Composition of air", concepts).map((c) => c.concept_id)).toEqual(["c003"]);
    expect(headingMatches("Air takes shape", concepts)).toEqual([]);
  });
  it("accepts a model assignment only above the confidence floor and with known ids", () => {
    const ids = new Set(["c001"]);
    expect(acceptConcept({ segment: "x", primary: "c001", confidence: 0.9 }, ids).availability).toBe("available");
    expect(acceptConcept({ segment: "x", primary: "c001", confidence: 0.5 }, ids)).toMatchObject({ availability: "unavailable", concept_id: null });
    expect(acceptConcept({ segment: "x", primary: "c999", confidence: 0.99 }, ids).reason).toMatch(/unknown concept/);
    expect(acceptConcept(undefined, ids).availability).toBe("unavailable");
  });
});

describe("item mapping (I1/I2)", () => {
  const ids = new Set(["o1", "o5"]);
  const base = { q_id: "quiz:q1", source: "quiz" as const, generation_id: "q", type: "mcq", prompt: "Which?", answer: "x" };
  it("trusts objective_ref only when the bank item belongs to the kit's own article", () => {
    expect(mechanicalItem({ ...base, bank_item_id: "b", objective_ref: "o5", bank_article_id: "ART" }, "ART", ids)?.concept_ids).toEqual(["o5"]);
    expect(mechanicalItem({ ...base, bank_item_id: "b", objective_ref: "o5", bank_article_id: "OLD" }, "ART", ids)).toBeNull();
  });
  it("marks low-confidence or unknown model mappings unavailable with a reason", () => {
    const segs = new Set(["p1:s001"]);
    expect(acceptItem(base, { q: "quiz:q1", concepts: ["o1"], segments: ["p1:s001", "p9:s9"], confidence: 0.9 }, ids, segs)).toMatchObject({ availability: "available", segment_ids: ["p1:s001"] });
    expect(acceptItem(base, { q: "quiz:q1", concepts: ["o1"], confidence: 0.79 }, ids, segs).availability).toBe("unavailable");
    expect(acceptItem(base, { q: "quiz:q1", concepts: [], confidence: 0.1 }, ids, segs).reason).toMatch(/no concept fits/);
  });
});

describe("assembly, pinning and invalidation", () => {
  it("pins ids/paths and goes stale when an artifacts row changes", () => {
    const m = assemble(kit(), { model: null }, "2026-10-28T00:00:00Z");
    expect(m.pinned.script_ids).toEqual(["S1", "S2"]);
    expect(m.pinned.video_manifest_ids).toEqual(["V1", "V2"]);
    expect(m.pinned.artifact_paths).toHaveLength(2);
    expect(isStale(m, rows, 3)).toBe(false);
    const rerun = rows.map((r) => (r.id === "a2" ? { ...r, created_at: "2026-10-29T00:00:00Z" } : r));
    expect(isStale(m, rerun, 3)).toBe(true);
    expect(isStale(m, rows.slice(0, 1), 3)).toBe(true);
    expect(isStale(m, rows, 4)).toBe(true);
  });
  it("degrades moves honestly: legacy script, partial video, no concepts", () => {
    const m = assemble(kit({ format_version: null, has_video: { 1: true, 2: false }, concepts: null, concept_source: "none" }), { model: null }, "t");
    expect(m.completeness).toMatchObject({ script: "legacy", video: "partial", concepts: "none", questions: "none" });
    expect(m.moves).toMatchObject({ slide: "degraded", practise: "unavailable", remediate: "unavailable", explain: "available" });
    expect(m.segments.filter((s) => s.slide_k !== null).every((s) => s.concept.availability === "unavailable")).toBe(true);
  });
  it("parses JSON out of a fenced model reply", () => {
    expect(parseModelJson<{ a: number }>("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseModelJson("no json")).toBeNull();
  });
});
