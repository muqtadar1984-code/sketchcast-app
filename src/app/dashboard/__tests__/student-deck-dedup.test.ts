import { describe, expect, it } from "vitest";

import { assignedDeckUnits, studentDeckLinks, unitKey } from "../kit";

/**
 * A chapter can carry its deck TWICE: embedded on a pre-0103 presentation
 * (deck_pptx artifacts on the lesson row) AND as an assigned deck-kind row
 * queued since. The student dashboard used to offer both — and only the deck
 * row's link records the download; the lesson row's embedded link records
 * nothing. The Library already picks one (`deckGen ? [] : legacyDecks`);
 * these pin the student side of the same rule.
 */
const gen = (o: { id: string; kind: string; book?: string | null; ch?: string | null; part?: unknown }) => ({
  id: o.id,
  kind: o.kind,
  book_id: o.book === undefined ? "b1" : o.book,
  chapter_ref: o.ch === undefined ? "3" : o.ch,
  params: o.part === undefined ? null : { part: o.part },
});

describe("unitKey", () => {
  it("is book|chapter|part, with a chapter-level row counted as part 1", () => {
    expect(unitKey(gen({ id: "a", kind: "deck" }))).toBe("b1|3|1");
    expect(unitKey(gen({ id: "a", kind: "deck", part: 1 }))).toBe("b1|3|1");
    expect(unitKey(gen({ id: "a", kind: "deck", part: 2 }))).toBe("b1|3|2");
  });

  it("ignores a part that is not a positive number", () => {
    expect(unitKey(gen({ id: "a", kind: "deck", part: "2" }))).toBe("b1|3|1");
    expect(unitKey(gen({ id: "a", kind: "deck", part: 0 }))).toBe("b1|3|1");
  });

  it("never throws on a row missing its book or chapter", () => {
    expect(unitKey(gen({ id: "a", kind: "deck", book: null, ch: null }))).toBe("||1");
  });
});

describe("assignedDeckUnits", () => {
  const gens = [
    gen({ id: "deck-assigned", kind: "deck", part: 2 }),
    gen({ id: "deck-unassigned", kind: "deck", part: 3 }),
    gen({ id: "lesson", kind: "presentation", part: 2 }),
    gen({ id: "worksheet", kind: "worksheet", part: 2 }),
    gen({ id: "deck-other-book", kind: "deck", book: "b2" }),
  ];
  const assigned = new Set(["deck-assigned", "lesson", "worksheet", "deck-other-book"]);

  it("collects the units of ASSIGNED deck rows only", () => {
    expect(assignedDeckUnits(gens, (id) => assigned.has(id))).toEqual(new Set(["b1|3|2", "b2|3|1"]));
  });

  it("an unassigned deck does not silence the lesson's embedded copy", () => {
    expect(assignedDeckUnits(gens, (id) => assigned.has(id)).has("b1|3|3")).toBe(false);
  });
});

describe("studentDeckLinks", () => {
  const units = new Set(["b1|3|2"]);
  const legacy = ["u/g/deck.pptx"];

  it("a presentation whose unit has an assigned deck row offers no embedded deck", () => {
    expect(studentDeckLinks(gen({ id: "l", kind: "presentation", part: 2 }), units, legacy)).toEqual([]);
  });

  it("a presentation of another unit keeps its embedded deck", () => {
    expect(studentDeckLinks(gen({ id: "l", kind: "presentation", part: 1 }), units, legacy)).toEqual(legacy);
    expect(studentDeckLinks(gen({ id: "l", kind: "presentation", part: 2, ch: "4" }), units, legacy)).toEqual(legacy);
    expect(studentDeckLinks(gen({ id: "l", kind: "presentation", part: 2 }), new Set(), legacy)).toEqual(legacy);
  });

  it("the deck row itself always keeps its deck — it is the link that records", () => {
    expect(studentDeckLinks(gen({ id: "d", kind: "deck", part: 2 }), units, legacy)).toEqual(legacy);
  });
});
