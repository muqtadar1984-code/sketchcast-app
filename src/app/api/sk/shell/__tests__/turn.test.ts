/**
 * /api/sk/shell/turn and /api/sk/shell/context (S0): the gate (404 off, 401
 * signed out, 404 role off), body validation, the deterministic navigate path
 * (events in order, no model), refusals, acknowledgements, the model path with
 * grounding (fabricated numbers stripped), memory echo, and the warm start.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  script: [] as unknown[],
  constructed: [] as string[],
  systems: [] as string[],
  error: null as string | null,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super(mocks.script as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.systems.push(opts.system);
        if (mocks.error) {
          yield { type: "error", message: mocks.error, retryable: true };
          return;
        }
        yield* super.stream(opts);
      }
    },
  };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { GET } from "@/app/api/sk/shell/context/route";
import { SK_NOTHING_ON_THAT } from "@/sk/shell/types";
import { NAV_REFUSED } from "@/sk/capabilities/navigate";
import { SK_CHAT_NOTHING_PENDING } from "@/sk/shell/rules";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_PARENT_PORTAL", "FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_CATALOGUE_TAB", "SK_SHELL_MODEL", "SK_AUDIT"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

const tables = (role = "teacher") => ({
  profiles: [{ role, school_id: SCHOOL_ID }],
  schools: [{ config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [{ class_id: "c7b", student_id: "s1", profiles: { full_name: "Ali Hassan", username: "ali" } }],
  books: [],
});
let session: ReturnType<typeof fakeSession>;
let admin: ReturnType<typeof fakeAdmin>;
function signIn(user: typeof USER | null = USER, role = "teacher") {
  session = fakeSession(tables(role), { user });
  mocks.createClient.mockResolvedValue(session);
}
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const turn = (text: string, extra: Record<string, unknown> = {}) => ({ turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" }, ...extra });

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.FEATURE_DIARY = "true";
  process.env.FEATURE_SCHOOL_ANALYTICS = "true";
  process.env.FEATURE_CATALOGUE_TAB = "true";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.script = [];
  mocks.constructed = [];
  mocks.systems = [];
  mocks.error = null;
  admin = fakeAdmin("school");
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

describe("gate", () => {
  it("404 when FEATURE_SK is off — before auth", async () => {
    delete process.env.FEATURE_SK;
    expect((await POST(req(turn("hi")))).status).toBe(404);
    expect((await GET(new Request("http://x/api/sk/shell/context"))).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("401 signed out", async () => {
    signIn(null);
    expect((await POST(req(turn("hi")))).status).toBe(401);
    expect((await GET(new Request("http://x/api/sk/shell/context"))).status).toBe(401);
  });
  it("404 when the role is not in SK_ROLES, or the tenant has not opted in", async () => {
    signIn(USER, "student");
    expect((await POST(req(turn("hi")))).status).toBe(404);
    signIn(USER, "teacher");
    delete process.env.FEATURE_SK_SHELL_ALL_SCHOOLS;
    expect((await POST(req(turn("hi")))).status).toBe(404);
  });
  it("400 on bad JSON, empty text, text over 600, missing turnId", async () => {
    expect((await POST(req("{"))).status).toBe(400);
    expect((await POST(req(turn("   ")))).status).toBe(400);
    expect((await POST(req(turn("x".repeat(601))))).status).toBe(400);
    expect((await POST(req({ text: "hi", collector: { path: "/dashboard" } }))).status).toBe(400);
  });
});

describe("navigate (deterministic)", () => {
  it("emits meta → tool(resolve) → tool(navigate) → text → navigate → done, with no model call", async () => {
    const t0 = Date.now();
    const res = await POST(req(turn("show me 7B's analytics")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const ev = await readEvents(res);
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "tool", "text", "navigate", "done"]);
    expect(ev[0]).toMatchObject({ type: "meta", intent: "navigate" });
    // The teacher sees the whole shipped registry (core + knowledge tools v1).
    expect((ev[0] as { capabilities: string[] }).capabilities).toEqual(
      expect.arrayContaining(["navigate", "context.resolve", "library.find", "assignments.status", "learners.risk", "timetable.now_next"]),
    );
    expect(typeof ev[0].sessionId).toBe("string");
    expect(ev[1]).toMatchObject({ type: "tool", name: "context.resolve", ok: true });
    expect(ev[2]).toMatchObject({ type: "tool", name: "navigate", ok: true });
    expect(ev[4]).toEqual({ type: "navigate", path: "/dashboard/analytics?c=c7b", label: "My Analytics" });
    expect(ev[5]).toMatchObject({ type: "done", label: "navigation", sources: ["context.resolve", "navigate"] });
    expect(typeof ev[5].memory).toBe("string");
    expect(typeof ev[5].latencyMs).toBe("number");
    expect(mocks.constructed).toEqual([]); // the model was never built
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("a class it cannot find still opens the page and says so", async () => {
    const ev = await readEvents(await POST(req(turn("open 9C's diary for today"))));
    const nav = ev.find((e) => e.type === "navigate") as { path: string };
    expect(nav.path).toMatch(/^\/dashboard\/diary\?d=\d{4}-\d{2}-\d{2}$/);
    expect((ev.find((e) => e.type === "text") as { text: string }).text).toMatch(/couldn't find class "9c"/);
  });
  it("refuses a page the hat cannot see → text + done declined, no navigate event", async () => {
    const ev = await readEvents(await POST(req(turn("open school admin"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[2]).toEqual({ type: "text", text: NAV_REFUSED });
    expect(ev[3]).toMatchObject({ type: "done", label: "declined", sources: [] });
  });
  it("a principal hat reaches school admin", async () => {
    signIn(USER, "school_admin");
    process.env.SK_ROLES = "teacher,school_admin";
    mocks.cookies = { sc_hat: "principal" };
    const ev = await readEvents(await POST(req(turn("open school admin"))));
    expect(ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/dashboard/school/admin", label: "School admin" });
  });
  it("a non-English command navigates too", async () => {
    const ev = await readEvents(await POST(req(turn("buka papan"))));
    expect(ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present", label: "Classroom board" });
  });
});

describe("chat", () => {
  it("'ok' with nothing pending → fixed reply, no model", async () => {
    const ev = await readEvents(await POST(req(turn("ok"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "text", "done"]);
    expect(ev[1]).toEqual({ type: "text", text: SK_CHAT_NOTHING_PENDING });
    expect(ev[2]).toMatchObject({ label: "supplementary" });
    expect(mocks.constructed).toEqual([]);
  });
});

describe("model path + grounding", () => {
  it("uses SK_SHELL_MODEL (default claude-sonnet-5-5) and offers the allowed tools", async () => {
    mocks.script = [{ text: ["I can open pages and look up your classes."] }];
    await readEvents(await POST(req(turn("what can you do here"))));
    expect(mocks.constructed).toEqual(["claude-sonnet-5-5"]);
    process.env.SK_SHELL_MODEL = "claude-haiku-5-5";
    await readEvents(await POST(req(turn("what can you do here"))));
    expect(mocks.constructed[1]).toBe("claude-haiku-5-5");
  });
  it("strips the stub's fabricated numbers: no tool called → exactly SK_NOTHING_ON_THAT, declined", async () => {
    mocks.script = [{ text: ["Class 7B has ", "31 learners and Ahmad Zaki ", "leads with 98%."] }];
    const ev = await readEvents(await POST(req(turn("how many learners does my class have"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "text", "done"]);
    expect(ev[1]).toEqual({ type: "text", text: SK_NOTHING_ON_THAT });
    expect(ev[2]).toMatchObject({ type: "done", label: "declined", sources: [], usage: { inputTokens: 100, outputTokens: 50 } });
    const spoken = ev.filter((e) => e.type === "text").map((e) => e.text).join(" ");
    expect(spoken).not.toContain("31");
    expect(spoken).not.toContain("98");
    expect(spoken).not.toContain("Ahmad");
  });
  it("a grounded answer passes untouched and names its source", async () => {
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "context.resolve", args: { query: "7B", kind: "class" } }] },
      { text: ["Yes — 7B is one of your classes."] },
    ];
    const ev = await readEvents(await POST(req(turn("is 7B one of my classes"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "context.resolve", ok: true });
    expect(ev[2]).toEqual({ type: "text", text: "Yes — 7B is one of your classes." });
    expect(ev[3]).toMatchObject({ label: "grounded", sources: ["context.resolve"] });
  });
  it("a partly invented answer is trimmed to its supported sentences and labelled supplementary", async () => {
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "context.resolve", args: { query: "7B", kind: "class" } }] },
      { text: ["7B is your class. It has 31 learners and Ahmad Zaki is top."] },
    ];
    const ev = await readEvents(await POST(req(turn("tell me about 7B"))));
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: "7B is your class." });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "supplementary", sources: ["context.resolve"] });
  });
  it("a tool that returned nothing → SK_NOTHING_ON_THAT even when the model narrates", async () => {
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "context.resolve", args: { query: "9C", kind: "class" } }] },
      { text: ["9C has 28 learners."] },
    ];
    const ev = await readEvents(await POST(req(turn("tell me about 9C"))));
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: SK_NOTHING_ON_THAT });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "declined", sources: [] });
  });
  it("a navigate requested BY THE MODEL is emitted and labelled navigation", async () => {
    mocks.script = [{ toolCalls: [{ id: "c1", name: "navigate", args: { target: "board" } }] }, { text: ["Opening the board."] }];
    const ev = await readEvents(await POST(req(turn("I'd like to present now please"))));
    expect(ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present", label: "Classroom board" });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "navigation", sources: ["navigate"] });
  });
  it("a provider error → one friendly error event, no done, never the raw message", async () => {
    // A distinctive token: a bare "529" can occur inside a random sessionId.
    mocks.error = "overloaded_error: RAW-PROVIDER-TEXT-7c3e (529)";
    const ev = await readEvents(await POST(req(turn("what is pending"))));
    expect(ev.map((e) => e.type)).toEqual(["meta", "error"]);
    expect((ev[1] as { message: string }).message).toMatch(/One moment/);
    expect(JSON.stringify(ev)).not.toContain("RAW-PROVIDER-TEXT-7c3e");
    expect(JSON.stringify(ev)).not.toContain("overloaded_error");
  });
  it("an empty model answer with no tool declines cleanly", async () => {
    mocks.script = [{ text: [] }];
    const ev = await readEvents(await POST(req(turn("what is pending"))));
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: SK_NOTHING_ON_THAT });
    expect(ev[ev.length - 1]).toMatchObject({ type: "done", label: "declined" });
  });
  it("the system prompt carries the version, the rules and the user's page", async () => {
    mocks.script = [{ text: ["Sure."] }];
    await readEvents(await POST(req(turn("hello there", { collector: { path: "/dashboard/analytics", locale: "ms" } }))));
    expect(mocks.systems[0]).toContain("sk-shell-1.0");
    expect(mocks.systems[0]).toContain(SK_NOTHING_ON_THAT);
    expect(mocks.systems[0]).toContain("page=analytics");
    expect(mocks.systems[0]).toContain("Bahasa Melayu");
  });
});

describe("memory echo", () => {
  it("the next turn carries the same session and the previous entities; a changed hat starts fresh", async () => {
    const first = await readEvents(await POST(req(turn("show me 7B's analytics"))));
    const memory = (first.find((e) => e.type === "done") as { memory: string }).memory;
    const sessionId = first[0].sessionId;
    mocks.script = [{ text: ["I can open pages for you."] }];
    const second = await readEvents(await POST(req(turn("and what else", { memory }))));
    expect(second[0].sessionId).toBe(sessionId);
    // The system prompt carried the remembered class and the previous turn.
    expect(mocks.systems[0]).toContain("recent=[class:7B(c7b)]");
    // A different hat (a teacher who is also a parent, now in Parent mode) → new conversation.
    mocks.cookies = { sc_hat: "parent" };
    session = fakeSession({ ...tables("teacher"), parent_links: [{ source: "self" }] }, { user: USER });
    mocks.createClient.mockResolvedValue(session);
    process.env.FEATURE_PARENT_PORTAL = "true";
    const third = await readEvents(await POST(req(turn("ok", { memory }))));
    expect(third[0].sessionId).not.toBe(sessionId);
  });
});

describe("GET /api/sk/shell/context", () => {
  it("returns readiness, a greeting, the capability names and a fresh memory blob", async () => {
    const res = await GET(new Request("http://x/api/sk/shell/context?path=/dashboard/analytics"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ready: true, role: "teacher", hat: "teacher", page: "analytics", locale: "en", promptVersion: "sk-shell-1.0" });
    expect(body.capabilities).toEqual(
      expect.arrayContaining(["navigate", "context.resolve", "library.find", "catalogue.availability", "assignments.status", "learners.risk", "timetable.now_next"]),
    );
    expect(body.greeting).toMatch(/I'm SK/);
    expect(body.memory).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  });
  it("greets in the sc_locale cookie's language", async () => {
    mocks.cookies = { sc_hat: "teacher", sc_locale: "ms" };
    const body = (await (await GET(new Request("http://x/api/sk/shell/context"))).json()) as { greeting: string; locale: string };
    expect(body.locale).toBe("ms");
    expect(body.greeting).toMatch(/saya SK/);
  });
});

describe("audit", () => {
  it("writes to sk_actions only when SK_AUDIT=db", async () => {
    await readEvents(await POST(req(turn("open the board"))));
    expect(admin.inserts).toEqual([]);
    process.env.SK_AUDIT = "db";
    await readEvents(await POST(req(turn("open the board"))));
    expect(admin.inserts.map((i) => i.table)).toEqual(["sk_actions"]);
    expect(admin.inserts[0].row).toMatchObject({ actor_id: TEACHER_ID, action: "navigate", kind: "nav", ok: true });
  });
});
