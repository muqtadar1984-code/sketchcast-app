/**
 * teach.ts (S1 slice C): the teaching content behind explain/compare.
 *   - resolution by concept name (exact, then the Board's fuzzy match), by
 *     segment id, by kit-wide k, by part-local k, and as a pair;
 *   - items for the segment(s), worksheet first, each once;
 *   - the narration cap (1,200 chars, word boundary) and the points cap;
 *   - the loader serves a READY manifest only — every other status comes back
 *     as that status and nothing is taught from it; a throwing read is `failed`;
 *   - the TEACHING block and the question are data + one ask, two segments for
 *     a compare, and the grounding tokens cover heading/points/narration.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/teach.test.ts
 */
import { describe, expect, it } from "vitest";
import type { ReadResult } from "@/sk/manifest/store";
import { TEACH_NARRATION_MAX, clipWords, itemsFor, refLabel, resolveRef, supportFrom, teachingBlock, teachingQuestion, teachingSupport, teachingSupportTokens, type TeachingSupport } from "../teach";
import { supportTokens } from "../prompt";
import { fakeManifest } from "./fixtures";

const LONG = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" "); // ~2,300 chars

const M = fakeManifest(
  [
    { id: "s1", heading: "Introduction", narration: "Today we look at cells. The cell is the unit of life." },
    { id: "s2", heading: "Red blood cells", points: ["Carry oxygen", "No nucleus", ""], narration: "Red blood cells carry oxygen using haemoglobin. They have no nucleus, which leaves room for 270 million haemoglobin molecules." },
    { id: "s3", heading: "Nerve cells", points: ["Carry signals"], narration: `Nerve cells carry electrical signals along a long axon. ${LONG}` },
    { id: "s4", part: 2, heading: "Diffusion across the membrane", narration: "Particles move from high to low concentration." },
  ],
  [
    { id: "c-rbc", name: "red blood cell", segmentIds: ["s2"] },
    { id: "c-neuron", name: "neuron", segmentIds: ["s3"] },
    { id: "c-diff", name: "diffusion", segmentIds: ["s4"] },
  ],
  [
    { q_id: "quiz:q2", source: "quiz", segment_ids: ["s2"] },
    { q_id: "ws:q3", source: "worksheet", segment_ids: ["s2", "s3"] },
    { q_id: "ws:q4", source: "worksheet", segment_ids: ["s3"] },
    { q_id: "ws:q9", source: "worksheet", segment_ids: ["s2"], availability: "unavailable" },
  ],
);

const ready = (s: TeachingSupport) => {
  if (s.status !== "ready") throw new Error(`not ready: ${s.status}`);
  return s;
};

describe("resolveRef — one ref → one segment", () => {
  it("a concept by exact name (segmentForConcept) carries the name it was asked as", () => {
    const s = resolveRef(M, { concept: "Red Blood Cell" });
    expect(s).toMatchObject({ k: 1, segmentId: "s2", key: "p1:s2", heading: "Red blood cells", concept: "Red Blood Cell" });
    expect(s?.points).toEqual(["Carry oxygen", "No nucleus"]); // the empty point is dropped
  });
  it("a concept by its id, and by the Board's fuzzy match over names and headings", () => {
    expect(resolveRef(M, { concept: "c-neuron" })?.segmentId).toBe("s3");
    expect(resolveRef(M, { concept: "red blood cells" })?.segmentId).toBe("s2"); // plural → fuzzy
    expect(resolveRef(M, { concept: "the nerve cells" })?.segmentId).toBe("s3"); // heading words
    expect(resolveRef(M, { concept: "diffusion" })?.segmentId).toBe("s4");
    expect(resolveRef(M, { concept: "photosynthesis" })).toBeNull();
    expect(resolveRef(M, { concept: "   " })).toBeNull();
  });
  it("a segment id or key", () => {
    expect(resolveRef(M, { segmentId: "s3" })?.k).toBe(2);
    expect(resolveRef(M, { segmentId: "p2:s4" })?.k).toBe(3);
    expect(resolveRef(M, { segmentId: "s9" })).toBeNull();
  });
  it("kit-wide k, and part-local k when the part is given", () => {
    expect(resolveRef(M, { k: 3 })?.segmentId).toBe("s4");
    expect(resolveRef(M, { k: 0, part: 2 })?.segmentId).toBe("s4"); // the first slide of part 2
    expect(resolveRef(M, { k: 1, part: 1 })?.segmentId).toBe("s2");
    expect(resolveRef(M, { k: 7 })).toBeNull();
    expect(resolveRef(M, { k: -1 })).toBeNull();
    expect(resolveRef(M, { k: 2, part: 2 })).toBeNull();
  });
  it("caps the narration at TEACH_NARRATION_MAX on a word boundary", () => {
    const s = resolveRef(M, { segmentId: "s3" })!;
    expect(s.narration.length).toBeLessThanOrEqual(TEACH_NARRATION_MAX);
    expect(s.narration.startsWith("Nerve cells carry electrical signals")).toBe(true);
    expect(s.narration.endsWith(" ")).toBe(false);
    expect(/word\d+$/.test(s.narration)).toBe(true); // cut between words, not inside one
    expect(clipWords("a b", 10)).toBe("a b");
  });
  it("refLabel names what could not be found", () => {
    expect(refLabel({ concept: "osmosis" })).toBe("osmosis");
    expect(refLabel({ segmentId: "s9" })).toBe("s9");
    expect(refLabel({ k: 3 })).toBe("k=3");
    expect(refLabel({ k: 1, part: 2 })).toBe("slide 2 of part 2");
  });
});

describe("supportFrom / itemsFor", () => {
  it("explain: one segment + its available items, worksheet before quiz", () => {
    const s = ready(supportFrom(M, { concept: "red blood cell" }));
    expect(s.segments.map((x) => x.segmentId)).toEqual(["s2"]);
    expect(s.items.map((i) => i.q_id)).toEqual(["ws:q3", "quiz:q2"]); // ws:q9 is unavailable
  });
  it("compare: both segments in the order asked, items of both, each once", () => {
    const s = ready(supportFrom(M, { pair: [{ concept: "neuron" }, { concept: "red blood cell" }] }));
    expect(s.segments.map((x) => x.segmentId)).toEqual(["s3", "s2"]);
    expect(s.items.map((i) => i.q_id)).toEqual(["ws:q3", "ws:q4", "quiz:q2"]);
    expect(itemsFor(M, [])).toEqual([]);
  });
  it("names every ref that did not match", () => {
    expect(supportFrom(M, { pair: [{ concept: "neuron" }, { concept: "osmosis" }] })).toEqual({ status: "no_match", missing: ["osmosis"] });
    expect(supportFrom(M, { concept: "gravity" })).toEqual({ status: "no_match", missing: ["gravity"] });
  });
});

describe("teachingSupport — the loader serves a ready manifest only", () => {
  const admin = { from: () => ({}) };
  const reads: string[] = [];
  const readAs = (r: ReadResult) => async (_a: unknown, g: string) => {
    reads.push(g);
    return r;
  };
  it("ready → resolved support", async () => {
    const s = await teachingSupport(admin, "gen-1", { segmentId: "s2" }, readAs({ status: "ready", manifest: M, builtAt: "2026-10-28T00:00:00Z" }));
    expect(s.status).toBe("ready");
    expect(reads).toContain("gen-1");
  });
  it.each(["building", "stale", "failed", "missing"] as const)("%s → that status, nothing taught", async (status) => {
    const s = await teachingSupport(admin, "gen-1", { segmentId: "s2" }, readAs({ status, reason: status === "stale" ? "re-check" : undefined }));
    expect(s).toEqual(status === "stale" ? { status, reason: "re-check" } : { status });
  });
  it("a read that throws is `failed`, never a throw", async () => {
    const s = await teachingSupport(admin, "gen-1", { segmentId: "s2" }, async () => {
      throw new Error("sk_manifests read failed: boom");
    });
    expect(s).toEqual({ status: "failed", reason: "sk_manifests read failed: boom" });
  });
});

describe("what the model is given", () => {
  it("the TEACHING block is marked data, one entry per segment, A/B for a compare", () => {
    const one = teachingBlock(ready(supportFrom(M, { concept: "red blood cell" })));
    expect(one).toContain('<teaching data_only="true">');
    expect(one).toContain('--- slide 2: Red blood cells (asked as "red blood cell") ---');
    expect(one).toContain("points: Carry oxygen | No nucleus");
    expect(one).toContain("narration: Red blood cells carry oxygen using haemoglobin.");
    expect(one).not.toContain("[A]");
    const two = teachingBlock(ready(supportFrom(M, { pair: [{ segmentId: "s2" }, { segmentId: "s3" }] })));
    expect(two).toContain("--- [A] slide 2: Red blood cells ---");
    expect(two).toContain("--- [B] slide 3: Nerve cells ---");
  });
  it("the question asks for 2–4 sentences in the user's language; compare names both", () => {
    const sup = ready(supportFrom(M, { pair: [{ concept: "red blood cell" }, { concept: "neuron" }] }));
    expect(teachingQuestion("compare", sup, "Bahasa Melayu")).toBe('Compare "red blood cell" with "neuron" for the class in 2–4 short sentences, in Bahasa Melayu: the differences, drawn only from the two narrations in TEACHING. No headings, no lists.');
    const one = ready(supportFrom(M, { segmentId: "s3" }));
    expect(teachingQuestion("explain", one, "English")).toBe('Explain "Nerve cells" to the class in 2–4 short sentences, in English, using only the narration in TEACHING. No headings, no lists.');
  });
  it("the grounding tokens cover heading, points, narration and the asked-as name", () => {
    const sup = ready(supportFrom(M, { concept: "red blood cell" }));
    const toks = supportTokens(teachingSupportTokens(sup));
    for (const t of ["haemoglobin", "270", "nucleus", "oxygen", "red"]) expect(toks.has(t)).toBe(true);
    expect(toks.has("axon")).toBe(false);
  });
});
