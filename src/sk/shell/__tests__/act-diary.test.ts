/**
 * S2 slice A execution: act-core's consumeThenWrite (consume ONCE through the
 * admin RPC, then write AS THE TEACHER with the session client carrying
 * sk_action_id = token id; a failed write leaves the token burned) and the two
 * actions it runs — diary.note and parents.remind — through executeAction, with
 * the audit row's tier/kind taken from the handler.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-diary.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACT_LINES, ACT_NOT_ALLOWED_LINE, HANDLERS, consumeThenWrite, executeAction, writeFailure, type ActInput } from "../act";
import { ACT_WRITE_FAILED, REMIND_BODY_NO_DUE } from "../act-lines";
import { MemoryAuditSink } from "../audit";
import { freshMemory } from "../memory";
import type { ActionParams } from "../tokens";
import { NOW, TEACHER_ID, makeCtx } from "./fixtures";
import { ACT_SECRET, AHMAD, ALI, CLASS_7B, GEN, GONE, SHARE, SITI, diarySession, signedRow, statefulAdmin, type DiarySessionOpts } from "./act-fakes";

const ID = "77777777-7777-4777-8777-777777777777";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SK_SHELL_SECRET = ACT_SECRET;
});
afterEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const NOTE: ActionParams = { class_id: CLASS_7B, note_type: "general", body: "No school on Friday.", parents_only: false, entry_date: "2026-10-28", target_label: "7B" };
const REMIND: ActionParams = {
  share_id: SHARE,
  generation_id: GEN,
  class_id: CLASS_7B,
  student_ids: [ALI, SITI, AHMAD, GONE].join(","),
  count: 4,
  body: 'Reminder: "Cells worksheet" is not done yet. Please encourage your child to finish it.',
  class_name: "7B",
  kit_title: "Cells worksheet",
};

const roster = () => ({
  classes: [{ id: CLASS_7B, name: "7B", teacher_id: TEACHER_ID }],
  generation_shares: [{ id: SHARE, generation_id: GEN, class_id: CLASS_7B }],
  enrollments: [
    { class_id: CLASS_7B, student_id: ALI, profiles: { full_name: "Ali Hassan" } },
    { class_id: CLASS_7B, student_id: SITI, profiles: { full_name: "Siti Aminah" } },
    { class_id: CLASS_7B, student_id: AHMAD, profiles: { full_name: "Ahmad Zaki" } },
  ],
  // Ahmad finished between the card and the click.
  student_progress: [{ generation_id: GEN, student_id: AHMAD, status: "completed" }],
  submissions: [] as Array<Record<string, unknown>>,
});

function setup(action: string, params: ActionParams, o: { locale?: string; tables?: Record<string, Array<Record<string, unknown>>>; session?: DiarySessionOpts; flags?: Record<string, boolean>; noSession?: boolean } = {}) {
  const ctx = makeCtx({ locale: o.locale, flags: o.flags });
  const { row, token } = signedRow({ id: ID, action, params, contextHash: ctx.contextHash });
  const admin = statefulAdmin({ [ID]: row });
  const session = diarySession(o.tables ?? roster(), o.session);
  const sink = new MemoryAuditSink();
  const input: ActInput = { ctx, token, via: "click", turnId: "t-1", now: NOW, memory: freshMemory(ctx, NOW), admin, session: o.noSession ? undefined : session, sink };
  return { ctx, row, token, admin, session, sink, input };
}
const consumes = (admin: ReturnType<typeof statefulAdmin>) => admin.calls.filter((c) => c.fn === "sk_consume_action_token");

describe("consumeThenWrite", () => {
  it("consumes ONCE through the admin RPC, then writes with the SESSION client and the token id as sk_action_id", async () => {
    const { admin, session, row, ctx } = setup("diary.note", NOTE);
    const seen: Array<{ db: unknown; id: string }> = [];
    const r = await consumeThenWrite(admin, session, row, ctx, async (db, id) => {
      seen.push({ db, id });
      return { ok: true, value: 1 };
    });
    expect(r).toEqual({ stage: "write", result: { ok: true, value: 1 } });
    expect(consumes(admin)).toEqual([{ fn: "sk_consume_action_token", args: { p_token: ID, p_context_hash: ctx.contextHash } }]);
    expect(seen).toEqual([{ db: session, id: ID }]);
    expect(admin.rows[ID].used_at).not.toBeNull();
  });
  it("a consume that is not done never writes (already_used / context_mismatch / not_found)", async () => {
    const { admin, session, row, ctx } = setup("diary.note", NOTE);
    let writes = 0;
    const w = async () => {
      writes++;
      return { ok: true as const, value: 0 };
    };
    expect(await consumeThenWrite(admin, session, row, ctx, w)).toMatchObject({ stage: "write" });
    expect(await consumeThenWrite(admin, session, row, ctx, w)).toEqual({ stage: "consume", outcome: "already_used" });
    expect(await consumeThenWrite(admin, session, { ...row, id: "00000000-0000-4000-8000-000000000000" }, ctx, w)).toEqual({ stage: "consume", outcome: "not_found" });
    const other = setup("diary.note", NOTE);
    expect(await consumeThenWrite(other.admin, other.session, other.row, makeCtx({ hat: "parent" }), w)).toEqual({ stage: "consume", outcome: "context_mismatch" });
    expect(writes).toBe(1);
  });
  it("a failed or thrown write leaves the token BURNED and reports the measured error", async () => {
    const { admin, session, row, ctx } = setup("diary.note", NOTE);
    const r = await consumeThenWrite(admin, session, row, ctx, async () => {
      throw new Error("socket hang up");
    });
    expect(r).toEqual({ stage: "write", result: { ok: false, outcome: "error", error: "socket hang up" } });
    expect(admin.rows[ID].used_at).not.toBeNull();
  });
  it("writeFailure: 23505 → already_used, 42501 → refused, anything else → error with code + message", () => {
    expect(writeFailure({ code: "23505", message: "dup" })).toEqual({ ok: false, outcome: "already_used", reason: "duplicate" });
    expect(writeFailure({ code: "42501", message: "new row violates row-level security policy" })).toMatchObject({ ok: false, outcome: "refused", reason: "not_permitted" });
    expect(writeFailure({ code: "XX000", message: "boom" })).toEqual({ ok: false, outcome: "error", error: "XX000 boom" });
    expect(writeFailure(null)).toEqual({ ok: false, outcome: "error", error: "no row returned" });
  });
});

describe("HANDLERS", () => {
  it("every action is confirm/act; only assign audits its own done row; only lesson.prepare (spends credits) is click-only", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(["assign", "diary.note", "lesson.prepare", "marking.grade", "parents.remind"]);
    for (const [name, h] of Object.entries(HANDLERS)) {
      expect([h.tier, h.kind]).toEqual(["confirm", "act"]);
      expect(h.clickOnly ?? false).toBe(name === "lesson.prepare");
      expect(h.meta?.tier).toBe("confirm");
    }
    expect(HANDLERS.assign.auditsDone).toBe(true);
    expect(HANDLERS["diary.note"].auditsDone ?? false).toBe(false);
    expect(HANDLERS["parents.remind"].auditsDone ?? false).toBe(false);
  });
});

describe("diary.note execution", () => {
  it("inserts ONE note as the teacher (author = me, sk_action_id = token id), says the line, audits ok with the handler's tier/kind", async () => {
    const { input, session, admin, sink } = setup("diary.note", NOTE);
    const out = await executeAction(input);
    expect(out.response).toEqual({
      ok: true,
      outcome: "done",
      summary: "Posted to 7B's diary.",
      result: { note_id: "note-1", class_id: CLASS_7B, entry_date: "2026-10-28", parents_only: false },
    });
    expect(session.notes).toEqual([
      { author_id: TEACHER_ID, class_id: CLASS_7B, student_id: null, note_type: "general", body: "No school on Friday.", parents_only: false, entry_date: "2026-10-28", sk_action_id: ID, id: "note-1" },
    ]);
    expect(consumes(admin)).toHaveLength(1);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ action: "diary.note", tier: "confirm", kind: "act", ok: true, token_id: ID, params: NOTE, result: { summary: "Posted to 7B's diary.", note_id: "note-1" } });
    expect(sink.rows[0].error).toBeUndefined();
    expect(out.memory.entities.map((e) => `${e.kind}:${e.id}`)).toEqual([`class:${CLASS_7B}`]);
  });
  it("a personal, parents-only note goes to the student; the line is in the teacher's language", async () => {
    const params = { student_id: ALI, note_type: "praise", body: "Ali did very well today.", parents_only: true, entry_date: "2026-10-29", target_label: "Ali Hassan" };
    const { input, session } = setup("diary.note", params, { locale: "ms" });
    const out = await executeAction(input);
    expect(out.response.summary).toBe("Telah dihantar ke diari Ali Hassan.");
    expect(session.notes[0]).toMatchObject({ class_id: null, student_id: ALI, note_type: "praise", parents_only: true, entry_date: "2026-10-29", sk_action_id: ID });
  });
  it("idempotent: a second write under the same action id hits 0169's unique index → already done, nothing new", async () => {
    const { input, session, sink } = setup("diary.note", NOTE);
    session.notes.push({ class_id: CLASS_7B, student_id: null, sk_action_id: ID, id: "earlier" });
    const out = await executeAction(input);
    expect(out.response).toEqual({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
    expect(session.notes).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ ok: false, error: "already_used:duplicate", tier: "confirm", kind: "act" });
  });
  it("a write that fails after the consume: token burned, nothing written, the write-failed line, the measured error audited", async () => {
    const { input, session, admin, sink } = setup("diary.note", NOTE, { session: { insertError: { code: "XX000", message: "disk full" } } });
    const out = await executeAction(input);
    expect(out.response).toEqual({ ok: false, outcome: "error", summary: ACT_WRITE_FAILED.en });
    expect(out.response.summary).toBe("That didn't go through — nothing was changed. Ask me again.");
    expect(session.notes).toEqual([]);
    expect(admin.rows[ID].used_at).not.toBeNull();
    expect(sink.rows[0]).toMatchObject({ ok: false, error: "error:write:XX000 disk full", token_id: ID });
  });
  it("RLS says no (not her class any more) → refused not_permitted, burned, nothing written", async () => {
    const { input, session, admin } = setup("diary.note", NOTE, { session: { insertError: { code: "42501", message: "new row violates row-level security policy" } } });
    const out = await executeAction(input);
    expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_LINES.refused, result: { reason: "not_permitted" } });
    expect(session.notes).toEqual([]);
    expect(admin.rows[ID].used_at).not.toBeNull();
  });
  it("malformed stored params are refused BEFORE the consume (the card stays unburned)", async () => {
    for (const bad of [
      { ...NOTE, student_id: ALI }, // both targets
      { ...NOTE, class_id: "7B" }, // not an id
      { ...NOTE, body: "" },
      { ...NOTE, note_type: "gossip" },
      { ...NOTE, entry_date: "2026-02-31" },
      { ...NOTE, parents_only: "yes" },
    ] as ActionParams[]) {
      const { input, admin, session } = setup("diary.note", bad);
      const out = await executeAction(input);
      expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_LINES.refused, result: { reason: "bad_params" } });
      expect(consumes(admin)).toEqual([]);
      expect(session.notes).toEqual([]);
    }
  });
  it("no session client → error before the consume", async () => {
    const { input, admin } = setup("diary.note", NOTE, { noSession: true });
    expect((await executeAction(input)).response.outcome).toBe("error");
    expect(consumes(admin)).toEqual([]);
  });
  it("revalidation: with the diary switched off the live Context no longer allows it → refused, nothing consumed", async () => {
    const { input, admin, sink } = setup("diary.note", NOTE, { flags: { diary: false } });
    const out = await executeAction(input);
    expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_NOT_ALLOWED_LINE });
    expect(consumes(admin)).toEqual([]);
    expect(sink.rows[0]).toMatchObject({ action: "diary.note", tier: "confirm", kind: "act", error: "refused" });
  });
  it("a spoken yes confirms a diary note (single class, not click-only)", async () => {
    const { input, session } = setup("diary.note", NOTE);
    const out = await executeAction({ ...input, via: "voice" });
    expect(out.response.outcome).toBe("done");
    expect(session.notes).toHaveLength(1);
  });
});

describe("parents.remind execution", () => {
  it("re-verifies at execution: one parents-only reminder per learner STILL not done; finished and departed learners left out and named", async () => {
    const { input, session, sink, admin } = setup("parents.remind", REMIND);
    const out = await executeAction(input);
    expect(out.response).toEqual({
      ok: true,
      outcome: "done",
      summary: "Sent reminders to 2 families (diary). Left out Ahmad Zaki: already finished. Left out 1 no longer in this class.",
      result: { sent: 2, skipped_done: 1, skipped_not_in_class: 1, share_id: SHARE, class_id: CLASS_7B, generation_id: GEN },
    });
    expect(session.notes.map((n) => n.student_id)).toEqual([ALI, SITI]);
    for (const n of session.notes) {
      expect(n).toMatchObject({ author_id: TEACHER_ID, class_id: null, note_type: "reminder", parents_only: true, body: REMIND.body, entry_date: "2026-10-28", sk_action_id: ID });
    }
    // ONE insert statement (all or nothing), after ONE consume.
    expect(session.log.filter((l) => l.startsWith("diary_notes.insert"))).toEqual(["diary_notes.insert(2)"]);
    expect(consumes(admin)).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ action: "parents.remind", tier: "confirm", kind: "act", ok: true, token_id: ID, generation_id: GEN, result: { sent: 2 } });
  });
  it("one family → the singular line", async () => {
    const params = { ...REMIND, student_ids: ALI, count: 1 };
    const { input } = setup("parents.remind", params);
    expect((await executeAction(input)).response.summary).toBe("Sent a reminder to 1 family (diary).");
  });
  it("everyone finished meanwhile → ok, nothing written, says so", async () => {
    const t = roster();
    t.student_progress = [ALI, SITI, AHMAD].map((s) => ({ generation_id: GEN, student_id: s, status: "completed" }));
    const { input, session } = setup("parents.remind", REMIND, { tables: t });
    const out = await executeAction(input);
    expect(out.response).toMatchObject({ ok: true, outcome: "done", summary: "Everyone has finished now, so I sent no reminders. Left out 1 no longer in this class." });
    expect(session.notes).toEqual([]);
  });
  it("a submission counts as done (the analytics page's rule)", async () => {
    const t = roster();
    t.submissions = [{ generation_id: GEN, student_id: SITI, grade_status: "pending" }];
    const { input, session } = setup("parents.remind", REMIND, { tables: t });
    await executeAction(input);
    expect(session.notes.map((n) => n.student_id)).toEqual([ALI]);
  });
  it("the class is no longer hers → refused class_not_owned, burned, nothing written", async () => {
    const t = roster();
    t.classes = [{ id: CLASS_7B, name: "7B", teacher_id: "22222222-2222-4222-8222-222222222222" }];
    const { input, session, admin } = setup("parents.remind", REMIND, { tables: t });
    const out = await executeAction(input);
    expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_LINES.refused, result: { reason: "class_not_owned" } });
    expect(session.notes).toEqual([]);
    expect(admin.rows[ID].used_at).not.toBeNull();
  });
  it("the share was removed → refused share_gone", async () => {
    const t = roster();
    t.generation_shares = [];
    const { input, session } = setup("parents.remind", REMIND, { tables: t });
    expect((await executeAction(input)).response).toMatchObject({ outcome: "refused", result: { reason: "share_gone" } });
    expect(session.notes).toEqual([]);
  });
  it("a read that fails after the consume → the write-failed line in the teacher's language, nothing written", async () => {
    const { input, session } = setup("parents.remind", REMIND, { session: { failRead: "enrollments" }, locale: "ar" });
    const out = await executeAction(input);
    expect(out.response).toEqual({ ok: false, outcome: "error", summary: ACT_WRITE_FAILED.ar });
    expect(session.notes).toEqual([]);
  });
  it("malformed params are refused before the consume: count mismatch, > 40 learners, a non-id, an empty body", async () => {
    const many = Array.from({ length: 41 }, (_, i) => `a1000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (const bad of [
      { ...REMIND, count: 3 },
      { ...REMIND, student_ids: many.join(","), count: 41 },
      { ...REMIND, student_ids: `${ALI},ahmad`, count: 2 },
      { ...REMIND, body: "  " },
      { ...REMIND, share_id: "s1" },
    ] as ActionParams[]) {
      const { input, admin, session } = setup("parents.remind", bad);
      expect((await executeAction(input)).response).toMatchObject({ outcome: "refused", result: { reason: "bad_params" } });
      expect(consumes(admin)).toEqual([]);
      expect(session.notes).toEqual([]);
    }
  });
  it("the default body names no child", () => {
    for (const [loc, line] of Object.entries(REMIND_BODY_NO_DUE)) {
      for (const name of ["Ali", "Siti", "Ahmad", "{name}", "{child}"]) expect(line, loc).not.toContain(name);
    }
  });
});
