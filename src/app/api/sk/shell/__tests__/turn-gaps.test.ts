/**
 * /api/sk/shell/turn — the SK gap tracker's capture (2026-10-31): SK's own
 * sk.note_gap (never a chip, a source or a tool that answered), a failed tool,
 * a grounding drop, a built-in refusal on the rules path, and the phrase net
 * only when nothing else fired. Rows are written ONCE, through after().
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-gaps.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";
import type { SkGapInput } from "@/sk/gaps/store";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  script: [] as unknown[],
  opts: [] as GenerateOpts[],
  after: [] as Array<() => Promise<unknown>>,
  recorded: [] as unknown[][],
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: () => Promise<unknown>) => void mocks.after.push(task) }));
vi.mock("@/sk/gaps/store", async (orig) => ({
  ...(await orig<typeof import("@/sk/gaps/store")>()),
  recordGaps: async (_admin: unknown, gaps: unknown[]) => void mocks.recorded.push(gaps),
}));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor() {
        super(mocks.script as StubTurn[]);
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
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_PARENT_PORTAL", "FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_CATALOGUE_TAB", "SK_SHELL_MODEL", "SK_AUDIT", "SK_ROUTING", "SK_MODEL_FIRST_EMAILS"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

const tables = () => ({
  profiles: [{ role: "teacher", school_id: SCHOOL_ID }],
  schools: [{ config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [{ class_id: "c7b", student_id: "s1", profiles: { full_name: "Ali Hassan", username: "ali" } }],
  books: [],
});
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string, extra: Record<string, unknown> = {}) => ({ turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard/classes", locale: "en" }, ...extra });

/** One turn, then the after() tasks run: the events and the gap rows written. */
async function run(text: string, extra: Record<string, unknown> = {}) {
  const body = turn(text, extra);
  const ev = await readEvents(await POST(req(body)));
  const tasks = mocks.after.splice(0);
  for (const t of tasks) await t();
  const rows = mocks.recorded.splice(0).flat() as SkGapInput[];
  return { ev, rows, tasks, body };
}

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
  mocks.opts = [];
  mocks.after = [];
  mocks.recorded = [];
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  mocks.createClient.mockResolvedValue(fakeSession(tables(), { user: USER }));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("signal A — sk.note_gap", () => {
  it("is offered to the main model call with the prompt rule, and recorded without a chip, a source or any visible text", async () => {
    mocks.script = [
      { text: ["Sorry, I can't email your class from here."], toolCalls: [{ id: "g1", name: "sk__note_gap", args: { wanted: "email the worksheet to 7B", why: "no email feature" } }] },
      { text: [] },
    ];
    const { ev, rows, tasks, body } = await run("email the worksheet to 7B please");
    expect(mocks.opts[0]!.tools?.map((t) => t.name)).toContain("sk__note_gap");
    expect(mocks.opts[0]!.system).toContain("sk__note_gap");
    // Never a chip, a source or a word of its own.
    expect(ev.some((e) => e.type === "tool")).toBe(false);
    const text = ev.filter((e) => e.type === "text").map((e) => e.text).join("");
    expect(text).toBe("Sorry, I can't email your class from here.");
    expect(JSON.stringify(ev)).not.toContain("note_gap");
    expect((ev.find((e) => e.type === "done") as { sources: string[] }).sources).toEqual([]);
    // One write, after the reply; `self` only (the phrase net stays quiet).
    expect(tasks).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turnId: body.turnId,
      userId: TEACHER_ID,
      role: "teacher",
      locale: "en",
      page: "/dashboard/classes",
      modality: "text",
      signal: "self",
      question: "email the worksheet to 7B please",
      reply: "Sorry, I can't email your class from here.",
      wanted: "email the worksheet to 7B",
    });
    expect(rows[0]!.context).toEqual({ items: [{ wanted: "email the worksheet to 7B", why: "no email feature" }] });
  });

  it("the teaching / single-shot calls never carry the tool", async () => {
    mocks.script = [{ text: ["Hello."] }];
    await run("hello there friend");
    for (const o of mocks.opts) if (!o.tools) expect(o.system).not.toContain("sk__note_gap");
  });
});

describe("signals B and C", () => {
  it("a failed tool → tool_failed with the tool and its error; the phrase net stays quiet", async () => {
    mocks.script = [{ toolCalls: [{ id: "c1", name: "email__send", args: { to: "7B" } }] }, { text: ["Done."] }];
    const { ev, rows } = await run("send an email to 7B");
    expect(ev.find((e) => e.type === "text")).toEqual({ type: "text", text: SK_NOTHING_ON_THAT });
    expect(rows.map((r) => r.signal)).toEqual(["tool_failed"]);
    expect(rows[0]!.tools).toEqual(["email.send"]);
    expect(rows[0]!.context).toEqual({ items: [{ tool: "email.send", error: "unknown_capability", summary: "Unknown capability." }] });
  });

  it("a grounding drop → grounding with what was dropped", async () => {
    mocks.script = [{ text: ["Class 7B has 31 learners and Ahmad Zaki leads with 98%."] }];
    const { rows } = await run("how many learners does my class have");
    expect(rows.map((r) => r.signal)).toEqual(["grounding"]);
    const item = (rows[0]!.context as { items: Array<{ where: string; unsupported: string[] }> }).items[0]!;
    expect(item.where).toBe("model");
    expect(item.unsupported).toEqual(expect.arrayContaining(["31"]));
  });

  it("rules path: an answer language SK cannot speak → refusal, no model", async () => {
    const { rows } = await run("say that in Tamil");
    expect(mocks.opts).toHaveLength(0);
    expect(rows.map((r) => r.signal)).toEqual(["refusal"]);
    expect(rows[0]!.route).toBe("lang");
    expect((rows[0]!.context as { items: Array<{ kind: string }> }).items[0]!.kind).toBe("language_unsupported");
  });
});

describe("signal D — the phrase net", () => {
  it("records `phrase` when the reply says it cannot and nothing else fired", async () => {
    mocks.script = [{ text: ["I'm not able to see attendance from here."] }];
    const { rows } = await run("show me attendance trends");
    expect(rows.map((r) => r.signal)).toEqual(["phrase"]);
    expect(rows[0]!.context).toEqual({ items: [{ lang: "en", match: "i'm not able" }] });
  });

  it("a turn SK answered writes nothing at all", async () => {
    mocks.script = [{ toolCalls: [{ id: "c1", name: "context.resolve", args: { query: "7B", kind: "class" } }] }, { text: ["Yes — 7B is one of your classes."] }];
    const { rows, tasks } = await run("is 7B one of my classes");
    expect(rows).toEqual([]);
    expect(tasks).toHaveLength(0);
  });
});
