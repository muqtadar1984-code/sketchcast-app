// Worksheet practice — the GRADED-QUIZ HOLDBACK (SK student Board plan
// 2026-10-31, phase 4 fix; founder default). Server only.
//
// The worksheet a student practises on the Board is the SAME paper her
// teacher (or parent) assigned as an interactive quiz: one questions.json,
// marked by /api/quiz/submit into her `submissions` row. So the help ladder's
// third rung — "here is the answer" — would hand her the key to a quiz that
// still counts. The rule:
//
//   The key is HELD while the paper is her graded quiz, she has NOT handed it
//   in, and it is NOT past due. While held, rung 3 shows the worked step again
//   plus "The answer unlocks after you hand in your quiz"; the key, the
//   paper's explanation (which may restate it) and any model-written
//   explanation are never sent.
//
//   * "her graded quiz"  = one of HER generation_shares rows names the paper
//                          (a share to a class she is enrolled in, or a direct
//                          share to her) — exactly isAssignedToStudent, the
//                          quiz route's own rule. A paper that is not assigned
//                          to her is not her quiz (the practice route only
//                          reaches here for assigned papers anyway).
//   * "handed in"        = a submissions row for (paper, her) with a
//                          submitted_at — an interactive attempt OR a file
//                          upload: both are her hand-in, and the teacher marks
//                          from it. After the FIRST hand-in the key unlocks
//                          (the quiz allows retakes; the founder's rule is
//                          "not yet submitted", so a retake is not protected).
//   * "past due"         = EVERY share of the paper to her carries a due date
//                          and the LATEST of them has passed. A share with no
//                          due date keeps the quiz open, so the key stays held
//                          until she hands it in. (The latest, not the earliest
//                          My lessons shows: a paper shared twice is still
//                          open on the later deadline — the safe reading for a
//                          leak.)
//
// FAIL CLOSED: a read that errors holds the key (the worked step is still
// help; a leaked key cannot be taken back).

import type { DbRow, SkDb } from "@/sk/store-supabase";

export type QuizKeyState = {
  /** Shares of the paper that reach her (class she is in, or direct). */
  dues: (string | null)[];
  /** Her submissions row's submitted_at, when there is one. */
  submittedAt: string | null;
};

export type HoldReason = "not_assigned" | "handed_in" | "past_due" | "open";

/** Pure: is the key held, and why. */
export function keyHeld(s: QuizKeyState | null, now: number): { held: boolean; reason: HoldReason | "unknown" } {
  if (!s) return { held: true, reason: "unknown" };
  if (s.dues.length === 0) return { held: false, reason: "not_assigned" };
  if (s.submittedAt) return { held: false, reason: "handed_in" };
  const times = s.dues.map((d) => (d ? Date.parse(d) : NaN));
  if (times.every((t) => Number.isFinite(t)) && Math.max(...times) < now) return { held: false, reason: "past_due" };
  return { held: true, reason: "open" };
}

/**
 * Read the paper's quiz state for her (service role; her id is the verified
 * session's). Null when any read fails — the caller then HOLDS the key.
 */
export async function loadQuizKeyState(db: SkDb, studentId: string, generationId: string): Promise<QuizKeyState | null> {
  try {
    const [direct, shares, enrolled, sub] = await Promise.all([
      db.from("generation_shares").select("due_at, student_id").eq("generation_id", generationId).eq("student_id", studentId),
      db.from("generation_shares").select("due_at, class_id").eq("generation_id", generationId),
      db.from("enrollments").select("class_id").eq("student_id", studentId),
      db.from("submissions").select("submitted_at").eq("generation_id", generationId).eq("student_id", studentId).maybeSingle(),
    ]);
    for (const r of [direct, shares, enrolled, sub] as { error?: unknown }[]) if (r?.error) return null;
    const mine = new Set(((enrolled as { data?: DbRow[] | null }).data ?? []).map((r) => String(r.class_id)));
    const dues: (string | null)[] = [];
    for (const r of ((direct as { data?: DbRow[] | null }).data ?? []) as DbRow[]) dues.push(typeof r.due_at === "string" ? r.due_at : null);
    for (const r of ((shares as { data?: DbRow[] | null }).data ?? []) as DbRow[]) {
      if (typeof r.class_id === "string" && r.class_id && mine.has(r.class_id)) dues.push(typeof r.due_at === "string" ? r.due_at : null);
    }
    const at = (sub as { data?: DbRow | null }).data?.submitted_at;
    return { dues, submittedAt: typeof at === "string" && at ? at : null };
  } catch {
    return null;
  }
}
