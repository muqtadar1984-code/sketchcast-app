// SK S7 K1 — the pure text helpers: block flattening (0160's rules, never an
// answer key), the upload paragraph splitter, the 8000 cap, language guess.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/text.test.ts
import { describe, expect, it } from "vitest";
import { blockText, chunkText, detectLanguage, flattenSection, MAX_BLOCK_CHARS, normLanguage, plain, splitParagraphs } from "../text";

describe("blockText / flattenSection", () => {
  it("follows sk_block_text: paragraph, key_term, key_idea, misconception, figure, list, table, worked_example", () => {
    expect(blockText({ type: "paragraph", text: "A *bold* idea." })).toBe("A bold idea.");
    expect(blockText({ type: "key_term", term: "Variable", text: "a letter for a number" })).toBe("Variable: a letter for a number");
    expect(blockText({ type: "key_idea", text: "Balance both sides." })).toBe("Balance both sides.");
    expect(blockText({ type: "misconception", wrong: "x is 1", right: "x varies" })).toBe("Common mistake: x is 1 Correct idea: x varies");
    expect(blockText({ type: "figure", caption: "A balance", path: "fig:1" })).toBe("A balance");
    expect(blockText({ type: "list", items: ["one", "two"] })).toBe("one two");
    expect(blockText({ type: "table", caption: "T", columns: ["a"], rows: [["1"]] })).toBe("T a 1");
    expect(blockText({ type: "worked_example", problem: "2x=4", steps: ["divide by 2"], answer: "x=2" })).toBe("2x=4 divide by 2 x=2");
  });

  it("never includes think.answer, and an unknown block type gives only text/caption, not its whole body", () => {
    expect(blockText({ type: "think", text: "Why?", answer: "SECRET-THINK" })).toBe("Why?");
    expect(blockText({ type: "quiz_box", text: "Try it", answer: "SECRET-NEW", solution: "SECRET-SOL" })).toBe("Try it");
  });

  it("joins a section's blocks one per line", () => {
    expect(flattenSection({ blocks: [{ type: "paragraph", text: "One." }, { type: "key_term", term: "T", text: "d" }, { type: "figure" }] })).toBe("One.\nT: d");
    expect(flattenSection({})).toBe("");
  });

  it("plain() strips markdown emphasis and headings", () => {
    expect(plain("## Heading\n**bold**  and *it*")).toBe("Heading bold and it");
  });
});

describe("splitParagraphs (uploads, ≤ 1200 chars)", () => {
  it("splits on blank lines, joins a paragraph's PDF line breaks, packs short paragraphs", () => {
    const out = splitParagraphs("Line one\nline two.\n\nSecond para.\n\n\nThird.");
    expect(out).toEqual(["Line one line two.\n\nSecond para.\n\nThird."]);
  });

  it("never exceeds the limit: long paragraphs split at sentence ends, giant sentences at whitespace", () => {
    const sentence = "The cell membrane controls what enters and leaves the cell. ";
    const para = sentence.repeat(60); // ~3600 chars, one paragraph
    const words = "word ".repeat(700); // one 3500-char "sentence"
    const out = splitParagraphs(`${para}\n\n${words}`);
    expect(out.length).toBeGreaterThan(5);
    for (const b of out) expect(b.length).toBeLessThanOrEqual(1200);
    expect(out[0].endsWith("cell.")).toBe(true);
    expect(out.join(" ").replace(/\s+/g, " ").length).toBeGreaterThan(6900);
  });

  it("splits Arabic text at the Arabic question mark and full stop", () => {
    const ar = "ما هو التيار الكهربائي؟ ".repeat(80);
    const out = splitParagraphs(ar);
    for (const b of out) expect(b.length).toBeLessThanOrEqual(1200);
    expect(out[0].endsWith("؟")).toBe(true);
  });

  it("an empty or whitespace text gives no blocks", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs(" \n\n ")).toEqual([]);
  });
});

describe("chunkText (the 8000 cap)", () => {
  it("leaves a normal section whole and cuts a huge one into ≤ 8000-char chunks", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const huge = ("A sentence about photosynthesis. ".repeat(40) + "\n").repeat(20);
    const out = chunkText(huge);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
  });
});

describe("language", () => {
  it("detects Arabic script, else English", () => {
    expect(detectLanguage("الفصل الثالث التيار الكهربائي Electric current")).toBe("ar");
    expect(detectLanguage("Chapter 3 Electric current")).toBe("en");
    expect(detectLanguage("")).toBe("en");
  });
  it("normalises codes the blocks table accepts", () => {
    expect(normLanguage("EN")).toBe("en");
    expect(normLanguage("ms_arab")).toBe("ms-arab");
    expect(normLanguage("english language")).toBeNull();
    expect(normLanguage(null)).toBeNull();
  });
});
