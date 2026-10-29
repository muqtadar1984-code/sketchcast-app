/**
 * SK S4 — a PARENT turn through the real /api/sk/shell/turn route: "how are my
 * kids doing" with two linked children is answered by child.status itself —
 * one block per child, grounded, and NO model is constructed. ctx.children is
 * built by loadContext from the parent's own parent_links (the leaky fake also
 * returns another family's link; it never reaches the answer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn(), constructed: [] as string[] }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super([{ text: ["The model must not answer a parent's child question."] }] as StubTurn[]);
        mocks.constructed.push(model);
      }
    },
  };
});

import { POST as turnPOST } from "@/app/api/sk/shell/turn/route";
import { fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";
import { __setParentMasteryForTests, type ChildMasteryRow } from "@/sk/parent-mastery";
import { MASTERY, PA, TABLES } from "@/sk/capabilities/__tests__/parent-fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "SK_AUDIT", "FEATURE_PARENT_PORTAL", "FEATURE_NOTICES", "FEATURE_ROLE_HATS"];
const saved: Record<string, string | undefined> = {};
const EMAIL = "parent.a@family.example";

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher,student,parent";
  process.env.SK_ALLOWED_EMAILS = EMAIL;
  process.env.SK_SHELL_SECRET = "parent-turn-test-secret-of-adequate-length";
  process.env.FEATURE_PARENT_PORTAL = "true";
  mocks.constructed = [];
  mocks.createAdminClient.mockImplementation(() => {
    throw new Error("no service key in tests");
  });
  mocks.createClient.mockResolvedValue(
    fakeSession({ ...TABLES, profiles: [{ role: "parent", school_id: null, full_name: "Parent A" }] }, { user: { id: PA, email: EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z" } }),
  );
  __setParentMasteryForTests({ admin: () => ({ from: () => ({}) }), reader: async (_a, id): Promise<ChildMasteryRow[]> => MASTERY[id] ?? [] });
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setParentMasteryForTests(null);
});

let n = 0;
const turn = (text: string) =>
  new Request("http://x/api/sk/shell/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId: `7a1c2d3e-4b5a-4c7d-8e9f-${String(++n).padStart(12, "0")}`, text, modality: "text", collector: { path: "/dashboard/children", locale: "en" } }),
  });

describe("parent turn — deterministic child answers", () => {
  it('"how are my kids doing" → one block per child, grounded, no model', async () => {
    const ev = await readEvents(await turnPOST(turn("how are my kids doing")));
    const text = ev.find((e) => e.type === "text")?.text as string;
    expect(text.split("\n")).toEqual(["Aisyah: shared work 3 — done 2, overdue 0, awaiting marking 1.", "Adam: shared work 1 — done 0, overdue 1, awaiting marking 0. Overdue: Worksheet — Cells (due Tue 27 Oct)."]);
    expect(ev.find((e) => e.type === "tool")).toMatchObject({ name: "child.status", ok: true });
    expect(ev.find((e) => e.type === "done")).toMatchObject({ sources: ["child.status"], label: "grounded" });
    expect(text).not.toMatch(/Zara|Xavier/);
    expect(mocks.constructed).toEqual([]);
  });
  it('"Aisyah\'s week" → the digest with what to do about it', async () => {
    const ev = await readEvents(await turnPOST(turn("Aisyah's week")));
    const text = ev.find((e) => e.type === "text")?.text as string;
    expect(text).toBe('Aisyah — this week: done 2, overdue 0, awaiting marking 1; ideas mastered 1; new diary notes 1. What to do about it: revisit "Explain diffusion" in Cells; finish Quiz — Plants before Fri 30 Oct.');
    expect(mocks.constructed).toEqual([]);
  });
  it("another family's child is refused, declined, no model", async () => {
    const ev = await readEvents(await turnPOST(turn("how is Zara doing")));
    expect(ev.find((e) => e.type === "text")?.text).toBe("That child isn't linked to your account, so I can't show anything about them.");
    expect(ev.find((e) => e.type === "done")).toMatchObject({ label: "declined", sources: [] });
    expect(mocks.constructed).toEqual([]);
  });
  it("the entities remembered are the parent's own children", async () => {
    const ev = await readEvents(await turnPOST(turn("is Adam at risk")));
    expect(ev.find((e) => e.type === "text")?.text).toBe("Adam could use a hand: has not started yet.");
    expect(JSON.stringify(ev)).not.toMatch(/Zara|Xavier/);
  });
});
