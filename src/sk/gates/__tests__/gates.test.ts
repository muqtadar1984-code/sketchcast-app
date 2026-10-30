/**
 * SK S5 slice E — the §8.4 leader gates through the REAL turn route.
 *
 * Default (CI): a ~10-item subset of the bank, scripted model, no network.
 * Full run (not CI): SK_GATES_FULL=1 — every item of the bank, the
 * leaky-RLS isolation pass, and a JSON + markdown report under
 * reports/sk-gates/. Start it with `node scripts/sk-gates.ts` (which sets the
 * env and prints the live cost estimate), not by hand.
 *
 * SK_GATES_MODEL=live (only with SK_GATES_LIVE=1) swaps the scripted model for
 * the app's real AnthropicProvider; SK_GATES_JUDGE=live adds a second-model
 * grade. Both make PAID calls — scripts/sk-gates.ts refuses them without the
 * founder's SK_GATES_LIVE=1, explicit prices and --yes.
 *
 * SK_GATES_ROUTING=model (2026-10-30) runs the FULL bank under MODEL-FIRST
 * routing (every item reaches the model; a rules item's scripted stand-in
 * calls the capability the rules would have). The CI subset runs both.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/gates/__tests__/gates.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerateOpts, LLMProvider, StreamEvent } from "@/utils/assistant/provider";
import type { SkCapability, SkCapabilityResult } from "@/sk/shell/types";
import type { GateItem } from "@/sk/gates/types";
import type { GateToolResult } from "@/sk/gates/grade";

const LIVE = process.env.SK_GATES_MODEL === "live";
const JUDGE = process.env.SK_GATES_JUDGE === "live";
const FULL = process.env.SK_GATES_FULL === "1";
/** 2026-10-30: the Shell routing a FULL run measures (scripts/sk-gates.ts --routing). */
const ROUTING: "rules" | "model" = process.env.SK_GATES_ROUTING === "model" ? "model" : "rules";
if ((LIVE || JUDGE) && process.env.SK_GATES_LIVE !== "1") throw new Error("SK gates: a live model or judge needs SK_GATES_LIVE=1 (paid calls; the founder approves).");

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  hat: undefined as string | undefined,
  item: null as unknown,
  results: [] as Array<{ name: string; args: Record<string, unknown>; result: SkCapabilityResult }>,
  calls: [] as Array<{ inputChars: number; outputChars: number }>,
  usage: { inputTokens: 0, outputTokens: 0 },
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "sc_hat" && mocks.hat ? { value: mocks.hat } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { ScriptedGateProvider, promptChars } = await import("@/sk/gates/scripted-provider");
  if (process.env.SK_GATES_MODEL === "live" && process.env.SK_GATES_LIVE === "1") {
    // The app's REAL provider, wrapped only to count what it was sent and billed.
    const real = await vi.importActual<typeof import("@/utils/assistant/providers/anthropic")>("@/utils/assistant/providers/anthropic");
    return {
      ...real,
      AnthropicProvider: class extends real.AnthropicProvider {
        async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
          let out = 0;
          for await (const ev of super.stream(opts)) {
            if (ev.type === "text") out += ev.text.length;
            if (ev.type === "done") {
              mocks.usage.inputTokens += ev.usage.inputTokens;
              mocks.usage.outputTokens += ev.usage.outputTokens;
            }
            yield ev;
          }
          mocks.calls.push({ inputChars: promptChars(opts), outputChars: out });
        }
      },
    };
  }
  return {
    AnthropicProvider: class extends ScriptedGateProvider {
      constructor(model?: string) {
        super(model ?? "scripted", (mocks.item as { scripted?: never } | null)?.scripted, mocks.calls);
      }
    },
  };
});
// The REAL registry, every handler wrapped so the harness sees the full result
// (facts included) — the route's `tool` event carries only a 200-char summary.
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
import { GATE_BANK, CI_SUBSET } from "@/sk/gates/bank";
import { applyGateEnv, runGates, type GateHooks, type GateOutcome } from "@/sk/gates/harness";
import { buildReport, writeReport } from "@/sk/gates/report";
import { JUDGE_SYSTEM, judgePrompt, judgeVerdict, type JudgeResult } from "@/sk/gates/judge";

const hooks: GateHooks = {
  setSession: (s) => mocks.createClient.mockResolvedValue(s),
  setAdmin: (a) => mocks.createAdminClient.mockReturnValue(a),
  setHat: (h) => {
    mocks.hat = h;
  },
  begin: (item: GateItem) => {
    mocks.item = item;
    mocks.results = [];
    mocks.calls = [];
    mocks.usage = { inputTokens: 0, outputTokens: 0 };
  },
  collect: () => ({
    results: mocks.results as GateToolResult[],
    calls: mocks.calls,
    ...(LIVE ? { usage: { ...mocks.usage } } : {}),
  }),
};

let restore: () => void = () => {};
beforeAll(() => {
  restore = applyGateEnv();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterAll(() => restore());

async function judgeProvider(): Promise<LLMProvider> {
  const real = await vi.importActual<typeof import("@/utils/assistant/providers/anthropic")>("@/utils/assistant/providers/anthropic");
  return new real.AnthropicProvider(process.env.SK_GATES_JUDGE_MODEL || "claude-sonnet-5-5");
}

const itemOf = (id: string): GateItem => GATE_BANK.find((i) => i.id === id)!;

describe.skipIf(FULL)("§8.4 leader gates — CI subset (scripted model, no network)", () => {
  it(`runs ${CI_SUBSET.length} items: grounded, refused and isolated`, async () => {
    const outcomes = await runGates(CI_SUBSET, POST, hooks, { leaky: true });
    for (const { verdict, leakyLeaks } of outcomes) {
      expect(verdict.reasons, `${verdict.id}: ${verdict.text}`).toEqual([]);
      expect(verdict.pass, verdict.id).toBe(true);
      expect(leakyLeaks, `${verdict.id} (leaky RLS)`).toEqual([]);
    }
  }, 120_000);
});

describe.skipIf(FULL)("§8.4 leader gates — CI subset under MODEL-FIRST routing (scripted model, no network)", () => {
  it(`runs ${CI_SUBSET.length} items with every turn reaching the model: grounded, refused and isolated`, async () => {
    const outcomes = await runGates(CI_SUBSET, POST, hooks, { leaky: true, routing: "model" });
    for (const { verdict, leakyLeaks } of outcomes) {
      expect(verdict.reasons, `${verdict.id}: ${verdict.text}`).toEqual([]);
      expect(verdict.pass, verdict.id).toBe(true);
      expect(verdict.modelCalls, `${verdict.id} reached the model`).toBeGreaterThan(0);
      expect(leakyLeaks, `${verdict.id} (leaky RLS)`).toEqual([]);
    }
  }, 120_000);
});

describe.skipIf(!FULL)("§8.4 leader gates — FULL bank", () => {
  it(`runs all ${GATE_BANK.length} items and writes the report`, async () => {
    const judged = new Map<string, JudgeResult>();
    const judge = JUDGE ? await judgeProvider() : null;
    const outcomes: GateOutcome[] = await runGates(GATE_BANK, POST, hooks, {
      leaky: true,
      routing: ROUTING,
      onItem: async (o) => {
        if (judge) judged.set(o.verdict.id, await judgeVerdict(judge, itemOf(o.verdict.id), o.verdict, o.results));
      },
    });
    // What a --judge live run would send (the estimate prices it).
    const judgePromptChars = outcomes.reduce((n, o) => n + JUDGE_SYSTEM.length + judgePrompt(itemOf(o.verdict.id), o.verdict, o.results).length, 0);
    const report = buildReport(outcomes, { model: LIVE ? "live" : "scripted", judge: JUDGE ? "live" : "none", routing: ROUTING, judged, judgePromptChars });
    const paths = writeReport(report, process.env.SK_GATES_REPORT_DIR || "reports/sk-gates");
    console.log(`[sk-gates] ${ROUTING} routing: ${report.summary.pass ? "PASS" : "FAIL"} — report: ${paths.json} , ${paths.md}`);
    // The run itself never fails the process on a gate miss: the report is the verdict.
    expect(outcomes).toHaveLength(GATE_BANK.length);
  }, 1_800_000);
});
