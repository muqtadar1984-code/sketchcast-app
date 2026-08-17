/**
 * /api/console/feedback-request — staff gate + one-open-request rule.
 *
 * Run: npx vitest run src/app/api/console/__tests__/feedback-request.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPlatformAdminRequest: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/utils/platform-admin", () => ({ isPlatformAdminRequest: mocks.isPlatformAdminRequest }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { POST } from "@/app/api/console/feedback-request/route";

type Row = Record<string, unknown>;

/** Minimal thenable-chain Supabase stub (same shape as the autofix dispatch
 * tests): records every insert so refusals can assert nothing was written. */
function fakeAdmin(cfg: { profile?: Row | null; requests?: Row[] }) {
  const inserts: { table: string; values: Row }[] = [];
  const deletes: string[] = [];
  const updates: { table: string; values: Row }[] = [];
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        is: () => b,
        delete: () => {
          deletes.push(table);
          return b;
        },
        insert: (values: Row) => {
          inserts.push({ table, values });
          return b;
        },
        update: (values: Row) => {
          updates.push({ table, values });
          return b;
        },
        maybeSingle: async () => ({
          data: table === "profiles" ? cfg.profile ?? null : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => void) =>
          resolve({
            data: table === "feedback_requests" ? cfg.requests ?? [] : null,
            error: null,
          }),
      });
      return b;
    },
  };
  return { client, inserts, deletes, updates };
}

function req(body: unknown) {
  return new Request("http://localhost/api/console/feedback-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const DAY_MS = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPlatformAdminRequest.mockResolvedValue({ id: "staff-1", email: "staff@sketchcast.app" });
});

describe("POST /api/console/feedback-request", () => {
  it("404s non-staff (console isn't probeable) and touches nothing", async () => {
    mocks.isPlatformAdminRequest.mockResolvedValue(null);
    const { client, inserts } = fakeAdmin({});
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  it("400s a missing user_id", async () => {
    const { client } = fakeAdmin({});
    mocks.createAdminClient.mockReturnValue(client);
    expect((await POST(req({}))).status).toBe(400);
  });

  it("404s an unknown user", async () => {
    const { client, inserts } = fakeAdmin({ profile: null });
    mocks.createAdminClient.mockReturnValue(client);
    expect((await POST(req({ user_id: "ghost" }))).status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  it("400s a demo account — only real users get feedback asks", async () => {
    const { client, inserts } = fakeAdmin({ profile: { id: "u1", is_demo: true } });
    mocks.createAdminClient.mockReturnValue(client);
    expect((await POST(req({ user_id: "u1" }))).status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("409s while an open (unanswered, unsnoozed) request exists — no second row", async () => {
    const { client, inserts } = fakeAdmin({
      profile: { id: "u1", is_demo: false },
      requests: [{ id: "r1", snoozed_until: null, responded_at: null }],
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(409);
    expect(inserts).toHaveLength(0);
  });

  it("409s while a request is actively snoozed — 'maybe later' is still open", async () => {
    const { client, inserts } = fakeAdmin({
      profile: { id: "u1", is_demo: false },
      requests: [{ id: "r1", snoozed_until: iso(2), responded_at: null }],
    });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(409);
    expect(inserts).toHaveLength(0);
  });

  it("re-asks after a lapsed snooze by RE-OPENING the same row — an in-flight popup keeps its id", async () => {
    const { client, inserts, deletes, updates } = fakeAdmin({
      profile: { id: "u1", is_demo: false },
      requests: [{ id: "r1", snoozed_until: iso(-1), responded_at: null }],
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(200);
    // The stale row is UPDATED (requested_by refreshed, snooze cleared), never
    // deleted — a user with the lapsed popup still open holds a valid id, and
    // no second row exists for the dashboard and console to disagree over.
    const upd = updates.find((u) => u.table === "feedback_requests");
    expect(upd?.values).toMatchObject({ requested_by: "staff-1", snoozed_until: null });
    expect(inserts.find((i) => i.table === "feedback_requests")).toBeUndefined();
    expect(deletes).toHaveLength(0);
  });

  it("refuses student targets — the dashboard never shows them the questionnaire", async () => {
    const { client, inserts } = fakeAdmin({
      profile: { id: "u1", is_demo: false, role: "student" },
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("never deletes anything on a 409 refusal", async () => {
    const { client, deletes } = fakeAdmin({
      profile: { id: "u1", is_demo: false },
      requests: [{ id: "r1", snoozed_until: null, responded_at: null }],
    });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(409);
    expect(deletes).toHaveLength(0);
  });

  it("creates a fresh request after an answer (history kept), and audits it", async () => {
    const { client, inserts } = fakeAdmin({
      profile: { id: "u1", is_demo: false },
      // The route only selects responded_at-null rows; an answered request
      // therefore never comes back from the query at all.
      requests: [],
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    expect(inserts.some((i) => i.table === "feedback_requests")).toBe(true);
    expect(inserts.some((i) => i.table === "platform_audit_log")).toBe(true);
  });
});
