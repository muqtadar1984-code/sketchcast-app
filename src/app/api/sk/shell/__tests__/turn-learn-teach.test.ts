/**
 * /api/sk/shell/turn — SK TEACHES BEYOND THE KIT, IN THE CHAT (student Board
 * plan 2026-10-31, phase 3), end to end through the route with the model
 * mocked (no paid call):
 *   - a worksheet gap (`teach: {trigger: "gap"}`) → ONE model call, no tools,
 *     the lesson map's segment for THAT question + the gap as DATA, never the
 *     answer; the lesson comes back as Markdown with a picture from her deck;
 *     a line carrying the worksheet's answer is dropped;
 *   - the idea and steps the kit cannot carry make the lesson "Extra";
 *   - "I don't get it" switches to teach mode for her last question;
 *   - her answer to SK's check question gets SK's short reply;
 *   - a teaching turn writes NO gap rows unless SK fails it; "taught" goes to
 *     the 0173 learning facts (consent decides) and the signed memory;
 *   - nothing of this for a teacher.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-learn-teach.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  script: [] as unknown[],
  opts: [] as GenerateOpts[],
  after: [] as Array<() => Promise<unknown>>,
  recorded: [] as unknown[][],
  notes: [] as unknown[][],
  answer: "3/4" as string | null,
  picture: { generationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", n: 4, title: "Equivalent fractions" } as { generationId: string; n: number; title: string } | null,
  manifest: null as unknown,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (task: () => Promise<unknown>) => void mocks.after.push(task) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/sk/gaps/store", async (orig) => ({ ...(await orig<typeof import("@/sk/gaps/store")>()), recordGaps: async (_a: unknown, rows: unknown[]) => void mocks.recorded.push(rows) }));
vi.mock("@/utils/present/learner-server", async (orig) => ({ ...(await orig<typeof import("@/utils/present/learner-server")>()), sharedToMe: async () => true }));
vi.mock("@/sk/student-cap", async (orig) => ({ ...(await orig<typeof import("@/sk/student-cap")>()), meterStudentTurn: async () => ({ ok: true, count: 1, metered: true }) }));
vi.mock("@/sk/manifest/store", async (orig) => ({
  ...(await orig<typeof import("@/sk/manifest/store")>()),
  readManifest: async () => (mocks.manifest ? { status: "ready", manifest: mocks.manifest, builtAt: "2026-10-31T00:00:00Z" } : { status: "missing" }),
}));
vi.mock("@/sk/capabilities/documents", async (orig) => ({
  ...(await orig<typeof import("@/sk/capabilities/documents")>()),
  openUnitAnswer: async () => mocks.answer,
  openUnitDeckPicture: async () => mocks.picture,
}));
vi.mock("@/sk/facts", async (orig) => ({ ...(await orig<typeof import("@/sk/facts")>()), noteLearning: async (...a: unknown[]) => void mocks.notes.push(a) }));
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
import { fakeAdmin, fakeManifest, fakeSession, readEvents, TEACHER_ID, SCHOOL_ID } from "@/sk/shell/__tests__/fixtures";
import type { SkGapInput } from "@/sk/gaps/store";

const ENV = ["FEATURE_SK", "NEXT_PUBLIC_FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "SK_SHELL_MODEL", "SK_AUDIT", "SK_ROUTING", "SK_MODEL_FIRST_EMAILS", "FEATURE_ROLE_HATS"];
const saved: Record<string, string | undefined> = {};
const STUDENT_ID = "33333333-3333-4333-8333-333333333333";
const EMAIL = "aisha@student.example";
const STUDENT = { id: STUDENT_ID, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" };
const GEN = "55555555-5555-4555-8555-555555555555";
const BOARD = { sessionId: "44444444-4444-4444-8444-444444444444", generationId: GEN, k: 0, segments: [{ k: 0, id: "s1", heading: "Fractions" }, { k: 1, id: "s2", heading: "Equivalent fractions" }] };
const NARRATION = "Equivalent fractions show the same amount. Multiply the top and bottom by the same number, or divide them by the same number.";
const GAP = { trigger: "gap", generationId: "66666666-6666-4666-8666-666666666666", questionId: "q3", questionText: "Simplify 6/8.", concept: "Equivalent fractions", attempts: 2, lastAnswer: "6/4", reason: "wrong_twice" };

const LESSON = [
  "TITLE: Equivalent fractions",
  "IDEA: Equivalent fractions show the same amount.",
  "STEP: Multiply the top and bottom by the same number.",
  "STEP: Or divide the top and bottom by the same number.",
  "EXAMPLE: Simplify $\\frac{10}{15}$.",
  "WORK: Both 10 and 15 divide by 5.",
  "WORK: $$\\frac{10}{15} = \\frac{2}{3}$$",
  "RESULT: $\\frac{2}{3}$",
  "CHECK: Is $\\frac{2}{4}$ the same as $\\frac{1}{2}$?",
  "SOURCE: kit",
].join("\n");

const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
const body = (text: string, extra: Record<string, unknown> = {}) => ({ turnId: `t-${++n}`, text, modality: "text", collector: { path: "/present", locale: "en", board: BOARD }, ...extra });

async function run(text: string, extra: Record<string, unknown> = {}) {
  const ev = await readEvents(await POST(req(body(text, extra))));
  for (const t of mocks.after.splice(0)) await t();
  const rows = mocks.recorded.splice(0).flat() as SkGapInput[];
  const done = ev.find((e) => e.type === "done") as Record<string, unknown> | undefined;
  return { ev, rows, done, memory: done?.memory as string | undefined, text: ev.filter((e) => e.type === "text").map((e) => e.text).join("") as string };
}
const lastQuestion = (o: GenerateOpts): string => {
  const m = o.messages.at(-1);
  return m && "text" in m ? m.text : "";
};

function signIn(role: "student" | "teacher" = "student") {
  const user = role === "student" ? STUDENT : { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };
  mocks.createClient.mockResolvedValue(
    fakeSession(
      {
        profiles: [{ role, school_id: role === "student" ? null : SCHOOL_ID }],
        schools: [{ config: {} }],
        coordinator_scope: [],
        parent_links: [],
        classes: [],
        enrollments: [],
        books: [],
        generation_shares: [{ generation_id: GEN }],
      },
      { user },
    ),
  );
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.NEXT_PUBLIC_FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,student";
  process.env.SK_ALLOWED_EMAILS = `t@school.example, ${EMAIL}`;
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "learn-teach-route-secret-of-adequate-length";
  mocks.script = [];
  mocks.opts = [];
  mocks.after = [];
  mocks.recorded = [];
  mocks.notes = [];
  mocks.answer = "3/4";
  mocks.picture = { generationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", n: 4, title: "Equivalent fractions" };
  mocks.manifest = fakeManifest(
    [
      { id: "s1", heading: "Fractions", narration: "A fraction is part of a whole." },
      { id: "s2", heading: "Equivalent fractions", narration: NARRATION, points: ["Same amount", "Multiply or divide top and bottom"] },
    ],
    [{ id: "c-eq", name: "Equivalent fractions", segmentIds: ["s2"] }],
    [{ q_id: "q3", source: "worksheet", segment_ids: ["s2"] }],
  );
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  signIn();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("a worksheet gap (sk:learner-gap → teach)", () => {
  it("ONE model call, no tools: the question's own segment and the gap as DATA, never the answer; a Markdown lesson + her deck's picture", async () => {
    mocks.script = [{ text: [LESSON] }];
    const r = await run("", { teach: GAP });
    expect(r.ev.map((e) => e.type)).toEqual(["meta", "text", "picture", "done"]);
    expect(mocks.opts).toHaveLength(1);
    const o = mocks.opts[0];
    expect(o.tools).toBeUndefined();
    expect(o.maxTokens).toBe(700);
    // the lesson map's segment for q3, the gap as data
    expect(o.system).toContain(`narration: ${NARRATION}`);
    expect(o.system).toContain('<gap data_only="true">');
    expect(o.system).toContain("worksheet question (do NOT solve it): Simplify 6/8.");
    expect(o.system).toContain("Never give, solve or confirm the answer to her worksheet");
    // the worksheet's answer (read server-side) is never in the prompt
    expect(o.system).not.toContain("3/4");
    expect(lastQuestion(o)).toContain("different numbers or a different situation");
    expect(lastQuestion(o)).not.toContain("3/4");
    // the lesson as SK's chat shows it
    expect(r.text).toContain("### Equivalent fractions");
    expect(r.text).toContain("**Steps**\n1. Multiply the top and bottom by the same number.");
    expect(r.text).toContain("$$\\frac{10}{15} = \\frac{2}{3}$$");
    expect(r.text).toContain("**Your turn:** Is $\\frac{2}{4}$ the same as $\\frac{1}{2}$?");
    expect(r.text).not.toContain("Extra");
    expect(r.ev[2]).toEqual({ type: "picture", generationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", n: 4, title: "Equivalent fractions" });
    expect(r.done).toMatchObject({ label: "grounded", sources: ["sk.teach", "manifest"], teach: { trigger: "gap", extra: false } });
    expect(r.done?.trimmed).toBeUndefined();
  });

  it("a line that carries the worksheet's answer is dropped (and the turn says trimmed)", async () => {
    mocks.script = [{ text: [LESSON.replace("STEP: Or divide the top and bottom by the same number.", "STEP: So 6/8 becomes 3/4.")] }];
    const r = await run("", { teach: GAP });
    expect(r.text).not.toContain("3/4");
    expect(r.text).toContain("1. Multiply the top and bottom by the same number.");
    expect(r.done).toMatchObject({ trimmed: true });
  });

  it("a teaching turn writes NO gap rows (even a lesson saying \"you can't\"), and remembers what it taught", async () => {
    mocks.script = [{ text: [LESSON.replace("IDEA: Equivalent fractions show the same amount.", "IDEA: Equivalent fractions show the same amount, and I can't stress that enough.")] }];
    const r = await run("", { teach: GAP });
    expect(r.rows).toEqual([]);
    expect(mocks.notes).toHaveLength(1);
    const [, studentId, note] = mocks.notes[0] as [unknown, string, { kind: string; source: string; detail: Record<string, unknown> }];
    expect(studentId).toBe(STUDENT_ID);
    expect(note).toMatchObject({ kind: "explained", source: "sk.board.teach", detail: { concept: "Equivalent fractions", trigger: "gap", extra: false, question_id: "q3" } });
    expect(JSON.stringify(note)).not.toContain("3/4");
    expect(JSON.stringify(note)).not.toContain("6/4"); // never her answer
  });

  it("SK failing to teach IS a gap: the honest line and one tool_failed row", async () => {
    mocks.script = [{ text: ["Sure! Fractions are fun."] }];
    const r = await run("", { teach: GAP });
    expect(r.text).toBe("I couldn't do that just now — try again or rephrase.");
    expect(r.done).toMatchObject({ label: "declined" });
    expect(r.rows.map((x) => x.signal)).toEqual(["tool_failed"]);
  });
});

describe("Extra: what the kit does not carry", () => {
  it("steps the lesson map cannot support make the lesson Extra (labelled, supplementary)", async () => {
    mocks.script = [{ text: [LESSON.replace("STEP: Or divide the top and bottom by the same number.", "STEP: Euclid's algorithm finds the greatest common divisor in 3 moves.")] }];
    const r = await run("", { teach: GAP });
    expect(r.text.split("\n")[0]).toBe("**Extra** · beyond your lesson");
    expect(r.done).toMatchObject({ label: "supplementary", teach: { trigger: "gap", extra: true } });
  });

  it("the Extra step after the kit is always Extra", async () => {
    mocks.script = [{ text: [LESSON] }];
    const r = await run("", { teach: { trigger: "extra" } });
    expect(lastQuestion(mocks.opts[0])).toContain("ONE short Extra step");
    expect(r.text.startsWith("**Extra** · beyond your lesson")).toBe(true);
    expect(r.done).toMatchObject({ teach: { trigger: "extra", extra: true } });
  });
});

describe("confusion in conversation (no client trigger)", () => {
  it("'I don't get it' after a question → teach mode for THAT question", async () => {
    mocks.script = [{ text: ["They show the same amount."] }];
    const first = await run("what is an equivalent fraction?");
    expect(first.done?.teach).toBeUndefined();
    // Her question is in the memory; the next message says she is lost.
    mocks.opts = [];
    mocks.script = [{ text: [LESSON] }];
    const r = await run("I don't get it", { memory: first.memory });
    expect(r.done).toMatchObject({ teach: { trigger: "confusion" } });
    expect(lastQuestion(mocks.opts[0])).toContain('She says she does not understand "what is an equivalent fraction?"');
    expect(r.rows).toEqual([]);
  });

  it("'explain again' is confusion, not a Board explain of 'again'", async () => {
    mocks.script = [{ text: [LESSON] }];
    const r = await run("explain it again");
    expect(r.ev.some((e) => e.type === "board")).toBe(false);
    expect(r.done).toMatchObject({ teach: { trigger: "confusion" } });
  });
});

describe("her answer to SK's check question", () => {
  it("gets SK's short reply, once; the next message is an ordinary turn", async () => {
    mocks.script = [{ text: [LESSON] }];
    const lesson = await run("", { teach: GAP });
    mocks.opts = [];
    mocks.script = [{ text: ["Yes — well done! Both show one half. Now try your worksheet question again."] }];
    const r = await run("yes they are the same", { memory: lesson.memory });
    expect(mocks.opts).toHaveLength(1);
    expect(mocks.opts[0].maxTokens).toBe(260);
    expect(mocks.opts[0].system).toContain("SK's check question: Is $\\frac{2}{4}$ the same as $\\frac{1}{2}$?");
    expect(mocks.opts[0].system).toContain("her answer: yes they are the same");
    expect(r.text).toBe("Yes — well done! Both show one half. Now try your worksheet question again.");
    expect(r.done).toMatchObject({ label: "supplementary", teach: { trigger: "check", extra: false } });
    expect(r.rows).toEqual([]);
  });

  it("a Board command is never taken for her answer — model routing too", async () => {
    process.env.SK_ROUTING = "model";
    mocks.script = [{ text: [LESSON] }];
    const lesson = await run("", { teach: GAP });
    mocks.opts = [];
    mocks.script = [{ text: ["Here is the next page."] }];
    const r = await run("next page", { memory: lesson.memory });
    expect(r.done?.teach).toBeUndefined();
    expect(mocks.opts.every((o) => !o.system.includes("SK's check question"))).toBe(true);
  });
});

describe("only a student on her own Board", () => {
  it("a teacher's `teach` request is ignored (an ordinary turn)", async () => {
    signIn("teacher");
    mocks.script = [{ text: ["Equivalent fractions show the same amount."] }];
    const r = await run("", { teach: GAP });
    expect(r.done?.teach).toBeUndefined();
  });

  it("a student with no Board open is not taught from a `teach` request", async () => {
    mocks.script = [{ text: ["Here is your lesson list."] }];
    const ev = await readEvents(await POST(req({ ...body("", { teach: GAP }), collector: { path: "/dashboard", locale: "en" } })));
    const done = ev.find((e) => e.type === "done") as Record<string, unknown> | undefined;
    expect(done?.teach).toBeUndefined();
  });
});
