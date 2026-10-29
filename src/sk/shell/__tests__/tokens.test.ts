// Action tokens (§8.2, §9.2): HMAC over the STORED fields, single-use,
// expiring, bound to the user and the context hash.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalParams,
  consumeActionToken,
  decodeToken,
  encodeToken,
  issueActionToken,
  signToken,
  tokenSecret,
  verifyActionToken,
  type ActionTokenRow,
} from "../tokens";
import { buildContext } from "../context";

const USER = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-28T10:00:00Z");

function fakeDb(rows: Record<string, ActionTokenRow>, opts: { insertError?: boolean; rpcOutcome?: string } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    from: (table: string) => {
      if (table !== "sk_action_tokens") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: Omit<ActionTokenRow, "id" | "used_at">) => ({
          select: () => ({
            single: async () => {
              if (opts.insertError) return { data: null, error: { message: "boom" } };
              rows[ID] = { ...row, id: ID, used_at: null };
              return { data: { id: ID }, error: null };
            },
          }),
        }),
        select: () => ({
          eq: (_c: string, id: string) => ({
            maybeSingle: async () => ({ data: rows[id] ?? null, error: null }),
          }),
        }),
      };
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      return { data: opts.rpcOutcome ?? "done", error: null };
    },
  };
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SK_SHELL_SECRET = "test-secret-with-enough-length-0123";
});
afterEach(() => {
  for (const k of ["SK_SHELL_SECRET", "BOOK_CODE_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("canonicalParams / encode / decode", () => {
  it("is independent of key order and treats undefined as null", () => {
    expect(canonicalParams({ b: 1, a: "x" })).toBe(canonicalParams({ a: "x", b: 1 }));
    expect(canonicalParams({ a: null })).toBe(canonicalParams({ a: undefined as unknown as null }));
  });
  it("round-trips the opaque token and rejects malformed ones", () => {
    const h = "a".repeat(64);
    expect(decodeToken(encodeToken(ID, h))).toEqual({ id: ID, hmac: h });
    expect(decodeToken("nope")).toBeNull();
    expect(decodeToken(`${ID}.${"a".repeat(63)}`)).toBeNull();
  });
  it("refuses to issue without a secret of at least 16 chars", async () => {
    delete process.env.SK_SHELL_SECRET;
    expect(tokenSecret()).toBeNull();
    process.env.BOOK_CODE_SECRET = "short";
    expect(tokenSecret()).toBeNull();
    const db = fakeDb({});
    expect(await issueActionToken(db, { userId: USER, action: "assign", params: {}, contextHash: "c" })).toBeNull();
  });
});

describe("issue → verify", () => {
  const params = { classId: "c7b", generationId: "g1", due: "2026-10-31" };

  it("issues a row whose HMAC covers the stored fields and verifies it", async () => {
    const rows: Record<string, ActionTokenRow> = {};
    const db = fakeDb(rows);
    const issued = await issueActionToken(db, { userId: USER, action: "assign", params, contextHash: "ctx", now: NOW });
    expect(issued).not.toBeNull();
    expect(issued!.expiresAt).toBe("2026-10-28T10:10:00.000Z"); // 10-minute default (§8.2)
    const row = rows[ID];
    expect(row.params_canonical).toBe(canonicalParams(params));
    expect(row.hmac).toBe(signToken(process.env.SK_SHELL_SECRET!, { userId: USER, action: "assign", canonical: row.params_canonical, contextHash: "ctx", nonce: row.nonce, expiresAt: row.expires_at }));
    const v = await verifyActionToken(db, issued!.token, { userId: USER, contextHash: "ctx", now: NOW });
    expect(v.ok).toBe(true);
  });

  it("refuses a tampered token, another user, altered stored params, expiry, reuse and a changed context", async () => {
    const rows: Record<string, ActionTokenRow> = {};
    const db = fakeDb(rows);
    const issued = (await issueActionToken(db, { userId: USER, action: "assign", params, contextHash: "ctx", now: NOW }))!;
    const { id } = decodeToken(issued.token)!;

    const tampered = encodeToken(id, "f".repeat(64));
    expect(await verifyActionToken(db, tampered, { userId: USER, contextHash: "ctx", now: NOW })).toEqual({ ok: false, outcome: "refused" });
    expect(await verifyActionToken(db, issued.token, { userId: "someone-else", contextHash: "ctx", now: NOW })).toEqual({ ok: false, outcome: "refused" });

    // Someone edits the stored params after issue → canonical no longer matches → refused.
    rows[ID].params = { ...params, classId: "c8a" };
    expect(await verifyActionToken(db, issued.token, { userId: USER, contextHash: "ctx", now: NOW })).toEqual({ ok: false, outcome: "refused" });
    rows[ID].params = params;

    expect(await verifyActionToken(db, issued.token, { userId: USER, contextHash: "ctx", now: new Date("2026-10-28T10:10:00Z") })).toEqual({ ok: false, outcome: "expired" });
    expect(await verifyActionToken(db, issued.token, { userId: USER, contextHash: "other", now: NOW })).toEqual({ ok: false, outcome: "context_mismatch" });

    rows[ID].used_at = "2026-10-28T10:01:00Z";
    expect(await verifyActionToken(db, issued.token, { userId: USER, contextHash: "ctx", now: NOW })).toEqual({ ok: false, outcome: "already_used" });

    expect(await verifyActionToken(db, encodeToken("33333333-3333-4333-8333-333333333333", "a".repeat(64)), { userId: USER, contextHash: "ctx", now: NOW })).toEqual({ ok: false, outcome: "not_found" });
  });

  it("S5: a change of coordinator scope is a context change — the token is refused as context_mismatch", async () => {
    const rows: Record<string, ActionTokenRow> = {};
    const db = fakeDb(rows);
    const ctx = (scope: Array<{ grade: string | null; subject: string | null }>) =>
      buildContext({ user: { id: USER, email: null }, role: "teacher", schoolId: "s", hat: "coordinator", coordinatorScope: scope, plan: "school", staff: false, flags: {}, collector: null, now: NOW });
    const before = ctx([{ grade: "5", subject: null }]).contextHash;
    const issued = (await issueActionToken(db, { userId: USER, action: "notice.school", params: {}, contextHash: before, now: NOW }))!;
    expect((await verifyActionToken(db, issued.token, { userId: USER, contextHash: ctx([{ grade: "5", subject: null }]).contextHash, now: NOW })).ok).toBe(true);
    for (const after of [[{ grade: "6", subject: null }], [{ grade: "5", subject: "Science" }], [{ grade: "5", subject: null }, { grade: "6", subject: null }], []])
      expect(await verifyActionToken(db, issued.token, { userId: USER, contextHash: ctx(after).contextHash, now: NOW })).toEqual({ ok: false, outcome: "context_mismatch" });
  });

  it("a different secret at verify time refuses every token", async () => {
    const rows: Record<string, ActionTokenRow> = {};
    const db = fakeDb(rows);
    const issued = (await issueActionToken(db, { userId: USER, action: "assign", params, contextHash: "ctx", now: NOW }))!;
    process.env.SK_SHELL_SECRET = "a-rotated-secret-of-enough-length";
    expect((await verifyActionToken(db, issued.token, { userId: USER, contextHash: "ctx", now: NOW })).ok).toBe(false);
  });

  it("consume goes through the 0163 RPC and returns its outcome", async () => {
    const db = fakeDb({}, { rpcOutcome: "already_used" });
    expect(await consumeActionToken(db, ID, "ctx")).toBe("already_used");
    expect(db.calls).toEqual([{ fn: "sk_consume_action_token", args: { p_token: ID, p_context_hash: "ctx" } }]);
  });
});
