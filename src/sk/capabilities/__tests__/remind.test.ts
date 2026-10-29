/**
 * `parents.remind` resolver (S2 slice A): the share from an explicit id or the
 * conversation's last `not-done:<shareId>` entity, the not-done learners
 * re-read through the session (own class only, the analytics definition), the
 * 40-family cap, the default message with NO child names, a dictated message
 * that names a learner refused, the exact flat card — and no writes.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/remind.test.ts
 */
import { describe, expect, it } from "vitest";
import { REMIND_MAX, namesALearner, parentsRemindAction, resolveParentsRemind, shareIdFor } from "../remind";
import { metaAllows } from "@/sk/shell/registry";
import type { ResolvedEntity } from "@/sk/shell/types";
import { NOW, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx, type Rows } from "@/sk/shell/__tests__/fixtures";
import { AHMAD, ALI, CLASS_7B, FOREIGN_CLASS, GEN, SHARE, SITI } from "@/sk/shell/__tests__/act-fakes";

const share = (over: Record<string, unknown> = {}) => ({
  id: SHARE,
  generation_id: GEN,
  class_id: CLASS_7B,
  due_at: "2026-10-30T09:00:00.000Z",
  created_at: "2026-10-20T00:00:00Z",
  generations: { kind: "worksheet", chapter_ref: null, title: "Cells worksheet" },
  ...over,
});
const tables = (): Record<string, Rows> => ({
  classes: [
    { id: CLASS_7B, name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: FOREIGN_CLASS, name: "9X", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID },
  ],
  generation_shares: [share()],
  enrollments: [
    { class_id: CLASS_7B, student_id: ALI, profiles: { full_name: "Ali Hassan" } },
    { class_id: CLASS_7B, student_id: SITI, profiles: { full_name: "Siti Aminah" } },
    { class_id: CLASS_7B, student_id: AHMAD, profiles: { full_name: "Ahmad Zaki" } },
    { class_id: FOREIGN_CLASS, student_id: "f0000000-0000-4000-8000-000000000099", profiles: { full_name: "Zara Foreign" } },
  ],
  student_progress: [{ generation_id: GEN, student_id: AHMAD, status: "completed" }],
  submissions: [],
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function readOnlySession(t = tables()) {
  const s = fakeSession(t);
  return {
    ...s,
    from: (table: string) => {
      const b: any = s.from(table);
      for (const m of ["insert", "update", "upsert", "delete"]) {
        b[m] = () => {
          throw new Error(`parents.remind wrote to ${table}`);
        };
      }
      return b;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const notDoneEntity: ResolvedEntity = { kind: "learners", id: `not-done:${SHARE}`, label: "Not done — Cells worksheet (7B)", via: "assignments.status", ids: [ALI, SITI] };
function run(args: Record<string, unknown>, o: { locale?: string; t?: Record<string, Rows>; recent?: ResolvedEntity[] } = {}) {
  const ctx = makeCtx({ locale: o.locale });
  ctx.recent = { ...ctx.recent, entities: o.recent ?? [] };
  return resolveParentsRemind(ctx, args, { session: readOnlySession(o.t), now: NOW });
}

describe("which assignment", () => {
  it("an explicit share id, a `not-done:` id, or the most recent not-done list in memory", () => {
    const ctx = makeCtx();
    expect(shareIdFor(ctx, { shareId: SHARE })).toBe(SHARE);
    expect(shareIdFor(ctx, { shareId: `not-done:${SHARE}` })).toBe(SHARE);
    expect(shareIdFor(ctx, {})).toBeNull();
    ctx.recent = { ...ctx.recent, entities: [{ kind: "class", id: CLASS_7B, label: "7B", via: "x" }, notDoneEntity] };
    expect(shareIdFor(ctx, {})).toBe(SHARE);
    expect(shareIdFor(ctx, { shareId: "garbage" })).toBe(SHARE);
  });
  it("nothing to go on → asks which assignment", async () => {
    expect(await run({})).toMatchObject({ ok: false, error: "share required" });
  });
});

describe("the card", () => {
  it("re-reads the not-done learners (Ahmad finished) and issues one flat card; the default message names no child", async () => {
    const r = await run({ shareId: SHARE });
    expect(r.ok).toBe(true);
    expect(r.confirm?.action).toBe("parents.remind");
    expect(r.confirm?.title).toBe("Remind the parents of 2 learners in 7B");
    const p = r.confirm!.params;
    expect(p).toMatchObject({ share_id: SHARE, generation_id: GEN, class_id: CLASS_7B, student_ids: `${ALI},${SITI}`, count: 2, class_name: "7B", kit_title: "Cells worksheet" });
    for (const v of Object.values(p)) expect(["string", "number", "boolean"]).toContain(typeof v);
    expect(String(p.body)).toMatch(/^Reminder: "Cells worksheet" is not done yet — due .*30.*\. Please encourage your child to finish it\.$/);
    for (const name of ["Ali", "Siti", "Ahmad", "Hassan", "Aminah"]) expect(String(p.body)).not.toContain(name);
    expect(r.facts?.[0]).toMatchObject({ count: 2, learners: "Ali Hassan, Siti Aminah" });
  });
  it("'remind their parents' — the memory's not-done entity — gives the same card", async () => {
    const a = await run({ shareId: SHARE });
    const b = await run({}, { recent: [notDoneEntity] });
    expect(b.confirm).toEqual(a.confirm);
  });
  it("one learner → the singular title; no due date → the no-due message", async () => {
    const t = tables();
    t.student_progress = [AHMAD, SITI].map((s) => ({ generation_id: GEN, student_id: s, status: "completed" }));
    t.generation_shares = [share({ due_at: null })];
    const r = await run({ shareId: SHARE }, { t });
    expect(r.confirm?.title).toBe("Remind the parents of 1 learner in 7B");
    expect(r.confirm?.params.body).toBe('Reminder: "Cells worksheet" is not done yet. Please encourage your child to finish it.');
  });
  it("the teacher's language: Malay title and message", async () => {
    const r = await run({ shareId: SHARE }, { locale: "ms" });
    expect(r.confirm?.title).toBe("Ingatkan ibu bapa 2 murid dalam 7B");
    expect(String(r.confirm?.params.body)).toMatch(/^Peringatan: "Cells worksheet" belum disiapkan — tarikh akhir .+\. Sila galakkan anak anda untuk menyiapkannya\.$/);
  });
  it("a dictated message replaces the default ('change the message to …' re-issues the card)", async () => {
    const r = await run({ shareId: SHARE, body: "Please make sure the worksheet is handed in by Friday." });
    expect(r.confirm?.params.body).toBe("Please make sure the worksheet is handed in by Friday.");
  });
  it("a dictated message that names a learner of the class is refused — the same text goes to every family", async () => {
    expect(await run({ shareId: SHARE, body: "Siti must finish the worksheet." })).toMatchObject({ ok: false, error: "body_names_learner" });
    expect(await run({ shareId: SHARE, body: "Tell Ahmad Zaki to hurry." })).toMatchObject({ ok: false, error: "body_names_learner" });
    // a word that merely contains a name is fine
    expect((await run({ shareId: SHARE, body: "Alice in Wonderland is next." })).confirm).toBeDefined();
  });
});

describe("refusals and empty cases", () => {
  it("everyone finished → no card, says so", async () => {
    const t = tables();
    t.student_progress = [ALI, SITI, AHMAD].map((s) => ({ generation_id: GEN, student_id: s, status: "completed" }));
    const r = await run({ shareId: SHARE }, { t });
    expect(r.confirm).toBeUndefined();
    expect(r.summary).toBe("Everyone in 7B has finished Cells worksheet — no reminders needed.");
  });
  it(`more than ${REMIND_MAX} families → refused with the narrowing line`, async () => {
    const t = tables();
    t.enrollments = Array.from({ length: REMIND_MAX + 1 }, (_, i) => ({ class_id: CLASS_7B, student_id: `b1000000-0000-4000-8000-${String(i).padStart(12, "0")}`, profiles: { full_name: `Learner ${i}` } }));
    t.student_progress = [];
    const r = await run({ shareId: SHARE }, { t });
    expect(r).toMatchObject({ ok: false, error: "too_many", summary: "That's more than 40 families — narrow it to one class." });
    expect(r.confirm).toBeUndefined();
    // exactly 40 is fine
    t.enrollments = t.enrollments.slice(0, REMIND_MAX);
    expect((await run({ shareId: SHARE }, { t })).confirm?.params.count).toBe(REMIND_MAX);
  });
  it("a share in another teacher's class, or an unknown share → not found", async () => {
    const t = tables();
    t.generation_shares = [share({ class_id: FOREIGN_CLASS })];
    expect(await run({ shareId: SHARE }, { t })).toMatchObject({ ok: false, error: "share_not_found" });
    t.generation_shares = [];
    expect(await run({ shareId: SHARE }, { t })).toMatchObject({ ok: false, error: "share_not_found" });
  });
});

describe("namesALearner", () => {
  it("full names and first names (3+ letters, not a particle), at word boundaries", () => {
    const roster = ["Ali Hassan", "Muhammad Iqbal", "Siti Aminah"];
    expect(namesALearner("Ali has not finished", roster)).toBe("Ali Hassan");
    expect(namesALearner("Iqbal is late", roster)).toBe("Muhammad Iqbal");
    expect(namesALearner("Muhammad is late", roster)).toBeNull(); // a common prefix alone is not a name
    expect(namesALearner("Alice and Sitis", roster)).toBeNull();
    expect(namesALearner("Please remind your child.", roster)).toBeNull();
  });
});

describe("parentsRemindAction meta", () => {
  it("confirm/act, teacher role + teacher hat, diary flag", () => {
    expect(parentsRemindAction.meta).toMatchObject({ name: "parents.remind", tier: "confirm", kind: "act", roles: ["teacher"], hats: ["teacher"], flags: ["diary"] });
    expect(metaAllows(parentsRemindAction.meta, makeCtx())).toBe(true);
    expect(metaAllows(parentsRemindAction.meta, makeCtx({ flags: { diary: false } }))).toBe(false);
    expect(metaAllows(parentsRemindAction.meta, makeCtx({ hat: "principal" }))).toBe(false);
  });
});
