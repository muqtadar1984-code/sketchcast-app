// SK S6 slice C — the routes: the greeting's ONE suggestion end to end
// (POST /api/sk/shell/context → "yes" on POST /api/sk/shell/turn), the
// suggestions preference, and the three settings routes (prefs, consent,
// school-memory) with their gates. The logic is unit-tested in
// src/sk/__tests__/s6-settings.test.ts and src/sk/shell/__tests__/suggest.test.ts.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/__tests__/s6-settings-routes.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn(), cookies: {} as Record<string, string> }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", () => ({
  AnthropicProvider: class {
    constructor() {
      throw new Error("no model call is expected on these paths");
    }
  },
}));

import { POST as CONTEXT } from "@/app/api/sk/shell/context/route";
import { POST as TURN } from "@/app/api/sk/shell/turn/route";
import { POST as PREFS } from "@/app/api/sk/prefs/route";
import { POST as CONSENT } from "@/app/api/sk/consent/route";
import { POST as SCHOOL_MEMORY } from "@/app/api/sk/school-memory/route";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents, type Rows } from "@/sk/shell/__tests__/fixtures";
import { CHILD, PARENT, S6Db, s6World, SCHOOL, UNLINKED_CHILD } from "@/sk/__tests__/s6-fake-db";

const ENV = ["FEATURE_SK", "SK_ROLES", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_CATALOGUE_TAB", "SK_AUDIT"];
const saved: Record<string, string | undefined> = {};
const GEN = "9e000000-0000-4000-8000-000000000001";
const STUDENT = "5d000000-0000-4000-8000-000000000001";
const SUB = "50b00000-0000-4000-8000-000000000001";
const CLASS = "c1a55000-0000-4000-8000-000000000001";
const PLAIN = "Hi — I'm SK. Ask me about your classes, or tell me where to go.";
const MARK = "1 submission to mark — want to see it?";

/** A teacher with one pending submission on her own worksheet (marking waiting). */
function teacher(extra: Record<string, Rows> = {}) {
  const session = fakeSession({
    profiles: [{ id: TEACHER_ID, role: "teacher", school_id: SCHOOL_ID }],
    schools: [{ config: {} }],
    coordinator_scope: [],
    parent_links: [],
    classes: [{ id: CLASS, name: "5B", teacher_id: TEACHER_ID }],
    enrollments: [{ class_id: CLASS, student_id: STUDENT, profiles: { full_name: "Aisha Rahman" } }],
    books: [],
    generations: [{ id: GEN, kind: "worksheet", title: "Cells worksheet", chapter_ref: "1", book_id: null, owner_id: TEACHER_ID, status: "done", params: {}, created_at: new Date().toISOString() }],
    submissions: [{ id: SUB, generation_id: GEN, student_id: STUDENT, mode: "online", grade_status: "pending", auto_score: 3, max_score: 5, answers: {}, submitted_at: "2026-10-28T01:00:00Z" }],
    sk_workflow_facts: [],
    ...extra,
  });
  mocks.createClient.mockResolvedValue(session);
  return session;
}
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const warm = async (body: Record<string, unknown> = {}) =>
  (await (await CONTEXT(post("http://x/api/sk/shell/context", { path: "/dashboard", ...body }))).json()) as { greeting: string; memory: string; announced: string; prefs: unknown };
const turn = (text: string, memory: string) => post("http://x/api/sk/shell/turn", { turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" }, memory });

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "s6c-route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.FEATURE_SCHOOL_ANALYTICS = "true";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("the greeting suggestion, end to end", () => {
  it("ONE line from the marking queue, before SK's own line; returned prefs are the server's", async () => {
    teacher();
    const g = await warm();
    expect(g.greeting.split("\n")).toEqual([MARK, PLAIN]);
    expect(g.prefs).toEqual({});
  });

  it("never repeated: the same conversation, or a new tab with only the signed note", async () => {
    teacher();
    const first = await warm();
    expect((await warm({ memory: first.memory, announced: first.announced })).greeting).toBe(PLAIN);
    expect((await warm({ announced: first.announced })).greeting).toBe(PLAIN);
  });

  it("the suggestions preference OFF → the plain greeting, and the marking queue is never read", async () => {
    const s = teacher({ sk_workflow_facts: [{ owner_id: TEACHER_ID, kind: "preference", key: "suggestions", value: { on: false }, updated_at: "2026-10-28T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" }] });
    const g = await warm();
    expect(g.greeting).toBe(PLAIN);
    expect(g.prefs).toEqual({ suggestions: false });
    expect(s.log.some((l) => l.startsWith("submissions."))).toBe(false);
  });

  it("“yes” runs exactly the offered read (marking.next) — no model, nothing sent", async () => {
    teacher();
    const { memory } = await warm();
    const ev = await readEvents(await TURN(turn("yes", memory)));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[1]).toMatchObject({ name: "marking.next", ok: true });
    expect(String(ev[2].text)).toContain("Aisha");
    expect(ev[3]).toMatchObject({ label: "grounded", sources: ["marking.next"] });
  });

  it("“no” declines with a plain line (not the kit's Library line)", async () => {
    teacher();
    const { memory } = await warm();
    const no = await readEvents(await TURN(turn("no", memory)));
    expect(no.find((e) => e.type === "text")).toMatchObject({ text: "All right." });
  });

  it("'Last time …' when no tool line applies, and “yes” opens the Board there", async () => {
    teacher({
      submissions: [],
      sk_workflow_facts: [
        { owner_id: TEACHER_ID, kind: "recent_kit", key: `kit:${GEN}`, value: { label: "Plant and Animal Cells", classId: CLASS, classLabel: "5B", generationId: GEN }, updated_at: "2026-10-28T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
      ],
    });
    const g = await warm();
    expect(g.greeting.split("\n")).toEqual(["Last time: 5B, Plant and Animal Cells — carry on?", PLAIN]);
    const ev = await readEvents(await TURN(turn("yes", g.memory)));
    expect(ev.find((e) => e.type === "navigate")).toMatchObject({ path: `/present?class=${CLASS}&kit=${GEN}` });
  });

  it("the fact store unreadable (0173 not applied) → prefs null, defaults apply, the greeting still answers", async () => {
    const s = teacher();
    const from = s.from;
    (s as { from: (t: string) => unknown }).from = (t: string) => (t === "sk_workflow_facts" ? { select: () => ({ eq: () => ({ in: () => ({ gt: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "relation does not exist" } }) }) }) }) }) }) } : from(t));
    const g = await warm();
    expect(g.prefs).toBeNull();
    expect(g.greeting.split("\n")).toEqual([MARK, PLAIN]);
  });
});

// ── the settings routes ─────────────────────────────────────────────────────

function as(db: S6Db, id: string | null) {
  mocks.createClient.mockResolvedValue(Object.assign(db, { auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } }));
  return db;
}

describe("POST /api/sk/prefs", () => {
  it("401 signed out; 200 stores the preference on the caller's own rows; works with SK off", async () => {
    delete process.env.FEATURE_SK;
    const db = as(s6World(), null);
    expect((await PREFS(post("http://x/api/sk/prefs", { suggestions: false }))).status).toBe(401);
    as(db, PARENT);
    const res = await PREFS(post("http://x/api/sk/prefs", { suggestions: false }));
    expect(res.status).toBe(200);
    expect(db.rows("sk_workflow_facts")).toEqual([expect.objectContaining({ owner_id: PARENT, kind: "preference", key: "suggestions", value: { on: false } })]);
  });
});

describe("POST /api/sk/consent", () => {
  const body = (child: string, grant: boolean) => post("http://x/api/sk/consent", { child, scope: "transcripts", grant });
  it("a verified parent: 200 through the RPC; revoke too", async () => {
    const db = as(s6World(), PARENT);
    db.rpcs.sk_set_consent = (a) => ({ data: { child_id: a.p_child, scope: a.p_scope, granted_at: "t", revoked_at: a.p_grant ? null : "t" } });
    expect((await CONSENT(body(CHILD, true))).status).toBe(200);
    expect((await CONSENT(body(CHILD, false))).status).toBe(200);
    expect(db.log.filter((c) => c.table === "rpc:sk_set_consent").map((c) => (c.payload as { p_grant: boolean }).p_grant)).toEqual([true, false]);
  });
  it("an unlinked child → 403, no RPC; a student → 403; signed out → 401", async () => {
    const db = as(s6World(), PARENT);
    expect((await CONSENT(body(UNLINKED_CHILD, true))).status).toBe(403);
    as(db, CHILD);
    expect((await CONSENT(body(CHILD, true))).status).toBe(403);
    expect(db.log.some((c) => c.table === "rpc:sk_set_consent")).toBe(false);
    as(db, null);
    expect((await CONSENT(body(CHILD, true))).status).toBe(401);
  });
});

describe("POST /api/sk/school-memory", () => {
  const PRINCIPAL = "88888888-8888-4888-8888-888888888888";
  it("the principal of the school: 200 and the switch is on; a coordinator: 403", async () => {
    const db = s6World();
    db.rows("profiles").push({ id: PRINCIPAL, role: "school_admin", school_id: SCHOOL }, { id: "c0000000-0000-4000-8000-000000000009", role: "coordinator", school_id: SCHOOL });
    mocks.createAdminClient.mockReturnValue(db);
    as(db, PRINCIPAL);
    expect((await SCHOOL_MEMORY(post("http://x/api/sk/school-memory", { on: true }))).status).toBe(200);
    expect((db.rows("schools")[0]!.config as { sk_learning_memory?: boolean }).sk_learning_memory).toBe(true);
    as(db, "c0000000-0000-4000-8000-000000000009");
    expect((await SCHOOL_MEMORY(post("http://x/api/sk/school-memory", { on: false }))).status).toBe(403);
    expect((db.rows("schools")[0]!.config as { sk_learning_memory?: boolean }).sk_learning_memory).toBe(true);
  });
});
