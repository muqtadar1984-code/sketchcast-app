import { describe, it, expect } from "vitest";
import {
  boardEligible,
  isRevision,
  partOf,
  chapterOf,
  scopeOf,
  groupOf,
  railFor,
  pickerFor,
  NEVER_PROJECT,
  type KitGeneration,
} from "@/utils/present/kit";

const gen = (over: Partial<KitGeneration> = {}): KitGeneration => ({
  id: "g1",
  kind: "worksheet",
  title: "Book · Chapter 4 · Part 2 · Worksheet",
  chapter_ref: "3",
  params: { part: 2 },
  artifacts: [
    { kind: "docx", storage_path: "a/worksheet.docx" },
    { kind: "questions_json", storage_path: "a/worksheet_questions.json" },
  ],
  ...over,
});

describe("what may reach the board", () => {
  it("admits a kit worksheet with structured questions", () => {
    expect(boardEligible(gen())).toBe(true);
  });

  it("admits BOTH revision flavours — per chapter and cumulative", () => {
    // 0061: free standalone papers. Same kind, same questions.json, so the same
    // predicate covers them without a special case.
    expect(
      boardEligible(gen({ params: { revision: true }, chapter_ref: "5" })),
    ).toBe(true);
    expect(
      boardEligible(gen({ params: { revision: true, chapters: [0, 1, 2] }, chapter_ref: null })),
    ).toBe(true);
  });

  it("REFUSES a test paper even though it has the same structured questions", () => {
    // The worker writes questions.json for exam_paper too. It is excluded BY
    // KIND, on principle: a paper the class has watched is no longer a test.
    // Excluding it for a reason that happens to be convenient would be an
    // exclusion that disappears the day the data changes.
    const paper = gen({ kind: "exam_paper" });
    expect(paper.artifacts.some((a) => a.kind === "questions_json")).toBe(true);
    expect(boardEligible(paper)).toBe(false);
    expect(NEVER_PROJECT.has("exam_paper")).toBe(true);
    expect(NEVER_PROJECT.has("exam")).toBe(true);
  });

  it("refuses a worksheet that has no structured questions", () => {
    expect(boardEligible(gen({ artifacts: [{ kind: "docx", storage_path: "x" }] }))).toBe(false);
  });

  it("refuses every kind that has no structured text at all", () => {
    for (const kind of ["lesson_plan", "activity", "case_study", "presentation"]) {
      expect(boardEligible(gen({ kind }))).toBe(false);
    }
  });
});

describe("where a generation sits", () => {
  it("reads a part, a chapter and a cumulative chapter list", () => {
    expect(scopeOf(gen())).toEqual({ kind: "part", chapter: 3, part: 2 });
    expect(scopeOf(gen({ params: {} }))).toEqual({ kind: "chapter", chapter: 3 });
    expect(scopeOf(gen({ chapter_ref: null, params: { chapters: [0, 1, 4] } }))).toEqual({
      kind: "chapters",
      chapters: [0, 1, 4],
    });
    expect(scopeOf(gen({ chapter_ref: null, params: {} }))).toEqual({ kind: "book" });
  });

  it("reads part and chapter defensively", () => {
    expect(partOf(gen({ params: { part: 0 } }))).toBeNull();
    expect(partOf(gen({ params: { part: "2" } }))).toBeNull();
    expect(partOf(gen({ params: null }))).toBeNull();
    expect(chapterOf(gen({ chapter_ref: "not a number" }))).toBeNull();
    expect(chapterOf(gen({ chapter_ref: null }))).toBeNull();
  });

  it("knows a revision paper when it sees one", () => {
    expect(isRevision(gen({ params: { revision: true } }))).toBe(true);
    expect(isRevision(gen())).toBe(false);
  });
});

describe("grouping for the picker", () => {
  const here = { chapter: 3, part: 2 };

  it("puts the part's own worksheet first", () => {
    expect(groupOf(gen(), here)).toBe("this-part");
  });

  it("separates another part of the same chapter from another chapter", () => {
    expect(groupOf(gen({ params: { part: 5 } }), here)).toBe("this-chapter");
    expect(groupOf(gen({ chapter_ref: "8", params: { part: 1 } }), here)).toBe("this-book");
  });

  it("files every revision paper under revision, wherever it points", () => {
    expect(groupOf(gen({ params: { revision: true }, chapter_ref: "3" }), here)).toBe("revision");
    expect(
      groupOf(gen({ params: { revision: true, chapters: [0, 1] }, chapter_ref: null }), here),
    ).toBe("revision");
    // A cumulative paper is a revision paper even without the flag — it spans
    // chapters, which is not a place in the book.
    expect(groupOf(gen({ chapter_ref: null, params: { chapters: [0, 1] } }), here)).toBe("revision");
  });
});

describe("the rail for a chapter", () => {
  const here = { chapter: 3 };
  const kit: KitGeneration[] = [
    gen({ id: "vid1", kind: "presentation", params: { part: 1 }, artifacts: [{ kind: "video_mp4", storage_path: "v1.mp4" }] }),
    gen({ id: "ws1", params: { part: 1 } }),
    gen({ id: "paper1", kind: "exam_paper", params: { part: 1 } }),
    gen({ id: "plan1", kind: "lesson_plan", params: { part: 1 }, artifacts: [{ kind: "docx", storage_path: "p.docx" }] }),
    gen({ id: "vid2", kind: "presentation", params: { part: 2 }, artifacts: [{ kind: "video_mp4", storage_path: "v2.mp4" }] }),
    gen({ id: "ws2", params: { part: 2 } }),
    gen({ id: "far", chapter_ref: "8", params: { part: 1 } }),
    gen({ id: "rev", params: { revision: true } }),
  ];

  it("RETURNS EVERY PART OF THE CHAPTER, not one", () => {
    // Every kit is generated per part, so a rail scoped to a single part would
    // make her declare which part she is teaching before it showed her anything
    // — and a rail scoped to none would match nothing at all.
    const units = railFor(kit, here);
    expect(units.map((u) => u.part)).toEqual([1, 2]);
    expect(units[0].video?.id).toBe("vid1");
    expect(units[1].video?.id).toBe("vid2");
  });

  it("COUNTS THE CHAPTER'S PARTS so the UI can say \"1 of 2\" in any language", () => {
    // The label used to be composed here, in English, on the server. What the
    // rail needs is the arithmetic; the words belong to the reader's locale.
    expect(railFor(kit, here).map((u) => u.total)).toEqual([2, 2]);
  });

  it("includes a chapter-level kit as its own unit, first", () => {
    const units = railFor([...kit, gen({ id: "whole", params: {} })], here);
    expect(units[0].part).toBeNull();
  });

  it("INCLUDES the test paper, marked download-only, rather than hiding it", () => {
    // She generated it and knows it exists; a rail that silently omitted it
    // would read as a bug and she would go looking.
    const paper = railFor(kit, here)[0].docs.find((d) => d.kind === "exam_paper");
    expect(paper?.projects).toBe(false);
    expect(paper?.note).toBe("never-project");
  });

  it("DISTINGUISHES the two reasons a doc only downloads", () => {
    // A test paper is excluded on principle; a lesson plan has nothing
    // structured to put on a board. Two reasons, two sentences in ten
    // languages — so the module returns which, never the sentence.
    const plan = railFor(kit, here)[0].docs.find((d) => d.kind === "lesson_plan");
    expect(plan?.projects).toBe(false);
    expect(plan?.note).toBe("no-text");
  });

  it("puts what projects at the top of each unit", () => {
    const docs = railFor(kit, here)[0].docs;
    expect(docs[0].kind).toBe("worksheet");
    expect(docs[0].projects).toBe(true);
  });

  it("leaves other chapters and revision papers out of the rail", () => {
    const ids = railFor(kit, here).flatMap((u) => u.docs.map((d) => d.id));
    expect(ids).not.toContain("far");
    expect(ids).not.toContain("rev");
  });

  it("returns nothing for a chapter with no kits", () => {
    expect(railFor(kit, { chapter: 99 })).toEqual([]);
  });
});

describe("the picker", () => {
  const here = { chapter: 3, part: 2 };

  it("groups every board-eligible worksheet and drops the rest", () => {
    const gens = [
      gen({ id: "mine" }),
      gen({ id: "sibling", params: { part: 5 } }),
      gen({ id: "far", chapter_ref: "9", params: { part: 1 } }),
      gen({ id: "revision", params: { revision: true, chapters: [0, 1, 2] }, chapter_ref: null }),
      gen({ id: "paper", kind: "exam_paper" }),
      gen({ id: "plan", kind: "lesson_plan" }),
    ];
    const groups = pickerFor(gens, here);
    expect(groups.map((g) => g.group)).toEqual(["this-part", "this-chapter", "this-book", "revision"]);
    const all = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(all).toEqual(["mine", "sibling", "far", "revision"]);
    expect(all).not.toContain("paper");
    expect(all).not.toContain("plan");
  });

  it("CARRIES WHERE EACH ONE SITS, so projecting it can be recorded truthfully", () => {
    // Without this the board stamps the session's own chapter onto whatever she
    // opened, and a cumulative revision paper reads as progress through the
    // chapter she is teaching — the one mistake the pointer rule exists to stop.
    const items = pickerFor(
      [
        gen({ id: "mine" }),
        gen({ id: "cumulative", params: { revision: true, chapters: [0, 1, 2] }, chapter_ref: null }),
      ],
      here,
    ).flatMap((g) => g.items);
    expect(items.find((i) => i.id === "mine")).toMatchObject({ chapter: 3, part: 2 });
    expect(items.find((i) => i.id === "cumulative")).toMatchObject({ chapter: null, part: null });
    // And its SCOPE, so the UI can write "Chapter 4 · Part 2" in its own words.
    expect(items.find((i) => i.id === "mine")?.scope).toEqual({
      kind: "part",
      chapter: 3,
      part: 2,
    });
  });

  it("omits a group with nothing in it rather than showing an empty heading", () => {
    expect(pickerFor([gen({ id: "mine" })], here).map((g) => g.group)).toEqual(["this-part"]);
  });

  it("returns nothing at all when she has generated no worksheets", () => {
    expect(pickerFor([gen({ kind: "lesson_plan" })], here)).toEqual([]);
  });
});
