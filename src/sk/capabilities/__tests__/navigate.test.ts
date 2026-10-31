/**
 * `navigate` target × role/hat matrix (mirrors nav-tabs.ts) and the path
 * builder with filters.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/navigate.test.ts
 */
import { describe, expect, it } from "vitest";
import { NAV_NEEDS_LEARNER, NAV_REFUSED, NAV_TARGETS, navTargetsFor, navigateCapability, resolveNavigate, type NavTarget } from "../navigate";
import { makeCtx, type CtxOverrides } from "@/sk/shell/__tests__/fixtures";

const sorted = (xs: readonly string[]) => [...xs].sort();
const targets = (o: CtxOverrides) => sorted(navTargetsFor(makeCtx(o)));

describe("navTargetsFor — the header's tabs, per hat", () => {
  it("teacher hat: authoring + board + diary + my timetable + calendar + reports", () => {
    expect(targets({ hat: "teacher" })).toEqual(sorted(["library", "analytics", "kits", "board", "diary", "timetable", "calendar", "reports"]));
  });
  it("teacher hat with surfaces off loses exactly those", () => {
    expect(targets({ hat: "teacher", flags: { kits: false, board: false, diary: false, timetable: false, calendar: false, sk: false } })).toEqual(
      sorted(["library", "analytics", "reports"]),
    );
  });
  it("consumer parent: authoring + children; school parent: watching only", () => {
    expect(targets({ role: "parent", hat: "parent" })).toEqual(sorted(["library", "analytics", "kits", "children", "diary", "calendar", "reports"]));
    expect(targets({ role: "parent", hat: "parent", flags: { schoolParent: true } })).toEqual(sorted(["children", "diary", "calendar", "reports"]));
  });
  it("principal: school/* incl. admin, school diary, school timetable, calendar — nothing authoring", () => {
    expect(targets({ role: "school_admin", hat: "principal" })).toEqual(
      sorted(["school", "school_teachers", "school_access", "school_admin", "school_books", "school_diary", "timetable", "calendar"]),
    );
  });
  it("coordinator: school/* WITHOUT admin", () => {
    expect(targets({ role: "teacher", hat: "coordinator", scope: [{ grade: "7", subject: null }] })).toEqual(
      sorted(["school", "school_teachers", "school_access", "school_books", "school_diary", "timetable", "calendar"]),
    );
  });
  it("leadership with analytics off keeps only diary/timetable/calendar", () => {
    expect(targets({ role: "school_admin", hat: "principal", flags: { analytics: false } })).toEqual(sorted(["school_diary", "timetable", "calendar"]));
  });
  it("student: my lessons, diary, my timetable (no SK Tutor any more)", () => {
    expect(targets({ role: "student" })).toEqual(sorted(["library", "diary", "timetable"]));
  });
  it("hats off (union view): a school_admin sees authoring AND school/*; a teacher with scope sees school/* without admin", () => {
    expect(targets({ role: "school_admin", hat: null })).toEqual(
      sorted(["library", "analytics", "kits", "board", "diary", "calendar", "school", "school_teachers", "school_access", "school_admin", "school_books", "school_diary", "timetable", "children", "reports"]),
    );
    expect(targets({ role: "teacher", hat: null, scope: [{ grade: "7", subject: null }], flags: { hasChildren: false } })).toEqual(
      sorted(["library", "analytics", "kits", "board", "diary", "calendar", "school", "school_teachers", "school_access", "school_books", "school_diary", "timetable", "reports"]),
    );
  });
});

describe("resolveNavigate — refusals", () => {
  const refused = (o: CtxOverrides, target: NavTarget) => resolveNavigate(makeCtx(o), { target });
  it("a teacher cannot navigate to school_admin (or any school/*)", () => {
    for (const t of ["school_admin", "school", "school_teachers", "school_access", "school_books", "school_diary"] as NavTarget[]) {
      expect(refused({ hat: "teacher" }, t)).toMatchObject({ ok: false, error: "not_allowed", summary: NAV_REFUSED });
    }
  });
  it("a parent cannot reach analytics unless a consumer parent; never the board", () => {
    expect(refused({ role: "parent", hat: "parent", flags: { schoolParent: true } }, "analytics").ok).toBe(false);
    expect(refused({ role: "parent", hat: "parent" }, "analytics").ok).toBe(true);
    expect(refused({ role: "parent", hat: "parent" }, "board").ok).toBe(false);
    expect(refused({ role: "parent", hat: null }, "board").ok).toBe(false);
  });
  it("a principal reaches school/*; a coordinator not school_admin; a student nothing leadership", () => {
    expect(refused({ role: "school_admin", hat: "principal" }, "school_admin")).toMatchObject({ ok: true, navigate: { path: "/dashboard/school/admin" } });
    expect(refused({ role: "teacher", hat: "coordinator", scope: [{ grade: "7", subject: null }] }, "school_admin").ok).toBe(false);
    expect(refused({ role: "student" }, "school").ok).toBe(false);
    expect(refused({ role: "student" }, "analytics").ok).toBe(false);
    expect(refused({ role: "student" }, "board").ok).toBe(false);
  });
  it("an unknown target is refused without touching the matrix", () => {
    expect(resolveNavigate(makeCtx(), { target: "console" })).toMatchObject({ ok: false, error: "unknown_target" });
    expect(resolveNavigate(makeCtx(), {})).toMatchObject({ ok: false, error: "unknown_target" });
  });
});

describe("navPath — the exact target table", () => {
  const teacher = makeCtx({ hat: "teacher" });
  const principal = makeCtx({ role: "school_admin", hat: "principal" });
  const parent = makeCtx({ role: "parent", hat: "parent" });
  const student = makeCtx({ role: "student" });
  const path = (ctx = teacher, target: NavTarget, f: Record<string, string> = {}) => {
    const r = resolveNavigate(ctx, { target, ...f });
    return r.ok ? r.navigate!.path : `REFUSED:${r.error}`;
  };
  it.each<[NavTarget, string]>([
    ["library", "/dashboard"],
    ["analytics", "/dashboard/analytics"],
    ["board", "/present"],
    ["kits", "/dashboard/kits"],
    ["diary", "/dashboard/diary"],
    ["timetable", "/dashboard/my-timetable"],
    ["calendar", "/dashboard/calendar"],
  ])("teacher %s → %s", (target, expected) => {
    expect(path(teacher, target)).toBe(expected);
  });
  it.each<[NavTarget, string]>([
    ["school", "/dashboard/school"],
    ["school_teachers", "/dashboard/school/teachers"],
    ["school_access", "/dashboard/school/access"],
    ["school_admin", "/dashboard/school/admin"],
    ["school_books", "/dashboard/school/books"],
    ["school_diary", "/dashboard/school/diary"],
    ["timetable", "/dashboard/school/timetable"],
    ["calendar", "/dashboard/calendar"],
  ])("principal %s → %s", (target, expected) => {
    expect(path(principal, target)).toBe(expected);
  });
  it("no tutor target any more (SK Tutor retired 2026-10-31): unknown, for every role", () => {
    expect(NAV_TARGETS as readonly string[]).not.toContain("tutor");
    for (const ctx of [teacher, parent, student]) expect(resolveNavigate(ctx, { target: "tutor", product: "biology", chapter: "1" })).toMatchObject({ ok: false, error: "unknown_target" });
  });
  it("parent children; student my lessons label", () => {
    expect(path(parent, "children")).toBe("/dashboard/children");
    const r = resolveNavigate(student, { target: "library" });
    expect(r.navigate).toEqual({ path: "/dashboard", label: "My lessons" });
  });
  it("filters: class on analytics/diary/school diary, day, month, topic, learner", () => {
    expect(path(teacher, "analytics", { classId: "c1" })).toBe("/dashboard/analytics?c=c1");
    expect(path(teacher, "diary", { day: "2026-10-28", classId: "c1" })).toBe("/dashboard/diary?d=2026-10-28&c=c1");
    expect(path(principal, "school_diary", { classId: "c1", day: "2026-10-28" })).toBe("/dashboard/school/diary?c=c1&d=2026-10-28");
    expect(path(teacher, "calendar", { month: "2026-11" })).toBe("/dashboard/calendar?m=2026-11");
    expect(path(teacher, "kits", { topic: "fractions & decimals" })).toBe("/dashboard/kits?topic=fractions+%26+decimals");
    expect(path(teacher, "reports", { learnerId: "L1" })).toBe("/dashboard/reports/L1");
  });
  it("rejects malformed filters silently and asks for a learner on reports", () => {
    expect(path(teacher, "analytics", { classId: "c1; drop" })).toBe("/dashboard/analytics");
    expect(path(teacher, "diary", { day: "tomorrow" })).toBe("/dashboard/diary");
    expect(path(teacher, "calendar", { month: "2026-1" })).toBe("/dashboard/calendar");
    expect(resolveNavigate(teacher, { target: "reports" })).toMatchObject({ ok: false, error: "needs_learner", summary: NAV_NEEDS_LEARNER });
  });
  it("the handler is the pure core; meta lists every role and the enum", async () => {
    const r = await navigateCapability.handler(teacher, { target: "board" }, { session: { from: () => null, rpc: () => null }, now: new Date() });
    expect(r).toMatchObject({ ok: true, navigate: { path: "/present", label: "Classroom board" } });
    expect(navigateCapability.meta).toMatchObject({ name: "navigate", tier: "immediate", kind: "nav" });
    expect(sorted(navigateCapability.meta.roles)).toEqual(sorted(["teacher", "student", "parent", "school_admin", "coordinator"]));
    expect((navigateCapability.meta.parameters.properties.target as { enum: string[] }).enum).toEqual([...NAV_TARGETS]);
  });
});

describe("board filters: the deep link the Board page reads (deep-link.ts)", () => {
  const teacher = makeCtx({ hat: "teacher" });
  const path = (f: Record<string, unknown>) => {
    const r = resolveNavigate(teacher, { target: "board", ...f });
    return r.ok ? r.navigate!.path : `REFUSED:${r.error}`;
  };
  it("class + book + chapter + autostart", () => {
    expect(path({ classId: "c7b", bookId: "b1", chapterRef: "2", autostart: true })).toBe("/present?class=c7b&book=b1&chapter=2&autostart=1");
    expect(path({ bookId: "b1", chapterRef: 2, autostart: "1" })).toBe("/present?book=b1&chapter=2&autostart=1");
  });
  it("a ready-made kit stands alone (a book beside it is dropped)", () => {
    expect(path({ generationId: "g-kit", autostart: true })).toBe("/present?kit=g-kit&autostart=1");
    expect(path({ classId: "c7b", generationId: "g-kit", bookId: "b1", chapterRef: "2" })).toBe("/present?class=c7b&kit=g-kit");
  });
  it("autostart needs a lesson to start; a chapter needs its book; only params present are written", () => {
    expect(path({ autostart: true })).toBe("/present");
    expect(path({ bookId: "b1", autostart: true })).toBe("/present?book=b1");
    expect(path({ chapterRef: "2", autostart: true })).toBe("/present");
    expect(path({ classId: "c7b" })).toBe("/present?class=c7b");
    expect(path({})).toBe("/present");
  });
  it("validates like the other filters: malformed ids and chapters are dropped", () => {
    expect(path({ bookId: "b1; drop", chapterRef: "2" })).toBe("/present");
    expect(path({ bookId: "b1", chapterRef: "two" })).toBe("/present?book=b1");
    expect(path({ generationId: "../x" })).toBe("/present");
    expect(path({ bookId: "b1", chapterRef: "2", autostart: "yes" })).toBe("/present?book=b1&chapter=2");
  });
  it("the Board filters are in the tool's schema", () => {
    const props = navigateCapability.meta.parameters.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["bookId", "chapterRef", "generationId", "autostart"]));
  });
});
