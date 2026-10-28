import { describe, it, expect } from "vitest";
import { diffChapter, wordDiff } from "../books/diff";
import type { ChapterBody } from "../books/types";

const body = (blocks: ChapterBody["sections"][number]["blocks"], exercises: ChapterBody["exercises"] = []): ChapterBody => ({
  sections: [{ sid: "s1", heading: "Cells", blocks }],
  exercises,
});

describe("diffChapter", () => {
  it("an identical chapter has no changes", () => {
    const a = body([{ type: "paragraph", text: "A cell is small." }]);
    const d = diffChapter(a, a);
    expect(d.counts).toEqual({ blocksAdded: 0, blocksRemoved: 0, blocksChanged: 0, exercisesChanged: 0 });
    expect(d.sections[0].status).toBe("same");
  });

  it("an edited paragraph is one changed block with a word diff", () => {
    const d = diffChapter(body([{ type: "paragraph", text: "the cell stores energy as ATP" }]), body([{ type: "paragraph", text: "the cell releases energy" }]));
    expect(d.counts.blocksChanged).toBe(1);
    const c = d.sections[0].blocks[0];
    expect(c.op).toBe("changed");
    if (c.op === "changed") expect(c.words.filter((w) => w.op === "del").map((w) => w.text.trim()).join(" ")).toContain("stores");
  });

  it("an unchanged block that moved stays 'same'; an inserted block is 'added'", () => {
    const p = { type: "paragraph", text: "kept" };
    const d = diffChapter(body([p]), body([{ type: "key_idea", text: "new" }, p]));
    expect(d.sections[0].blocks.map((b) => b.op)).toEqual(["added", "same"]);
  });

  it("a dropped picture is reported even when the text is untouched", () => {
    const d = diffChapter(body([{ type: "figure", ref: "fig:a", caption: "x" }]), body([]));
    expect(d.figuresRemoved).toEqual(["fig:a"]);
    expect(d.counts.blocksRemoved).toBe(1);
  });

  it("exercises are matched by id", () => {
    const d = diffChapter(body([], [{ xid: "x1", stem: "What is a cell?" }]), body([], [{ xid: "x1", stem: "What is an organelle?" }, { xid: "x2", stem: "New" }]));
    expect(d.exercises.map((x) => x.status)).toEqual(["changed", "added"]);
  });
});

describe("wordDiff", () => {
  it("keeps shared words and marks the rest", () => {
    const ops = wordDiff("a b c", "a x c");
    expect(ops.map((o) => o.op)).toEqual(["same", "del", "add", "same"]);
  });
});
