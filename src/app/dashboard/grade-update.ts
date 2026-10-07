// The row GradeList writes when a teacher saves a mark. Kept apart from the
// component so the rules are testable without a DOM.
//
// Every reader of a submission's mark (parent My Children, the three Diary
// views, the printable report, school health / at-risk) shows or uses
// `teacher_score ?? auto_score` only over a truthy `max_score`. An interactive
// quiz carries its own max from the auto-scorer; a FILE upload is written with
// max_score = NULL (student-item.tsx, pinned there by RLS 0091) because only
// the teacher knows what the paper was out of. So a file row must be graded
// with an "out of", or the mark reaches nobody.

export type GradeTarget = { mode: string; max: number | null };

export type GradeUpdate = {
  teacher_score: number;
  max_score?: number;
  feedback: string | null;
  grade_status: "graded";
  graded_by: string | null;
  graded_at: string;
};

// A file row has no max of its own; the teacher's "out of" becomes it. So does
// any row whose max is missing or 0 (a mark over 0 means nothing to a reader).
// An interactive row with a real max keeps the auto-scorer's — never overwritten.
export function needsOutOf(row: GradeTarget): boolean {
  return row.mode === "file" || !(row.max != null && row.max > 0);
}

export function buildGradeUpdate(
  row: GradeTarget,
  input: { score: string | undefined; outOf: string | undefined; feedback: string | undefined },
  graderId: string | null,
  now: Date = new Date(),
): { ok: true; update: GradeUpdate } | { ok: false; error: string } {
  const scoreRaw = (input.score ?? "").trim();
  if (scoreRaw === "") return { ok: false, error: "Enter a score first." };
  const score = Number(scoreRaw);
  if (!Number.isFinite(score) || score < 0) return { ok: false, error: "Score must be a number of 0 or more." };

  const askOutOf = needsOutOf(row);
  let max = row.max ?? 0;
  if (askOutOf) {
    const outRaw = (input.outOf ?? "").trim();
    if (outRaw === "") return { ok: false, error: "Enter what the work is marked out of." };
    max = Number(outRaw);
    if (!Number.isFinite(max) || max <= 0) return { ok: false, error: "“Out of” must be more than 0." };
  }
  if (score > max) return { ok: false, error: `Score can’t be more than ${max}.` };

  const update: GradeUpdate = {
    teacher_score: score,
    feedback: input.feedback?.trim() || null,
    grade_status: "graded",
    graded_by: graderId,
    graded_at: now.toISOString(),
  };
  if (askOutOf) update.max_score = max;
  return { ok: true, update };
}
