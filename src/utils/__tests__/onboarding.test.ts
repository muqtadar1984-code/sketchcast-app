/**
 * New-joiner onboarding logic (pure). The load-bearing decisions:
 *  • seedRole — never silently default a non-parent to parent; anything unknown
 *    seeds teacher (matches the app-wide default we're trying to make explicit).
 *  • missingRequired — the SAME gate the client uses to disable "Continue" and the
 *    server uses to reject a bypass, so they can never disagree.
 *  • homeForRole — where each confirmed role lands.
 * Run: npx vitest run src/utils/__tests__/onboarding.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  homeForRole,
  missingRequired,
  seedRole,
  type OnboardingProfile,
} from "@/utils/onboarding";

describe("seedRole", () => {
  it("seeds parent only for an explicit parent", () => {
    expect(seedRole("parent")).toBe("parent");
  });
  it("seeds teacher for teacher, unknown, null, and empty", () => {
    expect(seedRole("teacher")).toBe("teacher");
    expect(seedRole("student")).toBe("teacher");
    expect(seedRole("coordinator")).toBe("teacher");
    expect(seedRole(null)).toBe("teacher");
    expect(seedRole(undefined)).toBe("teacher");
    expect(seedRole("")).toBe("teacher");
  });
});

describe("missingRequired — teacher", () => {
  const full = (extra: OnboardingProfile = {}): OnboardingProfile => ({
    affiliation: "independent",
    grade_levels: ["Grades 4–6"],
    subjects: ["Mathematics"],
    ...extra,
  });

  it("is empty when name + affiliation + grades + subjects are all present", () => {
    expect(missingRequired("teacher", "Alex Morgan", full())).toEqual([]);
  });

  it("requires a full name", () => {
    expect(missingRequired("teacher", "   ", full())).toContain("full_name");
  });

  it("requires affiliation, grade_levels and subjects", () => {
    const m = missingRequired("teacher", "Alex", {});
    expect(m).toContain("affiliation");
    expect(m).toContain("grade_levels");
    expect(m).toContain("subjects");
  });

  it("requires school_name only when affiliation is school", () => {
    expect(missingRequired("teacher", "Alex", full({ affiliation: "school" }))).toContain("school_name");
    expect(missingRequired("teacher", "Alex", full({ affiliation: "school", school_name: "Riverside" }))).toEqual([]);
    // independent/homeschool never require school_name
    expect(missingRequired("teacher", "Alex", full({ affiliation: "homeschool" }))).toEqual([]);
  });

  it("treats an empty array as missing", () => {
    expect(missingRequired("teacher", "Alex", full({ subjects: [] }))).toContain("subjects");
  });
});

describe("missingRequired — parent", () => {
  it("is empty with a count ≥ 1 and at least one grade", () => {
    expect(
      missingRequired("parent", "Sam Lee", { children_count: 2, child_grade_levels: ["Grades 1–3"] }),
    ).toEqual([]);
  });

  it("requires children_count ≥ 1 and child_grade_levels", () => {
    const m = missingRequired("parent", "Sam", {});
    expect(m).toContain("children_count");
    expect(m).toContain("child_grade_levels");
    expect(missingRequired("parent", "Sam", { children_count: 0, child_grade_levels: ["x"] })).toContain(
      "children_count",
    );
  });

  it("does NOT require teacher-only fields", () => {
    const m = missingRequired("parent", "Sam", { children_count: 1, child_grade_levels: ["Grades 1–3"] });
    expect(m).not.toContain("affiliation");
    expect(m).not.toContain("subjects");
  });
});

describe("homeForRole", () => {
  it("sends parents to their children, teachers to the dashboard", () => {
    expect(homeForRole("parent")).toBe("/dashboard/children");
    expect(homeForRole("teacher")).toBe("/dashboard");
  });
});
