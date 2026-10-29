/**
 * Board UX (2026-10-28): a blank page INSERTED after the current page — the
 * note between slide pages 3 and 4. Pages after it shift by one, the ink on
 * them goes with them (model.insertPage), the log follows the moved ink
 * (BoardStore.moveStroke + replay), and the PDF export walks the new order.
 * Run: node node_modules/vitest/vitest.mjs run src/board/__tests__/insert-page.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addPage, addStroke, insertPage, newRoll, pageStrokes, type PageBackground, type Roll, type Stroke } from "../model";
import { BoardStore, MemoryLog, replay, type LogRecord } from "../store";
import { exportRoll, warmExport } from "../export-pdf";

const stroke = (id: string, page: number): Stroke => ({ id, page, tool: "pen", color: "#14181F", width: 4, pts: [10, 10, 1, 20, 20, 1] });
const q = (name: string): PageBackground => ({ kind: "question", generationId: "g", questionId: name, prompt: name });

/** Five "slide" pages S1..S5, with one stroke on each of pages 2, 3 and 4. */
function slides(): Roll {
  const r = newRoll("r");
  r.pages[0].background = q("S1");
  for (let i = 2; i <= 5; i++) addPage(r, q(`S${i}`));
  addStroke(r, stroke("ink-on-S3", 2));
  addStroke(r, stroke("ink-on-S4", 3));
  addStroke(r, stroke("ink-on-S5", 4));
  return r;
}
const names = (r: Roll) => r.pages.map((p) => (p.background.kind === "question" ? p.background.prompt : p.background.kind));

describe("insertPage — a page in between", () => {
  it("inserts right after `after`; later pages shift by one and stay dense", () => {
    const r = slides();
    const { index } = insertPage(r, 2);
    expect(index).toBe(3);
    expect(names(r)).toEqual(["S1", "S2", "S3", "blank", "S4", "S5"]);
    expect(r.pages.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("STROKES STAY WITH THEIR PAGE: ink after the insert moves, ink before it does not", () => {
    const r = slides();
    const { movedStrokes } = insertPage(r, 2);
    expect(movedStrokes.map((s) => s.id)).toEqual(["ink-on-S4", "ink-on-S5"]);
    expect(pageStrokes(r, 2).map((s) => s.id)).toEqual(["ink-on-S3"]);
    expect(pageStrokes(r, 3)).toEqual([]); // the new blank page is clean
    expect(pageStrokes(r, 4).map((s) => s.id)).toEqual(["ink-on-S4"]);
    expect(pageStrokes(r, 5).map((s) => s.id)).toEqual(["ink-on-S5"]);
  });

  it("after the LAST page (or past it) is the plain append it always was", () => {
    const r = slides();
    expect(insertPage(r, 4)).toEqual({ index: 5, movedStrokes: [] });
    expect(insertPage(r, 99).index).toBe(6);
    expect(names(r)).toEqual(["S1", "S2", "S3", "S4", "S5", "blank", "blank"]);
    // A non-integer `after` is an append too, never a splice at NaN.
    expect(insertPage(r, Number.NaN).index).toBe(7);
  });

  it("before the first page clamps to right after page 0", () => {
    const r = slides();
    expect(insertPage(r, -3).index).toBe(1);
    expect(names(r).slice(0, 3)).toEqual(["S1", "blank", "S2"]);
  });

  it("takes a background", () => {
    const r = slides();
    insertPage(r, 0, q("note"));
    expect(names(r).slice(0, 3)).toEqual(["S1", "note", "S2"]);
  });
});

describe("the log follows the moved ink", () => {
  it("moveStroke re-records under the ORIGINAL seq; replay puts the ink on its new page, once", async () => {
    const log = new MemoryLog();
    const s = new BoardStore("r", { log });
    await s.open();
    const r = slides();
    for (const p of r.pages) await s.addPage(p.index, p.background);
    for (const st of r.strokes) await s.addStroke({ ...st });

    // The host's insert: the model renumbers, the shifted pages are reported at
    // their new indices, the moved ink is re-recorded.
    const { index, movedStrokes } = insertPage(r, 2);
    for (let i = index; i < r.pages.length; i++) await s.addPage(i, r.pages[i].background);
    for (const st of movedStrokes) await s.moveStroke(st);

    const records = await log.all();
    const seqs = records.filter((x): x is Extract<LogRecord, { kind: "stroke" }> => x.kind === "stroke").map((x) => x.seq);
    // Two re-records share their stroke's original seq (the server upserts on it).
    expect(new Set(seqs).size).toBe(3);

    const back = replay("r", records);
    expect(names(back)).toEqual(names(r));
    expect(back.strokes).toHaveLength(3);
    expect(pageStrokes(back, 2).map((x) => x.id)).toEqual(["ink-on-S3"]);
    expect(pageStrokes(back, 4).map((x) => x.id)).toEqual(["ink-on-S4"]);
    expect(pageStrokes(back, 5).map((x) => x.id)).toEqual(["ink-on-S5"]);
    // The undo order is the drawing order, not the move order.
    expect(back.strokes.map((x) => x.id)).toEqual(["ink-on-S3", "ink-on-S4", "ink-on-S5"]);
  });

  it("a stroke this store never numbered is recorded as new", async () => {
    const log = new MemoryLog();
    const s = new BoardStore("r", { log });
    await s.open();
    await s.moveStroke(stroke("foreign", 1));
    const recs = await log.all();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: "stroke", stroke: { id: "foreign", page: 1 } });
  });
});

describe("the roll PDF follows the new order", () => {
  beforeAll(async () => {
    await warmExport();
  }, 30000);

  it("pages print in roll order, the inserted page in between", async () => {
    const r = slides();
    insertPage(r, 2, q("note"));
    const order: string[] = [];
    const bytes = await exportRoll(r, {
      text: (bg) => {
        if (bg.kind === "question") order.push(bg.prompt);
        return null;
      },
    });
    expect(order).toEqual(["S1", "S2", "S3", "note", "S4", "S5"]);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.match(/\/Type\s*\/Page[^s]/g)?.length).toBe(6);
  });
});
