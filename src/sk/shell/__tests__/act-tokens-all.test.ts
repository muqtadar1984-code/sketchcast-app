/**
 * The token suite across EVERY confirm-tier action /api/sk/act can execute
 * (assign, diary.note, parents.remind), against a stateful admin with 0163's
 * real consume semantics: single use, expired refused, altered params refused
 * (the HMAC is re-derived from the STORED row), a context change refused, and
 * a duplicate click — two at once — producing exactly ONE write.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act-tokens-all.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACT_LINES, HANDLERS, executeAction, type ActInput } from "../act";
import { MemoryAuditSink } from "../audit";
import { freshMemory } from "../memory";
import { canonicalParams, type ActionParams } from "../tokens";
import type { SkContext } from "../types";
import { NOW, TEACHER_ID, makeCtx } from "./fixtures";
import { ACT_SECRET, ALI, CLASS_7B, GEN, SHARE, SITI, diarySession, signedRow, statefulAdmin } from "./act-fakes";

const ID = "88888888-8888-4888-8888-888888888888";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.SK_SHELL_SECRET = process.env.SK_SHELL_SECRET;
  process.env.SK_SHELL_SECRET = ACT_SECRET;
});
afterEach(() => {
  if (saved.SK_SHELL_SECRET === undefined) delete process.env.SK_SHELL_SECRET;
  else process.env.SK_SHELL_SECRET = saved.SK_SHELL_SECRET;
});

const ACTIONS: Record<string, ActionParams> = {
  assign: { generation_id: GEN, class_id: CLASS_7B, due_at: "2026-10-30T09:00:00.000Z", class_name: "7B", kit_title: "Cells worksheet" },
  "diary.note": { class_id: CLASS_7B, note_type: "general", body: "No school on Friday.", parents_only: false, entry_date: "2026-10-28", target_label: "7B" },
  "parents.remind": {
    share_id: SHARE,
    generation_id: GEN,
    class_id: CLASS_7B,
    student_ids: `${ALI},${SITI}`,
    count: 2,
    body: 'Reminder: "Cells worksheet" is not done yet. Please encourage your child to finish it.',
    class_name: "7B",
    kit_title: "Cells worksheet",
  },
};

const TABLES = {
  classes: [{ id: CLASS_7B, name: "7B", teacher_id: TEACHER_ID }],
  generation_shares: [{ id: SHARE, generation_id: GEN, class_id: CLASS_7B }],
  enrollments: [
    { class_id: CLASS_7B, student_id: ALI, profiles: { full_name: "Ali Hassan" } },
    { class_id: CLASS_7B, student_id: SITI, profiles: { full_name: "Siti Aminah" } },
  ],
  student_progress: [],
  submissions: [],
};

function world(action: string, o: { ctx?: SkContext; issuedFor?: SkContext; expiresAt?: string } = {}) {
  const ctx = o.ctx ?? makeCtx();
  const { row, token } = signedRow({ id: ID, action, params: ACTIONS[action], contextHash: (o.issuedFor ?? ctx).contextHash, ...(o.expiresAt ? { expires_at: o.expiresAt } : {}) });
  const admin = statefulAdmin({ [ID]: row });
  const session = diarySession(TABLES);
  const sink = new MemoryAuditSink();
  const input = (over: Partial<ActInput> = {}): ActInput => ({ ctx, token, via: "click", turnId: "t-1", now: NOW, memory: freshMemory(ctx, NOW), admin, session, sink, ...over });
  /** Every write this world has seen: diary notes + assign's shares. */
  const writes = () => session.notes.length + admin.shareWrites.length;
  return { ctx, row, token, admin, session, sink, input, writes };
}

describe.each(Object.keys(ACTIONS))("%s", (action) => {
  it("is a registered handler", () => {
    expect(HANDLERS[action]).toBeDefined();
  });
  it("single use: the first click writes, the second is `already_used` and writes nothing", async () => {
    const w = world(action);
    const first = await executeAction(w.input());
    expect(first.response.outcome).toBe("done");
    const n = w.writes();
    expect(n).toBeGreaterThan(0);
    const second = await executeAction(w.input());
    expect(second.response).toEqual({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
    expect(w.writes()).toBe(n);
  });
  it("a duplicate click — two at once — gives exactly one write and one `already_used`", async () => {
    const w = world(action);
    const [a, b] = await Promise.all([executeAction(w.input()), executeAction(w.input({ turnId: "t-2" }))]);
    expect([a.response.outcome, b.response.outcome].sort()).toEqual(["already_used", "done"]);
    const one = world(action);
    await executeAction(one.input());
    expect(w.writes()).toBe(one.writes()); // the same as a single click
  });
  it("expired → `expired`, nothing consumed or written", async () => {
    const w = world(action, { expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    expect((await executeAction(w.input())).response).toEqual({ ok: false, outcome: "expired", summary: ACT_LINES.expired });
    expect(w.admin.calls).toEqual([]);
    expect(w.writes()).toBe(0);
  });
  it("altered params (the stored row changed after signing) → `refused`, nothing consumed", async () => {
    const w = world(action);
    const tampered = { ...w.row.params, class_id: "cf000000-0000-4000-8000-000000000003" };
    // A row whose params no longer match the signed canonical form…
    w.admin.rows[ID] = { ...w.row, params: tampered };
    expect((await executeAction(w.input())).response.outcome).toBe("refused");
    // …and one whose canonical form was rewritten too (the HMAC no longer matches).
    w.admin.rows[ID] = { ...w.row, params: tampered, params_canonical: canonicalParams(tampered) };
    expect((await executeAction(w.input())).response.outcome).toBe("refused");
    expect(w.admin.calls).toEqual([]);
    expect(w.writes()).toBe(0);
  });
  it("a context change between card and click (another hat) → `context_mismatch`, nothing consumed", async () => {
    // Issued as the teacher; the live Context is the same user under a different plan.
    const w = world(action, { issuedFor: makeCtx(), ctx: makeCtx({ plan: "pro" }) });
    expect((await executeAction(w.input())).response).toEqual({ ok: false, outcome: "context_mismatch", summary: ACT_LINES.context_mismatch });
    expect(w.admin.calls).toEqual([]);
    expect(w.writes()).toBe(0);
  });
  it("another user's token → `refused`", async () => {
    const w = world(action);
    w.admin.rows[ID] = { ...w.row, user_id: "99999999-9999-4999-8999-999999999999" };
    expect((await executeAction(w.input())).response.outcome).toBe("refused");
    expect(w.writes()).toBe(0);
  });
  it("every outcome leaves exactly one audit row, except assign's done (its RPC audits)", async () => {
    const w = world(action);
    await executeAction(w.input());
    await executeAction(w.input());
    const rows = w.sink.rows;
    expect(rows.length).toBe(action === "assign" ? 1 : 2);
    if (action !== "assign") expect(rows[0]).toMatchObject({ action, tier: "confirm", kind: "act", ok: true, token_id: ID });
    // The repeat fails verification (used_at is set), so no row is dispatched:
    // the audit carries the generic name and the decoded id in `result.token`.
    expect(rows[rows.length - 1]).toMatchObject({ action: "act", tier: "confirm", kind: "act", ok: false, error: "already_used", token_id: null, result: { token: ID } });
  });
});
