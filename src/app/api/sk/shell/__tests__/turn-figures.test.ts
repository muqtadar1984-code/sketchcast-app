/**
 * SK S5 slice C — the leader FIGURES through the real /api/sk/shell/turn
 * route: a principal's "school trend" and "how many teachers and students do
 * we have" are answered by school.trend / school.seats themselves, grounded,
 * no model; a coordinator's seats question never reaches school.seats (not
 * routed, not offered to the model). The fake session ignores filters and
 * hands over BOTH schools' rows, so the trend's boundary is the app-side cut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn(), constructed: [] as string[], hat: undefined as string | undefined }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "sc_hat" && mocks.hat ? { value: mocks.hat } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super([{ text: ["The model must not answer a leader's rules-routed question."] }] as StubTurn[]);
        mocks.constructed.push(model);
      }
    },
  };
});

import { POST as turnPOST } from "@/app/api/sk/shell/turn/route";
import { fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";
import { allRows, COORD, GRADE6, PA, SCH_A, SCHOOL_B } from "@/sk/capabilities/__tests__/leader-fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "SK_AUDIT", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_PARENT_PORTAL"];
const saved: Record<string, string | undefined> = {};
const EMAIL = "leader@school.example";

const session = (who: { id: string; role: string; scope?: Array<{ grade: string; subject: string | null }> }) => {
  const rows = allRows();
  return fakeSession(
    {
      ...rows,
      // The fake ignores filters: the profile read and the teacher-name read share this table.
      profiles: [{ id: who.id, role: who.role, school_id: SCH_A, full_name: "Leader" }],
      coordinator_scope: (who.scope ?? []).map((s) => ({ coordinator_id: who.id, school_id: SCH_A, ...s })),
      parent_links: [],
    } as never,
    { user: { id: who.id, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" } },
  );
};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,school_admin";
  process.env.SK_ALLOWED_EMAILS = EMAIL;
  process.env.SK_SHELL_SECRET = "leader-turn-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.FEATURE_DIARY = "true";
  mocks.constructed = [];
  mocks.hat = undefined;
  mocks.createAdminClient.mockImplementation(() => {
    throw new Error("no service key in tests");
  });
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let n = 0;
const turn = (text: string) =>
  new Request("http://x/api/sk/shell/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId: `5c1c2d3e-4b5a-4c7d-8e9f-${String(++n).padStart(12, "0")}`, text, modality: "text", collector: { path: "/dashboard/school", locale: "en" } }),
  });

describe("leader turn — the figures", () => {
  it('principal: "school trend" → school.trend, approximate, school A only, grounded, no model', async () => {
    mocks.createClient.mockResolvedValue(session({ id: PA, role: "school_admin" }));
    const ev = await readEvents(await turnPOST(turn("school trend")));
    const text = ev.find((e) => e.type === "text")?.text as string;
    expect(text).toMatch(/^Trend for the school, last 4 weeks — approximate \(from submission and due dates\): /);
    expect(text).toContain("this week (so far): due 13, submitted 6, on time 0%, awaiting marking 6");
    expect(ev.find((e) => e.type === "tool")).toMatchObject({ name: "school.trend", ok: true });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ sources: ["school.trend"], label: "grounded" });
    for (const t of SCHOOL_B) expect(JSON.stringify(ev)).not.toContain(t);
    expect(mocks.constructed).toEqual([]);
  });

  it('coordinator hat: "trend for grade 5" → their scope only (no grade-6 learner counted)', async () => {
    mocks.hat = "coordinator";
    mocks.createClient.mockResolvedValue(session({ id: COORD, role: "teacher", scope: [{ grade: "5", subject: null }] }));
    const ev = await readEvents(await turnPOST(turn("trend for grade 5")));
    const text = ev.find((e) => e.type === "text")?.text as string;
    expect(text).toContain("this week (so far): due 7, submitted 3, on time 0%, awaiting marking 3");
    const all = JSON.stringify(ev);
    for (const t of [...GRADE6, ...SCHOOL_B]) expect(all).not.toContain(t);
    expect(mocks.constructed).toEqual([]);
  });

  it('principal: "how many teachers and students do we have" → school.seats, no seat limit claimed, no model', async () => {
    mocks.createClient.mockResolvedValue(session({ id: PA, role: "school_admin" }));
    const ev = await readEvents(await turnPOST(turn("how many teachers and students do we have")));
    const text = ev.find((e) => e.type === "text")?.text as string;
    expect(text).toMatch(/^Your school: teachers \d+, students \d+, school admins \d+\./);
    expect(text).toContain("No seat limit is recorded for your school yet.");
    expect(ev.find((e) => e.type === "done")).toMatchObject({ sources: ["school.seats"], label: "grounded" });
    expect(mocks.constructed).toEqual([]);
  });

  it("coordinator hat: the same seats question is never routed to school.seats, and the model is not offered it", async () => {
    mocks.hat = "coordinator";
    mocks.createClient.mockResolvedValue(session({ id: COORD, role: "teacher", scope: [{ grade: "5", subject: null }] }));
    const ev = await readEvents(await turnPOST(turn("how many teachers and students do we have")));
    expect((ev.find((e) => e.type === "meta")?.capabilities as string[]).includes("school.seats")).toBe(false);
    expect((ev.find((e) => e.type === "meta")?.capabilities as string[]).includes("school.cost")).toBe(true);
    expect(ev.some((e) => e.type === "tool" && e.name === "school.seats")).toBe(false);
    expect(JSON.stringify(ev)).not.toContain("Your school: teachers");
  });
});
