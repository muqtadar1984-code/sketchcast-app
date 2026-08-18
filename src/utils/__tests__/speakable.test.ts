/**
 * speakableText — the narrator must read words, never "asterisk asterisk"
 * (founder's homeschool demo, 2026-08-18). Pins the exact production case
 * plus the marker families every voice surface can meet.
 * Run: npx vitest run src/utils/__tests__/speakable.test.ts
 */
import { describe, expect, it } from "vitest";
import { speakableText } from "../speakable";

describe("speakableText", () => {
  it("strips the production case: bold headings and bullet dashes", () => {
    const s = speakableText(
      "**What plant and animal cells share:** - Cell membrane (controls what goes in/out) - Cytoplasm",
    );
    expect(s).not.toMatch(/[*]/);
    expect(s).toContain("What plant and animal cells share:");
    expect(s).toContain("Cell membrane");
  });

  it("strips emphasis pairs but keeps their words", () => {
    expect(speakableText("This is **important** and *useful* and ~~not this~~.")).toBe(
      "This is important and useful and not this.",
    );
    expect(speakableText("***very*** __strong__")).toBe("very strong");
  });

  it("never lets stray unbalanced markers through (streamed sentence splits)", () => {
    expect(speakableText("**What plant cells have that animal cells don't:")).not.toMatch(/[*]/);
    expect(speakableText("stiff layer made of cellulose.**")).not.toMatch(/[*]/);
  });

  it("drops heading/bullet/blockquote line markers", () => {
    expect(speakableText("## Cells\n- one\n* two\n> note")).toBe("Cells\none\ntwo\nnote");
  });

  it("speaks link labels, never URLs", () => {
    expect(speakableText("See [the chapter](https://example.com/x) here")).toBe("See the chapter here");
  });

  it("keeps code content without backticks", () => {
    expect(speakableText("Use `photosynthesis` here")).toBe("Use photosynthesis here");
  });

  it("keeps natural # (question #2) and snake_case joins", () => {
    expect(speakableText("See question #2 about water_cycle")).toBe("See question #2 about water_cycle");
  });

  it("turns table pipes into pauses", () => {
    expect(speakableText("| cell | job |")).not.toMatch(/\|/);
  });

  it("is safe on empty and non-markdown input", () => {
    expect(speakableText("")).toBe("");
    expect(speakableText("Plain sentence.")).toBe("Plain sentence.");
  });
});
