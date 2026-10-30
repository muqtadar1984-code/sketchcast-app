/**
 * The Library's bookless generations, categorised: catalogue copies become
 * one kit per topic; lessons whose book was deleted group by chapter stem.
 * Pinned: the split, the grouping keys, piece order, the assignable subset,
 * and the title stem rule.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/bookless-kits.test.ts
 */
import { describe, expect, it } from "vitest";
import { assignableIds, groupBookless, isCatalogueCopy, titleStem, type BooklessLesson } from "../bookless-kits";

const L = (over: Partial<BooklessLesson> & { id: string }): BooklessLesson => ({
  title: "Circumference and Area of a Circle · Worksheet",
  status: "done",
  progress: 100,
  kind: "worksheet",
  params: null,
  chapterRef: null,
  videos: [],
  decks: [],
  doc: null,
  answerKey: null,
  ...over,
});
const ref = (topic: string) => ({ catalogue_ref: { topic_id: topic, source_generation_id: "s" } });

describe("groupBookless", () => {
  it("one kit per topic for catalogue copies, pieces in kit order, named by the title stem", () => {
    const { catalogue, stranded } = groupBookless([
      L({ id: "cs", kind: "case_study", title: "Circles · Case study", params: ref("t1") }),
      L({ id: "ws", kind: "worksheet", title: "Circles · Worksheet", params: ref("t1") }),
      L({ id: "pl", kind: "lesson_plan", title: "Circles · Lesson plan", params: ref("t1") }),
      L({ id: "dk", kind: "deck", title: "Circles · Circles · Slide deck", params: ref("t1") }),
      L({ id: "pr", kind: "presentation", title: "Circles · Circles", params: ref("t1") }),
      L({ id: "ws2", kind: "worksheet", title: "Angles · Worksheet", params: ref("t2") }),
    ]);
    expect(stranded).toEqual([]);
    expect(catalogue.map((g) => [g.title, g.pieces.map((p) => p.kind)])).toEqual([
      ["Circles", ["presentation", "deck", "lesson_plan", "worksheet", "case_study"]],
      ["Angles", ["worksheet"]],
    ]);
  });

  it("SketchCast book copies (0175 product_ref) are library copies too: one kit per book chapter", () => {
    const pref = (chapter: string) => ({ product_ref: { product_id: "p1", chapter_ref: chapter, source: "s" } });
    const { catalogue, stranded } = groupBookless([
      L({ id: "w1", kind: "worksheet", title: "Cells — Chapter 1: Cells · Worksheet", params: pref("0") }),
      L({ id: "p1", kind: "presentation", title: "Cells — Chapter 1: Cells · Cells", params: pref("0") }),
      L({ id: "p2", kind: "presentation", title: "Cells — Chapter 2: Microscopes · Microscopes", params: pref("1") }),
    ]);
    expect(stranded).toEqual([]);
    expect(catalogue.map((g) => [g.key, g.title, g.pieces.map((p) => p.id)])).toEqual([
      ["product:p1:0", "Cells — Chapter 1: Cells", ["p1", "w1"]],
      ["product:p1:1", "Cells — Chapter 2: Microscopes", ["p2"]],
    ]);
    expect(isCatalogueCopy({ params: pref("0") })).toBe(true); // signed with the service role, like a catalogue copy
  });

  it("a SketchCast book copy of a CATALOGUE kit (0175: catalogue_ref + product_ref) groups by its topic: a chapter's several kits stay apart, and one kit is one card", () => {
    const both = (topic: string, chapter: string) => ({ catalogue_ref: { topic_id: topic, topic_kit_id: `k-${topic}` }, product_ref: { product_id: "p1", chapter_ref: chapter, source: "s" } });
    const { catalogue } = groupBookless([
      L({ id: "blood", kind: "presentation", title: "Blood · Blood and Its Components", params: both("t-blood", "8") }),
      L({ id: "resp", kind: "presentation", title: "Respiration · The Human Respiratory System", params: both("t-resp", "8") }),
      L({ id: "resp-ws", kind: "worksheet", title: "Respiration · Worksheet", params: { catalogue_ref: { topic_id: "t-resp" } } }),
    ]);
    expect(catalogue.map((g) => [g.key, g.pieces.map((p) => p.id)])).toEqual([
      ["t-blood", ["blood"]],
      ["t-resp", ["resp", "resp-ws"]],
    ]);
  });

  it("stranded lessons group by chapter and title stem, never mixed with copies", () => {
    const { catalogue, stranded } = groupBookless([
      L({ id: "a", kind: "worksheet", title: "Photosynthesis · Worksheet", chapterRef: "4" }),
      L({ id: "b", kind: "presentation", title: "Photosynthesis", chapterRef: "4", videos: ["v"] }),
      L({ id: "c", kind: "worksheet", title: "Respiration · Worksheet", chapterRef: "5" }),
      L({ id: "d", kind: "worksheet", title: "Angles · Worksheet", params: ref("t2") }),
    ]);
    expect(catalogue).toHaveLength(1);
    expect(stranded.map((g) => [g.chapterRef, g.title, g.pieces.map((p) => p.id)])).toEqual([
      ["4", "Photosynthesis", ["b", "a"]],
      ["5", "Respiration", ["c"]],
    ]);
  });

  it("assignable = finished pieces except the plan and the question bank", () => {
    const pieces = [
      L({ id: "pr", kind: "presentation" }),
      L({ id: "pl", kind: "lesson_plan" }),
      L({ id: "ws", kind: "worksheet" }),
      L({ id: "qb", kind: "question_bank" }),
      L({ id: "cs", kind: "case_study", status: "processing" }),
    ];
    expect(assignableIds(pieces)).toEqual(["pr", "ws"]);
  });

  it("title stem and copy detection", () => {
    expect(titleStem("Circles · Circles · Slide deck")).toBe("Circles");
    expect(titleStem("Plain title")).toBe("Plain title");
    expect(isCatalogueCopy(L({ id: "x", params: ref("t") }))).toBe(true);
    expect(isCatalogueCopy(L({ id: "y", params: { catalogue: "true" } }))).toBe(false);
    expect(isCatalogueCopy(L({ id: "z", params: null }))).toBe(false);
  });
});
