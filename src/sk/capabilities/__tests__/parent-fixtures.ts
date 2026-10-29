// S4 — the two-family fixture (not a test file). Parent A has two children
// (Aisyah, a home learner; Adam, at school in class 5 Amanah), parent B has one
// (Zara, a home learner); Xavier is Adam's classmate; a teacher and a user of
// another school complete the cast. The fake session is LEAKY on purpose: it
// ignores every filter and hands back every family's rows, so the tests prove
// the capabilities' own cut to the one child — RLS is the gate, the code is
// the belt.

import type { SkContext } from "@/sk/shell/types";
import { childrenFromLinks } from "@/sk/shell/context";
import { NOW, OTHER_SCHOOL_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx } from "@/sk/shell/__tests__/fixtures";
import type { ChildMasteryRow } from "@/sk/parent-mastery";

export { NOW, SCHOOL_ID, OTHER_SCHOOL_ID, TEACHER_ID };

export const PA = "a0000000-0000-4000-8000-00000000000a";
export const PB = "b0000000-0000-4000-8000-00000000000b";
export const A1 = "a1000000-0000-4000-8000-0000000000a1"; // Aisyah Rahman, home
export const A2 = "a2000000-0000-4000-8000-0000000000a2"; // Adam Rahman, school
export const B1 = "b1000000-0000-4000-8000-0000000000b1"; // Zara Lim, home
export const X = "c1000000-0000-4000-8000-0000000000c1"; // Xavier Tan, Adam's classmate
export const C1 = "cc000000-0000-4000-8000-0000000000c1";
export const OTHER_USER = "dd000000-0000-4000-8000-0000000000dd";

export const FAMILY_A = { ids: [A1, A2], names: ["Aisyah", "Adam", "Rahman"] };
export const FAMILY_B = { ids: [B1], names: ["Zara", "Lim"] };
/** Strings that only Xavier's or another school's rows carry. */
export const STRANGERS = { ids: [X], names: ["Xavier", "Other school fair"] };

const link = (parent: string, child: string, source: string, verified: boolean, full_name: string, school_id: string | null) => ({
  parent_id: parent,
  child_id: child,
  source,
  verified_at: verified ? "2026-09-01T00:00:00Z" : null,
  profiles: { full_name, username: full_name.split(" ")[0].toLowerCase(), school_id },
});

export const LINKS = [
  link(PA, A1, "self", true, "Aisyah Rahman", null),
  link(PA, A2, "school", true, "Adam Rahman", SCHOOL_ID),
  link(PB, B1, "self", true, "Zara Lim", null),
];

export const TABLES: Record<string, Record<string, unknown>[]> = {
  parent_links: LINKS,
  enrollments: [
    { class_id: C1, student_id: A2 },
    { class_id: C1, student_id: X },
  ],
  classes: [{ id: C1, name: "5 Amanah", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  generation_shares: [
    { generation_id: "g1", class_id: C1, student_id: null, due_at: "2026-10-27T10:00:00Z", shared_by: TEACHER_ID, created_at: "2026-10-20T00:00:00Z" },
    { generation_id: "g2", class_id: null, student_id: A1, due_at: "2026-10-30T10:00:00Z", shared_by: PA, created_at: "2026-10-25T00:00:00Z" },
    { generation_id: "g3", class_id: null, student_id: A1, due_at: null, shared_by: PA, created_at: "2026-10-22T00:00:00Z" },
    { generation_id: "g4", class_id: null, student_id: B1, due_at: "2026-10-20T10:00:00Z", shared_by: PB, created_at: "2026-10-15T00:00:00Z" },
    { generation_id: "g5", class_id: null, student_id: X, due_at: "2026-10-21T10:00:00Z", shared_by: TEACHER_ID, created_at: "2026-10-15T00:00:00Z" },
    { generation_id: "g6", class_id: C1, student_id: null, due_at: null, shared_by: TEACHER_ID, created_at: "2026-10-15T00:00:00Z" },
    { generation_id: "g7", class_id: null, student_id: A1, due_at: "2026-10-26T10:00:00Z", shared_by: PA, created_at: "2026-10-21T00:00:00Z" },
  ],
  generations: [
    { id: "g1", title: "Worksheet — Cells", kind: "worksheet", chapter_ref: "0" },
    { id: "g2", title: "Quiz — Plants", kind: "exam_paper", chapter_ref: "1" },
    { id: "g3", title: "Fractions practice", kind: "worksheet", chapter_ref: null },
    { id: "g4", title: "Zara Lim private paper", kind: "exam_paper", chapter_ref: null },
    { id: "g5", title: "Xavier extra work", kind: "worksheet", chapter_ref: null },
    { id: "g6", title: "Teacher plan", kind: "lesson_plan", chapter_ref: null },
    { id: "g7", title: "Reading log", kind: "activity", chapter_ref: null },
  ],
  student_progress: [
    { generation_id: "g7", student_id: A1, status: "completed", completed_at: "2026-10-26T09:00:00Z", updated_at: "2026-10-26T09:00:00Z" },
    { generation_id: "g2", student_id: A1, status: "in_progress", completed_at: null, updated_at: "2026-10-27T09:00:00Z" },
    { generation_id: "g4", student_id: B1, status: "completed", completed_at: "2026-10-19T09:00:00Z", updated_at: "2026-10-19T09:00:00Z" },
    { generation_id: "g1", student_id: X, status: "completed", completed_at: "2026-10-22T09:00:00Z", updated_at: "2026-10-22T09:00:00Z" },
  ],
  submissions: [
    { generation_id: "g3", student_id: A1, auto_score: 4, teacher_score: null, max_score: 10, grade_status: "pending", feedback: null, submitted_at: "2026-10-27T08:00:00Z", graded_at: null },
    { generation_id: "g4", student_id: B1, auto_score: 9, teacher_score: 9, max_score: 10, grade_status: "graded", feedback: "Well done Zara", submitted_at: "2026-10-19T08:00:00Z", graded_at: "2026-10-20T08:00:00Z" },
    { generation_id: "g1", student_id: X, auto_score: 2, teacher_score: 2, max_score: 10, grade_status: "graded", feedback: "Xavier needs help", submitted_at: "2026-10-22T08:00:00Z", graded_at: "2026-10-23T08:00:00Z" },
  ],
  diary_notes: [
    { id: "n1", author_id: TEACHER_ID, class_id: C1, student_id: null, note_type: "announcement", body: "Class trip on Friday — bring a hat.", entry_date: "2026-10-27", created_at: "2026-10-27T01:00:00Z" },
    { id: "n2", author_id: PA, class_id: null, student_id: A1, note_type: "general", body: "Aisyah read beautifully today.", entry_date: "2026-10-26", created_at: "2026-10-26T12:00:00Z" },
    { id: "n3", author_id: PB, class_id: null, student_id: B1, note_type: "general", body: "Zara forgot her book.", entry_date: "2026-10-27", created_at: "2026-10-27T12:00:00Z" },
    { id: "n4", author_id: TEACHER_ID, class_id: C1, student_id: X, note_type: "behaviour", body: "Xavier was late.", entry_date: "2026-10-27", created_at: "2026-10-27T02:00:00Z" },
  ],
  school_events: [
    { id: "e1", school_id: SCHOOL_ID, title: "Sports day", description: null, audience: "school", starts_at: "2026-11-02T01:00:00Z", all_day: true, link_url: null, link_label: null, action_by: null, action_label: null, featured_until: null, importance: null },
    { id: "e2", school_id: OTHER_SCHOOL_ID, title: "Other school fair", description: null, audience: "school", starts_at: "2026-11-03T01:00:00Z", all_day: true, link_url: null, link_label: null, action_by: null, action_label: null, featured_until: null, importance: null },
  ],
  notice_acks: [],
  schools: [{ config: { calendar: true } }],
};

export function leakySession(log: string[] = []) {
  return fakeSession(TABLES, { log });
}

/** A context for a parent with the children loadContext would build. */
export function parentCtx(parentId: string, locale = "en"): SkContext {
  const ctx = makeCtx({ role: "parent", userId: parentId, hat: "parent", schoolId: null, locale });
  ctx.children = childrenFromLinks(parentId, LINKS);
  return ctx;
}

export const MASTERY: Record<string, ChildMasteryRow[]> = {
  [A1]: [
    { key: "art1:o1", status: "mastered", updatedAt: "2026-10-27T09:00:00Z", label: "Describe the cell as the unit of life", kit: "Cells" },
    { key: "art1:o2", status: "needs_work", updatedAt: "2026-10-27T10:00:00Z", label: "Explain diffusion", kit: "Cells" },
    { key: "art1:o3", status: "in_progress", updatedAt: "2026-10-26T10:00:00Z", label: "Name the parts of a plant cell", kit: "Cells" },
  ],
  [A2]: [],
  [B1]: [{ key: "art9:o1", status: "mastered", updatedAt: "2026-10-27T09:00:00Z", label: "Zara secret objective", kit: "Zara kit" }],
  [X]: [{ key: "art9:o2", status: "needs_work", updatedAt: "2026-10-27T09:00:00Z", label: "Xavier objective", kit: "Xavier kit" }],
};
