/**
 * Model-first COVERAGE: every ability the rules router had is a model tool.
 *   1. The inventory (intent-tools.ts) is typed Record<RuleUnion, tool>, so a
 *      new move / read / action / page without a tool fails to compile;
 *      here every tool it names exists in the registry and is open to the
 *      role that says it.
 *   2. A phrase bank walked through routeByRules (teacher, teacher on the
 *      Board, student, parent, principal, coordinator): every rules decision
 *      maps to tools that role's model is actually given (allowedFor).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/intent-tools.test.ts
 */
import { describe, expect, it } from "vitest";
import { REGISTRY } from "@/sk/capabilities";
import { NAV_TARGETS, navigateCapability } from "@/sk/capabilities/navigate";
import { parentCtx, PA } from "@/sk/capabilities/__tests__/parent-fixtures";
import { ACT_TOOLS, ALL_INTENT_TOOLS, BOARD_MOVE_TOOLS, LANG_TOOLS, LEADER_TOOLS, PARENT_TOOLS, TOUR_TOOLS, TUTOR_TOOLS, toolsForDecision } from "../intent-tools";
import { allowedFor } from "../registry";
import { routeByRules } from "../rules";
import type { SkContext } from "../types";
import { makeCtx, NOW } from "./fixtures";

const names = (ctx: SkContext) => new Set(allowedFor(ctx).map((c) => c.meta.name));
const teacher = makeCtx();
const onBoard: SkContext = {
  ...makeCtx({ path: "/present" }),
  board: {
    sessionId: "sess-1",
    manifestId: "man-1",
    generationId: "gen-1",
    k: 1,
    segments: [
      { k: 0, id: "s1", heading: "Introduction" },
      { k: 1, id: "s2", heading: "Red blood cells" },
    ],
    selection: { n: 2, text: "carry oxygen" },
  } as SkContext["board"],
};
const student = makeCtx({ role: "student", hat: null, schoolId: null, path: "/sk/biology" });
const parent = parentCtx(PA);
const principal = makeCtx({ role: "school_admin", hat: "principal" });
const coordinator = makeCtx({ role: "teacher", hat: "coordinator", scope: [{ grade: "5", subject: null }] });

describe("the inventory: every rule intent has a registered tool", () => {
  it("every tool the inventory names is in the registry", () => {
    const registered = new Set(REGISTRY.map((c) => c.meta.name));
    expect(ALL_INTENT_TOOLS.filter((t) => !registered.has(t))).toEqual([]);
  });
  it("…and open to the role whose rules used it", () => {
    const missing = (ctx: SkContext, tools: string[]) => tools.filter((t) => !names(ctx).has(t));
    expect(missing(teacher, Object.values(BOARD_MOVE_TOOLS))).toEqual([]);
    expect(missing(teacher, ["diary.note", "parents.remind", "marking.next", "marking.grade", "lesson.prepare", "context.resolve", "library.find", "start_lesson", "navigate"])).toEqual([]);
    expect(missing(principal, [ACT_TOOLS["notice.school"], ...Object.values(LEADER_TOOLS)])).toEqual([]);
    expect(missing(coordinator, [ACT_TOOLS["notice.school"], "school.health", "learners.risk", "assignments.status", "timetable.now_next"])).toEqual([]);
    expect(missing(student, [...Object.values(TUTOR_TOOLS), "book.activate", "knowledge.search", "navigate"])).toEqual([]);
    // SK Tutor retired (2026-10-31): start_lesson is the teacher's Board tool only.
    expect(names(student).has("start_lesson")).toBe(false);
    expect(missing(parent, [...Object.values(PARENT_TOOLS), "book.activate", "diary.note", "navigate"])).toEqual([]);
    for (const ctx of [teacher, student, parent, principal, coordinator]) {
      expect(missing(ctx, [...new Set([...Object.values(LANG_TOOLS), ...Object.values(TOUR_TOOLS)])]), ctx.user.role).toEqual([]);
    }
  });
  it("navigate's own target list covers every page the rules open", () => {
    const enumOf = ((navigateCapability.meta.parameters as unknown as { properties: { target: { enum: string[] } } }).properties.target.enum ?? []) as string[];
    expect([...NAV_TARGETS].filter((t) => !enumOf.includes(t))).toEqual([]);
  });
  it("the safety gates stay in the registry: a student is never given a teacher action", () => {
    const s = names(student);
    for (const t of ["diary.note", "parents.remind", "marking.grade", "lesson.prepare", "notice.school", "assign", "school.health", "child.status"]) expect(s.has(t), t).toBe(false);
    const p = names(parent);
    for (const t of ["marking.grade", "lesson.prepare", "notice.school", "board.pause", "school.health"]) expect(p.has(t), t).toBe(false);
  });
});

/** [role ctx, phrase] — the rules decide it; its tools must be the model's too. */
const BANK: Array<[string, SkContext, string]> = [
  // teacher, no Board session
  ["teacher", teacher, "open analytics for 7B"],
  ["teacher", teacher, "show me the diary for today"],
  ["teacher", teacher, "open the kits about photosynthesis"],
  ["teacher", teacher, "progress report for Ali"],
  ["teacher", teacher, "start the lesson for 7B on Specialised Cells"],
  ["teacher", teacher, "start the lesson"],
  ["teacher", teacher, "play chapter 1 of biology"],
  ["teacher", teacher, "post a notice to 7B: bring hats"],
  ["teacher", teacher, "remind the parents about the trip"],
  ["teacher", teacher, "mark the next one"],
  ["teacher", teacher, "give it 7 out of 10"],
  ["teacher", teacher, "prepare a kit for chapter 3"],
  ["teacher", teacher, "say that in Arabic"],
  ["teacher", teacher, "speak in Malay"],
  ["teacher", teacher, "Hi SK, show me around?"],
  ["teacher", teacher, "thanks"],
  // teacher on the Board
  ...(["pause", "continue", "start the video", "next slide", "previous slide", "slide 4", "part 2", "explain red blood cells", "compare red blood cells and nerve cells", "give them 3 practice questions", "freeze", "blank page", "go back", "show the slides", "load the slides", "load the deck", "show the units", "hide the units", "walk through the worksheet", "recap", "explain this", "next page", "page 31", "slide 4 in the deck"].map(
    (t): [string, SkContext, string] => ["board", onBoard, t],
  )),
  // student
  ...(["play", "pause", "start again", "where am I", "how am I doing", "quiz me", "show me the slide", "section 2", "next", "go back", "explain this", "chapter 3", "my chapters", "play chapter 1"].map((t): [string, SkContext, string] => ["student", student, t])),
  // parent
  ["parent", parent, "how is Aisyah doing"],
  ["parent", parent, "Aisyah's week"],
  ["parent", parent, "is Aisyah at risk"],
  ["parent", parent, "what has Aisyah mastered"],
  ["parent", parent, "what's in Aisyah's diary"],
  ["parent", parent, "activate my book for Aisyah"],
  ["parent", parent, "tell Aisyah's teacher she was sick yesterday"],
  // leaders
  ["principal", principal, "how is the school doing"],
  ["principal", principal, "who is at risk?"],
  ["principal", principal, "how are assignments going"],
  ["principal", principal, "how many seats are used"],
  ["principal", principal, "post a notice to the whole school: sports day on Friday"],
  ["coordinator", coordinator, "who's at risk in grade 5"],
];

describe("the phrase bank: every rules decision maps to tools the role's model is given", () => {
  it.each(BANK)("%s: %s", (_who, ctx, text) => {
    const d = routeByRules(text, ctx, NOW);
    const tools = toolsForDecision(d);
    // Only a bare pleasantry (and the plain "ask", always the model's) needs no tool.
    if (!tools.length) expect(["chat", "ask"]).toContain(d.intent);
    const open = names(ctx);
    expect(tools.filter((t) => !open.has(t)), `${text} → ${JSON.stringify(d)}`).toEqual([]);
  });
  it("the bank reaches every kind of rules decision", () => {
    const kinds = new Set<string>(
      BANK.map(([, ctx, text]) => {
        const d = routeByRules(text, ctx, NOW);
        return d.intent === "ask" ? ("parent" in d && d.parent ? "ask:parent" : "leader" in d && d.leader ? "ask:leader" : "ask") : d.intent;
      }),
    );
    for (const k of ["navigate", "chat", "teach", "act", "tutor", "lang", "tour", "ask:parent", "ask:leader"]) expect(kinds.has(k), k).toBe(true);
  });
  it("every Board move in the bank, and every tutor move", () => {
    const moves = new Set(BANK.map(([, ctx, text]) => routeByRules(text, ctx, NOW)).filter((d) => d.intent === "teach").map((d) => (d as { move: string }).move));
    // explain_selection needs a live highlight; the rest are said above.
    expect(Object.keys(BOARD_MOVE_TOOLS).filter((m) => !moves.has(m))).toEqual([]);
    const tutor = new Set(BANK.map(([, ctx, text]) => routeByRules(text, ctx, NOW)).filter((d) => d.intent === "tutor").map((d) => (d as { capability: string }).capability));
    expect(Object.keys(TUTOR_TOOLS).filter((m) => !tutor.has(m))).toEqual([]);
  });
});
