import { describe, it, expect, beforeAll } from "vitest";
import {
  exportRoll,
  warmExport,
  parseHexColor,
  runToSvgPath,
  toolPaint,
  pdfPageCount,
  pdfPathCount,
  PDF_W,
  PDF_H,
  PDF_SCALE,
} from "../export-pdf";
import { strokeRuns } from "../ink";
import { newRoll, addPage, addStroke, PAGE_W, type Roll, type Stroke } from "../model";

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  id: "s1",
  page: 0,
  tool: "pen",
  color: "#14181F",
  width: 4,
  pts: [100, 100, 1, 300, 200, 0.8, 500, 120, 1.2],
  ...over,
});

function board(): Roll {
  const r = newRoll("roll_x");
  addPage(r);
  addStroke(r, stroke());
  addStroke(r, stroke({ id: "s2", page: 1, tool: "highlighter", color: "#F5D547", width: 26 }));
  return r;
}

describe("colour", () => {
  it("reads six-digit and three-digit hex", () => {
    expect(parseHexColor("#FFFFFF")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseHexColor("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHexColor("#fff")).toEqual({ r: 1, g: 1, b: 1 });
    const teal = parseHexColor("#0C8175");
    expect(teal.r).toBeCloseTo(12 / 255, 6);
    expect(teal.g).toBeCloseTo(129 / 255, 6);
    expect(teal.b).toBeCloseTo(117 / 255, 6);
  });

  it("falls back to black on anything it cannot parse", () => {
    // Visible and wrong beats invisible and wrong: a stroke that silently
    // exported as white would look like the export had lost it.
    for (const bad of ["", "nonsense", "rgb(1,2,3)", "#12345", "#gggggg"]) {
      expect(parseHexColor(bad)).toEqual({ r: 0, g: 0, b: 0 });
    }
  });

  it("works without the leading hash and ignores surrounding space", () => {
    expect(parseHexColor("  FFFFFF ")).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe("tools", () => {
  it("prints the eraser as paper, exactly as the screen does", () => {
    expect(toolPaint(stroke({ tool: "eraser", color: "#123456" }))).toEqual({
      color: { r: 1, g: 1, b: 1 },
      opacity: 1,
    });
  });

  it("prints the highlighter translucent in its own colour", () => {
    const p = toolPaint(stroke({ tool: "highlighter", color: "#F5D547" }));
    expect(p.opacity).toBeLessThan(1);
    expect(p.color.r).toBeGreaterThan(0.9);
  });

  it("prints a pen opaque", () => {
    expect(toolPaint(stroke()).opacity).toBe(1);
  });
});

describe("path data", () => {
  it("starts with a move and continues in cubics", () => {
    const [run] = strokeRuns(stroke(), 1);
    const d = runToSvgPath(run);
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain("C ");
  });

  it("rounds to two decimals so a float's last bit cannot change the bytes", () => {
    const [run] = strokeRuns(stroke({ pts: [0.123456789, 0.987654321, 1, 50, 50, 1] }), 1);
    const d = runToSvgPath(run);
    expect(d).not.toMatch(/\d\.\d{3,}/);
  });

  it("gives a lone point a hair of length, so a viewer actually draws it", () => {
    const [run] = strokeRuns(stroke({ pts: [40, 40, 1] }), 1);
    const d = runToSvgPath(run);
    expect(d).toContain("L ");
  });

  it("is deterministic", () => {
    const [run] = strokeRuns(stroke(), 1);
    expect(runToSvgPath(run)).toBe(runToSvgPath(run));
  });
});

describe("counts", () => {
  it("reports every page, empty ones included", () => {
    // The page numbers she said out loud have to match the file a student opens.
    const r = newRoll("r");
    addPage(r);
    addPage(r);
    expect(pdfPageCount(r)).toBe(3);
  });

  it("counts the vector paths an export will emit", () => {
    expect(pdfPathCount(board())).toBeGreaterThan(0);
  });

  it("ignores voided strokes in the path count", () => {
    const r = newRoll("r");
    addStroke(r, stroke());
    const withOne = pdfPathCount(r);
    r.strokes[0].voided = true;
    expect(pdfPathCount(r)).toBe(0);
    expect(withOne).toBeGreaterThan(0);
  });
});

describe("the document", () => {
  // The FIRST export pays for pdf-lib's dynamic import — seconds, cold. That is
  // a real cost a host should hide with warmExport(), and here it is simply paid
  // once up front so no single test is timed against a module load.
  beforeAll(async () => {
    await warmExport();
  }, 30000);

  it("emits a real PDF with one page per roll page", async () => {
    const bytes = await exportRoll(board());
    const head = new TextDecoder().decode(bytes.slice(0, 8));
    expect(head.startsWith("%PDF-")).toBe(true);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.match(/\/Type\s*\/Page[^s]/g)?.length).toBe(2);
  });

  it("IS BYTE-IDENTICAL ACROSS TWO EXPORTS — a Phase 1 gate", async () => {
    // PDF writers habitually stamp the current time into /CreationDate, which
    // would make every export of an unchanged board a different file.
    const r = board();
    const [a, b] = await Promise.all([exportRoll(r), exportRoll(r)]);
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("carries no wall-clock timestamp", async () => {
    const text = new TextDecoder("latin1").decode(await exportRoll(board()));
    const dates = text.match(/D:(\d{14})/g) ?? [];
    expect(dates.length).toBeGreaterThan(0);
    // Every date is the fixed epoch, so none of them is this year.
    const thisYear = String(new Date().getFullYear());
    for (const d of dates) expect(d).not.toContain(thisYear);
  });

  it("changes when the board changes", async () => {
    // The flip side of determinism: identical output must not mean the exporter
    // is ignoring its input.
    const r = board();
    const before = await exportRoll(r);
    addStroke(r, stroke({ id: "s3", pts: [10, 10, 1, 900, 700, 1] }));
    const after = await exportRoll(r);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(false);
  });

  it("exports an empty roll rather than failing", async () => {
    const bytes = await exportRoll(newRoll("empty"));
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("uses a 16:9 page so nothing is cropped or letterboxed", () => {
    expect(PDF_W / PDF_H).toBeCloseTo(PAGE_W / 900, 6);
    expect(PDF_SCALE).toBeCloseTo(PDF_W / PAGE_W, 9);
  });

  it("prints a page's text when the host supplies it", async () => {
    const r = newRoll("r");
    r.pages[0].background = {
      kind: "question",
      generationId: "g",
      questionId: "q",
      prompt: "Why does pressure rise with depth?",
    };
    const bytes = await exportRoll(r, {
      text: (bg) => (bg.kind === "question" ? bg.prompt : null),
    });
    expect(bytes.length).toBeGreaterThan(0);
  });
});
