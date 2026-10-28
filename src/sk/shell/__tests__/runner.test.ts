/**
 * SK Shell runner (§2.5 revalidation, §8.3 caps, audit row). The row mirrors
 * migration 0162's sk_actions columns exactly.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/runner.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkActionRow, SkCapability } from "../types";
import { MemoryAuditSink, DbAuditSink, auditSinkFor, type SkAuditSink } from "../audit";
import { SK_FACTS_MAX_ROWS, SK_SUMMARY_MAX_CHARS, makeRunTool, runCapability, toolResultText } from "../runner";
import { NOW, SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeSession, makeCtx } from "./fixtures";

/** The 0162 column list (PR #156), in order. */
const COLUMNS_0162 = ["actor_id", "school_id", "role", "hat", "action", "tier", "kind", "params", "ok", "result", "error", "session_id", "generation_id", "token_id", "turn_id", "at", "ms"];

const wide: SkCapability = {
  meta: { name: "test.wide", description: "d", parameters: { type: "object", properties: {} }, tier: "immediate", kind: "read", roles: ["teacher"] },
  handler: async () => ({
    ok: true,
    summary: "s".repeat(5000),
    facts: Array.from({ length: 100 }, (_, i) => ({ i, long: "x".repeat(1000) })),
    entities: Array.from({ length: 30 }, (_, i) => ({ kind: "class" as const, id: `c${i}`, label: `C${i}`, via: "test.wide" })),
  }),
};
const boom: SkCapability = {
  meta: { name: "test.boom", description: "d", parameters: { type: "object", properties: {} }, tier: "confirm", kind: "act", roles: ["teacher"] },
  handler: async () => {
    throw new Error("kaboom");
  },
};
const deps = (sink: SkAuditSink, entries: SkCapability[]) => ({
  session: fakeSession({}),
  now: NOW,
  sink,
  sessionId: "sess-1",
  turnId: "turn-1",
  entries,
});

describe("runCapability", () => {
  it("writes one audit row per run whose keys are exactly the 0162 columns", async () => {
    const sink = new MemoryAuditSink();
    const ctx = makeCtx({ selection: { generationId: "gen-1" } });
    const r = await runCapability(ctx, "navigate", { target: "analytics" }, deps(sink, [...(await import("@/sk/capabilities")).REGISTRY]));
    expect(r.ok).toBe(true);
    expect(sink.rows).toHaveLength(1);
    const row = sink.rows[0];
    expect(Object.keys(row).sort()).toEqual([...COLUMNS_0162].filter((c) => c !== "error").sort());
    expect(row).toMatchObject({
      actor_id: TEACHER_ID,
      school_id: SCHOOL_ID,
      role: "teacher",
      hat: "teacher",
      action: "navigate",
      tier: "immediate",
      kind: "nav",
      params: { target: "analytics" },
      ok: true,
      session_id: "sess-1",
      generation_id: "gen-1",
      token_id: null,
      turn_id: "turn-1",
    });
    expect((row.result as Record<string, unknown>).navigate).toBe("/dashboard/analytics");
    expect(typeof row.ms).toBe("number");
    expect(Date.parse(row.at)).not.toBeNaN();
  });
  it("re-checks the registry predicate at execution time (a student may not resolve)", async () => {
    const sink = new MemoryAuditSink();
    const { REGISTRY } = await import("@/sk/capabilities");
    const r = await runCapability(makeCtx({ role: "student" }), "context.resolve", { query: "7B" }, deps(sink, REGISTRY));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_allowed");
    expect(sink.rows[0]).toMatchObject({ action: "context.resolve", ok: false, error: "not_allowed", kind: "read" });
  });
  it("unknown capability → ok:false, audited", async () => {
    const sink = new MemoryAuditSink();
    const r = await runCapability(makeCtx(), "nope", {}, deps(sink, []));
    expect(r.error).toBe("unknown_capability");
    expect(sink.rows[0].action).toBe("nope");
  });
  it("caps facts (≤40 rows, values ≤300 chars), summary (≤1500) and entities (≤20)", async () => {
    const sink = new MemoryAuditSink();
    const r = await runCapability(makeCtx(), "test.wide", {}, deps(sink, [wide]));
    expect(r.facts).toHaveLength(SK_FACTS_MAX_ROWS);
    expect((r.facts![0].long as string).length).toBe(300);
    expect(r.summary.length).toBe(SK_SUMMARY_MAX_CHARS);
    expect(r.entities).toHaveLength(20);
    expect(sink.rows[0].result).toMatchObject({ facts: 40, entities: 20 });
  });
  it("a throwing handler becomes ok:false with the error, tier/kind from meta", async () => {
    const sink = new MemoryAuditSink();
    const r = await runCapability(makeCtx(), "test.boom", { a: 1 }, deps(sink, [boom]));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("kaboom");
    expect(sink.rows[0]).toMatchObject({ tier: "confirm", kind: "act", ok: false, error: "kaboom" });
  });
  it("a failing sink never fails the turn", async () => {
    const bad: SkAuditSink = {
      record() {
        throw new Error("sink down");
      },
    };
    const rejecting: SkAuditSink = { record: () => Promise.reject(new Error("db down")) };
    const { REGISTRY } = await import("@/sk/capabilities");
    await expect(runCapability(makeCtx(), "navigate", { target: "board" }, deps(bad, REGISTRY))).resolves.toMatchObject({ ok: true });
    await expect(runCapability(makeCtx(), "navigate", { target: "board" }, deps(rejecting, REGISTRY))).resolves.toMatchObject({ ok: true });
  });
  it("an aborted signal short-circuits before the handler runs", async () => {
    const sink = new MemoryAuditSink();
    const ac = new AbortController();
    ac.abort();
    const r = await runCapability(makeCtx(), "test.boom", {}, { ...deps(sink, [boom]), signal: ac.signal });
    expect(r.error).toBe("aborted");
  });
});

describe("makeRunTool / toolResultText", () => {
  it("adapts an orchestrator ToolCall, traces it, and wraps the result as data", async () => {
    const sink = new MemoryAuditSink();
    const { REGISTRY } = await import("@/sk/capabilities");
    const trace: Parameters<typeof makeRunTool>[2] = [];
    const run = makeRunTool(makeCtx(), deps(sink, REGISTRY), trace);
    const out = await run({ id: "t1", name: "navigate", args: { target: "library" } });
    expect(out.startsWith('<tool_result data_only="true">')).toBe(true);
    expect(JSON.parse(out.replace(/^<tool_result data_only="true">|<\/tool_result>$/g, ""))).toMatchObject({ ok: true, navigate: { path: "/dashboard" } });
    expect(trace).toHaveLength(1);
    expect(trace[0].name).toBe("navigate");
    expect(toolResultText({ ok: false, summary: "x", error: "e" })).toContain('"error":"e"');
  });
});

describe("audit sinks", () => {
  it("MemoryAuditSink is the default; DbAuditSink only with SK_AUDIT=db and an admin", async () => {
    const admin = fakeAdmin();
    const prev = process.env.SK_AUDIT;
    delete process.env.SK_AUDIT;
    expect(auditSinkFor(admin)).toBeInstanceOf(MemoryAuditSink);
    process.env.SK_AUDIT = "db";
    expect(auditSinkFor(admin)).toBeInstanceOf(DbAuditSink);
    expect(auditSinkFor(null)).toBeInstanceOf(MemoryAuditSink);
    if (prev === undefined) delete process.env.SK_AUDIT;
    else process.env.SK_AUDIT = prev;
  });
  it("DbAuditSink inserts into sk_actions and swallows failures", async () => {
    const admin = fakeAdmin();
    const row: SkActionRow = { actor_id: TEACHER_ID, school_id: null, role: "teacher", hat: null, action: "navigate", tier: "immediate", kind: "nav", params: {}, ok: true, session_id: null, generation_id: null, turn_id: null, at: NOW.toISOString(), ms: 1 };
    await new DbAuditSink(admin).record(row);
    expect(admin.inserts).toEqual([{ table: "sk_actions", row }]);
    const broken = new DbAuditSink({
      from: () => ({
        insert: () => {
          throw new Error("no table");
        },
      }),
    });
    await expect(broken.record(row)).resolves.toBeUndefined();
  });
});
