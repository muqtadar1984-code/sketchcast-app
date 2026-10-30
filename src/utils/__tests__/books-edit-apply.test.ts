import { describe, expect, it } from "vitest";
import { applyEdits, applyImageEdits, imageSize, nextAppRevision, placedRefs } from "@/utils/books/edit-apply";
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

describe("replacing a picture", () => {
  const withPics = {
    sections: [
      { sid: "s1", heading: "H", blocks: [{ type: "figure", ref: "fig:x", caption: "Tiles" }, { type: "figure_group", items: [{ ref: "fig:x", label: "A" }, { ref: "fig:y", label: "B" }] }] },
    ],
    exercises: [{ xid: "x1", stem: "Look.", figure_ref: "fig:x", figure_refs: ["fig:y", "fig:x"] }],
    figures: {
      "fig:x": { store: "visual-assets", path: "lib/x.png", kind: "illustration", caption: "Old tiles", labels: ["a"], size: [10, 10], credit: null },
      "fig:y": { store: "visual-assets", path: "lib/y.png", kind: "photo", caption: "Y", labels: [], size: [5, 5], credit: null },
    },
  } as unknown as ChapterRevision["body"];

  it("points every use of the old picture at the new one and records it as a book picture", () => {
    const r = applyImageEdits(withPics, [{ id: 7, unit: "fig:x", meta: { key: "books/b/edits/u.png", size: [40, 30], caption: "New tiles" } }]);
    expect(r.failed).toEqual([]);
    expect(placedRefs(r.body).sort()).toEqual(["edit:img7", "fig:y"]);
    expect((r.body.exercises[0] as { figure_refs: string[] }).figure_refs).toEqual(["fig:y", "edit:img7"]);
    expect(r.body.figures?.["edit:img7"]).toMatchObject({ store: "s3", path: "books/b/edits/u.png", kind: "illustration", caption: "New tiles", labels: [], size: [40, 30] });
    expect(placedRefs(withPics).sort()).toEqual(["fig:x", "fig:y"]); // the original is untouched
  });

  it("refuses a picture the chapter no longer has", () => {
    expect(applyImageEdits(withPics, [{ id: 8, unit: "fig:z", meta: { key: "k" } }]).failed).toEqual([8]);
  });

  it("reads a PNG's size", () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    png.set([0, 0, 1, 0x2c], 16); // 300
    png.set([0, 0, 0, 0xc8], 20); // 200
    expect(imageSize(png)).toEqual({ type: "image/png", size: [300, 200] });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
