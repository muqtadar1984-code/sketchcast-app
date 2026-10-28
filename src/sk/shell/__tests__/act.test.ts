/**
 * executeAction (slice D): every outcome mapping from the RPC's jsonb, the
 * click-only refusal table (voice never confirms them; a click still may),
 * voice allowed for assign, unknown actions refused, per-tier revalidation,
 * verify failures that never reach the RPC, and the audit + memory trail.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/act.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACT_CLICK_ONLY_LINE, ACT_LINES, ACT_NOT_ALLOWED_LINE, CLICK_ONLY, executeAction, type ActInput } from "../act";
import { canonicalParams, encodeToken, signToken, type ActionParams, type ActionTokenRow } from "../tokens";
import { MemoryAuditSink } from "../audit";
import { freshMemory } from "../memory";
import { NOW, TEACHER_ID, makeCtx } from "./fixtures";

const SECRET = "act-test-secret-of-adequate-length-01";
const ID = "33333333-3333-4333-8333-333333333333";
const KL = { day: 3, minutes: 990, iso: "2026-10-28T16:30:00+08:00" };
const PARAMS: ActionParams = { generation_id: "g1", class_id: "c7b", due_at: "2026-10-30T09:00:00.000Z", class_name: "7B", kit_title: "Cells worksheet" };

function tokenRow(over: Partial<ActionTokenRow> & { contextHash?: string } = {}): { row: ActionTokenRow; token: string } {
  const ctxHash = over.contextHash ?? makeCtx().contextHash;
  const base: Omit<ActionTokenRow, "hmac"> = {
    id: ID,
    user_id: TEACHER_ID,
    action: "assign",
    params: PARAMS,
    params_canonical: canonicalParams(PARAMS),
    context_hash: ctxHash,
    nonce: "n0nce",
    expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
    used_at: null,
    ...over,
  };
  const hmac = signToken(SECRET, { userId: base.user_id, action: base.action, canonical: base.params_canonical, contextHash: base.context_hash, nonce: base.nonce, expiresAt: new Date(base.expires_at).toISOString() });
  return { row: { ...base, hmac }, token: encodeToken(base.id, hmac) };
}

type RpcResult = { data?: unknown; error?: unknown } | (() => never);
function fakeAdmin(rows: Record<string, ActionTokenRow>, rpc: RpcResult = { data: { outcome: "done" } }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    from: (table: string) => {
      if (table !== "sk_action_tokens") throw new Error(`unexpected table ${table}`);
      return { select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: rows[id] ?? null, error: null }) }) }) };
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      if (typeof rpc === "function") rpc();
      return rpc;
    },
  };
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SK_SHELL_SECRET = SECRET;
});
afterEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function input(over: Partial<ActInput> & { rows?: Record<string, ActionTokenRow>; rpc?: RpcResult } = {}) {
  const ctx = over.ctx ?? makeCtx();
  const admin = over.admin ?? fakeAdmin(over.rows ?? {}, over.rpc);
  const sink = new MemoryAuditSink();
  const base: ActInput = { ctx, token: "", via: "click", turnId: "t-1", now: NOW, clock: KL, memory: freshMemory(ctx, NOW), admin, sink, ...over };
  return { base, admin: admin as ReturnType<typeof fakeAdmin>, sink };
}

const DONE = { data: { outcome: "done", share_id: "s1", class_id: "c7b", generation_id: "g1", due_at: "2026-10-30T09:00:00+00:00" } };

describe("done", () => {
  it("calls the RPC with the token id + live context hash only, speaks the line, writes NO audit row (the RPC did), remembers", async () => {
    const { row, token } = tokenRow();
    const { base, admin, sink } = input({ token, rows: { [ID]: row }, rpc: DONE });
    const out = await executeAction(base);
    expect(out.response).toEqual({
      ok: true,
      outcome: "done",
      summary: "Assigned Cells worksheet to 7B, due Fri 30 Oct, 17:00.",
      result: { share_id: "s1", class_id: "c7b", generation_id: "g1", due_at: "2026-10-30T09:00:00+00:00" },
    });
    expect(admin.calls).toEqual([{ fn: "sk_assign_with_token", args: { p_token: ID, p_context_hash: base.ctx.contextHash } }]);
    expect(sink.rows).toEqual([]);
    expect(out.memory.turns).toEqual([
      { role: "user", text: "(confirmed by click)" },
      { role: "assistant", text: "Assigned Cells worksheet to 7B, due Fri 30 Oct, 17:00." },
    ]);
    expect(out.memory.entities.map((e) => `${e.kind}:${e.id}`)).toEqual(["class:c7b", "generation:g1"]);
  });
  it("without a due date the line stops at the class", async () => {
    const params = { ...PARAMS, due_at: null };
    const { row, token } = tokenRow({ params, params_canonical: canonicalParams(params) });
    const out = await executeAction(input({ token, rows: { [ID]: row }, rpc: { data: { outcome: "done", share_id: "s1", class_id: "c7b", generation_id: "g1", due_at: null } } }).base);
    expect(out.response.summary).toBe("Assigned Cells worksheet to 7B.");
  });
  it("a spoken yes is allowed for assign (not click-only)", async () => {
    const { row, token } = tokenRow();
    const out = await executeAction(input({ token, via: "voice", rows: { [ID]: row }, rpc: DONE }).base);
    expect(out.response.outcome).toBe("done");
    expect(out.memory.turns[0]).toEqual({ role: "user", text: "Yes. (spoken confirmation)" });
  });
});

describe("the RPC's non-done outcomes map one-to-one, each with its line and one audit row", () => {
  const table: Array<[string, string | undefined]> = [
    ["already_used", undefined],
    ["expired", undefined],
    ["context_mismatch", undefined],
    ["not_found", undefined],
    ["refused", "class_not_owned"],
    ["refused", "generation_not_assignable"],
  ];
  for (const [outcome, reason] of table) {
    it(`${outcome}${reason ? ` (${reason})` : ""}`, async () => {
      const { row, token } = tokenRow();
      const { base, sink } = input({ token, rows: { [ID]: row }, rpc: { data: { outcome, ...(reason ? { reason } : {}) } } });
      const out = await executeAction(base);
      expect(out.response).toEqual({ ok: false, outcome, summary: ACT_LINES[outcome as keyof typeof ACT_LINES], ...(reason ? { result: { reason } } : {}) });
      expect(sink.rows).toHaveLength(1);
      expect(sink.rows[0]).toMatchObject({
        actor_id: TEACHER_ID,
        action: "assign",
        tier: "confirm",
        kind: "act",
        ok: false,
        error: reason ? `${outcome}:${reason}` : outcome,
        token_id: ID,
        generation_id: "g1",
        turn_id: "t-1",
        params: PARAMS,
      });
      expect(out.memory.turns[1].text).toBe(ACT_LINES[outcome as keyof typeof ACT_LINES]);
    });
  }
  it("an RPC error, a thrown RPC and an unknown outcome are all `error` — nothing claimed", async () => {
    const { row, token } = tokenRow();
    for (const rpc of [{ error: { message: "boom" } }, { data: { outcome: "weird" } }, { data: "done" }, () => { throw new Error("net"); }] as RpcResult[]) {
      const { base, sink } = input({ token, rows: { [ID]: row }, rpc });
      const out = await executeAction(base);
      expect(out.response).toEqual({ ok: false, outcome: "error", summary: ACT_LINES.error });
      expect(sink.rows[0]).toMatchObject({ ok: false, error: "error", token_id: ID });
    }
  });
});

describe("verification failures never reach the RPC", () => {
  it("tampered HMAC → refused; wrong user → refused; malformed → refused; unknown id → not_found", async () => {
    const { row, token } = tokenRow();
    const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    for (const [tok, rows, outcome] of [
      [tampered, { [ID]: row }, "refused"],
      [token, { [ID]: { ...row, user_id: "99999999-9999-4999-8999-999999999999" } }, "refused"],
      ["not-a-token", { [ID]: row }, "refused"],
      [token, {}, "not_found"],
    ] as Array<[string, Record<string, ActionTokenRow>, string]>) {
      const { base, admin, sink } = input({ token: tok, rows });
      const out = await executeAction(base);
      expect(out.response).toEqual({ ok: false, outcome, summary: ACT_LINES[outcome as keyof typeof ACT_LINES] });
      expect(admin.calls).toEqual([]);
      // No row to reference: token_id null (FK); the decoded id travels in result.
      expect(sink.rows[0]).toMatchObject({ ok: false, error: outcome, token_id: null, action: "act", params: {} });
    }
  });
  it("used → already_used; past expiry → expired; another context → context_mismatch", async () => {
    const used = tokenRow({ used_at: NOW.toISOString() });
    const expired = tokenRow({ expires_at: new Date(NOW.getTime() - 1000).toISOString() });
    const other = tokenRow({ contextHash: "f".repeat(64) });
    for (const [t, outcome] of [
      [used, "already_used"],
      [expired, "expired"],
      [other, "context_mismatch"],
    ] as Array<[{ row: ActionTokenRow; token: string }, string]>) {
      const { base, admin } = input({ token: t.token, rows: { [ID]: t.row } });
      const out = await executeAction(base);
      expect(out.response.outcome).toBe(outcome);
      expect(admin.calls).toEqual([]);
    }
  });
  it("without a secret every token is refused", async () => {
    delete process.env.SK_SHELL_SECRET;
    const { row, token } = tokenRow();
    const { base, admin } = input({ token, rows: { [ID]: row } });
    expect((await executeAction(base)).response.outcome).toBe("refused");
    expect(admin.calls).toEqual([]);
  });
});

describe("click-only (§9.2) and dispatch", () => {
  it("every click-only action refuses a spoken yes WITHOUT consuming; assign is not in the set", () => {
    expect(CLICK_ONLY.has("assign")).toBe(false);
    expect([...CLICK_ONLY]).toEqual(expect.arrayContaining(["teacher.invite", "notice.school", "notice.multi_class", "kit.generate", "purchase", "book.activate", "access.revoke", "recap.publish"]));
  });
  for (const action of CLICK_ONLY) {
    it(`${action}: voice → refused "${ACT_CLICK_ONLY_LINE}", no RPC`, async () => {
      const params: ActionParams = { x: 1 };
      const { row, token } = tokenRow({ action, params, params_canonical: canonicalParams(params) });
      const { base, admin, sink } = input({ token, via: "voice", rows: { [ID]: row } });
      const out = await executeAction(base);
      expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_CLICK_ONLY_LINE });
      expect(admin.calls).toEqual([]);
      expect(sink.rows[0]).toMatchObject({ action, error: "refused", token_id: ID, result: { via: "voice" } });
    });
  }
  it("an action with no handler (S2's, or an unknown name) is refused by click too", async () => {
    for (const action of ["teacher.invite", "frobnicate"]) {
      const params: ActionParams = { x: 1 };
      const { row, token } = tokenRow({ action, params, params_canonical: canonicalParams(params) });
      const { base, admin } = input({ token, via: "click", rows: { [ID]: row } });
      const out = await executeAction(base);
      expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_LINES.refused });
      expect(admin.calls).toEqual([]);
    }
  });
  it("per-tier revalidation: a context the capability no longer allows is refused before the RPC", async () => {
    // Same user, but the live Context says Parent mode (hat parent): assign is teacher-hat only.
    const ctx = makeCtx({ hat: "parent" });
    const { row, token } = tokenRow({ contextHash: ctx.contextHash });
    const { base, admin, sink } = input({ ctx, token, rows: { [ID]: row }, rpc: DONE });
    const out = await executeAction(base);
    expect(out.response).toEqual({ ok: false, outcome: "refused", summary: ACT_NOT_ALLOWED_LINE });
    expect(admin.calls).toEqual([]);
    expect(sink.rows[0]).toMatchObject({ hat: "parent", error: "refused" });
  });
});
