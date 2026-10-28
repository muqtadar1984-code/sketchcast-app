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

import type { ResolvedEntity, SkCapability, SkCapabilityResult } from "../shell/types";
import { computeSchoolHealth, type HealthRows } from "@/utils/school-health";
import { schoolHealthRows } from "./shared";

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
      "Learners at risk in the teacher's own classes by the school-health rules (low completion, inactive 14+ days, never started, low or declining scores, 2+ overdue), with the reason for each. Optionally one class.",
    parameters: {
      type: "object",
      properties: { classId: { type: "string", description: "Only this class (one of the teacher's own)." } },
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "school_admin", "coordinator"],
  },
  async handler(ctx, args, deps) {
    const me = ctx.user.id;
    const classId = typeof args.classId === "string" && args.classId.trim() ? args.classId.trim() : undefined;
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
