/**
 * SK's chat rendering of a lesson (student Board phase 3, 2026-10-31):
 * tex.ts (the maths subset → nodes, plain text, speech) and rich-blocks.ts
 * (Markdown blocks, maths inline / on its own line, a price is never maths).
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/rich-blocks.test.ts
 */
import { describe, expect, it } from "vitest";
import { parseTex, texPlain, texSpoken } from "../tex";
import { hasMarkup, parseBlocks, parseInline, plainOf, spokenOf, splitMath } from "../rich-blocks";
import { renderLesson, headingsFor, parseLesson } from "../../learn-teach";

describe("the maths subset", () => {
  it("fractions, powers, roots and symbols", () => {
    expect(parseTex("\\frac{3}{4}")).toEqual([{ t: "frac", num: [{ t: "sym", v: "3" }], den: [{ t: "sym", v: "4" }] }]);
    expect(texPlain(parseTex("x^2 + 1"))).toBe("x²+1");
    expect(texPlain(parseTex("\\frac{a+1}{2}"))).toBe("(a+1)/2");
    expect(texPlain(parseTex("\\sqrt{x+1}"))).toBe("√(x+1)");
    expect(texPlain(parseTex("\\sqrt[3]{8} = 2"))).toBe("3√8=2");
    expect(texPlain(parseTex("3 \\times 4 \\div 2 \\le 6"))).toBe("3×4÷2≤6");
    expect(texPlain(parseTex("x_{1} - y"))).toBe("x₁−y");
    expect(texPlain(parseTex("90^\\circ"))).toBe("90^(°)");
    expect(texPlain(parseTex("\\left( \\frac{1}{2} \\right)"))).toBe("(1/2)");
    expect(texPlain(parseTex("\\text{area} = l \\times w"))).toBe("area=l×w");
  });

  it("anything outside the subset reads as text, never an error", () => {
    expect(texPlain(parseTex("\\begin{aligned} x \\end{aligned}"))).toContain("x");
    expect(() => parseTex("{{{{{{{{{{{{{{{{{{{{x")).not.toThrow();
    expect(() => parseTex("\\frac{")).not.toThrow();
    expect(parseTex("x".repeat(5000)).length).toBeLessThanOrEqual(600);
  });

  it("read aloud: words in English, symbols for the voice of any other language", () => {
    expect(texSpoken(parseTex("\\frac{3}{4}"), "en")).toBe("3 over 4");
    expect(texSpoken(parseTex("x^2 = 9"), "en-GB")).toBe("x squared equals 9");
    expect(texSpoken(parseTex("\\sqrt{16} = 4"), "en")).toBe("the square root of 16 equals 4");
    expect(texSpoken(parseTex("\\frac{3}{4}"), "ms-MY")).toBe("3/4");
  });
});

describe("maths in a line", () => {
  it("$…$ inline and $$…$$ display", () => {
    expect(splitMath("Half is $\\frac{1}{2}$ of it")).toEqual([
      { math: false, text: "Half is " },
      { math: true, tex: "\\frac{1}{2}", display: false },
      { math: false, text: " of it" },
    ]);
    expect(splitMath("$$x = 2$$")).toEqual([{ math: true, tex: "x = 2", display: true }]);
  });

  it("a price is never maths", () => {
    expect(splitMath("A pen costs $2 and a book $15.").every((p) => !p.math)).toBe(true);
    expect(splitMath("It costs \\$5")).toEqual([{ math: false, text: "It costs $5" }]);
  });

  it("emphasis around the maths still works", () => {
    expect(parseInline("**Answer:** $x$")).toEqual([
      { kind: "text", text: "Answer:", bold: true },
      { kind: "text", text: " " },
      { kind: "math", tex: [{ t: "sym", v: "x", italic: true }] },
    ]);
  });
});

const LESSON = renderLesson(
  parseLesson(
    [
      "TITLE: Equivalent fractions",
      "IDEA: Fractions are equivalent when they show the same amount.",
      "STEP: Multiply the top and bottom by the same number.",
      "STEP: Or divide them by the same number.",
      "EXAMPLE: Simplify $\\frac{10}{15}$.",
      "WORK: Both divide by 5.",
      "WORK: $$\\frac{10}{15} = \\frac{2}{3}$$",
      "RESULT: $\\frac{2}{3}$",
      "CHECK: Is $\\frac{2}{4}$ the same as $\\frac{1}{2}$?",
    ].join("\n"),
  )!,
  headingsFor("en"),
  true,
);

describe("a lesson as blocks", () => {
  it("heading, paragraphs, a numbered list, a bullet, a display formula", () => {
    const kinds = parseBlocks(LESSON).map((b) => b.kind);
    expect(kinds).toEqual(["para", "heading", "para", "para", "ol", "para", "ul", "math", "para", "para"]);
    const ol = parseBlocks(LESSON).find((b) => b.kind === "ol");
    expect(ol && ol.kind === "ol" ? ol.items.length : 0).toBe(2);
  });

  it("a plain reply is one paragraph and needs no block renderer", () => {
    expect(hasMarkup("Osmosis moves water across a membrane. It goes from dilute to concentrated.")).toBe(false);
    expect(hasMarkup(LESSON)).toBe(true);
    expect(parseBlocks("one line\nsecond line")).toEqual([{ kind: "para", lines: [[{ kind: "text", text: "one line" }], [{ kind: "text", text: "second line" }]] }]);
  });

  it("the bubble's plain form: no marks, maths as Unicode", () => {
    const p = plainOf(LESSON);
    expect(p).not.toMatch(/[*#$\\]/);
    expect(p).toContain("Extra · beyond your lesson");
    expect(p).toContain("10/15=2/3");
  });

  it("the voice: no marks, maths as words, each line a sentence", () => {
    const s = spokenOf(LESSON, "en");
    expect(s).not.toMatch(/[*#$\\]/);
    expect(s).toContain("Simplify 10 over 15.");
    expect(s).toContain("10 over 15 equals 2 over 3.");
    expect(spokenOf("Half is $\\frac{1}{2}$", "ms")).toBe("Half is 1/2.");
  });
});
