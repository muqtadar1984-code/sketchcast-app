/**
 * learners.risk — school-health's at-risk rule, scoped to the teacher's own
 * classes, over a fake session client seeded with TWO tenants. The S0
 * acceptance class: 7B, five learners, quiz assigned, 3 done, one learner
 * at risk by the rule ("never started").
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/risk.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkCapabilityDeps, SkContext } from "../../shell/types";
import type { HealthRows } from "@/utils/school-health";
import { learnersRisk, scopeHealthRows } from "../risk";

type Row = Record<string, unknown>;

class FakeDb {
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
const NOW = new Date("2026-10-28T04:00:00Z");
const DAY = 86400000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const ctx = (id = T1, role: SkContext["user"]["role"] = "teacher"): SkContext => ({
  user: { id, email: null, role, hat: "teacher", schoolId: "school-s", coordinatorScope: [], plan: "school", locale: "en", staff: false },
  place: { path: "/dashboard/analytics", page: "analytics", params: {} },
  selection: {},
  recent: { entities: [], lastToolResults: [] },
  flags: {},
  issuedAt: NOW.toISOString(),
  ttlSeconds: 60,
  contextHash: "h",
});
const deps = (db: FakeDb): SkCapabilityDeps => ({ session: db, now: NOW });
const enrol = (cls: string, id: string, name: string) => ({ class_id: cls, student_id: id, profiles: { full_name: name, username: null, parent_email: null } });

/** What a school_admin's RLS would return: BOTH teachers' classes. */
function seed(over: Partial<Record<string, Row[]>> = {}) {
  return new FakeDb({
    classes: [
      { id: "7b", name: "7B", grade: "Form 1", teacher_id: T1 },
      { id: "8a", name: "8A", grade: "Form 2", teacher_id: T2 },
    ],
    enrollments: [
      enrol("7b", "s1", "Aisha"),
      enrol("7b", "s2", "Ben"),
      enrol("7b", "s3", "Chen"),
      enrol("7b", "s4", "Dina"),
      enrol("7b", "s5", "Emir"),
      enrol("8a", "s7", "Gopal"),
      enrol("8a", "s8", "Hana"),
      // Emir's twin in name, in t2's class, also never started — must not leak into t1's answer.
      enrol("8a", "s9", "Emir"),
    ],
    generation_shares: [
      { generation_id: "quiz", class_id: "7b", shared_by: T1, due_at: ago(1) },
      { generation_id: "t2a", class_id: "8a", shared_by: T2, due_at: ago(3) },
      { generation_id: "t2b", class_id: "8a", shared_by: T2, due_at: ago(2) },
    ],
    student_progress: [
      { generation_id: "quiz", student_id: "s1", status: "completed", updated_at: ago(2) },
      { generation_id: "quiz", student_id: "s2", status: "revised", updated_at: ago(1) },
      { generation_id: "quiz", student_id: "s4", status: "in_progress", updated_at: ago(2) }, // active, so not flagged on one item
      { generation_id: "t2a", student_id: "s7", status: "completed", updated_at: ago(1) },
    ],
    submissions: [
      { generation_id: "quiz", student_id: "s3", auto_score: 4, max_score: 5, teacher_score: null, submitted_at: ago(1), graded_at: null, grade_status: "pending" },
    ],
    generations: [
      { id: "quiz", owner_id: T1 },
      { id: "t2a", owner_id: T2 },
      { id: "t2b", owner_id: T2 },
    ],
    profiles: [
      { id: T1, full_name: "Nurul Hassan", username: null },
      { id: T2, full_name: "Ravi Kumar", username: null },
    ],
    ...over,
  });
}

describe("learners.risk — the acceptance class", () => {
  it("names the one at-risk learner with the school-health reason text", async () => {
    const r = await learnersRisk.handler(ctx(), {}, deps(seed()));
    expect(r.ok).toBe(true);
    expect(r.facts).toEqual([{ name: "Emir", className: "7B", grade: "Form 1", reasons: "never started" }]);
    expect(r.summary).toBe("1 at risk in 1 class: Emir (7B) — never started.");
    expect(r.entities).toEqual([
      { kind: "class", id: "7b", label: "7B", via: "learners.risk" },
      { kind: "learners", id: `at-risk:${T1}`, label: "At risk — 1 class", via: "learners.risk", ids: ["s5"] },
    ]);
  });

  it("never names a learner from the other teacher's classes, even when RLS returned them", async () => {
    const r = await learnersRisk.handler(ctx(), {}, deps(seed()));
    // t2's 8A has Hana (never started, 2 overdue) and a second "Emir" — neither appears.
    expect(r.facts!.map((f) => f.className)).toEqual(["7B"]);
    const learners = r.entities!.find((e) => e.kind === "learners")!;
    expect(learners.ids).toEqual(["s5"]); // not s9, the 8A Emir
    const t2 = await learnersRisk.handler(ctx(T2), {}, deps(seed()));
    expect(t2.facts!.map((f) => `${f.name}@${f.className}`).sort()).toEqual(["Emir@8A", "Hana@8A"]);
    expect(t2.facts!.find((f) => f.name === "Hana")!.reasons).toBe("0% completion, never started, 2 overdue");
  });

  it("a school_admin wearing the teacher hat is scoped to THEIR classes too", async () => {
    const r = await learnersRisk.handler(ctx(T1, "school_admin"), {}, deps(seed()));
    expect(r.facts!.map((f) => f.className)).toEqual(["7B"]);
  });

  it("a learner in both teachers' classes is judged on this teacher's shares only", async () => {
    const db = seed({
      enrollments: [...seed().tables.enrollments, enrol("8a", "s1", "Aisha")], // Aisha also in 8A, never started t2's two overdue items
    });
    const r = await learnersRisk.handler(ctx(), {}, deps(db));
    expect(r.facts!.map((f) => f.name)).toEqual(["Emir"]); // Aisha completed t1's quiz → clean for t1
    const t2 = await learnersRisk.handler(ctx(T2), {}, deps(db));
    expect(t2.facts!.map((f) => f.name)).toContain("Aisha"); // but flagged for t2
  });

  it("classId narrows to one own class; another teacher's class yields nothing", async () => {
    const own = await learnersRisk.handler(ctx(), { classId: "7b" }, deps(seed()));
    expect(own.facts).toHaveLength(1);
    expect(own.summary).toBe("1 at risk in 7B: Emir — never started.");
    const theirs = await learnersRisk.handler(ctx(), { classId: "8a" }, deps(seed()));
    expect(theirs).toMatchObject({ ok: true, facts: [], entities: [] });
  });

  it("nobody at risk → ok, no facts, says so with the learner count", async () => {
    const db = seed({ student_progress: [...seed().tables.student_progress, { generation_id: "quiz", student_id: "s5", status: "completed", updated_at: ago(1) }] });
    const r = await learnersRisk.handler(ctx(), {}, deps(db));
    expect(r).toMatchObject({ ok: true, facts: [] });
    expect(r.summary).toBe("Nobody is at risk in 1 class by the school-health rules (5 learners).");
    expect(r.entities).toEqual([{ kind: "class", id: "7b", label: "7B", via: "learners.risk" }]);
  });

  it("no classes → ok with no facts; a thrown or failed query → ok:false", async () => {
    expect(await learnersRisk.handler(ctx("t9"), {}, deps(seed()))).toMatchObject({ ok: true, facts: [], entities: [] });
    const db = seed();
    db.throwing.add("submissions");
    const thrown = await learnersRisk.handler(ctx(), {}, deps(db));
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toMatch(/boom submissions/);
  });

  it("caps at 30 rows and keeps the facts flat", async () => {
    const many = Array.from({ length: 40 }, (_, i) => enrol("7b", `x${i}`, `Learner ${i}`));
    const r = await learnersRisk.handler(ctx(), {}, deps(seed({ enrollments: many, student_progress: [], submissions: [] })));
    expect(r.facts).toHaveLength(30);
    for (const f of r.facts!) for (const v of Object.values(f)) expect(typeof v === "string").toBe(true);
    expect(r.summary.length).toBeLessThanOrEqual(400);
  });
});

describe("scopeHealthRows", () => {
  it("keeps only the teacher's classes and the rows that hang off them", () => {
    const rows: HealthRows = {
      classes: [
        { id: "7b", name: "7B", grade: "1", teacher_id: T1 },
        { id: "8a", name: "8A", grade: "2", teacher_id: T2 },
      ],
      enrollments: [
        { class_id: "7b", student_id: "s1", full_name: "A", username: null, parent_email: null },
        { class_id: "8a", student_id: "s1", full_name: "A", username: null, parent_email: null },
        { class_id: "8a", student_id: "s7", full_name: "G", username: null, parent_email: null },
      ],
      shares: [
        { generation_id: "g1", class_id: "7b", shared_by: T1, due_at: null },
        { generation_id: "g2", class_id: "8a", shared_by: T2, due_at: null },
        { generation_id: "g3", class_id: null, shared_by: T1, due_at: null },
      ],
      progress: [
        { generation_id: "g1", student_id: "s1", status: "completed", updated_at: ago(1) },
        { generation_id: "g2", student_id: "s1", status: "completed", updated_at: ago(1) },
      ],
      submissions: [{ generation_id: "g2", student_id: "s7", auto_score: 1, max_score: 2, teacher_score: null, submitted_at: ago(1), graded_at: null, grade_status: "auto" }],
      generations: [
        { id: "g1", owner_id: T1 },
        { id: "g2", owner_id: T2 },
      ],
      teacherNames: { [T1]: "N", [T2]: "R" },
    };
    const s = scopeHealthRows(rows, T1);
    expect(s.classes.map((c) => c.id)).toEqual(["7b"]);
    expect(s.enrollments).toHaveLength(1);
    expect(s.shares.map((x) => x.generation_id)).toEqual(["g1"]);
    expect(s.progress.map((p) => p.generation_id)).toEqual(["g1"]);
    expect(s.submissions).toEqual([]);
    expect(s.generations.map((g) => g.id)).toEqual(["g1"]);
    expect(scopeHealthRows(rows, T1, "8a").classes).toEqual([]);
  });
});
