// SK teacher knowledge tool v1 — learners.risk (Final Plan 2026-10-28 §3:
// school-health's at-risk triggers are THE one at-risk definition; §4 row 3:
// the teacher gets them scoped to their own classes).
//
// `fetchSchoolHealthRows` runs on the user-session client (RLS-scoped), then
// the rows are cut to the teacher's OWN classes (`teacher_id = me`) BEFORE
// `computeSchoolHealth` runs, so a school_admin acting as a teacher is judged
// on their classes alone, and a learner's reasons reflect only what THIS
// teacher assigned (a share in another teacher's class is not this teacher's
// business). The rule text ("2 overdue", "inactive 16d", "never started",
// "40% completion", "avg score 30%", "scores declining") is school-health's,
// unchanged, so the teacher and the principal hear the same reasons.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "../shell/types";
import { computeSchoolHealth, type HealthRows } from "@/utils/school-health";
import { generationSubjects, schoolHealthRows } from "./shared";
// S5 slice A: the principal / coordinator modes (leader-scope.ts).
import { lineFor } from "../shell/lines";
import { S_AT_RISK, S_AT_RISK_NONE, S_EMPTY, S_NO_SCOPE, S_OUT_OF_SCOPE, S_READ_FAILED } from "../shell/school-lines";
import { cutLeaderRows, gradeOutsideScope, leaderScope, needsSubjects, scopeLabel, stripEmails, whereLabel, type LeaderScope } from "./leader-scope";
// S5 slice B: a leader mode with school analytics off answers the fixed line.
import { analyticsOffResult } from "@/sk/shell/school-meter";

export const RISK_ROWS_CAP = 30;

const fail = (e: unknown): SkCapabilityResult => ({
  ok: false,
  summary: "I could not read the class data right now.",
  error: e instanceof Error ? e.message : String(e),
});

/** school-health's own name cleaning (not exported there), replicated so a
 *  cleaned at-risk name maps back to the enrollment it came from. */
const clean = (s: string | null | undefined, max = 80): string =>
  (s ?? "")
    .replace(new RegExp("[\\x00-\\x1f\\x7f]+", "g"), " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);

/** Cut the RLS-scoped rows to the classes this teacher owns (optionally one of
 *  them). Pure; exported for the tests. */
export function scopeHealthRows(rows: HealthRows, teacherId: string, classId?: string): HealthRows {
  const own = rows.classes.filter((c) => c.teacher_id === teacherId && (!classId || c.id === classId));
  const ids = new Set(own.map((c) => c.id));
  const enrollments = rows.enrollments.filter((e) => ids.has(e.class_id));
  const students = new Set(enrollments.map((e) => e.student_id));
  const shares = rows.shares.filter((s) => s.class_id !== null && ids.has(s.class_id));
  const gens = new Set(shares.map((s) => s.generation_id));
  return {
    classes: own,
    enrollments,
    shares,
    progress: rows.progress.filter((p) => students.has(p.student_id) && gens.has(p.generation_id)),
    submissions: rows.submissions.filter((s) => students.has(s.student_id) && gens.has(s.generation_id)),
    generations: rows.generations.filter((g) => gens.has(g.id)),
    teacherNames: rows.teacherNames,
  };
}

export const learnersRisk: SkCapability = {
  meta: {
    name: "learners.risk",
    description:
      "Learners at risk by the school-health rules (low completion, inactive 14+ days, never started, low or declining scores, 2+ overdue), with the reason for each: the teacher's own classes; with the principal hat the whole school, with the coordinator hat the coordinator's scope grades. Optionally one class or (leaders) one grade.",
    parameters: {
      type: "object",
      properties: {
        classId: { type: "string", description: "Only this class (a teacher: one of their own)." },
        grade: { type: "string", description: "Leaders only: only this grade, e.g. \"5\" or \"Form 2\"." },
      },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
  },
  async handler(ctx, args, deps) {
    const me = ctx.user.id;
    const classId = typeof args.classId === "string" && args.classId.trim() ? args.classId.trim() : undefined;
    // S5: the principal / coordinator hats answer at school / scope level.
    const ls = leaderScope(ctx);
    // S5 slice B: the leader mode needs school analytics (the turn route's
    // gate says so first; this holds for any other caller). Own-class: unchanged.
    if (ls.mode !== "own" && ctx.flags.analytics !== true) return analyticsOffResult(ctx);
    if (ls.mode !== "own") return leaderRisk(ctx, ls, classId, typeof args.grade === "string" && args.grade.trim() ? args.grade.trim().slice(0, 20) : undefined, deps);
    try {
      // fetchSchoolHealthRows, once per turn (shared.ts) however many classes are asked about.
      const all = await schoolHealthRows(deps, me);
      const rows = scopeHealthRows(all, me, classId);
      if (!rows.classes.length) {
        return {
          ok: true,
          summary: classId ? "That class is not one of yours, so I have nothing on it." : "You have no classes yet.",
          facts: [],
          entities: [],
        };
      }
      const health = computeSchoolHealth(rows, deps.now.getTime());
      const atRisk = health.atRisk.slice(0, RISK_ROWS_CAP);

      // Map the cleaned (name, class) back to learner ids for the entity.
      const classNameById = new Map(rows.classes.map((c) => [c.id, clean(c.name) || "Class"] as const));
      const idsByKey = new Map<string, string[]>();
      for (const e of rows.enrollments) {
        const key = `${clean(e.full_name) || clean(e.username) || "Student"}\u0000${classNameById.get(e.class_id) ?? "—"}`;
        if (!idsByKey.has(key)) idsByKey.set(key, []);
        idsByKey.get(key)!.push(e.student_id);
      }
      const learnerIds: string[] = [];
      for (const r of atRisk) for (const id of idsByKey.get(`${r.name}\u0000${r.className}`) ?? []) if (!learnerIds.includes(id)) learnerIds.push(id);

      const classLabel = classId ? classNameById.get(classId) ?? "that class" : `${rows.classes.length} class${rows.classes.length === 1 ? "" : "es"}`;
      const summary = atRisk.length
        ? `${health.totals.atRisk} at risk in ${classLabel}: ${atRisk
            .slice(0, 6)
            .map((r) => `${r.name}${classId ? "" : ` (${r.className})`} — ${r.reasons.join(", ")}`)
            .join("; ")}${health.totals.atRisk > 6 ? "; …" : ""}.`
        : `Nobody is at risk in ${classLabel} by the school-health rules (${health.totals.students} learners).`;

      const entities: ResolvedEntity[] = rows.classes.map((c) => ({ kind: "class" as const, id: c.id, label: classNameById.get(c.id) ?? "Class", via: "learners.risk" }));
      if (learnerIds.length) entities.push({ kind: "learners", id: `at-risk:${classId ?? me}`, label: `At risk — ${classLabel}`, via: "learners.risk", ids: learnerIds });

      return {
        ok: true,
        summary: summary.slice(0, 400),
        facts: atRisk.map((r) => ({ name: r.name, className: r.className, grade: r.grade, reasons: r.reasons.join(", ") })),
        entities,
      };
    } catch (e) {
      return fail(e);
    }
  },
};

// ── S5 slice A: the leader modes ─────────────────────────────────────────────

/** learners.risk with the principal hat (the school) or the coordinator hat
 *  (the scope grades, intersected in code — never the coordinator's own
 *  out-of-scope classes). Names within that reach (decision 2); no email. */
export async function leaderRisk(ctx: SkContext, ls: LeaderScope, classId: string | undefined, grade: string | undefined, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const me = ctx.user.id;
  const locale = ctx.user.locale;
  if (ls.mode === "scope" && !(ls.rows ?? []).length) return { ok: true, summary: lineFor(S_NO_SCOPE, locale), facts: [], entities: [] };
  if (gradeOutsideScope(ls, grade)) {
    return { ok: true, summary: lineFor(S_OUT_OF_SCOPE, locale, { grade: whereLabel(ls, locale, grade), scope: scopeLabel(ls.rows ?? [], locale) }), facts: [], entities: [] };
  }
  try {
    const all = await schoolHealthRows(deps, me);
    const subjectOf = needsSubjects(ls) ? await generationSubjects(deps, me, all.shares.map((s) => s.generation_id)) : undefined;
    const rows = cutLeaderRows(all, ls, { classId, grade, subjectOf });
    const classNameById = new Map(rows.classes.map((c) => [c.id, clean(c.name) || "Class"] as const));
    const where = classId && classNameById.has(classId) ? classNameById.get(classId)! : whereLabel(ls, locale, grade);
    if (!rows.classes.length) return { ok: true, summary: lineFor(S_EMPTY, locale, { where }), facts: [], entities: [] };
    const health = computeSchoolHealth(rows, deps.now.getTime());
    const atRisk = health.atRisk.slice(0, RISK_ROWS_CAP);

    const idsByKey = new Map<string, string[]>();
    for (const e of rows.enrollments) {
      const key = `${clean(e.full_name) || clean(e.username) || "Student"}\u0000${classNameById.get(e.class_id) ?? "—"}`;
      if (!idsByKey.has(key)) idsByKey.set(key, []);
      idsByKey.get(key)!.push(e.student_id);
    }
    const learnerIds: string[] = [];
    for (const r of atRisk) for (const id of idsByKey.get(`${r.name}\u0000${r.className}`) ?? []) if (!learnerIds.includes(id)) learnerIds.push(id);

    const summary = atRisk.length
      ? lineFor(S_AT_RISK, locale, {
          where,
          n: health.totals.atRisk,
          items: `${atRisk
            .slice(0, 6)
            .map((r) => `${r.name} (${r.className}) — ${r.reasons.join(", ")}`)
            .join("; ")}${health.totals.atRisk > 6 ? "; …" : ""}`,
        })
      : lineFor(S_AT_RISK_NONE, locale, { where, students: health.totals.students });
    const entities: ResolvedEntity[] = rows.classes.slice(0, 15).map((c) => ({ kind: "class" as const, id: c.id, label: classNameById.get(c.id) ?? "Class", via: "learners.risk" }));
    if (learnerIds.length) entities.push({ kind: "learners", id: `at-risk:${ls.mode}:${classId ?? grade ?? ls.schoolId ?? me}`, label: `At risk — ${where}`, via: "learners.risk", ids: learnerIds });
    return stripEmails({
      ok: true,
      summary: summary.slice(0, 900),
      facts: atRisk.map((r) => ({ name: r.name, className: r.className, grade: r.grade, reasons: r.reasons.join(", ") })),
      entities,
    });
  } catch (e) {
    return { ok: false, summary: lineFor(S_READ_FAILED, locale), error: e instanceof Error ? e.message : String(e) };
  }
}
