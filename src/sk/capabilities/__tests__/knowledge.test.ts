// SK S7 K2 — knowledge.search against the fake 0174 RPC: it passes the
// ALLOWED sources only (asserted on p_sources), a user who cannot read a book
// never gets its passages even when the query matches (and even when a broken
// RPC returns them), drafts never appear, an Arabic source sets the answer
// language to Arabic, citations come back, no answer-key field reaches a fact,
// sources chosen by title / kind (and asked about when two fit), and
// library.find falling back to the text when no title matches.
// Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/knowledge.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { __setKnowledgeAdminForTests, hitAllowed, knowledgeSearch, pickSource, searchForUser } from "../knowledge";
import { libraryFind } from "../library";
import type { SkCapabilityDeps } from "@/sk/shell/types";
import { lastSources, type FakeKnowledge } from "@/sk/knowledge/__tests__/fake-knowledge";
import { ANSWER_KEY, BLOCKS, CHILD, NOW, OWN_BOOKS, STUDENT_ID, UNVERIFIED, grant, parentCtx, sessionWith, studentCtx, teacherCtx, world } from "@/sk/knowledge/__tests__/knowledge-world";
import { citationsOf, contentWords, isContentQuestion, narrationCovers, passageText, sharedLanguage } from "@/sk/knowledge/answer";
import type { KnowledgeSourceRef } from "@/sk/knowledge/sources";

let db: FakeKnowledge;
const use = (d: FakeKnowledge) => {
  db = d;
  __setKnowledgeAdminForTests(() => db);
  return d;
};
afterEach(() => __setKnowledgeAdminForTests(null));

const deps = (books: Record<string, unknown>[] = OWN_BOOKS, extra: Record<string, unknown[]> = {}): SkCapabilityDeps => ({ session: sessionWith({ books, ...extra }), now: NOW, cache: new Map() });
const run = (ctx: Parameters<typeof knowledgeSearch.handler>[0], args: Record<string, unknown>, d = deps()) => knowledgeSearch.handler(ctx, args, d);
const ALLOWED_FACT_KEYS = ["anchor", "chapter", "cite", "kind", "language", "passage", "section", "source_title"];

describe("knowledge.search — the allowed sources only", () => {
  it("passes EXACTLY her sources to sk_search_knowledge: her final, every article (wildcard), her uploads", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "specialised cells" });
    expect(r.ok).toBe(true);
    expect(lastSources(db)).toEqual(["article:*", "sketchcast_book:cells-structure@12", "user_book:book-own-ar"]);
    expect(db.searches[0]).toMatchObject({ p_query: "specialised cells", p_lang: "en", p_chapter: null });
  });

  it("a book she cannot read never gives a passage, though the query matches it (Chemistry, the foreign upload)", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "specialised cells batteries" });
    const text = JSON.stringify(r.facts);
    expect(text).not.toContain("batteries");
    expect(text).not.toContain("FOREIGN");
    expect(lastSources(db)).not.toContain("sketchcast_book:chem@20");
  });

  it("a DRAFT never gives a passage — even with a grant pointing at it", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "specialised cells draft" });
    expect(JSON.stringify(r.facts)).not.toContain("DRAFT TEXT");
    expect(lastSources(db).some((s) => s.includes("mastering-linear-equations"))).toBe(false);
  });

  it("every hit is re-checked: a broken RPC that ignores p_sources still leaks nothing", async () => {
    const d = use(world());
    d.rpc = async (fn: string) =>
      fn === "sk_search_knowledge" ? { data: BLOCKS.map((b, i) => ({ ...b, id: i + 1, rank: 1 })), error: null } : { data: null, error: null };
    const r = await run(studentCtx(), { query: "cells" });
    const text = JSON.stringify(r.facts);
    for (const bad of ["batteries", "DRAFT TEXT", "FOREIGN", "الخلايا المتخصصة مثل"]) expect(text).not.toContain(bad);
    expect(text).toContain("red blood cells");
    expect(hitAllowed({ source_kind: "sketchcast_book", source_id: "cells-structure", version: "13" }, [{ kind: "sketchcast_book", id: "cells-structure", version: "12", language: "en", title: "" }])).toBe(false);
  });

  it("no answer-key field ever reaches a fact; facts carry the passage fields only", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "name two specialised cells" });
    expect(r.facts!.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(ANSWER_KEY);
    for (const f of r.facts!) expect(Object.keys(f).sort()).toEqual(ALLOWED_FACT_KEYS);
  });

  it("citations: book · chapter · section, with the anchor and kind", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "specialised cells oxygen" });
    expect(r.citations?.[0]).toEqual({ title: "Biology", chapter: 5, anchor: "s3", section: "Specialised cells", kind: "sketchcast_book" });
    expect(r.facts![0]).toMatchObject({ source_title: "Biology", chapter: 5, section: "Specialised cells", cite: "Biology · ch 5 · Specialised cells", passage: expect.stringContaining("red blood cells carry oxygen") });
    expect(r.summary).toContain("end with: From: Biology · ch 5 · Specialised cells");
    expect(r.facts![0]!.passage).not.toContain("<b>");
  });

  it("an article hit is cited by the ARTICLE's title, not its section's", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "photosynthesis glucose", source: "articles" });
    expect(lastSources(db)).toEqual(["article:*"]);
    expect(r.citations).toEqual([{ title: "Photosynthesis", chapter: null, anchor: "s1", section: "How plants make food", kind: "article" }]);
    expect(r.language).toBe("en");
  });

  it("an Arabic source → the result's language is Arabic, and the citation is written in Arabic", async () => {
    use(world({ grants: [grant(STUDENT_ID, "p-bio-ar")] }));
    const r = await run(studentCtx(), { query: "الخلايا المتخصصة", source: "الأحياء" });
    expect(lastSources(db)).toEqual(["sketchcast_book:cells-structure@13"]);
    expect(r.language).toBe("ar");
    expect(r.facts![0]).toMatchObject({ language: "ar", cite: "الأحياء · الفصل 5 · الخلايا المتخصصة" });
    expect(r.summary).toContain("المصدر: الأحياء · الفصل 5 · الخلايا المتخصصة");
  });

  it("an Arabic UPLOAD → Arabic, from the book's own language", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "التنفس الخلوي", source: "uploads" });
    expect(lastSources(db)).toEqual(["user_book:book-own-ar"]);
    expect(r).toMatchObject({ ok: true, language: "ar", citations: [{ title: "كتابي", chapter: 2, anchor: "p4", section: "التنفس", kind: "user_book" }] });
  });

  it("mixed languages → no single source language", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "cells glucose التنفس" });
    expect(new Set(r.facts!.map((f) => f.language)).size).toBeGreaterThan(1);
    expect(r.language).toBeUndefined();
  });

  it("nothing matches → ok with no facts (SK says it has nothing)", async () => {
    use(world());
    const r = await run(studentCtx(), { query: "volcanoes" });
    expect(r).toMatchObject({ ok: true, facts: [] });
    expect(r.citations).toBeUndefined();
  });

  it("chapter narrows the search", async () => {
    use(world());
    await run(studentCtx(), { query: "cells", chapter: 5 });
    expect(db.searches[0]!.p_chapter).toBe(5);
  });

  it("no service client → a refusal, no search", async () => {
    __setKnowledgeAdminForTests(() => null);
    const r = await run(studentCtx(), { query: "cells" });
    expect(r).toMatchObject({ ok: false, error: "knowledge search unavailable" });
  });

  it("a parent naming her VERIFIED child searches that child's books too; an unverified child adds nothing", async () => {
    use(world());
    await run(parentCtx([CHILD, UNVERIFIED]), { query: "batteries", child: "Aisyah" });
    expect(lastSources(db)).toContain("sketchcast_book:chem@20");
    await run(parentCtx([CHILD, UNVERIFIED]), { query: "cells", child: "Omar" });
    expect(lastSources(db)).toEqual(["article:*", "user_book:book-own-ar"]);
  });
});

describe("choosing a source", () => {
  const S = (kind: KnowledgeSourceRef["kind"], id: string, title: string): KnowledgeSourceRef => ({ kind, id, title, language: "en" });
  const all = [S("sketchcast_book", "w1", "Biology"), S("user_book", "b1", "Biology Workbook"), S("article", "*", "SketchCast articles"), S("user_book", "b2", "History")];

  it("by kind word, by exact title, by part of a title; two different titles → ask", () => {
    expect(pickSource("uploads", all)).toEqual({ kind: "list", list: [all[1], all[3]] });
    expect(pickSource("articles", all)).toEqual({ kind: "list", list: [all[2]] });
    expect(pickSource("biology", all)).toEqual({ kind: "list", list: [all[0]] });
    expect(pickSource("histor", all)).toEqual({ kind: "list", list: [all[3]] });
    expect(pickSource("bio", all)).toEqual({ kind: "ask", candidates: [all[0], all[1]] });
    expect(pickSource("physics", all)).toEqual({ kind: "none" });
    expect(pickSource("the photosynthesis article", all)).toEqual({ kind: "list", list: [all[2]] });
  });

  it("the capability asks which, and never searches a source she has not got", async () => {
    use(world());
    const ask = await run(studentCtx(), { query: "cells", source: "bio" }, deps([...OWN_BOOKS, { id: "book-bio-notes", title: "Bio notes", language: "en", removed_at: null, health: null }]));
    expect(ask.summary).toMatch(/More than one of your sources fits 'bio': Biology; Bio notes/);
    expect(ask.facts).toEqual([
      { ask: "which_source", title: "Biology", kind: "sketchcast_book" },
      { ask: "which_source", title: "Bio notes", kind: "user_book" },
    ]);
    expect(db.searches).toHaveLength(0);
    const none = await run(studentCtx(), { query: "cells", source: "Chemistry" });
    expect(none).toMatchObject({ ok: false, error: "no_source" });
    expect(db.searches).toHaveLength(0);
  });
});

describe("restricting to a kit's own source", () => {
  it("restrict is cut to what she may use: a book she cannot read is dropped, an article stays", async () => {
    use(world());
    const r = await searchForUser(studentCtx(), deps(), {
      query: "specialised cells",
      restrict: [
        { kind: "sketchcast_book", id: "chem", language: "en", title: "" },
        { kind: "article", id: "art-photo-en", language: null, title: "" },
      ],
    });
    expect(lastSources(db)).toEqual(["article:art-photo-en"]);
    expect(r.status === "ok" && r.passages.map((p) => p.source_id)).toEqual(["art-photo-en"]);
  });
});

describe("library.find falls back to the TEXT when no title matches", () => {
  it("no title match → passages with citations; a title match → no text search", async () => {
    use(world({ entitlements: [{ school_id: teacherCtx().user.schoolId, plan_key: "school_annual", active: true, current_period_end: null }] }));
    const d = deps([], { generations: [] });
    const r = await libraryFind.handler(teacherCtx(), { query: "photosynthesis" }, d);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/^No title matches 'photosynthesis', but the text of your sources does\./);
    expect(r.citations?.[0]).toMatchObject({ title: "Photosynthesis", kind: "article" });
    const titled = await libraryFind.handler(teacherCtx(), { query: "biology" }, deps([{ id: "bk", title: "Biology for Form 1", subject: "Science", grade: "7", status: "ready", chapters: [], owner_id: teacherCtx().user.id }], { generations: [] }));
    expect(titled.facts?.[0]).toMatchObject({ kind: "book", title: "Biology for Form 1" });
    expect(titled.citations).toBeUndefined();
    expect(db.searches).toHaveLength(1);
  });
});

describe("pure helpers", () => {
  it("content questions in the app's languages", () => {
    for (const q of ["what is osmosis?", "Explain photosynthesis", "why do cells divide", "how does the heart pump blood", "apa itu fotosintesis", "terangkan osmosis", "ما هو التنفس الخلوي؟", "اشرح البناء الضوئي", "qu'est-ce que l'osmose", "¿qué es la fotosíntesis?", "o que é osmose", "प्रकाश संश्लेषण क्या है"]) expect(isContentQuestion(q), q).toBe(true);
    for (const q of ["play", "next section", "yes", "ok", "where am I", "open my library"]) expect(isContentQuestion(q), q).toBe(false);
  });
  it("narration coverage: half the subject words in the kit's words", () => {
    const sec = ["Red blood cells", ["no nucleus", "carry oxygen"], "Red blood cells carry oxygen around the body."];
    expect(narrationCovers("why do red blood cells carry oxygen?", sec)).toBe(true);
    expect(narrationCovers("what is mitochondria?", sec)).toBe(false);
    expect(narrationCovers("explain this", sec)).toBe(true);
    expect(contentWords("What are the specialised cells?")).toEqual(["specialis", "cell"]); // stems, both sides alike
  });
  it("passage text, shared language, distinct citations", () => {
    expect(passageText("A <b>cell</b>  is <B>small</B>")).toBe("A cell is small");
    expect(sharedLanguage([{ language: "ar" }, { language: "ar" }])).toBe("ar");
    expect(sharedLanguage([{ language: "ar" }, { language: null }])).toBeNull();
    const p = { kind: "sketchcast_book" as const, source_id: "w", source_title: "Biology", chapter: 5, anchor: "s3", section: "Cells", text: "t", language: "en" };
    expect(citationsOf([p, { ...p, anchor: "s3~2" }, { ...p, section: "Tissues", anchor: "s4" }])).toEqual([
      { title: "Biology", chapter: 5, anchor: "s3", section: "Cells", kind: "sketchcast_book" },
      { title: "Biology", chapter: 5, anchor: "s4", section: "Tissues", kind: "sketchcast_book" },
    ]);
  });
});
