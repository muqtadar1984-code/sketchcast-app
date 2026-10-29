/**
 * Highlight → selection: a highlighter stroke on a deck page → the words under
 * it, in reading order (RTL lines right-to-left); the 60 s selection window;
 * the per-deck map cache.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/highlight-select.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { PageBackground, Stroke } from "@/board/model";
import { isRtlLine, wordsUnderBox, type DeckMap, type DeckMapSlide } from "../deck-text";
import {
  SELECTION_MAX_CHARS,
  activeSelection,
  createDeckMapCache,
  payloadOf,
  selectionFromBox,
  selectionFromStroke,
  strokePointsBox,
} from "../highlight-select";

// A 16:9 slide, so page units divide straight through (x/1600, y/900).
// Line 1 at y 0.20–0.26 (page y 180–234), line 2 at y 0.40–0.46 (page y 360–414),
// an Arabic line at y 0.60–0.66 (page y 540–594), written right to left.
const slide: DeckMapSlide = {
  n: 3,
  png: "slide_03.png",
  w: 1920,
  h: 1080,
  title: "Diffusion",
  notes: "Ask what happens to a drop of ink.",
  text: "Particles move from high concentration to low",
  words: [
    { t: "Particles", b: [0.1, 0.2, 0.25, 0.26] },
    { t: "move", b: [0.27, 0.2, 0.35, 0.26] },
    { t: "from", b: [0.37, 0.2, 0.44, 0.26] },
    { t: "to", b: [0.36, 0.405, 0.4, 0.465] },
    { t: "high", b: [0.1, 0.4, 0.17, 0.46] },
    { t: "concentration", b: [0.19, 0.395, 0.34, 0.455] },
    { t: "low", b: [0.42, 0.4, 0.48, 0.46] },
    // Listed left-to-right by x, as a PDF text layer often gives them.
    { t: "الحياة", b: [0.3, 0.6, 0.43, 0.66] },
    { t: "وحدة", b: [0.45, 0.6, 0.58, 0.66] },
    { t: "الخلية", b: [0.6, 0.6, 0.75, 0.66] },
  ],
  blocks: [],
};
const map: DeckMap = { v: 1, renderer: "test", slides: [slide] };
const deckBg: PageBackground = { kind: "deckPage", generationId: "deck-1", n: 3, src: "o/deck-1/deck_pages/slide_03.png", w: 1920, h: 1080, title: "Diffusion" };
const page = { background: deckBg, map };

/** A highlighter stroke through the given page-unit points. */
const stroke = (pts: Array<[number, number]>, tool: Stroke["tool"] = "highlighter"): Stroke => ({
  id: "s1",
  page: 0,
  tool,
  color: "#F5D547",
  width: 26,
  pts: pts.flatMap(([x, y]) => [x, y, 1]),
});

describe("selectionFromStroke", () => {
  it("a stroke over one line selects exactly that line", () => {
    const sel = selectionFromStroke(stroke([[150, 207], [720, 207]]), page);
    expect(sel).not.toBeNull();
    expect(sel!.text).toBe("Particles move from");
    expect(sel!.slideN).toBe(3);
    expect(sel!.words.map((w) => w.t)).toEqual(["Particles", "move", "from"]);
    // The box is normalised to the slide, padded 2 % of the page each side.
    const [x0, y0, x1, y1] = sel!.box;
    expect(x0).toBeCloseTo((150 - 32) / 1600, 5);
    expect(y0).toBeCloseTo((207 - 18) / 900, 5);
    expect(x1).toBeCloseTo((720 + 32) / 1600, 5);
    expect(y1).toBeCloseTo((207 + 18) / 900, 5);
  });

  it("a stroke over two lines selects both, line 1 then line 2, each in reading order", () => {
    const sel = selectionFromStroke(stroke([[150, 207], [720, 207], [150, 387], [720, 387]]), page);
    expect(sel?.text).toBe("Particles move from high concentration to low");
  });

  it("a stroke off any text returns null", () => {
    expect(selectionFromStroke(stroke([[150, 760], [1400, 780]]), page)).toBeNull();
  });

  it("a pen stroke, a non-deck page, or a deck page with no map returns null", () => {
    expect(selectionFromStroke(stroke([[150, 207], [720, 207]], "pen"), page)).toBeNull();
    expect(selectionFromStroke(stroke([[150, 207], [720, 207]]), { background: { kind: "blank" }, map })).toBeNull();
    expect(selectionFromStroke(stroke([[150, 207], [720, 207]]), { background: { kind: "frame", src: "x.png" }, map })).toBeNull();
    expect(selectionFromStroke(stroke([[150, 207], [720, 207]]), { background: deckBg, map: null })).toBeNull();
    expect(selectionFromStroke(stroke([[150, 207], [720, 207]]), { background: { ...deckBg, n: 9 }, map })).toBeNull();
    expect(selectionFromStroke(stroke([]), page)).toBeNull();
  });

  it("an Arabic line reads RIGHT-TO-LEFT, whatever order the map lists its words in", () => {
    const sel = selectionFromStroke(stroke([[1250, 567], [450, 567]]), page);
    expect(sel?.text).toBe("الخلية وحدة الحياة");
    expect(sel?.words.map((w) => w.t)).toEqual(["الخلية", "وحدة", "الحياة"]);
  });

  it("an English line above an Arabic one: each line in its own direction, top to bottom", () => {
    const sel = selectionFromStroke(stroke([[150, 387], [1250, 387], [1250, 567], [150, 567]]), page);
    expect(sel?.text).toBe("high concentration to low الخلية وحدة الحياة");
  });

  it("the selection is capped at 600 characters, on a word boundary", () => {
    const many: DeckMapSlide = {
      ...slide,
      words: Array.from({ length: 200 }, (_, i) => ({ t: `word${i}`, b: [0.002 + (i % 40) * 0.024, 0.1 + Math.floor(i / 40) * 0.08, 0.022 + (i % 40) * 0.024, 0.15 + Math.floor(i / 40) * 0.08] as [number, number, number, number] })),
    };
    const sel = selectionFromBox({ x: 0, y: 0, w: 1600, h: 900 }, { background: deckBg, map: { ...map, slides: [many] } });
    expect(sel!.text.length).toBeLessThanOrEqual(SELECTION_MAX_CHARS);
    expect(sel!.text.endsWith(" ")).toBe(false);
    expect(sel!.text.startsWith("word0 word1")).toBe(true);
  });
});

describe("selectionFromBox (a future drag-rectangle)", () => {
  it("a page-unit box over line 2 → line 2", () => {
    expect(selectionFromBox({ x: 140, y: 350, w: 650, h: 70 }, page)?.text).toBe("high concentration to low");
  });
});

describe("RTL ordering (deck-text)", () => {
  it("a line is RTL by the majority of its letters: one English term in Arabic stays RTL", () => {
    expect(isRtlLine([{ t: "الحمض" }, { t: "النووي" }, { t: "DNA" }])).toBe(true);
    expect(isRtlLine([{ t: "The" }, { t: "word" }, { t: "خلية" }, { t: "means" }, { t: "cell" }])).toBe(false);
  });
  it("a line with no letters takes the deck's direction when known, else LTR", () => {
    const nums = { words: [{ t: "1", b: [0.1, 0.1, 0.15, 0.15] as [number, number, number, number] }, { t: "2", b: [0.2, 0.1, 0.25, 0.15] as [number, number, number, number] }] };
    expect(wordsUnderBox(nums, [0, 0, 1, 1]).map((w) => w.t)).toEqual(["1", "2"]);
    expect(wordsUnderBox(nums, [0, 0, 1, 1], { rtl: true }).map((w) => w.t)).toEqual(["2", "1"]);
  });
});

describe("strokePointsBox", () => {
  it("uses the POINTS, not the rendered width, and clamps to the page", () => {
    expect(strokePointsBox({ pts: [10, 10, 1, 100, 20, 1] })).toEqual({ x: 0, y: 0, w: 132, h: 38 });
  });
});

describe("the selection SK is told about", () => {
  const sel = selectionFromStroke(stroke([[150, 207], [720, 207]]), page)!;
  it("payloadOf: the deck, the slide number, the text and the slide's title", () => {
    expect(payloadOf(sel, deckBg, map)).toEqual({ generationId: "deck-1", n: 3, text: "Particles move from", title: "Diffusion" });
    expect(payloadOf(sel, { kind: "blank" }, map)).toBeNull();
  });
  it("activeSelection: within 60 s it answers; after, or before it was made, it does not", () => {
    const held = { selection: payloadOf(sel, deckBg, map)!, at: 1_000_000 };
    expect(activeSelection(held, 1_000_000 + 59_000)?.text).toBe("Particles move from");
    expect(activeSelection(held, 1_000_000 + 60_001)).toBeUndefined();
    expect(activeSelection(held, 999_000)).toBeUndefined();
    expect(activeSelection(null, 1)).toBeUndefined();
  });
});

describe("createDeckMapCache", () => {
  it("fetches a deck's map once (signed URL, then the JSON) and remembers a failure as null", async () => {
    const fetchReply = vi.fn(async (g: string) => (g === "deck-1" ? { status: "ready", mapUrl: "https://signed/pages.json" } : { status: "missing" }));
    const fetchJson = vi.fn(async () => ({ v: 1, renderer: "t", slides: [{ n: 3, words: [], title: "Diffusion" }] }));
    const cache = createDeckMapCache(fetchReply, fetchJson);
    const [a, b] = await Promise.all([cache.get("deck-1"), cache.get("deck-1")]);
    expect(a?.slides[0].title).toBe("Diffusion");
    expect(b).toBe(a);
    expect(fetchReply).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(await cache.get("deck-2")).toBeNull();
    const broken = createDeckMapCache(async () => {
      throw new Error("offline");
    }, fetchJson);
    expect(await broken.get("deck-1")).toBeNull();
  });
});
