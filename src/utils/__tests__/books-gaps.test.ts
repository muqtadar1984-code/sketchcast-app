import { describe, expect, it } from "vitest";
import { gapTotals, groupGaps, libraryLink, type Gap } from "@/utils/books/gaps";

const gap = (over: Partial<Gap>): Gap => ({
  title: "Calculating Speed", topic_id: null, topic_slug: null, topic_status: null, chapter: 2, chapter_title: "Motion",
  node_codes: ["P2.1"], role: "core", state: "missing_topic", failing: null,
  steps: [
    { order: 1, step: "Create the topic", job_type: null, language: null, usd: 0.2, review_min: 10, note: null },
    { order: 2, step: "Write the article", job_type: "article", language: "en", usd: 1.02, review_min: null, note: null },
  ],
  ...over,
});
const CUR = { id: "2b34a55d-a61c-4297-b256-b901f37d99ab", code: "0625", name: "Physics" };

describe("book gaps", () => {
  it("links an existing topic to its Library page", () => {
    expect(libraryLink(gap({ topic_id: "t-1" }), CUR)?.href).toBe("https://library.sketchcast.app/library/topics/t-1");
  });
  it("links a missing topic to its curriculum, where it is created from the node", () => {
    expect(libraryLink(gap({}), CUR)?.href).toBe(`https://library.sketchcast.app/library/curricula?curriculum=${CUR.id}`);
    expect(libraryLink(gap({}), null)).toBeNull();
  });
  it("totals cost and review, counting missing estimates as zero", () => {
    const t = gapTotals(gap({}));
    expect(t.usd).toBeCloseTo(1.22);
    expect(t.reviewMin).toBe(10);
  });
  it("groups by chapter in order with book totals", () => {
    const g = groupGaps([gap({ chapter: 3, title: "B" }), gap({ chapter: 1, title: "A" }), gap({ chapter: 3, title: "C" })]);
    expect(g.chapters.map((c) => [c.chapter, c.gaps.length])).toEqual([[1, 1], [3, 2]]);
    expect(g.usd).toBeCloseTo(3.66);
  });
});
