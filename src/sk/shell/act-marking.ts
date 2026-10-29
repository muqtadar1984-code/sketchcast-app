// SK Shell — executing `marking.grade` from a VERIFIED token row (S2 slice B).
//
// act-core's consumeThenWrite: the stored params are shape-checked and the
// score bounds validated BEFORE the consume (0 ≤ score ≤ out_of, out_of a
// whole number > 0 — a malformed row is refused, nothing is burned), the
// token is consumed through the admin RPC, then the grade is written AS THE
// TEACHER through the user-session client:
//   1. re-read the submission and its generation (hers? still pending?) —
//      not visible / not her kit → refused; already graded → already_used;
//   2. GradeList's own row (grade-update.ts buildGradeUpdate) against the
//      LIVE row (an interactive quiz keeps its auto-scorer max; a file or
//      max-less row takes the card's "out of" as max_score);
//   3. update … where id = ? and grade_status = 'pending' returning id — 0
//      rows = someone graded it in between → already_used ("That one is
//      already graded."); 42501 → refused. RLS sub_teacher_grade decides.
// submissions has no sk_action_id column (0169 does not add one): the
// `grade_status = 'pending'` guard IS the idempotence — a repeat write matches
// no row.
//
// After a grade, SK offers the next one: marking.next's own queue read, once.

import type { ResolvedEntity } from "./types";
import type { ActionTokenRow } from "./tokens";
import { consumeThenWrite, fail, failedStage, str, writeFailure, type ActInput, type Handled, type WriteOutcome } from "./act-core";
import { lineFor } from "./lines";
import { ACT_WRITE_FAILED, MARK_ALL_DONE, MARK_ALREADY_GRADED, MARK_GRADED, MARK_OFFER_NEXT } from "./act-lines";
import { buildGradeUpdate, needsOutOf } from "@/app/dashboard/grade-update";
import { FEEDBACK_MAX, capFirst, markingQueue, submissionEntity } from "@/sk/capabilities/marking";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badParams = () => fail("refused", undefined, { reason: "bad_params" });

type SubRow = { id: string; generation_id: string; student_id: string; mode: string; grade_status: string; max_score: number | null };
const rowsOrThrow = <T>(res: unknown, what: string): T[] => {
  const r = res as { data?: unknown; error?: { message?: string } | null } | null;
  if (r?.error) throw new Error(`${what}: ${r.error.message ?? "query failed"}`);
  return (Array.isArray(r?.data) ? r!.data : []) as T[];
};

/** The card's params, checked: what a well-formed marking.grade row carries. */
export function gradeParams(p: Record<string, unknown>): { id: string; score: number; outOf: number; feedback: string } | null {
  const id = typeof p.submission_id === "string" && UUID_RE.test(p.submission_id) ? p.submission_id : null;
  const score = typeof p.score === "number" && Number.isFinite(p.score) ? p.score : null;
  const outOf = typeof p.out_of === "number" && Number.isInteger(p.out_of) ? p.out_of : null;
  const feedback = p.feedback === null || p.feedback === undefined ? "" : typeof p.feedback === "string" ? p.feedback.trim() : null;
  if (!id || score === null || outOf === null || feedback === null) return null;
  if (outOf <= 0 || score < 0 || score > outOf || feedback.length > FEEDBACK_MAX) return null;
  return { id, score, outOf, feedback };
}

export async function runMarkingGrade(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  const g = gradeParams(row.params ?? {});
  if (!g) return badParams();
  if (!input.session) return fail("error", undefined, undefined, "error:no_session");
  const { ctx } = input;
  const me = ctx.user.id;
  const locale = ctx.user.locale;
  const learner = str(row.params?.learner_label) || "the learner";

  const r = await consumeThenWrite(input.admin, input.session, row, ctx, async (db): Promise<WriteOutcome<{ id: string }>> => {
    const sub = rowsOrThrow<SubRow>(await db.from("submissions").select("id, generation_id, student_id, mode, grade_status, max_score").eq("id", g.id), "submissions").find((s) => s.id === g.id);
    if (!sub) return { ok: false, outcome: "refused", reason: "not_permitted" };
    const own = rowsOrThrow<{ id: string; owner_id: string }>(await db.from("generations").select("id, owner_id").eq("id", sub.generation_id).eq("owner_id", me), "generations").some((x) => x.id === sub.generation_id && x.owner_id === me);
    if (!own) return { ok: false, outcome: "refused", reason: "not_permitted" };
    if (sub.grade_status !== "pending") return { ok: false, outcome: "already_used", reason: "already_graded" };
    const target = { mode: sub.mode, max: sub.max_score };
    // The card's "out of" must still be the row's own total when it has one.
    if (!needsOutOf(target) && sub.max_score !== g.outOf) return { ok: false, outcome: "refused", reason: "out_of_changed" };
    const built = buildGradeUpdate(target, { score: String(g.score), outOf: String(g.outOf), feedback: g.feedback }, me, input.now);
    if (!built.ok) return { ok: false, outcome: "refused", reason: "bad_params", error: built.error };
    const res = (await db.from("submissions").update(built.update).eq("id", g.id).eq("grade_status", "pending").select("id")) as { data?: unknown; error?: unknown };
    if (res?.error) return writeFailure(res.error);
    const hit = Array.isArray(res?.data) ? (res.data as Array<{ id?: string }>).find((x) => x?.id === g.id) : undefined;
    if (!hit) return { ok: false, outcome: "already_used", reason: "already_graded" };
    return { ok: true, value: { id: g.id } };
  });
  if (r.stage === "write" && !r.result.ok && r.result.outcome === "already_used" && r.result.reason === "already_graded") {
    return fail("already_used", lineFor(MARK_ALREADY_GRADED, locale), undefined, "already_used:already_graded");
  }
  const failed = failedStage(r, lineFor(ACT_WRITE_FAILED, locale));
  if (failed) return failed;

  // Offer the next one: the queue, once (a failed read just skips the offer).
  const graded = lineFor(MARK_GRADED, locale, { learner, score: g.score, outOf: g.outOf });
  let offer = "";
  const entities: ResolvedEntity[] = [];
  try {
    const next = (await markingQueue(ctx, { session: input.session, now: input.now }, { excludeIds: [g.id] }))[0];
    if (next) {
      offer = lineFor(MARK_OFFER_NEXT, locale, { what: capFirst(next.what) });
      entities.push(submissionEntity(next, "marking.grade"));
    } else offer = lineFor(MARK_ALL_DONE, locale);
  } catch (e) {
    console.error("sk-act marking next read", (e as Error)?.message);
  }
  return {
    response: {
      ok: true,
      outcome: "done",
      summary: offer ? `${graded} ${offer}` : graded,
      result: { submission_id: g.id, score: g.score, out_of: g.outOf, next_submission_id: entities[0]?.id ?? null },
    },
    entities,
  };
}
