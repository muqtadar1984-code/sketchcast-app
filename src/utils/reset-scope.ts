// Who may reset whose password — the PURE decision for /api/reset-password.
// The route gathers rows (profiles, enrollments, parent_links, coordinator
// grants, platform staff) and hands plain data here, so the whole allow/deny
// matrix is unit-testable without a database.
//
// Rules (first match wins), after the never-allow guards:
//   teacher      — target is a student enrolled in a class the caller teaches
//   parent       — a parent_links row (parent_id = caller, child_id = target)
//   school_admin — caller is a school_admin and the target is a non-admin
//                  member of the same school
//   coordinator  — caller holds coordinator_scope grades (coordinator is a
//                  GRANT here, not just the role enum — see /api/coordinators)
//                  and the target is a student in the caller's school enrolled
//                  in a class of a granted grade
// Never allowed: yourself, any school_admin target, any platform-staff target,
// and student callers can reset nobody.

export type ResetActor = {
  id: string;
  role: string | null; // profiles.role
  schoolId: string | null; // profiles.school_id
};

export type ResetTarget = {
  id: string;
  role: string | null;
  schoolId: string | null;
  /** target has an unrevoked platform_admins row */
  isPlatformAdmin: boolean;
};

export type ResetEvidence = {
  /** target is a student enrolled in a class with classes.teacher_id = caller */
  targetInCallerClass: boolean;
  /** a parent_links row (parent_id = caller, child_id = target) exists */
  parentLinked: boolean;
  /** grades from the caller's coordinator_scope rows in their school */
  coordinatorGrades: string[];
  /** grades of the caller-school classes the target is enrolled in */
  targetGradesInCallerSchool: string[];
};

export type ResetVia = "teacher" | "parent" | "school_admin" | "coordinator";

export type ResetDecision =
  | { allowed: true; via: ResetVia }
  | { allowed: false; reason: string };

const deny = (reason: string): ResetDecision => ({ allowed: false, reason });

export function decideReset(
  caller: ResetActor,
  target: ResetTarget,
  ev: ResetEvidence,
): ResetDecision {
  // ── Never-allow guards — checked before any rule can grant ────────────────
  if (target.id === caller.id) return deny("self");
  if (target.isPlatformAdmin) return deny("target is platform staff");
  if (target.role === "school_admin") return deny("school_admin accounts are never resettable");
  if (!caller.role || caller.role === "student") return deny("caller cannot reset passwords");

  // (a) teacher — owns a class the student is enrolled in.
  if (target.role === "student" && ev.targetInCallerClass) {
    return { allowed: true, via: "teacher" };
  }

  // (b) parent — linked to this child.
  if (ev.parentLinked) return { allowed: true, via: "parent" };

  // (c) school_admin — any non-admin member of their own school.
  if (
    caller.role === "school_admin" &&
    caller.schoolId !== null &&
    target.schoolId === caller.schoolId
  ) {
    return { allowed: true, via: "school_admin" };
  }

  // (d) coordinator grant — student in the caller's school, in a granted grade.
  // Grade match mirrors the 0009 RLS policies (exact string equality).
  if (
    target.role === "student" &&
    caller.schoolId !== null &&
    target.schoolId === caller.schoolId &&
    ev.coordinatorGrades.some((g) => g && ev.targetGradesInCallerSchool.includes(g))
  ) {
    return { allowed: true, via: "coordinator" };
  }

  return deny("no relationship grants access to this account");
}
