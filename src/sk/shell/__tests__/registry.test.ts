/**
 * SK Shell registry filter (§9.7): roles ∩ hat ∩ flags ∩ plans, tool defs,
 * lookup. Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/registry.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkCapability } from "../types";
import { allowedFor, findCapability, metaAllows, toToolDefs } from "../registry";
import { REGISTRY } from "@/sk/capabilities";
import { makeCtx } from "./fixtures";

const cap = (over: Partial<SkCapability["meta"]>): SkCapability => ({
  meta: {
    name: "x.y",
    description: "d",
    parameters: { type: "object", properties: {} },
    tier: "immediate",
    kind: "read",
    roles: ["teacher"],
    ...over,
  },
  handler: async () => ({ ok: true, summary: "" }),
});

describe("metaAllows", () => {
  it("roles: the profile role or the coordinator grant must be listed", () => {
    expect(metaAllows(cap({ roles: ["teacher"] }).meta, makeCtx({ role: "teacher" }))).toBe(true);
    expect(metaAllows(cap({ roles: ["teacher"] }).meta, makeCtx({ role: "parent", hat: "parent" }))).toBe(false);
    expect(metaAllows(cap({ roles: ["coordinator"] }).meta, makeCtx({ role: "teacher" }))).toBe(false);
    expect(metaAllows(cap({ roles: ["coordinator"] }).meta, makeCtx({ role: "teacher", scope: [{ grade: "7", subject: null }], hat: "coordinator" }))).toBe(true);
    expect(metaAllows(cap({ roles: ["school_admin"] }).meta, makeCtx({ role: "school_admin", hat: "principal" }))).toBe(true);
  });
  it("hats narrow when on, and the union view applies when the hat is null", () => {
    const m = cap({ roles: ["school_admin"], hats: ["principal"] }).meta;
    expect(metaAllows(m, makeCtx({ role: "school_admin", hat: "principal" }))).toBe(true);
    expect(metaAllows(m, makeCtx({ role: "school_admin", hat: "teacher" }))).toBe(false);
    expect(metaAllows(m, makeCtx({ role: "school_admin", hat: null }))).toBe(true);
  });
  it("flags: every listed flag must be true", () => {
    const m = cap({ flags: ["timetable", "diary"] }).meta;
    expect(metaAllows(m, makeCtx())).toBe(true);
    expect(metaAllows(m, makeCtx({ flags: { diary: false } }))).toBe(false);
    expect(metaAllows(cap({ flags: ["nope"] }).meta, makeCtx())).toBe(false);
  });
  it("plans: listed plans only, staff bypass", () => {
    const m = cap({ plans: ["school", "pro_plus"] }).meta;
    expect(metaAllows(m, makeCtx({ plan: "school" }))).toBe(true);
    expect(metaAllows(m, makeCtx({ plan: "trial" }))).toBe(false);
    expect(metaAllows(m, makeCtx({ plan: "trial", staff: true }))).toBe(true);
  });
});

/** The shipped S0 registry, in order: core (B) then the teacher knowledge
 *  tools v1 (C). A new entry must be added here on purpose. */
const SHIPPED = [
  "navigate",
  "context.resolve",
  "library.find",
  "catalogue.availability",
  "assignments.status",
  "learners.risk",
  "timetable.now_next",
];
const TEACHER_SEES = SHIPPED;
const PARENT_SEES = ["navigate", "context.resolve"];
const STUDENT_SEES = ["navigate"];

describe("allowedFor over the shipped registry", () => {
  it("teacher: everything; parent: navigate + context.resolve; student: navigate only", () => {
    expect(allowedFor(makeCtx()).map((c) => c.meta.name)).toEqual(TEACHER_SEES);
    expect(allowedFor(makeCtx({ role: "student" })).map((c) => c.meta.name)).toEqual(STUDENT_SEES);
    expect(allowedFor(makeCtx({ role: "parent", hat: "parent" })).map((c) => c.meta.name)).toEqual(PARENT_SEES);
  });
  it("filters a custom list and leaves REGISTRY untouched", () => {
    const list = [cap({ name: "a", roles: ["student"] }), cap({ name: "b", roles: ["teacher"] })];
    expect(allowedFor(makeCtx(), list).map((c) => c.meta.name)).toEqual(["b"]);
    expect(REGISTRY.map((c) => c.meta.name)).toEqual(SHIPPED);
  });
});

describe("toToolDefs / findCapability", () => {
  it("maps meta to the provider's ToolDef shape", () => {
    const defs = toToolDefs(REGISTRY);
    expect(defs.map((d) => d.name)).toEqual(SHIPPED);
    for (const d of defs) {
      expect(typeof d.description).toBe("string");
      expect((d.parameters as { type: string }).type).toBe("object");
    }
  });
  it("finds by name, null otherwise", () => {
    expect(findCapability("navigate")?.meta.kind).toBe("nav");
    expect(findCapability("context.resolve")?.meta.kind).toBe("read");
    expect(findCapability("nope")).toBeNull();
  });
});
