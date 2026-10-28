/**
 * SK Shell speed (founder, 2026-10-28: "the response needs to be faster").
 * Through POST /api/sk/shell/turn with a stub provider that asks for TWO tools
 * in ONE round, each a fake that takes 300 ms: the two must overlap and the
 * turn must beat the same turn with its tools back to back (alone: ~320-335 ms
 * vs ~630 ms on the sequential loop; bounds are relative so load cannot flake it). Before fix/sk-speed the
 * orchestrator ran the calls one after the other (live: assignments.status
 * 4005 ms, then learners.risk 3926 ms → ~8 s of tools before a word).
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/perf.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";
import type { SkCapability } from "@/sk/shell/types";

const TOOL_MS = 300;

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  script: [] as unknown[],
  /** [name, startedAt, endedAt] for every slow fake tool run. */
  runs: [] as Array<{ name: string; start: number; end: number }>,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
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
// The real registry, with the two teacher knowledge tools replaced by fakes
// that take TOOL_MS each and answer with one fact (so the turn is grounded).
vi.mock("@/sk/capabilities", async () => {
  const real = await vi.importActual<typeof import("@/sk/capabilities")>("@/sk/capabilities");
  const slow = (name: string, summary: string, fact: Record<string, string | number>): SkCapability["handler"] =>
    async () => {
      const start = performance.now();
      await new Promise((r) => setTimeout(r, TOOL_MS));
      mocks.runs.push({ name, start, end: performance.now() });
      return { ok: true, summary, facts: [fact], entities: [] };
    };
  const REGISTRY = real.REGISTRY.map((c): SkCapability => {
    if (c.meta.name === "assignments.status") return { ...c, handler: slow(c.meta.name, "Cells quiz (7B): 3 of 5 done.", { title: "Cells quiz", done: 3, assigned: 5 }) };
    if (c.meta.name === "learners.risk") return { ...c, handler: slow(c.meta.name, "1 at risk in 7B: Emir — never started.", { name: "Emir", reasons: "never started" }) };
    return c;
  });
  return { ...real, REGISTRY };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { fakeAdmin, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "SK_SHELL_MODEL", "SK_AUDIT"];
const saved: Record<string, string | undefined> = {};

const req = (text: string) =>
  new Request("http://x/api/sk/shell/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/dashboard", locale: "en" } }),
  });

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "perf-secret-of-adequate-length-0123456789";
  process.env.FEATURE_ROLE_HATS = "true";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.runs = [];
  mocks.createAdminClient.mockReturnValue(fakeAdmin("school"));
  mocks.createClient.mockResolvedValue(fakeSession({ profiles: [{ role: "teacher", school_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] }));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

describe("turn speed: two tools in one round run side by side", () => {
  it(`"how are my classes" with assignments.status + learners.risk (${TOOL_MS} ms each): the tools overlap and the round costs one tool, not two`, async () => {
    // One warm-up turn with no tools first: the first request of a fresh
    // process pays module JIT and lazy initialisation that have nothing to do
    // with the tool loop being measured.
    mocks.script = [{ text: ["Hello."] }];
    const w0 = performance.now();
    await readEvents(await POST(req("hello")));
    const warmMs = performance.now() - w0;
    // The same no-tool turn again, warm: everything a turn costs that is not the tools.
    const b0 = performance.now();
    await readEvents(await POST(req("hello")));
    const baseMs = performance.now() - b0;
    mocks.script = [
      {
        toolCalls: [
          { id: "c1", name: "assignments__status", args: {} },
          { id: "c2", name: "learners__risk", args: {} },
        ],
      },
      { text: ["3 of 5 done; Emir is at risk — never started."] },
    ];
    const t0 = performance.now();
    const res = await POST(req("how are my classes"));
    const ev = await readEvents(res);
    const wallMs = performance.now() - t0;

    expect(res.status).toBe(200);
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "tool", "text", "done"]);
    expect(ev.filter((e) => e.type === "tool").map((e) => e.name).sort()).toEqual(["assignments.status", "learners.risk"]);
    expect(ev[3]).toEqual({ type: "text", text: "3 of 5 done; Emir is at risk — never started." });
    expect(ev[4]).toMatchObject({ type: "done", label: "grounded" });
    expect(mocks.runs).toHaveLength(2);
    // Both fakes were in flight at the same time: the second started before the first ended.
    const [a, b] = [...mocks.runs].sort((x, y) => x.start - y.start);
    const overlap = b.start < a.end;
    const toolSpan = Math.max(a.end, b.end) - a.start;
    const sequentialMs = baseMs + (a.end - a.start) + (b.end - b.start);
    console.info(
      `[perf] warm-up ${warmMs.toFixed(1)} ms; no-tool turn ${baseMs.toFixed(1)} ms; two-tool turn wall ${wallMs.toFixed(1)} ms (sequential would be ≈ ${sequentialMs.toFixed(0)} ms); tool round ${toolSpan.toFixed(0)} ms: ${a.name} ${(a.end - a.start).toFixed(0)} ms + ${b.name} ${(b.end - b.start).toFixed(0)} ms; overlap=${overlap}`,
    );
    expect(overlap).toBe(true);
    // Every bound is RELATIVE to what the tools actually took: under a loaded
    // runner (the whole suite in parallel) a 300 ms timer has been seen to take
    // 880 ms, so a fixed wall-clock number would flake. Alone this measures a
    // ~310 ms tool round and a ~320-335 ms turn (≈ 630 ms before fix/sk-speed).
    // The tool round costs about the slower tool, not the sum: at least half of
    // the shorter tool ran under the other (back to back, the span is the sum).
    const [da, db] = [a.end - a.start, b.end - b.start];
    expect(toolSpan).toBeLessThan(da + db - Math.min(da, db) / 2);
    // And the whole turn beats the same turn with its tools back to back.
    expect(wallMs).toBeLessThan(sequentialMs);
  });
});
