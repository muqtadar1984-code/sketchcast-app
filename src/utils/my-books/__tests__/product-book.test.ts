// SketchCast books as Library books (0175) — the bought book's chapters: every
// chapter with its final title and its ONE kit (masters owned by the book's
// own system owner only, newest done per kind, whole chapter), files signed
// with download names, Assign sources = the student pieces, "coming soon" when
// a chapter has no kit, and the loader's tolerance of 0175 not being applied.
// Run: node node_modules/vitest/vitest.mjs run src/utils/my-books/__tests__/product-book.test.ts
import { describe, expect, it } from "vitest";
import { fakeDb } from "@/sk/knowledge/__tests__/fake-db";
import { chapterKit, loadProductBooks, productChapters, type MasterKitRow, type ProductSystemBook } from "../product-book";
import { myBookTiles } from "../tiles";
import type { MyBook } from "../decide";

const SYSTEM = "0c0c0c0c-0000-4000-8000-00000000000c";
const TEACHER = "7e7e7e7e-0000-4000-8000-000000000007";
const PRODUCT = "161828e0-32aa-40df-bbf3-16eb32c82504";
const book: ProductSystemBook = {
  id: "b0000000-0000-4000-8000-000000000001",
  owner_id: SYSTEM,
  sk_product_id: PRODUCT,
  title: "Cells",
  chapters: [
    { num: 1, title: "Microscopes" },
    { num: 0, title: "Cells" },
    { num: 2, title: "Membranes" },
  ],
};

let n = 0;
const g = (kind: string, chapter_ref: string, over: Partial<MasterKitRow> = {}): MasterKitRow => ({
  id: `g${++n}`,
  kind,
  title: `Cells · ${kind}`,
  chapter_ref,
  status: "done",
  owner_id: SYSTEM,
  book_id: book.id,
  params: {},
  created_at: `2026-10-30T10:${String(n).padStart(2, "0")}:00Z`,
  artifacts: [],
  ...over,
});

const sign = async (path: string, download?: string) => `signed:${path}${download ? `#${download}` : ""}`;

describe("chapterKit", () => {
  it("one kit: the newest done whole-chapter generation per kind, lesson first, masters only", () => {
    const old = g("presentation", "0", { created_at: "2026-10-01T00:00:00Z" });
    const lesson = g("presentation", "0");
    const sheet = g("worksheet", "0");
    const masters = [
      sheet,
      old,
      lesson,
      g("presentation", "0", { status: "error" }),
      g("deck", "0", { params: { part: 2 } }), // a part kit is not the chapter's kit
      g("exam_paper", "0", { owner_id: TEACHER }), // a teacher's row against the product book is never a master
      g("activity", "0", { removed_at: "2026-10-30" }),
      g("lesson_plan", "1"),
    ];
    expect(chapterKit(book, masters, 0).map((x) => x.id)).toEqual([lesson.id, sheet.id]);
  });

  it("documents without their lesson are not a kit yet", () => {
    expect(chapterKit(book, [g("worksheet", "0")], 0)).toEqual([]);
  });
});

describe("productChapters", () => {
  it("lists EVERY chapter in order with its kit's signed files, or none yet", async () => {
    const lesson = g("presentation", "0", {
      artifacts: [
        { kind: "video_mp4", storage_path: "sys/a/lesson_part2.mp4" },
        { kind: "video_mp4", storage_path: "sys/a/lesson.mp4" },
        { kind: "script_json", storage_path: "sys/a/script.json" },
      ],
    });
    const deck = g("deck", "0", { artifacts: [{ kind: "deck_pptx", storage_path: "sys/d/deck.pptx" }] });
    const sheet = g("worksheet", "0", {
      artifacts: [
        { kind: "docx", storage_path: "sys/w/ws.docx" },
        { kind: "answer_key_docx", storage_path: "sys/w/key.docx" },
        { kind: "questions_json", storage_path: "sys/w/q.json" },
      ],
    });
    const plan = g("lesson_plan", "0", { artifacts: [{ kind: "docx", storage_path: "sys/p/plan.docx" }] });
    const out = await productChapters(book, [plan, sheet, deck, lesson], { sign, skHref: (ch) => `/sk/cells/${ch}` });
    expect(out.map((c) => [c.num, c.chapter, c.title, c.pieces.length, c.skHref])).toEqual([
      [0, 1, "Cells", 4, "/sk/cells/1"],
      [1, 2, "Microscopes", 0, "/sk/cells/2"],
      [2, 3, "Membranes", 0, "/sk/cells/3"],
    ]);
    const [c1] = out;
    expect(c1.pieces.map((p) => p.kind)).toEqual(["presentation", "deck", "lesson_plan", "worksheet"]);
    // videos in PART order, no download disposition (in-tab playback)
    expect(c1.pieces[0].files).toEqual([
      { label: "watch", part: 1, url: "signed:sys/a/lesson.mp4" },
      { label: "watch", part: 2, url: "signed:sys/a/lesson_part2.mp4" },
    ]);
    expect(c1.pieces[1].files).toEqual([{ label: "deck", part: null, url: "signed:sys/d/deck.pptx#Deck.pptx" }]);
    expect(c1.pieces[3].files.map((f) => f.label)).toEqual(["download", "answerKey"]); // never the questions json
    // Assign carries the student pieces only (never the teacher's plan); the Board takes the whole kit
    expect(c1.assignSources).toEqual([lesson.id, deck.id, sheet.id]);
    expect(c1.boardSources).toEqual([lesson.id, deck.id, plan.id, sheet.id]);
  });

  it("no SK gate → no per-chapter Open in SK", async () => {
    const out = await productChapters(book, [], { sign, skHref: () => null });
    expect(out.every((c) => c.skHref === null && c.pieces.length === 0)).toBe(true);
  });
});

describe("loadProductBooks", () => {
  it("reads the system books of these products and their masters only", async () => {
    const lesson = g("presentation", "0");
    const db = fakeDb({
      books: [book, { ...book, id: "other-book", sk_product_id: "other" }, { id: "upload", owner_id: TEACHER, sk_product_id: null, title: "Mine", chapters: [] }],
      generations: [lesson, g("worksheet", "0", { owner_id: TEACHER }), g("presentation", "0", { book_id: "other-book" })],
    });
    const out = await loadProductBooks(db, [PRODUCT]);
    expect([...out.keys()]).toEqual([PRODUCT]);
    expect(out.get(PRODUCT)!.book.id).toBe(book.id);
    expect(out.get(PRODUCT)!.masters.map((m) => m.id)).toEqual([lesson.id]);
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
    const deps = { sign: async () => null, skOpen: true, chapters: async () => (asked++, await productChapters(book, [], { sign, skHref: () => null })) };
    const [own] = await myBookTiles([mine], deps);
    expect(own.chapters).toHaveLength(3);
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
