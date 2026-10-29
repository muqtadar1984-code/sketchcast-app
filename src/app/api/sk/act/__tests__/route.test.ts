/**
 * /api/sk/act (slice D): the gate (404 off, 401 signed out), body validation,
 * a tampered token → `refused` 200 with no RPC call, the done path returning
 * the summary + a memory blob that carries the turn, voice allowed for assign,
 * and the audit row for a non-done outcome when SK_AUDIT=db. S2 slice A: the
 * diary.note and parents.remind outcomes — consume through the admin RPC, then
 * the write with THIS request's session client.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/act/__tests__/route.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));

import { POST } from "@/app/api/sk/act/route";
import { ACT_LINES } from "@/sk/shell/act";
import { canonicalParams, encodeToken, signToken, type ActionParams, type ActionTokenRow } from "@/sk/shell/tokens";
import { verifyMemory } from "@/sk/shell/memory";
import { SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_CATALOGUE_TAB", "SK_AUDIT", "FEATURE_PARENT_PORTAL"];
const SECRET = "route-test-secret-of-adequate-length";
const ID = "44444444-4444-4444-8444-444444444444";
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const PARAMS: ActionParams = { generation_id: "g1", class_id: "c7b", due_at: "2026-10-30T09:00:00.000Z", class_name: "7B", kit_title: "Cells worksheet" };
const saved: Record<string, string | undefined> = {};

const tables = (role = "teacher") => ({
  profiles: [{ role, school_id: SCHOOL_ID }],
  schools: [{ config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  books: [],
});

/** The live route builds the same Context makeCtx() does: teacher, school, hat teacher, plan school. */
function tokenFor(over: Partial<ActionTokenRow> = {}): { row: ActionTokenRow; token: string } {
  const base: Omit<ActionTokenRow, "hmac"> = {
    id: ID,
    user_id: TEACHER_ID,
    action: "assign",
    params: PARAMS,
    params_canonical: canonicalParams(PARAMS),
    context_hash: makeCtx().contextHash,
    nonce: "n",
    // Fixed so the row in the fake admin and the token the test posts carry the SAME HMAC.
    expires_at: "2099-01-01T00:00:00.000Z",
    used_at: null,
    ...over,
  };
  const hmac = signToken(SECRET, { userId: base.user_id, action: base.action, canonical: base.params_canonical, contextHash: base.context_hash, nonce: base.nonce, expiresAt: new Date(base.expires_at).toISOString() });
  return { row: { ...base, hmac }, token: encodeToken(ID, hmac) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function actAdmin(
  tokens: Record<string, ActionTokenRow>,
  assign: (args: Record<string, unknown>) => { data?: unknown; error?: unknown },
  consume: (args: Record<string, unknown>) => { data?: unknown; error?: unknown } = () => ({ data: "done", error: null }),
) {
  const inserts: Array<{ table: string; row: any }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
  return {
    inserts,
    rpcCalls,
    from: (table: string) => {
      let id: string | null = null;
      const b: any = {
        insert: (row: unknown) => {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        select: () => b,
        eq: (_c: string, v: string) => {
          id = v;
          return b;
        },
        is: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: table === "sk_action_tokens" && id ? tokens[id] ?? null : null, error: null }),
      };
      return b;
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "plan_tier") return { data: "school", error: null };
      if (fn === "sk_assign_with_token") return assign(args ?? {});
      if (fn === "sk_consume_action_token") return consume(args ?? {});
      return { data: null, error: null };
    },
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let admin: ReturnType<typeof actAdmin>;
const DONE = { data: { outcome: "done", share_id: "s1", class_id: "c7b", generation_id: "g1", due_at: "2026-10-30T09:00:00+00:00" } };

function signIn(user: typeof USER | null = USER, role = "teacher") {
  mocks.createClient.mockResolvedValue(fakeSession(tables(role), { user }));
}
const req = (body: unknown) => new Request("http://x/api/sk/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const act = (token: string, extra: Record<string, unknown> = {}) => ({
  turnId: "t-act-1",
  token,
  via: "click",
  collector: { path: "/dashboard", locale: "en", clock: { day: 3, minutes: 990, iso: "2026-10-28T16:30:00+08:00" } },
  ...extra,
});

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = SECRET;
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.FEATURE_DIARY = "true";
  process.env.FEATURE_SCHOOL_ANALYTICS = "true";
  process.env.FEATURE_CATALOGUE_TAB = "true";
  mocks.cookies = { sc_hat: "teacher" };
  const { row } = tokenFor();
  admin = actAdmin({ [ID]: row }, () => DONE);
  mocks.createAdminClient.mockReturnValue(admin);
  signIn();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

const assignCalls = () => admin.rpcCalls.filter((c) => c.fn === "sk_assign_with_token");

describe("gate + body", () => {
  it("404 when FEATURE_SK is off — before auth", async () => {
    delete process.env.FEATURE_SK;
    expect((await POST(req(act("x")))).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("401 signed out; 404 for a role outside SK_ROLES", async () => {
    signIn(null);
    expect((await POST(req(act("x")))).status).toBe(401);
    signIn(USER, "student");
    expect((await POST(req(act("x")))).status).toBe(404);
  });
  it("400 on bad JSON, a missing token, a missing turnId", async () => {
    expect((await POST(req("{"))).status).toBe(400);
    expect((await POST(req({ turnId: "t", via: "click", collector: { path: "/dashboard" } }))).status).toBe(400);
    expect((await POST(req({ token: "x", via: "click", collector: { path: "/dashboard" } }))).status).toBe(400);
  });
});

describe("tokens", () => {
  it("a tampered token → 200 `refused`, one line, NO RPC call, memory still returned", async () => {
    const { token } = tokenFor();
    const bad = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    const res = await POST(req(act(bad)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, outcome: "refused", summary: ACT_LINES.refused });
    expect(body.result).toBeUndefined(); // no details for a prober
    expect(typeof body.memory).toBe("string");
    expect(assignCalls()).toEqual([]);
  });
  it("a token the user does not own → refused; an unknown one → not_found; nothing reaches the RPC", async () => {
    const { token } = tokenFor();
    admin = actAdmin({ [ID]: tokenFor({ user_id: "99999999-9999-4999-8999-999999999999" }).row }, () => DONE);
    mocks.createAdminClient.mockReturnValue(admin);
    expect(await (await POST(req(act(token)))).json()).toMatchObject({ outcome: "refused" });
    admin = actAdmin({}, () => DONE);
    mocks.createAdminClient.mockReturnValue(admin);
    expect(await (await POST(req(act(token)))).json()).toMatchObject({ outcome: "not_found" });
    expect(assignCalls()).toEqual([]);
  });
  it("a hat change between card and click → context_mismatch (the live Context decides)", async () => {
    const { token } = tokenFor();
    mocks.cookies = { sc_hat: "parent" };
    process.env.FEATURE_PARENT_PORTAL = "true";
    mocks.createClient.mockResolvedValue(fakeSession({ ...tables(), parent_links: [{ source: "self" }] }, { user: USER }));
    expect(await (await POST(req(act(token)))).json()).toMatchObject({ outcome: "context_mismatch", summary: ACT_LINES.context_mismatch });
    expect(assignCalls()).toEqual([]);
  });
});

describe("done path", () => {
  it("calls the RPC with the token id + live hash, answers the summary and a memory blob carrying the turn", async () => {
    const { token } = tokenFor();
    const res = await POST(req(act(token)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, outcome: "done", summary: "Assigned Cells worksheet to 7B, due Fri 30 Oct, 17:00.", result: { share_id: "s1" } });
    expect(assignCalls()).toEqual([{ fn: "sk_assign_with_token", args: { p_token: ID, p_context_hash: makeCtx().contextHash } }]);
    const mem = verifyMemory(body.memory as string);
    expect(mem).not.toBeNull();
    expect(mem!.turns.map((t) => t.text)).toEqual(["(confirmed by click)", "Assigned Cells worksheet to 7B, due Fri 30 Oct, 17:00."]);
    expect(mem!.entities.map((e) => e.id)).toEqual(["c7b", "g1"]);
    expect(admin.inserts).toEqual([]); // the RPC wrote the audit row
  });
  it("a spoken yes confirms assign", async () => {
    const { token } = tokenFor();
    const body = await (await POST(req(act(token, { via: "voice" })))).json();
    expect(body).toMatchObject({ ok: true, outcome: "done" });
  });
  it("the RPC's already_used comes back as the fixed line and, with SK_AUDIT=db, one sk_actions row", async () => {
    process.env.SK_AUDIT = "db";
    const { token } = tokenFor();
    admin = actAdmin({ [ID]: tokenFor().row }, () => ({ data: { outcome: "already_used" } }));
    mocks.createAdminClient.mockReturnValue(admin);
    const body = await (await POST(req(act(token)))).json();
    expect(body).toMatchObject({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
    expect(admin.inserts.map((i) => i.table)).toEqual(["sk_actions"]);
    expect(admin.inserts[0].row).toMatchObject({ actor_id: TEACHER_ID, action: "assign", tier: "confirm", kind: "act", ok: false, error: "already_used", token_id: ID, turn_id: "t-act-1" });
  });
  it("without a service-role key nothing can run: `error`, 200", async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("no key");
    });
    const { token } = tokenFor();
    expect(await (await POST(req(act(token)))).json()).toMatchObject({ ok: false, outcome: "error", summary: ACT_LINES.error });
  });
});

describe("S2 actions: consume via the admin RPC, then write AS THE TEACHER with the request's session", () => {
  const CLASS = "c7b00000-0000-4000-8000-000000000001";
  const GEN = "9e000000-0000-4000-8000-000000000004";
  const SHARE = "5a000000-0000-4000-8000-000000000005";
  const ALI = "a1000000-0000-4000-8000-000000000011";
  const SITI = "a2000000-0000-4000-8000-000000000012";
  const NOTE: ActionParams = { class_id: CLASS, note_type: "general", body: "No school on Friday.", parents_only: false, entry_date: "2026-10-28", target_label: "7B" };
  const REMIND: ActionParams = { share_id: SHARE, generation_id: GEN, class_id: CLASS, student_ids: `${ALI},${SITI}`, count: 2, body: "Reminder: please finish the worksheet.", class_name: "7B", kit_title: "Cells worksheet" };
  const sessionTables = () => ({
    ...tables(),
    classes: [{ id: CLASS, name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
    generation_shares: [{ id: SHARE, generation_id: GEN, class_id: CLASS }],
    enrollments: [
      { class_id: CLASS, student_id: ALI, profiles: { full_name: "Ali Hassan" } },
      { class_id: CLASS, student_id: SITI, profiles: { full_name: "Siti Aminah" } },
    ],
    student_progress: [],
    submissions: [],
    diary_notes: [{ id: "n1" }],
  });
  function arm(action: string, params: ActionParams, consume?: () => { data?: unknown; error?: unknown }) {
    const t = tokenFor({ action, params, params_canonical: canonicalParams(params) });
    admin = actAdmin({ [ID]: t.row }, () => DONE, consume);
    mocks.createAdminClient.mockReturnValue(admin);
    const session = fakeSession(sessionTables(), { user: USER });
    mocks.createClient.mockResolvedValue(session);
    return { token: t.token, session };
  }
  const consumeCalls = () => admin.rpcCalls.filter((c) => c.fn === "sk_consume_action_token");

  it("diary.note done: one consume (token id + live hash), one session insert carrying sk_action_id, the line, an ok audit row", async () => {
    process.env.SK_AUDIT = "db";
    const { token, session } = arm("diary.note", NOTE);
    const body = await (await POST(req(act(token)))).json();
    expect(body).toMatchObject({ ok: true, outcome: "done", summary: "Posted to 7B's diary.", result: { note_id: "n1", class_id: CLASS } });
    expect(consumeCalls()).toEqual([{ fn: "sk_consume_action_token", args: { p_token: ID, p_context_hash: makeCtx().contextHash } }]);
    expect(assignCalls()).toEqual([]);
    const insert = session.log.find((l) => l.startsWith("diary_notes.insert("));
    expect(insert).toBeDefined();
    expect(JSON.parse(insert!.slice("diary_notes.insert(".length, -1))).toEqual({
      author_id: TEACHER_ID,
      class_id: CLASS,
      student_id: null,
      note_type: "general",
      body: "No school on Friday.",
      parents_only: false,
      entry_date: "2026-10-28",
      sk_action_id: ID,
    });
    // The admin client never touched diary_notes; it wrote only the audit row.
    expect(admin.inserts.map((i) => i.table)).toEqual(["sk_actions"]);
    expect(admin.inserts[0].row).toMatchObject({ action: "diary.note", tier: "confirm", kind: "act", ok: true, token_id: ID });
  });
  it("a spoken yes confirms a diary note", async () => {
    const { token } = arm("diary.note", NOTE);
    expect(await (await POST(req(act(token, { via: "voice" })))).json()).toMatchObject({ ok: true, outcome: "done" });
  });
  it("the consume says already_used (a second click) → the fixed line, NO session write", async () => {
    const { token, session } = arm("diary.note", NOTE, () => ({ data: "already_used", error: null }));
    expect(await (await POST(req(act(token)))).json()).toMatchObject({ ok: false, outcome: "already_used", summary: ACT_LINES.already_used });
    expect(session.log.some((l) => l.startsWith("diary_notes.insert"))).toBe(false);
  });
  it("the diary switched off since the card → refused before the consume", async () => {
    delete process.env.FEATURE_DIARY;
    const { token, session } = arm("diary.note", NOTE);
    const body = await (await POST(req(act(token)))).json();
    expect(body.ok).toBe(false);
    expect(["refused", "context_mismatch"]).toContain(body.outcome);
    expect(consumeCalls()).toEqual([]);
    expect(session.log.some((l) => l.startsWith("diary_notes.insert"))).toBe(false);
  });
  it("parents.remind done: re-reads through the session, one insert of one reminder per learner, the line", async () => {
    const { token, session } = arm("parents.remind", REMIND);
    const body = await (await POST(req(act(token)))).json();
    expect(body).toMatchObject({ ok: true, outcome: "done", summary: "Sent reminders to 2 families (diary).", result: { sent: 2, share_id: SHARE } });
    expect(consumeCalls()).toHaveLength(1);
    const insert = session.log.find((l) => l.startsWith("diary_notes.insert("));
    const rows = JSON.parse(insert!.slice("diary_notes.insert(".length, -1)) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.student_id)).toEqual([ALI, SITI]);
    for (const r of rows) expect(r).toMatchObject({ author_id: TEACHER_ID, class_id: null, note_type: "reminder", parents_only: true, body: REMIND.body, sk_action_id: ID });
    for (const t of ["classes", "generation_shares", "enrollments", "student_progress", "submissions"]) expect(session.log.some((l) => l.startsWith(`${t}.`))).toBe(true);
  });
});
