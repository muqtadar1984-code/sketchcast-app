/**
 * library.find + catalogue.availability over a fake session client seeded with
 * TWO tenants: teacher t1 (school S) and teacher t2 (school S2). Nothing of
 * t2's may reach t1's facts; empty → ok with no facts; a failing query → ok:false.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/library.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkCapabilityDeps, SkContext } from "../../shell/types";
import { catalogueAvailability, grantIsLive, libraryFind } from "../library";

type Row = Record<string, unknown>;

class FakeDb {
  constructor(
    public tables: Record<string, Row[]>,
    public rpcs: Record<string, unknown> = {},
    public errors: Record<string, string> = {},
    public throwing: Set<string> = new Set(),
  ) {}
  from(table: string) {
    if (this.throwing.has(table)) throw new Error(`boom ${table}`);
    return new Query(this, table);
  }
  rpc(fn: string) {
    if (this.throwing.has(fn)) return Promise.reject(new Error(`boom ${fn}`));
    if (this.errors[fn]) return Promise.resolve({ data: null, error: { message: this.errors[fn] } });
    return Promise.resolve({ data: this.rpcs[fn] ?? null, error: null });
  }
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private single = false;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (v === null ? r[c] == null : r[c] === v));
    return this;
  }
  in(c: string, list: unknown[]) {
    this.filters.push((r) => list.includes(r[c]));
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: { message: string } | null }) => A) | null, no?: ((e: unknown) => B) | null) {
    const err = this.db.errors[this.table];
    const rows = (this.db.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    const res = err ? { data: null, error: { message: err } } : { data: this.single ? (rows[0] ?? null) : rows, error: null };
    return Promise.resolve(res).then(ok, no);
  }
}

const T1 = "t1";
const T2 = "t2";
const S = "school-s";
const S2 = "school-s2";
const NOW = new Date("2026-10-28T04:00:00Z");

const ctx = (id = T1, schoolId: string | null = S): SkContext => ({
  user: { id, email: null, role: "teacher", hat: "teacher", schoolId, coordinatorScope: [], plan: "school", locale: "en", staff: false },
  place: { path: "/dashboard", page: "library", params: {} },
  selection: {},
  recent: { entities: [], lastToolResults: [] },
  flags: {},
  issuedAt: NOW.toISOString(),
  ttlSeconds: 60,
  contextHash: "h",
});
const deps = (db: FakeDb): SkCapabilityDeps => ({ session: db, now: NOW });

function seed(over: { tables?: Record<string, Row[]>; rpcs?: Record<string, unknown>; errors?: Record<string, string>; throwing?: string[] } = {}) {
  const tables: Record<string, Row[]> = {
    books: [
      { id: "b1", owner_id: T1, school_id: S, title: "Cambridge Biology", author: "Jones", subject: "Biology", grade: "Form 1", status: "ready", chapters: [{ num: 0, title: "Cells" }, { num: 1, title: "Specialised cells and tissues" }] },
      { id: "b2", owner_id: T2, school_id: S, title: "Chemistry Matters", author: null, subject: "Chemistry", grade: "Form 2", status: "ready", chapters: [{ num: 0, title: "Atoms" }] },
      // t2's own book in ANOTHER school, with the very words t1 asks for.
      { id: "b3", owner_id: T2, school_id: S2, title: "Specialised cells", author: null, subject: "Biology", grade: "Form 1", status: "ready", chapters: [] },
    ],
    generations: [
      { id: "g1", owner_id: T1, title: "Quiz: Specialised cells", status: "done", kind: "quiz", chapter_ref: "1", book_id: "b1", created_at: "2026-10-20T00:00:00Z", withdrawn_at: null },
      { id: "g2", owner_id: T1, title: null, status: "done", kind: "worksheet", chapter_ref: "1", book_id: "b1", created_at: "2026-10-19T00:00:00Z", withdrawn_at: null },
      { id: "g3", owner_id: T1, title: "Specialised cells (old)", status: "done", kind: "presentation", chapter_ref: "1", book_id: "b1", created_at: "2026-09-01T00:00:00Z", withdrawn_at: "2026-10-01T00:00:00Z" },
      { id: "g4", owner_id: T2, title: "Specialised cells", status: "done", kind: "quiz", chapter_ref: "0", book_id: "b3", created_at: "2026-10-21T00:00:00Z", withdrawn_at: null },
    ],
    catalogue_unlocks: [{ user_id: T2, topic_id: "topic-sc", unlocked_at: "2026-10-01T00:00:00Z" }],
    sk_book_products: [
      { id: "p1", slug: "cambridge-ls-biology", title: "Cambridge Lower Secondary Biology Study Guide", subject: "Biology", status: "approved" },
      { id: "p2", slug: "draft-physics", title: "Physics Study Guide", subject: "Physics", status: "draft" },
    ],
    book_access_grants: [
      { user_id: T1, product_id: "p1", activated_at: "2026-10-01T00:00:00Z", expires_at: null, revoked_at: null },
      { user_id: T2, product_id: "p1", activated_at: "2026-10-01T00:00:00Z", expires_at: null, revoked_at: null },
    ],
    ...over.tables,
  };
  const rpcs = {
    public_catalogue: [
      { slug: "specialised-cells", title: "Specialised Cells", subject: "Biology", language: "en" },
      { slug: "specialised-cells", title: "Sel Khusus", subject: "Biologi", language: "ms" },
      { slug: "osmosis", title: "Osmosis", subject: "Biology", language: "en" },
    ],
    my_catalogue_allowance: { eligible: true, reason: null, tier: "school", cap: 4, used: 2, resets_at: "2026-11-02T00:00:00Z" },
    ...over.rpcs,
  };
  return new FakeDb(tables, rpcs, over.errors, new Set(over.throwing ?? []));
}

describe("library.find", () => {
  it("finds own kits, own books and the school shelf — never the other tenant's", async () => {
    const r = await libraryFind.handler(ctx(), { query: "specialised cells" }, deps(seed()));
    expect(r.ok).toBe(true);
    const ids = r.facts!.map((f) => f.id);
    expect(ids).toContain("g1"); // own kit by title
    expect(ids).toContain("g2"); // own untitled kit, matched through its chapter
    expect(ids).toContain("b1"); // own book, matched through a chapter title
    expect(ids).not.toContain("g3"); // withdrawn
    expect(ids).not.toContain("g4"); // t2's kit
    expect(ids).not.toContain("b3"); // t2's book in another school
    const kit = r.facts!.find((f) => f.id === "g1")!;
    // 2026-10-30: a book kit names its chapter as the app shows it (chapter_ref "1" → chapter 2).
    expect(kit).toEqual({ kind: "kit", id: "g1", title: "Quiz: Specialised cells", where: "my_library", status: "done", subject: "Biology", grade: "Form 1", chapter: 2 });
    expect(r.facts!.find((f) => f.id === "g2")!.title).toBe("worksheet: Specialised cells and tissues");
    expect(r.summary).toMatch(/^3 matches for 'specialised cells': 3 in your library \(2 kits, 1 books\), 0 on the school shelf/);
    expect(r.entities!.map((e) => e.kind)).toEqual(expect.arrayContaining(["generation", "book"]));
  });

  it("puts a colleague's book in the same school on the shelf, and keeps it off without a school", async () => {
    const withSchool = await libraryFind.handler(ctx(), { query: "chemistry" }, deps(seed()));
    expect(withSchool.facts).toEqual([{ kind: "book", id: "b2", title: "Chemistry Matters", where: "school_shelf", status: "ready", subject: "Chemistry", grade: "Form 2" }]);
    const noSchool = await libraryFind.handler(ctx(T1, null), { query: "chemistry" }, deps(seed()));
    expect(noSchool.ok).toBe(true);
    expect(noSchool.facts).toEqual([]);
  });

  it("facts never contain rows outside the teacher's own library or school shelf", async () => {
    const r = await libraryFind.handler(ctx(), { query: "cells" }, deps(seed()));
    for (const f of r.facts!) expect(["g1", "g2", "b1"]).toContain(f.id);
    // And the other tenant, asking the same, sees only theirs.
    const other = await libraryFind.handler(ctx(T2, S2), { query: "cells" }, deps(seed()));
    expect(other.facts!.map((f) => f.id).sort()).toEqual(["b3", "g4"]);
  });

  it("empty → ok with no facts; a missing query is an error", async () => {
    const r = await libraryFind.handler(ctx(), { query: "trigonometry" }, deps(seed()));
    expect(r).toMatchObject({ ok: true, facts: [], entities: [] });
    expect(r.summary).toBe("Nothing in your library or on the school shelf matches 'trigonometry'.");
    expect((await libraryFind.handler(ctx(), {}, deps(seed()))).ok).toBe(false);
  });

  it("a thrown or failed query → ok:false with the error, never a throw", async () => {
    const thrown = await libraryFind.handler(ctx(), { query: "cells" }, deps(seed({ throwing: ["generations"] })));
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toMatch(/boom generations/);
    const failed = await libraryFind.handler(ctx(), { query: "cells" }, deps(seed({ errors: { books: "permission denied" } })));
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/books: permission denied/);
  });

  it("caps at 12 rows", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `k${i}`, owner_id: T1, title: `Cells ${i}`, status: "done", kind: "quiz", chapter_ref: null, book_id: null, created_at: "2026-10-01T00:00:00Z", withdrawn_at: null }));
    const r = await libraryFind.handler(ctx(), { query: "cells" }, deps(seed({ tables: { generations: many, books: [] } })));
    expect(r.facts).toHaveLength(12);
  });
});

describe("catalogue.availability", () => {
  it("own library first: a matching own kit outranks the catalogue and the SK book", async () => {
    const r = await catalogueAvailability.handler(ctx(), { topic: "specialised cells" }, deps(seed()));
    expect(r.ok).toBe(true);
    expect(r.facts![0]).toMatchObject({ state: "in_library", kind: "kit", id: "g1" });
    expect(r.summary).toMatch(/^Yes — 'Quiz: Specialised cells' is in your library \(a kit\)/);
    const states = r.facts!.map((f) => f.state);
    // ranks never decrease down the list
    const ranks = r.facts!.map((f) => f.rank as number);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(states).toContain("in_catalogue_locked"); // t1 has no unlock rows → every kit is locked for them
    // The Malay row ("Sel Khusus") does not match English words — matching is textual, not by slug.
    expect(r.facts!.filter((f) => f.kind === "catalogue_kit").map((f) => f.language)).toEqual(["en"]);
  });

  it("no unlock rows → in_catalogue_locked with the allowance; some unlock rows → in_catalogue (unknown)", async () => {
    const locked = await catalogueAvailability.handler(ctx(), { topic: "osmosis" }, deps(seed()));
    expect(locked.facts![0]).toMatchObject({ state: "in_catalogue_locked", kind: "catalogue_kit", id: "osmosis", unlockEligible: true, unlockUsed: 2, unlockCap: 4 });
    expect(locked.summary).toBe("There is a kit 'Osmosis' but it is locked. 2 of 4 unlocks used this week.");
    expect(locked.entities).toEqual([{ kind: "topic", id: "osmosis", label: "Osmosis", via: "catalogue.availability" }]);

    const db = seed({ tables: { catalogue_unlocks: [{ user_id: T1, topic_id: "topic-x", unlocked_at: "2026-10-20T00:00:00Z" }] } });
    const unknown = await catalogueAvailability.handler(ctx(), { topic: "osmosis" }, deps(db));
    expect(unknown.facts![0]).toMatchObject({ state: "in_catalogue", unlockUsed: 2 });
    expect(unknown.summary).toMatch(/whether you have unlocked it is not visible from here/);
  });

  it("the other tenant's unlock rows do not count for this teacher", async () => {
    // t2 holds an unlock; t1 (no rows) is still 'locked' everywhere.
    const r = await catalogueAvailability.handler(ctx(), { topic: "osmosis" }, deps(seed()));
    expect(r.facts![0].state).toBe("in_catalogue_locked");
  });

  it("an SK study guide: activated for the grant holder, not for a teacher without a live grant; drafts never show", async () => {
    const mine = await catalogueAvailability.handler(ctx(), { topic: "biology study guide" }, deps(seed()));
    const book = mine.facts!.find((f) => f.kind === "sk_book")!;
    expect(book).toMatchObject({ state: "sk_book_activated", id: "p1", title: "Cambridge Lower Secondary Biology Study Guide" });

    const t3 = await catalogueAvailability.handler(ctx("t3", S), { topic: "biology study guide" }, deps(seed()));
    expect(t3.facts!.find((f) => f.kind === "sk_book")).toMatchObject({ state: "sk_book_not_activated" });
    expect(t3.summary).toBe("The SK book 'Cambridge Lower Secondary Biology Study Guide' exists but is not activated for you.");

    const physics = await catalogueAvailability.handler(ctx(), { topic: "physics study guide" }, deps(seed()));
    expect(physics.facts).toEqual([]);
  });

  it("a revoked or expired grant is not live", () => {
    expect(grantIsLive({ product_id: "p", activated_at: "2026-10-01T00:00:00Z", expires_at: null, revoked_at: null }, NOW)).toBe(true);
    expect(grantIsLive({ product_id: "p", activated_at: "2026-10-01T00:00:00Z", expires_at: null, revoked_at: "2026-10-10T00:00:00Z" }, NOW)).toBe(false);
    expect(grantIsLive({ product_id: "p", activated_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-20T00:00:00Z", revoked_at: null }, NOW)).toBe(false);
    expect(grantIsLive({ product_id: "p", activated_at: "2026-11-01T00:00:00Z", expires_at: null, revoked_at: null }, NOW)).toBe(false);
  });

  it("nothing anywhere → ok, no facts, an honest 'No'", async () => {
    const r = await catalogueAvailability.handler(ctx(), { topic: "trigonometry" }, deps(seed()));
    expect(r).toMatchObject({ ok: true, facts: [], entities: [] });
    expect(r.summary).toMatch(/^No — nothing matches 'trigonometry'/);
  });

  it("a failing RPC or a thrown table → ok:false", async () => {
    const rpcFail = await catalogueAvailability.handler(ctx(), { topic: "osmosis" }, deps(seed({ errors: { public_catalogue: "function not found" } })));
    expect(rpcFail.ok).toBe(false);
    expect(rpcFail.error).toMatch(/public_catalogue: function not found/);
    const thrown = await catalogueAvailability.handler(ctx(), { topic: "osmosis" }, deps(seed({ throwing: ["sk_book_products"] })));
    expect(thrown.ok).toBe(false);
    // A failed allowance RPC does not fail the answer — the lock state stands without the numbers.
    const noAllowance = await catalogueAvailability.handler(ctx(), { topic: "osmosis" }, deps(seed({ errors: { my_catalogue_allowance: "nope" } })));
    expect(noAllowance.ok).toBe(true);
    expect(noAllowance.summary).toBe("There is a kit 'Osmosis' but it is locked.");
  });

  it("facts are flat rows", async () => {
    const r = await catalogueAvailability.handler(ctx(), { topic: "specialised cells" }, deps(seed()));
    for (const f of r.facts!) for (const v of Object.values(f)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
  });
});
