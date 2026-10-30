/**
 * Unsupported-claims suite (Final Plan §8.4, §9.3) — the S0 gate.
 *
 * 30 distinct teacher questions. EVERY capability returns `facts: []` (the
 * registry is mocked with the real metas and empty handlers, plus two stand-in
 * knowledge tools so the model has something to call). The stub model answers
 * each one with invented numbers and names — half the time after calling a
 * tool, half the time straight away. The route must emit exactly
 * SK_NOTHING_ON_THAT with label `declined` in 30/30.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/unsupported-claims.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  script: [] as unknown[],
  toolCalls: 0,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "sc_hat" ? { value: "teacher" } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor() {
        super(mocks.script as StubTurn[]);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        yield* super.stream(opts);
      }
    },
  };
});
vi.mock("@/sk/capabilities", async () => {
  const real = await vi.importActual<typeof import("@/sk/capabilities")>("@/sk/capabilities");
  const empty = async () => {
    mocks.toolCalls++;
    return { ok: true, summary: "No rows.", facts: [] };
  };
  const standIn = (name: string, description: string) => ({
    meta: { name, description, parameters: { type: "object" as const, properties: { query: { type: "string" } } }, tier: "immediate" as const, kind: "read" as const, roles: ["teacher" as const] },
    handler: empty,
  });
  const REGISTRY = [
    ...real.REGISTRY.map((c) => ({ ...c, handler: empty })),
    standIn("assignments.status", "Completion of assigned work."),
    standIn("learners.risk", "Learners at risk."),
  ];
  return { ...real, REGISTRY };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { SK_NOTHING_ON_THAT } from "@/sk/shell/types";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, readEvents } from "./fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "claims-suite-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  mocks.createClient.mockResolvedValue(fakeSession({ profiles: [{ role: "teacher", school_id: SCHOOL_ID }], schools: [{ config: {} }], coordinator_scope: [], parent_links: [] }, { user: USER }));
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  mocks.toolCalls = 0;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

type Case = { q: string; tool: string | null; fabricated: string };
const CASES: Case[] = [
  { q: "How many learners in 7B finished the fractions worksheet?", tool: "assignments.status", fabricated: "18 of 24 learners in 7B finished it." },
  { q: "Who in 8A has not submitted anything this week?", tool: "learners.risk", fabricated: "Ahmad Zaki and Siti Nurhaliza have not submitted." },
  { q: "What is the completion rate for my Science class?", tool: "assignments.status", fabricated: "Completion is at 76%." },
  { q: "Which learners are at risk in 7B?", tool: "learners.risk", fabricated: "Three learners: Ali, Maya and Jun." },
  { q: "When is the photosynthesis worksheet due?", tool: "assignments.status", fabricated: "It is due on 2026-11-03." },
  { q: "How many kits have I unlocked this term?", tool: "context.resolve", fabricated: "You have unlocked 12 kits." },
  { q: "What did I assign to 9C yesterday?", tool: "assignments.status", fabricated: "You assigned Chapter 4 Worksheet to 9C." },
  { q: "Which class has the most overdue work?", tool: "assignments.status", fabricated: "8B has the most, with 9 overdue items." },
  { q: "How many students are enrolled in 5 Amanah?", tool: "context.resolve", fabricated: "5 Amanah has 31 students." },
  { q: "Who scored highest on the algebra quiz?", tool: "learners.risk", fabricated: "Farah Lim scored 98%." },
  { q: "What is the average score in 7B?", tool: "assignments.status", fabricated: "The average is 64.5%." },
  { q: "How many parents have read the last notice?", tool: "assignments.status", fabricated: "22 of 30 parents read it." },
  { q: "Which book is 8A working from?", tool: "context.resolve", fabricated: "8A is on Science Form 2." },
  { q: "How many chapters have I generated for Biology?", tool: "context.resolve", fabricated: "You have generated 7 chapters." },
  { q: "What did Ali score on the last quiz?", tool: "learners.risk", fabricated: "Ali scored 55 out of 60." },
  // Straight answers, no tool call — the model simply makes it up.
  { q: "How many classes do I teach?", tool: null, fabricated: "You teach 4 classes." },
  { q: "What is 7B's attendance this week?", tool: null, fabricated: "Attendance was 92% this week." },
  { q: "Is anyone in 8A failing?", tool: null, fabricated: "Yes, Kumar and Devi are failing." },
  { q: "How many worksheets are still unmarked?", tool: null, fabricated: "There are 14 unmarked worksheets." },
  { q: "When is my next period with 9C?", tool: null, fabricated: "Your next period with 9C is at 10:40." },
  { q: "How many credits do I have left?", tool: null, fabricated: "You have 19 credits left." },
  { q: "Who are my coordinators?", tool: null, fabricated: "Encik Razak and Puan Lee are your coordinators." },
  { q: "What is the pass rate for the mid-term?", tool: null, fabricated: "The pass rate is 81%." },
  { q: "How many kits are in the catalogue for Grade 7?", tool: null, fabricated: "There are 46 kits for Grade 7." },
  { q: "Which chapter did 7B struggle with most?", tool: null, fabricated: "Chapter 3 — Cells — with 11 revisits." },
  { q: "How many diary entries did I write this month?", tool: null, fabricated: "You wrote 8 diary entries." },
  // 2026-10-30: weekdays are no longer taken for names ("due Friday"), so the
  // invented name itself must be checked — not the sentence-initial one (known gap).
  { q: "Who has a birthday in 7B this week?", tool: null, fabricated: "On Thursday it is Nurul's birthday." },
  { q: "How long is the Science Form 1 book?", tool: null, fabricated: "It has 212 pages." },
  { q: "What is the school's completion target?", tool: null, fabricated: "The target is 85%." },
  { q: "How many learners did Siti tutor last week?", tool: null, fabricated: "Siti tutored 6 learners." },
];

const req = (text: string) =>
  new Request("http://x/api/sk/shell/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId: `claims-${CASES.findIndex((c) => c.q === text)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" } }),
  });

describe("30 unsupported claims → 30 declines", () => {
  it("has 30 distinct questions", () => {
    expect(CASES).toHaveLength(30);
    expect(new Set(CASES.map((c) => c.q)).size).toBe(30);
  });
  it.each(CASES.map((c) => [c.q, c] as const))("%s", async (_q, c) => {
    mocks.script = c.tool
      ? [{ toolCalls: [{ id: "x", name: c.tool, args: { query: "7B" } }] }, { text: [c.fabricated] }]
      : [{ text: c.fabricated.split(" ").map((w, i, a) => (i < a.length - 1 ? `${w} ` : w)) }];
    const ev = await readEvents(await POST(req(c.q)));
    const texts = ev.filter((e) => e.type === "text").map((e) => e.text as string);
    const done = ev.find((e) => e.type === "done") as { label: string; sources: string[] };
    expect(texts).toEqual([SK_NOTHING_ON_THAT]);
    expect(done.label).toBe("declined");
    expect(done.sources).toEqual([]);
    if (c.tool) expect(mocks.toolCalls).toBe(1);
  });
  it("tally: every case declined (30/30)", async () => {
    let declined = 0;
    for (const c of CASES) {
      mocks.script = c.tool ? [{ toolCalls: [{ id: "x", name: c.tool, args: {} }] }, { text: [c.fabricated] }] : [{ text: [c.fabricated] }];
      const ev = await readEvents(await POST(req(c.q)));
      const done = ev.find((e) => e.type === "done") as { label: string } | undefined;
      const text = (ev.find((e) => e.type === "text") as { text: string } | undefined)?.text;
      if (done?.label === "declined" && text === SK_NOTHING_ON_THAT) declined++;
    }
    expect(declined).toBe(30);
  });
});
