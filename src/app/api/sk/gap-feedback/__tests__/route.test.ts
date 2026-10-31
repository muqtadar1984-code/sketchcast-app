/**
 * /api/sk/gap-feedback — the 👎 (SK gap tracker, signal E): the SK gate (404
 * off, 401 signed out, every role incl. students when SK is on for them),
 * body validation, one `thumbs_down` row with the note as `wanted`, the
 * question AS ASKED (a book code is not masked), the earlier pairs in
 * context, and the hourly cap. Also: a refused /api/sk/act → `refusal`.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/gap-feedback
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkGapInput } from "@/sk/gaps/store";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  recorded: [] as unknown[][],
  after: [] as Array<() => Promise<unknown>>,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: () => Promise<unknown>) => void mocks.after.push(task) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/sk/gaps/store", async (orig) => ({
  ...(await orig<typeof import("@/sk/gaps/store")>()),
  recordGaps: async (_admin: unknown, gaps: unknown[]) => void mocks.recorded.push(gaps),
}));

import { POST } from "@/app/api/sk/gap-feedback/route";
import { POST as ACT } from "@/app/api/sk/act/route";
import { THUMBS_PER_HOUR } from "@/sk/gaps/feedback";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "FEATURE_PARENT_PORTAL", "SK_ALLOWED_EMAILS", "SK_SHELL_CONSUMER"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const tables = (role = "teacher") => ({ profiles: [{ role, school_id: SCHOOL_ID }], schools: [{ config: {} }], coordinator_scope: [], parent_links: [], classes: [], books: [] });
const req = (body: unknown, url = "http://x/api/sk/gap-feedback") => new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const BODY = {
  turnId: "t-abc",
  question: "activate SKBE1-ABCD-EFGH-JKLM for me",
  reply: "I can't do that from here.",
  note: "activate my book code",
  previous: [{ q: "hi", a: "Hi, I'm SK." }],
  page: "/dashboard/books",
};

function signIn(role = "teacher", user: typeof USER | null = USER) {
  mocks.createClient.mockResolvedValue(fakeSession(tables(role), { user }));
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,student";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  mocks.cookies = { sc_locale: "ms" };
  mocks.recorded = [];
  mocks.after = [];
  mocks.createAdminClient.mockReturnValue(fakeSession({ sk_gaps: [] }));
  signIn();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("gate", () => {
  it("404 when SK is off — before auth", async () => {
    delete process.env.FEATURE_SK;
    expect((await POST(req(BODY))).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("401 signed out", async () => {
    signIn("teacher", null);
    expect((await POST(req(BODY))).status).toBe(401);
  });
  it("404 when SK is not on for her role", async () => {
    process.env.SK_ROLES = "teacher";
    signIn("student");
    expect((await POST(req(BODY))).status).toBe(404);
    expect(mocks.recorded).toEqual([]);
  });
});

describe("validation", () => {
  it("400 on bad JSON, a missing turnId / question, an over-long note", async () => {
    expect((await POST(req("{nope"))).status).toBe(400);
    expect((await POST(req({ ...BODY, turnId: "" }))).status).toBe(400);
    expect((await POST(req({ ...BODY, question: "" }))).status).toBe(400);
    expect((await POST(req({ ...BODY, note: "n".repeat(301) }))).status).toBe(400);
    expect(mocks.recorded).toEqual([]);
  });
});

describe("the 👎", () => {
  it("records one thumbs_down row: the note as wanted, the question as asked, the earlier pairs", async () => {
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = mocks.recorded.flat() as SkGapInput[];
    expect(rows).toEqual([
      {
        turnId: "t-abc",
        userId: TEACHER_ID,
        role: "teacher",
        locale: "ms",
        page: "/dashboard/books",
        signal: "thumbs_down",
        question: "activate SKBE1-ABCD-EFGH-JKLM for me",
        reply: "I can't do that from here.",
        wanted: "activate my book code",
        route: "feedback",
        context: { previous: [{ q: "hi", a: "Hi, I'm SK." }] },
      },
    ]);
  });
  it("a student may send one too (students included), with no note", async () => {
    signIn("student");
    const res = await POST(req({ turnId: "t-s", question: "what is osmosis", reply: "I have nothing on that." }));
    expect(res.status).toBe(200);
    expect(mocks.recorded.flat()).toMatchObject([{ role: "student", signal: "thumbs_down", wanted: null, context: null }]);
  });
  it("429 past the hourly cap, nothing written", async () => {
    mocks.createAdminClient.mockReturnValue(fakeSession({ sk_gaps: Array.from({ length: THUMBS_PER_HOUR }, (_, i) => ({ id: `g${i}` })) }));
    expect((await POST(req(BODY))).status).toBe(429);
    expect(mocks.recorded).toEqual([]);
  });
});

describe("/api/sk/act — a refused action is a gap", () => {
  it("a token that does not verify → refused, and one refusal row after the reply", async () => {
    mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
    const res = await ACT(req({ turnId: "t-act", token: "garbage", via: "voice", collector: { path: "/dashboard", locale: "en" } }, "http://x/api/sk/act"));
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("refused");
    for (const t of mocks.after.splice(0)) await t();
    expect(mocks.recorded.flat()).toMatchObject([{ turnId: "t-act", signal: "refusal", route: "act", modality: "voice", tools: [], context: { items: [{ kind: "act_refused", action: null, via: "voice" }] } }]);
  });
});
