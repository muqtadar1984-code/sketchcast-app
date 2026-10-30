// SketchCast books as Library books (0175, reworked 2026-10-30) — the bought
// book's chapters: every chapter with its final title and its CATALOGUE kits
// (sk_product_kits, in topic order; a kit shared with an earlier chapter says
// so), the lesson's Watch = YouTube (storage only as a logged fallback), the
// documents signed with download names, Assign sources = the student pieces
// across the chapter's kits, the Board deep link, "coming soon" when a chapter
// has no kit, and the loader's tolerance of 0175 not being applied.
// Run: node node_modules/vitest/vitest.mjs run src/utils/my-books/__tests__/product-book.test.ts
import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/sk/knowledge/__tests__/fake-db";
import { boardHref, loadProductBooks, productChapters, type ProductBookData, type ProductSystemBook } from "../product-book";
import { myBookTiles } from "../tiles";
import type { MyBook } from "../decide";

const PRODUCT = "161828e0-32aa-40df-bbf3-16eb32c82504";
const book: ProductSystemBook = {
  id: "b0000000-0000-4000-8000-000000000001",
  sk_product_id: PRODUCT,
  title: "Cells",
  chapters: [
    { num: 1, title: "Microscopes" },
    { num: 0, title: "Cells" },
    { num: 2, title: "Membranes" },
    { num: 3, title: "Transport" },
  ],
};

const KIT_CELLS = "c0000001-0000-4000-8000-000000000000";
const KIT_BLOOD = "c0000002-0000-4000-8000-000000000000";
const KIT_RESP = "c0000003-0000-4000-8000-000000000000";
const piece = (id: string, kind: string, artifacts: { kind: string; storage_path: string }[] = [], over: Record<string, unknown> = {}) => ({
  id,
  kind,
  status: "done",
  removed_at: null,
  withdrawn_at: null,
  artifacts,
  ...over,
});

function data(over: Partial<ProductBookData> = {}): ProductBookData {
  return {
    book,
    map: [
      { product_id: PRODUCT, chapter_ref: "1", sort: 0, generation_id: "cells-lesson", label: "Cells" },
      { product_id: PRODUCT, chapter_ref: "3", sort: 0, generation_id: "cells-lesson", label: "Membranes" },
      { product_id: PRODUCT, chapter_ref: "4", sort: 1, generation_id: "resp-lesson", label: "The Human Respiratory System" },
      { product_id: PRODUCT, chapter_ref: "4", sort: 0, generation_id: "blood-lesson", label: "Blood and Its Components" },
      { product_id: "another", chapter_ref: "2", sort: 0, generation_id: "x-lesson", label: "not this book" },
    ],
    kits: [
      { id: KIT_CELLS, presentation_generation_id: "cells-lesson", doc_generation_ids: { worksheet: "cells-ws", lesson_plan: "cells-plan", deck: "cells-deck", case_study: "" } },
      { id: KIT_BLOOD, presentation_generation_id: "blood-lesson", doc_generation_ids: { activity: "blood-act" } },
      { id: KIT_RESP, presentation_generation_id: "resp-lesson", doc_generation_ids: {} },
    ],
    pieces: [
      piece("cells-lesson", "presentation", [
        { kind: "video_mp4", storage_path: "sys/c/lesson.mp4" },
        { kind: "script_json", storage_path: "sys/c/script.json" },
      ]),
      piece("cells-deck", "deck", [{ kind: "deck_pptx", storage_path: "sys/c/deck.pptx" }]),
      piece("cells-ws", "worksheet", [
        { kind: "docx", storage_path: "sys/c/ws.docx" },
        { kind: "answer_key_docx", storage_path: "sys/c/key.docx" },
        { kind: "questions_json", storage_path: "sys/c/q.json" },
      ]),
      piece("cells-plan", "lesson_plan", [{ kind: "docx", storage_path: "sys/c/plan.docx" }]),
      piece("blood-lesson", "presentation", [
        { kind: "video_mp4", storage_path: "sys/b/lesson.mp4" },
        { kind: "video_mp4", storage_path: "sys/b/lesson_part2.mp4" },
      ]),
      piece("blood-act", "activity", [{ kind: "docx", storage_path: "sys/b/act.docx" }], { removed_at: "2026-10-30" }),
      piece("resp-lesson", "presentation", [{ kind: "video_mp4", storage_path: "sys/r/lesson.mp4" }]),
    ],
    youtube: new Map([
      [KIT_CELLS, ["AAAAAAAAAA1"]],
      // blood has 2 stored parts but only part 1 on YouTube → storage (logged)
      [KIT_BLOOD, ["BBBBBBBBBB1"]],
      [KIT_RESP, ["RRRRRRRRRR1"]],
    ]),
    ...over,
  };
}

const sign = async (path: string, download?: string) => `signed:${path}${download ? `#${download}` : ""}`;

describe("productChapters", () => {
  it("lists EVERY chapter in order with its catalogue kits in topic order, or none yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await productChapters(data(), { sign, boardOn: true });
    warn.mockRestore();
    expect(out.map((c) => [c.num, c.chapter, c.title, c.kits.map((k) => k.lessonId)])).toEqual([
      [0, 1, "Cells", ["cells-lesson"]],
      [1, 2, "Microscopes", []],
      [2, 3, "Membranes", ["cells-lesson"]],
      [3, 4, "Transport", ["blood-lesson", "resp-lesson"]],
    ]);
  });

  it("the lesson's Watch is the YouTube link — never a signed MP4 — and documents are signed with download names", async () => {
    const out = await productChapters(data(), { sign, boardOn: true });
    const kit = out[0].kits[0];
    expect(kit.pieces.map((p) => p.kind)).toEqual(["presentation", "deck", "lesson_plan", "worksheet"]);
    expect(kit.pieces[0].files).toEqual([{ label: "watch", part: null, url: "https://www.youtube.com/watch?v=AAAAAAAAAA1", youtube: true }]);
    expect(kit.pieces[1].files).toEqual([{ label: "deck", part: null, url: "signed:sys/c/deck.pptx#Deck.pptx" }]);
    expect(kit.pieces[3].files.map((f) => f.label)).toEqual(["download", "answerKey"]); // never the questions json
  });

  it("no watchable YouTube video for every part → the stored MP4s in part order, and it is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await productChapters(data(), { sign, boardOn: true });
    const blood = out[3].kits[0];
    expect(blood.pieces[0].files).toEqual([
      { label: "watch", part: 1, url: "signed:sys/b/lesson.mp4" },
      { label: "watch", part: 2, url: "signed:sys/b/lesson_part2.mp4" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(KIT_BLOOD));
    warn.mockRestore();
    // the removed activity is not offered
    expect(blood.pieces.map((p) => p.kind)).toEqual(["presentation"]);
  });

  it("labels and sharing: the map's label, and a kit an earlier chapter maps says which", async () => {
    const out = await productChapters(data(), { sign, boardOn: true });
    expect(out[0].kits[0]).toMatchObject({ label: "Cells", sharedWith: null, topicKitId: KIT_CELLS });
    expect(out[2].kits[0]).toMatchObject({ label: "Membranes", sharedWith: 1 });
    expect(out[3].kits.map((k) => k.label)).toEqual(["Blood and Its Components", "The Human Respiratory System"]);
  });

  it("Assign = the student pieces across the chapter's kits (never the plan); the Board link only for a Board reader and a chapter with a kit", async () => {
    const out = await productChapters(data(), { sign, boardOn: true });
    expect(out[0].assignSources).toEqual(["cells-lesson", "cells-deck", "cells-ws"]);
    expect(out[3].assignSources).toEqual(["blood-lesson", "resp-lesson"]);
    expect(out[0].boardHref).toBe(`/present?book=${book.id}&chapter=0`);
    expect(out[3].boardHref).toBe(boardHref(book.id, 3));
    expect(out[1].boardHref).toBeNull(); // no kit, nothing to teach from
    const off = await productChapters(data(), { sign, boardOn: false });
    expect(off.every((c) => c.boardHref === null)).toBe(true);
  });

  it("a mapped lesson that is gone (withdrawn) or whose kit is unreadable is not offered", async () => {
    const d = data();
    d.pieces = d.pieces.map((p) => (p.id === "resp-lesson" ? { ...p, withdrawn_at: "2026-10-30" } : p));
    d.kits = d.kits.filter((k) => k.id !== KIT_CELLS);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await productChapters(d, { sign, boardOn: true });
    warn.mockRestore();
    expect(out[0].kits).toEqual([]);
    expect(out[3].kits.map((k) => k.lessonId)).toEqual(["blood-lesson"]);
  });
});

describe("loadProductBooks", () => {
  it("reads the system book, its map, the mapped APPROVED catalogue kits, their pieces and YouTube ids", async () => {
    const d = data();
    const db = fakeDb({
      books: [book, { ...book, id: "other-book", sk_product_id: "other" }, { id: "upload", sk_product_id: null, title: "Mine", chapters: [] }],
      sk_product_kits: d.map,
      topic_kits: [...d.kits.map((k) => ({ ...k, status: "approved" })), { id: "rejected", presentation_generation_id: "cells-lesson", doc_generation_ids: {}, status: "rejected" }],
      generations: d.pieces,
      topic_publications: [{ topic_kit_id: KIT_CELLS, part: 1, youtube_video_id: "AAAAAAAAAA1", privacy: "public", superseded_by: null }],
    });
    const out = await loadProductBooks(db, [PRODUCT]);
    expect([...out.keys()]).toEqual([PRODUCT]);
    const hit = out.get(PRODUCT)!;
    expect(hit.book.id).toBe(book.id);
    expect(hit.map.every((r) => r.product_id === PRODUCT)).toBe(true);
    expect(hit.kits.map((k) => k.id).sort()).toEqual([KIT_CELLS, KIT_BLOOD, KIT_RESP].sort());
    expect(hit.pieces.map((p) => p.id)).toContain("cells-ws");
    expect(hit.youtube.get(KIT_CELLS)).toEqual(["AAAAAAAAAA1"]);
  });

  it("0175 not applied → an empty map, no throw", async () => {
    const db = fakeDb({}, { missingColumns: ["books"] });
    expect((await loadProductBooks(db, [PRODUCT])).size).toBe(0);
  });
});

describe("myBookTiles with chapters", () => {
  const mine: MyBook = { productId: PRODUCT, slug: "cells", title: "Cells", language: "en", chapterCount: 3, releaseId: 3, coverKey: null, pdfKey: "k.pdf", forChildren: [], withdrawn: false };

  it("a book the reader holds gets its chapters; a child's book (parent view) does not", async () => {
    let asked = 0;
    const deps = { sign: async () => null, skOpen: true, chapters: async () => (asked++, await productChapters(data({ map: [] }), { sign, boardOn: false })) };
    const [own] = await myBookTiles([mine], deps);
    expect(own.chapters).toHaveLength(4);
    const [kid] = await myBookTiles([{ ...mine, forChildren: ["Aisyah"] }], deps);
    expect(kid.chapters).toBeNull();
    expect(asked).toBe(1);
  });

  it("no chapters loader, or a loader that fails → the plain tile", async () => {
    const [plain] = await myBookTiles([mine], { sign: async () => null, skOpen: false });
    expect(plain.chapters).toBeNull();
    const err = console.error;
    console.error = () => {};
    const [failed] = await myBookTiles([mine], { sign: async () => null, skOpen: false, chapters: async () => Promise.reject(new Error("boom")) });
    console.error = err;
    expect(failed.chapters).toBeNull();
  });
});
