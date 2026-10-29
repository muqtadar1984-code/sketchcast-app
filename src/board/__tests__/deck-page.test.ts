/**
 * The deck's slides on the roll (founder 2026-10-28: "the pptx loaded on the
 * board … each slide as 1 page"): a `deckPage` background carries the PNG's
 * STORAGE PATH (re-signed on load, like a frozen frame), its slide number, its
 * size and the deck's text map by path. It round-trips through serialise, the
 * local log and replay; ink and a blank page in between work as on any page.
 * Run: node node_modules/vitest/vitest.mjs run src/board/__tests__/deck-page.test.ts
 */
import { describe, expect, it } from "vitest";
import { addPage, addStroke, deserialise, insertPage, newRoll, pageStrokes, serialise, setBackground, type DeckPageBackground, type Roll } from "../model";
import { BoardStore, MemoryLog, replay } from "../store";

const deck = (n: number): DeckPageBackground => ({
  kind: "deckPage",
  generationId: "deck-gen",
  n,
  src: `owner/deck-gen/deck_pages/slide_${String(n).padStart(2, "0")}.png`,
  w: 1920,
  h: 1080,
  title: `Slide ${n}`,
  map: "owner/deck-gen/deck_pages/pages.json",
});

function deckRoll(): Roll {
  const r = newRoll("r");
  setBackground(r, 0, deck(1));
  addPage(r, deck(2));
  addPage(r, deck(3));
  return r;
}

describe("deckPage background", () => {
  it("round-trips through serialise/deserialise with every field", () => {
    const r = deckRoll();
    addStroke(r, { id: "ink", page: 1, tool: "highlighter", color: "#F5D547", width: 26, pts: [100, 100, 1, 400, 110, 1] });
    const back = deserialise(serialise(r));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.roll.pages.map((p) => p.background)).toEqual([deck(1), deck(2), deck(3)]);
    expect(pageStrokes(back.roll, 1).map((s) => s.id)).toEqual(["ink"]);
  });

  it("optional fields are optional; a page with no path, no deck or a bad n is refused", () => {
    const ok = deserialise(JSON.stringify({ version: 1, id: "r", pages: [{ index: 0, background: { kind: "deckPage", generationId: "g", n: 4, src: "p.png" } }], strokes: [] }));
    expect(ok.ok && ok.roll.pages[0].background).toEqual({ kind: "deckPage", generationId: "g", n: 4, src: "p.png" });
    for (const bad of [
      { kind: "deckPage", generationId: "g", n: 1 },
      { kind: "deckPage", n: 1, src: "p.png" },
      { kind: "deckPage", generationId: "g", n: 0, src: "p.png" },
      { kind: "deckPage", generationId: "g", n: 1.5, src: "p.png" },
    ]) {
      expect(deserialise(JSON.stringify({ version: 1, id: "r", pages: [{ index: 0, background: bad }], strokes: [] })).ok).toBe(false);
    }
  });

  it("a blank page between slide 2 and slide 3 keeps the slides in order, with their ink", () => {
    const r = deckRoll();
    addStroke(r, { id: "on-3", page: 2, tool: "pen", color: "#000", width: 4, pts: [1, 1, 1] });
    insertPage(r, 1);
    expect(r.pages.map((p) => (p.background.kind === "deckPage" ? p.background.n : p.background.kind))).toEqual([1, 2, "blank", 3]);
    expect(pageStrokes(r, 3).map((s) => s.id)).toEqual(["on-3"]);
  });

  it("the local log persists the background and replay rebuilds the deck pages", async () => {
    const log = new MemoryLog();
    const s = new BoardStore("r", { log });
    await s.open();
    const r = deckRoll();
    for (const p of r.pages) await s.addPage(p.index, p.background);
    const back = replay("r", await log.all());
    expect(back.pages.map((p) => p.background)).toEqual([deck(1), deck(2), deck(3)]);
  });
});
