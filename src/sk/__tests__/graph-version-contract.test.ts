/**
 * Live fix 2026-10-27: sk_sessions.graph_version is CHECK (>= 1) (0157), so
 * a graph with version 0 opened fine but could never be stored — the student
 * saw "Could not open the session." at the first Play. The loader now refuses
 * such a graph up front, and the fixture graphs (inline since S3 slice E
 * retired the shipped files) must pass. The same holds
 * for `chapter` (CHECK >= 1 on sk_sessions, sk_book_units, teaching_objectives).
 */
import { describe, expect, it } from "vitest";
import { parseGraph } from "@/sk/graph";
import { CELLS_BASE, CELLS_GRAPH_JSON, STANDIN_GRAPH_JSON } from "./fixtures";

const read = (g: object) => JSON.parse(JSON.stringify(g));

describe("graph version matches the sk_sessions contract", () => {
  it("refuses version 0 and non-integers", () => {
    const g = read(STANDIN_GRAPH_JSON);
    expect(() => parseGraph({ ...g, version: 0 }, "/lessons/")).toThrow(/bad version/);
    expect(() => parseGraph({ ...g, version: 1.5 }, "/lessons/")).toThrow(/bad version/);
    expect(() => parseGraph({ ...g, version: "x" }, "/lessons/")).toThrow(/bad version/);
  });
  it("refuses chapter 0 and non-integers the same way", () => {
    const g = read(CELLS_GRAPH_JSON);
    expect(() => parseGraph({ ...g, chapter: 0 }, CELLS_BASE)).toThrow(/bad chapter/);
    expect(() => parseGraph({ ...g, chapter: 2.5 }, CELLS_BASE)).toThrow(/bad chapter/);
    expect(() => parseGraph({ ...g, chapter: "two" }, CELLS_BASE)).toThrow(/bad chapter/);
  });
  it("the fixture graphs have version >= 1 and chapter >= 1", () => {
    for (const raw of [STANDIN_GRAPH_JSON, CELLS_GRAPH_JSON]) {
      const g = parseGraph(read(raw), CELLS_BASE);
      expect(g.version).toBeGreaterThanOrEqual(1);
      expect(g.chapter).toBeGreaterThanOrEqual(1);
    }
  });
});
