import { describe, expect, it } from "vitest";
import { applyEdits, nextAppRevision } from "@/utils/books/edit-apply";
import type { ChapterRevision } from "@/utils/books/types";

const body = {
  sections: [{ sid: "s1", heading: "Like terms", blocks: [{ type: "paragraph", text: "Add like terms by combining coefficients." }, { type: "figure", ref: "fig:x", caption: "Tiles" }] }],
  exercises: [{ xid: "x1", stem: "Simplify 3x + 5x.", answer: "8x" }],
} as unknown as ChapterRevision["body"];

describe("applying reader edits", () => {
  it("replaces the passage once, inside its unit only", () => {
    const r = applyEdits(body, [
      { id: 1, unit: "s1.b0", before_text: "combining coefficients", after_text: "adding the numbers in front" },
      { id: 2, unit: "x1", before_text: "Simplify", after_text: "Write more simply:" },
    ]);
    expect(r.failed).toEqual([]);
    expect((r.body.sections[0].blocks[0] as { text: string }).text).toBe("Add like terms by adding the numbers in front.");
    expect((r.body.exercises[0] as { stem: string }).stem).toBe("Write more simply: 3x + 5x.");
    expect((body.sections[0].blocks[0] as { text: string }).text).toContain("combining"); // the original is untouched
  });

  it("reports a passage it cannot place, and never rewrites ids", () => {
    const r = applyEdits(body, [
      { id: 3, unit: "s1.b0", before_text: "not in the text", after_text: "x" },
      { id: 4, unit: "s1.b1", before_text: "fig:x", after_text: "fig:y" },
    ]);
    expect(r.failed).toEqual([3, 4]);
  });

  it("numbers the next app revision", () => {
    expect(nextAppRevision(["r4", "r4.1"])).toBe("d1");
    expect(nextAppRevision(["d1", "d2"])).toBe("d3");
  });
});
