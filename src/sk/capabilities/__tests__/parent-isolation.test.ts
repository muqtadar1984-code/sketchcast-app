/**
 * S4 acceptance 2 (pure half) — CROSS-CHILD ISOLATION. A two-family fixture
 * (parent A: Aisyah + Adam; parent B: Zara; Adam's classmate Xavier; a teacher;
 * a user of another school) behind a LEAKY session that ignores every filter
 * and returns every family's rows. EVERY parent capability is run as A and as
 * B with every way of naming a child (none, each own child by name and id,
 * "my kids", the other family's names and ids, a classmate, a forged uuid).
 * No output — summary, facts or entities — may carry the other family's child
 * name or id, or a stranger's; a forged child is refused; the admin mastery
 * read only ever sees the asking parent's own children. The teacher and the
 * other-school user cannot reach a child.* capability at all.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/parent-isolation.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PARENT_CAPABILITIES } from "../parent";
import { __setParentMasteryForTests, type ChildMasteryRow } from "@/sk/parent-mastery";
import { runCapability } from "@/sk/shell/runner";
import { MemoryAuditSink } from "@/sk/shell/audit";
import { makeCtx } from "@/sk/shell/__tests__/fixtures";
import { A1, A2, B1, FAMILY_A, FAMILY_B, MASTERY, NOW, OTHER_SCHOOL_ID, OTHER_USER, PA, PB, STRANGERS, TEACHER_ID, X, leakySession, parentCtx } from "./parent-fixtures";

const reader = vi.fn(async (_admin: unknown, childId: string): Promise<ChildMasteryRow[]> => MASTERY[childId] ?? []);
beforeAll(() => {
  __setParentMasteryForTests({ admin: () => ({ from: () => ({}) }), reader });
  process.env.FEATURE_NOTICES = "true";
});
afterAll(() => {
  __setParentMasteryForTests(null);
  delete process.env.FEATURE_NOTICES;
});

const FORGED = "99999999-9999-4999-8999-999999999999";

const actors = [
  { who: "A", parent: PA, own: FAMILY_A, foreign: FAMILY_B, ownArgs: ["Aisyah", "Adam", A1, A2, "Aisyah Rahman", "adam's"], foreignArgs: [B1, "Zara", "Zara Lim"] },
  { who: "B", parent: PB, own: FAMILY_B, foreign: FAMILY_A, ownArgs: ["Zara", B1, "zara lim"], foreignArgs: [A1, A2, "Aisyah", "Adam"] },
] as const;

describe.each(actors)("parent $who", ({ parent, own, foreign, ownArgs, foreignArgs }) => {
  const banned = [...foreign.ids, ...foreign.names, ...STRANGERS.ids, ...STRANGERS.names];
  const cases = PARENT_CAPABILITIES.flatMap((cap) => [undefined, "my kids", "anak saya", "أطفالي", ...ownArgs, ...foreignArgs, X, "Xavier", FORGED].map((child) => [cap.meta.name, child] as const));

  it.each(cases)("%s with child=%s never mentions another family or a stranger", async (name, child) => {
    const cap = PARENT_CAPABILITIES.find((c) => c.meta.name === name)!;
    for (const locale of ["en", "ms", "ar"]) {
      const r = await cap.handler(parentCtx(parent, locale), child === undefined ? {} : { child }, { session: leakySession(), now: NOW, cache: new Map() });
      const out = JSON.stringify({ summary: r.summary, facts: r.facts, entities: r.entities });
      for (const b of banned) expect(out, `${name}/${child}/${locale} leaked "${b}"`).not.toContain(b);
      for (const e of r.entities ?? []) expect(own.ids as readonly string[]).toContain(e.id);
    }
  });

  it.each(PARENT_CAPABILITIES.map((c) => c.meta.name))("%s refuses a forged / foreign / classmate child id", async (name) => {
    const cap = PARENT_CAPABILITIES.find((c) => c.meta.name === name)!;
    for (const forged of [...foreign.ids, X, FORGED]) {
      const r = await cap.handler(parentCtx(parent), { child: forged }, { session: leakySession(), now: NOW, cache: new Map() });
      expect(r).toMatchObject({ ok: false, error: "not_linked", facts: [], entities: [] });
    }
  });

  it("the admin mastery read only ever receives this parent's own children", () => {
    for (const [, childId] of reader.mock.calls) expect([...FAMILY_A.ids, ...FAMILY_B.ids]).toContain(childId);
  });
});

describe("cross-family: what the mastery reader saw, per parent", () => {
  it("parent A's runs read A's children only; parent B's runs read B's only", async () => {
    for (const { parent, own } of actors) {
      reader.mockClear();
      for (const cap of PARENT_CAPABILITIES) await cap.handler(parentCtx(parent), {}, { session: leakySession(), now: NOW, cache: new Map() });
      const seen = new Set(reader.mock.calls.map((c) => c[1]));
      expect([...seen].sort()).toEqual([...own.ids].sort());
    }
  });
});

describe("non-parents never reach a child.* capability", () => {
  const others = [
    { label: "teacher", ctx: () => makeCtx({ role: "teacher", userId: TEACHER_ID }) },
    { label: "other-school user", ctx: () => makeCtx({ role: "school_admin", userId: OTHER_USER, schoolId: OTHER_SCHOOL_ID }) },
    { label: "student", ctx: () => makeCtx({ role: "student", userId: A1, hat: null }) },
  ];
  it.each(others)("$label: the runner refuses every child.* (not_allowed)", async ({ ctx }) => {
    const deps = { session: leakySession(), now: NOW, sink: new MemoryAuditSink(), sessionId: null, turnId: null };
    for (const cap of PARENT_CAPABILITIES) {
      const r = await runCapability(ctx(), cap.meta.name, { child: A1 }, deps);
      expect(r.error, cap.meta.name).toBe("not_allowed");
      expect(JSON.stringify(r)).not.toMatch(/Aisyah|Adam|Zara|Xavier/);
    }
  });
  it.each(others)("$label: even the handler called directly has no children to answer about", async ({ ctx }) => {
    for (const cap of PARENT_CAPABILITIES) {
      for (const child of [undefined, A1, B1, "Aisyah"]) {
        const r = await cap.handler(ctx(), child ? { child } : {}, { session: leakySession(), now: NOW });
        expect(r.ok).toBe(false);
        expect(JSON.stringify({ s: r.summary, f: r.facts, e: r.entities })).not.toMatch(/Aisyah|Adam|Zara|Xavier/);
      }
    }
  });
});
