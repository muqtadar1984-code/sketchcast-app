// SK S7 K1 — the daily cron runs the guarded release poll (finals only) after
// the cron secret, never on a dry run; a failure only logs and the cron still
// answers 200.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/lifecycle/reminders/__tests__/sk-knowledge-poll.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn(), poll: vi.fn() }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/utils/lifecycle/send", () => ({ sendLifecycleEmail: mocks.send, lifecycleAppUrl: () => "https://app.example" }));
vi.mock("@/sk/knowledge/release", () => ({ pollReleases: mocks.poll }));

import { GET } from "@/app/api/lifecycle/reminders/route";

const call = (q = "", secret = "cron-secret") => GET(new Request(`https://app.example/api/lifecycle/reminders${q}`, { headers: { authorization: `Bearer ${secret}` } }));

beforeEach(() => {
  process.env.CRON_SECRET = "cron-secret";
  delete process.env.LIFECYCLE_EMAILS_SINCE;
  mocks.rpc.mockImplementation(async (fn: string) => (fn === "sk_memory_sweep" ? { data: {}, error: null } : { data: [], error: null }));
  mocks.from.mockReturnValue({ select: async () => ({ data: [], error: null }), insert: async () => ({ error: null }) });
  mocks.poll.mockResolvedValue({ status: "waiting_for_book_app" });
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("/api/lifecycle/reminders runs the SK knowledge release poll", () => {
  it("polls with the service-role client and reports the result", async () => {
    mocks.poll.mockResolvedValue({ status: "ok", live: 1, imported: [12], unchanged: [], skipped: [], unavailable: [], errors: [] });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.poll).toHaveBeenCalledTimes(1);
    expect(((await res.json()) as { skKnowledge: unknown }).skKnowledge).toMatchObject({ status: "ok", imported: [12] });
  });
  it("waits quietly while pub_releases is missing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(((await res.json()) as { skKnowledge: unknown }).skKnowledge).toEqual({ status: "waiting_for_book_app" });
    expect(err).not.toHaveBeenCalledWith(expect.stringContaining("[sk knowledge]"), expect.anything());
  });
  it("a failed poll only logs: the cron still answers 200", async () => {
    mocks.poll.mockRejectedValue(new Error("pub_releases read failed: timeout"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skKnowledge: unknown }).skKnowledge).toBeNull();
    expect(err).toHaveBeenCalledWith("[sk knowledge] release poll failed:", "pub_releases read failed: timeout");
  });
  it("does not run on a dry run, nor without the cron secret", async () => {
    process.env.LIFECYCLE_EMAILS_SINCE = "2026-10-01T00:00:00Z";
    await call("?dry=1");
    expect(mocks.poll).not.toHaveBeenCalled();
    const res = await call("", "wrong");
    expect(res.status).toBe(401);
    expect(mocks.poll).not.toHaveBeenCalled();
  });
});
