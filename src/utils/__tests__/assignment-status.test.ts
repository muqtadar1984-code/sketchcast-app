/**
 * assignmentStatus — the analytics page's four definitions, replicated:
 * done (completed | revised | any submission), overdue (not done AND due_at <
 * now, strict), pending to grade (grade_status === "pending"), completion %.
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/assignment-status.test.ts
 */
import { describe, expect, it } from "vitest";
import { assignmentStatus, filterByDue, NOT_DONE_NAMES_CAP, shareTitle, type AssignmentStatusInput } from "../assignment-status";

const NOW = new Date("2026-10-28T04:00:00Z"); // 12:00 in Kuala Lumpur
const HOUR = 3600000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const enrol = (cls: string, id: string, name: string) => ({ class_id: cls, student_id: id, profiles: { full_name: name, username: null } });

/** Class 7B, five learners, one quiz due yesterday. */
function seeded(over: Partial<AssignmentStatusInput> = {}): AssignmentStatusInput {
  return {
    shares: [{ id: "sh1", generation_id: "quiz", class_id: "7b", due_at: iso(-24 * HOUR), generations: { kind: "quiz", chapter_ref: "2", title: "Cells quiz" } }],
    enrollments: [enrol("7b", "s1", "Aisha"), enrol("7b", "s2", "Ben"), enrol("7b", "s3", "Chen"), enrol("7b", "s4", "Dina"), enrol("7b", "s5", "Emir")],
    progress: [
      { generation_id: "quiz", student_id: "s1", status: "completed" },
      { generation_id: "quiz", student_id: "s2", status: "revised" },
      { generation_id: "quiz", student_id: "s4", status: "in_progress" },
    ],
    submissions: [{ generation_id: "quiz", student_id: "s3", grade_status: "pending" }],
    classNames: { "7b": "7B" },
    now: NOW,
    ...over,
  };
}

describe("assignmentStatus — the page's definitions", () => {
  it("done = completed | revised | any submission; not done are named", () => {
    const { shares, totals } = assignmentStatus(seeded());
    expect(shares).toHaveLength(1);
    const r = shares[0];
    expect(r).toMatchObject({ shareId: "sh1", generationId: "quiz", classId: "7b", className: "7B", title: "Cells quiz", kind: "quiz", assigned: 5, done: 3, notDone: 2 });
    expect(r.notDoneNames).toEqual(["Dina", "Emir"]);
    expect(r.notDoneIds).toEqual(["s4", "s5"]);
    expect(r.completionPct).toBe(60);
    expect(totals).toMatchObject({ shares: 1, assigned: 5, done: 3, notDone: 2, overdue: 2, pendingToGrade: 1, completionPct: 60 });
  });

  it("overdue counts only the not-done when due_at is strictly in the past", () => {
    expect(assignmentStatus(seeded()).shares[0].overdue).toBe(2);
    // Due later today: nothing is overdue yet.
    const future = seeded({ shares: [{ ...seeded().shares[0], due_at: iso(+2 * HOUR) }] });
    expect(assignmentStatus(future).shares[0].overdue).toBe(0);
    // No due date: never overdue.
    const none = seeded({ shares: [{ ...seeded().shares[0], due_at: null }] });
    expect(assignmentStatus(none).shares[0].overdue).toBe(0);
  });

  it("due_at == now is NOT overdue (the page's `<`)", () => {
    const edge = seeded({ shares: [{ ...seeded().shares[0], due_at: NOW.toISOString() }] });
    expect(assignmentStatus(edge).shares[0].overdue).toBe(0);
    const past = seeded({ shares: [{ ...seeded().shares[0], due_at: iso(-1) }] });
    expect(assignmentStatus(past).shares[0].overdue).toBe(2);
  });

  it("a submission alone makes a learner done, even with no progress row or a stale one", () => {
    const input = seeded({
      progress: [{ generation_id: "quiz", student_id: "s3", status: "in_progress" }],
      submissions: [
        { generation_id: "quiz", student_id: "s3", grade_status: "auto" },
        { generation_id: "quiz", student_id: "s5", grade_status: "graded" },
      ],
    });
    const r = assignmentStatus(input).shares[0];
    expect(r.done).toBe(2);
    expect(r.notDoneNames).toEqual(["Aisha", "Ben", "Dina"]);
  });

  it("revised counts as done; in_progress and opened do not", () => {
    const input = seeded({
      progress: [
        { generation_id: "quiz", student_id: "s1", status: "revised" },
        { generation_id: "quiz", student_id: "s2", status: "in_progress" },
        { generation_id: "quiz", student_id: "s3", status: "opened" },
      ],
      submissions: [],
    });
    expect(assignmentStatus(input).shares[0].done).toBe(1);
  });

  it("pending to grade = submissions with grade_status 'pending' (auto / graded are not)", () => {
    const input = seeded({
      submissions: [
        { generation_id: "quiz", student_id: "s3", grade_status: "pending" },
        { generation_id: "quiz", student_id: "s4", grade_status: "pending" },
        { generation_id: "quiz", student_id: "s5", grade_status: "auto" },
        { generation_id: "quiz", student_id: "s1", grade_status: "graded" },
      ],
    });
    const { shares, totals } = assignmentStatus(input);
    expect(shares[0].pendingToGrade).toBe(2);
    expect(totals.pendingToGrade).toBe(2);
  });

  it("the totals' to-grade counts a pending submission once even when its generation is shared to two classes", () => {
    const input = seeded({
      shares: [
        ...seeded().shares,
        { id: "sh2", generation_id: "quiz", class_id: "7c", due_at: null, generations: { kind: "quiz", chapter_ref: null, title: "Cells quiz" } },
      ],
      enrollments: [...seeded().enrollments, enrol("7c", "s3", "Chen")],
      classNames: { "7b": "7B", "7c": "7C" },
    });
    const { shares, totals } = assignmentStatus(input);
    expect(shares.map((r) => r.pendingToGrade)).toEqual([1, 1]);
    expect(totals.pendingToGrade).toBe(1);
  });

  it("direct-to-student shares (class_id null) and unknown classes contribute nothing", () => {
    const input = seeded({
      shares: [{ id: "sh9", generation_id: "quiz", class_id: null, due_at: iso(-HOUR) }, { id: "sh8", generation_id: "quiz", class_id: "ghost", due_at: iso(-HOUR) }],
    });
    const { shares, totals } = assignmentStatus(input);
    expect(shares).toHaveLength(1); // the ghost class: assigned 0
    expect(shares[0]).toMatchObject({ classId: "ghost", className: "Class", assigned: 0, done: 0, completionPct: 0 });
    expect(totals.assigned).toBe(0);
    expect(totals.completionPct).toBe(0);
  });

  it("completion % is rounded, per share and overall", () => {
    const input = seeded({
      shares: [...seeded().shares, { id: "sh2", generation_id: "ws", class_id: "7b", due_at: null, generations: { kind: "worksheet", chapter_ref: "0", title: null } }],
      progress: [...seeded().progress, { generation_id: "ws", student_id: "s1", status: "completed" }],
    });
    const { shares, totals } = assignmentStatus(input);
    expect(shares[1]).toMatchObject({ title: "worksheet chapter 1", completionPct: 20 });
    expect(totals.completionPct).toBe(40); // 4 of 10
  });

  it("caps the not-done names at 20 but keeps every id", () => {
    const many = Array.from({ length: 25 }, (_, i) => enrol("7b", `x${i}`, `Learner ${i}`));
    const r = assignmentStatus(seeded({ enrollments: many, progress: [], submissions: [] })).shares[0];
    expect(r.notDoneNames).toHaveLength(NOT_DONE_NAMES_CAP);
    expect(r.notDoneIds).toHaveLength(25);
  });

  it("falls back to the username, then 'Student', for a learner's name", () => {
    const r = assignmentStatus(
      seeded({ enrollments: [{ class_id: "7b", student_id: "u", profiles: { full_name: null, username: "ali.k" } }, { class_id: "7b", student_id: "v", profiles: null }], progress: [], submissions: [] }),
    ).shares[0];
    expect(r.notDoneNames).toEqual(["ali.k", "Student"]);
  });
});

describe("shareTitle", () => {
  it("title, else kind + 1-based chapter, else kind, else Item", () => {
    expect(shareTitle({ kind: "quiz", chapter_ref: "2", title: "Cells quiz" })).toBe("Cells quiz");
    expect(shareTitle({ kind: "quiz", chapter_ref: "2", title: null })).toBe("quiz chapter 3");
    expect(shareTitle({ kind: "worksheet", chapter_ref: null, title: "" })).toBe("worksheet");
    expect(shareTitle(null)).toBe("Item");
  });
});

describe("filterByDue", () => {
  const rows = () => {
    const base = seeded();
    const mk = (id: string, due: string | null, notDone = 2) => ({ ...assignmentStatus(base).shares[0], shareId: id, dueAt: due, notDone });
    return [
      mk("past", iso(-30 * HOUR)),
      mk("past-done", iso(-30 * HOUR), 0),
      mk("today-later", iso(+5 * HOUR)), // 17:00 KL, same civil day
      mk("tomorrow", iso(+20 * HOUR)), // 08:00 KL next day
      mk("in-six-days", iso(+6 * 24 * HOUR)),
      mk("in-nine-days", iso(+9 * 24 * HOUR)),
      mk("undated", null),
    ];
  };
  it("passes everything through without a filter", () => {
    expect(filterByDue(rows(), undefined, NOW)).toHaveLength(7);
  });
  it("overdue = past due with someone still not done", () => {
    expect(filterByDue(rows(), "overdue", NOW).map((r) => r.shareId)).toEqual(["past"]);
  });
  it("today = the same civil day in UTC+8 (yesterday's and tomorrow's are out)", () => {
    expect(filterByDue(rows(), "today", NOW).map((r) => r.shareId)).toEqual(["today-later"]);
    // 23:30 KL: tomorrow 08:00 KL is still another day.
    const late = new Date("2026-10-28T15:30:00Z");
    expect(filterByDue(rows(), "today", late).map((r) => r.shareId)).toEqual(["today-later"]);
  });
  it("week = from now through the next 7 days", () => {
    expect(filterByDue(rows(), "week", NOW).map((r) => r.shareId)).toEqual(["today-later", "tomorrow", "in-six-days"]);
  });
});
