/**
 * Which pages the SK panel warms up for a navigate (prefetch.ts): the role's
 * targets only, nothing until `navigate` is a capability, each path once per
 * panel. Pure.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/prefetch.test.ts
 */
import { describe, expect, it } from "vitest";
import { PREFETCH_PATHS, pathsToPrefetch, prefetchTargets } from "../prefetch";

const CAPS = ["navigate", "context.resolve", "library.find"];

describe("prefetchTargets — role gating", () => {
  it("a teacher gets the teacher pages, in a stable order", () => {
    expect(prefetchTargets("teacher", "teacher")).toEqual(["/dashboard", "/dashboard/analytics", "/present", "/dashboard/kits", "/dashboard/diary", "/dashboard/my-timetable", "/dashboard/calendar"]);
  });
  it("a student gets lessons, diary and timetable only — never the board, analytics or kits", () => {
    const t = prefetchTargets("student", null);
    expect(t).toEqual(["/dashboard", "/dashboard/diary", "/dashboard/my-timetable"]);
    expect(t).not.toContain(PREFETCH_PATHS.board);
    expect(t).not.toContain(PREFETCH_PATHS.analytics);
  });
  it("the parent hat (or a parent with hats off) gets children, diary, calendar — never the board", () => {
    expect(prefetchTargets("teacher", "parent")).toEqual(["/dashboard", "/dashboard/children", "/dashboard/diary", "/dashboard/calendar"]);
    expect(prefetchTargets("parent", null)).toEqual(["/dashboard", "/dashboard/children", "/dashboard/diary", "/dashboard/calendar"]);
  });
  it("the leadership hats get only the calendar (their School pages keep their own launcher)", () => {
    expect(prefetchTargets("school_admin", "principal")).toEqual(["/dashboard/calendar"]);
    expect(prefetchTargets("teacher", "coordinator")).toEqual(["/dashboard/calendar"]);
  });
  it("an adult with hats off gets the union view", () => {
    expect(prefetchTargets("school_admin", null)).toContain("/present");
    expect(prefetchTargets(null, null)).toContain("/dashboard");
  });
});

describe("pathsToPrefetch — dedupe and the navigate gate", () => {
  it("returns nothing until `navigate` is among the capabilities", () => {
    const done = new Set<string>();
    expect(pathsToPrefetch({ role: "teacher", hat: "teacher", capabilities: ["library.find"], done })).toEqual([]);
    expect(done.size).toBe(0);
  });
  it("returns each path once per panel, however many meta events arrive", () => {
    const done = new Set<string>();
    const first = pathsToPrefetch({ role: "teacher", hat: "teacher", capabilities: CAPS, done });
    expect(first).toEqual(prefetchTargets("teacher", "teacher"));
    expect(pathsToPrefetch({ role: "teacher", hat: "teacher", capabilities: CAPS, done })).toEqual([]);
    expect(pathsToPrefetch({ role: "teacher", hat: "teacher", capabilities: CAPS, done })).toEqual([]);
    expect([...done].sort()).toEqual([...first].sort());
  });
  it("a path already requested is skipped, a new one is not", () => {
    const done = new Set<string>(["/dashboard", "/present"]);
    const out = pathsToPrefetch({ role: "teacher", hat: "teacher", capabilities: CAPS, done });
    expect(out).not.toContain("/dashboard");
    expect(out).not.toContain("/present");
    expect(out).toContain("/dashboard/analytics");
  });
});
