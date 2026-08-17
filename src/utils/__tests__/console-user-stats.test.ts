import { describe, it, expect } from "vitest";
import { aggregateUserStats, languageSummary, EMPTY_USER_STATS } from "../console-user-stats";

describe("aggregateUserStats — the console roster's per-user numbers", () => {
  it("counts only live books and collects their distinct languages sorted", () => {
    const stats = aggregateUserStats(
      [
        { owner_id: "u1", language: "en", removed_at: null },
        { owner_id: "u1", language: "ar", removed_at: null },
        { owner_id: "u1", language: "ar", removed_at: null }, // duplicate language
        { owner_id: "u1", language: "ms", removed_at: "2026-08-01T00:00:00Z" }, // soft-deleted
        { owner_id: "u1", language: null, removed_at: null }, // language not yet detected
      ],
      [],
      [],
    );
    expect(stats.get("u1")?.books).toBe(4); // removed row excluded, null-language row still a book
    expect(stats.get("u1")?.bookLanguages).toEqual(["ar", "en"]);
  });

  it("lessons = finished presentations only — other kinds and unfinished runs don't count", () => {
    const stats = aggregateUserStats(
      [],
      [
        { owner_id: "u1", kind: "presentation", status: "done" },
        { owner_id: "u1", kind: "presentation", status: "done" },
        { owner_id: "u1", kind: "presentation", status: "error" },
        { owner_id: "u1", kind: "presentation", status: "queued" },
        { owner_id: "u1", kind: "exam_material", status: "done" },
        { owner_id: "u2", kind: "presentation", status: "done" },
      ],
      [],
    );
    expect(stats.get("u1")?.lessons).toBe(2);
    expect(stats.get("u2")?.lessons).toBe(1);
  });

  it("errors count issues in EVERY status; resolved counts only status='resolved'", () => {
    const stats = aggregateUserStats(
      [],
      [],
      [
        { reporter_id: "u1", status: "open" },
        { reporter_id: "u1", status: "in_progress" },
        { reporter_id: "u1", status: "resolved" },
        { reporter_id: null, status: "resolved" }, // reporter deleted — attributable to no row
      ],
    );
    expect(stats.get("u1")?.errors).toBe(3);
    expect(stats.get("u1")?.resolved).toBe(1);
  });

  it("a user with no rows anywhere simply has no entry — the page falls back to EMPTY_USER_STATS", () => {
    const stats = aggregateUserStats([], [], []);
    expect(stats.get("ghost")).toBeUndefined();
    expect(EMPTY_USER_STATS).toEqual({ books: 0, bookLanguages: [], lessons: 0, errors: 0, resolved: 0 });
  });
});

describe("languageSummary — the compact Language cell", () => {
  it("just the UI locale when the books (if any) match it", () => {
    expect(languageSummary("en", [])).toBe("en");
    expect(languageSummary("en", ["en"])).toBe("en");
  });

  it("appends the book languages that differ from the UI locale", () => {
    expect(languageSummary("en", ["ar"])).toBe("en · ar books");
    expect(languageSummary("en", ["ar", "en", "hi"])).toBe("en · ar, hi books");
  });

  it("missing ui_locale (never chosen) renders as — but book languages still show", () => {
    expect(languageSummary(null, [])).toBe("—");
    expect(languageSummary(undefined, [])).toBe("—");
    expect(languageSummary("", [])).toBe("—");
    expect(languageSummary(null, ["ar"])).toBe("— · ar books");
  });
});
