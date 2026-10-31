/**
 * The SK Tutor tab is gone (founder, 2026-10-31: "remove sk tutor, we dont
 * need a separate tutor. existing books can be taught on the board itself").
 * Pinned: no hat and no role in the union view carries an /sk tab any more,
 * and the teacher's authoring row runs Library → My Analytics → Kits → Board.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/nav-tabs-sk.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
const noSk = (tabs: Array<{ href: string }>) => expect(hrefs(tabs).filter((h) => h === "/sk" || h.startsWith("/sk/"))).toEqual([]);

describe("no SK Tutor tab — hats", () => {
  it("teacher hat: Kits is followed by the Board", () => {
    const tabs = tabsForHat(T, "teacher", true, true, true, true, false, true, true);
    expect(hrefs(tabs).slice(0, 4)).toEqual(["/dashboard", "/dashboard/analytics", "/dashboard/kits", "/present"]);
    noSk(tabs);
  });
  it("every hat, school parent or not", () => {
    for (const hat of ["teacher", "parent", "principal", "coordinator"] as const)
      for (const schoolParent of [false, true]) noSk(tabsForHat(T, hat, true, true, true, true, schoolParent, true, true));
  });
});

describe("no SK Tutor tab — union view", () => {
  it("students: My lessons, then the diary", () => {
    const tabs = tabsFor(T, "student", false, false, false, false, false, false, true, "My lessons", false, false);
    expect(hrefs(tabs)).toEqual(["/dashboard", "/dashboard/diary"]);
  });
  it("every role", () => {
    for (const role of ["teacher", "school_admin", "coordinator", "parent", "student", null])
      noSk(tabsFor(T, role, true, true, true, true, true, true, true, "My lessons", true, true));
  });
  it("the header has no /sk tour marker left", () => {
    const src = readFileSync(join(resolve(__dirname, "..", ".."), "app", "dashboard", "header-nav.tsx"), "utf8");
    expect(src).not.toMatch(/"\/sk"\s*:/);
  });
});
