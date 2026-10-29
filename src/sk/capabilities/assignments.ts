// SK teacher knowledge tool v1 — assignments.status (Final Plan 2026-10-28 §4
// row 2, §6 S0: "How many finished the quiz" returns the tool's count).
//
// User-session client only (§2.3). The analytics page's own scoping is kept:
// classes are the teacher's OWN (`teacher_id = me`) even when RLS shows a
// school_admin the whole school, and every other table is cut to those
// classes' shares. The numbers come from the pure `assignmentStatus`
// (src/utils/assignment-status.ts), which replicates the page's done / overdue
// / pending-to-grade / completion definitions line for line.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "../shell/types";
import {
  assignmentStatus,
  filterByDue,
  type DueFilter,
  type ShareStatus,
  type StatusEnrollmentRow,
  type StatusProgressRow,
  type StatusShareRow,
  type StatusSubmissionRow,
} from "@/utils/assignment-status";
import { classEnrollments, generationSubjects, teacherClasses, visibleClasses } from "./shared";
// S5 slice A: the principal / coordinator modes (leader-scope.ts).
import { lineFor } from "../shell/lines";
import { S_ASSIGN, S_ASSIGN_NONE, S_EMPTY, S_NO_SCOPE, S_OUT_OF_SCOPE, S_READ_FAILED } from "../shell/school-lines";
import { classInScope, gradeOutsideScope, leaderScope, needsSubjects, sameGrade, scopeLabel, shareInScope, stripEmails, whereLabel, type LeaderScope } from "./leader-scope";
// S5 slice B: a leader mode with school analytics off answers the fixed line.
import { analyticsOffResult } from "@/sk/shell/school-meter";

export const SHARE_ROWS_CAP = 40;
/** `.in()` lists are URL-bound; a teacher with more generations than this gets
 *  the most recent shares' generations only. */
const GEN_IDS_CAP = 200;
/** Leaders: at most this many classes go into one `.in()` list. */
const LEADER_CLASS_IDS_CAP = 200;

type ClassRow = { id: string; name: string | null; teacher_id?: string | null; grade?: string | null; school_id?: string | null };

const rows = <T>(res: { data: unknown; error: { message?: string } | null } | null | undefined, what: string): T[] => {
  if (!res) return [];
  if (res.error) throw new Error(`${what}: ${res.error.message ?? "query failed"}`);
  return (res.data ?? []) as T[];
};

const fail = (e: unknown): SkCapabilityResult => ({
  ok: false,
  summary: "I could not read the assignments right now.",
  error: e instanceof Error ? e.message : String(e),
});

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;

const DUE: readonly DueFilter[] = ["overdue", "today", "week"];

export const assignmentsStatus: SkCapability = {
  meta: {
    name: "assignments.status",
    description:
      "How assignments stand, per class share: assigned, done, not done (with names), overdue, pending to grade, completion %. The teacher's own classes; with the principal hat the whole school, with the coordinator hat the coordinator's scope grades. Optionally one class, one generation, (leaders) one grade, or only those due overdue / today / this week.",
    parameters: {
      type: "object",
      properties: {
        classId: { type: "string", description: "Only this class (a teacher: one of their own)." },
        generationId: { type: "string", description: "Only this kit / quiz / worksheet." },
        due: { type: "string", enum: ["overdue", "today", "week"], description: "Only shares due in this window." },
        grade: { type: "string", description: 'Leaders only: only this grade, e.g. "5" or "Form 2".' },
      },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
  },
  async handler(ctx, args, deps) {
    const me = ctx.user.id;
    const db = deps.session;
    const classId = str(args, "classId");
    const generationId = str(args, "generationId");
    const dueRaw = str(args, "due");
    const due = DUE.find((d) => d === dueRaw);
    // S5: the principal / coordinator hats answer at school / scope level.
    const ls = leaderScope(ctx);
    // S5 slice B: the leader mode needs school analytics (the turn route's
    // gate says so first; this holds for any other caller). Own-class: unchanged.
    if (ls.mode !== "own" && ctx.flags.analytics !== true) return analyticsOffResult(ctx);
    if (ls.mode !== "own") return leaderAssignments(ctx, ls, { classId, generationId, due, grade: str(args, "grade")?.slice(0, 20) }, deps);
    try {
      // Own classes — the scope everything else is cut to. The predicate goes
      // to the DB AND is re-applied here (belt and braces, like risk.ts and
      // resolve.ts): a wide RLS view must never widen the teacher's scope.
      // Read once per turn (shared.ts): context.resolve and assign use the same rows.
      const classes = rows<ClassRow>(await teacherClasses(deps, me), "classes").filter((c) => c.teacher_id === undefined || c.teacher_id === me);
      const myClassIds = new Set(classes.map((c) => c.id));
      const classNames: Record<string, string> = {};
      for (const c of classes) classNames[c.id] = c.name || "Class";
      if (classId && !myClassIds.has(classId)) {
        return { ok: true, summary: "That class is not one of yours, so I have nothing on it.", facts: [], entities: [] };
      }
      const scopeIds = classId ? [classId] : [...myClassIds];
      if (!scopeIds.length) return { ok: true, summary: "You have no classes yet, so nothing is assigned.", facts: [], entities: [] };

      let shares = rows<StatusShareRow>(
        await db
          .from("generation_shares")
          .select("id, generation_id, class_id, due_at, created_at, generations(kind, chapter_ref, title)")
          .in("class_id", scopeIds)
          .order("created_at", { ascending: false }),
        "generation_shares",
      ).filter((s) => s.class_id !== null && myClassIds.has(s.class_id));
      if (generationId) shares = shares.filter((s) => s.generation_id === generationId);
      if (!shares.length) {
        return { ok: true, summary: "Nothing has been assigned to those classes.", facts: [], entities: [] };
      }
      const genIds = [...new Set(shares.map((s) => s.generation_id))].slice(0, GEN_IDS_CAP);
      const genSet = new Set(genIds);
      shares = shares.filter((s) => genSet.has(s.generation_id));

      const [enrQ, progQ, subsQ] = await Promise.all([
        classEnrollments(deps, me, scopeIds),
        db.from("student_progress").select("generation_id, student_id, status").in("generation_id", genIds),
        db.from("submissions").select("generation_id, student_id, grade_status").in("generation_id", genIds),
      ]);
      const enrollments = rows<StatusEnrollmentRow>(enrQ, "enrollments").filter((e) => myClassIds.has(e.class_id));
      const progress = rows<StatusProgressRow>(progQ, "student_progress").filter((p) => genSet.has(p.generation_id));
      const submissions = rows<StatusSubmissionRow>(subsQ, "submissions").filter((s) => genSet.has(s.generation_id));

      const status = assignmentStatus({ shares, enrollments, progress, submissions, classNames, now: deps.now });
      const kept = filterByDue(status.shares, due, deps.now);
      if (!kept.length) {
        return {
          ok: true,
          summary: due ? `No assignments are due ${due === "week" ? "this week" : due}.` : "Nothing has been assigned to those classes.",
          facts: [],
          entities: [],
        };
      }
      const shown = kept.slice(0, SHARE_ROWS_CAP);
      const t = {
        assigned: kept.reduce((n, r) => n + r.assigned, 0),
        done: kept.reduce((n, r) => n + r.done, 0),
        notDone: kept.reduce((n, r) => n + r.notDone, 0),
        overdue: kept.reduce((n, r) => n + r.overdue, 0),
      };
      const pendingToGrade = due ? kept.reduce((n, r) => n + r.pendingToGrade, 0) : status.totals.pendingToGrade;
      const pct = t.assigned ? Math.round((t.done / t.assigned) * 100) : 0;

      const first = shown[0];
      const lead =
        shown.length === 1
          ? `${first.title} (${first.className}): ${first.done} of ${first.assigned} done, ${first.notDone} not done${first.overdue ? ` (${first.overdue} overdue)` : ""}${
              first.pendingToGrade ? `, ${first.pendingToGrade} to grade` : ""
            }${first.notDoneNames.length ? `. Not done: ${first.notDoneNames.join(", ")}` : ""}.`
          : `${kept.length} assignments across ${new Set(kept.map((r) => r.classId)).size} class${new Set(kept.map((r) => r.classId)).size === 1 ? "" : "es"}: ${t.done} of ${t.assigned} done (${pct}%), ${t.notDone} not done, ${t.overdue} overdue, ${pendingToGrade} to grade.`;

      const entities: ResolvedEntity[] = [];
      for (const cid of new Set(shown.map((r) => r.classId))) entities.push({ kind: "class", id: cid, label: classNames[cid] ?? "Class", via: "assignments.status" });
      for (const r of shown.slice(0, 5)) {
        entities.push({ kind: "share", id: r.shareId, label: `${r.title} → ${r.className}`, via: "assignments.status", ids: [r.generationId, r.classId] });
        entities.push({ kind: "generation", id: r.generationId, label: r.title, via: "assignments.status" });
        if (r.notDoneIds.length)
          entities.push({ kind: "learners", id: `not-done:${r.shareId}`, label: `Not done — ${r.title} (${r.className})`, via: "assignments.status", ids: r.notDoneIds });
      }

      return {
        ok: true,
        summary: lead.slice(0, 400),
        facts: shown.map(toFact),
        entities,
      };
    } catch (e) {
      return fail(e);
    }
  },
};

const toFact = (r: ShareStatus) => ({
  shareId: r.shareId,
  generationId: r.generationId,
  classId: r.classId,
  title: r.title,
  kind: r.kind,
  className: r.className,
  assigned: r.assigned,
  done: r.done,
  notDone: r.notDone,
  overdue: r.overdue,
  pendingToGrade: r.pendingToGrade,
  dueAt: r.dueAt,
  completionPct: r.completionPct,
  notDoneNames: r.notDoneNames.join(", "),
});

// ── S5 slice A: the leader modes ─────────────────────────────────────────────

/** assignments.status with the principal hat (the school's classes) or the
 *  coordinator hat (classes of the scope grades — RLS also returns the
 *  coordinator's OWN classes of other grades, which are cut here; a share is
 *  kept only when a scope row matches its class grade and, when that row
 *  names one, its book subject). Same counting as the teacher view. */
export async function leaderAssignments(
  ctx: SkContext,
  ls: LeaderScope,
  q: { classId?: string; generationId?: string; due?: DueFilter; grade?: string },
  deps: SkCapabilityDeps,
): Promise<SkCapabilityResult> {
  const me = ctx.user.id;
  const locale = ctx.user.locale;
  const db = deps.session;
  if (ls.mode === "scope" && !(ls.rows ?? []).length) return { ok: true, summary: lineFor(S_NO_SCOPE, locale), facts: [], entities: [] };
  if (gradeOutsideScope(ls, q.grade)) {
    return { ok: true, summary: lineFor(S_OUT_OF_SCOPE, locale, { grade: whereLabel(ls, locale, q.grade), scope: scopeLabel(ls.rows ?? [], locale) }), facts: [], entities: [] };
  }
  try {
    const scopeRows = ls.rows ?? [];
    const classes = rows<ClassRow>(await visibleClasses(deps, me), "classes").filter(
      (c) =>
        !!ls.schoolId &&
        c.school_id === ls.schoolId &&
        (ls.mode === "school" || classInScope(c.grade, scopeRows)) &&
        (!q.grade || sameGrade(c.grade, q.grade)) &&
        (!q.classId || c.id === q.classId),
    );
    const classSet = new Set(classes.slice(0, LEADER_CLASS_IDS_CAP).map((c) => c.id));
    const gradeOf = new Map(classes.map((c) => [c.id, c.grade ?? null] as const));
    const classNames: Record<string, string> = {};
    for (const c of classes) classNames[c.id] = c.name || "Class";
    const where = q.classId && classNames[q.classId] ? classNames[q.classId] : whereLabel(ls, locale, q.grade);
    if (!classSet.size) return { ok: true, summary: lineFor(S_EMPTY, locale, { where }), facts: [], entities: [] };
    const scopeIds = [...classSet];

    let shares = rows<StatusShareRow>(
      await db
        .from("generation_shares")
        .select("id, generation_id, class_id, due_at, created_at, generations(kind, chapter_ref, title)")
        .in("class_id", scopeIds)
        .order("created_at", { ascending: false }),
      "generation_shares",
    ).filter((s) => s.class_id !== null && classSet.has(s.class_id));
    if (needsSubjects(ls)) {
      const subjectOf = await generationSubjects(deps, me, shares.map((s) => s.generation_id));
      shares = shares.filter((s) => shareInScope(gradeOf.get(s.class_id as string), subjectOf.get(s.generation_id) ?? null, scopeRows));
    }
    if (q.generationId) shares = shares.filter((s) => s.generation_id === q.generationId);
    if (!shares.length) return { ok: true, summary: lineFor(S_ASSIGN_NONE, locale, { where }), facts: [], entities: [] };
    const genIds = [...new Set(shares.map((s) => s.generation_id))].slice(0, GEN_IDS_CAP);
    const genSet = new Set(genIds);
    shares = shares.filter((s) => genSet.has(s.generation_id));

    const [enrQ, progQ, subsQ] = await Promise.all([
      classEnrollments(deps, me, scopeIds),
      db.from("student_progress").select("generation_id, student_id, status").in("generation_id", genIds),
      db.from("submissions").select("generation_id, student_id, grade_status").in("generation_id", genIds),
    ]);
    const enrollments = rows<StatusEnrollmentRow>(enrQ, "enrollments").filter((e) => classSet.has(e.class_id));
    const students = new Set(enrollments.map((e) => e.student_id));
    const progress = rows<StatusProgressRow>(progQ, "student_progress").filter((p) => genSet.has(p.generation_id) && students.has(p.student_id));
    const submissions = rows<StatusSubmissionRow>(subsQ, "submissions").filter((s) => genSet.has(s.generation_id) && students.has(s.student_id));

    const status = assignmentStatus({ shares, enrollments, progress, submissions, classNames, now: deps.now });
    const kept = filterByDue(status.shares, q.due, deps.now);
    if (!kept.length) return { ok: true, summary: lineFor(S_ASSIGN_NONE, locale, { where }), facts: [], entities: [] };
    const shown = kept.slice(0, SHARE_ROWS_CAP - 1);
    const t = {
      assigned: kept.reduce((n, r) => n + r.assigned, 0),
      done: kept.reduce((n, r) => n + r.done, 0),
      notDone: kept.reduce((n, r) => n + r.notDone, 0),
      overdue: kept.reduce((n, r) => n + r.overdue, 0),
    };
    const pendingToGrade = q.due ? kept.reduce((n, r) => n + r.pendingToGrade, 0) : status.totals.pendingToGrade;
    const pct = t.assigned ? Math.round((t.done / t.assigned) * 100) : 0;
    const classCount = new Set(kept.map((r) => r.classId)).size;
    const summary = lineFor(S_ASSIGN, locale, { where, n: kept.length, classes: classCount, done: t.done, assigned: t.assigned, pct, notDone: t.notDone, overdue: t.overdue, pending: pendingToGrade });
    const entities: ResolvedEntity[] = [];
    for (const cid of new Set(shown.map((r) => r.classId))) entities.push({ kind: "class", id: cid, label: classNames[cid] ?? "Class", via: "assignments.status" });
    for (const r of shown.slice(0, 5)) {
      entities.push({ kind: "share", id: r.shareId, label: `${r.title} → ${r.className}`, via: "assignments.status", ids: [r.generationId, r.classId] });
      entities.push({ kind: "generation", id: r.generationId, label: r.title, via: "assignments.status" });
    }
    return stripEmails({
      ok: true,
      summary: summary.slice(0, 900),
      facts: [
        { row: "totals", scope: ls.mode, where, assignments: kept.length, classes: classCount, assigned: t.assigned, done: t.done, notDone: t.notDone, overdue: t.overdue, pendingToGrade, completionPct: pct },
        ...shown.map(toFact),
      ],
      entities,
    });
  } catch (e) {
    return { ok: false, summary: lineFor(S_READ_FAILED, locale), error: e instanceof Error ? e.message : String(e) };
  }
}
