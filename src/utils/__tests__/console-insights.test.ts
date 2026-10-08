import { describe, it, expect } from "vitest";
import {
  countryName, isCustomerJob, monthlyFailureRate, monthStartUtc, sharedBooks, stalledAccounts, topCountries, topTeachersByKits,
} from "../console-insights";

const prof = (id: string, role = "teacher", extra: Partial<{ full_name: string | null; username: string | null; country: string | null; country_source: string | null; school_id: string | null }> = {}) => ({
  id,
  role,
  full_name: null,
  username: null,
  country: null,
  country_source: null,
  school_id: null,
  ...extra,
});
const gen = (owner_id: string, status = "done", kind: string | null = "presentation", created_at = "2026-10-01T00:00:00Z") => ({
  owner_id,
  kind,
  status,
  created_at,
});

describe("topTeachersByKits — the Overview's top-5 teachers", () => {
  it("counts finished presentations only, the roster's Lessons number", () => {
    const [t] = topTeachersByKits(
      [prof("u1", "teacher", { full_name: "Amina" })],
      [
        gen("u1"),
        gen("u1", "done", null), // legacy NULL kind = presentation
        gen("u1", "error"), // not finished
        gen("u1", "done", "deck"), // another kind
        gen("u1", "done", "worksheet"),
      ],
    );
    expect(t).toMatchObject({ id: "u1", name: "Amina", kits: 2 });
  });

  it("ranks by kits, breaks ties by the more recent kit, and caps at the limit", () => {
    const rows = topTeachersByKits(
      [prof("a", "teacher", { username: "a" }), prof("b", "coordinator", { username: "b" }), prof("c", "teacher", { username: "c" })],
      [
        gen("a", "done", "presentation", "2026-09-01T00:00:00Z"),
        gen("b", "done", "presentation", "2026-09-05T00:00:00Z"),
        gen("c", "done", "presentation", "2026-09-01T00:00:00Z"),
        gen("c", "done", "presentation", "2026-09-02T00:00:00Z"),
      ],
      2,
    );
    expect(rows.map((r) => r.id)).toEqual(["c", "b"]);
    expect(rows[0].lastAt).toBe("2026-09-02T00:00:00Z");
  });

  it("ignores students, parents and unknown owners — teachers and coordinators only", () => {
    const rows = topTeachersByKits(
      [prof("s", "student"), prof("p", "parent"), prof("t", "teacher")],
      [gen("s"), gen("p"), gen("ghost"), gen("t")],
    );
    expect(rows.map((r) => r.id)).toEqual(["t"]);
  });

  it("falls back from full_name to username to a dash, like the roster", () => {
    const rows = topTeachersByKits(
      [prof("a", "teacher", { username: "handle" }), prof("b", "teacher")],
      [gen("a"), gen("b")],
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["handle", "—"]);
  });
});

describe("topCountries — where the accounts come from", () => {
  it("tallies alpha-2 codes case-insensitively, counts the assumed ones, and reports the unknowns", () => {
    const r = topCountries([
      prof("1", "teacher", { country: "EG", country_source: "signup" }),
      prof("2", "teacher", { country: "eg", country_source: "assumed" }),
      prof("3", "student", { country: "IN" }),
      prof("4", "parent", { country: null }),
      prof("5", "teacher", { country: " " }),
    ]);
    expect(r.top).toEqual([
      { code: "EG", name: "Egypt", users: 2, assumed: 1 },
      { code: "IN", name: "India", users: 1, assumed: 0 },
    ]);
    expect(r.unknown).toBe(2);
    expect(r.total).toBe(5);
  });

  it("caps at the limit, most users first, ties by code", () => {
    const r = topCountries(
      [prof("1", "t", { country: "MY" }), prof("2", "t", { country: "JO" }), prof("3", "t", { country: "US" }), prof("4", "t", { country: "US" })],
      2,
    );
    expect(r.top.map((c) => c.code)).toEqual(["US", "JO"]);
  });

  it("names a region it knows and keeps the code for one it does not", () => {
    expect(countryName("SA")).toBe("Saudi Arabia");
    expect(countryName("ZZ")).toBe("ZZ"); // ICU's reserved "Unknown Region"
    expect(countryName("Q9")).toBe("Q9"); // not a region subtag at all
  });
});

describe("sharedBooks — books more than one user uploaded", () => {
  const book = (owner_id: string, title: string | null, extra: Partial<{ pages: number | null; content_hash: string | null; language: string | null; removed_at: string | null }> = {}) => ({
    owner_id,
    title,
    pages: null,
    content_hash: null,
    language: null,
    removed_at: null,
    ...extra,
  });

  it("groups by content hash first, counts distinct owners and total uploads, and needs two owners", () => {
    const rows = sharedBooks([
      book("a", "Physics 10", { content_hash: "h1", language: "ar" }),
      book("b", "physics 10 (copy)", { content_hash: "h1", language: "ar" }),
      book("b", "Physics 10", { content_hash: "h1" }), // same owner again: an upload, not a new user
      book("c", "Solo", { content_hash: "h2" }),
    ]);
    expect(rows).toEqual([{ title: "Physics 10", uploads: 3, owners: 2, languages: ["ar"] }]);
  });

  it("falls back to title + page count for uploads without a hash, case-insensitively", () => {
    const rows = sharedBooks([
      book("a", "Cambridge Maths 5", { pages: 200 }),
      book("b", "cambridge maths 5", { pages: 200 }),
      book("c", "Cambridge Maths 5", { pages: 150 }), // a different edition
    ]);
    expect(rows).toEqual([{ title: "Cambridge Maths 5", uploads: 2, owners: 2, languages: [] }]);
  });

  it("skips soft-deleted uploads and rows with nothing to group on", () => {
    const rows = sharedBooks([
      book("a", "Gone", { content_hash: "h9" }),
      book("b", "Gone", { content_hash: "h9", removed_at: "2026-09-01T00:00:00Z" }),
      book("a", null),
      book("b", ""),
    ]);
    expect(rows).toEqual([]);
  });

  it("orders by owners, then uploads, then title, and caps at the limit", () => {
    const rows = sharedBooks(
      [
        book("a", "B", { content_hash: "b" }), book("b", "B", { content_hash: "b" }),
        book("a", "A", { content_hash: "a" }), book("b", "A", { content_hash: "a" }), book("c", "A", { content_hash: "a" }),
        book("a", "C", { content_hash: "c" }), book("b", "C", { content_hash: "c" }), book("b", "C", { content_hash: "c" }),
      ],
      2,
    );
    expect(rows.map((r) => `${r.title}:${r.owners}/${r.uploads}`)).toEqual(["A:3/3", "C:2/3"]);
  });
});

describe("stalledAccounts — where adults stop after signing up", () => {
  const people = [
    { id: "t-nobook", role: "teacher" },
    { id: "c-nobook", role: "coordinator" },
    { id: "p-nobook", role: "parent" },
    { id: "t-book-nogen", role: "teacher" },
    { id: "p-book-nogen", role: "parent" },
    { id: "t-book-failed", role: "teacher" },
    { id: "t-active", role: "teacher" },
    { id: "s-nobook", role: "student" },
    { id: "a-nobook", role: "school_admin" },
  ];
  const books = [
    { owner_id: "t-book-nogen" },
    { owner_id: "p-book-nogen" },
    { owner_id: "t-book-failed" },
    { owner_id: "t-active" },
    { owner_id: "t-active" },
  ];
  const gens = [
    { owner_id: "t-book-failed", status: "error" },
    { owner_id: "t-active", status: "done" },
    { owner_id: "t-active", status: "error" },
  ];

  it("counts teachers, coordinators and parents with no upload, by role", () => {
    const s = stalledAccounts(people, books, gens);
    expect(s.noBook).toEqual({ total: 3, teachers: 2, parents: 1 });
  });

  it("counts uploaders who never started a generation, and reports the tried-but-nothing-finished beside them", () => {
    const s = stalledAccounts(people, books, gens);
    expect(s.bookNoGeneration).toEqual({ total: 2, teachers: 1, parents: 1, triedNothingFinished: 1 });
  });

  it("ignores students and school admins, and treats a deleted upload as an upload", () => {
    const s = stalledAccounts(
      [{ id: "t", role: "teacher" }, { id: "s", role: "student" }],
      [{ owner_id: "t" }], // the Overview passes every book row, removed ones included
      [],
    );
    expect(s.noBook.total).toBe(0);
    expect(s.bookNoGeneration.total).toBe(1);
  });
});

describe("isCustomerJob — whose failures the Overview counts", () => {
  it("keeps kit and indexing jobs, drops the worker's own lanes", () => {
    for (const type of ["presentation", "worksheet", "lesson_plan", "activity", "case_study", "deck", "exam_paper", "index_book"]) {
      expect(isCustomerJob({ type })).toBe(true);
    }
    for (const type of ["support_diagnose", "issue_resolve", "topic_article", "topic_questions", "topic_publish", "figure_render", "youtube_playlists", "announcement_email"]) {
      expect(isCustomerJob({ type })).toBe(false);
    }
  });

  it("drops catalogue kits by their params flag, and tolerates a null or odd params", () => {
    expect(isCustomerJob({ type: "presentation", params: { catalogue: true } })).toBe(false);
    expect(isCustomerJob({ type: "presentation", params: { catalogue: "true" } })).toBe(true); // only the boolean the worker writes
    expect(isCustomerJob({ type: "presentation", params: null })).toBe(true);
    expect(isCustomerJob({ type: null })).toBe(true); // a legacy row with no type is a customer generation
  });
});

describe("monthlyFailureRate — the Overview's monthly failure chart", () => {
  // 2026-10-08 → six months are May … October 2026, October to date.
  const NOW = new Date("2026-10-08T12:00:00Z");
  const job = (status: string, created_at: string) => ({ status, created_at });

  it("finds the first of the month, in UTC, any number of months back", () => {
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(iso(monthStartUtc(NOW))).toBe("2026-10-01");
    expect(iso(monthStartUtc(NOW, 5))).toBe("2026-05-01");
    expect(iso(monthStartUtc(new Date("2026-01-15T00:00:00Z"), 2))).toBe("2025-11-01"); // crosses the year
  });

  it("returns every month oldest first, with nothing-finished months as null, not 0%", () => {
    const rows = monthlyFailureRate([], 6, NOW);
    expect(rows.map((r) => r.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(rows.every((r) => r.finished === 0 && r.rate === null)).toBe(true);
  });

  it("buckets finished jobs by month and ignores queued, running and out-of-window jobs", () => {
    const rows = monthlyFailureRate(
      [
        job("done", "2026-10-01T00:00:00Z"), // first second of this month
        job("error", "2026-10-07T09:00:00Z"),
        job("done", "2026-10-07T10:00:00Z"),
        job("done", "2026-10-07T11:00:00Z"), // this month → 1/4 = 25%
        job("error", "2026-09-30T23:59:59Z"), // last second of September → 1/1
        job("queued", "2026-10-06T00:00:00Z"), // no outcome yet
        job("processing", "2026-10-06T00:00:00Z"),
        job("done", "2026-04-30T23:59:59Z"), // the month before the window
        job("done", "2026-05-01T00:00:00Z"), // first second of the window
      ],
      6,
      NOW,
    );
    const by = Object.fromEntries(rows.map((r) => [r.month, r]));
    expect(by["2026-10"]).toMatchObject({ finished: 4, failed: 1, rate: 0.25 });
    expect(by["2026-09"]).toMatchObject({ finished: 1, failed: 1, rate: 1 });
    expect(by["2026-05"]).toMatchObject({ finished: 1, failed: 0, rate: 0 });
    expect(rows.reduce((a, r) => a + r.finished, 0)).toBe(6);
  });
});
