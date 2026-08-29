import { describe, expect, it } from "vitest";

import { tabsForHat } from "@/utils/nav-tabs";

/**
 * A SCHOOL parent is a spectator; a CONSUMER parent is the teacher.
 *
 * The parent hat was built for the consumer case (founder, 2026-07-19): a
 * homeschool parent authors from the Library, so the hat carries the full
 * authoring set and never switches. When schools arrived, that same hat started
 * being worn by parents who teach nobody — and it offered them the Library and
 * "My Analytics", which measures your own teaching and is therefore empty by
 * construction for them (founder, 2026-08-29).
 *
 * The predicate is the one the Test Papers tab already used, read both ways: a
 * parent_links row with source='school' means the school provisioned this
 * parent, so they GAIN the school-portal surface and LOSE the authoring ones.
 */

const T = {
  library: "Library", myAnalytics: "My Analytics", myChildren: "My Children",
  diary: "Diary", testPapers: "Test Papers", calendar: "Calendar",
  timetable: "Timetable", school: "School", teachers: "Teachers",
  access: "Access", admin: "Admin", books: "Books", schoolDiary: "School diary",
} as unknown as Parameters<typeof tabsForHat>[0];

const labels = (schoolParent: boolean) =>
  tabsForHat(T, "parent", true, true, true, true, schoolParent).map((x: { label: string }) => x.label);

describe("the parent hat's tabs", () => {
  it("gives a school parent no authoring surfaces", () => {
    const t = labels(true);
    expect(t).not.toContain("Library");
    expect(t).not.toContain("My Analytics");
  });

  it("still gives a school parent everything they came for", () => {
    // Their children, the communication book, the school's dates, and the
    // papers the school shares with them.
    expect(labels(true)).toEqual(["My Children", "Diary", "Test Papers", "Calendar"]);
  });

  it("leaves the consumer parent untouched", () => {
    // The 2026-07-19 decision: a homeschool parent authors from the Library and
    // must never have to switch hats to reach it.
    const t = labels(false);
    expect(t).toContain("Library");
    expect(t).toContain("My Analytics");
    expect(t).not.toContain("Test Papers");
  });

  it("is the SAME switch both ways round", () => {
    // Library/My Analytics and Test Papers are mirror images — no parent should
    // ever see all three, and none should see none of them.
    for (const school of [true, false]) {
      const t = labels(school);
      expect(t.includes("Library")).toBe(!t.includes("Test Papers"));
    }
  });

  it("does not touch the teacher hat", () => {
    // A teacher who is also a school parent keeps everything under their own
    // hat — that is what hats are for.
    const t = tabsForHat(T, "teacher", true, true, true, true, true).map((x: { label: string }) => x.label);
    expect(t).toContain("Library");
    expect(t).toContain("My Analytics");
  });

  it("keeps My Children first for a school parent, so the page is not empty", () => {
    // With the Library gone it becomes the landing tab; parentHatHome already
    // sends a non-home-educator parent there.
    expect(labels(true)[0]).toBe("My Children");
  });
});
