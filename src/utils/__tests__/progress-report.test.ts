import { describe, expect, it } from "vitest";
import {
  buildProgressReport,
  reportAccess,
  type ReportGenRow,
  type ReportProgressRow,
  type ReportShareRow,
  type ReportSubmissionRow,
} from "../progress-report";

// The printable progress record's assembly step. The page hands it the raw
// RLS-scoped rows; these tests hand it the same shapes and pin what the report
// may claim: only what a row records, grouped per book, honestly empty when
// nothing exists.

const LEARNER = "stu-1";
const OTHER = "stu-2";
const CLASS_A = "class-a";

const share = (over: Partial<ReportShareRow> & { generation_id: string }): ReportShareRow => ({
  class_id: null,
  student_id: null,
  due_at: null,
  created_at: "2026-08-01T08:00:00Z",
  ...over,
});

const gen = (over: Partial<ReportGenRow> & { id: string }): ReportGenRow => ({
  title: null,
  kind: "worksheet",
  chapter_ref: null,
  book_id: null,
  ...over,
});

const prog = (over: Partial<ReportProgressRow> & { generation_id: string }): ReportProgressRow => ({
  student_id: LEARNER,
  status: "in_progress",
  completed_at: null,
  opened_at: null,
  ...over,
});

const sub = (over: Partial<ReportSubmissionRow> & { generation_id: string }): ReportSubmissionRow => ({
  student_id: LEARNER,
  auto_score: null,
  teacher_score: null,
  max_score: null,
  grade_status: "pending",
  submitted_at: "2026-08-10T10:00:00Z",
  graded_at: null,
  ...over,
});

describe("buildProgressReport", () => {
  it("groups a multi-book learner into per-book sections with chapters, dates and statuses", () => {
    const report = buildProgressReport({
      learnerId: LEARNER,
      learnerClassIds: [CLASS_A],
      shares: [
        // Book 1: one class share (chapter 2), one direct share (chapter 10).
        share({ generation_id: "g1", class_id: CLASS_A, created_at: "2026-08-01T08:00:00Z" }),
        share({ generation_id: "g2", student_id: LEARNER, created_at: "2026-08-03T08:00:00Z", due_at: "2026-08-20T00:00:00Z" }),
        // Book 2: one class share.
        share({ generation_id: "g3", class_id: CLASS_A, created_at: "2026-08-02T08:00:00Z" }),
        // Shared to a class the learner is NOT in — someone else's work.
        share({ generation_id: "g4", class_id: "class-b" }),
        // A lesson plan is teacher material, never learner work.
        share({ generation_id: "g5", class_id: CLASS_A }),
        // A share whose generation row is gone says nothing truthful.
        share({ generation_id: "g6", class_id: CLASS_A }),
      ],
      generations: [
        gen({ id: "g1", kind: "presentation", title: "Cells", chapter_ref: "2", book_id: "book-1" }),
        gen({ id: "g2", kind: "exam_paper", title: "Test: Plants", chapter_ref: "10", book_id: "book-1" }),
        gen({ id: "g3", kind: "worksheet", title: "Fractions", chapter_ref: "3", book_id: "book-2" }),
        gen({ id: "g4", kind: "worksheet", book_id: "book-1" }),
        gen({ id: "g5", kind: "lesson_plan", book_id: "book-1" }),
      ],
      progress: [
        prog({ generation_id: "g1", status: "completed", completed_at: "2026-08-05T09:00:00Z" }),
        // A different student's progress on the same generation must not leak in.
        prog({ generation_id: "g3", student_id: OTHER, status: "completed", completed_at: "2026-08-06T09:00:00Z" }),
      ],
      submissions: [],
    });

    expect(report.empty).toBe(false);
    expect(report.sections.map((s) => s.bookId)).toEqual(["book-1", "book-2"]);

    const [book1, book2] = report.sections;
    expect(book1.items.map((i) => i.generationId)).toEqual(["g1", "g2"]);
    // Human labels: 0-based chapter_ref + 1, numeric order ("3" before "11"),
    // matching the analytics page's "Ch N" convention.
    expect(book1.chaptersCovered).toEqual(["3", "11"]);
    expect(book1.items[0].status).toBe("completed");
    expect(book1.items[0].completedAt).toBe("2026-08-05T09:00:00Z");
    expect(book1.items[1].status).toBe("not_started");
    expect(book1.items[1].dueAt).toBe("2026-08-20T00:00:00Z");
    expect(book1.summary).toEqual({ assigned: 2, completed: 1, scored: 0, averagePct: null });

    expect(book2.items.map((i) => i.generationId)).toEqual(["g3"]);
    // g3's completion belongs to another student: this learner is untouched.
    expect(book2.items[0].status).toBe("not_started");

    expect(report.summary).toEqual({ assigned: 3, completed: 1, scored: 0, averagePct: null });
    expect(report.firstActivityAt).toBe("2026-08-01T08:00:00Z");
    expect(report.lastActivityAt).toBe("2026-08-05T09:00:00Z");
  });

  it("merges a class share and a direct share of the same generation into one item", () => {
    const report = buildProgressReport({
      learnerId: LEARNER,
      learnerClassIds: [CLASS_A],
      shares: [
        share({ generation_id: "g1", class_id: CLASS_A, created_at: "2026-08-01T08:00:00Z", due_at: "2026-08-09T00:00:00Z" }),
        share({ generation_id: "g1", student_id: LEARNER, created_at: "2026-08-04T08:00:00Z", due_at: "2026-08-15T00:00:00Z" }),
      ],
      generations: [gen({ id: "g1", book_id: "book-1" })],
      progress: [],
      submissions: [],
    });
    expect(report.summary.assigned).toBe(1);
    const item = report.sections[0].items[0];
    // Earliest assignment date wins; the direct share's due date wins.
    expect(item.assignedAt).toBe("2026-08-01T08:00:00Z");
    expect(item.dueAt).toBe("2026-08-15T00:00:00Z");
  });

  it("a personal share without a deadline never hides the class due date", () => {
    const report = buildProgressReport({
      learnerId: LEARNER,
      learnerClassIds: [CLASS_A],
      shares: [
        share({ generation_id: "g1", class_id: CLASS_A, created_at: "2026-08-01T08:00:00Z", due_at: "2026-08-09T00:00:00Z" }),
        share({ generation_id: "g1", student_id: LEARNER, created_at: "2026-08-04T08:00:00Z", due_at: null }),
      ],
      generations: [gen({ id: "g1", book_id: "book-1" })],
      progress: [],
      submissions: [],
    });
    // The due-less personal share still merges (one item), but the class
    // deadline is the one that prints.
    expect(report.summary.assigned).toBe(1);
    expect(report.sections[0].items[0].dueAt).toBe("2026-08-09T00:00:00Z");
  });

  it("is honestly empty for a learner with no recorded work", () => {
    const report = buildProgressReport({
      learnerId: LEARNER,
      learnerClassIds: [],
      shares: [share({ generation_id: "g1", class_id: CLASS_A })],
      generations: [gen({ id: "g1" })],
      progress: [],
      submissions: [],
    });
    expect(report.empty).toBe(true);
    expect(report.sections).toEqual([]);
    expect(report.summary).toEqual({ assigned: 0, completed: 0, scored: 0, averagePct: null });
    expect(report.firstActivityAt).toBeNull();
    expect(report.lastActivityAt).toBeNull();
  });

  it("averages score percentages, preferring the teacher's mark over the auto mark", () => {
    const report = buildProgressReport({
      learnerId: LEARNER,
      learnerClassIds: [CLASS_A],
      shares: [
        share({ generation_id: "g1", class_id: CLASS_A, created_at: "2026-08-01T08:00:00Z" }),
        share({ generation_id: "g2", class_id: CLASS_A, created_at: "2026-08-02T08:00:00Z" }),
        share({ generation_id: "g3", class_id: CLASS_A, created_at: "2026-08-03T08:00:00Z" }),
      ],
      generations: [gen({ id: "g1" }), gen({ id: "g2" }), gen({ id: "g3" })],
      progress: [],
      submissions: [
        // auto 8/10 = 80%, but the teacher re-marked it 9/10 = 90%.
        sub({ generation_id: "g1", auto_score: 8, teacher_score: 9, max_score: 10, grade_status: "graded", graded_at: "2026-08-12T10:00:00Z" }),
        // auto-marked 5/10 = 50%.
        sub({ generation_id: "g2", auto_score: 5, max_score: 10, grade_status: "auto" }),
        // A file submission with no score yet: submitted, but never averaged.
        sub({ generation_id: "g3" }),
      ],
    });

    const items = report.sections[0].items;
    expect(items[0].score).toEqual({ points: 9, max: 10, pct: 90, gradeStatus: "graded", date: "2026-08-12T10:00:00Z" });
    expect(items[1].score?.pct).toBe(50);
    expect(items[2].score).toBeNull();
    expect(items[2].status).toBe("submitted");
    // (90 + 50) / 2 = 70; the unscored submission does not drag the average.
    expect(report.summary).toEqual({ assigned: 3, completed: 3, scored: 2, averagePct: 70 });
    // Grading is the latest recorded event.
    expect(report.lastActivityAt).toBe("2026-08-12T10:00:00Z");
  });
});

describe("reportAccess", () => {
  const base = {
    viewerId: "adult-1",
    learnerId: LEARNER,
    parentLinks: [] as { parent_id: string; child_id: string }[],
    taughtClasses: [] as { id: string; teacher_id: string }[],
    learnerEnrollments: [] as { class_id: string; student_id: string }[],
  };

  it("allows a parent linked to the learner", () => {
    expect(
      reportAccess({ ...base, parentLinks: [{ parent_id: "adult-1", child_id: LEARNER }] }),
    ).toEqual({ allowed: true, via: "parent" });
  });

  it("allows a teacher whose class the learner is enrolled in", () => {
    expect(
      reportAccess({
        ...base,
        taughtClasses: [{ id: CLASS_A, teacher_id: "adult-1" }],
        learnerEnrollments: [{ class_id: CLASS_A, student_id: LEARNER }],
      }),
    ).toEqual({ allowed: true, via: "teacher" });
  });

  it("refuses a foreign learner even when stray rows are present", () => {
    expect(
      reportAccess({
        ...base,
        // A link to a DIFFERENT child, and someone else's class/enrollment —
        // the kind of rows a looser RLS policy might hand back.
        parentLinks: [{ parent_id: "adult-1", child_id: OTHER }],
        taughtClasses: [{ id: CLASS_A, teacher_id: "someone-else" }],
        learnerEnrollments: [{ class_id: CLASS_A, student_id: LEARNER }],
      }),
    ).toEqual({ allowed: false, via: null });
  });

  it("refuses the learner themselves and a teacher of an unrelated class", () => {
    expect(reportAccess({ ...base, viewerId: LEARNER })).toEqual({ allowed: false, via: null });
    expect(
      reportAccess({
        ...base,
        taughtClasses: [{ id: "class-b", teacher_id: "adult-1" }],
        learnerEnrollments: [{ class_id: CLASS_A, student_id: LEARNER }],
      }),
    ).toEqual({ allowed: false, via: null });
  });
});
