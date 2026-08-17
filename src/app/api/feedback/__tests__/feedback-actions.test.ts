/**
 * /api/feedback — questionnaire actions (submit / later): own-request-only,
 * answered = 409, and the legacy beta path stays untouched by the dispatch.
 *
 * Run: npx vitest run src/app/api/feedback/__tests__/feedback-actions.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  teacherBetaEnabled: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/flags", () => ({ teacherBetaEnabled: mocks.teacherBetaEnabled }));

import { POST } from "@/app/api/feedback/route";

type Row = Record<string, unknown>;

function fakeSession(user: { id: string } | null) {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => {
      throw new Error("questionnaire actions must not touch the user-scoped client's tables");
    },
  };
}

function fakeAdmin(cfg: { request?: Row | null }) {
  const inserts: { table: string; values: Row }[] = [];
  const updates: { table: string; values: Row }[] = [];
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        insert: (values: Row) => {
          inserts.push({ table, values });
          return b;
        },
        update: (values: Row) => {
          updates.push({ table, values });
          return b;
        },
        maybeSingle: async () => ({
          data: table === "feedback_requests" ? cfg.request ?? null : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return b;
    },
  };
  return { client, inserts, updates };
}

function req(body: unknown) {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const submitBody = {
  action: "submit",
  request_id: "r1",
  ease: 4,
  usefulness: 5,
  quality: 3,
  most_used: "worksheet",
  blocker: "Upload took a while",
  wish: "Malay narration voices",
  contact_ok: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacherBetaEnabled.mockReturnValue(true);
  mocks.createClient.mockResolvedValue(fakeSession({ id: "u1" }));
});

describe("POST /api/feedback — questionnaire actions", () => {
  it("401s when not signed in", async () => {
    mocks.createClient.mockResolvedValue(fakeSession(null));
    const { client } = fakeAdmin({});
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ action: "later", request_id: "r1" }))).status).toBe(401);
  });

  it("404s someone else's request — indistinguishable from nonexistent", async () => {
    const { client, inserts, updates } = fakeAdmin({
      request: { id: "r1", user_id: "OTHER", responded_at: null },
    });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req(submitBody))).status).toBe(404);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("409s an already-answered request", async () => {
    const { client, inserts } = fakeAdmin({
      request: { id: "r1", user_id: "u1", responded_at: new Date().toISOString() },
    });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req(submitBody))).status).toBe(409);
    expect(inserts).toHaveLength(0);
  });

  it("submit inserts the response and stamps responded_at", async () => {
    const { client, inserts, updates } = fakeAdmin({
      request: { id: "r1", user_id: "u1", responded_at: null },
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req(submitBody));
    expect(res.status).toBe(200);

    const ins = inserts.find((i) => i.table === "feedback_responses");
    expect(ins?.values).toMatchObject({
      request_id: "r1",
      user_id: "u1",
      ease: 4,
      usefulness: 5,
      quality: 3,
      most_used: "worksheet",
      blocker: "Upload took a while",
      wish: "Malay narration voices",
      contact_ok: true,
    });
    const stamp = updates.find((u) => u.table === "feedback_requests");
    expect(typeof stamp?.values.responded_at).toBe("string");
  });

  it("400s a bad most_used and writes nothing", async () => {
    const { client, inserts, updates } = fakeAdmin({
      request: { id: "r1", user_id: "u1", responded_at: null },
    });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ ...submitBody, most_used: "exam paper" }))).status).toBe(400);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("400s missing ratings", async () => {
    const { client } = fakeAdmin({ request: { id: "r1", user_id: "u1", responded_at: null } });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ ...submitBody, quality: undefined }))).status).toBe(400);
  });

  it("later snoozes for 3 days", async () => {
    const { client, updates } = fakeAdmin({
      request: { id: "r1", user_id: "u1", responded_at: null },
    });
    mocks.createAdminClient.mockReturnValue(client);

    const before = Date.now();
    const res = await POST(req({ action: "later", request_id: "r1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { snoozed_until?: string };

    const stamp = updates.find((u) => u.table === "feedback_requests");
    const until = new Date(stamp?.values.snoozed_until as string).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 3 * 86_400_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 3 * 86_400_000);
    expect(json.snoozed_until).toBe(stamp?.values.snoozed_until);
  });

  it("a body with NO action still takes the legacy beta path (flag off → 404)", async () => {
    mocks.teacherBetaEnabled.mockReturnValue(false);
    const { client } = fakeAdmin({});
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ overall: 5 }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Not enabled.");
  });
});
