/**
 * assignments.status over a fake session client seeded with TWO tenants and
 * the S0 acceptance class: 7B (teacher t1), five learners, one quiz assigned
 * and overdue, 3 done → "3 done / 2 not done" with names (Final Plan §6 S0).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/assignments.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkCapabilityDeps, SkContext } from "../../shell/types";
import { assignmentsStatus } from "../assignments";

type Row = Record<string, unknown>;

class FakeDb {
  /** When true, `.in()` is ignored — the "RLS shows the whole school" shape,
   *  so the handler's own in-memory scoping is what keeps tenants apart. */
  ignoreIn = false;
  constructor(
    public tables: Record<string, Row[]>,
    public errors: Record<string, string> = {},
    public throwing: Set<string> = new Set(),
  ) {}
  from(table: string) {
    if (this.throwing.has(table)) throw new Error(`boom ${table}`);
    return new Query(this, table);
  }
  rpc() {
    return Promise.resolve({ data: null, error: null });
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
    if (!this.db.ignoreIn) this.filters.push((r) => list.includes(r[c]));
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
const NOW = new Date("2026-10-28T04:00:00Z"); // Wed 12:00 KL
const HOUR = 3600000;
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const ctx = (id = T1): SkContext => ({
  user: { id, email: null, role: "teacher", hat: "teacher", schoolId: "school-s", coordinatorScope: [], plan: "school", locale: "en", staff: false },
  place: { path: "/dashboard/analytics", page: "analytics", params: {} },
  selection: {},
  recent: { entities: [], lastToolResults: [] },
  flags: {},
  issuedAt: NOW.toISOString(),
  ttlSeconds: 60,
  contextHash: "h",
});
const deps = (db: FakeDb): SkCapabilityDeps => ({ session: db, now: NOW });
const enrol = (cls: string, id: string, name: string) => ({ class_id: cls, student_id: id, profiles: { full_name: name, username: null } });

function seed(over: Partial<Record<string, Row[]>> = {}) {
  return new FakeDb({
    classes: [
      { id: "7b", name: "7B", teacher_id: T1, created_at: "2026-09-01T00:00:00Z" },
      { id: "7c", name: "7C", teacher_id: T1, created_at: "2026-09-02T00:00:00Z" },
      { id: "8a", name: "8A", teacher_id: T2, created_at: "2026-09-03T00:00:00Z" },
    ],
    enrollments: [
      enrol("7b", "s1", "Aisha"),
      enrol("7b", "s2", "Ben"),
      enrol("7b", "s3", "Chen"),
      enrol("7b", "s4", "Dina"),
      enrol("7b", "s5", "Emir"),
      enrol("7c", "s6", "Farah"),
      enrol("8a", "s7", "Gopal"),
      enrol("8a", "s8", "Hana"),
    ],
    generation_shares: [
      { id: "sh-quiz", generation_id: "quiz", class_id: "7b", due_at: iso(-24 * HOUR), created_at: iso(-72 * HOUR), generations: { kind: "quiz", chapter_ref: "1", title: "Cells quiz" } },
      { id: "sh-ws", generation_id: "ws", class_id: "7c", due_at: iso(+3 * HOUR), created_at: iso(-48 * HOUR), generations: { kind: "worksheet", chapter_ref: "1", title: null } },
      { id: "sh-t2", generation_id: "t2quiz", class_id: "8a", due_at: iso(-24 * HOUR), created_at: iso(-72 * HOUR), generations: { kind: "quiz", chapter_ref: "0", title: "8A quiz" } },
    ],
    student_progress: [
      { generation_id: "quiz", student_id: "s1", status: "completed" },
      { generation_id: "quiz", student_id: "s2", status: "revised" },
      { generation_id: "quiz", student_id: "s4", status: "in_progress" },
      { generation_id: "t2quiz", student_id: "s7", status: "completed" },
    ],
    submissions: [
      { id: "sub1", generation_id: "quiz", student_id: "s3", grade_status: "pending" },
      { id: "sub2", generation_id: "t2quiz", student_id: "s8", grade_status: "pending" },
    ],
    ...over,
  });
}

describe("assignments.status — the acceptance class", () => {
  it("'How many finished the quiz' → 3 done / 2 not done, with names, 1 assignment overdue", async () => {
    const r = await assignmentsStatus.handler(ctx(), { generationId: "quiz" }, deps(seed()));
    expect(r.ok).toBe(true);
    expect(r.facts).toHaveLength(1);
    expect(r.facts![0]).toEqual({
      shareId: "sh-quiz",
      generationId: "quiz",
      classId: "7b",
      title: "Cells quiz",
      kind: "quiz",
      className: "7B",
      assigned: 5,
      done: 3,
      notDone: 2,
      overdue: 2,
      pendingToGrade: 1,
      dueAt: iso(-24 * HOUR),
      completionPct: 60,
      notDoneNames: "Dina, Emir",
    });
    expect(r.summary).toBe("Cells quiz (7B): 3 of 5 done, 2 not done (2 overdue), 1 to grade. Not done: Dina, Emir.");
    const learners = r.entities!.find((e) => e.kind === "learners")!;
    expect(learners).toMatchObject({ id: "not-done:sh-quiz", ids: ["s4", "s5"], via: "assignments.status" });
    expect(r.entities!.find((e) => e.kind === "class")).toMatchObject({ id: "7b", label: "7B" });
    expect(r.entities!.find((e) => e.kind === "share")).toMatchObject({ id: "sh-quiz", ids: ["quiz", "7b"] });
  });

  it("across all own classes: totals in the summary, one row per share, nothing of t2's", async () => {
    const r = await assignmentsStatus.handler(ctx(), {}, deps(seed()));
    expect(r.facts!.map((f) => f.shareId).sort()).toEqual(["sh-quiz", "sh-ws"]); // (the fake ignores order(); the real client sorts newest first)
    expect(r.facts!.map((f) => f.classId)).not.toContain("8a");
    expect(r.facts!.find((f) => f.shareId === "sh-ws")).toMatchObject({ title: "worksheet chapter 2", className: "7C", assigned: 1, done: 0, overdue: 0, notDoneNames: "Farah" });
    expect(r.summary).toBe("2 assignments across 2 classes: 3 of 6 done (50%), 3 not done, 2 overdue, 1 to grade.");
  });

  it("the other teacher sees only theirs", async () => {
    const r = await assignmentsStatus.handler(ctx(T2), {}, deps(seed()));
    expect(r.facts!.map((f) => f.shareId)).toEqual(["sh-t2"]);
    expect(r.facts![0]).toMatchObject({ className: "8A", assigned: 2, done: 2, notDone: 0, pendingToGrade: 1, notDoneNames: "" });
  });

  it("when RLS returns the whole school (filters ignored), the teacher_id scope still holds", async () => {
    const db = seed();
    db.ignoreIn = true;
    const r = await assignmentsStatus.handler(ctx(), {}, deps(db));
    expect(r.facts!.map((f) => f.classId).sort()).toEqual(["7b", "7c"]);
    for (const f of r.facts!) expect(String(f.notDoneNames)).not.toMatch(/Gopal|Hana/);
    // and t2's pending submission is not in t1's to-grade
    expect(r.summary).toMatch(/1 to grade\./);
  });

  it("classId narrows to one own class; someone else's class yields nothing", async () => {
    const own = await assignmentsStatus.handler(ctx(), { classId: "7c" }, deps(seed()));
    expect(own.facts!.map((f) => f.shareId)).toEqual(["sh-ws"]);
    const theirs = await assignmentsStatus.handler(ctx(), { classId: "8a" }, deps(seed()));
    expect(theirs).toMatchObject({ ok: true, facts: [], entities: [] });
    expect(theirs.summary).toMatch(/not one of yours/);
  });

  it("due filters: overdue / today / week", async () => {
    const overdue = await assignmentsStatus.handler(ctx(), { due: "overdue" }, deps(seed()));
    expect(overdue.facts!.map((f) => f.shareId)).toEqual(["sh-quiz"]);
    const today = await assignmentsStatus.handler(ctx(), { due: "today" }, deps(seed()));
    expect(today.facts!.map((f) => f.shareId)).toEqual(["sh-ws"]);
    const week = await assignmentsStatus.handler(ctx(), { due: "week" }, deps(seed()));
    expect(week.facts!.map((f) => f.shareId)).toEqual(["sh-ws"]);
    const bad = await assignmentsStatus.handler(ctx(), { due: "someday" }, deps(seed()));
    expect(bad.facts).toHaveLength(2); // unknown filter = no filter
  });

  it("empty → ok with no facts (no classes; no shares; nothing due)", async () => {
    const noClasses = await assignmentsStatus.handler(ctx("t9"), {}, deps(seed()));
    expect(noClasses).toMatchObject({ ok: true, facts: [], entities: [] });
    const noShares = await assignmentsStatus.handler(ctx(), {}, deps(seed({ generation_shares: [] })));
    expect(noShares).toMatchObject({ ok: true, facts: [] });
    const nothingDue = await assignmentsStatus.handler(ctx(), { due: "today" }, deps(seed({ generation_shares: [] })));
    expect(nothingDue).toMatchObject({ ok: true, facts: [] });
    const unknownGen = await assignmentsStatus.handler(ctx(), { generationId: "nope" }, deps(seed()));
    expect(unknownGen).toMatchObject({ ok: true, facts: [] });
  });

  it("a thrown or failed query → ok:false", async () => {
    const db = seed();
    db.throwing.add("student_progress");
    const t = await assignmentsStatus.handler(ctx(), {}, deps(db));
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/boom student_progress/);
    const failing = new FakeDb(seed().tables, { enrollments: "permission denied" });
    const e = await assignmentsStatus.handler(ctx(), {}, deps(failing));
    expect(e.ok).toBe(false);
    expect(e.error).toMatch(/enrollments: permission denied/);
  });

  it("facts are flat rows and the summary stays under 400 chars", async () => {
    const r = await assignmentsStatus.handler(ctx(), {}, deps(seed()));
    for (const f of r.facts!) for (const v of Object.values(f)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
    expect(r.summary.length).toBeLessThanOrEqual(400);
  });
});
