/**
 * The SK Tutor tab (founder, 2026-10-27: live, restricted to the allow-list).
 * Pinned: where it appears — the teacher hat and the CONSUMER parent hat right
 * after Kits, every role in the union view (students included: it is the
 * learner's surface), and never a leadership hat or a school-provisioned
 * parent — and that the default (no argument) is OFF, so every existing call
 * site and test reads unchanged.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/nav-tabs-sk.test.ts
 */
import { describe, expect, it } from "vitest";
import { tabsFor, tabsForHat } from "@/utils/nav-tabs";

const T = {
  library: "Library",
  myAnalytics: "My Analytics",
  diary: "Diary",
  schoolDiary: "School Diary",
  calendar: "Calendar",
  timetable: "Timetable",
  school: "School",
  teachers: "Teachers",
  access: "Access",
  admin: "Admin",
  myChildren: "My Children",
  testPapers: "Test Papers",
  books: "Books",
  board: "Board",
  kits: "Kits",
  skTutor: "SK Tutor",
} as unknown as Parameters<typeof tabsForHat>[0];

const hrefs = (tabs: Array<{ href: string }>) => tabs.map((t) => t.href);

describe("SK Tutor tab — hats", () => {
  it("teacher hat: right after Kits, before the board; label from the dictionary", () => {
    const tabs = tabsForHat(T, "teacher", true, true, true, true, false, true, true, true);
    expect(hrefs(tabs).slice(0, 5)).toEqual(["/dashboard", "/dashboard/analytics", "/dashboard/kits", "/sk", "/present"]);
    expect(tabs.find((t) => t.href === "/sk")?.label).toBe("SK Tutor");
  });
  it("teacher hat without kits: right after My Analytics", () => {
    expect(hrefs(tabsForHat(T, "teacher", true, true, true, true, false, true, false, true)).slice(0, 3)).toEqual([
      "/dashboard",
      "/dashboard/analytics",
      "/sk",
    ]);
  });
  it("consumer parent hat: with the authoring surfaces; school parent: not at all", () => {
    expect(hrefs(tabsForHat(T, "parent", false, false, false, false, false, false, false, true))).toContain("/sk");
    expect(hrefs(tabsForHat(T, "parent", false, false, false, false, true, false, false, true))).not.toContain("/sk");
  });
  it("leadership hats never carry it", () => {
    for (const hat of ["principal", "coordinator"] as const)
      expect(hrefs(tabsForHat(T, hat, true, true, true, true, false, false, false, true))).not.toContain("/sk");
  });
  it("default is OFF", () => {
    expect(hrefs(tabsForHat(T, "teacher", true, true, true, true, false, true, true))).not.toContain("/sk");
  });
});

describe("SK Tutor tab — union view", () => {
  it("teacher: right after Kits; off by default", () => {
    const on = hrefs(tabsFor(T, "teacher", false, false, false, false, false, false, false, "My lessons", true, true, true));
    expect(on.slice(0, 5)).toEqual(["/dashboard", "/dashboard/analytics", "/dashboard/kits", "/sk", "/present"]);
    const off = hrefs(tabsFor(T, "teacher", false, false, false, false, false, false, false, "My lessons", true, true));
    expect(off).not.toContain("/sk");
    expect(off).toEqual(on.filter((h) => h !== "/sk"));
  });
  it("student: right after My lessons", () => {
    expect(hrefs(tabsFor(T, "student", false, false, false, false, false, false, true, "My lessons", false, false, true))).toEqual([
      "/dashboard",
      "/sk",
      "/dashboard/diary",
    ]);
    expect(hrefs(tabsFor(T, "student", false, false, false, false, false, false, true, "My lessons", false, false))).not.toContain("/sk");
  });
  it("school admin and parent-with-children carry it too", () => {
    expect(hrefs(tabsFor(T, "school_admin", true, false, false, true, false, false, false, "My lessons", true, false, true))).toContain("/sk");
    expect(hrefs(tabsFor(T, "parent", false, true, false, false, false, false, false, "My lessons", false, false, true))).toContain("/sk");
  });
});
