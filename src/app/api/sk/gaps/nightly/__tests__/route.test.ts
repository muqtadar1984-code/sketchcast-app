// SK gap tracker — the nightly cron: CRON_SECRET auth before anything runs,
// grouping then the 90-day text purge (its exact query shape), and one step's
// failure never stops the other.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/gaps/nightly/__tests__/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/sk/gaps/__tests__/fake-db";

const mocks = vi.hoisted(() => ({ db: null as unknown, group: vi.fn(), admin: vi.fn() }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/sk/gaps/group", () => ({ groupNewGaps: mocks.group }));

import { GET, POST } from "@/app/api/sk/gaps/nightly/route";

const NOW = new Date("2026-10-31T20:00:00.000Z");
const call = (secret: string | null = "cron-secret", method: "GET" | "POST" = "GET") =>
  (method === "GET" ? GET : POST)(
    new Request("https://app.example/api/sk/gaps/nightly", { method, headers: secret === null ? {} : { authorization: `Bearer ${secret}` } }),
  );

const okGroup = { status: "ok", gaps: 3, grouped: 2, dismissed: 1, skipped: 0, newThemes: 1, reopened: 0, usage: { input_tokens: 1, output_tokens: 1, usd: 0.0012 }, ms: 5 };

let db: FakeDb;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = "cron-secret";
  db = new FakeDb({
    sk_gaps: [
      { id: "old", created_at: "2026-07-01T00:00:00.000Z", question: "q", reply: "r", wanted: "w", context: { a: 1 }, page: "/dashboard", text_purged_at: null },
      { id: "done", created_at: "2026-06-01T00:00:00.000Z", question: null, reply: null, wanted: null, context: null, text_purged_at: "2026-09-01T00:00:00.000Z" },
      { id: "recent", created_at: "2026-10-30T00:00:00.000Z", question: "q2", reply: "r2", wanted: null, context: null, text_purged_at: null },
    ],
  });
  mocks.admin.mockImplementation(() => db);
  mocks.group.mockResolvedValue(okGroup);
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("/api/sk/gaps/nightly", () => {
  it("401s without the cron secret and touches nothing", async () => {
    for (const secret of [null, "wrong", ""]) {
      const res = await call(secret);
      expect(res.status).toBe(401);
    }
    delete process.env.CRON_SECRET; // unset secret fails closed
    expect((await call("cron-secret")).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.group).not.toHaveBeenCalled();
  });

  it("groups, then clears text older than 90 days (GET and POST)", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; group: Record<string, unknown>; purge: { purged: number; cutoff: string } };
    expect(body.ok).toBe(true);
    expect(body.group).toMatchObject({ status: "ok", grouped: 2, newThemes: 1, usd: 0.0012 });
    expect(body.purge).toEqual({ purged: 1, cutoff: "2026-08-02T20:00:00.000Z" });
    expect(mocks.group).toHaveBeenCalledWith(db, { now: NOW });

    const purge = db.calls.find((c) => c.table === "sk_gaps" && c.op === "update")!;
    expect(purge.patch).toEqual({ question: null, reply: null, wanted: null, context: null, text_purged_at: NOW.toISOString() });
    expect(purge.options).toEqual({ count: "exact" });
    expect(purge.filters).toEqual([
      ["lt", "created_at", "2026-08-02T20:00:00.000Z"],
      ["is", "text_purged_at", null],
    ]);
    const old = db.tables.sk_gaps.find((g) => g.id === "old")!;
    expect(old).toMatchObject({ question: null, reply: null, wanted: null, context: null, page: "/dashboard", text_purged_at: NOW.toISOString() });
    expect(db.tables.sk_gaps.find((g) => g.id === "done")!.text_purged_at).toBe("2026-09-01T00:00:00.000Z");
    expect(db.tables.sk_gaps.find((g) => g.id === "recent")!.question).toBe("q2");

    expect((await call("cron-secret", "POST")).status).toBe(200);
  });

  it("still purges when grouping fails, and reports ok:false", async () => {
    mocks.group.mockResolvedValue({ ...okGroup, status: "failed", grouped: 0, error: "reply is not valid JSON" });
    const body = (await (await call()).json()) as { ok: boolean; group: { error: string }; purge: { purged: number } };
    expect(body.ok).toBe(false);
    expect(body.group.error).toBe("reply is not valid JSON");
    expect(body.purge.purged).toBe(1);
  });

  it("a failed purge only logs: the cron still answers 200", async () => {
    db.failOn = { table: "sk_gaps", op: "update", message: "timeout" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purge: { error: string } };
    expect(body.ok).toBe(false);
    expect(body.purge.error).toBe("sk_gaps purge failed: timeout");
    expect(err).toHaveBeenCalled();
  });
});
