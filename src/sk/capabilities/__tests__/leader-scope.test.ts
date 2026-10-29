/**
 * S5 slice A — leaderScope (THE mode decision), the grade / subject matching,
 * the row cut and the email boundary. Pure.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/leader-scope.test.ts
 */
import { describe, expect, it } from "vitest";
import type { HealthRows } from "@/utils/school-health";
import { cutLeaderRows, leaderScope, needsSubjects, sameGrade, sameSubject, scopeLabel, scopeRowsOf, shareInScope, stripEmails, whereLabel } from "../leader-scope";
import { ctxFor } from "./leader-fixtures";

const S5 = [{ grade: "5", subject: null }];

describe("leaderScope — one pure decision", () => {
  const cases: Array<[string, Parameters<typeof ctxFor>[0], "own" | "school" | "scope"]> = [
    ["teacher hat (plain teacher)", { id: "t", role: "teacher", hat: "teacher", schoolId: "s" }, "own"],
    ["teacher hat (a coordinator)", { id: "t", role: "teacher", hat: "teacher", schoolId: "s", scope: S5 }, "own"],
    ["teacher hat (a principal)", { id: "p", role: "school_admin", hat: "teacher", schoolId: "s" }, "own"],
    ["hats off (null) — the S0 reads stay own", { id: "p", role: "school_admin", hat: null, schoolId: "s" }, "own"],
    ["principal hat + school_admin", { id: "p", role: "school_admin", hat: "principal", schoolId: "s" }, "school"],
    ["principal hat without a school", { id: "p", role: "school_admin", hat: "principal", schoolId: null }, "own"],
    ["principal hat on a teacher role (never widened)", { id: "t", role: "teacher", hat: "principal", schoolId: "s" }, "own"],
    ["coordinator hat", { id: "c", role: "teacher", hat: "coordinator", schoolId: "s", scope: S5 }, "scope"],
    ["coordinator hat on a school_admin (scope, not school)", { id: "p", role: "school_admin", hat: "coordinator", schoolId: "s", scope: S5 }, "scope"],
    ["parent hat", { id: "x", role: "parent", hat: "parent", schoolId: "s" }, "own"],
    ["student", { id: "x", role: "student", hat: null, schoolId: "s", scope: S5 }, "own"],
  ];
  for (const [label, o, mode] of cases) it(`${label} → ${mode}`, () => expect(leaderScope(ctxFor(o)).mode).toBe(mode));

  it("the scope mode carries grades, subjects and the rows; a coordinator hat with no rows matches nothing", () => {
    const ls = leaderScope(ctxFor({ id: "c", role: "teacher", hat: "coordinator", schoolId: "s", scope: [{ grade: " 5 ", subject: null }, { grade: "6", subject: "Science" }, { grade: "5", subject: null }] }));
    expect(ls).toEqual({ mode: "scope", schoolId: "s", rows: [{ grade: "5", subject: null }, { grade: "6", subject: "Science" }], grades: ["5", "6"], subjects: ["Science"] });
    expect(needsSubjects(ls)).toBe(true);
    const empty = leaderScope(ctxFor({ id: "c", role: "teacher", hat: "coordinator", schoolId: "s", scope: [] }));
    expect(empty).toMatchObject({ mode: "scope", rows: [] });
  });

  it("hatless: \"leader\" (school.health only) answers a school_admin at school level and a scope holder at scope level", () => {
    expect(leaderScope(ctxFor({ id: "p", role: "school_admin", hat: null, schoolId: "s" }), { hatless: "leader" }).mode).toBe("school");
    expect(leaderScope(ctxFor({ id: "c", role: "teacher", hat: null, schoolId: "s", scope: S5 }), { hatless: "leader" }).mode).toBe("scope");
    expect(leaderScope(ctxFor({ id: "t", role: "teacher", hat: null, schoolId: "s" }), { hatless: "leader" }).mode).toBe("own");
    // A hat that is ON still decides.
    expect(leaderScope(ctxFor({ id: "p", role: "school_admin", hat: "teacher", schoolId: "s" }), { hatless: "leader" }).mode).toBe("own");
  });

  it("scopeRowsOf drops blank grades and collapses duplicates (case and spaces)", () => {
    expect(scopeRowsOf([{ grade: "", subject: null }, { grade: null, subject: "x" }, { grade: "Form 1", subject: "Sains" }, { grade: "form  1", subject: "sains" }])).toEqual([{ grade: "Form 1", subject: "Sains" }]);
  });
});

describe("grade and subject matching (school-books' rules; only ever narrows)", () => {
  it("grades: '5' = 'Grade 5' = 'Year 5' = 'tahun 5'; Form/Tingkatan; Form 5 is not 5", () => {
    expect(sameGrade("5", "Grade 5")).toBe(true);
    expect(sameGrade("Year 5", "5")).toBe(true);
    expect(sameGrade("Tahun 5", "grade 5")).toBe(true);
    expect(sameGrade("Form 1", "Tingkatan 1")).toBe(true);
    expect(sameGrade("Form 5", "5")).toBe(false);
    expect(sameGrade("6", "5")).toBe(false);
    expect(sameGrade("5A", "5")).toBe(true); // a level is a level
    expect(sameGrade(null, "5")).toBe(false);
    expect(sameGrade("Primary", "primary")).toBe(true); // exact text, no level
    expect(sameGrade("Primary", "5")).toBe(false);
  });
  it("subjects: case-insensitive, Malay/English synonyms, a missing book subject never matches", () => {
    expect(sameSubject("science", "Science")).toBe(true);
    expect(sameSubject("Sains", "Science")).toBe(true);
    expect(sameSubject("Mathematics", "Science")).toBe(false);
    expect(sameSubject("Additional Mathematics", "Mathematics")).toBe(false);
    expect(sameSubject(null, "Science")).toBe(false);
  });
  it("a share is in scope by ITS row: grade 5 (all subjects) + grade 6 (Science only)", () => {
    const rows = [{ grade: "5", subject: null }, { grade: "6", subject: "Science" }];
    expect(shareInScope("5", "Mathematics", rows)).toBe(true);
    expect(shareInScope("6", "Science", rows)).toBe(true);
    expect(shareInScope("6", "Mathematics", rows)).toBe(false);
    expect(shareInScope("4", "Science", rows)).toBe(false);
  });
});

const rows = (): HealthRows => ({
  classes: [
    { id: "a5", name: "5A", grade: "5", teacher_id: "t1", school_id: "s" },
    { id: "a6", name: "6A", grade: "6", teacher_id: "coord", school_id: "s" },
    { id: "b5", name: "5B other school", grade: "5", teacher_id: "t9", school_id: "other" },
  ],
  enrollments: [
    { class_id: "a5", student_id: "l1", full_name: "Lina", username: null, parent_email: "p1@x.example" },
    { class_id: "a6", student_id: "l2", full_name: "Lim", username: null, parent_email: "p2@x.example" },
    { class_id: "b5", student_id: "l3", full_name: "Luqman", username: null, parent_email: null },
  ],
  shares: [
    { generation_id: "g5", class_id: "a5", shared_by: "t1", due_at: null },
    { generation_id: "g6", class_id: "a6", shared_by: "coord", due_at: null },
    { generation_id: "gb", class_id: "b5", shared_by: "t9", due_at: null },
    { generation_id: "gd", class_id: null, student_id: "l1", shared_by: "t1", due_at: null },
  ],
  progress: [
    { generation_id: "g5", student_id: "l1", status: "completed", updated_at: "2026-10-01T00:00:00Z" },
    { generation_id: "g6", student_id: "l1", status: "completed", updated_at: "2026-10-01T00:00:00Z" },
    { generation_id: "g6", student_id: "l2", status: "completed", updated_at: "2026-10-01T00:00:00Z" },
  ],
  submissions: [],
  generations: [
    { id: "g5", owner_id: "t1" },
    { id: "g6", owner_id: "coord" },
    { id: "gb", owner_id: "t9" },
    { id: "gx", owner_id: "t1" },
  ],
  teacherNames: { t1: "T One", coord: "Coord", t9: "Other" },
});

describe("cutLeaderRows", () => {
  it("scope: the grade-5 class, its learners, its shares — progress only on in-scope generations; no emails", () => {
    const ls = leaderScope(ctxFor({ id: "coord", role: "teacher", hat: "coordinator", schoolId: "s", scope: S5 }));
    const r = cutLeaderRows(rows(), ls);
    expect(r.classes.map((c) => c.id)).toEqual(["a5"]);
    expect(r.enrollments.map((e) => e.student_id)).toEqual(["l1"]);
    expect(r.enrollments.every((e) => e.parent_email === null)).toBe(true);
    expect(r.shares.map((s) => s.generation_id)).toEqual(["g5"]);
    expect(r.progress.map((p) => p.generation_id)).toEqual(["g5"]); // l1's g6 row is grade 6's business
    expect(r.generations.map((g) => g.id)).toEqual(["g5"]);
    expect(Object.keys(r.teacherNames)).toEqual(["t1"]);
  });
  it("school: every class of the user's school, none of another; generations of its shares and teachers", () => {
    const ls = leaderScope(ctxFor({ id: "p", role: "school_admin", hat: "principal", schoolId: "s" }));
    const r = cutLeaderRows(rows(), ls);
    expect(r.classes.map((c) => c.id)).toEqual(["a5", "a6"]);
    expect(r.enrollments.map((e) => e.student_id)).toEqual(["l1", "l2"]);
    expect(r.generations.map((g) => g.id).sort()).toEqual(["g5", "g6", "gx"]);
    expect(Object.keys(r.teacherNames).sort()).toEqual(["coord", "t1"]);
  });
  it("grade and classId narrow further; a subject scope needs the generation's subject", () => {
    const school = leaderScope(ctxFor({ id: "p", role: "school_admin", hat: "principal", schoolId: "s" }));
    expect(cutLeaderRows(rows(), school, { grade: "Grade 6" }).classes.map((c) => c.id)).toEqual(["a6"]);
    expect(cutLeaderRows(rows(), school, { classId: "b5" }).classes).toEqual([]);
    const sci = leaderScope(ctxFor({ id: "c", role: "teacher", hat: "coordinator", schoolId: "s", scope: [{ grade: "5", subject: "Science" }] }));
    expect(cutLeaderRows(rows(), sci).shares).toEqual([]); // no subject known → nothing
    expect(cutLeaderRows(rows(), sci, { subjectOf: new Map([["g5", "Sains"]]) }).shares.map((s) => s.generation_id)).toEqual(["g5"]);
  });
  it("own mode is not this function's", () => {
    expect(() => cutLeaderRows(rows(), { mode: "own", schoolId: "s" })).toThrow();
  });
});

describe("labels", () => {
  it("scope and where, localised", () => {
    expect(scopeLabel([{ grade: "5", subject: null }, { grade: "Form 2", subject: "Science" }], "en")).toBe("grade 5, Form 2 (Science)");
    expect(scopeLabel([{ grade: "5", subject: null }], "ms")).toBe("tahun 5");
    expect(whereLabel({ mode: "school", schoolId: "s" }, "ar")).toBe("المدرسة");
    expect(whereLabel({ mode: "school", schoolId: "s" }, "en", "grade 5")).toBe("grade 5");
  });
});

describe("stripEmails — the capability boundary", () => {
  it("drops email keys, removes addresses from values, summary and entity labels", () => {
    const r = stripEmails({
      ok: true,
      summary: "Ask a@b.example (or nobody).",
      facts: [{ name: "kid@mail.example", parentEmail: "p@x.example", parent_email: "q@x.example", email: "z@x.example", n: 3 }],
      entities: [{ kind: "learner", id: "1", label: "Lina <l@x.example>", via: "x" }],
    });
    expect(JSON.stringify(r)).not.toMatch(/@/);
    expect(r.facts).toEqual([{ name: "—", n: 3 }]);
    expect(r.summary).toBe("Ask (or nobody).");
  });
});
