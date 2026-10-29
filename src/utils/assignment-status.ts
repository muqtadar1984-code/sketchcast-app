// Assignment status — the teacher analytics page's definitions, lifted out so
// SK's `assignments.status` tool and the page can never disagree (Final Plan
// 2026-10-28 §3: "dashboard/analytics/page.tsx reads … reuse as tool
// implementations"). Replicates src/app/dashboard/analytics/page.tsx EXACTLY:
//
//   assigned instance  each class share × each student enrolled in that class (:164-172)
//   done               progress status "completed" | "revised" OR any submission row
//                      for (generation, student)                             (:178)
//   overdue            not done AND due_at set AND due_at < now (strict)     (:184)
//   pending to grade   a submission whose grade_status === "pending"         (:234)
//   completion %       Math.round(done / assigned × 100); 0 when nothing assigned (:237, :332)
//
// A due_at EQUAL to now is not overdue (the page's `<`). Direct-to-student
// shares (class_id null) are not class analytics and are ignored, as the page
// ignores them for teachers (:95).
//
// PURE — rows in, numbers out; the clock is injected.

export type StatusShareRow = {
  id: string;
  generation_id: string;
  class_id: string | null;
  due_at: string | null;
  generations?: { kind?: string | null; chapter_ref?: string | null; title?: string | null } | null;
};
export type StatusEnrollmentRow = {
  class_id: string;
  student_id: string;
  profiles?: { full_name?: string | null; username?: string | null } | null;
};
export type StatusProgressRow = { generation_id: string; student_id: string; status: string };
export type StatusSubmissionRow = { generation_id: string; student_id: string; grade_status: string };

export type AssignmentStatusInput = {
  shares: StatusShareRow[];
  enrollments: StatusEnrollmentRow[];
  progress: StatusProgressRow[];
  submissions: StatusSubmissionRow[];
  /** class id → name, for the rows' labels. */
  classNames: Record<string, string>;
  now: Date;
  /** Civil-day offset for `due: "today"`; Malaysia is fixed UTC+8 (notices.ts). */
  tzOffsetMinutes?: number;
};

export type ShareStatus = {
  shareId: string;
  generationId: string;
  classId: string;
  title: string;
  kind: string | null;
  className: string;
  assigned: number;
  done: number;
  notDone: number;
  overdue: number;
  pendingToGrade: number;
  dueAt: string | null;
  completionPct: number;
  /** Learners not done, display names (≤ 20). */
  notDoneNames: string[];
  /** Learners not done, ids (all of them, for the entity). */
  notDoneIds: string[];
};

export type AssignmentStatus = {
  shares: ShareStatus[];
  totals: { shares: number; assigned: number; done: number; notDone: number; overdue: number; pendingToGrade: number; completionPct: number };
};

export const NOT_DONE_NAMES_CAP = 20;
const MINUTE = 60000;
const DAY = 86400000;

/** The page's label: title, else "<kind> chapter N" (chapter_ref is 0-based), else kind. */
export function shareTitle(g: StatusShareRow["generations"]): string {
  if (!g) return "Item";
  if (g.title) return g.title;
  const kind = g.kind ?? "item";
  if (g.chapter_ref != null && g.chapter_ref !== "" && !Number.isNaN(Number(g.chapter_ref))) return `${kind} chapter ${Number(g.chapter_ref) + 1}`;
  return kind;
}

export function assignmentStatus(input: AssignmentStatusInput): AssignmentStatus {
  const now = input.now.getTime();
  const studentName = new Map<string, string>();
  const studentsByClass = new Map<string, string[]>();
  for (const e of input.enrollments) {
    studentName.set(e.student_id, e.profiles?.full_name || e.profiles?.username || "Student");
    if (!studentsByClass.has(e.class_id)) studentsByClass.set(e.class_id, []);
    studentsByClass.get(e.class_id)!.push(e.student_id);
  }
  const statusOf = new Map<string, string>(input.progress.map((p) => [`${p.generation_id}|${p.student_id}`, p.status]));
  const submittedOf = new Set<string>(input.submissions.map((s) => `${s.generation_id}|${s.student_id}`));
  const pendingByGen = new Map<string, Set<string>>();
  for (const s of input.submissions) {
    if (s.grade_status !== "pending") continue;
    if (!pendingByGen.has(s.generation_id)) pendingByGen.set(s.generation_id, new Set());
    pendingByGen.get(s.generation_id)!.add(s.student_id);
  }
  const isDone = (gen: string, stu: string) => {
    const key = `${gen}|${stu}`;
    const st = statusOf.get(key);
    return st === "completed" || st === "revised" || submittedOf.has(key);
  };

  const out: ShareStatus[] = [];
  const totals = { shares: 0, assigned: 0, done: 0, notDone: 0, overdue: 0, pendingToGrade: 0, completionPct: 0 };
  for (const sh of input.shares) {
    if (!sh.class_id) continue;
    const roster = studentsByClass.get(sh.class_id) ?? [];
    const dueMs = sh.due_at ? new Date(sh.due_at).getTime() : NaN;
    const pastDue = !Number.isNaN(dueMs) && dueMs < now;
    let done = 0;
    let pending = 0;
    const notDoneIds: string[] = [];
    const pendingSet = pendingByGen.get(sh.generation_id);
    for (const stu of roster) {
      if (isDone(sh.generation_id, stu)) done++;
      else notDoneIds.push(stu);
      if (pendingSet?.has(stu)) pending++;
    }
    const assigned = roster.length;
    const overdue = pastDue ? notDoneIds.length : 0;
    const row: ShareStatus = {
      shareId: sh.id,
      generationId: sh.generation_id,
      classId: sh.class_id,
      title: shareTitle(sh.generations),
      kind: sh.generations?.kind ?? null,
      className: input.classNames[sh.class_id] ?? "Class",
      assigned,
      done,
      notDone: notDoneIds.length,
      overdue,
      pendingToGrade: pending,
      dueAt: sh.due_at,
      completionPct: assigned ? Math.round((done / assigned) * 100) : 0,
      notDoneNames: notDoneIds.slice(0, NOT_DONE_NAMES_CAP).map((id) => studentName.get(id) ?? "Student"),
      notDoneIds,
    };
    out.push(row);
    totals.shares++;
    totals.assigned += assigned;
    totals.done += done;
    totals.notDone += notDoneIds.length;
    totals.overdue += overdue;
  }
  totals.completionPct = totals.assigned ? Math.round((totals.done / totals.assigned) * 100) : 0;
  // The page's "To grade" is every pending submission on an assigned
  // generation (:234), counted once — not the per-class roster sums, which
  // would count a learner enrolled in two classes twice.
  const sharedGens = new Set(out.map((r) => r.generationId));
  totals.pendingToGrade = input.submissions.filter((s) => s.grade_status === "pending" && sharedGens.has(s.generation_id)).length;
  return { shares: out, totals };
}

export type DueFilter = "overdue" | "today" | "week" | "tomorrow";

/** Civil day index in the given offset. */
const dayIndex = (ms: number, offsetMin: number) => Math.floor((ms + offsetMin * MINUTE) / DAY);

/**
 * The `due` argument: "overdue" = past due with someone not done; "today" =
 * due in the current civil day (UTC+8 by default); "week" = due from now
 * through the next 7 days. A share with no due date never matches a filter.
 * SK S6 (additive): "tomorrow" = due in the NEXT civil day in the same offset
 * (UTC+8 by default: Kuala Lumpur time), so 23:30 KL on Tuesday asks about
 * Wednesday even though it is already Wednesday in UTC+9.
 */
export function filterByDue(rows: ShareStatus[], due: DueFilter | undefined, now: Date, tzOffsetMinutes = 480): ShareStatus[] {
  if (!due) return rows;
  const t = now.getTime();
  const today = dayIndex(t, tzOffsetMinutes);
  return rows.filter((r) => {
    if (!r.dueAt) return false;
    const d = new Date(r.dueAt).getTime();
    if (Number.isNaN(d)) return false;
    if (due === "overdue") return d < t && r.notDone > 0;
    if (due === "today") return dayIndex(d, tzOffsetMinutes) === today;
    if (due === "tomorrow") return dayIndex(d, tzOffsetMinutes) === today + 1;
    return d >= t && d <= t + 7 * DAY;
  });
}
