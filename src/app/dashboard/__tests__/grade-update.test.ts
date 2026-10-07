/**
 * A teacher's mark on a FILE submission must reach the people who read it.
 *
 * A file upload is written with max_score = NULL (student-item.tsx; RLS 0091
 * pins it there for a student session), and every reader shows or uses a mark
 * only over a truthy max_score. Before this fix GradeList wrote the score and
 * no max, so the parent saw "submitted" with no mark and the at-risk average
 * ignored it. GradeList now asks "out of" on a file row and writes it as
 * max_score; these tests pin that payload, run it through the real readers'
 * rules, and pin the RLS facts the fix leans on.
 * Run: node node_modules/vitest/vitest.mjs run src/app/dashboard/__tests__/grade-update.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGradeUpdate, needsOutOf } from "../grade-update";
import { computeSchoolHealth, type HealthRows } from "@/utils/school-health";

const NOW = new Date("2026-10-07T09:00:00Z");
const FILE = { mode: "file", max: null };
const QUIZ = { mode: "interactive", max: 20 };

describe("buildGradeUpdate — file submissions", () => {
  it("writes the teacher's 'out of' as max_score", () => {
    const r = buildGradeUpdate(FILE, { score: "7", outOf: "10", feedback: "  Good work " }, "t1", NOW);
    expect(r).toEqual({
      ok: true,
      update: {
        teacher_score: 7,
        max_score: 10,
        feedback: "Good work",
        grade_status: "graded",
        graded_by: "t1",
        graded_at: NOW.toISOString(),
      },
    });
  });

  it("refuses to save a file mark with no 'out of' — that mark would reach nobody", () => {
    for (const outOf of [undefined, "", "   "]) {
      const r = buildGradeUpdate(FILE, { score: "7", outOf, feedback: undefined }, "t1", NOW);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects an 'out of' of 0, negative or not a number", () => {
    for (const outOf of ["0", "-5", "abc", "Infinity"]) {
      expect(buildGradeUpdate(FILE, { score: "0", outOf, feedback: "" }, "t1", NOW).ok).toBe(false);
    }
  });

  it("rejects a score above the max or below 0, accepts 0 and full marks", () => {
    expect(buildGradeUpdate(FILE, { score: "11", outOf: "10", feedback: "" }, "t1", NOW).ok).toBe(false);
    expect(buildGradeUpdate(FILE, { score: "-1", outOf: "10", feedback: "" }, "t1", NOW).ok).toBe(false);
    expect(buildGradeUpdate(FILE, { score: "0", outOf: "10", feedback: "" }, "t1", NOW).ok).toBe(true);
    expect(buildGradeUpdate(FILE, { score: "10", outOf: "10", feedback: "" }, "t1", NOW).ok).toBe(true);
  });

  it("still requires a score", () => {
    const r = buildGradeUpdate(FILE, { score: "", outOf: "10", feedback: "" }, "t1", NOW);
    expect(r).toEqual({ ok: false, error: "Enter a score first." });
  });
});

describe("buildGradeUpdate — interactive submissions", () => {
  it("never touches the auto-scorer's max_score", () => {
    const r = buildGradeUpdate(QUIZ, { score: "15", outOf: "99", feedback: "" }, "t1", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.update).not.toHaveProperty("max_score");
      expect(r.update.teacher_score).toBe(15);
    }
    expect(needsOutOf(QUIZ)).toBe(false);
  });

  it("caps the teacher's total at the quiz max", () => {
    expect(buildGradeUpdate(QUIZ, { score: "21", outOf: undefined, feedback: "" }, "t1", NOW).ok).toBe(false);
  });

  it("asks for 'out of' on any row without a usable max", () => {
    expect(needsOutOf(FILE)).toBe(true);
    expect(needsOutOf({ mode: "interactive", max: 0 })).toBe(true);
    expect(needsOutOf({ mode: "interactive", max: null })).toBe(true);
  });
});

// The parent / Diary / console readers all format a mark with this exact
// expression (children/page.tsx, diary/*-view.tsx). Restated here so the test
// checks the reader's rule, not a paraphrase of it.
type Sub = { auto_score: number | null; teacher_score: number | null; max_score: number | null };
const readerScore = (sub: Sub | undefined) =>
  sub && sub.max_score ? `${(sub.teacher_score ?? sub.auto_score) ?? "—"}/${sub.max_score}` : null;

describe("a graded file submission reaches its readers", () => {
  const uploaded: Sub = { auto_score: null, teacher_score: null, max_score: null };
  const graded = (): Sub => {
    const r = buildGradeUpdate(FILE, { score: "3", outOf: "10", feedback: "" }, "t1", NOW);
    if (!r.ok) throw new Error(r.error);
    return { ...uploaded, ...r.update };
  };

  it("parent / Diary score expression shows the mark", () => {
    expect(readerScore(uploaded)).toBeNull();
    expect(readerScore(graded())).toBe("3/10");
  });

  it("the reader expression is still the one the readers use", () => {
    const src = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf-8");
    const expr = "sub && sub.max_score ? `${(sub.teacher_score ?? sub.auto_score) ?? \"—\"}/${sub.max_score}` : null";
    for (const f of ["children/page.tsx", "diary/parent-view.tsx", "diary/student-view.tsx", "diary/teacher-view.tsx"]) {
      expect(src(f), f).toContain(expr);
    }
  });

  it("school health counts it toward the at-risk average", () => {
    const ago = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
    const rows: HealthRows = {
      classes: [{ id: "c1", name: "Maths 5A", grade: "5", teacher_id: "t1" }],
      enrollments: [{ class_id: "c1", student_id: "s1", full_name: "Aisha Rahman", username: "aisha", parent_email: null }],
      shares: [{ generation_id: "g1", class_id: "c1", shared_by: "t1", due_at: ago(5) }],
      progress: [],
      submissions: [
        {
          generation_id: "g1",
          student_id: "s1",
          ...graded(),
          submitted_at: ago(4),
          graded_at: ago(3),
          grade_status: "graded",
        },
      ],
      generations: [{ id: "g1", owner_id: "t1" }],
      teacherNames: { t1: "Nurul Hassan" },
    };
    const before = computeSchoolHealth(
      { ...rows, submissions: rows.submissions.map((s) => ({ ...s, max_score: null })) },
      NOW.getTime(),
    );
    const after = computeSchoolHealth(rows, NOW.getTime());
    // 3/10 = 30%: a concern the principal sees only once the max is known.
    expect(before.atRisk).toEqual([]);
    expect(after.atRisk).toHaveLength(1);
    expect(after.atRisk[0].name).toBe("Aisha Rahman");
    expect(after.atRisk[0].reasons).toContain("avg score 30%");
  });
});

describe("the RLS this leans on (0091) still keeps max_score out of a student's hands", () => {
  const sql = readFileSync(
    path.resolve(__dirname, "../../../../supabase/migrations/0091_students_cannot_grade_themselves.sql"),
    "utf-8",
  );
  it("both student file policies pin max_score to NULL", () => {
    for (const name of ["sub_student_file_insert", "sub_student_file_update"]) {
      const at = sql.indexOf(`create policy ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      const body = sql.slice(at, sql.indexOf(";", at));
      expect(body, name).toMatch(/max_score is null/);
    }
  });

  it("the student's upload still writes max_score: null, so a resubmit clears the teacher's max with the mark", () => {
    const src = readFileSync(path.resolve(__dirname, "../student-item.tsx"), "utf-8");
    const at = src.indexOf('mode: "file"');
    expect(at).toBeGreaterThan(-1);
    const upsert = src.slice(at, src.indexOf("onConflict", at));
    expect(upsert).toMatch(/max_score: null/);
    expect(upsert).toMatch(/teacher_score: null/);
  });
});
