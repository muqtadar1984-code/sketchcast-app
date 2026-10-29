/**
 * `diary.note` resolver (S2 slice A): class vs learner, own rows only (the
 * fake ignores filters, so leaked foreign rows test the belt), ambiguity asks,
 * note type / parents-only / KL entry dates, the card's exact flat params —
 * and that the handler NEVER writes (the act route does, as the teacher).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/diary.test.ts
 */
import { describe, expect, it } from "vitest";
import { diaryDayKey, diaryNoteAction, parseEntryDate, resolveDiaryNote } from "../diary";
import { metaAllows } from "@/sk/shell/registry";
import { NOW, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx, type Rows } from "@/sk/shell/__tests__/fixtures";

// NOW = 2026-10-28T08:30Z = Wednesday 16:30 in Kuala Lumpur.
const tables = (): Record<string, Rows> => ({
  classes: [
    { id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c7c", name: "7C", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c5a", name: "5 Amanah", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c5p", name: "5 Amanah Pagi", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c9x", name: "9X", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID }, // not hers
  ],
  enrollments: [
    { class_id: "c7b", student_id: "s-ali", profiles: { full_name: "Ali Hassan" } },
    { class_id: "c7b", student_id: "s-siti", profiles: { full_name: "Siti Aminah" } },
    { class_id: "c7c", student_id: "s-aliya", profiles: { full_name: "Aliya Tan" } },
    { class_id: "c9x", student_id: "s-zara", profiles: { full_name: "Zara Foreign" } }, // a foreign roster
  ],
  books: [],
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
          throw new Error(`diary.note wrote to ${table}`);
        };
      }
      return b;
    },
    rpc: () => {
      throw new Error("diary.note called an rpc");
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const run = (args: Record<string, unknown>, o: { locale?: string; selection?: Record<string, string>; t?: Record<string, Rows>; now?: Date } = {}) =>
  resolveDiaryNote(makeCtx({ locale: o.locale, selection: o.selection }), args, { session: readOnlySession(o.t), now: o.now ?? NOW });

describe("parseEntryDate — the diary's KL day (fixed UTC+8)", () => {
  const table: Array<[string, string]> = [
    ["today", "2026-10-28"],
    ["hari ini", "2026-10-28"],
    ["اليوم", "2026-10-28"],
    ["tomorrow", "2026-10-29"],
    ["esok", "2026-10-29"],
    ["غدا", "2026-10-29"],
    ["day after tomorrow", "2026-10-30"],
    ["lusa", "2026-10-30"],
    ["Friday", "2026-10-30"],
    ["for friday", "2026-10-30"],
    ["Jumaat", "2026-10-30"],
    ["الجمعة", "2026-10-30"],
    ["Wednesday", "2026-10-28"], // a weekday counts today
    ["Monday", "2026-11-02"],
    ["next Monday", "2026-11-02"],
    ["Jumaat depan", "2026-11-06"],
    ["next Friday", "2026-11-06"],
    ["2026-11-03", "2026-11-03"],
  ];
  it.each(table)("%s → %s", (text, day) => {
    expect(parseEntryDate(text, NOW)).toEqual({ ok: true, date: day });
  });
  it("no day → null (today); unknown words or a non-day → not ok, never a guess", () => {
    expect(parseEntryDate("", NOW)).toBeNull();
    expect(parseEntryDate(undefined, NOW)).toBeNull();
    expect(parseEntryDate("someday soon", NOW)).toEqual({ ok: false });
    expect(parseEntryDate("2026-02-31", NOW)).toEqual({ ok: false });
  });
  it("the KL day, not UTC: 01:30 Thursday in KL is still Wednesday in UTC", () => {
    const late = new Date("2026-10-28T17:30:00.000Z");
    expect(diaryDayKey(late)).toBe("2026-10-29");
    expect(parseEntryDate("today", late)).toEqual({ ok: true, date: "2026-10-29" });
    expect(parseEntryDate("tomorrow", late)).toEqual({ ok: true, date: "2026-10-30" });
  });
});

describe("resolveDiaryNote — card", () => {
  it("a class note: the exact text, general, not parents-only, today; flat params only", async () => {
    const r = await run({ classQuery: "7B", body: "No school on Friday — Deepavali." });
    expect(r.ok).toBe(true);
    expect(r.confirm).toEqual({
      action: "diary.note",
      title: "Post to 7B's diary",
      params: { class_id: "c7b", note_type: "general", body: "No school on Friday — Deepavali.", parents_only: false, entry_date: "2026-10-28", target_label: "7B" },
    });
    for (const v of Object.values(r.confirm!.params)) expect(["string", "number", "boolean"]).toContain(typeof v);
    expect(r.summary).toContain('"No school on Friday — Deepavali."');
    expect(r.entities).toEqual([{ kind: "class", id: "c7b", label: "7B", via: "diary.note" }]);
  });
  it("type, parents-only and the day are carried as said; an unknown type falls back to general", async () => {
    const r = await run({ classQuery: "7c", body: "Bring your atlas.", type: "homework", parentsOnly: true, entryDate: "tomorrow" });
    expect(r.confirm?.params).toMatchObject({ class_id: "c7c", note_type: "homework", parents_only: true, entry_date: "2026-10-29" });
    expect((await run({ classQuery: "7B", body: "x", type: "gossip" })).confirm?.params.note_type).toBe("general");
    expect((await run({ classQuery: "7B", body: "x", parentsOnly: "yes" })).confirm?.params.parents_only).toBe(false);
  });
  it("a learner note goes to the learner (student_id, never class_id) — own classes only", async () => {
    const r = await run({ learnerQuery: "Ali Hassan", body: "Ali did very well today.", type: "praise" });
    expect(r.confirm?.title).toBe("Post to Ali Hassan's diary");
    expect(r.confirm?.params).toEqual({ student_id: "s-ali", note_type: "praise", body: "Ali did very well today.", parents_only: false, entry_date: "2026-10-28", target_label: "Ali Hassan" });
    // A learner only in another teacher's class is not found.
    expect(await run({ learnerQuery: "Zara", body: "x" })).toMatchObject({ ok: false, error: "learner_not_found" });
    // An id outside her rosters is not found either.
    expect(await run({ learnerId: "s-zara", body: "x" })).toMatchObject({ ok: false, error: "learner_not_found" });
    expect((await run({ learnerId: "s-siti", body: "x" })).confirm?.params.student_id).toBe("s-siti");
  });
  it("ambiguity asks, never guesses: two learners, two classes", async () => {
    const l = await run({ learnerQuery: "Ali", body: "x" });
    expect(l.confirm).toBeUndefined();
    expect(l.summary).toBe("Which learner: Ali Hassan or Aliya Tan?");
    const c = await run({ classQuery: "amanah", body: "x" });
    expect(c.confirm).toBeUndefined();
    expect(c.summary).toBe("Which class: 5 Amanah or 5 Amanah Pagi?");
    // an exact name settles it
    expect((await run({ classQuery: "5 Amanah", body: "x" })).confirm?.params.class_id).toBe("c5a");
  });
  it("another teacher's class is not found", async () => {
    expect(await run({ classQuery: "9X", body: "x" })).toMatchObject({ ok: false, error: "class_not_found" });
    expect(await run({ classId: "c9x", body: "x" })).toMatchObject({ ok: false, error: "class_not_found" });
  });
  it("no target: the class she has selected, else ask", async () => {
    expect((await run({ body: "x" }, { selection: { classId: "c7b" } })).confirm?.params.class_id).toBe("c7b");
    expect(await run({ body: "x" }, { selection: { classId: "c9x" } })).toMatchObject({ ok: false, error: "class_not_found" });
    expect(await run({ body: "x" })).toMatchObject({ ok: false, error: "target required", summary: "Which class — or which learner — is the note for?" });
  });
  it("an empty, too-long or undated note asks", async () => {
    expect(await run({ classQuery: "7B", body: "  " })).toMatchObject({ ok: false, error: "body required" });
    expect(await run({ classQuery: "7B", body: "x".repeat(4001) })).toMatchObject({ ok: false, error: "body_too_long" });
    expect(await run({ classQuery: "7B", body: "x", entryDate: "whenever" })).toMatchObject({ ok: false, error: "date_unparsed" });
  });
  it("the card title is in the teacher's language", async () => {
    expect((await run({ classQuery: "7B", body: "x" }, { locale: "ms" })).confirm?.title).toBe("Hantar ke diari 7B");
    expect((await run({ classQuery: "7B", body: "x" }, { locale: "ar" })).confirm?.title).toBe("انشر في يوميات 7B");
  });
});

describe("diaryNoteAction meta", () => {
  it("confirm/act, teacher role + teacher hat, diary flag", () => {
    expect(diaryNoteAction.meta).toMatchObject({ name: "diary.note", tier: "confirm", kind: "act", roles: ["teacher"], hats: ["teacher"], flags: ["diary"] });
    expect(metaAllows(diaryNoteAction.meta, makeCtx())).toBe(true);
    expect(metaAllows(diaryNoteAction.meta, makeCtx({ flags: { diary: false } }))).toBe(false);
    expect(metaAllows(diaryNoteAction.meta, makeCtx({ hat: "parent" }))).toBe(false);
    expect(metaAllows(diaryNoteAction.meta, makeCtx({ role: "parent", hat: null }))).toBe(false);
    expect(metaAllows(diaryNoteAction.meta, makeCtx({ role: "student", hat: null }))).toBe(false);
  });
});
