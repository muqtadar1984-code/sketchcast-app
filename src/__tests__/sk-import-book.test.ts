// SK book import (tools/sk/import-book-lib.ts): a whole approved edition as one transaction, chapter topics from
// the bundle, curriculum links from the agreed coverage, review chapters without a bank, approvals enforced.
import { describe, expect, it } from "vitest";
import type { ChapterDraft } from "../../tools/sk/export-lib";
import { bookSql, validateBundle, type Bundle } from "../../tools/sk/import-book-lib";

function draft(n: number): ChapterDraft {
  return {
    chapter: { number: n, title: `Chapter ${n} title`, node_codes: ["7Bs.01"] },
    work: { slug: "test-book", title: "Biology: Test Book", curriculum: "cur_x" },
    plan: { sections: [
      { sid: "s1", purpose: "Explain what a cell is.", node_codes: ["7Bs.01"], source_refs: ["claim:c1"] },
      { sid: "s2", purpose: "Use a microscope safely.", node_codes: ["7Bs.01"], source_refs: ["claim:c2"] },
    ] },
    sections: [
      { sid: "s1", heading: "Cells", blocks: [{ type: "paragraph", text: "A cell is …", source_refs: ["claim:c1"] }] },
      { sid: "s2", heading: "Microscopes", blocks: [{ type: "paragraph", text: "Carry it with two hands.", source_refs: ["claim:c2"] }] },
    ],
    exercises: [
      { xid: "x1", tier: "guided", item_type: "mcq", stem: "What is a cell?", options: ["a", "b"], answer: "a", marks: 1, source_refs: ["claim:c1"] },
      { xid: "x2", tier: "independent", item_type: "short_answer", stem: "Name two safe actions.", answer: "two hands; flat surface", marks: 2, source_refs: ["claim:c2"] },
    ],
  };
}

function bundle(): Bundle {
  return {
    bundle_version: 1,
    revision: "rev9",
    product: { slug: "test-book", title: "Test Book", edition: "Revision 9", isbn: null, curriculum_code: "cur_x", languages: ["en"], manuscript_version: "rev9@abc1234" },
    chapters: [
      { number: 1, title: "Chapter 1 title", draft: "ch01-draft.json", draft_sha1: "x", approval: { kind: "gate_d", at: "2026-10-26" },
        topic: { slug: "cells", title: "Cells", canonical_key: "cells" },
        curriculum_links: [
          { kind: "assessed", unit: "x2", code: "7TWSc.05", evidence: ["Name two safe actions."] },
          { kind: "taught", unit: "s2", code: "7TWSc.05", evidence: ["Carry it with two hands."] },
          { kind: "taught", unit: "s9", code: "7Bs.01", evidence: ["no such section"] },
        ] },
      { number: 2, title: "Review", draft: "ch02-draft.json", draft_sha1: "y", approval: { kind: "book", at: "2026-10-27" },
        topic: null, curriculum_links: [] },
    ],
  };
}

const drafts = () => new Map([[1, draft(1)], [2, draft(2)]]);

describe("bookSql", () => {
  it("writes the whole book as ONE transaction ending in a summary", () => {
    const { sql } = bookSql(bundle(), drafts());
    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.match(/^commit;$/gm)).toHaveLength(1);
    expect(sql.indexOf("commit;")).toBeLessThan(sql.indexOf("as summary"));
    expect(sql).toContain("set edition = 'Revision 9'");
  });

  it("links come from the agreed coverage: assessed as 'supports', taught as 'covers' (written last, so it wins)", () => {
    const { sql, reports } = bookSql(bundle(), drafts());
    const supports = sql.indexOf("'supports', 0.7");
    const covers = sql.indexOf("'covers', 0.8");
    expect(supports).toBeGreaterThan(-1);
    expect(covers).toBeGreaterThan(supports);
    expect(sql).toContain("where public.objective_curriculum_map.status = 'proposed' and public.objective_curriculum_map.mapped_by = 'model'");
    expect(reports[0].links).toEqual({ taught: 1, assessed: 1, unplaced: ["s9:7Bs.01"] });
  });

  it("a chapter with no catalogue topic keeps its teaching but skips its questions, and says so", () => {
    const { reports } = bookSql(bundle(), drafts());
    expect(reports[1].exercises).toBe(0);
    expect(reports[1].exercises_skipped).toMatch(/no catalogue topic/);
    expect(reports[1].units).toBe(2);
  });

  it("refuses a chapter without an approval, a wrong draft, or a bundle of another shape", () => {
    const b = bundle();
    (b.chapters[1] as { approval: unknown }).approval = null;
    expect(() => validateBundle(b)).toThrow(/no approval/);
    const wrong = new Map([[1, draft(1)], [2, draft(5)]]);
    expect(() => bookSql(bundle(), wrong)).toThrow(/is chapter 5, not 2/);
    expect(() => validateBundle({ ...bundle(), bundle_version: 2 } as unknown as Bundle)).toThrow(/bundle_version/);
  });
});

describe("sort questions", () => {
  it("become match items whose answers repeat (each item paired with its category)", async () => {
    const { toTopicQuestion } = await import("../../tools/sk/export-lib");
    const row = toTopicQuestion({ xid: "x4", item_type: "sort", stem: "Sort these.", answer: "…",
      items: [{ text: "Amoeba", category: "Unicellular" }, { text: "Rabbit", category: "Multicellular" }] }, { slug: "b", chapter: 1 });
    expect(row.item_type).toBe("match");
    expect(row.answer_mode).toBe("objective");
    expect(row.answer).toEqual({ pairs: [{ left: "Amoeba", right: "Unicellular" }, { left: "Rabbit", right: "Multicellular" }] });
  });
});
