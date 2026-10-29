/**
 * S5 slice D execution: `notice.school` through executeAction — CLICK-ONLY
 * (a spoken yes is refused and consumes nothing), consumed once through the
 * admin RPC, then ONE school_events row inserted AS THE LEADER with the
 * session client: is_notice = true, the composer's own row (buildNoticeRow)
 * plus sk_action_id = token id. 0171's unique index → `already_used`; RLS
 * (42501) → refused; a stale or malformed row is refused before the consume.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-notice.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACT_CLICK_ONLY_LINE, ACT_LINES, ACT_NOT_ALLOWED_LINE, CLICK_ONLY, HANDLERS, executeAction, type ActInput } from "../act";
import { MemoryAuditSink } from "../audit";
import { freshMemory } from "../memory";
import type { ActionParams } from "../tokens";
import type { SkContext } from "../types";
import { NOW, SCHOOL_ID, TEACHER_ID, makeCtx } from "./fixtures";
import { ACT_SECRET, diarySession, signedRow, statefulAdmin, type DiarySessionOpts } from "./act-fakes";
import { buildNoticeRow, validateNotice } from "@/utils/notice-row";

const ID = "66666666-6666-4666-8666-666666666666";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["SK_SHELL_SECRET", "FEATURE_NOTICES"]) saved[k] = process.env[k];
  process.env.SK_SHELL_SECRET = ACT_SECRET;
  process.env.FEATURE_NOTICES = "true";
});
afterEach(() => {
  for (const k of ["SK_SHELL_SECRET", "FEATURE_NOTICES"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const NOTICE: ActionParams = {
  audience: "school",
  title: "No school on Friday",
  body: "No school on Friday. Classes resume on Monday.",
  starts_at: "2026-10-30",
  school_label: "Demo School",
  seen_by: "Every parent, student and teacher at Demo School",
  click_only: true,
};
const principal = () => makeCtx({ role: "school_admin", hat: "principal" });

function world(params: ActionParams = NOTICE, o: { ctx?: SkContext; session?: DiarySessionOpts } = {}) {
  const ctx = o.ctx ?? principal();
  const { row, token } = signedRow({ id: ID, action: "notice.school", params, contextHash: ctx.contextHash });
  const admin = statefulAdmin({ [ID]: row }, NOW);
  const session = diarySession({}, o.session);
  const sink = new MemoryAuditSink();
  const input = (over: Partial<ActInput> = {}): ActInput => ({ ctx, token, via: "click", turnId: "t-1", now: NOW, memory: freshMemory(ctx, NOW), admin, session, sink, ...over });
  return { ctx, admin, session, sink, input };
}

describe("notice.school is click-only", () => {
  it("is registered with clickOnly and listed in CLICK_ONLY; notice.multi_class stays a reserved name with no handler", () => {
    expect(HANDLERS["notice.school"]).toMatchObject({ tier: "confirm", kind: "act", clickOnly: true });
    expect(CLICK_ONLY.has("notice.school")).toBe(true);
    expect(CLICK_ONLY.has("notice.multi_class")).toBe(true);
    expect(HANDLERS["notice.multi_class"]).toBeUndefined();
  });
  it("a spoken yes is refused, consumes nothing and writes nothing; the card still works by click", async () => {
    const w = world();
    const voice = await executeAction(w.input({ via: "voice" }));
    expect(voice.response).toEqual({ ok: false, outcome: "refused", summary: ACT_CLICK_ONLY_LINE });
    expect(w.admin.calls).toEqual([]);
    expect(w.session.events).toEqual([]);
    expect((await executeAction(w.input())).response.outcome).toBe("done");
  });
});

describe("the write", () => {
  it("inserts ONE school_events row as the leader: is_notice true, the route's row + sk_action_id = token id", async () => {
    const w = world();
    const out = await executeAction(w.input());
    expect(out.response).toMatchObject({ ok: true, outcome: "done", summary: "Posted to the whole school: No school on Friday.", result: { notice_id: "event-1", audience: "school", starts_at: "2026-10-30" } });
    expect(w.admin.calls.map((c) => c.fn)).toEqual(["sk_consume_action_token"]);
    expect(w.session.events).toHaveLength(1);
    const ev = w.session.events[0];
    expect(ev).toMatchObject({ is_notice: true, sk_action_id: ID, school_id: SCHOOL_ID, created_by: TEACHER_ID, class_id: null, audience: "school", status: "published", all_day: true });
    expect(ev.title).toBe("No school on Friday");
    expect(ev.description).toBe("No school on Friday. Classes resume on Monday.");
    expect(ev.starts_at).toBe("2026-10-29T16:00:00.000Z"); // Friday 00:00 in the school's zone (UTC+8)
    // Exactly the shared builder's row (the one POST /api/notices inserts), plus the action id and the whole day.
    const v = validateNotice({ title: "No school on Friday", body: "No school on Friday. Classes resume on Monday.", audience: "school", startsAt: "2026-10-29T16:00:00.000Z" }, NOW.getTime());
    if (!v.ok) throw new Error(v.error);
    const { id: _id, ...inserted } = ev;
    void _id;
    expect(inserted).toEqual(buildNoticeRow(v.fields, { schoolId: SCHOOL_ID, createdBy: TEACHER_ID, skActionId: ID, allDay: true }));
    expect(w.session.log).toContain("school_events.insert(1)");
  });
  it("staff audience: the staff line", async () => {
    const w = world({ ...NOTICE, audience: "staff", title: "Staff meeting", body: "Staff meeting at 2pm in the hall." });
    expect((await executeAction(w.input())).response.summary).toBe("Posted to all staff: Staff meeting.");
    expect(w.session.events[0]).toMatchObject({ audience: "staff", is_notice: true });
  });
  it("a coordinator posts the same way (RLS decides)", async () => {
    const w = world(NOTICE, { ctx: makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "5", subject: null }] }) });
    expect((await executeAction(w.input())).response.outcome).toBe("done");
    expect(w.session.events[0]).toMatchObject({ created_by: TEACHER_ID, sk_action_id: ID });
  });
  it("a duplicate write under the same action id (23505) → already_used", async () => {
    const w = world(NOTICE, { session: { insertError: { code: "23505", message: 'duplicate key value violates unique constraint "school_events_sk_action_uidx"' } } });
    const out = await executeAction(w.input());
    expect(out.response).toEqual({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
    expect(w.sink.rows[0]).toMatchObject({ action: "notice.school", ok: false, error: "already_used:duplicate" });
  });
  it("RLS says no (42501) → refused, and the audit keeps the measured reason", async () => {
    const w = world(NOTICE, { session: { insertError: { code: "42501", message: 'new row violates row-level security policy for table "school_events"' } } });
    const out = await executeAction(w.input());
    expect(out.response).toMatchObject({ ok: false, outcome: "refused", summary: ACT_LINES.refused, result: { reason: "not_permitted" } });
    expect(w.sink.rows[0].error).toMatch(/^refused:not_permitted:new row violates row-level security/);
    expect(w.admin.calls.map((c) => c.fn)).toEqual(["sk_consume_action_token"]); // burned: nothing written
  });
});

describe("refused before the consume", () => {
  it("a teacher with no scope (the live context no longer allows it) → not allowed, nothing consumed", async () => {
    const teacher = makeCtx();
    const w = world(NOTICE, { ctx: teacher });
    expect((await executeAction(w.input())).response).toEqual({ ok: false, outcome: "refused", summary: ACT_NOT_ALLOWED_LINE });
    expect(w.admin.calls).toEqual([]);
  });
  it("a stale day (already passed at the click), a malformed row, or notices switched off → refused, nothing consumed", async () => {
    for (const params of [{ ...NOTICE, starts_at: "2026-10-27" }, { ...NOTICE, audience: "leadership" }, { ...NOTICE, body: "" }, { ...NOTICE, click_only: false }]) {
      const w = world(params);
      expect((await executeAction(w.input())).response.outcome, JSON.stringify(params)).toBe("refused");
      expect(w.admin.calls).toEqual([]);
      expect(w.session.events).toEqual([]);
    }
    process.env.FEATURE_NOTICES = "false";
    const off = world();
    expect((await executeAction(off.input())).response).toMatchObject({ outcome: "refused", summary: "School notices aren't switched on for your school." });
    expect(off.admin.calls).toEqual([]);
  });
});
