// The Classroom Board's pickers (founder 2026-10-30: "my books or readymade
// kits are not showing up here on the board"): SketchCast books are marked
// for adopt-on-pick; ready-made kits list hers first, then every catalogue kit
// she can open (unlocked, or any on an unlimited tier), never one she already
// copied, never a capped tier's locked kit.
// Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/ready-made.test.ts
import { describe, expect, it } from "vitest";
import { boardBooks, boardKits, CATALOGUE_PICK, productChapterKits, type CatalogueOffer, type OwnKitRow } from "@/utils/present/ready-made";

describe("boardBooks", () => {
  it("marks SketchCast books (sk_product_id) and leaves uploaded books as they were", () => {
    const out = boardBooks([
      { id: "u", title: "My upload", grade: "5", subject: "Science", chapters: [{ num: 0, title: "One" }] },
      { id: "p", title: "Cells", chapters: [{ num: 0, title: "Cells" }], sk_product_id: "prod" },
      { id: "x", title: "No chapters", chapters: null, sk_product_id: null },
    ]);
    expect(out).toEqual([
      { id: "u", title: "My upload", grade: "5", subject: "Science", chapters: [{ num: 0, title: "One" }] },
      { id: "p", title: "Cells", grade: null, subject: null, chapters: [{ num: 0, title: "Cells" }], product: true, productKits: {} },
      { id: "x", title: "No chapters", grade: null, subject: null, chapters: [] },
    ]);
  });
});

describe("productChapterKits / boardBooks with the map", () => {
  const map = [
    { product_id: "prod", chapter_ref: "6", sort: 1, generation_id: "diff", label: "Diffusion in Living Cells" },
    { product_id: "prod", chapter_ref: "1", sort: 0, generation_id: "cells", label: "Cells" },
    { product_id: "prod", chapter_ref: "6", sort: 0, generation_id: "matter", label: "States of Matter" },
    { product_id: "prod", chapter_ref: "3", sort: 0, generation_id: "cells", label: "Cell Membranes" },
    { product_id: "prod", chapter_ref: "6", sort: 2, generation_id: "diff", label: "dup" },
    { product_id: "prod", chapter_ref: "x", sort: 0, generation_id: "bad", label: null },
    { product_id: "other", chapter_ref: "1", sort: 0, generation_id: "not-mine", label: null },
  ];

  it("release chapter N → the book's num N-1, kits in topic order, each once; a shared kit sits in every chapter that maps it", () => {
    expect(productChapterKits(map.filter((r) => r.product_id === "prod"))).toEqual({
      0: [{ id: "cells", label: "Cells" }],
      2: [{ id: "cells", label: "Cell Membranes" }],
      5: [
        { id: "matter", label: "States of Matter" },
        { id: "diff", label: "Diffusion in Living Cells" },
      ],
    });
  });

  it("a SketchCast book carries only its own product's kits; an uploaded book carries none", () => {
    const [up, prod] = boardBooks(
      [
        { id: "u", title: "Mine", chapters: [] },
        { id: "p", title: "Cells", chapters: [{ num: 0 }], sk_product_id: "prod" },
      ],
      map,
    );
    expect(up.productKits).toBeUndefined();
    expect(Object.values(prod.productKits ?? {}).flat().some((k) => k.id === "not-mine")).toBe(false);
    expect(prod.productKits?.[0]).toEqual([{ id: "cells", label: "Cells" }]);
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
