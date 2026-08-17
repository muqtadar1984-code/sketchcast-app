/**
 * /api/autofix/dispatch — worker-scope refusal + app-category happy path.
 *
 * Live incident (run ee0fb99628f13098, issue 8b79d4e0): a generation_failed
 * (worker-pipeline) issue was dispatched to the app-repo autofix Action, which
 * can only ever change app code — it wrote a doomed PR (#24). Dispatch must
 * refuse worker-side categories with a 400 BEFORE any autofix_runs row exists.
 *
 * Run: npx vitest run src/app/api/autofix/__tests__/dispatch.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_SIDE_CATEGORIES, WORKER_SCOPE_REFUSAL, workerScopeRefusal } from "@/utils/autofix/scope";

const mocks = vi.hoisted(() => ({
  autofixEnabled: vi.fn(),
  isPlatformAdminRequest: vi.fn(),
  repositoryDispatch: vi.fn(),
  autofixRepoConfigured: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/utils/flags", () => ({ autofixEnabled: mocks.autofixEnabled }));
vi.mock("@/utils/platform-admin", () => ({ isPlatformAdminRequest: mocks.isPlatformAdminRequest }));
vi.mock("@/utils/autofix/github", () => ({
  repositoryDispatch: mocks.repositoryDispatch,
  autofixRepoConfigured: mocks.autofixRepoConfigured,
}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { POST } from "@/app/api/autofix/dispatch/route";

type Row = Record<string, unknown>;

/** Minimal thenable-chain Supabase stub: records every insert so tests can
 * assert no autofix_runs row was created on refusal. */
function fakeAdmin(issue: Row | null) {
  const inserts: { table: string; values: Row }[] = [];
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        in: () => b,
        limit: () => b,
        gte: () => b,
        update: () => b,
        insert: (values: Row) => {
          inserts.push({ table, values });
          return b;
        },
        maybeSingle: async () =>
          table === "platform_issues" ? { data: issue, error: null } : { data: null, error: null },
        single: async () => ({ data: { id: "run-1" }, error: null }),
        // Awaited directly for the daily-cap count and the update/audit writes.
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null, count: 0 }),
      });
      return b;
    },
  };
  return { client, inserts };
}

function makeIssue(category: string): Row {
  return { id: "i1", title: "Cambridge kit failed", description: "It broke", category, severity: "normal", diagnosis: null };
}

function req(body: unknown) {
  return new Request("http://localhost/api/autofix/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autofixEnabled.mockReturnValue(true);
  mocks.isPlatformAdminRequest.mockResolvedValue({ id: "staff-1", email: "staff@sketchcast.app" });
  mocks.repositoryDispatch.mockResolvedValue({ ok: true });
  mocks.autofixRepoConfigured.mockReturnValue(true);
});

describe("workerScopeRefusal", () => {
  it("refuses exactly the worker-pipeline categories", () => {
    // Full taxonomy from migration 0020_support_agent.sql.
    const all = [
      "video", "deck_docs", "quiz", "upload", "login", "speed", "other",
      "wrong_chapter", "poor_quality", "missing_parts", "generation_failed",
    ];
    for (const cat of all) {
      if (WORKER_SIDE_CATEGORIES.has(cat)) {
        expect(workerScopeRefusal(cat)).toBe(WORKER_SCOPE_REFUSAL);
      } else {
        expect(workerScopeRefusal(cat)).toBeNull();
      }
    }
    expect([...WORKER_SIDE_CATEGORIES].sort()).toEqual(
      ["generation_failed", "missing_parts", "poor_quality", "wrong_chapter"],
    );
  });

  it("passes null/undefined/unknown categories through (no refusal)", () => {
    expect(workerScopeRefusal(null)).toBeNull();
    expect(workerScopeRefusal(undefined)).toBeNull();
    expect(workerScopeRefusal("")).toBeNull();
    expect(workerScopeRefusal("something_new")).toBeNull();
  });
});

describe("POST /api/autofix/dispatch — worker-scope refusal", () => {
  it("400s a generation_failed issue with the refusal message and creates NO run", async () => {
    const { client, inserts } = fakeAdmin(makeIssue("generation_failed"));
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ issueId: "i1" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe(WORKER_SCOPE_REFUSAL);
    expect(json.error).toMatch(/worker/);

    // The whole point: no ledger row, no GitHub dispatch, nothing to orphan.
    expect(inserts).toHaveLength(0);
    expect(mocks.repositoryDispatch).not.toHaveBeenCalled();
  });

  it.each(["wrong_chapter", "poor_quality", "missing_parts"])(
    "also refuses the worker content category %s",
    async (category) => {
      const { client, inserts } = fakeAdmin(makeIssue(category));
      mocks.createAdminClient.mockReturnValue(client);

      const res = await POST(req({ issueId: "i1" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe(WORKER_SCOPE_REFUSAL);
      expect(inserts).toHaveLength(0);
      expect(mocks.repositoryDispatch).not.toHaveBeenCalled();
    },
  );

  it("still dispatches an app-category issue (login)", async () => {
    const { client, inserts } = fakeAdmin(makeIssue("login"));
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ issueId: "i1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; dispatched?: boolean };
    expect(json.ok).toBe(true);
    expect(json.dispatched).toBe(true);

    expect(inserts.some((i) => i.table === "autofix_runs")).toBe(true);
    expect(mocks.repositoryDispatch).toHaveBeenCalledTimes(1);
    // The dispatch payload carries the sanitized brief for the Action.
    const [eventType, payload] = mocks.repositoryDispatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventType).toBe("autofix");
    expect(payload.branch).toMatch(/^autofix\//);
  });
});
