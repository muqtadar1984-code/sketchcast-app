/**
 * The grounding check keeps SK's own clarifying questions (production log
 * 2026-10-30: dropped ["Do you mean a class like 7B, or a different book
 * title?"], unsupported ["7"]). A name or number from the user's OWN context —
 * her classes, books, chapters, children, school — supports the answer when
 * the tools of the turn did not carry it; an invented one is still dropped.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/context-entities.test.ts
 */
import { describe, expect, it } from "vitest";
import { contextEntities, groundWithContext } from "../context-entities";
import { groundingCheck } from "../prompt";
import { NOW, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx } from "./fixtures";

const FOUNDER = "Do you mean a class like 7B, or a different book title?";
const QUESTION = "play chapter 1 from the book";
const deps = (tables: Record<string, Record<string, unknown>[]>) => ({ session: fakeSession(tables), now: NOW, cache: new Map<string, Promise<unknown>>() });
const TABLES = {
  classes: [
    { id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c9z", name: "9Z", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID },
  ],
  books: [{ id: "b1", title: "Biology Form 4", chapters: [{ num: 0, title: "Cell Structure" }, { num: 11, title: "Ecosystems" }] }],
  schools: [{ id: SCHOOL_ID, name: "Sekolah Seri Bestari" }],
};

describe("the founder's sentence", () => {
  it("is dropped today with nothing but the question as support (the '7')", () => {
    const v = groundingCheck(FOUNDER, [], QUESTION);
    expect(v.ok).toBe(false);
    expect(v.unsupported).toEqual(["7"]);
  });
  it("is KEPT once her own class 7B is support", async () => {
    const ctx = makeCtx({ role: "teacher" });
    const v = await groundWithContext(FOUNDER, [], QUESTION, () => contextEntities(ctx, deps(TABLES)));
    expect(v).toMatchObject({ ok: true, context: true, dropped: [] });
    expect(v.text).toBe(FOUNDER);
  });
  it("is still dropped when 7B is not one of HER classes (a colleague's is not support)", async () => {
    const ctx = makeCtx({ role: "teacher" });
    const tables = { ...TABLES, classes: [{ id: "c7b", name: "7B", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID }] };
    const v = await groundWithContext(FOUNDER, [], QUESTION, () => contextEntities(ctx, deps(tables)));
    expect(v.ok).toBe(false);
    expect(v.dropped).toEqual([FOUNDER]);
  });
});

describe("what her context supports — and what it does not", () => {
  const ctx = makeCtx({ role: "teacher" });
  const check = (text: string) => groundWithContext(text, [], QUESTION, () => contextEntities(ctx, deps(TABLES)));
  it("her book titles, chapter numbers (1-based) and chapter titles, and her school", async () => {
    for (const s of ["Should I start Biology Form 4?", "Do you mean chapter 12, Ecosystems?", "Is that for Sekolah Seri Bestari?", "Which part of Cell Structure?"]) {
      expect((await check(s)).ok, s).toBe(true);
    }
  });
  it("invented names and numbers are still dropped", async () => {
    for (const s of ["Do you mean Zubair's class?", "Do you mean a class like 8C?", "Chemistry Form 5 has 14 chapters."]) {
      const v = await check(s);
      expect(v.ok, s).toBe(false);
      expect(v.dropped, s).toEqual([s]);
    }
  });
  it("a grounded answer reads nothing more (the context is loaded only on a failure)", async () => {
    let calls = 0;
    const v = await groundWithContext("Opening the Library.", ["Opening Library."], "open the library", async () => {
      calls++;
      return [];
    });
    expect(v).toMatchObject({ ok: true, context: false });
    expect(calls).toBe(0);
  });
  it("a parent's children, by name; the conversation's resolved entities", async () => {
    const parent = makeCtx({ role: "parent", hat: "parent" });
    parent.children = [{ id: "k1", firstName: "Aisyah", name: "Aisyah Rahman", source: "school", verified: true, schoolId: SCHOOL_ID }];
    parent.recent = { entities: [{ kind: "class", id: "c5a", label: "5 Amanah", via: "context.resolve" }], lastToolResults: [] };
    const words = await contextEntities(parent, deps({ books: [] }));
    expect(words).toEqual(expect.arrayContaining(["Aisyah Rahman", "Aisyah", "5 Amanah"]));
    const v = await groundWithContext("Do you mean Aisyah or 5 Amanah?", [], "how is she doing", () => Promise.resolve(words));
    expect(v.ok).toBe(true);
  });
  it("a student's own classes come from her enrolments", async () => {
    const student = makeCtx({ role: "student", hat: null, userId: "s1" });
    const words = await contextEntities(student, deps({ enrollments: [{ student_id: "s1", classes: { name: "4 Bestari" } }, { student_id: "s2", classes: { name: "4 Other" } }], books: [] }));
    expect(words).toContain("4 Bestari");
    expect(words).not.toContain("4 Other");
  });
});
