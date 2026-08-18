// Printable progress record — the pure assembly step.
//
// Given the raw rows a viewer's RLS-scoped session can already read
// (assignments, generations, per-learner progress, submissions), produce the
// report model the /dashboard/reports/[learnerId] page renders. Everything in
// the output is derived from a row that exists TODAY — nothing is inferred or
// invented: an item with no submission simply has no score, a learner with no
// shares gets an honest empty report.
//
// PURE — no next/*, no supabase, no server-only — so vitest exercises it
// directly and a future surface (email digest, docx export) can reuse it.

// ── Input row shapes (subsets of the DB rows, as the page selects them) ──────

export type ReportShareRow = {
  generation_id: string;
  class_id: string | null;
  student_id: string | null;
  due_at: string | null;
  created_at: string;
};

export type ReportGenRow = {
  id: string;
  title: string | null;
  kind: string | null;
  chapter_ref: string | null;
  book_id: string | null;
};

export type ReportProgressRow = {
  generation_id: string;
  student_id: string;
  status: string;
  completed_at: string | null;
  opened_at: string | null;
};

export type ReportSubmissionRow = {
  generation_id: string;
  student_id: string;
  auto_score: number | null;
  teacher_score: number | null;
  max_score: number | null;
  grade_status: string;
  submitted_at: string;
  graded_at: string | null;
};

// ── Output model ─────────────────────────────────────────────────────────────

/** The report's status vocabulary — the student dashboard's words, so a chip on
 * the printed record and a chip on screen never disagree about the same row. */
export type ReportStatus = "not_started" | "in_progress" | "completed" | "revised" | "submitted";

export type ReportScore = {
  points: number;
  max: number;
  /** 0–100, rounded. */
  pct: number;
  /** DB grade_status verbatim: "auto" | "graded" | "pending". */
  gradeStatus: string;
  /** graded_at when a teacher marked it, else submitted_at. */
  date: string;
};

export type ReportItem = {
  generationId: string;
  /** generations.title verbatim; "" when the row has none (caller shows the kind). */
  title: string;
  /** DB kind verbatim ("presentation", "worksheet", …). */
  kind: string;
  chapterRef: string | null;
  bookId: string | null;
  /** Earliest share of this generation to the learner. */
  assignedAt: string;
  dueAt: string | null;
  status: ReportStatus;
  completedAt: string | null;
  score: ReportScore | null;
};

export type ReportSummary = {
  assigned: number;
  /** completed + revised + submitted. */
  completed: number;
  /** Items carrying a score. */
  scored: number;
  /** Mean of per-item score percentages, rounded; null when nothing is scored. */
  averagePct: number | null;
};

export type ReportSection = {
  /** books.id, or null for generations with no book (the page labels it "Other work"). */
  bookId: string | null;
  items: ReportItem[];
  /** Human chapter labels for the section's items, numerically sorted.
   * chapter_ref is a 0-based index in the DB; readers count from 1, so these
   * carry the same +1 the analytics page shows ("1" for ref "0"). */
  chaptersCovered: string[];
  summary: ReportSummary;
};

export type ProgressReport = {
  sections: ReportSection[];
  summary: ReportSummary;
  /** Earliest assignment date, or null when the report is empty. */
  firstActivityAt: string | null;
  /** Latest recorded event (assignment, completion, submission, grading). */
  lastActivityAt: string | null;
  empty: boolean;
};

// ── Access ───────────────────────────────────────────────────────────────────

export type ReportAccessInput = {
  viewerId: string;
  learnerId: string;
  /** parent_links rows visible to the viewer (RLS already scopes to their own). */
  parentLinks: { parent_id: string; child_id: string }[];
  /** Classes the viewer teaches (page queries .eq teacher_id = viewer). */
  taughtClasses: { id: string; teacher_id: string }[];
  /** The learner's enrollment rows visible to the viewer. */
  learnerEnrollments: { class_id: string; student_id: string }[];
};

/**
 * May this viewer see this learner's record? Belt over RLS's braces: every row
 * is re-checked against the ids, so a broader-than-expected policy (or a future
 * one) cannot silently widen who prints a child's scores.
 *
 * - parent: an own parent_links row to exactly this learner.
 * - teacher: the learner is enrolled in a class the viewer teaches.
 * - anyone else — including the learner themselves — is refused; the page 404s.
 */
export function reportAccess(input: ReportAccessInput): { allowed: boolean; via: "parent" | "teacher" | null } {
  const { viewerId, learnerId } = input;
  if (!viewerId || !learnerId || viewerId === learnerId) return { allowed: false, via: null };
  if (input.parentLinks.some((l) => l.parent_id === viewerId && l.child_id === learnerId)) {
    return { allowed: true, via: "parent" };
  }
  const taught = new Set(input.taughtClasses.filter((c) => c.teacher_id === viewerId).map((c) => c.id));
  if (input.learnerEnrollments.some((e) => e.student_id === learnerId && taught.has(e.class_id))) {
    return { allowed: true, via: "teacher" };
  }
  return { allowed: false, via: null };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const DONE: ReadonlySet<ReportStatus> = new Set(["completed", "revised", "submitted"]);

const KNOWN_PROGRESS: Record<string, ReportStatus> = {
  assigned: "not_started",
  not_started: "not_started",
  in_progress: "in_progress",
  completed: "completed",
  revised: "revised",
};

/** Sort chapter refs numerically when they are numbers ("2" < "10"), lexically otherwise. */
function chapterSort(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** chapter_ref → what a reader calls the chapter: refs are 0-based indices
 * ("0".."25" in prod), people count from 1. Non-numeric refs print verbatim. */
function chapterLabel(ref: string): string {
  const n = Number(ref);
  return Number.isFinite(n) ? String(n + 1) : ref;
}

function summarize(items: ReportItem[]): ReportSummary {
  const scoredItems = items.filter((i) => i.score !== null);
  const averagePct = scoredItems.length
    ? Math.round(scoredItems.reduce((sum, i) => sum + i.score!.pct, 0) / scoredItems.length)
    : null;
  return {
    assigned: items.length,
    completed: items.filter((i) => DONE.has(i.status)).length,
    scored: scoredItems.length,
    averagePct,
  };
}

export function buildProgressReport({
  learnerId,
  learnerClassIds,
  shares,
  generations,
  progress,
  submissions,
}: {
  learnerId: string;
  /** Classes the learner belongs to (from their enrollment rows). */
  learnerClassIds: readonly string[];
  shares: readonly ReportShareRow[];
  generations: readonly ReportGenRow[];
  progress: readonly ReportProgressRow[];
  submissions: readonly ReportSubmissionRow[];
}): ProgressReport {
  const classSet = new Set(learnerClassIds);
  const genOf = new Map(generations.map((g) => [g.id, g]));
  const progOf = new Map(
    progress.filter((p) => p.student_id === learnerId).map((p) => [p.generation_id, p]),
  );
  const subOf = new Map(
    submissions.filter((s) => s.student_id === learnerId).map((s) => [s.generation_id, s]),
  );

  // One report row per generation. A generation shared to the class AND
  // directly to this learner is still one piece of work: merged, keeping the
  // earliest assignment date. For the due date, a direct share addressed to
  // this learner personally outranks the class-wide one — but only when it
  // actually sets a deadline: a due-less personal share must not hide a real
  // class due date on the printout.
  type Merged = { assignedAt: string; dueAt: string | null; dueDirect: boolean };
  const merged = new Map<string, Merged>();
  const duePriority = (direct: boolean, due: string | null) => (due === null ? 0 : direct ? 2 : 1);
  for (const s of shares) {
    const direct = s.student_id === learnerId;
    const viaClass = s.class_id !== null && classSet.has(s.class_id);
    if (!direct && !viaClass) continue;
    const cur = merged.get(s.generation_id);
    if (!cur) {
      merged.set(s.generation_id, { assignedAt: s.created_at, dueAt: s.due_at, dueDirect: direct });
      continue;
    }
    if (s.created_at < cur.assignedAt) cur.assignedAt = s.created_at;
    if (duePriority(direct, s.due_at) > duePriority(cur.dueDirect, cur.dueAt)) {
      cur.dueAt = s.due_at;
      cur.dueDirect = direct;
    }
  }

  const items: ReportItem[] = [];
  for (const [genId, m] of merged) {
    const g = genOf.get(genId);
    // A share whose generation is gone (withdrawn/removed) or teacher-only
    // material (lesson plans) is not the learner's work — say nothing.
    if (!g || g.kind === "lesson_plan") continue;
    const prog = progOf.get(genId);
    const sub = subOf.get(genId);
    // Same resolution the parent portal uses: a submission is the strongest
    // signal, otherwise the progress row's word, otherwise not started.
    const status: ReportStatus = sub ? "submitted" : (KNOWN_PROGRESS[prog?.status ?? ""] ?? "not_started");
    const points = sub ? (sub.teacher_score ?? sub.auto_score) : null;
    const score: ReportScore | null =
      sub && sub.max_score != null && sub.max_score > 0 && points != null
        ? {
            points,
            max: sub.max_score,
            pct: Math.round((100 * points) / sub.max_score),
            gradeStatus: sub.grade_status,
            date: sub.graded_at ?? sub.submitted_at,
          }
        : null;
    items.push({
      generationId: genId,
      title: g.title ?? "",
      kind: g.kind ?? "",
      chapterRef: g.chapter_ref,
      bookId: g.book_id,
      assignedAt: m.assignedAt,
      dueAt: m.dueAt,
      status,
      completedAt: prog?.completed_at ?? sub?.submitted_at ?? null,
      score,
    });
  }
  items.sort((a, b) => a.assignedAt.localeCompare(b.assignedAt) || a.generationId.localeCompare(b.generationId));

  // Group into per-book sections, ordered by each book's earliest assignment
  // (items are already date-sorted, so first-seen order IS that order).
  const sectionOf = new Map<string | null, ReportItem[]>();
  for (const item of items) {
    const key = item.bookId;
    const list = sectionOf.get(key);
    if (list) list.push(item);
    else sectionOf.set(key, [item]);
  }
  const sections: ReportSection[] = [...sectionOf.entries()].map(([bookId, list]) => ({
    bookId,
    items: list,
    chaptersCovered: [...new Set(list.map((i) => i.chapterRef).filter((c): c is string => c !== null))]
      .sort(chapterSort)
      .map(chapterLabel),
    summary: summarize(list),
  }));

  // Activity range: assignments open it; completions, submissions and grading
  // extend it. Due dates are plans, not activity — they don't count.
  const eventDates: string[] = [];
  for (const i of items) {
    eventDates.push(i.assignedAt);
    if (i.completedAt) eventDates.push(i.completedAt);
    if (i.score) eventDates.push(i.score.date);
  }
  eventDates.sort();

  return {
    sections,
    summary: summarize(items),
    firstActivityAt: eventDates[0] ?? null,
    lastActivityAt: eventDates[eventDates.length - 1] ?? null,
    empty: items.length === 0,
  };
}
