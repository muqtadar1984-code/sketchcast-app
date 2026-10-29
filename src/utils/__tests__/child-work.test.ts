/**
 * child-work.ts — the children page's itemsFor rules, moved to a pure module
 * that the page and SK's child.status share (S4).
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/child-work.test.ts
 */
import { describe, expect, it } from "vitest";
import { childWorkItems, isDoneStatus, uniqueWork, type ChildWorkRows } from "../child-work";

const NOW = Date.parse("2026-10-28T08:30:00Z");
const rows: ChildWorkRows = {
  enrollments: [
    { class_id: "c1", student_id: "kid" },
    { class_id: "c2", student_id: "other" },
  ],
  shares: [
    { generation_id: "g1", class_id: "c1", student_id: null, due_at: "2026-10-27T00:00:00Z", shared_by: "t" },
    { generation_id: "g2", class_id: null, student_id: "kid", due_at: "2026-10-20T00:00:00Z", shared_by: "parent" },
    { generation_id: "g3", class_id: "c2", student_id: null, due_at: null, shared_by: "t" },
    { generation_id: "g4", class_id: "c1", student_id: null, due_at: null, shared_by: "t" },
    { generation_id: "g1", class_id: null, student_id: "kid", due_at: "2026-11-02T00:00:00Z", shared_by: "parent" },
    { generation_id: "gone", class_id: "c1", student_id: null, due_at: null, shared_by: "t" },
  ],
  generations: [
    { id: "g1", title: "Cells", kind: "worksheet" },
    { id: "g2", title: null, kind: "exam_paper" },
    { id: "g3", title: "Other class", kind: "worksheet" },
    { id: "g4", title: "Plan", kind: "lesson_plan" },
  ],
  progress: [{ generation_id: "g1", student_id: "other", status: "completed" }],
  submissions: [
    { generation_id: "g2", student_id: "kid", auto_score: 4, teacher_score: null, max_score: 10, grade_status: "pending", feedback: "  ", submitted_at: "2026-10-21T00:00:00Z" },
    { generation_id: "g1", student_id: "other", auto_score: 9, teacher_score: 9, max_score: 10, grade_status: "graded", feedback: "x" },
  ],
};

describe("childWorkItems", () => {
  const items = childWorkItems(rows, "kid", NOW);
  it("class + direct shares only; lesson plans and missing generations dropped; one row per share", () => {
    expect(items.map((i) => [i.genId, i.direct])).toEqual([
      ["g1", false],
      ["g2", true],
      ["g1", true],
    ]);
  });
  it("another learner's progress/submission never counts; a pending paper is awaiting marking, not a score", () => {
    const g1 = items[0];
    expect(g1).toMatchObject({ status: "not started", overdue: true, score: null, feedback: null, classId: "c1" });
    const g2 = items[1];
    expect(g2).toMatchObject({ status: "submitted", awaitingMarking: true, score: null, overdue: false, feedback: null, title: null });
  });
  it("uniqueWork: one per generation, a dated direct share wins over the class row", () => {
    const u = uniqueWork(items);
    expect(u.map((i) => [i.genId, i.due])).toEqual([
      ["g1", "2026-11-02T00:00:00Z"],
      ["g2", "2026-10-20T00:00:00Z"],
    ]);
    expect(isDoneStatus("submitted") && isDoneStatus("revised") && !isDoneStatus("in_progress")).toBe(true);
  });
});
