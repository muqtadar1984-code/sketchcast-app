// SketchCast books as Library books (0175) — the importer's product BOOK:
// one system-owned books row per product (uploaded-book chapter shape, 0-based
// nums), one chapter_grounding row per chapter (section text + exercise STEMS,
// never answers), updated in place by a newer final, caught up for a release
// imported before 0175, and skipped with a log line while 0175 is not applied.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/product-book.test.ts
import { describe, expect, it, vi } from "vitest";
import { pythonDumps, sha256Hex } from "../canonical-json";
import { importRelease, pollReleases, type BundleReader, type ReleaseRow } from "../release";
import { chapterSourceText, MIGRATION_0175_SKIP, NO_OWNER_SKIP, productBookChapters } from "../product-book";
import { fakeDb } from "./fake-db";

const OWNER = "0c0c0c0c-0000-4000-8000-00000000000c";
const SECRET = ["ANSWER-SEVEN-42", "SOLUTION-STEP-SUBTRACT-3", "MARK-POINT-SECRET", "OPTION-DISTRACTOR-Q", "BLIND-ANSWER-9"];

function chapter(n: number, variant = "") {
  const sections = [
    {
      sid: "s1",
      heading: `Section ${n}.1${variant}`,
      blocks: [
        { type: "paragraph", text: `Cells are the units of life (chapter ${n}${variant}).` },
        { type: "think", text: "What is inside a cell?", answer: SECRET[0] },
      ],
    },
  ];
  const exercises = [
    { xid: "x1", stem: `Name two organelles (ch ${n}).`, options: [SECRET[3]], answer: SECRET[0], marking_scheme: [{ point: SECRET[2] }], worked_solution: SECRET[1] },
  ];
  return {
    chapter: n,
    title: `Chapter ${n} title${variant}`,
    content_sha256: sha256Hex(pythonDumps({ sections, exercises })),
    approval: { kind: "book", id: 7, by: "founder@sketchcast.app", on: "2026-10-26" },
    review: { blind_answers: [SECRET[4]] },
    sections,
    exercises,
  };
}

function release(id: number, chapters = [1, 2, 3], variant = "") {
  const edition_key = `en-${id}`;
  const chs = chapters.map((n) => chapter(n, variant));
  const bundle = {
    schema: "sketchcast.book-release/1",
    release: { release_kind: "final", edition_key },
    work: { uid: "cells", slug: "cells-structure-function-organisation", title: "Cells: Structure, Function and Organisation", language: "en" },
    chapters: chs,
  };
  const text = JSON.stringify(bundle);
  const key = `books/cells/editions/${edition_key}/bundle.json`;
  const row: ReleaseRow = {
    id,
    work_uid: "cells",
    slug: "cells-structure-function-organisation",
    release_kind: "final",
    edition_key,
    language: "en",
    revision_key: "r4",
    title: "Cells: Structure, Function and Organisation",
    subject: "Biology",
    grade_band: "Year 7",
    chapters: chs.map((c) => ({ chapter: c.chapter, title: c.title, content_sha256: c.content_sha256, approval_id: 7, approval_kind: "book", gate_d_approval_id: null })),
    chapter_count: chs.length,
    bundle_key: key,
    bundle_sha256: sha256Hex(Buffer.from(text, "utf8")),
    superseded_by: null,
    withdrawn_at: null,
  };
  return { row, text, key, chapters: chs };
}

const s3 = (...rs: { key: string; text: string }[]): BundleReader => ({
  async getBytes(k: string) {
    const r = rs.find((x) => x.key === k);
    if (!r) throw new Error(`NoSuchKey ${k}`);
    return new Uint8Array(Buffer.from(r.text, "utf8"));
  },
});

describe("productBookChapters / chapterSourceText", () => {
  it("chapters are the uploaded-book shape with 0-based nums, in order", () => {
    const r = release(3, [2, 1, 3]);
    expect(productBookChapters(r.chapters)).toEqual([
      { num: 0, title: "Chapter 1 title" },
      { num: 1, title: "Chapter 2 title" },
      { num: 2, title: "Chapter 3 title" },
    ]);
  });

  it("source text = section headings + text + numbered exercise STEMS; no answer, solution, mark point, option or blind answer", () => {
    const text = chapterSourceText(release(3).chapters[0]);
    expect(text).toContain("## Section 1.1");
    expect(text).toContain("Cells are the units of life (chapter 1).");
    expect(text).toContain("## Exercises\n\n1. Name two organelles (ch 1).");
    for (const s of SECRET) expect(text).not.toContain(s);
  });
});

describe("importRelease writes the product book", () => {
  it("a final creates ONE system-owned book + one grounding row per chapter", async () => {
    const r = release(3);
    const db = fakeDb({ books: [], chapter_grounding: [] });
    const out = await importRelease(db, s3(r), r.row, { bookOwnerId: OWNER });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.book).toMatchObject({ status: "created", chapters: 3 });
    const [book] = db.tables.books;
    expect(db.tables.books).toHaveLength(1);
    expect(book).toMatchObject({
      owner_id: OWNER,
      sk_product_id: out.product_id,
      sk_release_id: 3,
      school_id: null,
      title: "Cells: Structure, Function and Organisation",
      language: "en",
      subject: "Biology",
      grade: "Year 7",
      status: "ready",
      chapters: [
        { num: 0, title: "Chapter 1 title" },
        { num: 1, title: "Chapter 2 title" },
        { num: 2, title: "Chapter 3 title" },
      ],
    });
    expect(book.storage_path).toBeUndefined(); // no PDF: 0175's WHEN clause keeps indexing away
    const g = db.tables.chapter_grounding;
    expect(g.map((x) => x.chapter_num).sort()).toEqual([0, 1, 2]);
    expect(g.every((x) => x.book_id === book.id)).toBe(true);
    const all = JSON.stringify(g);
    for (const s of SECRET) expect(all).not.toContain(s);
  });

  it("a newer final updates the same book in place, drops a removed chapter and the stale concept cache", async () => {
    const first = release(3);
    const db = fakeDb({ books: [], chapter_grounding: [] });
    await importRelease(db, s3(first), first.row, { bookOwnerId: OWNER });
    const bookId = db.tables.books[0].id;
    // the worker cached a concept analysis for chapter 1 (num 0)
    db.tables.chapter_grounding.find((x) => x.chapter_num === 0)!.concepts = { cached: true };
    db.tables.chapter_grounding.find((x) => x.chapter_num === 1)!.concepts = { cached: true };

    const next = release(4, [1, 2], " (rev)");
    // chapter 2's text is unchanged in the new final except its title variant; make it truly identical
    next.chapters[1] = { ...first.chapters[1], title: "Chapter 2 title" };
    const fixed = { ...JSON.parse(next.text), chapters: next.chapters };
    const text = JSON.stringify(fixed);
    const row = { ...next.row, chapters: next.chapters.map((c) => ({ chapter: c.chapter, title: c.title, content_sha256: c.content_sha256, approval_id: 7, approval_kind: "book" as const, gate_d_approval_id: null })), bundle_sha256: sha256Hex(Buffer.from(text, "utf8")) };
    const out = await importRelease(db, s3({ key: next.key, text }), row, { bookOwnerId: OWNER });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.book).toMatchObject({ status: "updated", book_id: bookId, chapters: 2 });
    expect(db.tables.books).toHaveLength(1);
    expect(db.tables.books[0]).toMatchObject({ id: bookId, sk_release_id: 4, chapters: [{ num: 0, title: "Chapter 1 title (rev)" }, { num: 1, title: "Chapter 2 title" }] });
    const g = db.tables.chapter_grounding;
    expect(g.map((x) => x.chapter_num).sort()).toEqual([0, 1]); // chapter 3 removed
    expect(g.find((x) => x.chapter_num === 0)!.concepts).toBeNull(); // text changed → cache dropped
    expect(g.find((x) => x.chapter_num === 1)!.concepts).toEqual({ cached: true }); // unchanged text keeps it
  });

  it("a release imported BEFORE 0175 gets its book on the next run, without re-writing its blocks", async () => {
    const r = release(3);
    const db = fakeDb({ books: [], chapter_grounding: [] }, { missingColumns: ["books"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await importRelease(db, s3(r), r.row, { bookOwnerId: OWNER });
    expect(first.status === "ok" && first.book).toEqual({ status: "skipped", reason: MIGRATION_0175_SKIP });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const replaces = db.calls.filter((c) => c.rpc === "sk_knowledge_replace").length;

    // 0175 applied: the same fake, now with the columns
    const after = fakeDb({ ...db.tables, books: [], chapter_grounding: [] });
    after.blocks.push(...db.blocks);
    const again = await importRelease(after, s3(r), r.row, { bookOwnerId: OWNER });
    expect(again).toMatchObject({ status: "ok", bookOnly: true, blocks: 0, book: { status: "created", chapters: 3 } });
    expect(after.calls.filter((c) => c.rpc === "sk_knowledge_replace")).toHaveLength(0);
    expect(replaces).toBe(1);

    // and a third run is a plain skip
    expect(await importRelease(after, s3(r), r.row, { bookOwnerId: OWNER })).toMatchObject({ status: "skipped", reason: "already imported" });
  });

  it("no CATALOGUE_OWNER_ID: the import succeeds, the book is skipped, and an imported release is not re-fetched for it", async () => {
    const r = release(3);
    const db = fakeDb({ books: [], chapter_grounding: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await importRelease(db, s3(r), r.row, { bookOwnerId: null });
    warn.mockRestore();
    expect(out.status === "ok" && out.book).toEqual({ status: "skipped", reason: NO_OWNER_SKIP });
    expect(db.tables.books).toHaveLength(0);
    expect(await importRelease(db, s3(r), r.row, { bookOwnerId: null })).toMatchObject({ status: "skipped", reason: "already imported" });
  });

  it("a dry run reports the book it would write and writes nothing", async () => {
    const r = release(3);
    const db = fakeDb({ books: [], chapter_grounding: [], sk_book_products: [{ id: "p1", slug: "cells-structure-function-organisation", status: "approved", work_uid: "cells", language: "en", release_id: null, release_kind: null }] });
    const out = await importRelease(db, s3(r), r.row, { dryRun: true, bookOwnerId: OWNER });
    expect(out).toMatchObject({ status: "ok", product_id: "p1", book: { status: "created", book_id: "(new)", chapters: 3 } });
    expect(db.tables.books).toHaveLength(0);
    expect(db.tables.chapter_grounding).toHaveLength(0);
  });
});

describe("pollReleases and the product book", () => {
  it("an imported release whose book is missing is not 'unchanged': the poll catches the book up", async () => {
    const r = release(3);
    const db = fakeDb({ books: [], chapter_grounding: [], pub_releases: [r.row] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importRelease(db, s3(r), r.row, { bookOwnerId: null }); // imported without a book
    warn.mockRestore();
    const res = await pollReleases(db, { s3: s3(r), bookOwnerId: OWNER });
    expect(res).toMatchObject({ status: "ok", imported: [3], unchanged: [] });
    expect(db.tables.books).toHaveLength(1);
    const again = await pollReleases(db, { s3: s3(r), bookOwnerId: OWNER });
    expect(again).toMatchObject({ status: "ok", imported: [], unchanged: [3] });
  });

  it("0175 not applied: the poll treats the book as current (no daily re-fetch)", async () => {
    const r = release(3);
    const db = fakeDb({ chapter_grounding: [], pub_releases: [r.row] }, { missingColumns: ["books"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await importRelease(db, s3(r), r.row, { bookOwnerId: OWNER });
    warn.mockRestore();
    expect(await pollReleases(db, { s3: s3(r), bookOwnerId: OWNER })).toMatchObject({ status: "ok", imported: [], unchanged: [3] });
  });
});
