/**
 * Permission matrix, GENERATED from the registry (§8.4, §9.7): every entry ×
 * {teacher, student, parent, school_admin, coordinator} × every hat, asserting
 * `allowedFor` against the entry's own declared meta — so slice C's entries
 * are covered the moment they join REGISTRY. Plus the cross-tenant check:
 * a foreign class returned by the (fake, RLS-less) session never surfaces.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/permission-matrix.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkHat, SkRole } from "@/sk/shell/types";
import { allowedFor } from "@/sk/shell/registry";
import { effectiveRoles } from "@/sk/shell/context";
import { REGISTRY } from "@/sk/capabilities";
import { ALL_FLAGS, OTHER_SCHOOL_ID, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, NOW, fakeSession, makeCtx, type CtxOverrides } from "@/sk/shell/__tests__/fixtures";
import { resolveEntities } from "../resolve";

const ROLES: SkRole[] = ["teacher", "student", "parent", "school_admin", "coordinator"];
const HATS: SkHat[] = ["principal", "coordinator", "teacher", "parent", null];

/** A context for a (role, hat) cell. "coordinator" is a teacher holding scope. */
function cell(role: SkRole, hat: SkHat, over: CtxOverrides = {}) {
  const base: CtxOverrides =
    role === "coordinator" ? { role: "teacher", scope: [{ grade: "7", subject: null }] } : role === "school_admin" ? { role } : { role };
  return makeCtx({ ...base, hat: role === "student" ? null : hat, ...over });
}

describe("REGISTRY × role × hat — allowedFor agrees with each entry's declared meta", () => {
  it("has entries to test", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
    for (const e of REGISTRY) {
      expect(e.meta.roles.length).toBeGreaterThan(0);
      expect(["immediate", "confirm", "queued"]).toContain(e.meta.tier);
      expect(["nav", "board", "read", "act", "job"]).toContain(e.meta.kind);
    }
  });
  const cells = ROLES.flatMap((role) => HATS.map((hat) => [role, hat] as const));
  it.each(cells)("%s wearing %s", (role, hat) => {
    const ctx = cell(role, hat);
    const names = new Set(allowedFor(ctx).map((c) => c.meta.name));
    const roles = effectiveRoles(ctx);
    for (const e of REGISTRY) {
      const roleOk = e.meta.roles.some((r) => roles.includes(r));
      const hatOk = !e.meta.hats?.length || !ctx.user.hat || e.meta.hats.includes(ctx.user.hat);
      const flagsOk = !e.meta.flags?.some((f) => ctx.flags[f] !== true);
      const planOk = !e.meta.plans?.length || e.meta.plans.includes(ctx.user.plan) || ctx.user.staff;
      expect(names.has(e.meta.name), `${e.meta.name} for ${role}/${hat}`).toBe(roleOk && hatOk && flagsOk && planOk);
    }
  });
  it("a flag the entry needs, turned off, removes it (every flagged entry)", () => {
    for (const e of REGISTRY) {
      if (!e.meta.flags?.length) continue;
      const role = e.meta.roles[0];
      const off = Object.fromEntries(Object.keys(ALL_FLAGS).map((k) => [k, true]));
      off[e.meta.flags[0]] = false;
      expect(allowedFor(cell(role, null, { flags: off })).map((c) => c.meta.name)).not.toContain(e.meta.name);
    }
  });
  it("a plan the entry does not list removes it unless staff (every plan-gated entry)", () => {
    for (const e of REGISTRY) {
      if (!e.meta.plans?.length) continue;
      const role = e.meta.roles[0];
      expect(allowedFor(cell(role, null, { plan: "no-such-plan" })).map((c) => c.meta.name)).not.toContain(e.meta.name);
      expect(allowedFor(cell(role, null, { plan: "no-such-plan", staff: true })).map((c) => c.meta.name)).toContain(e.meta.name);
    }
  });
  it("a student never sees a read/act/job tool that excludes students", () => {
    const names = allowedFor(cell("student", null)).map((c) => c.meta.name);
    for (const e of REGISTRY) if (!e.meta.roles.includes("student")) expect(names).not.toContain(e.meta.name);
  });
});

describe("S7 K2: knowledge.search is in the matrix", () => {
  it("every role and every hat sees it with the sk flag on; nobody without it", () => {
    expect(REGISTRY.map((e) => e.meta.name)).toContain("knowledge.search");
    for (const role of ROLES) {
      for (const hat of HATS) expect(allowedFor(cell(role, hat)).map((c) => c.meta.name), `${role}/${hat}`).toContain("knowledge.search");
      expect(allowedFor(cell(role, null, { flags: { ...ALL_FLAGS, sk: false } })).map((c) => c.meta.name), role).not.toContain("knowledge.search");
    }
    const e = REGISTRY.find((x) => x.meta.name === "knowledge.search")!;
    expect(e.meta).toMatchObject({ tier: "immediate", kind: "read", flags: ["sk"] });
  });
});

describe("cross-tenant: context.resolve never surfaces another school's or teacher's rows", () => {
  const leaky = fakeSession({
    classes: [
      { id: "foreign-1", name: "7B", teacher_id: OTHER_TEACHER_ID, school_id: OTHER_SCHOOL_ID },
      { id: "foreign-2", name: "7B", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID },
      { id: "foreign-3", name: "7B", teacher_id: TEACHER_ID, school_id: OTHER_SCHOOL_ID },
    ],
    enrollments: [{ class_id: "foreign-1", student_id: "fs", profiles: { full_name: "Ali Foreign", username: "x" } }],
    books: [{ id: "fb", title: "Science", owner_id: OTHER_TEACHER_ID, school_id: OTHER_SCHOOL_ID }],
    parent_links: [{ parent_id: OTHER_TEACHER_ID, child_id: "fk", profiles: { full_name: "Ali Kid", username: "k" } }],
  });
  it.each(ROLES.filter((r) => r !== "student"))("%s from school A gets nothing from school B", async (role) => {
    const ctx = cell(role, null);
    for (const kind of ["class", "learner", "book", "any"] as const) {
      const r = await resolveEntities(ctx, { query: kind === "book" ? "Science" : kind === "learner" ? "Ali" : "7B", kind }, { session: leaky, now: NOW });
      expect(r.entities, `${role}/${kind}`).toEqual([]);
      expect(r.facts, `${role}/${kind}`).toEqual([]);
    }
  });
});
