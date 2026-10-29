/**
 * S5 slice A — the coordinator-isolation proof at the app layer (design
 * acceptance 2) and the principal's school boundary.
 *
 * The union leak: a grade-5 coordinator also TEACHES a grade-6 class, so RLS
 * returns that class (and its learners, shares, scores, the coordinator's
 * own teacher row) next to their grade-5 scope. With the coordinator hat,
 * school.health / learners.risk / assignments.status / timetable.now_next
 * must show none of it — both over the real RLS union and over a view that
 * hands them EVERYTHING (both schools), so the cut is proven on its own. With
 * the teacher hat they see their own grade-6 class and nothing school-wide.
 * A principal sees all of their school and nothing of another school.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/school-isolation.test.ts
 */
import { describe, expect, it } from "vitest";
import { schoolHealth } from "../school";
import { learnersRisk } from "../risk";
import { assignmentsStatus } from "../assignments";
import { timetableNowNext } from "../timetable";
import { metaAllows } from "@/sk/shell/registry";
import type { SkCapability } from "@/sk/shell/types";
import { allRows, coordinatorCtx, coordinatorRlsRows, depsFor, FakeDb, GRADE4, GRADE5_A, GRADE6, principalCtx, PB, SCH_B, SCHOOL_B, text } from "./leader-fixtures";

const LEADER_READS: Array<[string, SkCapability, Record<string, unknown>]> = [
  ["school.health overview", schoolHealth, {}],
  ["school.health at_risk", schoolHealth, { focus: "at_risk" }],
  ["school.health teachers", schoolHealth, { focus: "teachers" }],
  ["learners.risk", learnersRisk, {}],
  ["assignments.status", assignmentsStatus, {}],
  ["timetable.now_next", timetableNowNext, {}],
];

const none = (out: string, tokens: string[]) => {
  for (const t of tokens) expect(out, `leaked "${t}"`).not.toContain(t);
};

describe("coordinator hat (grade 5) — the union leak is closed in code", () => {
  for (const [label, rows] of [
    ["real RLS union (scope + own grade-6 class)", coordinatorRlsRows],
    ["worst case: every row of both schools", allRows],
  ] as const) {
    for (const [name, cap, args] of LEADER_READS) {
      it(`${name} over the ${label}: no grade-6, grade-4 or other-school row`, async () => {
        const ctx = coordinatorCtx();
        expect(metaAllows(cap.meta, ctx)).toBe(true);
        const r = await cap.handler(ctx, args, depsFor(new FakeDb(rows())));
        expect(r.ok).toBe(true);
        const out = text(r);
        none(out, GRADE6);
        none(out, GRADE4);
        none(out, SCHOOL_B);
        // …and the scope itself IS answered (not an empty refusal).
        expect(out).toMatch(/5 Amanah|5 Bestari|Amir|Balqis|Cikgu Bakar|Cikgu Aminah/);
      });
    }
  }

  it("school.health in scope: grade-5 totals only, and the coordinator's own grade-6 marking backlog is not a flag", async () => {
    const r = await schoolHealth.handler(coordinatorCtx(), {}, depsFor(new FakeDb(coordinatorRlsRows())));
    const totals = r.facts!.find((f) => f.row === "totals")!;
    expect(totals).toMatchObject({ scope: "scope", students: 7, classes: 2, teachers: 2, pendingToGrade: 3 });
    const teachers = r.facts!.filter((f) => f.row === "teacher").map((f) => f.name);
    expect(teachers.sort()).toEqual(["Cikgu Aminah", "Cikgu Bakar"]);
    expect(r.facts!.find((f) => f.name === "Cikgu Bakar")!.flags).toBe("3 to grade");
  });

  it("an asked-for grade outside the scope is refused, not answered", async () => {
    for (const cap of [schoolHealth, learnersRisk, assignmentsStatus, timetableNowNext]) {
      const r = await cap.handler(coordinatorCtx(), { grade: "grade 6" }, depsFor(new FakeDb(allRows())));
      expect(r.facts).toEqual([]);
      expect(r.summary).toContain("outside your scope");
      none(text(r), GRADE6);
    }
  });

  it("a coordinator hat with no scope rows sees nothing (fail closed, never the school)", async () => {
    const ctx = coordinatorCtx("coordinator", []);
    for (const [, cap, args] of LEADER_READS) {
      const r = await cap.handler(ctx, args, depsFor(new FakeDb(allRows())));
      expect(r.facts ?? []).toEqual([]);
      none(text(r), [...GRADE6, ...GRADE5_A, ...GRADE4, ...SCHOOL_B]);
    }
  });

  it("a subject scope (grade 5, Science) drops the grade-5 Mathematics share and its scores", async () => {
    const ctx = coordinatorCtx("coordinator", [{ grade: "5", subject: "science" }]);
    const db = new FakeDb(coordinatorRlsRows());
    const a = await assignmentsStatus.handler(ctx, {}, depsFor(db));
    expect(a.facts!.filter((f) => f.shareId).map((f) => f.shareId)).toEqual(["sh-c5a"]);
    const h = await schoolHealth.handler(ctx, { focus: "teachers" }, depsFor(new FakeDb(coordinatorRlsRows())));
    // Cikgu Bakar's 3 pending are on the Mathematics quiz: out of a Science scope.
    expect(h.facts!.find((f) => f.row === "totals")!.pendingToGrade).toBe(0);
    expect(text(h)).not.toContain("3 to grade");
  });
});

describe("the same coordinator with the TEACHER hat — their own class, nothing school-wide", () => {
  it("learners.risk and assignments.status are their own grade-6 class only", async () => {
    const ctx = coordinatorCtx("teacher");
    const risk = await learnersRisk.handler(ctx, {}, depsFor(new FakeDb(coordinatorRlsRows())));
    expect(risk.facts!.map((f) => f.name)).toEqual(["Citra"]);
    none(text(risk), GRADE5_A);
    const asg = await assignmentsStatus.handler(ctx, {}, depsFor(new FakeDb(coordinatorRlsRows())));
    expect(asg.facts!.map((f) => f.shareId)).toEqual(["sh-c6c"]);
    none(text(asg), GRADE5_A);
  });

  it("school.health is not offered on the teacher hat, and answers nothing if called", async () => {
    const ctx = coordinatorCtx("teacher");
    expect(metaAllows(schoolHealth.meta, ctx)).toBe(false);
    const r = await schoolHealth.handler(ctx, {}, depsFor(new FakeDb(allRows())));
    expect(r.facts).toEqual([]);
  });
});

describe("principal — all of their school, nothing of another", () => {
  it("school A's principal over every row of both schools: school A only", async () => {
    for (const [name, cap, args] of LEADER_READS) {
      const r = await cap.handler(principalCtx(), args, depsFor(new FakeDb(allRows())));
      expect(r.ok, name).toBe(true);
      none(text(r), SCHOOL_B);
    }
    const h = await schoolHealth.handler(principalCtx(), { focus: "at_risk" }, depsFor(new FakeDb(allRows())));
    expect(h.facts!.find((f) => f.row === "totals")).toMatchObject({ scope: "school", students: 13, classes: 4, teachers: 3 });
    const names = h.facts!.filter((f) => f.row === "at_risk").map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Amir", "Balqis", "Citra", "Dewi"]));
  });

  it("school B's principal: school B only", async () => {
    for (const [name, cap, args] of LEADER_READS) {
      const r = await cap.handler(principalCtx(PB, SCH_B), args, depsFor(new FakeDb(allRows())));
      expect(r.ok, name).toBe(true);
      none(text(r), [...GRADE6, ...GRADE4, ...GRADE5_A]);
    }
  });

  it("a principal on the teacher hat is a teacher again (own classes: none)", async () => {
    const r = await learnersRisk.handler(principalCtx(undefined, undefined, "teacher"), {}, depsFor(new FakeDb(allRows())));
    expect(r.facts).toEqual([]);
  });
});

describe("decision 2: never a parent's email", () => {
  it("no email key, no address — in facts, text or entities — from any leader read", async () => {
    for (const ctx of [principalCtx(), coordinatorCtx()]) {
      for (const [name, cap, args] of LEADER_READS) {
        const r = await cap.handler(ctx, args, depsFor(new FakeDb(allRows())));
        const out = text(r);
        expect(out, name).not.toMatch(/@/);
        expect(out, name).not.toMatch(/parent_?email/i);
        for (const f of r.facts ?? []) for (const k of Object.keys(f)) expect(k).not.toMatch(/e-?mail/i);
      }
    }
  });

  it("a learner whose username is an email address is named \"Student\"", async () => {
    const r = await learnersRisk.handler(principalCtx(), { classId: "c5a" }, depsFor(new FakeDb(allRows())));
    expect(r.facts!.map((f) => f.name).sort()).toEqual(["Amir", "Student"]);
  });
});
