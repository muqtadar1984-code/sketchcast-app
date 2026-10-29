// SK Shell — executing the S2 slice A actions (`diary.note`, `parents.remind`)
// from a VERIFIED token row. Both follow act-core's `consumeThenWrite`: the
// stored params are shape-checked (a malformed row is refused BEFORE the
// consume — a server fault, like 0164's wrong_action), the token is consumed
// through the admin RPC, and the diary_notes insert runs AS THE TEACHER through
// the user-session client with sk_action_id = token id. 0066's `dn_insert`
// (author = me, and I teach the class / the student) decides standing; 0169's
// unique index (sk_action_id, coalesce(student_id, class_id)) makes a repeat
// write fail → "That was already done."
//
// `parents.remind` re-verifies at EXECUTION time, through the session: the
// class is still the teacher's own, the share still exists for that class and
// kit, each learner is still enrolled and still not done. Finished learners
// are left out and named in the line; nobody left → ok, nothing written.

import type { ResolvedEntity, SkSessionDb } from "./types";
import type { ActionTokenRow } from "./tokens";
import { ACT_NOT_ALLOWED_LINE, consumeThenWrite, fail, failedStage, str, writeFailure, type ActInput, type Handled, type WriteOutcome } from "./act-core";
import { lineFor } from "./lines";
import { ACT_WRITE_FAILED, DIARY_POSTED, REMIND_LEFT_OUT_DONE, REMIND_LEFT_OUT_GONE, REMIND_NONE_LEFT, REMIND_SENT, REMIND_SENT_ONE } from "./act-lines";
import { DIARY_BODY_MAX, DIARY_NOTE_TYPES, diaryDayKey, isParentWriter, isRealDay } from "@/sk/capabilities/diary";
import { isVerifiedChild } from "@/sk/capabilities/child-scope";
import { REMIND_MAX } from "@/sk/capabilities/remind";
import { assignmentStatus, type StatusEnrollmentRow, type StatusProgressRow, type StatusSubmissionRow } from "@/utils/assignment-status";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const badParams = () => fail("refused", undefined, { reason: "bad_params" });
const noSession = () => fail("error", undefined, undefined, "error:no_session");

type Row = Record<string, unknown>;
const rowsOrThrow = <T>(res: unknown, what: string): T[] => {
  const r = res as { data?: unknown; error?: { message?: string } | null } | null;
  if (r?.error) throw new Error(`${what}: ${r.error.message ?? "query failed"}`);
  return (Array.isArray(r?.data) ? r!.data : []) as T[];
};

// ── diary.note ───────────────────────────────────────────────────────────────

export async function runDiaryNote(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  const p = row.params ?? {};
  const classId = isId(p.class_id) ? p.class_id : null;
  const studentId = isId(p.student_id) ? p.student_id : null;
  const body = typeof p.body === "string" ? p.body.trim() : "";
  const noteType = DIARY_NOTE_TYPES.find((t) => t === p.note_type);
  const entryDate = typeof p.entry_date === "string" && isRealDay(p.entry_date) ? p.entry_date : null;
  if ((classId ? 1 : 0) + (studentId ? 1 : 0) !== 1 || !body || body.length > DIARY_BODY_MAX || !noteType || !entryDate || typeof p.parents_only !== "boolean") return badParams();
  if (!input.session) return noSession();
  const { ctx } = input;
  const label = str(p.target_label) || (classId ? "the class" : "the learner");

  const r = await consumeThenWrite(input.admin, input.session, row, ctx, async (db: SkSessionDb, actionId: string): Promise<WriteOutcome<{ id: string }>> => {
    const res = (await db
      .from("diary_notes")
      .insert({
        author_id: ctx.user.id,
        class_id: classId,
        student_id: studentId,
        note_type: noteType,
        body,
        parents_only: p.parents_only === true,
        entry_date: entryDate,
        sk_action_id: actionId,
      })
      .select("id")
      .single()) as { data?: { id?: string } | null; error?: unknown };
    if (res?.error || !res?.data?.id) return writeFailure(res?.error);
    return { ok: true, value: { id: String(res.data.id) } };
  });
  const failed = failedStage(r, lineFor(ACT_WRITE_FAILED, ctx.user.locale));
  if (failed) return failed;
  const noteId = r.stage === "write" && r.result.ok ? r.result.value.id : null;
  const entities: ResolvedEntity[] = [{ kind: classId ? "class" : "learner", id: (classId ?? studentId)!, label, via: "diary.note" }];
  return {
    response: {
      ok: true,
      outcome: "done",
      summary: lineFor(DIARY_POSTED, ctx.user.locale, { target: label }),
      result: { note_id: noteId, ...(classId ? { class_id: classId } : { student_id: studentId }), entry_date: entryDate, parents_only: p.parents_only === true },
    },
    entities,
  };
}

/**
 * S4 slice C: the diary.note entry point /api/sk/act dispatches to. A PARENT's
 * stored params are re-checked against the LIVE context BEFORE anything is
 * consumed: exactly one student_id, no class, and that student one of
 * ctx.children's VERIFIED links (a link removed or unverified since the card,
 * or a row naming someone else's child, is refused here). The write itself is
 * runDiaryNote, unchanged; a teacher goes straight to it, as before.
 */
export async function runDiaryNoteChecked(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  if (isParentWriter(input.ctx)) {
    const p = row.params ?? {};
    const studentId = isId(p.student_id) ? p.student_id : null;
    const hasClass = p.class_id !== undefined && p.class_id !== null && p.class_id !== "";
    if (hasClass || !studentId || !isVerifiedChild(input.ctx, studentId)) return fail("refused", ACT_NOT_ALLOWED_LINE, { reason: "not_your_child" });
  }
  return runDiaryNote(row, input);
}

// ── parents.remind ───────────────────────────────────────────────────────────

type RemindValue = { sent: string[]; finishedNames: string[]; gone: number };

export async function runParentsRemind(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  const p = row.params ?? {};
  const shareId = isId(p.share_id) ? p.share_id : null;
  const generationId = isId(p.generation_id) ? p.generation_id : null;
  const classId = isId(p.class_id) ? p.class_id : null;
  const ids = typeof p.student_ids === "string" ? [...new Set(p.student_ids.split(",").map((s) => s.trim()).filter(Boolean))] : [];
  const body = typeof p.body === "string" ? p.body.trim() : "";
  if (!shareId || !generationId || !classId || !ids.length || ids.length > REMIND_MAX || !ids.every(isId) || p.count !== ids.length || !body || body.length > DIARY_BODY_MAX) return badParams();
  if (!input.session) return noSession();
  const { ctx } = input;
  const me = ctx.user.id;
  const className = str(p.class_name) || "the class";
  const kitTitle = str(p.kit_title) || "the kit";

  const r = await consumeThenWrite(input.admin, input.session, row, ctx, async (db: SkSessionDb, actionId: string): Promise<WriteOutcome<RemindValue>> => {
    // Re-verify through the session, at execution time.
    const own = rowsOrThrow<Row>(await db.from("classes").select("id, teacher_id").eq("id", classId).eq("teacher_id", me), "classes");
    if (!own.some((c) => c.id === classId && c.teacher_id === me)) return { ok: false, outcome: "refused", reason: "class_not_owned" };
    const share = rowsOrThrow<Row>(await db.from("generation_shares").select("id, generation_id, class_id").eq("id", shareId), "generation_shares");
    if (!share.some((s) => s.id === shareId && s.generation_id === generationId && s.class_id === classId)) return { ok: false, outcome: "refused", reason: "share_gone" };
    const [enrQ, progQ, subsQ] = await Promise.all([
      db.from("enrollments").select("class_id, student_id, profiles(full_name, username)").eq("class_id", classId).in("student_id", ids),
      db.from("student_progress").select("generation_id, student_id, status").eq("generation_id", generationId).in("student_id", ids),
      db.from("submissions").select("generation_id, student_id, grade_status").eq("generation_id", generationId).in("student_id", ids),
    ]);
    const wanted = new Set(ids);
    const enrollments = rowsOrThrow<StatusEnrollmentRow>(enrQ, "enrollments").filter((e) => e.class_id === classId && wanted.has(e.student_id));
    const progress = rowsOrThrow<StatusProgressRow>(progQ, "student_progress").filter((x) => x.generation_id === generationId);
    const submissions = rowsOrThrow<StatusSubmissionRow>(subsQ, "submissions").filter((x) => x.generation_id === generationId);
    const status = assignmentStatus({
      shares: [{ id: shareId, generation_id: generationId, class_id: classId, due_at: null }],
      enrollments,
      progress,
      submissions,
      classNames: { [classId]: className },
      now: input.now,
    }).shares[0];
    const notDone = new Set(status?.notDoneIds ?? []);
    const enrolled = new Set(enrollments.map((e) => e.student_id));
    const keep = ids.filter((id) => enrolled.has(id) && notDone.has(id));
    const finishedNames = enrollments
      .filter((e) => !notDone.has(e.student_id))
      .map((e) => (e.profiles?.full_name || e.profiles?.username || "Student").trim());
    const gone = ids.filter((id) => !enrolled.has(id)).length;
    if (!keep.length) return { ok: true, value: { sent: [], finishedNames, gone } };

    const entryDate = diaryDayKey(input.now);
    const res = (await db
      .from("diary_notes")
      .insert(keep.map((student_id) => ({ author_id: me, class_id: null, student_id, note_type: "reminder", body, parents_only: true, entry_date: entryDate, sk_action_id: actionId })))
      .select("id, student_id")) as { data?: unknown; error?: unknown };
    if (res?.error || !Array.isArray(res?.data)) return writeFailure(res?.error);
    return { ok: true, value: { sent: keep, finishedNames, gone } };
  });
  const failed = failedStage(r, lineFor(ACT_WRITE_FAILED, ctx.user.locale));
  if (failed) return failed;
  const v = r.stage === "write" && r.result.ok ? r.result.value : { sent: [], finishedNames: [], gone: 0 };

  const locale = ctx.user.locale;
  const parts: string[] = [];
  if (!v.sent.length) parts.push(lineFor(REMIND_NONE_LEFT, locale));
  else parts.push(v.sent.length === 1 ? lineFor(REMIND_SENT_ONE, locale) : lineFor(REMIND_SENT, locale, { n: v.sent.length }));
  if (v.sent.length && v.finishedNames.length) parts.push(lineFor(REMIND_LEFT_OUT_DONE, locale, { names: v.finishedNames.slice(0, 5).join(", ") + (v.finishedNames.length > 5 ? ` +${v.finishedNames.length - 5}` : "") }));
  if (v.gone) parts.push(lineFor(REMIND_LEFT_OUT_GONE, locale, { n: v.gone }));
  return {
    response: {
      ok: true,
      outcome: "done",
      summary: parts.join(" "),
      result: { sent: v.sent.length, skipped_done: v.finishedNames.length, skipped_not_in_class: v.gone, share_id: shareId, class_id: classId, generation_id: generationId },
    },
    entities: [
      { kind: "class", id: classId, label: className, via: "parents.remind" },
      { kind: "generation", id: generationId, label: kitTitle, via: "parents.remind" },
    ],
  };
}
