/**
 * SK S5 slice B — the 60/day cap + audit and the analytics gate through the
 * real /api/sk/shell/turn route: the leader block (rules-routed, no model) and
 * the model's own tool calls. analytics_access_log is a filter-honouring fake;
 * everything else is fixtures.ts's fakeSession over leader-fixtures' rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  constructed: [] as string[],
  hat: undefined as string | undefined,
  script: [] as unknown[],
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "sc_hat" && mocks.hat ? { value: mocks.hat } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super((mocks.script.length ? mocks.script : [{ text: ["(model)"] }]) as StubTurn[]);
        mocks.constructed.push(model);
      }
    },
  };
});

import { POST as turnPOST } from "@/app/api/sk/shell/turn/route";
import { fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";
import { allRows, COORD, PA, SCH_A } from "@/sk/capabilities/__tests__/leader-fixtures";
import { fakeAuditLog, withAuditLog, type AuditLogFake } from "@/sk/shell/__tests__/audit-log-fake";
import { utcDayStart } from "@/sk/shell/school-meter";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "SK_AUDIT", "FEATURE_ROLE_HATS", "FEATURE_DIARY", "FEATURE_PARENT_PORTAL", "FEATURE_SCHOOL_ANALYTICS"];
const saved: Record<string, string | undefined> = {};
const EMAIL = "leader@school.example";
const CAP_LINE = "You've reached today's 60 school questions — it resets at midnight UTC.";
const AUDIT_LINE = "I can't open school figures right now — try again in a moment.";
const OFF_LINE = "School analytics aren't switched on for your school.";
/** School A learner / class names: none may appear in a refused answer. */
const SCHOOL_A = ["Amir", "Balqis", "5 Amanah", "5 Bestari"];

let aal: AuditLogFake;
const session = (who: { id: string; role: string; scope?: Array<{ grade: string; subject: string | null }> }, o: { failInsert?: boolean } = {}) => {
  aal = fakeAuditLog({ user: who.id, ...o });
  return withAuditLog(
    fakeSession(
      {
        ...allRows(),
        profiles: [{ id: who.id, role: who.role, school_id: SCH_A, full_name: "Leader" }],
        coordinator_scope: (who.scope ?? []).map((s) => ({ coordinator_id: who.id, school_id: SCH_A, ...s })),
        parent_links: [],
      } as never,
      { user: { id: who.id, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" } },
    ),
    aal,
  );
};
const principal = (o: { failInsert?: boolean } = {}) => session({ id: PA, role: "school_admin" }, o);
const coordinator = () => session({ id: COORD, role: "teacher", scope: [{ grade: "5", subject: null }] });
const today = () => new Date(utcDayStart(new Date()).getTime() + 1);

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,school_admin";
  process.env.SK_ALLOWED_EMAILS = EMAIL;
  process.env.SK_SHELL_SECRET = "school-meter-turn-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.FEATURE_DIARY = "true";
  process.env.FEATURE_SCHOOL_ANALYTICS = "true";
  mocks.constructed = [];
  mocks.hat = undefined;
  mocks.script = [];
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
const newTurnId = () => `5b5b2d3e-4b5a-4c7d-8e9f-${String(++n).padStart(12, "0")}`;
const turn = (text: string, turnId = newTurnId()) =>
  new Request("http://x/api/sk/shell/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId, text, modality: "text", collector: { path: "/dashboard/school", locale: "en" } }),
  });
const answer = (ev: Array<Record<string, unknown>>) => ev.find((e) => e.type === "text")?.text as string;

describe("the leader block — metered before the read", () => {
  it("59 rows today → this turn is the 60th: answered, one row written", async () => {
    mocks.createClient.mockResolvedValue(principal());
    aal.seed(59, { actor: PA, scope: "sk_school", at: today() });
    const ev = await readEvents(await turnPOST(turn("how is the school doing")));
    expect(answer(ev)).toMatch(/^Overview for the school:/);
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "grounded" });
    expect(aal.inserted).toHaveLength(1);
    expect(aal.inserted[0]).toMatchObject({ actor_id: PA, actor_role: "school_admin", school_id: SCH_A, scope: "sk_school", target_kind: "sk_capability", target_id: null });
    expect(aal.inserted[0].detail).toMatchObject({ capability: "school.health", mode: "school" });
  });
  it("60 rows today → the 61st is refused with the cap line; its row stays; no school data; no model", async () => {
    mocks.createClient.mockResolvedValue(principal());
    aal.seed(60, { actor: PA, scope: "sk_school", at: today() });
    const ev = await readEvents(await turnPOST(turn("how is the school doing")));
    expect(answer(ev)).toBe(CAP_LINE);
    expect(ev.find((e) => e.type === "tool")).toMatchObject({ name: "school.health", ok: false });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ sources: [], label: "declined" });
    for (const t of SCHOOL_A) expect(JSON.stringify(ev)).not.toContain(t);
    expect(aal.rows).toHaveLength(61);
    expect(mocks.constructed).toEqual([]);
  });
  it("the School Briefing panel's rows count toward it", async () => {
    mocks.createClient.mockResolvedValue(principal());
    aal.seed(45, { actor: PA, scope: "school_briefing", at: today() });
    aal.seed(15, { actor: PA, scope: "sk_school", at: new Date(today().getTime() + 50) });
    const ev = await readEvents(await turnPOST(turn("who's at risk")));
    expect(answer(ev)).toBe(CAP_LINE);
  });
  it("a failed audit insert refuses the read (fail closed)", async () => {
    mocks.createClient.mockResolvedValue(principal({ failInsert: true }));
    const ev = await readEvents(await turnPOST(turn("how is the school doing")));
    expect(answer(ev)).toBe(AUDIT_LINE);
    for (const t of SCHOOL_A) expect(JSON.stringify(ev)).not.toContain(t);
    expect(aal.rows).toHaveLength(0);
  });
  it("a replayed turn id writes no second row and answers the same", async () => {
    mocks.createClient.mockResolvedValue(principal());
    const id = newTurnId();
    const first = answer(await readEvents(await turnPOST(turn("how is the school doing", id))));
    const again = answer(await readEvents(await turnPOST(turn("how is the school doing", id))));
    expect(again).toBe(first);
    expect(aal.rows).toHaveLength(1);
    // A different turn is a new row.
    await readEvents(await turnPOST(turn("how is the school doing")));
    expect(aal.rows).toHaveLength(2);
  });
});

describe("the analytics gate — per role", () => {
  it("principal with school analytics off → the fixed line; nothing metered; no model", async () => {
    delete process.env.FEATURE_SCHOOL_ANALYTICS;
    mocks.createClient.mockResolvedValue(principal());
    const ev = await readEvents(await turnPOST(turn("how is the school doing")));
    expect(answer(ev)).toBe(OFF_LINE);
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "declined" });
    expect(aal.rows).toHaveLength(0);
    expect(mocks.constructed).toEqual([]);
  });
  it("coordinator hat with school analytics off → the same line", async () => {
    delete process.env.FEATURE_SCHOOL_ANALYTICS;
    // The coordinator hat needs analytics, timetable or diary on: diary is.
    mocks.hat = "coordinator";
    mocks.createClient.mockResolvedValue(coordinator());
    const ev = await readEvents(await turnPOST(turn("who's at risk in grade 5")));
    expect(answer(ev)).toBe(OFF_LINE);
    expect(aal.rows).toHaveLength(0);
  });
  it("teacher hat (own classes) with analytics off: not a leader turn — the S0 model path, unmetered", async () => {
    delete process.env.FEATURE_SCHOOL_ANALYTICS;
    mocks.hat = "teacher";
    mocks.createClient.mockResolvedValue(coordinator());
    const ev = await readEvents(await turnPOST(turn("who's at risk in grade 5")));
    expect(answer(ev)).not.toBe(OFF_LINE);
    expect(mocks.constructed.length).toBe(1);
    expect(aal.rows).toHaveLength(0);
  });
});

describe("the model's tool calls — the same gate", () => {
  it("two leader reads in one turn write ONE row", async () => {
    mocks.createClient.mockResolvedValue(principal());
    mocks.script = [
      {
        toolCalls: [
          { id: "c1", name: "school__health", args: {} },
          { id: "c2", name: "learners__risk", args: {} },
        ],
      },
      { text: ["Here is the picture."] },
    ];
    const ev = await readEvents(await turnPOST(turn("anything I should worry about this week")));
    expect(mocks.constructed.length).toBe(1);
    expect(ev.filter((e) => e.type === "tool").map((e) => [e.name, e.ok])).toEqual([
      ["school.health", true],
      ["learners.risk", true],
    ]);
    expect(aal.inserted).toHaveLength(1);
  });
  it("a capped model read: the cap line is the answer, not the model's words", async () => {
    mocks.createClient.mockResolvedValue(principal());
    aal.seed(60, { actor: PA, scope: "school_briefing", at: today() });
    mocks.script = [{ toolCalls: [{ id: "c1", name: "school__health", args: {} }] }, { text: ["The school has 99 learners."] }];
    const ev = await readEvents(await turnPOST(turn("anything I should worry about this week")));
    expect(answer(ev)).toBe(CAP_LINE);
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "declined" });
    expect(aal.rows).toHaveLength(61);
  });
});
