/**
 * SK Shell registry filter (§9.7): roles ∩ hat ∩ flags ∩ plans, tool defs,
 * lookup. Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/registry.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkCapability } from "../types";
import { API_TOOL_NAME_RE, allowedFor, findCapability, fromApiToolName, metaAllows, toApiToolName, toToolDefs } from "../registry";
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
  // S1 slice B: the Board moves (teacher hat + Board access).
  "board.intro",
  "board.segment",
  "board.slide",
  "board.explain",
  "board.compare",
  "board.practise",
  "board.walkthrough",
  "board.freeze",
  "board.blank",
  "board.back",
  "board.resume",
  "board.pause",
  "board.recap",
  // Board UX (2026-10-28): the unit rail overlay and the slides-as-pages load.
  "board.rail",
  "board.load_slides",
  // Founder 2026-10-28: the kit's .pptx as pages.
  "board.load_deck",
  // Founder 2026-10-28: explain the highlighted part of a deck slide.
  "board.explain_selection",
  // S1 slice D: the first confirm-tier action (teacher hat only).
  "assign",
  // S2 slice A: diary note + parent reminders (teacher hat, diary flag).
  "diary.note",
  "parents.remind",
  // S2 slice B: the marking queue + lesson prep (teacher hat; prepare is click-only).
  "marking.next",
  "marking.grade",
  "lesson.prepare",
  "lesson.status",
  // S3 slice D: the student tutor (student role only).
  "tutor.where",
  "tutor.progress",
  "tutor.play",
  "tutor.section",
  "tutor.slide",
  "tutor.practise",
  "tutor.explain",
  // S4 slices A+B: the parent reads (parent role only).
  "child.status",
  "child.diary",
  "child.notices",
  "child.risk",
  "child.progress",
  "child.week",
  // S4 slice D: book activation (student + parent, sk flag; click-only).
  "book.activate",
  // S5 slice A: the leader read (principal / coordinator hats only).
  "school.health",
];
const STUDENT_ONLY = SHIPPED.filter((n) => n.startsWith("tutor."));
const PARENT_ONLY = SHIPPED.filter((n) => n.startsWith("child."));
const STUDENT_AND_PARENT = ["book.activate"];
// S5 slice A: leader-hat entries (never a plain teacher's).
const LEADER_ONLY = ["school.health"];
const TEACHER_SEES = SHIPPED.filter((n) => !STUDENT_ONLY.includes(n) && !PARENT_ONLY.includes(n) && !STUDENT_AND_PARENT.includes(n) && !LEADER_ONLY.includes(n));
// S4 slice C: diary.note's parent branch (a note to one of her own children).
const PARENT_SEES = ["navigate", "context.resolve", "diary.note", ...PARENT_ONLY, ...STUDENT_AND_PARENT];
const STUDENT_SEES = ["navigate", ...STUDENT_ONLY, ...STUDENT_AND_PARENT];

describe("allowedFor over the shipped registry", () => {
  it("teacher: everything but the tutor, child.* and book.activate; parent: navigate + context.resolve + diary.note + child.* + book.activate; student: navigate + the tutor + book.activate", () => {
    const teacher = allowedFor(makeCtx()).map((c) => c.meta.name);
    expect(teacher).toEqual(TEACHER_SEES);
    expect(teacher.some((n) => n.startsWith("child.") || n === "book.activate")).toBe(false);
    expect(allowedFor(makeCtx({ role: "student" })).map((c) => c.meta.name)).toEqual(STUDENT_SEES);
    expect(allowedFor(makeCtx({ role: "parent", hat: "parent" })).map((c) => c.meta.name)).toEqual(PARENT_SEES);
  });
  it("S5: school.health is the principal's and the coordinator's — by hat — never the teacher hat's", () => {
    const sees = (o: Parameters<typeof makeCtx>[0]) => allowedFor(makeCtx(o)).map((c) => c.meta.name).includes("school.health");
    expect(sees({ role: "school_admin", hat: "principal" })).toBe(true);
    expect(sees({ role: "school_admin", hat: "teacher" })).toBe(false);
    expect(sees({ role: "teacher", scope: [{ grade: "5", subject: null }], hat: "coordinator" })).toBe(true);
    expect(sees({ role: "teacher", scope: [{ grade: "5", subject: null }], hat: "teacher" })).toBe(false);
    expect(sees({ role: "teacher", hat: "teacher" })).toBe(false);
    expect(sees({ role: "parent", hat: "parent" })).toBe(false);
    expect(sees({ role: "student" })).toBe(false);
  });
  it("filters a custom list and leaves REGISTRY untouched", () => {
    const list = [cap({ name: "a", roles: ["student"] }), cap({ name: "b", roles: ["teacher"] })];
    expect(allowedFor(makeCtx(), list).map((c) => c.meta.name)).toEqual(["b"]);
    expect(REGISTRY.map((c) => c.meta.name)).toEqual(SHIPPED);
  });
});

describe("toToolDefs / findCapability", () => {
  it("maps meta to the provider's ToolDef shape with API-safe names (dots → __)", () => {
    const defs = toToolDefs(REGISTRY);
    expect(defs.map((d) => d.name)).toEqual(SHIPPED.map((n) => n.replace(/\./g, "__")));
    // The live failure of 2026-10-28: Anthropic rejects any tool name outside
    // this pattern with a 400, which the Shell reports as a non-retryable error.
    for (const d of defs) expect(d.name).toMatch(API_TOOL_NAME_RE);
    for (const n of SHIPPED) {
      expect(fromApiToolName(toApiToolName(n))).toBe(n);
      expect(findCapability(toApiToolName(n))?.meta.name).toBe(n);
      expect(findCapability(n)?.meta.name).toBe(n);
    }
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
