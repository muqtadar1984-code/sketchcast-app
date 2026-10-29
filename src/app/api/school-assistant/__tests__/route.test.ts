/**
 * SK S5 slice B — the School Briefing panel's daily cap is the SAME counter as
 * SK's leader school reads: its count takes scope IN ('school_briefing',
 * 'sk_school') over the same UTC day. Minimal: the gate is a principal, the
 * snapshot and the provider are mocked; analytics_access_log is the
 * filter-honouring fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), providerCalls: 0 }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/flags", () => ({ schoolAssistantEnabledFor: async () => true }));
vi.mock("@/utils/school-health", () => ({
  fetchSchoolHealthRows: async () => ({}),
  computeSchoolHealth: () => ({ totals: { atRisk: 0, students: 0 } }),
}));
vi.mock("@/utils/assistant/provider", () => ({
  assistantProvider: async () => {
    mocks.providerCalls++;
    throw new Error("no provider in tests");
  },
}));

import { POST } from "@/app/api/school-assistant/route";
import { fakeSession } from "@/sk/shell/__tests__/fixtures";
import { fakeAuditLog, withAuditLog, type AuditLogFake } from "@/sk/shell/__tests__/audit-log-fake";
import { utcDayStart } from "@/sk/shell/school-meter";

const PA = "84d6c190-0000-4000-8000-000000000001";
const SCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const today = () => new Date(utcDayStart(new Date()).getTime() + 1);
let aal: AuditLogFake;

beforeEach(() => {
  mocks.providerCalls = 0;
  aal = fakeAuditLog({ user: PA });
  mocks.createClient.mockResolvedValue(
    withAuditLog(
      fakeSession(
        {
          profiles: [{ id: PA, full_name: "Puan Pengetua", role: "school_admin", school_id: SCH }],
          schools: [{ id: SCH, name: "Demo School", display_name: null }],
        },
        { user: { id: PA, email: "p@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" } },
      ),
      aal,
    ),
  );
});

const ask = () => POST(new Request("http://x/api/school-assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "How is the school doing?" }) }));

describe("briefing cap — one counter with SK's school reads", () => {
  it("59 sk_school + 1 school_briefing today → the next briefing turn is 429", async () => {
    aal.seed(59, { actor: PA, scope: "sk_school", at: today() });
    aal.seed(1, { actor: PA, scope: "school_briefing", at: new Date(today().getTime() + 100) });
    const res = await ask();
    expect(res.status).toBe(429);
    expect(aal.inserted).toHaveLength(0);
    expect(mocks.providerCalls).toBe(0);
  });
  it("59 rows across both scopes → the 60th briefing turn passes the cap (and writes its row)", async () => {
    aal.seed(58, { actor: PA, scope: "sk_school", at: today() });
    aal.seed(1, { actor: PA, scope: "school_briefing", at: new Date(today().getTime() + 100) });
    const res = await ask();
    expect(res.status).not.toBe(429);
    expect(aal.inserted).toHaveLength(1);
    expect(aal.inserted[0]).toMatchObject({ actor_id: PA, scope: "school_briefing" });
  });
  it("yesterday's and other scopes' rows do not count", async () => {
    aal.seed(80, { actor: PA, scope: "sk_school", at: new Date(utcDayStart(new Date()).getTime() - 3_600_000) });
    aal.seed(80, { actor: PA, scope: "at_risk", at: today() });
    expect((await ask()).status).not.toBe(429);
  });
});
