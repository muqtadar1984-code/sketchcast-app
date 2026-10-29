// SK S5 slice A — which rows a LEADER may be answered from (design 2026-10-29,
// decisions 2 and 8; Final Plan §4: "coordinator = principal reads within scope").
//
// Three modes, decided by ONE pure function, `leaderScope(ctx)`:
//   own    — the teacher hat, or no leader hat: the S0 behaviour, unchanged
//            (the teacher's own classes; risk.ts scopeHealthRows).
//   school — the principal hat AND profiles.role = school_admin: every RLS row
//            of the user's own school (cut to `school_id = ctx.user.schoolId`).
//   scope  — the coordinator hat: the RLS rows INTERSECTED IN CODE with the
//            classes whose grade is in ctx.user.coordinatorScope (and, for a
//            share, the book's subject when the matching scope row names one).
//
// Why the intersect: a coordinator is also a teacher. RLS hands them the union
// of `coordinates_*` (their scope) AND `owns_class` (their own classes, any
// grade), so "the RLS rows" of a grade-5 coordinator who teaches a grade-6
// class include that grade-6 class. The scope mode drops it here; the
// production dry run (PR body) counts exactly those rows.
//
// Everything here is PURE and only ever NARROWS what RLS returned: a row RLS
// did not return cannot appear, whatever the grade spelling.

import type { SkCapabilityResult, SkContext } from "@/sk/shell/types";
import type { HealthRows } from "@/utils/school-health";
import { isRelevant } from "@/utils/school-books";
import { lineFor } from "@/sk/shell/lines";
import { S_WHERE_GRADE, S_WHERE_SCHOOL } from "@/sk/shell/school-lines";

export type LeaderMode = "own" | "school" | "scope";
/** One coordinator_scope row, normalised: a grade, and a subject or null (= all). */
export type ScopeRow = { grade: string; subject: string | null };
export type LeaderScope = {
  mode: LeaderMode;
  schoolId: string | null;
  /** scope mode: the distinct scope grades. */
  grades?: string[];
  /** scope mode: the distinct non-null scope subjects. */
  subjects?: string[];
  /** scope mode: the rows themselves (a subject narrows only its own grade). */
  rows?: ScopeRow[];
};

const trimmed = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
const folded = (s: string | null | undefined): string => trimmed(s).toLowerCase();

/** The coordinator_scope rows, normalised: blank grades dropped (the column is
 *  NOT NULL; a blank one could only widen nothing), duplicates collapsed. */
export function scopeRowsOf(scope: SkContext["user"]["coordinatorScope"]): ScopeRow[] {
  const out: ScopeRow[] = [];
  const seen = new Set<string>();
  for (const r of scope ?? []) {
    const grade = trimmed(r.grade);
    if (!grade) continue;
    const subject = trimmed(r.subject) || null;
    const key = `${folded(grade)}|${folded(subject)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ grade, subject });
  }
  return out;
}

/**
 * THE mode decision. Pure.
 *
 * `hatless: "leader"` is for the leader-only capability (school.health): with
 * hats switched off (hat null) the registry shows it to a school_admin or a
 * scope holder by role alone, so it must still answer at the leader level
 * rather than fall back to "own". Every S0 read keeps the default ("own").
 */
export function leaderScope(ctx: SkContext, opts: { hatless?: "own" | "leader" } = {}): LeaderScope {
  const u = ctx.user;
  const schoolId = u.schoolId ?? null;
  const adult = u.role !== "student" && u.role !== "parent";
  const principal = u.role === "school_admin" && !!schoolId;
  const scope = (): LeaderScope => {
    const rows = adult && schoolId ? scopeRowsOf(u.coordinatorScope) : [];
    return {
      mode: "scope",
      schoolId,
      rows,
      grades: [...new Set(rows.map((r) => r.grade))],
      subjects: [...new Set(rows.map((r) => r.subject).filter((s): s is string => !!s))],
    };
  };
  if (u.hat === "principal") return principal ? { mode: "school", schoolId } : { mode: "own", schoolId };
  // A coordinator hat with no usable rows is still the scope mode: it then
  // matches NOTHING (fail closed), never the whole school.
  if (u.hat === "coordinator") return adult ? scope() : { mode: "own", schoolId };
  if (u.hat === null && opts.hatless === "leader") {
    if (principal) return { mode: "school", schoolId };
    if (adult && scopeRowsOf(u.coordinatorScope).length) return scope();
  }
  return { mode: "own", schoolId };
}

/** Does a class grade match a scope (or asked-for) grade? Exact match after
 *  case/space folding (what RLS's `cs.grade = c.grade` matches), or the same
 *  normalised level via school-books' rule ("5" = "Grade 5" = "Year 5";
 *  "Form 1" = "Tingkatan 1"; "Form 5" is NOT "5"). */
export function sameGrade(classGrade: string | null | undefined, wanted: string | null | undefined): boolean {
  const a = folded(classGrade);
  const b = folded(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  return isRelevant({ grade: trimmed(classGrade), subject: null }, { grades: [trimmed(wanted)], subjects: [] });
}

/** Does a book subject match a scope subject? Case-insensitive equality, or the
 *  same canonical subject via school-books' table ("Sains" = "Science"). A
 *  missing book subject never matches (RLS: `cs.subject = b.subject` is false
 *  for a null subject). */
export function sameSubject(bookSubject: string | null | undefined, scopeSubject: string | null | undefined): boolean {
  const a = folded(bookSubject);
  const b = folded(scopeSubject);
  if (!a || !b) return false;
  if (a === b) return true;
  return isRelevant({ grade: null, subject: trimmed(bookSubject) }, { grades: [], subjects: [trimmed(scopeSubject)] });
}

/** Is a class (by grade) inside the scope? Any scope row with that grade. */
export function classInScope(grade: string | null | undefined, rows: ScopeRow[]): boolean {
  return rows.some((r) => sameGrade(grade, r.grade));
}

/** Is a share inside the scope? A scope row of the class's grade whose subject
 *  is null (all subjects) or matches the shared generation's book subject. */
export function shareInScope(classGrade: string | null | undefined, bookSubject: string | null | undefined, rows: ScopeRow[]): boolean {
  return rows.some((r) => sameGrade(classGrade, r.grade) && (r.subject === null || sameSubject(bookSubject, r.subject)));
}

/** True when some scope row names a subject, i.e. shares need their book's subject. */
export function needsSubjects(ls: LeaderScope): boolean {
  return ls.mode === "scope" && (ls.rows ?? []).some((r) => r.subject !== null);
}

export type LeaderCutOptions = {
  /** Only this class (it must survive the cut). */
  classId?: string;
  /** Only classes of this grade ("grade 5", "Form 2", "tahun 5"). */
  grade?: string;
  /** generation id → its book's subject (scope rows with a subject need it). */
  subjectOf?: Map<string, string | null>;
};

/**
 * Cut school-health's RLS rows to the leader's school or scope. Pure. Throws
 * on mode "own" (that is risk.ts scopeHealthRows, unchanged).
 *
 * school: classes of the user's school; their enrollments and class shares;
 *         the progress and submissions of those learners; the generations
 *         shared to those classes or owned by their teachers.
 * scope:  classes of a scope grade (of the user's school); the shares whose
 *         class grade AND book subject match one scope row; progress and
 *         submissions of in-scope learners ON in-scope generations only (a
 *         subject-scoped coordinator never sees another subject's scores).
 */
export function cutLeaderRows(rows: HealthRows, ls: LeaderScope, opts: LeaderCutOptions = {}): HealthRows {
  if (ls.mode === "own") throw new Error("cutLeaderRows: own mode is scopeHealthRows");
  const scopeRows = ls.rows ?? [];
  const classes = rows.classes.filter(
    (c) =>
      !!ls.schoolId &&
      c.school_id === ls.schoolId &&
      (ls.mode === "school" || classInScope(c.grade, scopeRows)) &&
      (!opts.grade || sameGrade(c.grade, opts.grade)) &&
      (!opts.classId || c.id === opts.classId),
  );
  const classIds = new Set(classes.map((c) => c.id));
  const gradeOf = new Map(classes.map((c) => [c.id, c.grade] as const));
  const enrollments = rows.enrollments.filter((e) => classIds.has(e.class_id));
  const students = new Set(enrollments.map((e) => e.student_id));
  const shares = rows.shares.filter(
    (s) =>
      s.class_id !== null &&
      classIds.has(s.class_id) &&
      (ls.mode === "school" || shareInScope(gradeOf.get(s.class_id), opts.subjectOf?.get(s.generation_id) ?? null, scopeRows)),
  );
  const gens = new Set(shares.map((s) => s.generation_id));
  const teachers = new Set(classes.map((c) => c.teacher_id));
  const teacherNames: Record<string, string> = {};
  for (const id of teachers) if (rows.teacherNames[id] !== undefined) teacherNames[id] = rows.teacherNames[id];
  if (ls.mode === "school") {
    return {
      classes,
      enrollments,
      shares,
      progress: rows.progress.filter((p) => students.has(p.student_id)),
      submissions: rows.submissions.filter((s) => students.has(s.student_id)),
      generations: rows.generations.filter((g) => gens.has(g.id) || teachers.has(g.owner_id)),
      teacherNames,
    };
  }
  return {
    classes,
    enrollments,
    shares,
    progress: rows.progress.filter((p) => students.has(p.student_id) && gens.has(p.generation_id)),
    submissions: rows.submissions.filter((s) => students.has(s.student_id) && gens.has(s.generation_id)),
    generations: rows.generations.filter((g) => gens.has(g.id)),
    teacherNames,
  };
}

// ── The email boundary (decision 2: "never parents' emails") ────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_KEY_RE = /e-?mail/i;

const scrub = (s: string): string => s.replace(EMAIL_RE, "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();

/**
 * Strip every email from a leader read's result: any fact key that names an
 * email (parentEmail, parent_email, email …) is dropped, and any value or
 * summary text that contains an address has it removed (a learner whose
 * username IS an email address must not leak through the name either).
 * Applied at the capability boundary of every school/scope answer.
 */
export function stripEmails(r: SkCapabilityResult): SkCapabilityResult {
  const out: SkCapabilityResult = { ...r, summary: scrub(r.summary) };
  if (r.facts) {
    out.facts = r.facts.map((f) => {
      const g: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(f)) {
        if (EMAIL_KEY_RE.test(k)) continue;
        g[k] = typeof v === "string" ? scrub(v) : v;
      }
      return g;
    });
  }
  if (r.entities) out.entities = r.entities.map((e) => ({ ...e, label: scrub(e.label) }));
  return out;
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** "grade 5" for a bare number, the stored text otherwise ("Form 1"). */
export function gradeLabel(grade: string, locale: string): string {
  const g = trimmed(grade);
  return /^\d{1,2}$/.test(g) ? lineFor(S_WHERE_GRADE, locale, { grade: g }) : g;
}

/** The coordinator's scope in words: "grade 5", "grade 5 (Science), Form 2". */
export function scopeLabel(rows: ScopeRow[], locale: string): string {
  return rows.map((r) => `${gradeLabel(r.grade, locale)}${r.subject ? ` (${r.subject})` : ""}`).join(", ");
}

/** What {where} says: the school, the asked-for grade, or the scope. */
export function whereLabel(ls: LeaderScope, locale: string, grade?: string): string {
  if (grade) return gradeLabel(grade, locale);
  if (ls.mode === "scope") return scopeLabel(ls.rows ?? [], locale);
  return lineFor(S_WHERE_SCHOOL, locale);
}

/** An asked-for grade a coordinator does not hold. */
export function gradeOutsideScope(ls: LeaderScope, grade: string | undefined): boolean {
  return !!grade && ls.mode === "scope" && !classInScope(grade, ls.rows ?? []);
}
