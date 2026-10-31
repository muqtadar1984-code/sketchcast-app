/**
 * start_lesson (founder 2026-10-30: "play chapter 1 from the book") — how the
 * tool resolves the book and the chapter, with fake rows behind a fake
 * user-session client that IGNORES filters (fixtures.ts), so every row the
 * tool must not use is also proven to be dropped by its own checks:
 *   - an uploaded book with a generated chapter 1 → the Board deep link with
 *     autostart (chapter=0: the database's 0-based num);
 *   - a SketchCast product book (live grant) → the same Board link, no kit
 *     check (the Board adopts the chapter's catalogue kit on arrival);
 *   - nothing generated → the guidance line and the Library row; in progress
 *     → its own line;
 *   - several books and none named → "which book?" with up to three titles;
 *     the one on screen / last taught wins over asking;
 *   - a student is not in the tool's roles any more (SK Tutor retired
 *     2026-10-31; the Board is teacher-only).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/lesson.test.ts
 */
import { describe, expect, it } from "vitest";
import { startLesson, startLessonCapability, matchBooks, resolveChapter, isDeicticBook, titleScore, type LessonBook } from "../lesson";
import { REGISTRY } from "../index";
import { runCapability } from "@/sk/shell/runner";
import { NOW, OTHER_SCHOOL_ID, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx, type Rows } from "@/sk/shell/__tests__/fixtures";
import { LESSON_NOT_GENERATED, LESSON_STARTING, LESSON_WHICH_BOOK } from "@/sk/shell/lesson-lines";

const SYSTEM = "99999999-9999-4999-8999-999999999999";
const STUDENT_ID = "44444444-4444-4444-8444-444444444444";

const BIO = { id: "b-bio", title: "Biology Form 4", subject: "Biology", chapters: [{ num: 0, title: "Cell Structure" }, { num: 1, title: "Cell Division" }, { num: 2, title: "Enzymes" }], owner_id: TEACHER_ID, school_id: SCHOOL_ID, created_at: "2026-10-01T00:00:00Z", sk_product_id: null };
const CHEM = { id: "b-chem", title: "Chemistry Matters", subject: "Chemistry", chapters: [{ num: 0, title: "Atoms" }], owner_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID, created_at: "2026-10-05T00:00:00Z", sk_product_id: null };
const PHYS = { id: "b-phys", title: "Physics Now", subject: "Physics", chapters: [{ num: 0, title: "Motion" }], owner_id: TEACHER_ID, school_id: SCHOOL_ID, created_at: "2026-09-01T00:00:00Z", sk_product_id: null };
const PRODUCT = { id: "b-prod", title: "SketchCast Biology", subject: "Biology", chapters: [{ num: 0, title: "Cells" }, { num: 1, title: "Tissues" }], owner_id: SYSTEM, school_id: null, created_at: "2026-10-20T00:00:00Z", sk_product_id: "p1" };
const FOREIGN = { id: "b-foreign", title: "Geography Elsewhere", subject: "Geography", chapters: [{ num: 0, title: "Maps" }], owner_id: OTHER_TEACHER_ID, school_id: OTHER_SCHOOL_ID, created_at: "2026-10-28T00:00:00Z", sk_product_id: null };
const GRANT = { user_id: TEACHER_ID, product_id: "p1", activated_at: "2026-01-01T00:00:00Z", expires_at: null, revoked_at: null };
const doneCh1 = { id: "g1", kind: "presentation", status: "done", chapter_ref: "0", params: {}, owner_id: TEACHER_ID, book_id: "b-bio" };

const deps = (tables: Record<string, Rows>) => ({ session: fakeSession(tables), now: NOW, cache: new Map<string, Promise<unknown>>() });
const teacher = (over: Parameters<typeof makeCtx>[0] = {}) => makeCtx({ role: "teacher", ...over });

describe("an uploaded book", () => {
  it("generated chapter 1 → the Board with the chapter (0-based) and autostart", async () => {
    const r = await startLesson(teacher(), { book: "the book", chapter: 1 }, deps({ books: [BIO, FOREIGN], generations: [doneCh1] }));
    expect(r.ok).toBe(true);
    expect(r.navigate).toEqual({ path: "/present?book=b-bio&chapter=0&autostart=1", label: "Classroom board" });
    expect(r.summary).toBe("Starting chapter 1 of Biology Form 4 on the Board.");
    expect(r.facts).toEqual([{ book: "Biology Form 4", chapter: 1, chapter_title: "Cell Structure", part: null }]);
    expect(r.entities).toEqual([{ kind: "book", id: "b-bio", label: "Biology Form 4", via: "start_lesson" }]);
  });
  it("not generated yet → the guidance line and her Library row (no Board)", async () => {
    const r = await startLesson(teacher(), { chapter: "1" }, deps({ books: [BIO], generations: [] }));
    expect(r.ok).toBe(true);
    expect(r.navigate).toEqual({ path: "/dashboard?book=b-bio", label: "Library" });
    expect(r.summary).toBe("Chapter 1 of Biology Form 4 hasn't been generated yet — I'm opening it in your Library so you can generate the kit.");
  });
  it("a colleague's kit, another chapter's, or a withdrawn-looking failure does not count as generated", async () => {
    const gens = [
      { ...doneCh1, id: "x1", owner_id: OTHER_TEACHER_ID },
      { ...doneCh1, id: "x2", chapter_ref: "1" },
      { ...doneCh1, id: "x3", status: "failed" },
      { ...doneCh1, id: "x4", kind: "worksheet" },
    ];
    const r = await startLesson(teacher(), { chapter: 1 }, deps({ books: [BIO], generations: gens }));
    expect(r.navigate?.path).toBe("/dashboard?book=b-bio");
  });
  it("still generating → its own line, and the Library row", async () => {
    const r = await startLesson(teacher(), { chapter: 1 }, deps({ books: [BIO], generations: [{ ...doneCh1, status: "processing" }] }));
    expect(r.summary).toMatch(/^Chapter 1 of Biology Form 4 is still being generated/);
    expect(r.navigate?.path).toBe("/dashboard?book=b-bio");
  });
  it("a part: generated → the chapter on the Board and 'part N is on the rail'; not generated → the Library", async () => {
    const withPart = { ...doneCh1, params: { part: 2 } };
    const ok = await startLesson(teacher(), { chapter: 1, part: 2 }, deps({ books: [BIO], generations: [withPart] }));
    expect(ok.navigate?.path).toBe("/present?book=b-bio&chapter=0&autostart=1");
    expect(ok.summary).toBe("Starting chapter 1 of Biology Form 4 on the Board. Part 2 is on the rail.");
    const missing = await startLesson(teacher(), { chapter: 1, part: 3 }, deps({ books: [BIO], generations: [withPart] }));
    expect(missing.navigate?.path).toBe("/dashboard?book=b-bio");
  });
  it("the class she named rides along on the Board link", async () => {
    const classes = [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }, { id: "cx", name: "7B", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID }];
    const r = await startLesson(teacher(), { chapter: 1, class: "7B" }, deps({ books: [BIO], generations: [doneCh1], classes }));
    expect(r.navigate?.path).toBe("/present?class=c7b&book=b-bio&chapter=0&autostart=1");
  });
});

describe("a SketchCast product book", () => {
  it("with a live grant → the Board link as it is (the Board adopts the chapter's kit on arrival)", async () => {
    const r = await startLesson(teacher(), { book: "SketchCast Biology", chapter: "first" }, deps({ books: [PRODUCT, BIO], book_access_grants: [GRANT], generations: [] }));
    expect(r.navigate?.path).toBe("/present?book=b-prod&chapter=0&autostart=1");
    expect(r.summary).toBe("Starting chapter 1 of SketchCast Biology on the Board.");
  });
  it("without a live grant it is not her book (revoked, expired, someone else's)", async () => {
    for (const g of [{ ...GRANT, revoked_at: "2026-02-01T00:00:00Z" }, { ...GRANT, expires_at: "2026-02-01T00:00:00Z" }, { ...GRANT, user_id: OTHER_TEACHER_ID }]) {
      const r = await startLesson(teacher(), { chapter: 1 }, deps({ books: [PRODUCT, BIO], book_access_grants: [g], generations: [doneCh1] }));
      expect(r.navigate?.path).toBe("/present?book=b-bio&chapter=0&autostart=1"); // the only book left
    }
  });
});

describe("which book", () => {
  const two = () => deps({ books: [BIO, CHEM, PHYS, FOREIGN], generations: [doneCh1] });
  it("several books and none named → the question, with up to three of HER titles, and no navigate", async () => {
    const r = await startLesson(teacher(), { chapter: 1 }, two());
    expect(r.ok).toBe(true);
    expect(r.navigate).toBeUndefined();
    expect(r.summary).toBe("Which book — Chemistry Matters, Biology Form 4 or Physics Now?");
    expect(r.summary).not.toContain("Geography");
    expect(r.facts).toEqual([{ book: "Chemistry Matters", chapters: 1 }, { book: "Biology Form 4", chapters: 3 }, { book: "Physics Now", chapters: 1 }]);
  });
  it("the question in her language", async () => {
    const r = await startLesson(teacher({ locale: "ms" }), { chapter: 1 }, two());
    expect(r.summary).toBe(LESSON_WHICH_BOOK.ms.replace("{titles}", "Chemistry Matters, Biology Form 4 atau Physics Now"));
  });
  it("title words pick one (fuzzy: a word, the subject, any case)", async () => {
    for (const q of ["biology", "Biology Form 4", "bio", "the biology book", "BIOLOGY"]) {
      const r = await startLesson(teacher(), { book: q, chapter: 1 }, two());
      expect(r.navigate?.path, q).toBe("/present?book=b-bio&chapter=0&autostart=1");
    }
  });
  it("words that match no book → says so and names her books", async () => {
    const r = await startLesson(teacher(), { book: "Astronomy", chapter: 1 }, two());
    expect(r.navigate).toBeUndefined();
    expect(r.summary).toMatch(/^I couldn't find a book matching “Astronomy”\. Your books: /);
  });
  it("the book on screen (the selection) wins over asking", async () => {
    const r = await startLesson(teacher({ selection: { bookId: "b-bio" } }), { chapter: 1 }, two());
    expect(r.navigate?.path).toBe("/present?book=b-bio&chapter=0&autostart=1");
  });
  it("'the book' → the one she taught last on the Board", async () => {
    const t = deps({ books: [BIO, CHEM, PHYS], generations: [doneCh1], present_last_taught: [{ teacher_id: TEACHER_ID, book_id: "b-bio", updated_at: "2026-10-29T00:00:00Z" }] });
    const r = await startLesson(teacher(), { book: "the book", chapter: 1 }, t);
    expect(r.navigate?.path).toBe("/present?book=b-bio&chapter=0&autostart=1");
  });
  it("no books at all → the add-a-book line", async () => {
    const r = await startLesson(teacher(), { chapter: 1 }, deps({ books: [FOREIGN] }));
    expect(r.navigate).toBeUndefined();
    expect(r.summary).toMatch(/^You don't have a book to teach from yet/);
  });
});

describe("which chapter", () => {
  it("by title words", async () => {
    const r = await startLesson(teacher(), { chapter: "cell division" }, deps({ books: [BIO], generations: [{ ...doneCh1, chapter_ref: "1" }] }));
    expect(r.navigate?.path).toBe("/present?book=b-bio&chapter=1&autostart=1");
  });
  it("none said → which chapter, with the range", async () => {
    const r = await startLesson(teacher(), { book: "biology" }, deps({ books: [BIO] }));
    expect(r.summary).toBe("Which chapter of Biology Form 4? It has chapters 1 to 3.");
    expect(r.navigate).toBeUndefined();
  });
  it("one the book does not have → says so, with the range", async () => {
    const r = await startLesson(teacher(), { chapter: 9 }, deps({ books: [BIO] }));
    expect(r.summary).toBe("I couldn't find that chapter in Biology Form 4. It has chapters 1 to 3.");
  });
});

describe("the registry entry", () => {
  it("is registered, immediate, for teachers (teacher hat or none) — not students, parents or leader hats", () => {
    expect(REGISTRY).toContain(startLessonCapability);
    expect(startLessonCapability.meta).toMatchObject({ name: "start_lesson", tier: "immediate", kind: "nav", hats: ["teacher"] });
    expect(startLessonCapability.meta.roles).toEqual(expect.arrayContaining(["teacher"]));
    expect(startLessonCapability.meta.roles).not.toContain("parent");
    expect(startLessonCapability.meta.roles).not.toContain("student");
    expect(startLessonCapability.meta.description).not.toMatch(/SK Tutor/);
  });
  it("through the runner: a parent, a principal hat and a student are refused before any read", async () => {
    const log: string[] = [];
    for (const ctx of [makeCtx({ role: "parent", hat: "parent" }), makeCtx({ role: "school_admin", hat: "principal" }), makeCtx({ role: "student", hat: null, userId: STUDENT_ID })]) {
      const r = await runCapability(ctx, "start_lesson", { chapter: 1 }, { session: fakeSession({ books: [BIO] }, { log }), now: NOW, sessionId: "s", turnId: "t", sink: { write: async () => {} } } as never);
      expect(r.error).toBe("not_allowed");
    }
    expect(log.filter((l) => l.startsWith("books."))).toEqual([]);
  });
  it("a teacher without the Board flag is refused by the navigate inside", async () => {
    const r = await startLesson(makeCtx({ role: "teacher", flags: { board: false } }), { chapter: 1 }, deps({ books: [BIO], generations: [doneCh1] }));
    expect(r.ok).toBe(false);
    expect(r.navigate).toBeUndefined();
  });
});

describe("the pure parts", () => {
  const book = (title: string, subject: string | null = null): LessonBook => ({ id: title, title, subject, chapters: [], productId: null, ownerId: null, schoolId: null, createdAt: null });
  it("deictic words name no book", () => {
    for (const q of ["", "the book", "this book", "my book", "buku ini", "الكتاب", "le livre", "el libro", "the textbook"]) expect(isDeicticBook(q), q).toBe(true);
    for (const q of ["biology", "the biology book", "Sains"]) expect(isDeicticBook(q), q).toBe(false);
  });
  it("matchBooks: a clear winner, a tie, nothing", () => {
    const books = [book("Biology Form 4", "Biology"), book("Biology Form 5", "Biology"), book("Chemistry")];
    expect(matchBooks("form 5", books).map((b) => b.title)).toEqual(["Biology Form 5"]);
    expect(matchBooks("biology", books).map((b) => b.title)).toEqual(["Biology Form 4", "Biology Form 5"]);
    expect(matchBooks("astronomy", books)).toEqual([]);
    expect(titleScore("Biology Form 4", "Biology Form 4")).toBe(100);
  });
  it("resolveChapter: spoken numbers are 1-based, the num is 0-based", () => {
    const b: LessonBook = { ...book("B"), chapters: [{ num: 0, title: "Cells" }, { num: 1, title: "Tissues" }] };
    expect(resolveChapter(b, 1)).toEqual({ num: 0 });
    expect(resolveChapter(b, "Chapter 2")).toEqual({ num: 1 });
    expect(resolveChapter(b, "second")).toEqual({ num: 1 });
    expect(resolveChapter(b, "tissues")).toEqual({ num: 1 });
    expect(resolveChapter(b, 3)).toEqual({ error: "no_chapter" });
    expect(resolveChapter(b, "")).toEqual({ error: "missing" });
  });
  it("every line used here has all ten locales", () => {
    for (const t of [LESSON_STARTING, LESSON_NOT_GENERATED, LESSON_WHICH_BOOK]) expect(Object.keys(t).sort()).toEqual(["ar", "en", "es", "fr", "hi", "mr", "ms", "ms-arab", "pt", "te"]);
  });
});
