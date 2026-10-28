/**
 * S0 acceptance on a seeded class (Final Plan 2026-10-28 §6 S0), mechanically,
 * through POST /api/sk/shell/turn with the REAL capability handlers over a
 * filtering fake session seeded with two tenants: 7B (this teacher: Aisha,
 * Ben, Chen, Dina, Emir; one quiz due yesterday; 3 done) and 8A (the other
 * teacher: Gopal, Hana and a second "Emir"; its own overdue quiz).
 *
 *   - "show me 7B's analytics" lands on /dashboard/analytics?c=<7B id> with
 *     no model constructed, inside 2 s.
 *   - "How many finished the quiz?" returns the tool's count and names, and
 *     every number and every name in SK's answer is traceable to a tool
 *     result (asserted token by token, independently of groundingCheck).
 *   - "who is at risk in 7B" names the at-risk learner per the school-health
 *     rule, and 8A's Emir never appears.
 *   - an invented name / number is stripped; an empty tool set declines with
 *     exactly SK_NOTHING_ON_THAT; whole-school rows (RLS leak shape) never
 *     reach the facts.
 *
 * The fixtures' fakeSession ignores every filter, which cannot seed two
 * tenants (assignments.status trusts its own `classes.eq("teacher_id", me)`
 * predicate), so this suite carries a filtering fake: eq/neq/is/in honoured,
 * `ignoreIn` reproduces the "RLS shows the whole school" shape.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/acceptance-s0.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";
import type { SkCapability, SkCapabilityResult } from "@/sk/shell/types";

type Recorded = { name: string; args: Record<string, unknown>; result: SkCapabilityResult };

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  script: [] as unknown[],
  constructed: [] as string[],
  /** Every real capability result the route obtained this turn (facts included). */
  results: [] as Array<{ name: string; args: Record<string, unknown>; result: { ok: boolean; summary: string; facts?: unknown[]; entities?: unknown[] } }>,
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
        yield* super.stream(opts);
      }
    },
  };
});
// The REAL registry, every handler wrapped so the test sees the full result
// (the route's `tool` event carries only a 200-char summary).
vi.mock("@/sk/capabilities", async () => {
  const real = await vi.importActual<typeof import("@/sk/capabilities")>("@/sk/capabilities");
  const REGISTRY = real.REGISTRY.map(
    (c): SkCapability => ({
      ...c,
      handler: async (ctx, args, deps) => {
        const result = await c.handler(ctx, args, deps);
        mocks.results.push({ name: c.meta.name, args, result });
        return result;
      },
    }),
  );
  return { ...real, REGISTRY };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { SK_NOTHING_ON_THAT } from "@/sk/shell/types";
import { supportTokens } from "@/sk/shell/prompt";
import { OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeAdmin, readEvents } from "@/sk/shell/__tests__/fixtures";

// ── A filtering fake session ─────────────────────────────────────────────────

type Row = Record<string, unknown>;
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

/* eslint-disable @typescript-eslint/no-explicit-any */
function seededSession(tables: Record<string, Row[]>, opts: { ignoreIn?: boolean } = {}) {
  const log: string[] = [];
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let single = false;
    const b: any = {};
    const note = (name: string, args: unknown[]) => log.push(`${table}.${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
    for (const m of ["select", "order", "limit", "ilike", "not", "gte", "lte", "insert", "update"]) {
      b[m] = (...args: unknown[]) => {
        note(m, args);
        return b;
      };
    }
    b.eq = (c: string, v: unknown) => {
      note("eq", [c, v]);
      filters.push((r) => r[c] === v);
      return b;
    };
    b.neq = (c: string, v: unknown) => {
      note("neq", [c, v]);
      filters.push((r) => r[c] !== v);
      return b;
    };
    b.is = (c: string, v: unknown) => {
      note("is", [c, v]);
      filters.push((r) => (v === null ? r[c] == null : r[c] === v));
      return b;
    };
    b.in = (c: string, list: unknown[]) => {
      note("in", [c, list]);
      if (!opts.ignoreIn) filters.push((r) => list.includes(r[c]));
      return b;
    };
    b.maybeSingle = () => {
      single = true;
      note("maybeSingle", []);
      return b;
    };
    b.single = b.maybeSingle;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length }).then(res, rej);
    };
    return b;
  };
  return {
    log,
    from,
    rpc: (fn: string, args?: Record<string, unknown>) => {
      log.push(`rpc.${fn}(${JSON.stringify(args ?? {})})`);
      return Promise.resolve({ data: null, error: null });
    },
    auth: { getUser: async () => ({ data: { user: USER } }) },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── The seed: 7B (ours) and 8A (the other teacher's), one school ────────────

const HOUR = 3_600_000;
const C7B = "c7b";
const C8A = "c8a";
const enrol = (cls: string, id: string, name: string) => ({ class_id: cls, student_id: id, profiles: { full_name: name, username: null, parent_email: null } });

function seed(over: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  return {
    profiles: [
      { id: TEACHER_ID, role: "teacher", school_id: SCHOOL_ID, full_name: "Nurul Hassan", username: null },
      { id: OTHER_TEACHER_ID, role: "teacher", school_id: SCHOOL_ID, full_name: "Ravi Kumar", username: null },
    ],
    schools: [{ id: SCHOOL_ID, config: {} }],
    coordinator_scope: [],
    parent_links: [],
    books: [],
    classes: [
      { id: C7B, name: "7B", grade: "Form 1", teacher_id: TEACHER_ID, school_id: SCHOOL_ID, created_at: at(-60 * 24 * HOUR) },
      { id: C8A, name: "8A", grade: "Form 2", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID, created_at: at(-59 * 24 * HOUR) },
    ],
    enrollments: [
      enrol(C7B, "s1", "Aisha"),
      enrol(C7B, "s2", "Ben"),
      enrol(C7B, "s3", "Chen"),
      enrol(C7B, "s4", "Dina"),
      enrol(C7B, "s5", "Emir"),
      enrol(C8A, "s7", "Gopal"),
      enrol(C8A, "s8", "Hana"),
      // Emir's namesake in the other teacher's class, also never started.
      enrol(C8A, "s9", "Emir"),
    ],
    generation_shares: [
      // The acceptance quiz: due yesterday, 3 of 5 done.
      { id: "sh-quiz", generation_id: "quiz", class_id: C7B, shared_by: TEACHER_ID, due_at: at(-24 * HOUR), created_at: at(-72 * HOUR), generations: { kind: "quiz", chapter_ref: "1", title: "Cells quiz" } },
      { id: "sh-t2", generation_id: "t2quiz", class_id: C8A, shared_by: OTHER_TEACHER_ID, due_at: at(-24 * HOUR), created_at: at(-72 * HOUR), generations: { kind: "quiz", chapter_ref: "0", title: "8A quiz" } },
    ],
    student_progress: [
      { generation_id: "quiz", student_id: "s1", status: "completed", updated_at: at(-48 * HOUR) },
      { generation_id: "quiz", student_id: "s2", status: "revised", updated_at: at(-24 * HOUR) },
      { generation_id: "quiz", student_id: "s4", status: "in_progress", updated_at: at(-48 * HOUR) }, // active → not at risk on one item
      { generation_id: "t2quiz", student_id: "s7", status: "completed", updated_at: at(-24 * HOUR) },
    ],
    submissions: [
      { id: "sub1", generation_id: "quiz", student_id: "s3", auto_score: 4, max_score: 5, teacher_score: null, submitted_at: at(-24 * HOUR), graded_at: null, grade_status: "pending" },
      { id: "sub2", generation_id: "t2quiz", student_id: "s8", auto_score: 3, max_score: 5, teacher_score: null, submitted_at: at(-24 * HOUR), graded_at: null, grade_status: "pending" },
    ],
    generations: [
      { id: "quiz", owner_id: TEACHER_ID },
      { id: "t2quiz", owner_id: OTHER_TEACHER_ID },
    ],
    ...over,
  };
}

const QUIZ_SUMMARY = "Cells quiz (7B): 3 of 5 done, 2 not done (2 overdue), 1 to grade. Not done: Dina, Emir.";
const RISK_SUMMARY_7B = "1 at risk in 7B: Emir — never started.";

// ── Harness ─────────────────────────────────────────────────────────────────

const ENV = ["FEATURE_PARENT_PORTAL", "FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_SCHOOL_ANALYTICS", "FEATURE_CATALOGUE_TAB", "SK_SHELL_MODEL", "SK_AUDIT"];
const saved: Record<string, string | undefined> = {};

function signIn(session: ReturnType<typeof seededSession>) {
  mocks.createClient.mockResolvedValue(session);
}
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const turn = (text: string) => ({ turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" } });
const ask = async (text: string) => readEvents(await POST(req(turn(text))));

type Ev = Record<string, unknown>;
const only = (ev: Ev[], type: string) => ev.filter((e) => e.type === type);
const one = (ev: Ev[], type: string) => {
  const hits = only(ev, type);
  expect(hits, `exactly one ${type} event`).toHaveLength(1);
  return hits[0];
};
const textOf = (ev: Ev[]) => one(ev, "text").text as string;
const doneOf = (ev: Ev[]) => one(ev, "done") as { label: string; sources: string[]; latencyMs: number };
const recorded = (name: string): Recorded => {
  const r = mocks.results.find((x) => x.name === name);
  expect(r, `${name} was run`).toBeDefined();
  return r as Recorded;
};

const NUMBER_RE = /\d+(?:[.,:/]\d+)*%?/g;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const norm = (t: string) => t.toLowerCase().replace(/[’']s$/u, "");

/** The S0 acceptance invariant, asserted independently of groundingCheck:
 *  every number token and every capitalised word (sentence-initial excepted,
 *  "I"/"SK" excepted) in SK's spoken answer occurs in a TOOL RESULT of this
 *  turn — summary or facts. The user's question is deliberately NOT support. */
function assertTraceableToTools(text: string) {
  const support = supportTokens(mocks.results.flatMap((r) => [r.result.summary, ...(r.result.facts ?? [])]));
  const sentences = text.split(/(?<=[.!?])\s+/u).filter(Boolean);
  for (const s of sentences) {
    for (const n of s.match(NUMBER_RE) ?? []) expect(support, `number "${n}" in a tool result`).toContain(norm(n));
    (s.match(WORD_RE) ?? []).forEach((w, i) => {
      if (i === 0 || !/^\p{Lu}/u.test(w) || !/\p{Ll}/u.test(w.slice(1)) || ["I", "SK"].includes(w)) return;
      expect(support, `name "${w}" in a tool result`).toContain(norm(w));
    });
  }
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "acceptance-s0-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.FEATURE_DIARY = "true";
  process.env.FEATURE_SCHOOL_ANALYTICS = "true";
  process.env.FEATURE_CATALOGUE_TAB = "true";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.script = [];
  mocks.constructed = [];
  mocks.results = [];
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  signIn(seededSession(seed()));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

// ── The cases ───────────────────────────────────────────────────────────────

describe("S0 acceptance on a seeded class", () => {
  it("1. navigate: 'show me 7B's analytics' lands on /dashboard/analytics?c=<7B id>, no model, under 2 s", async () => {
    const t0 = performance.now();
    const res = await POST(req(turn("show me 7B's analytics")));
    const ev = await readEvents(res);
    const wallMs = performance.now() - t0;

    expect(res.status).toBe(200);
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "tool", "text", "navigate", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "context.resolve", ok: true });
    expect(ev[2]).toMatchObject({ type: "tool", name: "navigate", ok: true });
    expect(ev[4]).toEqual({ type: "navigate", path: `/dashboard/analytics?c=${C7B}`, label: "My Analytics" });
    expect(ev[5]).toMatchObject({ type: "done", label: "navigation", sources: ["context.resolve", "navigate"] });
    // The resolve found OUR 7B, by id — not a guess.
    expect(recorded("context.resolve").result.entities).toEqual([{ kind: "class", id: C7B, label: "7B", via: "context.resolve" }]);
    // No model was constructed on the navigate path.
    expect(mocks.constructed).toEqual([]);
    console.info(`[acceptance-s0] navigate wall time ${wallMs.toFixed(1)} ms; route latencyMs ${doneOf(ev).latencyMs}`);
    expect(wallMs).toBeLessThan(2000);
  });

  it("2. count: 'How many finished the quiz?' returns the tool's count and names, every number and name traceable", async () => {
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "assignments.status", args: {} }] },
      { text: ["3 of 5 finished the quiz. ", "Dina and Emir have not."] },
    ];
    const ev = await ask("How many finished the quiz?");

    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[0]).toMatchObject({ type: "meta", intent: "ask" });
    expect(ev[1]).toEqual({ type: "tool", name: "assignments.status", ok: true, summary: QUIZ_SUMMARY });
    // The tool's own facts: the seeded quiz, 3 done of 5, Dina and Emir not done.
    const fact = recorded("assignments.status").result.facts![0];
    expect(fact).toMatchObject({ classId: C7B, className: "7B", title: "Cells quiz", assigned: 5, done: 3, notDone: 2, overdue: 2, pendingToGrade: 1, completionPct: 60, notDoneNames: "Dina, Emir" });
    // SK's answer is the scripted one, untouched, and grounded.
    const text = textOf(ev);
    expect(text).toBe("3 of 5 finished the quiz. Dina and Emir have not.");
    expect(doneOf(ev)).toMatchObject({ label: "grounded", sources: ["assignments.status"] });
    assertTraceableToTools(text);
    expect(mocks.constructed).toEqual(["claude-sonnet-5-5"]);
  });

  it("3. fabrication is stripped: a name and a number the tool never returned do not survive", async () => {
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "assignments.status", args: {} }] },
      { text: ["3 of 5 finished. Dina, Emir and Farah have not, and 12 are overdue."] },
    ];
    const ev = await ask("How many finished the quiz?");

    const text = textOf(ev);
    // Farah and 12 exist nowhere in any tool result of this turn…
    expect(JSON.stringify(mocks.results)).not.toMatch(/Farah|\b12\b/);
    // …so they do not reach the user; the supported sentence does.
    expect(text).not.toContain("Farah");
    expect(text).not.toMatch(/\b12\b/);
    expect(text).toBe("3 of 5 finished.");
    // What remains is fully tool-backed → grounded; `trimmed` records the drop.
    expect(doneOf(ev)).toMatchObject({ label: "grounded", trimmed: true, sources: ["assignments.status"] });
    // The invariant holds on what was spoken: no token absent from the facts survives.
    assertTraceableToTools(text);
  });

  it("4. at-risk: 'who is at risk in 7B' names the at-risk learner by the school-health rule; 8A's Emir never appears", async () => {
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "context.resolve", args: { query: "7B", kind: "class" } }] },
      { toolCalls: [{ id: "c2", name: "learners.risk", args: { classId: C7B } }] },
      { text: ["In 7B, Emir is at risk — never started."] },
    ];
    const ev = await ask("who is at risk in 7B");

    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "tool", "text", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "context.resolve", ok: true });
    expect(ev[2]).toEqual({ type: "tool", name: "learners.risk", ok: true, summary: RISK_SUMMARY_7B });
    // The rule's verdict, as school-health words it, scoped to OUR class only.
    const risk = recorded("learners.risk").result;
    expect(risk.facts).toEqual([{ name: "Emir", className: "7B", grade: "Form 1", reasons: "never started" }]);
    expect(risk.entities).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "learners", ids: ["s5"] })])); // s5, never s9 (8A's Emir)
    for (const t of only(ev, "tool")) {
      expect(t.summary as string).not.toContain("8A");
      expect(t.summary as string).not.toMatch(/Gopal|Hana/);
    }
    expect((ev[2] as { summary: string }).summary).toContain("7B");
    const text = textOf(ev);
    expect(text).toBe("In 7B, Emir is at risk — never started.");
    expect(doneOf(ev)).toMatchObject({ label: "grounded", sources: ["context.resolve", "learners.risk"] });
    assertTraceableToTools(text);
  });

  it("5. empty: no shares → the tool returns no facts and SK says exactly SK_NOTHING_ON_THAT, whatever the model wrote", async () => {
    signIn(seededSession(seed({ generation_shares: [], student_progress: [], submissions: [] })));
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "assignments.status", args: {} }] },
      { text: ["3 of 5 finished the quiz. Dina and Emir have not."] },
    ];
    const ev = await ask("how many finished the quiz");

    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "text", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", name: "assignments.status", ok: true, summary: "Nothing has been assigned to those classes." });
    expect(recorded("assignments.status").result.facts).toEqual([]);
    expect(textOf(ev)).toBe(SK_NOTHING_ON_THAT);
    expect(doneOf(ev)).toMatchObject({ label: "declined", sources: [] });
    const spoken = only(ev, "text")
      .map((e) => e.text)
      .join(" ");
    expect(spoken).not.toMatch(/\b[35]\b|Dina|Emir/);
  });

  it("6. cross-tenant: when the session returns the whole school (filters ignored), the facts carry no 8A row and no 8A learner", async () => {
    // The "RLS shows the whole school" shape: `.in()` lists are ignored, so
    // enrollments / shares / progress / submissions come back for 8A too.
    const session = seededSession(seed(), { ignoreIn: true });
    signIn(session);
    mocks.script = [
      { toolCalls: [{ id: "c1", name: "assignments.status", args: {} }] },
      { text: ["3 of 5 finished the quiz. Dina and Emir have not."] },
    ];
    const ev = await ask("How many finished the quiz?");

    // The fake really did hand back 8A rows on the `.in()` queries.
    expect(session.log.some((l) => l.startsWith("generation_shares.in("))).toBe(true);
    const r = recorded("assignments.status").result;
    expect(r.facts!.map((f) => f.classId)).toEqual([C7B]);
    expect(r.facts!.map((f) => f.className)).not.toContain("8A");
    expect(r.facts!.map((f) => f.shareId)).not.toContain("sh-t2");
    for (const f of r.facts!) expect(String(f.notDoneNames)).not.toMatch(/Gopal|Hana/);
    // 8A's pending submission is not in this teacher's to-grade; 8A's learners are not in the count.
    expect(r.summary).toBe(QUIZ_SUMMARY);
    expect(r.facts![0]).toMatchObject({ assigned: 5, pendingToGrade: 1 });
    // Nothing of 8A's reaches the client either.
    expect(JSON.stringify(ev)).not.toMatch(/8A|Gopal|Hana|sh-t2|c8a/);
    expect(doneOf(ev)).toMatchObject({ label: "grounded", sources: ["assignments.status"] });
  });
});
