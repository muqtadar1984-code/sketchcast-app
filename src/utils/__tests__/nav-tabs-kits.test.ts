/**
 * The Kits tab (catalogue Phase C). Pinned: where it appears — the teacher
 * hat, the CONSUMER parent hat and every adult in the union view, right after
 * My Analytics — and where it never does: students, school-provisioned
 * parents and leadership hats. And that the default (no argument) is OFF, so
 * the existing positional call sites and tests are unchanged.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/nav-tabs-kits.test.ts
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
} as unknown as Parameters<typeof tabsForHat>[0];

const hrefs = (tabs: Array<{ href: string }>) => tabs.map((t) => t.href);

describe("Kits tab — hats", () => {
  it("teacher hat: right after My Analytics, before the board", () => {
    const on = hrefs(tabsForHat(T, "teacher", true, true, true, true, false, true, true));
    expect(on.slice(0, 4)).toEqual(["/dashboard", "/dashboard/analytics", "/dashboard/kits", "/present"]);
    const off = hrefs(tabsForHat(T, "teacher", true, true, true, true, false, true));
    expect(off).not.toContain("/dashboard/kits");
    expect(off).toEqual(on.filter((h) => h !== "/dashboard/kits"));
  });
  it("consumer parent hat: with the Library; a school parent (no Library) has no Kits either", () => {
    expect(hrefs(tabsForHat(T, "parent", true, true, true, true, false, false, true))).toContain("/dashboard/kits");
    expect(hrefs(tabsForHat(T, "parent", true, true, true, true, true, false, true))).not.toContain("/dashboard/kits");
  });
  it("leadership hats never carry it", () => {
    expect(hrefs(tabsForHat(T, "principal", true, true, true, true, false, false, true))).not.toContain("/dashboard/kits");
    expect(hrefs(tabsForHat(T, "coordinator", true, true, true, true, false, false, true))).not.toContain("/dashboard/kits");
  });
});

describe("Kits tab — union view", () => {
  it("every adult role gets it after My Analytics; students never", () => {
    for (const role of ["teacher", "parent", "school_admin"]) {
      const tabs = hrefs(tabsFor(T, role, role === "school_admin", role === "parent", false, true, true, true, true, "My lessons", true, true));
      expect(tabs.slice(0, 3)).toEqual(["/dashboard", "/dashboard/analytics", "/dashboard/kits"]);
    }
    expect(hrefs(tabsFor(T, "student", false, false, false, true, true, true, true, "My lessons", false, true))).not.toContain("/dashboard/kits");
    expect(hrefs(tabsFor(T, "teacher", false, false, false, true, true, true, true, "My lessons", true))).not.toContain("/dashboard/kits");
  });
});
