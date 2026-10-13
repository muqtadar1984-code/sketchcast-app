import { describe, it, expect } from "vitest";
import {
  applyRosterFilters,
  hasRosterFilters,
  joinedDate,
  matchesRosterFilters,
  parseRosterFilters,
  type RosterRow,
} from "../console-roster-filter";

const row = (extra: Partial<RosterRow> = {}): RosterRow => ({
  name: "Amina Hassan",
  identifier: "amina@school.eg",
  role: "teacher",
  school: "Nile Academy",
  country: "EG",
  language: "ar · en books",
  books: 3,
  lessons: 5,
  artifacts: 12,
  errors: 1,
  resolved: 1,
  joined: "2026-10-07",
  ...extra,
});

describe("parseRosterFilters — the query string is the filter state", () => {
  it("keeps set keys, drops blanks, and floors non-negative numbers", () => {
    expect(
      parseRosterFilters({ name: " ami ", role: "teacher", school: "", books: "2.7", errors: "-1", lessons: "abc", joined: "2026-10", q: "x" }),
    ).toEqual({ name: "ami", role: "teacher", books: 2, joined: "2026-10" });
  });

  it("takes the first value of a repeated key", () => {
    expect(parseRosterFilters({ country: ["SA", "EG"] })).toEqual({ country: "SA" });
  });

  it("reports whether anything is set", () => {
    expect(hasRosterFilters({})).toBe(false);
    expect(hasRosterFilters({ lessons: 0 })).toBe(true);
  });
});

describe("matchesRosterFilters — one rule per column kind", () => {
  it("text columns match case-insensitively by substring", () => {
    expect(matchesRosterFilters(row(), { name: "HASS" })).toBe(true);
    expect(matchesRosterFilters(row(), { email: "@school" })).toBe(true);
    expect(matchesRosterFilters(row(), { language: "en books" })).toBe(true);
    expect(matchesRosterFilters(row(), { name: "zed" })).toBe(false);
  });

  it("role and school match exactly; country ignores case", () => {
    expect(matchesRosterFilters(row(), { role: "teacher" })).toBe(true);
    expect(matchesRosterFilters(row(), { role: "teach" })).toBe(false);
    expect(matchesRosterFilters(row(), { school: "Nile Academy" })).toBe(true);
    expect(matchesRosterFilters(row(), { school: "Nile" })).toBe(false);
    expect(matchesRosterFilters(row(), { country: "eg" })).toBe(true);
    expect(matchesRosterFilters(row({ country: "" }), { country: "EG" })).toBe(false);
  });

  it("numeric columns are minimums, so 0 keeps everyone and a real zero still matches 0", () => {
    expect(matchesRosterFilters(row(), { lessons: 5 })).toBe(true);
    expect(matchesRosterFilters(row(), { lessons: 6 })).toBe(false);
    expect(matchesRosterFilters(row({ books: 0 }), { books: 0 })).toBe(true);
  });

  it("joined is a date prefix: a month, a day, or a year", () => {
    expect(matchesRosterFilters(row(), { joined: "2026-10" })).toBe(true);
    expect(matchesRosterFilters(row(), { joined: "2026-10-07" })).toBe(true);
    expect(matchesRosterFilters(row(), { joined: "2025" })).toBe(false);
  });

  it("every set filter must pass", () => {
    expect(matchesRosterFilters(row(), { role: "teacher", lessons: 9 })).toBe(false);
    expect(matchesRosterFilters(row(), { role: "teacher", lessons: 1, country: "EG" })).toBe(true);
  });
});

describe("applyRosterFilters", () => {
  it("returns the input untouched when nothing is set and filters through a row mapper otherwise", () => {
    const items = [{ id: "a", n: 1 }, { id: "b", n: 7 }];
    const toRow = (i: { n: number }) => row({ lessons: i.n });
    expect(applyRosterFilters(items, toRow, {})).toBe(items);
    expect(applyRosterFilters(items, toRow, { lessons: 5 }).map((i) => i.id)).toEqual(["b"]);
  });
});

describe("joinedDate", () => {
  it("renders the UTC calendar date and tolerates a bad timestamp", () => {
    expect(joinedDate("2026-10-07T23:59:00Z")).toBe("2026-10-07");
    expect(joinedDate("2026-10-07T23:59:00+05:30")).toBe("2026-10-07");
    expect(joinedDate("nope")).toBe("");
  });
});
