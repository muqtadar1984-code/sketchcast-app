/**
 * "Play chapter 1 from the book" through POST /api/sk/shell/turn (founder
 * 2026-10-30, production: SK called context.resolve + library.find and could
 * only ask a question back, which the grounding check then dropped):
 *   - the rule takes the phrase, start_lesson resolves the book and chapter,
 *     and the turn emits the Board deep link with autostart — no model;
 *   - several books → SK's own "which book?" line, no navigate, no model;
 *   - nothing generated → the guidance line and the Library row;
 *   - the model's tool: a phrasing no rule takes reaches start_lesson through
 *     the model and still navigates;
 *   - the grounding check keeps the founder's clarifying question once her
 *     class 7B is in her context, and still drops an invented name.
 * Stub providers only — no paid model call.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-play-chapter.test.ts
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
import { SK_NOTHING_ON_THAT } from "@/sk/shell/types";
import { OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "SK_SHELL_MODEL", "SK_TRANSLATE_MODEL", "SK_AUDIT", "FEATURE_PRESENT_MODE"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
const BIO = { id: "b-bio", title: "Biology Form 4", subject: "Biology", chapters: [{ num: 0, title: "Cell Structure" }, { num: 1, title: "Cell Division" }], owner_id: TEACHER_ID, school_id: SCHOOL_ID, created_at: "2026-10-01T00:00:00Z", sk_product_id: null };
const CHEM = { id: "b-chem", title: "Chemistry Matters", subject: "Chemistry", chapters: [{ num: 0, title: "Atoms" }], owner_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID, created_at: "2026-10-05T00:00:00Z", sk_product_id: null };
const DONE = { id: "g1", kind: "presentation", status: "done", chapter_ref: "0", params: {}, owner_id: TEACHER_ID, book_id: "b-bio", title: "Cell Structure", created_at: "2026-10-02T00:00:00Z" };
const tables = (over: Record<string, unknown[]> = {}) => ({
  profiles: [{ role: "teacher", school_id: SCHOOL_ID }],
  schools: [{ id: SCHOOL_ID, name: "Sekolah Seri Bestari", config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [],
  books: [BIO],
  generations: [DONE],
  ...over,
});

type Ev = Record<string, unknown> & { type: string };
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string) => ({ turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" } });
async function say(text: string): Promise<{ ev: Ev[]; text: string; done: Ev }> {
  const ev = (await readEvents(await POST(req(turn(text))))) as Ev[];
  return { ev, done: ev.find((e) => e.type === "done")!, text: ev.filter((e) => e.type === "text").map((e) => e.text).join("") };
}
const useTables = (t: Record<string, unknown[]>) => mocks.createClient.mockResolvedValue(fakeSession(t as never, { user: USER }));

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
  mocks.cookies = { sc_hat: "teacher" };
  mocks.queue = [];
  mocks.constructed = [];
  mocks.opts = [];
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  useTables(tables());
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("the founder's phrase, end to end (rules → start_lesson, no model)", () => {
  it("'Hi SK, play chapter 1 from the book' → the Board deep link with autostart", async () => {
    const r = await say("Hi SK, play chapter 1 from the book");
    const board = r.ev.find((e) => e.type === "navigate");
    expect(r.ev.map((e) => e.type).filter((t) => t !== "lang")).toEqual(["meta", "tool", "text", "navigate", "done"]);
    expect(r.ev[0]).toMatchObject({ intent: "navigate" });
    expect(r.ev.find((e) => e.type === "tool")).toMatchObject({ name: "start_lesson", ok: true });
    expect(board).toEqual({ type: "navigate", path: "/present?book=b-bio&chapter=0&autostart=1", label: "Classroom board" });
    expect(r.text).toBe("Starting chapter 1 of Biology Form 4 on the Board.");
    expect(r.done).toMatchObject({ sources: ["start_lesson", "navigate"], label: "navigation" });
    expect(mocks.constructed).toEqual([]);
  });
  it("several books → SK's own 'which book?' line (her books only), no navigate, no model", async () => {
    useTables(tables({ books: [BIO, CHEM, { ...CHEM, id: "b-x", title: "Elsewhere", school_id: "other", owner_id: OTHER_TEACHER_ID }] }));
    const r = await say("play chapter 1");
    expect(r.ev.some((e) => e.type === "navigate")).toBe(false);
    expect(r.text).toBe("Which book — Chemistry Matters or Biology Form 4?");
    expect(r.done).toMatchObject({ sources: ["start_lesson"], label: "grounded" });
    expect(mocks.constructed).toEqual([]);
  });
  it("nothing generated → the guidance line and the Library row", async () => {
    useTables(tables({ generations: [] }));
    const r = await say("start chapter one of biology");
    expect(r.ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/dashboard?book=b-bio", label: "Library" });
    expect(r.text).toBe("Chapter 1 of Biology Form 4 hasn't been generated yet — I'm opening it in your Library so you can generate the kit.");
    expect(mocks.constructed).toEqual([]);
  });
  it("a question about a chapter still goes to the model", async () => {
    mocks.queue.push([{ text: ["(answer)"] }]);
    const r = await say("what is in chapter 1?");
    expect(r.ev[0]).toMatchObject({ intent: "ask" });
    expect(r.ev.some((e) => e.type === "tool" && e.name === "start_lesson")).toBe(false);
    expect(mocks.constructed).toHaveLength(1);
  });
});

describe("the model's tool", () => {
  it("a phrasing no rule takes → the model calls start_lesson and the turn navigates", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "start_lesson", args: { book: "biology", chapter: "cell structure" } }] }, { text: ["Starting chapter 1 of Biology Form 4 on the Board."] }]);
    const r = await say("I'd love to get going with the cell structure bit of my biology book");
    expect(r.ev[0]).toMatchObject({ intent: "ask" });
    expect((mocks.opts[0]!.tools ?? []).map((t) => t.name)).toContain("start_lesson");
    expect(mocks.opts[0]!.system).toContain("start_lesson");
    expect(r.ev.find((e) => e.type === "tool" && e.name === "start_lesson")).toMatchObject({ ok: true });
    expect(r.ev.find((e) => e.type === "navigate")).toEqual({ type: "navigate", path: "/present?book=b-bio&chapter=0&autostart=1", label: "Classroom board" });
    expect(r.done).toMatchObject({ label: "navigation", sources: ["start_lesson"] });
    expect(mocks.opts).toHaveLength(2);
  });
});

describe("grounding keeps SK's own clarifying question", () => {
  const FOUNDER = "Do you mean a class like 7B, or a different book title?";
  it("the founder's sentence is said, not dropped, when 7B is her class", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "library.find", args: { query: "biology" } }] }, { text: [FOUNDER] }]);
    const r = await say("hmm what about the biology thing we did");
    expect(r.text).toBe(FOUNDER);
    expect(r.done).toMatchObject({ label: "grounded" });
    expect(r.done.trimmed).toBeUndefined();
  });
  it("an invented name is still dropped", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "library.find", args: { query: "biology" } }] }, { text: ["Do you mean Zubair's class?"] }]);
    const r = await say("hmm what about the biology thing we did");
    expect(r.text).toBe(SK_NOTHING_ON_THAT);
  });
});
