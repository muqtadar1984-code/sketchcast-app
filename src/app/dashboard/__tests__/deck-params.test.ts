import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deckParams, lessonLanguageOf } from "../kit";

/**
 * The deck (0103) is free with its lesson and asks no options — but it has
 * one option it must not lose: the LANGUAGE. The worker resolves
 * `params.language or books.language`, so a deck row queued with only
 * `{ part }` lands in the BOOK's language even when the lesson it rides on
 * was generated in another (the kit picker allows that). The kit insert
 * carries the picker's language on every row; the chip paths — the part
 * card's "+ Deck" add-back, the chapter row's add-back checkbox, and a failed
 * deck's retry — have no picker and must inherit it from the lesson instead.
 */
describe("deckParams", () => {
  it("an add-back carries the unit's part and the lesson's language", () => {
    expect(deckParams({ part: 2, lessonLanguage: "ms" })).toEqual({ part: 2, language: "ms" });
  });

  it("a chapter-level add-back carries the language alone", () => {
    expect(deckParams({ part: null, lessonLanguage: "ar" })).toEqual({ language: "ar" });
  });

  it("with no lesson language the row says nothing — the worker then uses the book's", () => {
    expect(deckParams({ part: 3 })).toEqual({ part: 3 });
    expect(deckParams({ part: 3, lessonLanguage: "" })).toEqual({ part: 3 });
    expect(deckParams({})).toBeNull();
  });

  it("a retry keeps the failed row's own language over the lesson's", () => {
    expect(deckParams({ part: 1, lessonLanguage: "en", prior: { part: 1, language: "zh" } })).toEqual({
      part: 1,
      language: "zh",
    });
  });

  it("a retry copies nothing else from the failed row", () => {
    // A stale junk-gate stamp or batch marker is not the deck's to carry;
    // the gate re-stamps on confirm if it is still active.
    expect(
      deckParams({ part: 1, lessonLanguage: "ms", prior: { part: 1, batch: true, junk_gate: { confirmed_at: "x" } } }),
    ).toEqual({ part: 1, language: "ms" });
    // And a malformed prior language falls through to the lesson's.
    expect(deckParams({ part: 1, lessonLanguage: "ms", prior: { language: 7 } })).toEqual({ part: 1, language: "ms" });
  });
});

describe("lessonLanguageOf", () => {
  it("reads the presentation row's params.language", () => {
    expect(lessonLanguageOf({ params: { language: "ta", part: 2 } })).toBe("ta");
  });

  it("is null when the row carries none, or no row exists", () => {
    expect(lessonLanguageOf({ params: { part: 2 } })).toBeNull();
    expect(lessonLanguageOf({ params: null })).toBeNull();
    expect(lessonLanguageOf(null)).toBeNull();
    expect(lessonLanguageOf({ params: { language: "" } })).toBeNull();
    expect(lessonLanguageOf({ params: { language: 3 } })).toBeNull();
  });
});

// The language has to travel from the presentation row to three JSX sites,
// and vitest collects no .tsx — a dropped prop would be silent (the deck
// would quietly come back in the book's language). Read the sources and
// assert the wiring, as the premiumVoices threading test does.
const src = (rel: string) => readFileSync(join(process.cwd(), "src/app/dashboard", rel), "utf8");

describe("deck language threading", () => {
  it("ContentCell builds a deck's params through deckParams, with the lesson language and the failed row", () => {
    const cell = src("content-cell.tsx");
    expect(cell).toMatch(/lessonLanguage\?: string \| null/);
    expect(cell).toMatch(/params=\{isDeck \? deckParams\(\{ part, lessonLanguage, prior: lesson\?\.params \}\)/);
  });

  it("the part card hands the presentation's language to its deck chip", () => {
    expect(src("lesson-card.tsx")).toMatch(/kind="deck"[\s\S]*?lessonLanguage=\{lessonLanguageOf\(p\)\}/);
  });

  it("the chapter row hands it to its cells and queues add-backs in it", () => {
    const row = src("chapter-generate.tsx");
    expect(row).toMatch(/lessonLanguage=\{lessonLanguageOf\(presL\)\}/);
    expect(row).toMatch(/const addBackLanguage = lessonLanguageOf\(presL\) \?\? language;/);
    expect(row).toMatch(/params: \{ \.\.\.defaultParams\(k\), language: addBackLanguage \}/);
  });
});
