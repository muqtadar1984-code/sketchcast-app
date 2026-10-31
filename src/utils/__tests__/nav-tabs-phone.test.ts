/**
 * The teacher's phone tab bar: which three tabs sit in the bar and which go
 * behind "More". Nothing is dropped and nothing is duplicated, whatever the
 * flags give a teacher.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/nav-tabs-phone.test.ts
 */
import { describe, expect, it } from "vitest";
import { phoneTabBar } from "@/utils/nav-tabs";

const tab = (href: string) => ({ href, label: href });
const ALL = ["/dashboard", "/dashboard/analytics", "/dashboard/kits", "/present", "/dashboard/diary", "/dashboard/calendar", "/dashboard/my-timetable"].map(tab);

describe("phoneTabBar", () => {
  it("puts Library, Kits and Diary in the bar for a teacher with every flag on", () => {
    const { primary, more } = phoneTabBar(ALL);
    expect(primary.map((t) => t.href)).toEqual(["/dashboard", "/dashboard/kits", "/dashboard/diary"]);
    expect(more.map((t) => t.href)).toEqual(["/dashboard/analytics", "/present", "/dashboard/calendar", "/dashboard/my-timetable"]);
  });

  it("moves the next tab up when Kits and Diary are off", () => {
    const { primary } = phoneTabBar(ALL.filter((t) => t.href !== "/dashboard/kits" && t.href !== "/dashboard/diary"));
    expect(primary.map((t) => t.href)).toEqual(["/dashboard", "/present", "/dashboard/analytics"]);
  });

  it("never drops or repeats a tab", () => {
    for (let n = 0; n <= ALL.length; n++) {
      const tabs = ALL.slice(0, n);
      const { primary, more } = phoneTabBar(tabs);
      expect([...primary, ...more].map((t) => t.href).sort()).toEqual(tabs.map((t) => t.href).sort());
      expect(primary.length).toBe(Math.min(3, n));
    }
  });
});
