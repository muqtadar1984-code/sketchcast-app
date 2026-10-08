import { describe, it, expect } from "vitest";
import { countryName, sharedBooks, stalledAccounts, topCountries, topTeachersByKits } from "../console-insights";

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
