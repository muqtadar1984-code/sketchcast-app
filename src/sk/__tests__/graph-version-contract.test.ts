/**
 * Live fix 2026-10-27: sk_sessions.graph_version is CHECK (>= 1) (0157), so
 * a graph with version 0 opened fine but could never be stored — the student
 * saw "Could not open the session." at the first Play. The loader now refuses
 * such a graph up front, and every shipped graph must pass. The same holds
 * for `chapter` (CHECK >= 1 on sk_sessions, sk_book_units, teaching_objectives).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGraph } from "@/sk/graph";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../../public/sk-s1/${p}`, import.meta.url), "utf-8"));

describe("graph version matches the sk_sessions contract", () => {
  it("refuses version 0 and non-integers", () => {
    const g = read("graph-ch2.json");
    expect(() => parseGraph({ ...g, version: 0 }, "/sk-s1/")).toThrow(/bad version/);
    expect(() => parseGraph({ ...g, version: 1.5 }, "/sk-s1/")).toThrow(/bad version/);
    expect(() => parseGraph({ ...g, version: "x" }, "/sk-s1/")).toThrow(/bad version/);
  });
  it("refuses chapter 0 and non-integers the same way", () => {
    const g = read("ch02/graph.json");
    expect(() => parseGraph({ ...g, chapter: 0 }, "/sk-s1/ch02/")).toThrow(/bad chapter/);
    expect(() => parseGraph({ ...g, chapter: 2.5 }, "/sk-s1/ch02/")).toThrow(/bad chapter/);
    expect(() => parseGraph({ ...g, chapter: "two" }, "/sk-s1/ch02/")).toThrow(/bad chapter/);
  });
  it("every shipped graph has version >= 1 and chapter >= 1", () => {
    for (const p of ["graph-ch2.json", "ch02/graph.json"]) {
      const g = parseGraph(read(p), "/sk-s1/");
      expect(g.version).toBeGreaterThanOrEqual(1);
      expect(g.chapter).toBeGreaterThanOrEqual(1);
    }
  });
});
