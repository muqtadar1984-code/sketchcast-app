/**
 * Live fix 2026-10-27: the stand-in chapter (string item ids, string
 * objective) cannot grade on the Supabase store — item_attempts.item_id is a
 * uuid FK — so on that store only graphs whose product the database knows are
 * served. The in-memory store (dev) serves every loaded graph.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/graphs-for-store.test.ts
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseGraph } from "@/sk/graph";
import { graphsForStore } from "@/sk/server";

const read = (p: string) => parseGraph(JSON.parse(readFileSync(new URL(`../../../public/sk-s1/${p}`, import.meta.url), "utf-8")), "/sk-s1/");

describe("graphsForStore", () => {
  const standin = read("graph-ch2.json");
  const packaged = read("ch02/graph.json");
  it("withholds the stand-in on the Supabase store, keeps the packaged chapter, and logs why", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = graphsForStore([standin, packaged], new Set([packaged.product_id]));
    expect(out.map((g) => g.product_id)).toEqual([packaged.product_id]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining(`product ${standin.product_id} is not in sk_book_products`));
    err.mockRestore();
  });
  it("serves everything on the in-memory store (no product list)", () => {
    expect(graphsForStore([standin, packaged], null)).toHaveLength(2);
  });
  it("the two shipped graphs differ exactly as assumed: only the stand-in uses string item ids", () => {
    const ids = (g: typeof standin) => g.units.flatMap((u) => u.assets.flatMap((a) => a.item_ids ?? []));
    expect(ids(standin).every((id) => !/^[0-9a-f-]{36}$/i.test(id))).toBe(true);
    expect(ids(packaged)).toEqual([]); // packaged checks come from the bank (B4.1)
  });
});
