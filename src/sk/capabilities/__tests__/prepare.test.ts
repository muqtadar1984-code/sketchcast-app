/**
 * S2 slice B: the `lesson.prepare` resolver (book + chapter from her shelf —
 * own first, then the school shelf; ambiguity asks; an existing kit → NO card,
 * an offer to open it; the card's credits are EXACTLY kitCredits(kitRows(…)),
 * credits_left from my_fair_use like the Library's meter; "for Friday" only
 * in the title; it never writes), `lesson.status` (SK-started kits, degrading
 * when 0169's column is missing), and the credit arithmetic it shares.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/prepare.test.ts
 */
import { describe, expect, it } from "vitest";
import { lessonPrepareAction, lessonStatus, missingActionColumn, resolveLessonPrepare, spokenChapterNumber } from "../prepare";
import { kitCredits, kitRows } from "@/app/dashboard/kit";
import { creditsLeftOf, spendable } from "@/utils/fair-use";
import { PREP_EXISTS, PREP_GATE_WARNING } from "@/sk/shell/act-lines";
import { lineFor } from "@/sk/shell/lines";
import { metaAllows } from "@/sk/shell/registry";
import { NOW, OTHER_SCHOOL_ID, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx, type Rows } from "@/sk/shell/__tests__/fixtures";

const BIO = "b0000000-0000-4000-8000-000000000001";
const SHELF = "b0000000-0000-4000-8000-000000000002";
const FOREIGN = "b0000000-0000-4000-8000-000000000003";

const tables = (): Record<string, Rows> => ({
  books: [
    {
      id: BIO,
      title: "Biology Form 4",
      subject: "Biology",
      grade: "Form 4",
      language: "en",
      status: "ready",
      owner_id: TEACHER_ID,
      school_id: SCHOOL_ID,
      chapters: [
        { num: 0, title: "Introduction to Biology", parts: [] },
        { num: 1, title: "Cell Structure", parts: [] },
        { num: 2, title: "Specialised Cells", parts: [{}, {}, {}] },
      ],
      health: null,
    },
    { id: SHELF, title: "Science Year 7", subject: "Science", grade: "Year 7", language: "en", status: "ready", owner_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID, chapters: [{ num: 4, title: "Specialised Cells" }], health: null },
    // Leaked by a too-wide RLS read: another school's book. Never a candidate.
    { id: FOREIGN, title: "Biology Foreign", subject: "Biology", grade: "Form 4", language: "en", status: "ready", owner_id: OTHER_TEACHER_ID, school_id: OTHER_SCHOOL_ID, chapters: [{ num: 0, title: "Photosynthesis" }], health: null },
  ],
  generations: [],
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function session(t: Record<string, Rows>, fairUse: unknown = { tier: "pro", unlimited: false, credits: { cap: 24, carry: 0, used: 6, available: 18 } }, statusError?: { code?: string; message?: string }) {
  const s = fakeSession(t);
  const rpcs: string[] = [];
  return {
    rpcs,
    log: s.log,
    from: (table: string) => {
      const b: any = s.from(table);
      for (const m of ["insert", "update", "upsert", "delete"]) {
        b[m] = () => {
          throw new Error(`lesson.prepare resolver wrote to ${table}`);
        };
      }
      if (statusError && table === "generations") {
        // The FIRST generations read (with sk_action_id) fails like a missing column.
        let selectedAction = false;
        const sel = b.select;
        b.select = (cols: string) => {
          selectedAction = /sk_action_id/.test(cols);
          return sel(cols);
        };
        const then = b.then;
        b.then = (res: any, rej: any) => (selectedAction ? Promise.resolve({ data: null, error: statusError }).then(res, rej) : then(res, rej));
      }
      return b;
    },
    rpc: async (fn: string) => {
      rpcs.push(fn);
      if (fn === "my_fair_use") return { data: fairUse, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const prep = (args: Record<string, unknown>, o: { t?: Record<string, Rows>; fairUse?: unknown; locale?: string } = {}) =>
  resolveLessonPrepare(makeCtx({ locale: o.locale }), args, { session: session(o.t ?? tables(), o.fairUse), now: NOW });

describe("kitCredits — credit_ledger_write's own rule over kitRows", () => {
  const rows = (parts?: number) => kitRows({ bookId: BIO, schoolId: null, userId: TEACHER_ID, chapterNum: 2, part: parts ?? null });
  it("a one-part chapter kit is 6 (seven rows, the deck free)", () => {
    expect(rows()).toHaveLength(7);
    expect(kitCredits(rows())).toBe(6);
    expect(kitCredits(rows(), 1)).toBe(6);
  });
  it("a chapter-level lesson on an N-part chapter is charged N; a part row is 1", () => {
    expect(kitCredits(rows(), 3)).toBe(3 + 5);
    expect(kitCredits(rows(2), 3)).toBe(6); // params.part = 2 → the lesson is one credit
  });
});

describe("creditsLeftOf — the meter's spendable() over my_fair_use", () => {
  it("monthly + purchased, minus an overdraft; null when unmetered; 0 when locked", () => {
    expect(creditsLeftOf({ credits: { cap: 24, carry: 0, used: 6, available: 18 } })).toBe(18);
    expect(creditsLeftOf({ credits: { cap: 12, carry: 0, used: 15, available: 0 }, purchased: 6 })).toBe(3);
    expect(spendable({ cap: 12, carry: 0, used: 15, available: 0 }, 6).total).toBe(3);
    expect(creditsLeftOf({ unlimited: true })).toBeNull();
    expect(creditsLeftOf({ locked: true, credits: { cap: 0, carry: 0, used: 0, available: 0 } })).toBe(0);
    expect(creditsLeftOf(null)).toBeNull();
  });
});

describe("lesson.prepare — the resolver (card only, never writes)", () => {
  it("is a teacher-hat confirm act", () => {
    expect(lessonPrepareAction.meta).toMatchObject({ tier: "confirm", kind: "act", roles: ["teacher"], hats: ["teacher"] });
    expect(metaAllows(lessonPrepareAction.meta, makeCtx({ role: "parent", hat: "parent" }))).toBe(false);
  });
  it("'make a kit for chapter 2 of Biology' → the card with the EXACT credits kitRows would charge, credits left, the click-only marker", async () => {
    const r = await prep({ chapterNumber: 2, bookQuery: "Biology" });
    expect(r.ok).toBe(true);
    const expected = kitCredits(kitRows({ bookId: BIO, schoolId: SCHOOL_ID, userId: TEACHER_ID, chapterNum: 1, language: "en" }), 0);
    expect(r.confirm).toEqual({
      action: "lesson.prepare",
      title: "Prepare a kit: Cell Structure",
      params: { book_id: BIO, chapter_ref: "1", chapter_title: "Cell Structure", book_title: "Biology Form 4", credits: expected, credits_left: 18, click_only: true },
    });
    expect(expected).toBe(6);
    expect(r.summary).toContain("needs a click");
  });
  it("a three-part chapter: the card says 8 (the chapter's lesson is charged per part)", async () => {
    const r = await prep({ chapterQuery: "Specialised Cells", bookQuery: "Biology" });
    expect(r.confirm?.params).toMatchObject({ chapter_ref: "2", chapter_title: "Specialised Cells", credits: 8 });
  });
  it("'prepare Specialised Cells for Friday' — two books have it: her own wins over the shelf's; 'Friday' only in the title", async () => {
    const r = await prep({ chapterQuery: "Specialised Cells", forWhen: "Friday" });
    expect(r.confirm?.title).toBe("Prepare a kit: Specialised Cells (for Friday)");
    expect(r.confirm?.params.book_id).toBe(BIO);
    expect(Object.values(r.confirm?.params ?? {})).not.toContain("Friday");
  });
  it("ambiguous on the shelf alone → asks which, no card", async () => {
    const t = tables();
    t.books[0].chapters = [{ num: 0, title: "Other" }];
    t.books.push({ id: "b0000000-0000-4000-8000-000000000004", title: "Science Year 8", subject: "Science", status: "ready", owner_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID, chapters: [{ num: 1, title: "Specialised Cells" }] });
    const r = await prep({ chapterQuery: "Specialised Cells" }, { t });
    expect(r.ok).toBe(true);
    expect(r.confirm).toBeUndefined();
    expect(r.summary).toMatch(/^Which one: /);
    expect(r.entities?.every((e) => e.kind === "chapter")).toBe(true);
  });
  it("a book with no chapter said → asks which chapter", async () => {
    const r = await prep({ bookQuery: "Biology" });
    expect(r.confirm).toBeUndefined();
    expect(r.summary).toMatch(/^Which chapter of Biology Form 4\?/);
  });
  it("another school's book never resolves (the leaked row)", async () => {
    const r = await prep({ chapterQuery: "Photosynthesis" });
    expect(r).toMatchObject({ ok: false, error: "chapter_not_found" });
    const byId = await prep({ bookId: FOREIGN, chapterRef: "0" });
    expect(byId).toMatchObject({ ok: false, error: "book_not_found" });
  });
  it("she already has the kit → NO card: “You already have that kit — want me to open it?” + a kit entity", async () => {
    const t = tables();
    t.generations = [{ id: "pres-1", kind: "presentation", status: "done", chapter_ref: "1", book_id: BIO, owner_id: TEACHER_ID, params: {} }];
    const r = await prep({ chapterNumber: 2, bookQuery: "Biology" }, { t });
    expect(r.confirm).toBeUndefined();
    expect(r).toMatchObject({ ok: true, summary: lineFor(PREP_EXISTS, "en") });
    expect(r.entities).toEqual([{ kind: "kit", id: "pres-1", label: "Cell Structure (Biology Form 4)", via: "lesson.prepare", ids: [BIO, "1"] }]);
    expect(r.facts?.[0]).toMatchObject({ kind: "kit", generation_id: "pres-1", book_id: BIO, chapter_ref: "1" });
  });
  it("a failed lesson is not a kit: the card is issued (the Library would offer to generate again)", async () => {
    const t = tables();
    t.generations = [{ id: "pres-x", kind: "presentation", status: "error", chapter_ref: "1", book_id: BIO, owner_id: TEACHER_ID, params: {} }];
    expect((await prep({ chapterNumber: 2, bookQuery: "Biology" }, { t })).confirm).toBeDefined();
  });
  it("a legacy chapter-level document is skipped, exactly as the Library's kit does (credits drop by one)", async () => {
    const t = tables();
    t.generations = [{ id: "ws-1", kind: "worksheet", status: "done", chapter_ref: "1", book_id: BIO, owner_id: TEACHER_ID, params: {} }];
    expect((await prep({ chapterNumber: 2, bookQuery: "Biology" }, { t })).confirm?.params.credits).toBe(5);
  });
  it("unmetered (a school) → no credits_left param", async () => {
    const r = await prep({ chapterNumber: 2, bookQuery: "Biology" }, { fairUse: { unlimited: true } });
    expect(r.confirm?.params).not.toHaveProperty("credits_left");
  });
  it("a book the junk-upload gate flags → the card carries the warning", async () => {
    const t = tables();
    t.books[0].health = { gate: "confirm" };
    const r = await prep({ chapterNumber: 2, bookQuery: "Biology" }, { t, locale: "ms" });
    expect(r.confirm?.params.warning).toBe(lineFor(PREP_GATE_WARNING, "ms"));
    expect(r.confirm?.title).toBe("Sediakan kit: Cell Structure");
  });
  it("nothing said → asks", async () => {
    expect(await prep({})).toMatchObject({ ok: false, error: "chapter required" });
  });
  it("spokenChapterNumber", () => {
    expect(spokenChapterNumber("chapter 3")).toBe(3);
    expect(spokenChapterNumber("bab 4")).toBe(4);
    expect(spokenChapterNumber("الفصل 2")).toBe(2);
    expect(spokenChapterNumber("Specialised Cells")).toBeNull();
  });
});

describe("lesson.status — how the kit is going", () => {
  const gens = (): Rows => [
    { id: "p1", kind: "presentation", status: "processing", title: null, chapter_ref: "2", book_id: BIO, owner_id: TEACHER_ID, params: {}, created_at: "2026-10-28T08:00:00Z", sk_action_id: "act-1" },
    { id: "d1", kind: "worksheet", status: "done", title: null, chapter_ref: "2", book_id: BIO, owner_id: TEACHER_ID, params: {}, created_at: "2026-10-28T08:00:00Z", sk_action_id: "act-1" },
    { id: "d2", kind: "exam_paper", status: "error", title: null, chapter_ref: "2", book_id: BIO, owner_id: TEACHER_ID, params: {}, created_at: "2026-10-28T08:00:00Z", sk_action_id: "act-1" },
    { id: "x1", kind: "presentation", status: "done", title: null, chapter_ref: "0", book_id: BIO, owner_id: OTHER_TEACHER_ID, params: {}, created_at: "2026-10-28T09:00:00Z", sk_action_id: "act-9" },
  ];
  it("groups her SK-started rows by action: the lesson's status and the pieces ready / failed (never another teacher's)", async () => {
    const t = { ...tables(), generations: gens() };
    const r = await lessonStatus.handler(makeCtx(), {}, { session: session(t), now: NOW });
    expect(r.summary).toBe("Specialised Cells: the lesson is being made; 1 of 3 pieces ready, 1 failed.");
    expect(r.facts?.[0]).toMatchObject({ kind: "kit", generation_id: "p1", ready: 1, total: 3, failed: 1, started_by_sk: true });
    expect(r.entities).toEqual([{ kind: "kit", id: "p1", label: "Specialised Cells", via: "lesson.status", ids: [BIO, "2"] }]);
  });
  it("0169 not applied (the column is missing) → falls back to her newest generations", async () => {
    const t = { ...tables(), generations: gens().map(({ sk_action_id: _a, ...g }) => g) };
    const s = session(t, undefined, { code: "42703", message: 'column generations.sk_action_id does not exist' });
    const r = await lessonStatus.handler(makeCtx(), {}, { session: s, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.facts?.[0]).toMatchObject({ generation_id: "p1", started_by_sk: false });
    expect(s.log.filter((l) => l.startsWith("generations.select("))).toHaveLength(2);
    expect(missingActionColumn({ code: "PGRST204" })).toBe(true);
    expect(missingActionColumn({ code: "42501", message: "permission denied" })).toBe(false);
  });
  it("nothing being made → says so", async () => {
    const r = await lessonStatus.handler(makeCtx(), {}, { session: session(tables()), now: NOW });
    expect(r).toMatchObject({ ok: true, summary: "You have no kits being made right now." });
  });
});
