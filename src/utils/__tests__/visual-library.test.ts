import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE,
  duplicateKeys,
  facetsFrom,
  hasActiveFilters,
  isMissingTable,
  pageCount,
  pageRange,
  parseFilters,
  searchExpression,
  withFilter,
} from "../visual-library";

describe("parseFilters", () => {
  it("defaults to an unfiltered newest-first first page", () => {
    const f = parseFilters({});
    expect(f).toMatchObject({ type: "all", sort: "newest", page: 1, q: "" });
    expect(hasActiveFilters(f)).toBe(false);
  });

  it("keeps avatars and visuals as distinct, explicit choices", () => {
    expect(parseFilters({ type: "avatar" }).type).toBe("avatar");
    expect(parseFilters({ type: "visual" }).type).toBe("visual");
  });

  it("falls back rather than throwing on a hand-edited URL", () => {
    // An internal tool should survive someone typing in the address bar.
    expect(parseFilters({ type: "teacher" }).type).toBe("all");
    expect(parseFilters({ sort: "; drop table" }).sort).toBe("newest");
    expect(parseFilters({ status: "approved-ish" }).status).toBe("");
    expect(parseFilters({ page: "-4" }).page).toBe(1);
    expect(parseFilters({ page: "abc" }).page).toBe(1);
  });

  it("only accepts statuses the schema's CHECK constraint allows", () => {
    expect(parseFilters({ status: "approved" }).status).toBe("approved");
    expect(parseFilters({ status: "retired" }).status).toBe("retired");
    expect(parseFilters({ status: "banana" }).status).toBe("");
  });
});

describe("searchExpression", () => {
  it("searches identity and description columns", () => {
    const e = searchExpression("photosynthesis")!;
    expect(e).toContain("canonical_key.ilike.%photosynthesis%");
    expect(e).toContain("topic.ilike.%photosynthesis%");
    expect(e).toContain("description.ilike.%photosynthesis%");
  });

  it("strips the characters that are PostgREST's own or() separators", () => {
    // Left in, these change the SHAPE of the filter rather than its value.
    const e = searchExpression("a,b(c)")!;
    expect(e).not.toContain("(");
    expect(e).not.toContain(")");
    expect(e.split("asset_key.ilike").length - 1).toBe(1);
  });

  it("is null for an empty or whitespace query", () => {
    expect(searchExpression("")).toBeNull();
    expect(searchExpression("   ")).toBeNull();
    expect(searchExpression(",,,")).toBeNull();
  });
});

describe("pagination", () => {
  it("asks Postgres for one page, never the library", () => {
    expect(pageRange(1)).toEqual([0, PAGE_SIZE - 1]);
    expect(pageRange(3, 24)).toEqual([48, 71]);
  });

  it("clamps a nonsense page to the first", () => {
    expect(pageRange(0, 24)).toEqual([0, 23]);
  });

  it("always reports at least one page, even when empty", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(25, 24)).toBe(2);
    expect(pageCount(48, 24)).toBe(2);
  });
});

describe("facetsFrom", () => {
  it("derives options from the data instead of a hard-coded list", () => {
    // The brief is explicit: a subject nobody predicted must still appear.
    const f = facetsFrom([
      { subject: "Biology", grade: "7", curriculum: "Cambridge", topic: "Cells" },
      { subject: "Marine Robotics", grade: "9", curriculum: "IB", topic: "Sensors" },
      { subject: "Biology", grade: "7", curriculum: "Cambridge", topic: "Cells" },
    ]);
    expect(f.subjects).toEqual(["Biology", "Marine Robotics"]);
    expect(f.grades).toEqual(["7", "9"]);
    expect(f.curricula).toEqual(["Cambridge", "IB"]);
  });

  it("drops blanks so the dropdowns stay usable", () => {
    const f = facetsFrom([
      { subject: "", grade: "  ", curriculum: "IB", topic: "" },
      { subject: "Physics", grade: "8", curriculum: "IB", topic: "Forces" },
    ]);
    expect(f.subjects).toEqual(["Physics"]);
    expect(f.grades).toEqual(["8"]);
    expect(f.topics).toEqual(["Forces"]);
  });
});

describe("withFilter", () => {
  const base = parseFilters({ subject: "Biology", type: "visual", q: "cell" });

  it("combines filters rather than replacing them", () => {
    const qs = withFilter(base, { grade: "7" });
    expect(qs).toContain("subject=Biology");
    expect(qs).toContain("type=visual");
    expect(qs).toContain("q=cell");
    expect(qs).toContain("grade=7");
  });

  it("returns to page 1 when a filter changes", () => {
    // Changing a filter on page 7 of the old result set otherwise lands on an
    // empty page and reads as "no assets".
    const onPage7 = parseFilters({ subject: "Biology", page: "7" });
    expect(withFilter(onPage7, { subject: "Physics" })).not.toContain("page=");
  });

  it("keeps the page when paging explicitly", () => {
    expect(withFilter(base, { page: 3 })).toContain("page=3");
  });

  it("omits defaults so a clean view has a clean URL", () => {
    expect(withFilter(parseFilters({}), {})).toBe("");
  });
});

describe("isMissingTable", () => {
  it("recognises an unapplied migration, which is the expected first state", () => {
    // visual_assets is defined in the WORKER repo; the console may well load
    // before that migration is applied, and must explain rather than crash.
    expect(isMissingTable({ code: "42P01" })).toBe(true);
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ message: "Could not find the table 'public.visual_assets'" })).toBe(true);
  });

  it("does not swallow real errors", () => {
    expect(isMissingTable(null)).toBe(false);
    expect(isMissingTable({ code: "42501", message: "permission denied" })).toBe(false);
  });
});

describe("duplicateKeys", () => {
  it("surfaces rows sharing a canonical key instead of cleaning them up", () => {
    const d = duplicateKeys([
      { canonical_key: "cell_plant" },
      { canonical_key: "cell_plant" },
      { canonical_key: "leaf" },
    ]);
    expect([...d]).toEqual(["cell_plant"]);
  });

  it("is empty when every key is distinct", () => {
    expect(duplicateKeys([{ canonical_key: "a" }, { canonical_key: "b" }]).size).toBe(0);
  });
});
