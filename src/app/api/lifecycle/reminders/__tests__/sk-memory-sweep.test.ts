// SK S6 slice A — the daily cron runs the SK memory retention sweep
// (migration 0173 sk_memory_sweep) with the service-role client: after the
// cron secret, before (and independent of) the email section, never on a dry
// run, and a failure only logs. It sends nothing itself.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/lifecycle/reminders/__tests__/sk-memory-sweep.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn() }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/utils/lifecycle/send", () => ({ sendLifecycleEmail: mocks.send, lifecycleAppUrl: () => "https://app.example" }));

import { GET } from "@/app/api/lifecycle/reminders/route";

const call = (q = "", secret = "cron-secret") => GET(new Request(`https://app.example/api/lifecycle/reminders${q}`, { headers: { authorization: `Bearer ${secret}` } }));

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  delete process.env.LIFECYCLE_EMAILS_SINCE;
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === "sk_memory_sweep" ? { data: { workflow_facts: 1, learning_facts: 2, history_cleared: 0, sk_actions: 3 }, error: null } : { data: [], error: null },
  );
  mocks.from.mockReturnValue({ select: async () => ({ data: [], error: null }), insert: async () => ({ error: null }) });
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.LIFECYCLE_EMAILS_SINCE;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("/api/lifecycle/reminders runs the SK memory sweep", () => {
  it("calls sk_memory_sweep and reports its counts, even when the emails are switched off", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("sk_memory_sweep");
    const body = (await res.json()) as { skipped?: string; skMemory: unknown };
    expect(body.skipped).toMatch(/LIFECYCLE_EMAILS_SINCE not set/);
    expect(body.skMemory).toEqual({ workflow_facts: 1, learning_facts: 2, history_cleared: 0, sk_actions: 3 });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("runs with the emails on too, and the counts ride on the normal reply", async () => {
    process.env.LIFECYCLE_EMAILS_SINCE = "2026-10-01T00:00:00Z";
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("sk_memory_sweep");
    expect(((await res.json()) as { skMemory: unknown }).skMemory).toMatchObject({ sk_actions: 3 });
  });
  it("a failed sweep only logs: the cron still answers 200", async () => {
    mocks.rpc.mockImplementation(async (fn: string) => (fn === "sk_memory_sweep" ? { data: null, error: { message: "function sk_memory_sweep() does not exist" } } : { data: [], error: null }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skMemory: unknown }).skMemory).toBeNull();
    expect(err).toHaveBeenCalledWith("[sk memory] sweep failed:", "function sk_memory_sweep() does not exist");
  });
  it("does not run on a dry run, nor without the cron secret", async () => {
    process.env.LIFECYCLE_EMAILS_SINCE = "2026-10-01T00:00:00Z";
    await call("?dry=1");
    expect(mocks.rpc).not.toHaveBeenCalledWith("sk_memory_sweep");
    const res = await call("", "wrong");
    expect(res.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalledWith("sk_memory_sweep");
  });
});
