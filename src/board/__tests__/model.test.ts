import { describe, it, expect } from "vitest";
import {
  PAGE_W,
  PAGE_H,
  newRoll,
  addPage,
  setBackground,
  addStroke,
  pageStrokes,
  pointCount,
  pointAt,
  strokeBounds,
  voidLast,
  History,
  serialise,
  deserialise,
  fitPage,
  toPage,
  toScreen,
  type Roll,
  type Stroke,
} from "../model";

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  id: "s1",
  page: 0,
  tool: "pen",
  color: "#14181F",
  width: 4,
  pts: [10, 20, 0.5, 30, 40, 0.5],
  ...over,
});

/** A roll with three pages and one stroke on each, ids s0/s1/s2. */
function threePages(): Roll {
  const r = newRoll("roll_1");
  addPage(r);
  addPage(r);
  for (let p = 0; p < 3; p++) addStroke(r, stroke({ id: `s${p}`, page: p }));
  return r;
}

describe("the roll", () => {
  it("always starts with a page", () => {
    // "No pages" is not a state the renderer or exporter should have to hold.
    const r = newRoll("roll_1");
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toEqual({ index: 0, background: { kind: "blank" } });
  });

  it("keeps page indexes dense and in order as the board is pushed up", () => {
    const r = newRoll("roll_1");
    expect(addPage(r)).toBe(1);
    expect(addPage(r, { kind: "frame", src: "blob:x", t: 272 })).toBe(2);
    expect(r.pages.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it("freezes a video frame onto a page it already has", () => {
    const r = newRoll("roll_1");
    setBackground(r, 0, { kind: "frame", src: "blob:frame", generationId: "g1", t: 272.4 });
    expect(r.pages[0].background).toEqual({
      kind: "frame",
      src: "blob:frame",
      generationId: "g1",
      t: 272.4,
    });
  });

  it("ignores a background set on a page that does not exist", () => {
    const r = newRoll("roll_1");
    expect(() => setBackground(r, 9, { kind: "blank" })).not.toThrow();
    expect(r.pages).toHaveLength(1);
  });
});

describe("points", () => {
  it("reads the flat triple back as x/y/width-multiplier", () => {
    const s = stroke({ pts: [1, 2, 0.3, 4, 5, 0.6] });
    expect(pointCount(s)).toBe(2);
    expect(pointAt(s, 0)).toEqual({ x: 1, y: 2, w: 0.3 });
    expect(pointAt(s, 1)).toEqual({ x: 4, y: 5, w: 0.6 });
  });

  it("grows the bounding box by the stroke's own width", () => {
    // A dirty rect that forgets the line width leaves half a stroke on screen.
    const s = stroke({ pts: [100, 100, 0.5, 200, 150, 0.5], width: 10 });
    expect(strokeBounds(s)).toEqual({ x: 95, y: 95, w: 110, h: 60 });
  });

  it("accepts extra padding on top of the width", () => {
    const s = stroke({ pts: [100, 100, 0.5, 100, 100, 0.5], width: 10 });
    expect(strokeBounds(s, 2)).toEqual({ x: 93, y: 93, w: 14, h: 14 });
  });

  it("returns null for a stroke with no points rather than an empty box at the origin", () => {
    expect(strokeBounds(stroke({ pts: [] }))).toBeNull();
  });
});

describe("undo and redo", () => {
  it("tombstones rather than deletes, so the append order survives", () => {
    const r = threePages();
    new History().undo(r, 2);
    expect(r.strokes).toHaveLength(3);
    expect(r.strokes[2].voided).toBe(true);
    expect(pageStrokes(r, 2)).toHaveLength(0);
  });

  it("is SCOPED TO A PAGE, so undo never edits a screen she is not looking at", () => {
    // She writes on page 2, scrolls back to page 0 to add a note, presses undo.
    // Unscoped, that would silently remove her last stroke on page 2.
    const r = threePages();
    addStroke(r, stroke({ id: "late", page: 2 }));
    new History().undo(r, 0);
    expect(r.strokes.find((s) => s.id === "s0")?.voided).toBe(true);
    expect(r.strokes.find((s) => s.id === "late")?.voided).toBeUndefined();
  });

  it("walks back through several strokes and forward again", () => {
    const r = newRoll("roll_1");
    const h = new History();
    for (const id of ["a", "b", "c"]) addStroke(r, stroke({ id }));
    expect(h.undo(r)?.id).toBe("c");
    expect(h.undo(r)?.id).toBe("b");
    expect(pageStrokes(r, 0).map((s) => s.id)).toEqual(["a"]);
    expect(h.redo(r)?.id).toBe("b");
    expect(pageStrokes(r, 0).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("REDOES IN VOID ORDER, not in append order", () => {
    // The bug this class exists for. Deriving redo by scanning the stroke list
    // finds the stroke latest in APPEND order — so undo c, undo b, redo brought
    // back c and left b voided: a board no sequence of her actions could produce.
    const r = newRoll("roll_1");
    const h = new History();
    for (const id of ["a", "b", "c"]) addStroke(r, stroke({ id }));
    h.undo(r); // voids c
    h.undo(r); // voids b
    expect(h.redo(r)?.id).toBe("b");
    expect(h.redo(r)?.id).toBe("c");
    expect(pageStrokes(r, 0).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("clears the redo stack when she draws again", () => {
    // Otherwise: undo a stroke, write something else, press redo, and a stroke
    // from before the new one reappears UNDERNEATH it.
    const r = newRoll("roll_1");
    const h = new History();
    addStroke(r, stroke({ id: "a" }));
    h.undo(r);
    addStroke(r, stroke({ id: "b" }));
    h.clear();
    expect(h.redo(r)).toBeNull();
    expect(r.strokes.find((s) => s.id === "a")?.voided).toBe(true);
  });

  it("returns null when there is nothing left to undo or redo", () => {
    const r = newRoll("roll_1");
    const h = new History();
    expect(h.undo(r)).toBeNull();
    expect(h.redo(r)).toBeNull();
    addStroke(r, stroke());
    expect(h.undo(r)?.id).toBe("s1");
    expect(h.undo(r)).toBeNull();
  });

  it("reports how deep the redo stack is, for enabling the button", () => {
    const r = newRoll("roll_1");
    const h = new History();
    for (const id of ["a", "b"]) addStroke(r, stroke({ id }));
    expect(h.depth).toBe(0);
    h.undo(r);
    h.undo(r);
    expect(h.depth).toBe(2);
    h.redo(r);
    expect(h.depth).toBe(1);
  });

  it("redoes only on the page asked for", () => {
    const r = threePages();
    const h = new History();
    h.undo(r, 0);
    h.undo(r, 1);
    expect(h.redo(r, 0)?.id).toBe("s0");
    expect(r.strokes.find((s) => s.id === "s1")?.voided).toBe(true);
  });

  it("voidLast is the primitive History is built on", () => {
    const r = newRoll("roll_1");
    addStroke(r, stroke({ id: "a" }));
    expect(voidLast(r)?.id).toBe("a");
    expect(voidLast(r)).toBeNull();
  });
});

describe("serialisation", () => {
  it("round-trips a roll exactly", () => {
    const r = threePages();
    setBackground(r, 1, { kind: "question", generationId: "g1", questionId: "q3", prompt: "Why?", marks: 2 });
    new History().undo(r, 2);
    const parsed = deserialise(serialise(r));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.roll).toEqual(r);
  });

  it("is byte-identical across two serialisations — a Phase 1 gate", () => {
    const r = threePages();
    expect(serialise(r)).toBe(serialise(r));
    const again = deserialise(serialise(r));
    expect(again.ok).toBe(true);
    if (again.ok) expect(serialise(again.roll)).toBe(serialise(r));
  });

  it("omits `voided` when false so an untouched roll grows no field per stroke", () => {
    const r = newRoll("roll_1");
    addStroke(r, stroke());
    expect(serialise(r)).not.toContain("voided");
  });

  it("REFUSES an unknown version rather than reading it as version 1", () => {
    // A future writer is allowed to change what these fields mean. Guessing is
    // how that becomes silent corruption of a lesson's record.
    const r = newRoll("roll_1");
    const bumped = serialise(r).replace('"version":1', '"version":2');
    const out = deserialise(bumped);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("version");
  });

  it("refuses rather than half-loads, on every kind of damage", () => {
    // A roll that half-loads is worse than one that refuses: she can start a
    // fresh board in three seconds, but cannot tell that page 6 is quietly
    // missing half its annotations.
    const cases: [string, string][] = [
      ["not JSON", "{oh no"],
      ["not an object", "[]"],
      ["no pages", '{"version":1,"id":"r","pages":[],"strokes":[]}'],
      [
        "page 1 has index 5",
        '{"version":1,"id":"r","pages":[{"index":0,"background":{"kind":"blank"}},{"index":5,"background":{"kind":"blank"}}],"strokes":[]}',
      ],
      [
        "unreadable background",
        '{"version":1,"id":"r","pages":[{"index":0,"background":{"kind":"martian"}}],"strokes":[]}',
      ],
      [
        "truncated point list",
        '{"version":1,"id":"r","pages":[{"index":0,"background":{"kind":"blank"}}],"strokes":[{"id":"a","page":0,"tool":"pen","color":"#000","width":4,"pts":[1,2]}]}',
      ],
      [
        "non-finite coordinate",
        '{"version":1,"id":"r","pages":[{"index":0,"background":{"kind":"blank"}}],"strokes":[{"id":"a","page":0,"tool":"pen","color":"#000","width":4,"pts":[1,2,3,4,null,6]}]}',
      ],
      [
        "points at page 3",
        '{"version":1,"id":"r","pages":[{"index":0,"background":{"kind":"blank"}}],"strokes":[{"id":"a","page":3,"tool":"pen","color":"#000","width":4,"pts":[1,2,3]}]}',
      ],
      [
        "tool crayon",
        '{"version":1,"id":"r","pages":[{"index":0,"background":{"kind":"blank"}}],"strokes":[{"id":"a","page":0,"tool":"crayon","color":"#000","width":4,"pts":[1,2,3]}]}',
      ],
      [
        "width 0",
        '{"version":1,"id":"r","pages":[{"index":0,"background":{"kind":"blank"}}],"strokes":[{"id":"a","page":0,"tool":"pen","color":"#000","width":0,"pts":[1,2,3]}]}',
      ],
    ];
    for (const [why, json] of cases) {
      const out = deserialise(json);
      expect(out.ok, `${why} should have been refused`).toBe(false);
    }
  });

  it("survives a stroke list that is empty", () => {
    const out = deserialise(serialise(newRoll("roll_1")));
    expect(out.ok).toBe(true);
  });

  it("keeps float coordinates exact through the round trip", () => {
    // Ink is sub-pixel. A round trip that quantises is a round trip that moves
    // every stroke slightly, every time a lesson is reopened.
    const r = newRoll("roll_1");
    addStroke(r, stroke({ pts: [1234.5678901, 0.1 + 0.2, 0.3333333333333333] }));
    const out = deserialise(serialise(r));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.roll.strokes[0].pts).toEqual([1234.5678901, 0.1 + 0.2, 0.3333333333333333]);
  });
});

describe("projection", () => {
  it("fits a page into a 16:9 box with no letterboxing", () => {
    const p = fitPage(1600, 900);
    expect(p).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it("scales uniformly and centres rather than stretching", () => {
    // A distorted diagram is worse than a letterboxed one.
    const p = fitPage(1600, 1200); // taller than 16:9
    expect(p.scale).toBe(1);
    expect(p.offsetX).toBe(0);
    expect(p.offsetY).toBe(150);
  });

  it("letterboxes horizontally on a wide box", () => {
    const p = fitPage(2000, 900);
    expect(p.scale).toBe(1);
    expect(p.offsetX).toBe(200);
    expect(p.offsetY).toBe(0);
  });

  it("round-trips a point through screen and back", () => {
    const p = fitPage(1280, 800);
    for (const [x, y] of [[0, 0], [PAGE_W, PAGE_H], [123.4, 567.8]]) {
      const s = toScreen(x, y, p);
      const back = toPage(s.x, s.y, p);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it("puts the page's centre at the box's centre", () => {
    const p = fitPage(1000, 1000);
    const c = toScreen(PAGE_W / 2, PAGE_H / 2, p);
    expect(c.x).toBeCloseTo(500, 9);
    expect(c.y).toBeCloseTo(500, 9);
  });
});
