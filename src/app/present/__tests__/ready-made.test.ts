// The Classroom Board's pickers (founder 2026-10-30: "my books or readymade
// kits are not showing up here on the board"): SketchCast books are marked
// for adopt-on-pick; ready-made kits list hers first, then every catalogue kit
// she can open (unlocked, or any on an unlimited tier), never one she already
// copied, never a capped tier's locked kit.
// Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/ready-made.test.ts
import { describe, expect, it } from "vitest";
import { boardBooks, boardKits, CATALOGUE_PICK, type CatalogueOffer, type OwnKitRow } from "@/utils/present/ready-made";

describe("boardBooks", () => {
  it("marks SketchCast books (sk_product_id) and leaves uploaded books as they were", () => {
    const out = boardBooks([
      { id: "u", title: "My upload", grade: "5", subject: "Science", chapters: [{ num: 0, title: "One" }] },
      { id: "p", title: "Cells", chapters: [{ num: 0, title: "Cells" }], sk_product_id: "prod" },
      { id: "x", title: "No chapters", chapters: null, sk_product_id: null },
    ]);
    expect(out).toEqual([
      { id: "u", title: "My upload", grade: "5", subject: "Science", chapters: [{ num: 0, title: "One" }] },
      { id: "p", title: "Cells", grade: null, subject: null, chapters: [{ num: 0, title: "Cells" }], product: true },
      { id: "x", title: "No chapters", grade: null, subject: null, chapters: [] },
    ]);
  });
});

describe("boardKits", () => {
  const own: OwnKitRow[] = [
    { id: "own-osmosis", title: "Osmosis · Osmosis", created_at: "2026-10-29", params: { catalogue_ref: { topic_id: "t-osm", source_generation_id: "m-osm" } } },
    { id: "own-cells", title: "Cells — Chapter 1: Cells · Cells", created_at: "2026-10-30", params: { product_ref: { product_id: "p" } } },
  ];
  const offers: CatalogueOffer[] = [
    { topicKitId: "k-osm-v2", topicId: "t-osm", presentationId: "m-osm-v2", title: "Osmosis · Osmosis" }, // already hers (older version)
    { topicKitId: "k-diff", topicId: "t-diff", presentationId: "m-diff", title: "Diffusion · Diffusion in Living Cells" },
    { topicKitId: "k-resp", topicId: "t-resp", presentationId: "m-resp", title: "Respiration · Respiration" },
    { topicKitId: "k-none", topicId: "t-none", presentationId: "m-none", title: null },
  ];

  it("hers first (newest first), then the catalogue kits she unlocked, adopt-on-pick", () => {
    const out = boardKits({ own, offers, unlocked: new Set(["t-diff", "t-osm"]), unlimited: false });
    expect(out).toEqual([
      { id: "own-cells", title: "Cells — Chapter 1: Cells" },
      { id: "own-osmosis", title: "Osmosis" },
      { id: `${CATALOGUE_PICK}k-diff`, title: "Diffusion", adopt: { catalogueKit: "k-diff" } },
    ]);
  });

  it("an unlimited tier is offered every current kit (unlocking is free there); a kit with no title is dropped", () => {
    const out = boardKits({ own: [], offers, unlocked: new Set(), unlimited: true });
    expect(out.map((k) => k.title)).toEqual(["Diffusion", "Osmosis", "Respiration"]);
    expect(out.every((k) => k.adopt)).toBe(true);
  });

  it("a capped tier's locked kit is never offered", () => {
    expect(boardKits({ own: [], offers, unlocked: new Set(), unlimited: false })).toEqual([]);
  });
});
