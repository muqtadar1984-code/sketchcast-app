import { describe, it, expect } from "vitest";
import { hatsFor, resolveHat, isHat } from "../hats";

describe("hatsFor — which hats an account holds", () => {
  it("students and signed-out users hold no hats", () => {
    expect(hatsFor({ role: "student", hasScope: false, hasChildren: false, analyticsOn: true })).toEqual([]);
    expect(hatsFor({ role: null, hasScope: true, hasChildren: true, analyticsOn: true })).toEqual([]);
  });
  it("a plain teacher holds exactly the teacher hat", () => {
    expect(hatsFor({ role: "teacher", hasScope: false, hasChildren: false, analyticsOn: true })).toEqual(["teacher"]);
  });
  it("a principal holds principal + teacher (adults implicitly teach)", () => {
    expect(hatsFor({ role: "school_admin", hasScope: false, hasChildren: false, analyticsOn: true })).toEqual([
      "principal",
      "teacher",
    ]);
  });
  it("a scope-holding teacher-parent holds coordinator + teacher + parent, in seniority order", () => {
    expect(hatsFor({ role: "teacher", hasScope: true, hasChildren: true, analyticsOn: true })).toEqual([
      "coordinator",
      "teacher",
      "parent",
    ]);
  });
  it("the coordinator hat needs the tenant's analytics suite — no suite, no hat", () => {
    expect(hatsFor({ role: "teacher", hasScope: true, hasChildren: false, analyticsOn: false })).toEqual(["teacher"]);
  });
});

describe("resolveHat — cookie vs held hats", () => {
  const hats = hatsFor({ role: "school_admin", hasScope: false, hasChildren: false, analyticsOn: true });
  it("honours a cookie naming a held hat", () => {
    expect(resolveHat("teacher", hats)).toBe("teacher");
  });
  it("falls back to the most senior hat on a missing, garbage, or un-held cookie", () => {
    expect(resolveHat(null, hats)).toBe("principal");
    expect(resolveHat("wizard", hats)).toBe("principal");
    expect(resolveHat("parent", hats)).toBe("principal"); // not held by this account
  });
  it("returns null when there are no hats (students)", () => {
    expect(resolveHat("teacher", [])).toBeNull();
  });
});

describe("isHat", () => {
  it("accepts exactly the four hats", () => {
    for (const h of ["principal", "coordinator", "teacher", "parent"]) expect(isHat(h)).toBe(true);
    for (const h of ["student", "admin", "", null, undefined]) expect(isHat(h as string | null)).toBe(false);
  });
});
