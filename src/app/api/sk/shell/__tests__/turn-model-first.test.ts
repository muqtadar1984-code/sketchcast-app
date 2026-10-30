/**
 * MODEL-FIRST routing through POST /api/sk/shell/turn (founder 2026-10-30:
 * "let them handle the conversations" → "Yes, switch"):
 *   - SK_ROUTING unset: the rules path, unchanged (no model for the tour);
 *     SK_MODEL_FIRST_EMAILS turns model-first on for the listed user only;
 *   - model routing: "Hi SK, show me around?", "play chapter 1 of biology",
 *     "say that in Arabic" and "post a notice to 7B: bring hats" reach the
 *     model FIRST (Haiku 5.5 — short commands), and its tool produces the
 *     same events the rules did (walkthrough, navigate, lang, confirm card);
 *   - the pre-model rules still bypass the model: a running tour's "next",
 *     a book code (never part of a prompt);
 *   - one `sk-shell.turn timing` line per turn.
 * Stub providers only — no paid model call.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-model-first.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  queue: [] as unknown[][],
  constructed: [] as string[],
  opts: [] as GenerateOpts[],
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
        super((mocks.queue.shift() ?? [{ text: ["(unscripted)"] }]) as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.opts.push(opts);
        yield* super.stream(opts);
      }
    },
  };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { WALKTHROUGH_START } from "@/sk/shell/walkthrough-lines";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = [
  "FEATURE_SK",
  "SK_ROLES",
  "SK_ALLOWED_EMAILS",
  "FEATURE_SK_SHELL_ALL_SCHOOLS",
  "SK_SHELL_CONSUMER",
  "SK_SHELL_SECRET",
  "FEATURE_ROLE_HATS",
  "FEATURE_DIARY",
  "SK_SHELL_MODEL",
  "SK_FAST_MODEL",
  "SK_TRANSLATE_MODEL",
  "SK_AUDIT",
  "SK_ROUTING",
  "SK_MODEL_FIRST_EMAILS",
  "SK_DEBUG_EMAILS",
];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const BIO = { id: "b-bio", title: "Biology Form 4", subject: "Biology", chapters: [{ num: 0, title: "Cell Structure" }, { num: 1, title: "Cell Division" }], owner_id: TEACHER_ID, school_id: SCHOOL_ID, created_at: "2026-10-01T00:00:00Z", sk_product_id: null };
const DONE = { id: "g1", kind: "presentation", status: "done", chapter_ref: "0", params: {}, owner_id: TEACHER_ID, book_id: "b-bio", title: "Cell Structure", created_at: "2026-10-02T00:00:00Z" };
const tables = () => ({
  profiles: [{ role: "teacher", school_id: SCHOOL_ID }],
  schools: [{ id: SCHOOL_ID, name: "Sekolah Seri Bestari", config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [],
  books: [BIO],
  generations: [DONE],
});

type Ev = Record<string, unknown> & { type: string };
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string, extra: Record<string, unknown> = {}) => ({ turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" }, ...extra });
async function say(text: string, extra: Record<string, unknown> = {}): Promise<{ ev: Ev[]; text: string; done: Ev; memory: string }> {
  const ev = (await readEvents(await POST(req(turn(text, extra))))) as Ev[];
  const done = ev.find((e) => e.type === "done")!;
  return { ev, done, memory: done?.memory as string, text: ev.filter((e) => e.type === "text").map((e) => e.text).join("") };
}
let info: ReturnType<typeof vi.spyOn>;
/** The parsed `sk-shell.turn timing` lines this test logged. */
const timings = (): Array<Record<string, unknown>> =>
  info.mock.calls.filter((c: unknown[]) => c[0] === "sk-shell.turn timing").map((c: unknown[]) => JSON.parse(String(c[1])) as Record<string, unknown>);
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

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
  mocks.cookies = { sc_hat: "teacher" };
  mocks.queue = [];
  mocks.constructed = [];
  mocks.opts = [];
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  mocks.createClient.mockResolvedValue(fakeSession(tables(), { user: USER }));
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  info.mockRestore();
  vi.clearAllMocks();
});

describe("the switch", () => {
  it("SK_ROUTING unset: the rules path as before — the tour with no model, timing says rules", async () => {
    const r = await say("Hi SK, show me around?");
    expect(r.ev.map((e) => e.type)).toEqual(["meta", "walkthrough", "text", "done"]);
    expect(r.ev[0]).toMatchObject({ intent: "tour" });
    expect(mocks.constructed).toEqual([]);
    expect(timings()).toEqual([expect.objectContaining({ routing: "rules", route: "tour", model: null, rounds: 0 })]);
  });
  it("SK_MODEL_FIRST_EMAILS turns it on for the listed user only; SK_ROUTING=rules is the rollback", async () => {
    process.env.SK_MODEL_FIRST_EMAILS = "someone@else.example, T@School.Example";
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "start_tour", args: {} }] }]);
    await say("Hi SK, show me around?");
    expect(mocks.constructed).toEqual([HAIKU]);
    process.env.SK_ROUTING = "rules";
    mocks.constructed = [];
    await say("Hi SK, show me around?");
    expect(mocks.constructed).toEqual([]);
    expect(timings().map((t) => t.routing)).toEqual(["model", "rules"]);
  });
});

describe("model routing: every message goes to the model first", () => {
  beforeEach(() => {
    process.env.SK_ROUTING = "model";
  });

  it("'Hi SK, show me around?' → Haiku calls start_tour → the walkthrough START event and its line, one round", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "start_tour", args: {} }] }]);
    const r = await say("Hi SK, show me around?");
    expect(r.ev.map((e) => e.type)).toEqual(["meta", "tool", "walkthrough", "text", "done"]);
    expect(r.ev[0]).toMatchObject({ intent: "ask" });
    expect(r.ev.find((e) => e.type === "walkthrough")).toEqual({ type: "walkthrough" });
    expect(r.text).toBe(WALKTHROUGH_START.en);
    expect(r.done).toMatchObject({ label: "navigation", sources: ["start_tour"] });
    expect(mocks.constructed).toEqual([HAIKU]);
    expect(mocks.opts).toHaveLength(1); // stopped at the tool: no narrating round
    // The full tool set, and the model-first block in the prompt.
    const tools = (mocks.opts[0]!.tools ?? []).map((t) => t.name);
    for (const t of ["navigate", "start_tour", "tour_control", "start_lesson", "diary__note", "knowledge__search", "set_answer_language", "repeat_in_language"]) expect(tools).toContain(t);
    expect(mocks.opts[0]!.system).toContain("MODEL-FIRST");
    expect(timings()).toEqual([expect.objectContaining({ routing: "model", route: "model", model: { tier: "fast", models: [HAIKU], escalated: null }, rounds: 1 })]);
  });

  it("'play chapter 1 of biology' → Haiku calls start_lesson → the Board deep link", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "start_lesson", args: { book: "biology", chapter: "1" } }] }, { text: ["Starting chapter 1 of Biology Form 4 on the Board."] }]);
    const r = await say("play chapter 1 of biology");
    expect(r.ev.find((e) => e.type === "tool")).toMatchObject({ name: "start_lesson", ok: true });
    expect(r.ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present?book=b-bio&chapter=0&autostart=1", label: "Classroom board" });
    expect(r.text).toBe("Starting chapter 1 of Biology Form 4 on the Board.");
    expect(r.done).toMatchObject({ label: "navigation", sources: ["start_lesson"] });
    expect(mocks.constructed).toEqual([HAIKU]);
  });

  it("'start the lesson' with nothing named → start_lesson handed to the rules' planner (Board pick / timetable)", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "start_lesson", args: {} }] }]);
    const r = await say("start the lesson");
    // The planner ran (no Board pick, no timetable here): the way to the Board.
    expect(r.ev.find((e) => e.type === "navigate")).toMatchObject({ type: "navigate", label: "Classroom board" });
    expect(r.ev.filter((e) => e.type === "tool").map((e) => e.name)).not.toContain("start_lesson");
    expect(mocks.opts).toHaveLength(1);
    expect(timings()[0]).toMatchObject({ route: "model>lesson_plan" });
  });

  it("'say that in Arabic' → repeat_in_language → the lang event and ONE translation of the last answer", async () => {
    mocks.queue.push([{ text: ["Hello! I'm SK."] }]);
    const first = await say("hello");
    expect(first.text).toBe("Hello! I'm SK.");
    expect(first.done).toMatchObject({ label: "supplementary" });
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "repeat_in_language", args: { language: "Arabic" } }] }]);
    mocks.queue.push([{ text: ["مرحبا! أنا SK."] }]); // the translation call
    const r = await say("say that in Arabic", { memory: first.memory });
    expect(r.ev.find((e) => e.type === "lang")).toMatchObject({ lang: "ar", dir: "rtl", override: true });
    expect(r.text).toBe("مرحبا! أنا SK.");
    expect(mocks.constructed).toEqual([HAIKU, HAIKU, HAIKU]); // turn 1, turn 2, the translation (Haiku 5.5)
  });

  it("'post a notice to 7B: bring hats' → diary.note → a confirm card, nothing written", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "diary__note", args: { classQuery: "7B", body: "Bring hats." } }] }, { text: ["Here is the note for 7B — confirm it on the card."] }]);
    const r = await say("post a notice to 7B: bring hats");
    expect(r.ev.find((e) => e.type === "tool")).toMatchObject({ name: "diary.note", ok: true });
    const card = r.ev.find((e) => e.type === "confirm") as Ev & { action: string; params: Record<string, unknown> };
    expect(card).toBeTruthy();
    expect(card.action).toBe("diary.note");
    expect(card.params).toMatchObject({ body: "Bring hats." });
    expect(r.done).toMatchObject({ label: "grounded", sources: ["diary.note"] });
    expect(mocks.constructed).toEqual([HAIKU]);
  });

  it("an invented person and an invented email are still dropped (softer check, hard blocks kept)", async () => {
    mocks.queue.push([{ text: ["Mrs Tan teaches 7B. You can reach the office at office@school.example. Happy to help!"] }]);
    const r = await say("who teaches 7B?");
    expect(r.text).toBe("Happy to help!");
    expect(r.done).toMatchObject({ label: "supplementary" });
  });
});

describe("model routing: the pre-model rules still bypass the model", () => {
  beforeEach(() => {
    process.env.SK_ROUTING = "model";
  });
  it("a running tour's 'next' moves the tour instantly — no model", async () => {
    const walk = { active: true, paused: false, role: "teacher", stop: "output", index: 3, total: 14 };
    const r = await say("next", { walk });
    expect(r.ev.find((e) => e.type === "walkthrough")).toEqual({ type: "walkthrough", action: "next" });
    expect(mocks.constructed).toEqual([]);
    expect(timings()[0]).toMatchObject({ routing: "model", route: "walk", model: null });
  });
  it("a book code is never sent to a model: book.activate runs directly", async () => {
    const r = await say("my code is SKB-ABCD-EFGH");
    expect(r.ev.some((e) => e.type === "tool" && e.name === "book.activate")).toBe(true);
    expect(mocks.constructed).toEqual([]);
    expect(mocks.opts).toEqual([]);
    expect(timings()[0]).toMatchObject({ route: "book" });
  });
  it("a teaching question goes to Sonnet, not Haiku", async () => {
    mocks.queue.push([{ text: ["this is not in your data, but osmosis is water moving across a membrane."] }]);
    await say("explain how osmosis works");
    expect(mocks.constructed).toEqual([SONNET]);
    expect(timings()[0]).toMatchObject({ model: { tier: "full", models: [SONNET], escalated: null } });
  });
});

describe("start_tour covers casual asks (model routing)", () => {
  it("'can you show me around the app' → the model is offered start_tour with the casual cues, and its call starts the tour", async () => {
    process.env.SK_ROUTING = "model";
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "start_tour", args: {} }] }]);
    const r = await say("can you show me around the app", { modality: "voice" });
    const tour = (mocks.opts[0]!.tools ?? []).find((t) => t.name === "start_tour");
    expect(tour).toBeTruthy();
    for (const cue of ["show me around", "give me a tour", "what can you do", "what can I do here", "walk me through the app", "how does this work"]) expect(tour!.description, cue).toContain(cue);
    expect(r.ev.find((e) => e.type === "walkthrough")).toEqual({ type: "walkthrough" });
    expect(r.text).toBe(WALKTHROUGH_START.en);
  });
});

describe("SK_DEBUG_EMAILS: a tester-only debug line per turn", () => {
  const debugLines = (): Array<Record<string, unknown>> =>
    info.mock.calls.filter((c: unknown[]) => c[0] === "sk-shell.turn debug").map((c: unknown[]) => JSON.parse(String(c[1])) as Record<string, unknown>);
  const voiceTurn = async () => {
    mocks.queue.push([{ text: ["Here is what I can do."] }]);
    process.env.SK_ROUTING = "model";
    await say("can you show me around the app", { modality: "voice" });
  };
  it("unset → nothing logged", async () => {
    await voiceTurn();
    expect(debugLines()).toEqual([]);
  });
  it("listed (any case) → one line: modality, what was heard, route, model, tools, reply", async () => {
    process.env.SK_DEBUG_EMAILS = "other@x.example, T@School.example";
    await voiceTurn();
    expect(debugLines()).toEqual([
      expect.objectContaining({ modality: "voice", text: "can you show me around the app", route: "model", model: "claude-haiku-5-5", tools: [], reply: "Here is what I can do." }),
    ]);
  });
  it("listed, rules routing → the rules intent as the route", async () => {
    process.env.SK_DEBUG_EMAILS = "t@school.example";
    await say("Hi SK, show me around?");
    expect(debugLines()).toEqual([expect.objectContaining({ modality: "text", route: "tour", model: null, tools: [] })]);
  });
  it("a book code in the text is masked in the line", async () => {
    process.env.SK_DEBUG_EMAILS = "t@school.example";
    await say("my code is SKB-ABCD-EFGH");
    const line = debugLines()[0]!;
    expect(String(line.text)).not.toContain("ABCD-EFGH");
    expect(line).toMatchObject({ route: "book", tools: ["book.activate"] });
  });
  it("unlisted → nothing logged", async () => {
    process.env.SK_DEBUG_EMAILS = "someone@else.example";
    await voiceTurn();
    expect(debugLines()).toEqual([]);
  });
});
