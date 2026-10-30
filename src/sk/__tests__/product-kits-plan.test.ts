// SketchCast books as Library books — the planning behind
// scripts/sk-product-kits.ts: one full single-part kit per chapter, owned by
// the system account, the cost estimate, the production guards, and the SK
// map replacement (one row per chapter, release chapter numbers, final titles).
// Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/product-kits-plan.test.ts
import { describe, expect, it } from "vitest";
import { DOC_KINDS } from "@/app/dashboard/kit";
import {
  KIT_COST_USD,
  busyJobs,
  chapterState,
  kitOutcome,
  offPeak,
  planProductKitMap,
  planProductKits,
  staleMapRows,
  type MasterGen,
  type ProductBookRow,
} from "../product-kits-plan";

const OWNER = "0c0c0c0c-0000-4000-8000-00000000000c";
const PRODUCT = "161828e0-32aa-40df-bbf3-16eb32c82504";
const book: ProductBookRow = {
  id: "b0000000-0000-4000-8000-000000000001",
  title: "Cells",
  owner_id: OWNER,
  sk_product_id: PRODUCT,
  storage_path: null,
  chapters: [
    { num: 2, title: "Cell membranes" },
    { num: 0, title: "Cells" },
    { num: 1, title: "Microscopes" },
  ],
};
let seq = 0;
const gen = (chapter_ref: string, status: string, over: Partial<MasterGen> = {}): MasterGen => ({
  id: `g-${++seq}`,
  kind: "presentation",
  chapter_ref,
  status,
  params: {},
  created_at: `2026-10-30T0${seq % 10}:00:00Z`,
  ...over,
});

describe("planProductKits", () => {
  it("one FULL kit per missing chapter: the Library's seven rows, owned by the system account, whole chapter, single part", () => {
    const plan = planProductKits({ book, ownerId: OWNER, masters: [], workerReady: true });
    expect(plan.chapters.map((c) => [c.num, c.chapter, c.title, c.state])).toEqual([
      [0, 1, "Cells", "missing"],
      [1, 2, "Microscopes", "missing"],
      [2, 3, "Cell membranes", "missing"],
    ]);
    expect(plan.toQueue).toHaveLength(3);
    const rows = plan.toQueue[0].rows;
    expect(rows.map((r) => r.kind)).toEqual(["presentation", ...DOC_KINDS]); // lesson FIRST (the docs-ride guard)
    for (const r of rows) {
      expect(r).toMatchObject({ book_id: book.id, owner_id: OWNER, school_id: null, chapter_ref: "0", status: "queued" });
      expect(r.params.part).toBeUndefined();
      expect(r.params.single_part).toBe(true);
      expect(r.params.sk_product).toEqual({ product_id: PRODUCT });
      expect(r.params.catalogue).toBeUndefined(); // never the catalogue path
    }
    expect(plan.blockers).toEqual([]);
  });

  it("estimates the cost per kit and in total from KIT_COST_USD", () => {
    const plan = planProductKits({ book, ownerId: OWNER, masters: [gen("0", "done")], workerReady: true });
    expect(plan.cost).toEqual({ perKit: KIT_COST_USD, kits: 2, low: 2 * KIT_COST_USD.low, point: 2 * KIT_COST_USD.point, high: 2 * KIT_COST_USD.high });
    expect(KIT_COST_USD.low).toBeGreaterThanOrEqual(1.5);
    expect(KIT_COST_USD.high).toBeLessThanOrEqual(2.5);
  });

  it("done chapters are skipped, failed ones re-queued, running ones block --apply", () => {
    const masters = [gen("0", "done"), gen("1", "error"), gen("2", "processing", { kind: "worksheet" })];
    const plan = planProductKits({ book, ownerId: OWNER, masters, workerReady: true });
    expect(plan.chapters.map((c) => c.state)).toEqual(["done", "failed", "in_progress"]);
    expect(plan.toQueue.map((c) => c.chapter)).toEqual([2]);
    expect(plan.blockers).toEqual(["a chapter's kit is still being made; wait for it"]);
  });

  it("refuses --apply for a PDF-less book until the worker is ready, and for a book that is not the system account's", () => {
    expect(planProductKits({ book, ownerId: OWNER, masters: [], workerReady: false }).blockers[0]).toMatch(/worker cannot build a PDF-less product book/);
    expect(planProductKits({ book, ownerId: "someone-else", masters: [], workerReady: true }).blockers[0]).toMatch(/not CATALOGUE_OWNER_ID/);
    expect(planProductKits({ book: { ...book, chapters: [] }, ownerId: OWNER, masters: [], workerReady: true }).blockers).toContain(
      "the product book has no chapters (re-import the release)",
    );
  });

  it("a part kit, a removed or withdrawn row is not the chapter's kit", () => {
    expect(chapterState([gen("0", "done", { params: { part: 1 } })], 0).state).toBe("missing");
    expect(chapterState([gen("0", "done", { removed_at: "2026-10-30" })], 0).state).toBe("missing");
    expect(chapterState([gen("0", "done", { withdrawn_at: "2026-10-30" })], 0).state).toBe("missing");
  });
});

describe("production guards", () => {
  it("busyJobs counts queued and processing jobs only", () => {
    expect(busyJobs([{ status: "done" }, { status: "error" }])).toBe(0);
    expect(busyJobs([{ status: "queued" }, { status: "processing" }, { status: "done" }])).toBe(2);
  });

  it("offPeak is 20:00–05:00 UTC", () => {
    expect(offPeak(new Date("2026-10-30T20:00:00Z"))).toBe(true);
    expect(offPeak(new Date("2026-10-30T04:59:00Z"))).toBe(true);
    expect(offPeak(new Date("2026-10-30T05:00:00Z"))).toBe(false);
    expect(offPeak(new Date("2026-10-30T12:00:00Z"))).toBe(false);
  });

  it("kitOutcome waits for every row, and fails on the lesson", () => {
    expect(kitOutcome([{ kind: "presentation", status: "done" }, { kind: "deck", status: "queued" }])).toBe("running");
    expect(kitOutcome([{ kind: "presentation", status: "done" }, { kind: "deck", status: "error" }])).toBe("done");
    expect(kitOutcome([{ kind: "presentation", status: "error" }, { kind: "deck", status: "done" }])).toBe("failed");
  });
});

describe("planProductKitMap", () => {
  const current = [
    { product_id: PRODUCT, chapter_ref: "8", sort: 1, generation_id: "old-resp", label: "The Human Respiratory System" },
    { product_id: PRODUCT, chapter_ref: "1", sort: 0, generation_id: "old-cells", label: "Cells" },
    { product_id: "other", chapter_ref: "1", sort: 0, generation_id: "x", label: null },
  ];

  it("REPLACES the product's map: one row per chapter, release chapter numbers, the newest done kit, the final title", () => {
    const older = gen("0", "done", { created_at: "2026-10-01T00:00:00Z" });
    const newer = gen("0", "done", { created_at: "2026-10-30T00:00:00Z" });
    const plan = planProductKitMap({ book, masters: [older, newer, gen("1", "done"), gen("2", "done")], current });
    expect(plan.after).toEqual([
      { product_id: PRODUCT, chapter_ref: "1", sort: 0, generation_id: newer.id, label: "Cells" },
      { product_id: PRODUCT, chapter_ref: "2", sort: 0, generation_id: expect.any(String), label: "Microscopes" },
      { product_id: PRODUCT, chapter_ref: "3", sort: 0, generation_id: expect.any(String), label: "Cell membranes" },
    ]);
    expect(plan.missing).toEqual([]);
    expect(plan.before.map((r) => r.generation_id)).toEqual(["old-cells", "old-resp"]); // only this product, chapter order
    expect(staleMapRows(plan).map((r) => r.generation_id)).toEqual(["old-cells", "old-resp"]);
  });

  it("lists chapters without a done kit as missing (the script refuses to map until there are none)", () => {
    const plan = planProductKitMap({ book, masters: [gen("0", "done"), gen("1", "error")], current: [] });
    expect(plan.after.map((r) => r.chapter_ref)).toEqual(["1"]);
    expect(plan.missing).toEqual([
      { chapter: 2, title: "Microscopes" },
      { chapter: 3, title: "Cell membranes" },
    ]);
  });

  it("a row already in the new map is kept, not deleted and re-made", () => {
    const k = gen("0", "done");
    const plan = planProductKitMap({ book, masters: [k], current: [{ product_id: PRODUCT, chapter_ref: "1", sort: 0, generation_id: k.id, label: "old label" }] });
    expect(staleMapRows(plan)).toEqual([]);
  });
});
