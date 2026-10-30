// SK S7 K1 — the article and upload importers on an in-memory fake:
// current-version selection, superseded versions pruned, idempotency; uploads
// split ≤ 1200, junk-gated (unconfirmed) and removed books skipped and cleared,
// language from books.language else detected per chapter (never written to
// books), batching / resume, dry runs write nothing.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/articles-uploads.test.ts
import { describe, expect, it } from "vitest";
import { articleBlocks, currentArticleIds, importArticles } from "../articles";
import { bookExcluded, importUserBooks } from "../user-books";
import { fakeDb } from "./fake-db";

const article = (id: string, topic: string, version: number, status = "approved", language = "en") => ({
  id,
  topic_id: topic,
  version,
  language,
  status,
  title: `Angles v${version}`,
  updated_at: `2026-10-${10 + version}T00:00:00Z`,
  sections: [
    { id: "s1", heading: "Parallel lines", body_md: "**Parallel** lines never meet.", covers: [] },
    { id: "s2", heading: "Transversals", body_md: "A transversal crosses two lines.\n\nEight angles appear." },
  ],
  glossary: [{ term: "Transversal", definition: "A line crossing two others." }],
  misconceptions: [{ id: "m1", misconception: "Co-interior angles are equal.", correction: "They add to 180 degrees." }],
  worked_examples: [{ id: "w1", problem: "Angle AGH is 65. Find x.", solution_md: "1. Alternate angles.\n2. x = 65." }],
});

describe("articleBlocks", () => {
  it("one block per section, glossary entry, misconception and worked example", () => {
    const blocks = articleBlocks(article("a1", "t1", 2, "approved", "ms-arab"));
    expect(blocks.map((b) => `${b.kind}:${b.anchor}`)).toEqual(["section:s1", "section:s2", "glossary:g1", "misconception:m1", "worked_example:w1"]);
    expect(blocks.every((b) => b.source_kind === "article" && b.source_id === "a1" && b.version === "2" && b.chapter === null && b.language === "ms-arab")).toBe(true);
    expect(blocks[0]).toMatchObject({ title: "Parallel lines", text: "Parallel lines never meet." });
    expect(blocks[2].text).toBe("Transversal: A line crossing two others.");
    expect(blocks[3].text).toBe("Common mistake: Co-interior angles are equal. Correct idea: They add to 180 degrees.");
  });
  it("picks the newest approved version per (topic, language)", () => {
    const ids = currentArticleIds([
      { id: "a1", topic_id: "t1", language: "en", version: 1 },
      { id: "a2", topic_id: "t1", language: "en", version: 2 },
      { id: "a3", topic_id: "t1", language: "ar", version: 1 },
    ]);
    expect([...ids].sort()).toEqual(["a2", "a3"]);
  });
});

describe("importArticles", () => {
  it("imports the current versions, prunes superseded ones, and is idempotent", async () => {
    const db = fakeDb({ topic_articles: [article("a1", "t1", 1), article("a2", "t1", 2), article("a3", "t2", 1, "rejected"), article("a4", "t3", 1, "approved", "ar")] });
    // an old version imported earlier
    db.blocks.push({ ...articleBlocks(article("a1", "t1", 1))[0], id: 1, created_at: "2026-10-01" });
    const r = await importArticles(db, { batch: 1 });
    expect(r).toMatchObject({ current: 2, imported: 2, upToDate: 0, blocks: 10, pruned: { articles: 1, user_books: 0 } });
    expect(new Set(db.blocks.map((b) => b.source_id))).toEqual(new Set(["a2", "a4"]));
    expect(db.calls.filter((c) => c.rpc === "sk_knowledge_replace")).toHaveLength(2); // one transaction per batch

    const again = await importArticles(db);
    expect(again).toMatchObject({ imported: 0, upToDate: 2, blocks: 0 });
    expect(db.blocks).toHaveLength(10);
  });
  it("a dry run writes nothing", async () => {
    const db = fakeDb({ topic_articles: [article("a2", "t1", 2)] });
    const r = await importArticles(db, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, imported: 1, blocks: 5, pruned: null });
    expect(db.calls.map((c) => c.rpc)).toEqual(["sk_knowledge_versions"]);
    expect(db.blocks).toEqual([]);
  });
});

const longText = (sentence: string, n: number) => Array.from({ length: n }, () => sentence).join(" ");

function uploads() {
  return {
    books: [
      { id: "b-en", language: "en", content_hash: "hash-en", removed_at: null, health: { gate: "none" } },
      { id: "b-null-ar", language: null, content_hash: null, removed_at: null, health: null },
      { id: "b-junk", language: "en", content_hash: "hash-j", removed_at: null, health: { gate: "confirm", facts: { doc_type: "administrative" } } },
      { id: "b-junk-ok", language: "fr", content_hash: "hash-k", removed_at: null, health: { gate: "confirm" } },
      { id: "b-removed", language: "en", content_hash: "hash-r", removed_at: "2026-10-01T00:00:00Z", health: null },
    ],
    generations: [{ id: "g1", book_id: "b-junk-ok", params: { junk_gate: { confirmed_at: "2026-10-02" } } }, { id: "g2", book_id: "b-junk", params: {} }],
    chapter_grounding: [
      { book_id: "b-en", chapter_num: 1, chapter_title: "Cells", updated_at: "2026-10-01T00:00:00Z", source_text: longText("The cell membrane controls what enters the cell.", 60) },
      { book_id: "b-en", chapter_num: 2, chapter_title: "Tissues", updated_at: "2026-10-01T00:00:00Z", source_text: "Tissues are groups of cells.\n\nOrgans are groups of tissues." },
      { book_id: "b-null-ar", chapter_num: 1, chapter_title: "الفصل الثالث", updated_at: "2026-10-05T00:00:00Z", source_text: "التيار الكهربائي\nهو حركة الشحنات الكهربائية.\n\nElectric current" },
      { book_id: "b-junk", chapter_num: 1, chapter_title: "Roster", updated_at: "2026-10-01T00:00:00Z", source_text: "Name Class Mark" },
      { book_id: "b-junk-ok", chapter_num: 1, chapter_title: "Chapitre", updated_at: "2026-10-01T00:00:00Z", source_text: "Les plantes produisent du glucose." },
      { book_id: "b-removed", chapter_num: 1, chapter_title: "Gone", updated_at: "2026-10-01T00:00:00Z", source_text: "Removed text." },
    ],
  };
}

describe("importUserBooks", () => {
  it("skips removed and unconfirmed junk-gated books; a confirmed gated book is in", () => {
    const confirmed = new Set(["b-junk-ok"]);
    const [en, , junk, junkOk, removed] = uploads().books as never[];
    expect(bookExcluded(en, confirmed)).toBeNull();
    expect(bookExcluded(junk, confirmed)).toBe("junk_gated");
    expect(bookExcluded(junkOk, confirmed)).toBeNull();
    expect(bookExcluded(removed, confirmed)).toBe("removed");
  });

  it("splits chapters into ≤ 1200-char paragraph blocks, detects language when books.language is null, never touches books", async () => {
    const db = fakeDb(uploads());
    const before = JSON.stringify(db.tables.books);
    const r = await importUserBooks(db);
    expect(r).toMatchObject({ books: 5, eligibleBooks: 3, skippedRemoved: 1, skippedJunk: 1, chapters: 4, chaptersImported: 4, detectedLanguages: { ar: 1 } });
    expect(new Set(db.blocks.map((b) => b.source_id))).toEqual(new Set(["b-en", "b-null-ar", "b-junk-ok"]));
    for (const b of db.blocks) expect(b.text.length).toBeLessThanOrEqual(1200);
    const ar = db.blocks.filter((b) => b.source_id === "b-null-ar");
    expect(ar).toHaveLength(1);
    expect(ar[0]).toMatchObject({ language: "ar", version: "2026-10-05T00:00:00Z", chapter: 1, anchor: "p1", kind: "paragraph", title: "الفصل الثالث" });
    expect(ar[0].text).toBe("التيار الكهربائي هو حركة الشحنات الكهربائية.\n\nElectric current");
    expect(db.blocks.find((b) => b.source_id === "b-junk-ok")).toMatchObject({ language: "fr", version: "hash-k" });
    expect(db.blocks.filter((b) => b.source_id === "b-en" && b.chapter === 1).length).toBeGreaterThan(1);
    expect(JSON.stringify(db.tables.books)).toBe(before);
  });

  it("is resumable: --max-batches stops early, the next run carries on, a third run finds everything up to date", async () => {
    const db = fakeDb(uploads());
    const first = await importUserBooks(db, { batch: 1, maxBatches: 2 });
    expect(first).toMatchObject({ batches: 2, chaptersImported: 2, chaptersRemaining: 2 });
    const second = await importUserBooks(db, { batch: 1 });
    expect(second).toMatchObject({ chaptersUpToDate: 2, chaptersImported: 2, chaptersRemaining: 0 });
    const third = await importUserBooks(db, { batch: 1 });
    expect(third).toMatchObject({ chaptersUpToDate: 4, chaptersImported: 0, batches: 0 });
    // every write was one transaction holding ≤ batch chapters
    for (const c of db.calls.filter((x) => x.rpc === "sk_knowledge_replace")) expect(c.args.p_scopes.filter((s: { chapter?: number }) => s.chapter !== undefined).length).toBeLessThanOrEqual(1);
  });

  it("a book that becomes junk-gated or removed loses its blocks on the next run", async () => {
    const db = fakeDb(uploads());
    await importUserBooks(db);
    expect(db.blocks.some((b) => b.source_id === "b-en")).toBe(true);
    db.tables.books[0].removed_at = "2026-10-30T00:00:00Z";
    const r = await importUserBooks(db);
    expect(r.cleared).toBe(1);
    expect(db.blocks.some((b) => b.source_id === "b-en")).toBe(false);
  });

  it("re-imports a chapter whose grounding changed after it was imported", async () => {
    const db = fakeDb(uploads(), { now: () => "2026-10-10T00:00:00Z" });
    await importUserBooks(db);
    db.tables.chapter_grounding[1].updated_at = "2026-10-20T00:00:00Z";
    db.tables.chapter_grounding[1].source_text = "Healed text about organs.";
    const r = await importUserBooks(db);
    expect(r).toMatchObject({ chaptersImported: 1, chaptersUpToDate: 3 });
    expect(db.blocks.filter((b) => b.source_id === "b-en" && b.chapter === 2).map((b) => b.text)).toEqual(["Healed text about organs."]);
  });

  it("a dry run reads but writes nothing", async () => {
    const db = fakeDb(uploads());
    const r = await importUserBooks(db, { dryRun: true });
    expect(r.chaptersImported).toBe(4);
    expect(r.blocks).toBeGreaterThan(4);
    expect(db.calls.map((c) => c.rpc)).toEqual(["sk_knowledge_versions"]);
    expect(db.blocks).toEqual([]);
  });

  it("only the given books with bookIds", async () => {
    const db = fakeDb(uploads());
    const r = await importUserBooks(db, { bookIds: ["b-junk-ok"] });
    expect(r).toMatchObject({ books: 1, chaptersImported: 1 });
    expect(new Set(db.blocks.map((b) => b.source_id))).toEqual(new Set(["b-junk-ok"]));
  });
});
