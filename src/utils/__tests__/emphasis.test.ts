/**
 * emphasisSegments — the chat bubbles' display half of the markdown story
 * (speakable.ts is the voice half): bold/italic pairs become typed segments,
 * anything unbalanced stays literal. Run: npx vitest run src/utils/__tests__/emphasis.test.ts
 */
import { describe, expect, it } from "vitest";
import { emphasisSegments } from "../emphasis";

describe("emphasisSegments", () => {
  it("parses the production case", () => {
    expect(emphasisSegments("**What plant and animal cells share:** - Cell membrane")).toEqual([
      { text: "What plant and animal cells share:", bold: true, italic: false },
      { text: " - Cell membrane", bold: false, italic: false },
    ]);
  });

  it("distinguishes bold, italic and bold-italic", () => {
    expect(emphasisSegments("a **b** *c* ***d***")).toEqual([
      { text: "a ", bold: false, italic: false },
      { text: "b", bold: true, italic: false },
      { text: " ", bold: false, italic: false },
      { text: "c", bold: false, italic: true },
      { text: " ", bold: false, italic: false },
      { text: "d", bold: true, italic: true },
    ]);
  });

  it("leaves unbalanced markers literal — never guesses", () => {
    expect(emphasisSegments("2 ** 3 = 8? and *dangling")).toEqual([
      { text: "2 ** 3 = 8? and *dangling", bold: false, italic: false },
    ]);
  });

  it("never crosses line breaks", () => {
    expect(emphasisSegments("*a\nb*")).toEqual([{ text: "*a\nb*", bold: false, italic: false }]);
  });

  it("is safe on empty input", () => {
    expect(emphasisSegments("")).toEqual([]);
  });
});
