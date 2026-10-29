// One child's shared work, as a parent sees it — the pure assembly step that
// /dashboard/children (itemsFor) and SK's parent capabilities (child.status,
// child.week) BOTH use, so the parent's page and SK never tell two stories
// about the same row.
//
// Moved here from src/app/dashboard/children/page.tsx (S4, 2026-10-29). The
// rules are the page's, unchanged:
//   - a share counts when it is DIRECT to the child (student_id) or to one of
//     the child's classes; teacher-only material (lesson plans) and shares
//     whose generation is gone are not the child's work;
//   - a submission is the strongest status signal ("submitted"), else the
//     progress row's word, else "not started";
//   - a 'pending' submission holds only the auto-marked part: it is "awaiting
//     marking", never a final score;
//   - overdue = a due date in the past, not completed and nothing submitted.
//
// PURE — no next/*, no supabase — and every row is re-filtered to THIS child
// in code, so a broader-than-expected read can never leak a sibling's or a
// classmate's work into the answer.

export type ChildWorkShare = {
  generation_id: string;
  class_id: string | null;
  student_id: string | null;
  due_at: string | null;
  shared_by: string | null;
  created_at?: string | null;
};
export type ChildWorkGeneration = { id: string; title: string | null; kind: string | null; chapter_ref?: string | null };
export type ChildWorkProgress = { generation_id: string; student_id: string; status: string; completed_at?: string | null; updated_at?: string | null };
export type ChildWorkSubmission = {
  generation_id: string;
  student_id: string;
  auto_score: number | null;
  teacher_score: number | null;
  max_score: number | null;
  grade_status: string | null;
  feedback: string | null;
  submitted_at?: string | null;
  graded_at?: string | null;
};

export type ChildWorkRows = {
  /** The child's enrollments (rows of other students are ignored). */
  enrollments: { class_id: string; student_id: string }[];
  shares: ChildWorkShare[];
  generations: ChildWorkGeneration[];
  progress: ChildWorkProgress[];
  submissions: ChildWorkSubmission[];
};

export type ChildWorkItem = {
  genId: string;
  /** generations.kind verbatim. */
  kind: string;
  /** generations.title, or null (the caller names the kind). */
  title: string | null;
  /** Shared to the child directly (not through a class). */
  direct: boolean;
  /** The class it came through (null for a direct share). */
  classId: string | null;
  sharedBy: string | null;
  due: string | null;
  overdue: boolean;
  /** "submitted" when there is a submission, else the progress status, else "not started". */
  status: string;
  awaitingMarking: boolean;
  /** Final points / max (teacher's mark, else the auto mark); null when unscored or pending. */
  score: { points: number | null; max: number } | null;
  feedback: string | null;
  /** When the child finished it: progress completed_at, else submitted_at. */
  doneAt: string | null;
  submittedAt: string | null;
};

/** One row per share (the page's shape: a generation shared both ways shows twice). */
export function childWorkItems(rows: ChildWorkRows, childId: string, now: number): ChildWorkItem[] {
  const childClasses = new Set(rows.enrollments.filter((e) => e.student_id === childId).map((e) => e.class_id));
  const genOf = new Map(rows.generations.map((g) => [g.id, g]));
  const progOf = new Map(rows.progress.filter((p) => p.student_id === childId).map((p) => [p.generation_id, p]));
  const subOf = new Map(rows.submissions.filter((s) => s.student_id === childId).map((s) => [s.generation_id, s]));
  const out: ChildWorkItem[] = [];
  for (const s of rows.shares) {
    const direct = s.student_id === childId;
    const viaClass = s.class_id != null && childClasses.has(s.class_id);
    if (!direct && !viaClass) continue;
    const g = genOf.get(s.generation_id);
    if (!g || g.kind === "lesson_plan") continue;
    const prog = progOf.get(s.generation_id);
    const status = prog?.status ?? "not started";
    const sub = subOf.get(s.generation_id);
    const awaitingMarking = sub?.grade_status === "pending";
    out.push({
      genId: s.generation_id,
      kind: g.kind ?? "",
      title: g.title || null,
      direct,
      classId: direct ? null : s.class_id,
      sharedBy: s.shared_by,
      due: s.due_at,
      overdue: !!s.due_at && new Date(s.due_at).getTime() < now && status !== "completed" && !sub,
      status: sub ? "submitted" : status,
      awaitingMarking,
      score: !awaitingMarking && sub && sub.max_score ? { points: sub.teacher_score ?? sub.auto_score, max: sub.max_score } : null,
      feedback: sub?.feedback?.trim() || null,
      doneAt: prog?.completed_at ?? sub?.submitted_at ?? null,
      submittedAt: sub?.submitted_at ?? null,
    });
  }
  return out;
}

/** Done = completed / revised / submitted (the progress report's vocabulary). */
export function isDoneStatus(status: string): boolean {
  return status === "completed" || status === "revised" || status === "submitted";
}

/** The same work once per generation (SK counts pieces of work, not shares):
 *  the first row wins, a direct row with a due date replaces a class row. */
export function uniqueWork(items: ChildWorkItem[]): ChildWorkItem[] {
  const by = new Map<string, ChildWorkItem>();
  for (const it of items) {
    const cur = by.get(it.genId);
    if (!cur || (it.direct && it.due && !cur.direct)) by.set(it.genId, it);
  }
  return [...by.values()];
}
