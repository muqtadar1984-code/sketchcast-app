import { describe, expect, it } from "vitest";

import { DOC_KINDS, kitRows, kitUnitsFor } from "../kit";

/**
 * "Generate all" queues one kit PER PART.
 *
 * THE INCIDENT (Sara, 2026-08-27). She clicked Generate all on a book whose
 * chapter 9 "Magnetism" has a 4-part map. She got ONE chapter-level kit — a
 * presentation that rendered as 4 video parts (the Pt 1-4 chips) plus one set of
 * documents for the whole chapter, 9 credits and 19 artifacts, all successful.
 * The Library then still showed four EMPTY "Generate kit" rows underneath it.
 * The same chapter was offered to her twice, and she had no way to tell what she
 * already owned.
 */
describe("kitUnitsFor", () => {
  it("expands a multi-part chapter into one unit per part", () => {
    // Sara's Magnetism: 4 parts.
    expect(kitUnitsFor([{ num: 8, partCount: 4 }])).toEqual([
      { chapterNum: 8, part: 1 },
      { chapterNum: 8, part: 2 },
      { chapterNum: 8, part: 3 },
      { chapterNum: 8, part: 4 },
    ]);
  });

  it("keeps a chapter with no part map at chapter level", () => {
    // There is no part row for it to fill, so part stays null.
    expect(kitUnitsFor([{ num: 0, partCount: 0 }])).toEqual([{ chapterNum: 0, part: null }]);
    expect(kitUnitsFor([{ num: 1, partCount: 1 }])).toEqual([{ chapterNum: 1, part: null }]);
  });

  it("orders chapter first, then part within it", () => {
    // The caller inserts one unit per statement and claim_next_job takes jobs by
    // created_at — so this order IS the build order the teacher watches. Part 1
    // builds while the rest sit queued, then part 2 starts.
    expect(kitUnitsFor([
      { num: 0, partCount: 2 },
      { num: 1, partCount: 0 },
      { num: 2, partCount: 3 },
    ])).toEqual([
      { chapterNum: 0, part: 1 },
      { chapterNum: 0, part: 2 },
      { chapterNum: 1, part: null },
      { chapterNum: 2, part: 1 },
      { chapterNum: 2, part: 2 },
      { chapterNum: 2, part: 3 },
    ]);
  });

  it("queues nothing for no chapters", () => {
    expect(kitUnitsFor([])).toEqual([]);
  });

  it("produces the rows the per-part rows in the Library expect", () => {
    // The unit must round-trip through kitRows into params.part, or the row it
    // fills is not the row the teacher clicked.
    const [unit] = kitUnitsFor([{ num: 8, partCount: 4 }]);
    const rows = kitRows({
      bookId: "b", schoolId: null, userId: "u",
      chapterNum: unit.chapterNum, part: unit.part,
    });
    expect(rows).toHaveLength(1 + DOC_KINDS.length); // lesson + deck + five documents
    expect(rows[0].kind).toBe("presentation"); // order is load-bearing (0059)
    // The deck (0103) rides free right behind the lesson: its DB guard, like
    // the documents', needs the presentation row inserted earlier in the same
    // statement.
    expect(rows[1].kind).toBe("deck");
    for (const r of rows) {
      expect(r.params.part).toBe(1);
      expect(r.chapter_ref).toBe("8");
    }
  });

  it("leaves params.part off a chapter-level kit", () => {
    // credit_ledger_write keys on the ABSENCE of params.part to seed a
    // chapter-level presentation from the part map — a stray part would change
    // what the teacher is charged.
    const [unit] = kitUnitsFor([{ num: 3, partCount: 1 }]);
    const rows = kitRows({
      bookId: "b", schoolId: null, userId: "u",
      chapterNum: unit.chapterNum, part: unit.part,
    });
    for (const r of rows) expect("part" in r.params).toBe(false);
  });

  it("counts the kits a run will queue, for the confirm dialog", () => {
    const chapters = [
      { num: 0, partCount: 4 },
      { num: 1, partCount: 0 },
      { num: 2, partCount: 2 },
    ];
    // 4 + 1 + 2 — what the teacher is told, and what actually gets inserted.
    expect(kitUnitsFor(chapters)).toHaveLength(7);
    expect(chapters.reduce((n, c) => n + Math.max(1, c.partCount), 0)).toBe(7);
  });
});
