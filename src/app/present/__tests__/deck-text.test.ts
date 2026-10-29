/**
 * The deck's text map: parse, words under a highlighter box in reading order,
 * a slide's context, and a page-unit box back through the contain-fit letterbox.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/deck-text.test.ts
 */
import { describe, expect, it } from "vitest";
import { pageBoxToSlide, parseDeckMap, slideContext, slideOf, textUnderBox, wordsUnderBox, type DeckMapSlide } from "../deck-text";

// Two lines of words on a 16:9 slide. Line 1 at y 0.20–0.26, line 2 at y 0.40–0.46.
// Line 2's words are listed out of order and jitter a little vertically, as a
// PDF text layer does.
const slide: DeckMapSlide = {
  n: 2,
  png: "slide_02.png",
  w: 1920,
  h: 1080,
  title: "Diffusion",
  notes: "  Ask what happens to a drop of ink.  ",
  text: "Particles move from high concentration to low",
  words: [
    { t: "Particles", b: [0.1, 0.2, 0.25, 0.26] },
    { t: "move", b: [0.27, 0.2, 0.35, 0.26] },
    { t: "from", b: [0.37, 0.2, 0.44, 0.26] },
    { t: "to", b: [0.36, 0.405, 0.4, 0.465] },
    { t: "high", b: [0.1, 0.4, 0.17, 0.46] },
    { t: "concentration", b: [0.19, 0.395, 0.34, 0.455] },
    { t: "low", b: [0.42, 0.4, 0.48, 0.46] },
  ],
  blocks: [],
};

describe("textUnderBox", () => {
  it("a box covering one line returns that line, left to right", () => {
    expect(textUnderBox(slide, [0.05, 0.38, 0.6, 0.48])).toBe("high concentration to low");
    expect(textUnderBox(slide, [0.05, 0.18, 0.6, 0.28])).toBe("Particles move from");
  });

  it("a box over both lines reads line 1 then line 2", () => {
    expect(textUnderBox(slide, [0, 0, 1, 1])).toBe("Particles move from high concentration to low");
  });

  it("partial overlap: a word counts only when at least half of IT is covered", () => {
    // x 0.30..0.60 covers 5/8 of "move" (0.27..0.35) and all of "from"; a box
    // starting at 0.32 covers 3/8 of "move" — out.
    expect(textUnderBox(slide, [0.3, 0.18, 0.6, 0.28])).toBe("move from");
    expect(textUnderBox(slide, [0.32, 0.18, 0.6, 0.28])).toBe("from");
    // A stricter threshold drops the partly covered word.
    expect(textUnderBox(slide, [0.3, 0.18, 0.6, 0.28], { minOverlap: 0.9 })).toBe("from");
    // A box only grazing the bottom of line 1 takes nothing.
    expect(textUnderBox(slide, [0, 0.25, 1, 0.3])).toBe("");
  });

  it("wordsUnderBox keeps the boxes, in the same order", () => {
    expect(wordsUnderBox(slide, [0.05, 0.38, 0.6, 0.48]).map((w) => w.t)).toEqual(["high", "concentration", "to", "low"]);
  });
});

describe("slideContext / slideOf / parseDeckMap", () => {
  it("slideContext is the title, notes and text, trimmed", () => {
    expect(slideContext(slide)).toEqual({
      title: "Diffusion",
      notes: "Ask what happens to a drop of ink.",
      text: "Particles move from high concentration to low",
    });
  });

  it("parses a v1 map, dropping broken words but never the slide, sorted by n", () => {
    const map = parseDeckMap({
      v: 1,
      renderer: "libreoffice",
      slides: [
        { n: 2, png: "slide_02.png", w: 1920, h: 1080, title: "B", notes: "", text: "b", words: [{ t: "ok", b: [0, 0, 0.1, 0.1] }, { t: "bad", b: [0, 0] }, { t: "", b: [0, 0, 1, 1] }], blocks: [] },
        { n: 1, part: 1, png: "slide_01.png", w: 1920, h: 1080, title: "A", notes: "n", text: "a", words: [], blocks: [{ t: "A", b: [0, 0, 1, 0.2] }] },
        { n: 0, png: "x" },
      ],
    });
    expect(map?.slides.map((s) => s.n)).toEqual([1, 2]);
    expect(slideOf(map, 2)?.words).toEqual([{ t: "ok", b: [0, 0, 0.1, 0.1] }]);
    expect(slideOf(map, 1)).toMatchObject({ part: 1, title: "A", blocks: [{ t: "A", b: [0, 0, 1, 0.2] }] });
    expect(slideOf(map, 3)).toBeNull();
    expect(parseDeckMap({ v: 2, slides: [] })).toBeNull();
    expect(parseDeckMap("nope")).toBeNull();
  });
});

describe("pageBoxToSlide", () => {
  it("a 16:9 slide fills the page: page units divide straight through", () => {
    expect(pageBoxToSlide({ x: 160, y: 360, w: 800, h: 72 }, { w: 1920, h: 1080 })).toEqual([0.1, 0.4, 0.6, 0.48]);
  });

  it("a 4:3 slide is pillar-boxed: the letterbox comes off first, and a box in it alone is null", () => {
    // 4:3 contained in 1600x900 → 1200x900 at x 200..1400.
    const b = pageBoxToSlide({ x: 200, y: 0, w: 600, h: 450 }, { w: 1024, h: 768 });
    expect(b).toEqual([0, 0, 0.5, 0.5]);
    expect(pageBoxToSlide({ x: 0, y: 0, w: 150, h: 900 }, { w: 1024, h: 768 })).toBeNull();
    // Clamped to the slide when the stroke runs into the letterbox.
    expect(pageBoxToSlide({ x: 100, y: 0, w: 400, h: 900 }, { w: 1024, h: 768 })).toEqual([0, 0, 0.25, 1]);
  });

  it("with the deck's own map: a highlighter's page box → the words under it", () => {
    const b = pageBoxToSlide({ x: 80, y: 342, w: 880, h: 90 }, { w: slide.w, h: slide.h });
    expect(b).not.toBeNull();
    expect(textUnderBox(slide, b!)).toBe("high concentration to low");
  });
});
