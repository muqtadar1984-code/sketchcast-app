/**
 * S2 slice B execution, through executeAction: `marking.grade` (GradeList's own
 * update row, a `grade_status = 'pending'` guard, RLS refusals) and
 * `lesson.prepare` (CLICK-ONLY; the Library's kitRows inserted through the
 * USER-SESSION client — the admin fake throws on any table but the tokens —
 * each row carrying sk_action_id; every trigger refusal mapped to one line).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-s2b.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACT_CLICK_ONLY_LINE, ACT_LINES, HANDLERS, executeAction, type ActInput } from "../act";
import {
  ACT_WRITE_FAILED,
  MARK_ALL_DONE,
  MARK_ALREADY_GRADED,
  PREP_BOOK_BUSY,
  PREP_EXISTS,
  PREP_JUST_STARTED,
  PREP_NO_ACCESS,
  PREP_NO_CREDITS,
  PREP_NOT_ON_SHELF,
  PREP_STARTED,
  PREP_TRIAL,
} from "../act-lines";
import { prepRefusal } from "../act-prepare";
import { lineFor } from "../lines";
import { MemoryAuditSink } from "../audit";
import { freshMemory } from "../memory";
import type { ActionParams } from "../tokens";
import { buildGradeUpdate } from "@/app/dashboard/grade-update";
import { kitCredits, kitRows } from "@/app/dashboard/kit";
import { defaultNarrationForGrade } from "@/utils/narration";
import { NOW, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, makeCtx } from "./fixtures";
import { ACT_SECRET, ALI, BOOK, CLASS_7B, GEN, SITI, SUB, SUB2, diarySession, signedRow, statefulAdmin, type DiarySessionOpts } from "./act-fakes";

const ID = "66666666-6666-4666-8666-666666666666";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.SK_SHELL_SECRET = process.env.SK_SHELL_SECRET;
  process.env.SK_SHELL_SECRET = ACT_SECRET;
});
afterEach(() => {
  if (saved.SK_SHELL_SECRET === undefined) delete process.env.SK_SHELL_SECRET;
  else process.env.SK_SHELL_SECRET = saved.SK_SHELL_SECRET;
});

type Tables = Record<string, Array<Record<string, unknown>>>;
const sub = (id: string, student: string, over: Record<string, unknown> = {}) => ({
  id,
  generation_id: GEN,
  student_id: student,
  mode: "file",
  grade_status: "pending",
  auto_score: null,
  max_score: null,
  answers: null,
  submitted_at: id === SUB ? "2026-10-27T01:00:00.000Z" : "2026-10-27T02:00:00.000Z",
  ...over,
});
const tables = (): Tables => ({
  classes: [{ id: CLASS_7B, name: "7B", teacher_id: TEACHER_ID }],
  enrollments: [
    { class_id: CLASS_7B, student_id: ALI, profiles: { full_name: "Ali Hassan" } },
    { class_id: CLASS_7B, student_id: SITI, profiles: { full_name: "Siti Aminah" } },
  ],
  submissions: [sub(SUB, ALI), sub(SUB2, SITI)],
  generations: [{ id: GEN, kind: "worksheet", title: "Plant and Animal Cells", chapter_ref: "1", book_id: null, owner_id: TEACHER_ID, params: null, status: "done" }],
  books: [{ id: BOOK, title: "Biology", subject: "Science", grade: "Form 4", language: "en", status: "ready", owner_id: TEACHER_ID, school_id: SCHOOL_ID, chapters: [{ num: 2, title: "Specialised Cells", parts: [] }], health: null }],
});

function world(action: string, params: ActionParams, o: { t?: Tables; session?: DiarySessionOpts; via?: "click" | "voice"; locale?: string } = {}) {
  const ctx = makeCtx({ locale: o.locale });
  const { row, token } = signedRow({ id: ID, action, params, contextHash: ctx.contextHash });
  const admin = statefulAdmin({ [ID]: row });
  const session = diarySession(o.t ?? tables(), o.session);
  const sink = new MemoryAuditSink();
  const input: ActInput = { ctx, token, via: o.via ?? "click", turnId: "t-1", now: NOW, memory: freshMemory(ctx, NOW), admin, session, sink };
  return { ctx, admin, session, sink, input, run: () => executeAction(input) };
}
const consumed = (admin: ReturnType<typeof statefulAdmin>) => admin.calls.filter((c) => c.fn === "sk_consume_action_token").length;

// ── marking.grade ────────────────────────────────────────────────────────────

const GRADE: ActionParams = { submission_id: SUB, score: 7, out_of: 10, feedback: "Good work on part 2.", learner_label: "Ali Hassan", kit_title: "Plant and Animal Cells" };

describe("marking.grade — execution", () => {
  it("is registered as a confirm-tier act, NOT click-only (a spoken yes may confirm)", () => {
    expect(HANDLERS["marking.grade"]).toMatchObject({ tier: "confirm", kind: "act" });
    expect(HANDLERS["marking.grade"].clickOnly).toBeFalsy();
  });
  it("writes GradeList's own row (buildGradeUpdate) with the pending guard, then offers the next one", async () => {
    const w = world("marking.grade", GRADE);
    const out = await w.run();
    expect(out.response.outcome).toBe("done");
    expect(out.response.summary).toBe("Graded Ali Hassan: 7/10. Next: Siti Aminah's worksheet — say “next one” to see it.");
    const built = buildGradeUpdate({ mode: "file", max: null }, { score: "7", outOf: "10", feedback: "Good work on part 2." }, TEACHER_ID, NOW);
    expect(built.ok).toBe(true);
    expect(w.session.updates).toEqual([{ table: "submissions", patch: (built as { update: unknown }).update, ids: [SUB] }]);
    expect(w.session.log).toContain('submissions.eq("grade_status","pending")');
    expect(w.session.log).toContain('submissions.eq("id","5b000000-0000-4000-8000-000000000021")');
    expect(out.response.result).toMatchObject({ submission_id: SUB, score: 7, out_of: 10, next_submission_id: SUB2 });
    // The next one is remembered: "give it 8 out of 10" resolves to Siti's.
    expect(out.memory.entities[0]).toMatchObject({ kind: "submission", id: SUB2 });
    expect(w.sink.rows[0]).toMatchObject({ action: "marking.grade", tier: "confirm", kind: "act", ok: true });
  });
  it("a spoken yes confirms it (not click-only)", async () => {
    expect((await world("marking.grade", GRADE, { via: "voice" }).run()).response.outcome).toBe("done");
  });
  it("the last one in the queue: says so", async () => {
    const t = tables();
    t.submissions = [sub(SUB, ALI)];
    expect((await world("marking.grade", GRADE, { t }).run()).response.summary).toBe(`Graded Ali Hassan: 7/10. ${lineFor(MARK_ALL_DONE, "en")}`);
  });
  it("in Malay: the lines are the locale's", async () => {
    const out = await world("marking.grade", GRADE, { locale: "ms" }).run();
    expect(out.response.summary).toBe("Ali Hassan telah digred: 7/10. Seterusnya: Lembaran kerja Siti Aminah — sebut “yang seterusnya” untuk melihatnya.");
  });
  it("already graded at execution → already_used, “That one is already graded.”, nothing written", async () => {
    const t = tables();
    t.submissions = [sub(SUB, ALI, { grade_status: "graded" })];
    const w = world("marking.grade", GRADE, { t });
    expect((await w.run()).response).toEqual({ ok: false, outcome: "already_used", summary: lineFor(MARK_ALREADY_GRADED, "en") });
    expect(w.session.updates).toEqual([]);
    expect(w.sink.rows[0].error).toBe("already_used:already_graded");
  });
  it("graded in between (the guarded update matches 0 rows) → already_used", async () => {
    const t = tables();
    const w = world("marking.grade", GRADE, { t });
    // Someone else grades it after the read, before the update: the guard finds nothing.
    const real = w.session.from;
    w.session.from = (table: string) => {
      const b = real(table);
      if (table === "submissions") {
        const update = b.update;
        b.update = (patch: Record<string, unknown>) => {
          t.submissions[0].grade_status = "graded";
          return update(patch);
        };
      }
      return b;
    };
    expect((await w.run()).response).toEqual({ ok: false, outcome: "already_used", summary: lineFor(MARK_ALREADY_GRADED, "en") });
    expect(w.session.updates[0].ids).toEqual([]);
  });
  it("RLS refuses the update (42501) → refused", async () => {
    const w = world("marking.grade", GRADE, { session: { updateError: { code: "42501", message: "permission denied for table submissions" } } });
    const out = await w.run();
    expect(out.response).toMatchObject({ ok: false, outcome: "refused", summary: ACT_LINES.refused });
    expect(w.sink.rows[0].error).toMatch(/^refused:not_permitted/);
  });
  it("a submission she cannot see, or on someone else's kit → refused, nothing written", async () => {
    const hidden = tables();
    hidden.submissions = [];
    const a = world("marking.grade", GRADE, { t: hidden });
    expect((await a.run()).response.outcome).toBe("refused");
    const foreign = tables();
    foreign.generations = [{ id: GEN, kind: "worksheet", title: "x", owner_id: OTHER_TEACHER_ID }];
    const b = world("marking.grade", GRADE, { t: foreign });
    expect((await b.run()).response.outcome).toBe("refused");
    expect(a.session.updates).toEqual([]);
    expect(b.session.updates).toEqual([]);
  });
  it.each([
    ["score above out_of", { ...GRADE, score: 11 }],
    ["negative score", { ...GRADE, score: -1 }],
    ["out_of 0", { ...GRADE, out_of: 0, score: 0 }],
    ["out_of not a whole number (max_score is an integer column)", { ...GRADE, out_of: 7.5 }],
    ["no submission id", { ...GRADE, submission_id: "nope" }],
  ])("bounds checked BEFORE the consume: %s → refused bad_params, nothing consumed", async (_n, params) => {
    const w = world("marking.grade", params as ActionParams);
    expect((await w.run()).response).toMatchObject({ ok: false, outcome: "refused", result: { reason: "bad_params" } });
    expect(consumed(w.admin)).toBe(0);
    expect(w.session.updates).toEqual([]);
  });
  it("an interactive quiz keeps its own total: a card 'out of' that differs → refused", async () => {
    const t = tables();
    t.submissions = [sub(SUB, ALI, { mode: "interactive", max_score: 20, auto_score: 12 })];
    const w = world("marking.grade", GRADE, { t });
    expect((await w.run()).response.outcome).toBe("refused");
    expect(w.session.updates).toEqual([]);
  });
  it("an interactive quiz graded out of its own total: no max_score in the patch (never overwritten)", async () => {
    const t = tables();
    t.submissions = [sub(SUB, ALI, { mode: "interactive", max_score: 10, auto_score: 6 })];
    const w = world("marking.grade", GRADE, { t });
    expect((await w.run()).response.outcome).toBe("done");
    expect(w.session.updates[0].patch).not.toHaveProperty("max_score");
  });
});

// ── lesson.prepare ───────────────────────────────────────────────────────────

const PREP: ActionParams = { book_id: BOOK, chapter_ref: "2", chapter_title: "Specialised Cells", book_title: "Biology", credits: 6, credits_left: 18, click_only: true };

describe("lesson.prepare — execution", () => {
  it("is click-only (its handler flag and the CLICK_ONLY set)", () => {
    expect(HANDLERS["lesson.prepare"]).toMatchObject({ tier: "confirm", kind: "act", clickOnly: true });
  });
  it("a spoken yes is refused as click-only: nothing consumed, nothing inserted, the card stays valid", async () => {
    const w = world("lesson.prepare", PREP, { via: "voice" });
    expect((await w.run()).response).toEqual({ ok: false, outcome: "refused", summary: ACT_CLICK_ONLY_LINE });
    expect(w.admin.calls).toEqual([]);
    expect(w.session.generations).toEqual([]);
    // …and the click still works.
    const again = await executeAction({ ...w.input, via: "click" });
    expect(again.response.outcome).toBe("done");
  });
  it("a click inserts the Library's kitRows through the SESSION client, each carrying sk_action_id (never the admin client)", async () => {
    const w = world("lesson.prepare", PREP);
    const out = await w.run();
    expect(out.response).toMatchObject({ ok: true, outcome: "done", summary: lineFor(PREP_STARTED, "en", { chapter: "Specialised Cells" }) });
    const expected = kitRows({ bookId: BOOK, schoolId: SCHOOL_ID, userId: TEACHER_ID, chapterNum: 2, language: "en", narrationStyle: defaultNarrationForGrade("Form 4") });
    expect(w.session.generations.map((g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== "id")))).toEqual(expected.map((r) => ({ ...r, sk_action_id: ID })));
    expect(w.session.generations[0].kind).toBe("presentation"); // the lesson FIRST — load-bearing for the docs guard
    expect(kitCredits(expected)).toBe(6);
    expect(out.response.result).toMatchObject({ generation_id: "gen-1", book_id: BOOK, chapter_ref: "2", credits: 6 });
    expect(out.memory.entities[0]).toMatchObject({ kind: "kit", id: "gen-1", label: "Specialised Cells" });
    // The admin fake throws on any table but sk_action_tokens: reaching here proves it was never used for the insert.
    expect(w.admin.calls.map((c) => c.fn)).toEqual(["sk_consume_action_token"]);
  });
  it.each([
    ["duplicate_guard (23505 with its sentence)", { code: "23505", message: "That kit is already being made — give it a moment to appear." }, PREP_JUST_STARTED],
    ["the trial pin (already started)", { code: "P0001", message: "Your free trial includes the full kit (all seven content types) for one part of one chapter, and yours is already started. Upgrade to unlock the rest of the book." }, PREP_TRIAL],
    ["the trial pin (multi-part chapter)", { code: "P0001", message: "This chapter has 3 parts. Your free trial includes the full kit for one part — use a part row to generate." }, PREP_TRIAL],
    ["the console chapter cap", { code: "P0001", message: "Your plan is limited to 1 chapter(s). You can generate every content type for the chapter(s) you already picked." }, PREP_TRIAL],
    ["fair use (monthly)", { code: "P0001", message: "Monthly limit reached: your plan includes 24 generations/month (+0 carried over) — a lesson, a worksheet, a plan, an activity, a test paper and a case study each count as one. It resets on the 1st, or upgrade for more." }, PREP_NO_CREDITS],
    ["fair use (promo trial)", { code: "P0001", message: "Your free trial includes 6 generations with every feature unlocked, and you've used them all. Subscribe to keep generating." }, PREP_NO_CREDITS],
    ["can_use_book / gen_write (RLS)", { code: "42501", message: 'new row violates row-level security policy for table "generations"' }, PREP_NOT_ON_SHELF],
    ["the part-map guard", { code: "55000", message: "This book is being re-read right now — try again in a few minutes, once its chapters reappear." }, PREP_BOOK_BUSY],
    ["lesson tools off", { code: "P0001", message: "Lesson tools are not enabled on this account — SketchCast manages teacher tool access. Contact support." }, PREP_NO_ACCESS],
    ["a suspended school", { code: "P0001", message: "Your school's SketchCast access is suspended. Please contact support." }, PREP_NO_ACCESS],
  ])("a trigger refusal — %s → refused with its plain line, the DB's words in the audit only", async (_n, error, line) => {
    const w = world("lesson.prepare", PREP, { session: { insertError: error } });
    const out = await w.run();
    expect(out.response).toMatchObject({ ok: false, outcome: "refused", summary: lineFor(line, "en") });
    expect(out.response.summary).not.toBe(error.message);
    expect(w.sink.rows[0].error).toContain(error.message.slice(0, 30));
  });
  it("0169's unique index (23505, not the guard's sentence) → already_used", async () => {
    const w = world("lesson.prepare", PREP, { session: { insertError: { code: "23505", message: 'duplicate key value violates unique constraint "generations_sk_action_kind_part_uidx"' } } });
    expect((await w.run()).response).toEqual({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
  });
  it("an unknown DB error → error, the write-failed line", async () => {
    const w = world("lesson.prepare", PREP, { session: { insertError: { code: "XX000", message: "boom" } } });
    expect((await w.run()).response).toEqual({ ok: false, outcome: "error", summary: lineFor(ACT_WRITE_FAILED, "en") });
  });
  it("she made the kit in the meantime → already_used, “You already have that kit”, nothing inserted", async () => {
    const t = tables();
    t.generations.push({ id: "p-1", kind: "presentation", status: "done", chapter_ref: "2", book_id: BOOK, owner_id: TEACHER_ID, params: {} });
    const w = world("lesson.prepare", PREP, { t });
    expect((await w.run()).response).toEqual({ ok: false, outcome: "already_used", summary: lineFor(PREP_EXISTS, "en") });
    expect(w.session.generations).toEqual([]);
  });
  it("the credits changed since the card (the chapter was split into parts) → refused, nothing inserted", async () => {
    const t = tables();
    (t.books[0].chapters as Array<Record<string, unknown>>)[0].parts = [{}, {}, {}];
    const w = world("lesson.prepare", PREP, { t });
    expect((await w.run()).response).toMatchObject({ ok: false, outcome: "refused", result: { reason: "credits_changed" } });
    expect(w.session.generations).toEqual([]);
  });
  it("the book left her shelf → refused, “That book isn't on your shelf.”", async () => {
    const t = tables();
    t.books = [];
    const w = world("lesson.prepare", PREP, { t });
    expect((await w.run()).response).toMatchObject({ ok: false, outcome: "refused", summary: lineFor(PREP_NOT_ON_SHELF, "en") });
  });
  it("a gated book: the card's warning was the confirmation, every row is stamped; no warning on the card → refused", async () => {
    const t = tables();
    t.books[0].health = { gate: "confirm", problems: ["Looks like a worksheet, not a textbook."] };
    const warned = world("lesson.prepare", { ...PREP, warning: "This upload may not be a textbook — the kit may come out poorly." }, { t });
    expect((await warned.run()).response.outcome).toBe("done");
    expect(warned.session.generations.every((g) => !!(g.params as Record<string, unknown>).junk_gate)).toBe(true);
    const t2 = tables();
    t2.books[0].health = { gate: "confirm" };
    const unwarned = world("lesson.prepare", PREP, { t: t2 });
    expect((await unwarned.run()).response).toMatchObject({ outcome: "refused", result: { reason: "gate_changed" } });
    expect(unwarned.session.generations).toEqual([]);
  });
  it.each([
    ["no click_only marker", { ...PREP, click_only: false }],
    ["credits not a positive whole number", { ...PREP, credits: 0 }],
    ["chapter_ref not a number", { ...PREP, chapter_ref: "three" }],
    ["book id not an id", { ...PREP, book_id: "biology" }],
  ])("malformed params (%s) → refused bad_params before the consume", async (_n, params) => {
    const w = world("lesson.prepare", params as ActionParams);
    expect((await w.run()).response).toMatchObject({ outcome: "refused", result: { reason: "bad_params" } });
    expect(consumed(w.admin)).toBe(0);
  });
});

describe("prepRefusal — the mapping table", () => {
  it("checks the guard's sentence before 0169's index (both are 23505)", () => {
    expect(prepRefusal({ code: "23505", message: "That kit is already being made — give it a moment to appear." })).toMatchObject({ outcome: "refused", reason: "duplicate_guard" });
    expect(prepRefusal({ code: "23505", message: "duplicate key" })).toMatchObject({ outcome: "already_used", reason: "duplicate" });
    expect(prepRefusal({ code: "P0001", message: "Regeneration limit: this document type was already generated 3 times this month for this lesson." })).toMatchObject({ outcome: "refused", reason: "regeneration_limit" });
    expect(prepRefusal({ code: "XX000", message: "boom" })).toMatchObject({ outcome: "error" });
  });
});
