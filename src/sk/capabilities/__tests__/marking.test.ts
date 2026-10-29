/**
 * S2 slice B: `marking.next` (the oldest pending submission on HER OWN kits —
 * the fake ignores filters, so leaked foreign rows test the belt — narrowed by
 * class / learner / kit, with the count left and an empty-queue line) and the
 * `marking.grade` resolver (the latest `submission` entity, asks without one,
 * score bounds, out-of rules, the card's exact params; it never writes).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/marking.test.ts
 */
import { describe, expect, it } from "vitest";
import { answersSummary, markingGrade, markingNext, resolveMarkingGrade, resolveMarkingNext } from "../marking";
import { metaAllows } from "@/sk/shell/registry";
import { MARK_ALREADY_GRADED, MARK_EMPTY } from "@/sk/shell/act-lines";
import { lineFor } from "@/sk/shell/lines";
import type { ResolvedEntity } from "@/sk/shell/types";
import { NOW, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx, type Rows } from "@/sk/shell/__tests__/fixtures";

const S1 = "5b000000-0000-4000-8000-000000000001"; // Ali, worksheet — oldest
const S2 = "5b000000-0000-4000-8000-000000000002"; // Siti, test paper
const S3 = "5b000000-0000-4000-8000-000000000003"; // Mei (7C), worksheet
const S4 = "5b000000-0000-4000-8000-000000000004"; // Zara: FOREIGN kit (leaked by RLS)
const S5 = "5b000000-0000-4000-8000-000000000005"; // already graded

const tables = (): Record<string, Rows> => ({
  classes: [
    { id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c7c", name: "7C", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c9x", name: "9X", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID },
  ],
  enrollments: [
    { class_id: "c7b", student_id: "s-ali", profiles: { full_name: "Ali Hassan" } },
    { class_id: "c7b", student_id: "s-siti", profiles: { full_name: "Siti Aminah" } },
    { class_id: "c7c", student_id: "s-mei", profiles: { full_name: "Mei Ling" } },
    { class_id: "c9x", student_id: "s-zara", profiles: { full_name: "Zara Foreign" } },
  ],
  submissions: [
    // Out of order on purpose: the handler sorts oldest first itself.
    { id: S3, generation_id: "g-ws", student_id: "s-mei", mode: "file", grade_status: "pending", auto_score: null, max_score: null, answers: null, submitted_at: "2026-10-27T03:00:00Z" },
    { id: S2, generation_id: "g-test", student_id: "s-siti", mode: "interactive", grade_status: "pending", auto_score: 6, max_score: 10, answers: { q1: "Mitochondria", q2: true, q3: "It makes energy for the cell" }, submitted_at: "2026-10-27T02:00:00Z" },
    { id: S1, generation_id: "g-ws", student_id: "s-ali", mode: "file", grade_status: "pending", auto_score: null, max_score: null, answers: null, submitted_at: "2026-10-27T01:00:00Z" },
    { id: S4, generation_id: "g-foreign", student_id: "s-zara", mode: "file", grade_status: "pending", auto_score: null, max_score: null, answers: null, submitted_at: "2026-10-26T01:00:00Z" },
    { id: S5, generation_id: "g-ws", student_id: "s-ali", mode: "file", grade_status: "graded", auto_score: null, max_score: 10, answers: null, submitted_at: "2026-10-25T01:00:00Z" },
  ],
  generations: [
    { id: "g-ws", kind: "worksheet", title: null, chapter_ref: "1", book_id: "b-bio", owner_id: TEACHER_ID },
    { id: "g-test", kind: "exam_paper", title: "Cells test", chapter_ref: "1", book_id: "b-bio", owner_id: TEACHER_ID },
    { id: "g-foreign", kind: "worksheet", title: "Foreign worksheet", chapter_ref: "0", book_id: null, owner_id: OTHER_TEACHER_ID },
  ],
  books: [{ id: "b-bio", title: "Biology", chapters: [{ num: 1, title: "Plant and Animal Cells" }] }],
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function readOnly(t: Record<string, Rows>) {
  const s = fakeSession(t);
  return {
    ...s,
    from: (table: string) => {
      const b: any = s.from(table);
      for (const m of ["insert", "update", "upsert", "delete"]) {
        b[m] = () => {
          throw new Error(`marking resolver wrote to ${table}`);
        };
      }
      return b;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ctxWith = (o: { locale?: string; entities?: ResolvedEntity[] } = {}) => {
  const ctx = makeCtx({ locale: o.locale });
  return o.entities ? { ...ctx, recent: { ...ctx.recent, entities: o.entities } } : ctx;
};
const next = (args: Record<string, unknown> = {}, o: { t?: Record<string, Rows>; locale?: string } = {}) =>
  resolveMarkingNext(ctxWith({ locale: o.locale }), args, { session: readOnly(o.t ?? tables()), now: NOW });

describe("marking.next — the queue", () => {
  it("is a teacher-hat read", () => {
    expect(markingNext.meta).toMatchObject({ tier: "immediate", kind: "read", roles: ["teacher"], hats: ["teacher"] });
    expect(metaAllows(markingNext.meta, makeCtx({ role: "student", hat: null }))).toBe(false);
    expect(metaAllows(markingNext.meta, makeCtx({ hat: "parent" }))).toBe(false);
  });
  it("oldest first, own kits only (a leaked foreign submission never surfaces), graded rows excluded, with the count left", async () => {
    const r = await next();
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Ali Hassan's worksheet, Plant and Animal Cells — 2 more after this.");
    expect(r.facts?.[0]).toMatchObject({ kind: "submission", id: S1, learner: "Ali Hassan", kit: "Plant and Animal Cells", kit_kind: "worksheet", remaining_after: 2, answers: "(uploaded a file)" });
    expect(r.entities).toEqual([{ kind: "submission", id: S1, label: "Ali Hassan's worksheet — Plant and Animal Cells", via: "marking.next", ids: ["g-ws", "s-ali"] }]);
    expect(JSON.stringify(r)).not.toContain("Zara");
  });
  it("narrowed to a class (7C) → Mei's, the last one", async () => {
    const r = await next({ classQuery: "7C" });
    expect(r.summary).toBe("Mei Ling's worksheet, Plant and Animal Cells — the last one to mark.");
  });
  it("narrowed to a learner (Siti) → her test paper with her own answers, short", async () => {
    const r = await next({ learnerQuery: "Siti" });
    expect(r.summary).toBe("Siti Aminah's test paper, Cells test — the last one to mark.");
    expect(r.facts?.[0]).toMatchObject({ id: S2, answers: "Mitochondria; true; It makes energy for the cell", auto_score: 6, max_score: 10 });
  });
  it("narrowed to a kind ('test') or a kit title", async () => {
    expect((await next({ kitQuery: "test" })).facts?.[0]).toMatchObject({ id: S2 });
    expect((await next({ kitQuery: "Plant and Animal" })).facts?.[0]).toMatchObject({ id: S1, remaining_after: 1 });
  });
  it("skipId passes over one", async () => {
    expect((await next({ skipId: S1 })).facts?.[0]).toMatchObject({ id: S2 });
  });
  it("an empty queue → the caught-up line (localized), a grounded fact, no entity", async () => {
    const t = tables();
    t.submissions = [];
    const r = await next({}, { t, locale: "ms" });
    expect(r).toMatchObject({ ok: true, summary: lineFor(MARK_EMPTY, "ms"), entities: [] });
    expect(r.facts).toEqual([{ kind: "marking.queue", remaining: 0 }]);
    const r2 = await next({ classQuery: "7C" }, { t });
    expect(r2.summary).toBe(`${lineFor(MARK_EMPTY, "en")} (7C)`);
  });
  it("a class that is not hers → not found", async () => {
    expect((await next({ classQuery: "9X" })).ok).toBe(false);
  });
  it("answersSummary keeps only the learner's answers and truncates", () => {
    expect(answersSummary("file", null)).toBe("(uploaded a file)");
    expect(answersSummary("interactive", {})).toBe("(no answers)");
    const long = answersSummary("interactive", { a: "x".repeat(400) });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
    expect(answersSummary("interactive", { m: { 0: "A", 1: "B" }, c: ["x", "y"] })).toBe("A, B; x, y");
  });
});

describe("marking.grade — the resolver (card only, never writes)", () => {
  const latest = (id: string): ResolvedEntity[] => [{ kind: "submission", id, label: "x", via: "marking.next" }];
  const grade = (args: Record<string, unknown>, o: { entities?: ResolvedEntity[]; t?: Record<string, Rows>; locale?: string } = {}) =>
    resolveMarkingGrade(ctxWith({ entities: o.entities, locale: o.locale }), args, { session: readOnly(o.t ?? tables()), now: NOW });

  it("is a teacher-hat confirm act", () => {
    expect(markingGrade.meta).toMatchObject({ tier: "confirm", kind: "act", roles: ["teacher"], hats: ["teacher"] });
  });
  it("'give it 7 out of 10, good work on part 2' → the card for the latest submission entity, exact params", async () => {
    const r = await grade({ score: 7, outOf: 10, feedback: "Good work on part 2." }, { entities: latest(S1) });
    expect(r.ok).toBe(true);
    expect(r.confirm).toEqual({
      action: "marking.grade",
      title: "Grade Ali Hassan's worksheet",
      params: { submission_id: S1, score: 7, out_of: 10, feedback: "Good work on part 2.", learner_label: "Ali Hassan", kit_title: "Plant and Animal Cells" },
    });
  });
  it("no submission in the conversation → asks, no card", async () => {
    const r = await grade({ score: 7, outOf: 10 });
    expect(r.ok).toBe(false);
    expect(r.confirm).toBeUndefined();
    expect(r.error).toBe("submission required");
  });
  it("a file with no 'out of' → asks what it is out of", async () => {
    const r = await grade({ score: 7 }, { entities: latest(S1) });
    expect(r).toMatchObject({ ok: false, error: "out_of required" });
  });
  it("an interactive quiz uses its own total; a different 'out of' is refused", async () => {
    const own = await grade({ score: 8 }, { entities: latest(S2) });
    expect(own.confirm?.params).toMatchObject({ submission_id: S2, score: 8, out_of: 10, feedback: null, kit_title: "Cells test" });
    expect(own.confirm?.title).toBe("Grade Siti Aminah's test paper");
    const other = await grade({ score: 8, outOf: 20 }, { entities: latest(S2) });
    expect(other).toMatchObject({ ok: false, error: "out_of_mismatch" });
  });
  it.each([
    [{ score: 11, outOf: 10 }, "bad_score"],
    [{ score: -1, outOf: 10 }, "bad_score"],
    [{ score: 7, outOf: 0 }, "bad_out_of"],
    [{ score: 7, outOf: 7.5 }, "bad_out_of"],
    [{ score: "seven", outOf: 10 }, "score required"],
  ])("bounds: %j → no card (%s)", async (args, error) => {
    const r = await grade(args, { entities: latest(S1) });
    expect(r.confirm).toBeUndefined();
    expect(r.error).toBe(error);
  });
  it("already graded → says so, no card", async () => {
    const r = await grade({ score: 7, outOf: 10 }, { entities: latest(S5) });
    expect(r).toMatchObject({ ok: false, summary: lineFor(MARK_ALREADY_GRADED, "en"), error: "already_graded" });
  });
  it("a submission on someone else's kit → not found, no card", async () => {
    const r = await grade({ score: 7, outOf: 10 }, { entities: latest(S4) });
    expect(r).toMatchObject({ ok: false, error: "submission_not_found" });
  });
  it("in Arabic: the card title is the locale's", async () => {
    const r = await grade({ score: 7, outOf: 10 }, { entities: latest(S1), locale: "ar" });
    expect(r.confirm?.title).toBe("قيّم ورقة عمل Ali Hassan");
  });
});
