/**
 * `assign` (slice D): resolution of class + kit within the teacher's own rows,
 * ambiguity asks instead of guessing, the due-date table (EN + MS words,
 * offsets), the Library's assignable rule, and — above all — that the handler
 * NEVER writes: it returns a confirm card and the RPC does the rest.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/assign.test.ts
 */
import { describe, expect, it } from "vitest";
import { ASSIGN_DEFAULT_OFFSET_MINUTES, assignAction, formatDue, offsetMinutesOf, parseDue, resolveAssign } from "../assign";
import { metaAllows } from "@/sk/shell/registry";
import { NOW, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx, type Rows } from "@/sk/shell/__tests__/fixtures";

// NOW = 2026-10-28T08:30Z = Wednesday 16:30 in Kuala Lumpur.
const KL = { day: 3, minutes: 990, iso: "2026-10-28T16:30:00+08:00" };
const UTC = { day: 3, minutes: 510, iso: "2026-10-28T08:30:00Z" };
const NY = { day: 3, minutes: 210, iso: "2026-10-28T03:30:00-05:00" };

const gen = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  status: "done",
  kind: "worksheet",
  owner_id: TEACHER_ID,
  withdrawn_at: null,
  chapter_ref: null,
  book_id: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

/** The fake ignores filters on purpose: the leaked rows below test the belt. */
const tables = (): Record<string, Rows> => ({
  classes: [
    { id: "c7a", name: "7 Amanah", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c7b", name: "7 Bestari", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c9x", name: "9 Cerdik", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID }, // not hers
  ],
  enrollments: [],
  books: [],
  generations: [
    gen("g1", "Cells worksheet"),
    gen("g2", "Cells presentation", { kind: "presentation" }),
    gen("g3", "Osmosis worksheet", { status: "queued" }),
    gen("g4", "Cells lesson plan", { kind: "lesson_plan" }),
    gen("g5", "Cells worksheet (leaked)", { owner_id: OTHER_TEACHER_ID }),
    gen("g6", "Withdrawn cells worksheet", { withdrawn_at: "2026-09-01T00:00:00Z" }),
    gen("g7", "Cells question bank", { kind: "question_bank" }),
  ],
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A session whose every write THROWS: the handler must never reach one. */
function readOnlySession(t = tables()) {
  const s = fakeSession(t);
  const boom = () => {
    throw new Error("assign wrote to the database");
  };
  return {
    ...s,
    from: (table: string) => {
      const b: any = s.from(table);
      for (const m of ["insert", "update", "upsert", "delete"]) b[m] = boom;
      return b;
    },
    rpc: boom,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const run = (args: Record<string, unknown>, session = readOnlySession(), ctx = makeCtx()) => resolveAssign(ctx, args, { session, now: NOW, clock: KL });

describe("parseDue — the user's civil day, 17:00 local unless a time is said", () => {
  const cases: Array<[string, string, string]> = [
    ["Friday", "2026-10-30T09:00:00.000Z", "Fri 30 Oct, 17:00"],
    ["jumaat", "2026-10-30T09:00:00.000Z", "Fri 30 Oct, 17:00"],
    ["due Friday please", "2026-10-30T09:00:00.000Z", "Fri 30 Oct, 17:00"],
    ["tomorrow", "2026-10-29T09:00:00.000Z", "Thu 29 Oct, 17:00"],
    ["esok", "2026-10-29T09:00:00.000Z", "Thu 29 Oct, 17:00"],
    ["today", "2026-10-28T09:00:00.000Z", "Wed 28 Oct, 17:00"], // 17:00 KL is still ahead of 16:30
    ["lusa", "2026-10-30T09:00:00.000Z", "Fri 30 Oct, 17:00"],
    ["2026-11-03", "2026-11-03T09:00:00.000Z", "Tue 3 Nov, 17:00"],
    ["Monday", "2026-11-02T09:00:00.000Z", "Mon 2 Nov, 17:00"], // the coming Monday
    ["next Monday", "2026-11-02T09:00:00.000Z", "Mon 2 Nov, 17:00"], // Monday of next calendar week = the same day here
    ["next Friday", "2026-11-06T09:00:00.000Z", "Fri 6 Nov, 17:00"], // Friday of NEXT week, not this week's
    ["Jumaat depan", "2026-11-06T09:00:00.000Z", "Fri 6 Nov, 17:00"],
    ["Wednesday", "2026-11-04T09:00:00.000Z", "Wed 4 Nov, 17:00"], // a bare weekday is never today
    ["Friday at 9am", "2026-10-30T01:00:00.000Z", "Fri 30 Oct, 09:00"],
    ["Friday 3pm", "2026-10-30T07:00:00.000Z", "Fri 30 Oct, 15:00"],
    ["esok pukul 10", "2026-10-29T02:00:00.000Z", "Thu 29 Oct, 10:00"],
    ["Friday noon", "2026-10-30T04:00:00.000Z", "Fri 30 Oct, 12:00"],
    ["in 3 days", "2026-10-31T09:00:00.000Z", "Sat 31 Oct, 17:00"],
    ["3 hari lagi", "2026-10-31T09:00:00.000Z", "Sat 31 Oct, 17:00"],
    ["2026-11-03T02:00:00Z", "2026-11-03T02:00:00.000Z", "Tue 3 Nov, 10:00"], // a full instant is taken as said
  ];
  for (const [text, iso, label] of cases) {
    it(`"${text}" → ${iso}`, () => {
      expect(parseDue(text, NOW, KL)).toEqual({ ok: true, iso, label });
    });
  }
  it("nothing given → null; unknown words → unparsed; a past instant → past", () => {
    expect(parseDue("", NOW, KL)).toBeNull();
    expect(parseDue(undefined, NOW, KL)).toBeNull();
    expect(parseDue("someday", NOW, KL)).toEqual({ ok: false, reason: "unparsed" });
    expect(parseDue("next week", NOW, KL)).toEqual({ ok: false, reason: "unparsed" });
    expect(parseDue("yesterday", NOW, KL)).toEqual({ ok: false, reason: "unparsed" });
    expect(parseDue("2026-10-27", NOW, KL)).toEqual({ ok: false, reason: "past" });
    expect(parseDue("today 9am", NOW, KL)).toEqual({ ok: false, reason: "past" }); // 09:00 KL was this morning
  });
  it("follows the collector clock's offset; defaults to Kuala Lumpur when there is none", () => {
    expect(offsetMinutesOf(undefined)).toBe(ASSIGN_DEFAULT_OFFSET_MINUTES);
    expect(offsetMinutesOf(KL)).toBe(480);
    expect(offsetMinutesOf(UTC)).toBe(0);
    expect(offsetMinutesOf(NY)).toBe(-300);
    expect(offsetMinutesOf({ ...KL, iso: "2026-10-28T16:30:00+05:30" })).toBe(330);
    expect(parseDue("Friday", NOW, undefined)).toMatchObject({ iso: "2026-10-30T09:00:00.000Z" });
    expect(parseDue("Friday", NOW, UTC)).toMatchObject({ iso: "2026-10-30T17:00:00.000Z", label: "Fri 30 Oct, 17:00" });
    // New York: it is still 03:30 on the 28th there; tomorrow 17:00 EST = 22:00Z.
    expect(parseDue("tomorrow", NOW, NY)).toMatchObject({ iso: "2026-10-29T22:00:00.000Z", label: "Thu 29 Oct, 17:00" });
    expect(formatDue("2026-10-30T09:00:00+00:00", 480)).toBe("Fri 30 Oct, 17:00");
  });
});

describe("resolution → a confirm card with fully resolved params", () => {
  it("one class, one kit, no due → the card; nothing written", async () => {
    const session = readOnlySession();
    const r = await run({ classQuery: "7 Amanah", kitQuery: "cells worksheet" }, session);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Assign Cells worksheet to 7 Amanah?");
    expect(r.confirm).toEqual({
      action: "assign",
      title: "Assign Cells worksheet to 7 Amanah?",
      params: { generation_id: "g1", class_id: "c7a", due_at: null, class_name: "7 Amanah", kit_title: "Cells worksheet" },
    });
    expect(r.entities).toEqual([
      { kind: "class", id: "c7a", label: "7 Amanah", via: "assign" },
      { kind: "generation", id: "g1", label: "Cells worksheet", via: "assign" },
    ]);
    expect(session.log.filter((l) => /insert|update|upsert|delete|rpc/.test(l))).toEqual([]);
  });
  it("with a due date the card carries the absolute instant and the summary the local label", async () => {
    const r = await run({ classQuery: "7 Amanah", kitQuery: "cells worksheet", due: "Friday" });
    expect(r.summary).toBe("Assign Cells worksheet to 7 Amanah, due Fri 30 Oct, 17:00?");
    expect(r.confirm?.params.due_at).toBe("2026-10-30T09:00:00.000Z");
  });
  it("two classes match → asks which, with NO confirm", async () => {
    const r = await run({ classQuery: "7", kitQuery: "cells worksheet" });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Which class: 7 Amanah or 7 Bestari?");
    expect(r.confirm).toBeUndefined();
    expect(r.entities?.map((e) => e.id)).toEqual(["c7a", "c7b"]);
  });
  it("two kits match → asks which, with NO confirm (queued, lesson plan, question bank, withdrawn and foreign rows are not candidates)", async () => {
    const r = await run({ classQuery: "7 Amanah", kitQuery: "cells" });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("Which one: Cells worksheet or Cells presentation?");
    expect(r.confirm).toBeUndefined();
    expect(r.entities?.map((e) => e.id)).toEqual(["g1", "g2"]);
  });
  it("an exact title breaks a tie", async () => {
    const r = await run({ classQuery: "7 Bestari", kitQuery: "Cells presentation" });
    expect(r.confirm?.params).toMatchObject({ generation_id: "g2", class_id: "c7b" });
  });
  it("ids already resolved this conversation work too — and are re-checked as OWN rows", async () => {
    expect((await run({ classId: "c7a", generationId: "g1" })).confirm?.params).toMatchObject({ generation_id: "g1", class_id: "c7a" });
    expect(await run({ classId: "c9x", generationId: "g1" })).toMatchObject({ ok: false, error: "class_not_found" });
    expect(await run({ classId: "c7a", generationId: "g5" })).toMatchObject({ ok: false, error: "kit_not_found" }); // another teacher's
    expect(await run({ classId: "c7a", generationId: "g3" })).toMatchObject({ ok: false, error: "kit_not_found" }); // queued
    expect(await run({ classId: "c7a", generationId: "g4" })).toMatchObject({ ok: false, error: "kit_not_found" }); // lesson plan
    expect(await run({ classId: "c7a", generationId: "g6" })).toMatchObject({ ok: false, error: "kit_not_found" }); // withdrawn
    expect(await run({ classId: "c7a", generationId: "g7" })).toMatchObject({ ok: false, error: "kit_not_found" }); // question bank
  });
  it("not found → ok false, says what it looked for", async () => {
    expect(await run({ classQuery: "9 Cerdik", kitQuery: "cells worksheet" })).toMatchObject({ ok: false, error: "class_not_found", summary: 'I can\'t find a class called "9 Cerdik" among yours.' });
    expect(await run({ classQuery: "7 Amanah", kitQuery: "osmosis" })).toMatchObject({ ok: false, error: "kit_not_found" });
    expect(await run({ classQuery: "7 Amanah", kitQuery: "lesson plan" })).toMatchObject({ ok: false, error: "kit_not_found" });
  });
  it("a bad due date is refused before any lookup", async () => {
    const session = readOnlySession();
    expect(await run({ classQuery: "7 Amanah", kitQuery: "cells worksheet", due: "2026-10-27" }, session)).toMatchObject({ ok: false, error: "due_past" });
    expect(await run({ classQuery: "7 Amanah", kitQuery: "cells worksheet", due: "someday" }, session)).toMatchObject({ ok: false, error: "due_unparsed" });
    expect(session.log).toEqual([]);
  });
  it("missing parameters ask for them", async () => {
    expect(await run({ kitQuery: "cells worksheet" })).toMatchObject({ ok: false, error: "class required", summary: "Which class should I assign it to?" });
    expect(await run({ classQuery: "7 Amanah" })).toMatchObject({ ok: false, error: "kit required" });
  });
  it("a session that errors on reads yields a clean not-found, never a throw", async () => {
    const session = readOnlySession({ ...tables(), generations: [] });
    expect(await run({ classQuery: "7 Amanah", kitQuery: "cells" }, session)).toMatchObject({ ok: false, error: "kit_not_found" });
  });
});

describe("meta", () => {
  it("is a teacher-only, teacher-hat confirm-tier act", () => {
    expect(assignAction.meta).toMatchObject({ name: "assign", tier: "confirm", kind: "act", roles: ["teacher"], hats: ["teacher"] });
    expect(assignAction.meta.parameters.additionalProperties).toBe(false);
    expect(Object.keys(assignAction.meta.parameters.properties).sort()).toEqual(["classId", "classQuery", "due", "generationId", "kitQuery"]);
  });
  it("is allowed for a teacher (hat teacher, or hats off) and for nobody else", () => {
    expect(metaAllows(assignAction.meta, makeCtx())).toBe(true);
    expect(metaAllows(assignAction.meta, makeCtx({ hat: null }))).toBe(true);
    expect(metaAllows(assignAction.meta, makeCtx({ role: "student", hat: null }))).toBe(false);
    expect(metaAllows(assignAction.meta, makeCtx({ role: "parent", hat: "parent" }))).toBe(false);
    expect(metaAllows(assignAction.meta, makeCtx({ role: "school_admin", hat: "principal" }))).toBe(false);
    expect(metaAllows(assignAction.meta, makeCtx({ role: "teacher", hat: "parent" }))).toBe(false); // a teacher in Parent mode
  });
});
