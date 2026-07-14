import type { SupabaseClient } from "@supabase/supabase-js";

// One shared definition of "how is the school doing" — the live snapshot the
// school-briefing assistant answers from. The metric logic and thresholds are a
// faithful port of the two leadership pages (dashboard/school/page.tsx — at-risk
// worklist — and dashboard/school/teachers/page.tsx — teacher workload); if a
// rule changes there, change it here too so the assistant and the dashboards
// never tell the principal two different stories.
//
// Privacy shape: fetchSchoolHealthRows runs on the CALLER'S session client, so
// RLS decides visibility — a school_admin gets the whole school, a coordinator
// gets only their grade/subject slice, everyone else gets nothing. Nothing here
// touches the service role.

// ── Thresholds (mirrors dashboard/school/page.tsx:14-19 + teachers/page.tsx:15-17)
export const INACTIVE_DAYS = 14;
export const LOW_COMPLETION = 0.5;
export const MIN_ASSIGNED = 2;
export const LOW_SCORE = 0.5;
export const DECLINE_DELTA = 0.15;
export const OVERDUE_FLAG = 2;
export const SLOW_GRADING_DAYS = 7;
export const GRADING_BACKLOG = 3;
export const BELOW_BASELINE = 15;

const DAY = 86400000;

export type HealthRows = {
  classes: { id: string; name: string; grade: string | null; teacher_id: string }[];
  enrollments: {
    class_id: string;
    student_id: string;
    full_name: string | null;
    username: string | null;
    parent_email: string | null;
  }[];
  shares: { generation_id: string; class_id: string | null; shared_by: string; due_at: string | null }[];
  progress: { generation_id: string; student_id: string; status: string; updated_at: string }[];
  submissions: {
    generation_id: string;
    student_id: string;
    auto_score: number | null;
    max_score: number | null;
    teacher_score: number | null;
    submitted_at: string;
    graded_at: string | null;
    grade_status: string;
  }[];
  generations: { id: string; owner_id: string }[];
  teacherNames: Record<string, string>;
};

export type SchoolHealth = {
  totals: {
    students: number;
    classes: number;
    teachers: number;
    /** % of students active in the last 14 days; null = no students yet. */
    activePct: number | null;
    /** % of assigned items done; null = nothing assigned yet (≠ measured 0). */
    completionPct: number | null;
    atRisk: number;
    overdue: number;
    pendingToGrade: number;
  };
  atRiskByGrade: { grade: string; count: number }[];
  atRisk: { name: string; className: string; grade: string; reasons: string[]; parentEmail: string | null }[];
  classes: { name: string; grade: string; teacher: string; students: number; completionPct: number | null; overdue: number }[];
  teachers: {
    name: string;
    lessons: number;
    assignments: number;
    pendingToGrade: number;
    avgTurnaroundDays: number | null;
    completionPct: number | null;
    flags: string[];
  }[];
};

/** The superset of both leadership pages' reads, RLS-scoped to the caller. */
export async function fetchSchoolHealthRows(supabase: SupabaseClient): Promise<HealthRows> {
  const [classesQ, enrQ, sharesQ, progQ, subsQ, gensQ] = await Promise.all([
    supabase.from("classes").select("id, name, grade, teacher_id"),
    supabase.from("enrollments").select("class_id, student_id, profiles(full_name, username, parent_email)"),
    supabase.from("generation_shares").select("generation_id, class_id, shared_by, due_at"),
    supabase.from("student_progress").select("generation_id, student_id, status, updated_at"),
    supabase
      .from("submissions")
      .select("generation_id, student_id, auto_score, max_score, teacher_score, submitted_at, graded_at, grade_status"),
    supabase.from("generations").select("id, owner_id"),
  ]);

  const classes = (classesQ.data ?? []) as HealthRows["classes"];
  type EnrRaw = {
    class_id: string;
    student_id: string;
    profiles: { full_name: string | null; username: string | null; parent_email: string | null } | null;
  };
  const enrollments = ((enrQ.data ?? []) as unknown as EnrRaw[]).map((e) => ({
    class_id: e.class_id,
    student_id: e.student_id,
    full_name: e.profiles?.full_name ?? null,
    username: e.profiles?.username ?? null,
    parent_email: e.profiles?.parent_email ?? null,
  }));

  const teacherIds = [...new Set(classes.map((c) => c.teacher_id))];
  const teacherNames: Record<string, string> = {};
  if (teacherIds.length) {
    const { data } = await supabase.from("profiles").select("id, full_name, username").in("id", teacherIds);
    for (const p of (data ?? []) as { id: string; full_name: string | null; username: string | null }[]) {
      teacherNames[p.id] = p.full_name || p.username || "Teacher";
    }
  }

  return {
    classes,
    enrollments,
    shares: (sharesQ.data ?? []) as HealthRows["shares"],
    progress: (progQ.data ?? []) as HealthRows["progress"],
    submissions: (subsQ.data ?? []) as HealthRows["submissions"],
    generations: (gensQ.data ?? []) as HealthRows["generations"],
    teacherNames,
  };
}

// User-editable strings (a student can rename themselves, teachers name their
// classes) end up inside a leadership LLM prompt — neutralize control chars,
// collapse whitespace, and cap length so a crafted name can't smuggle
// instructions into the briefing or bloat the context.
const clean = (s: string | null | undefined, max = 80): string =>
  (s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(new RegExp("[\\x00-\\x1f\\x7f]+", "g"), " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);

/** Pure aggregation — injectable clock so the at-risk rules are unit-testable. */
export function computeSchoolHealth(rows: HealthRows, now: number = Date.now()): SchoolHealth {
  const classMeta = new Map(
    rows.classes.map((c) => [c.id, { name: clean(c.name) || "Class", grade: clean(c.grade, 20) || "—", teacher: c.teacher_id }] as const),
  );
  const studentName = new Map<string, string>();
  const parentEmail = new Map<string, string | null>();
  const studentsByClass = new Map<string, string[]>();
  const classOfStudent = new Map<string, string>();
  const allStudents = new Set<string>();
  for (const e of rows.enrollments) {
    studentName.set(e.student_id, clean(e.full_name) || clean(e.username) || "Student");
    parentEmail.set(e.student_id, e.parent_email ? clean(e.parent_email, 120) : null);
    if (!studentsByClass.has(e.class_id)) studentsByClass.set(e.class_id, []);
    studentsByClass.get(e.class_id)!.push(e.student_id);
    if (!classOfStudent.has(e.student_id)) classOfStudent.set(e.student_id, e.class_id);
    allStudents.add(e.student_id);
  }

  const statusOf = new Map<string, string>(rows.progress.map((p) => [`${p.generation_id}|${p.student_id}`, p.status]));
  const lastActivity = new Map<string, number>();
  const touch = (sid: string, iso: string | null) => {
    if (!iso) return;
    const t = new Date(iso).getTime();
    if (!Number.isNaN(t)) lastActivity.set(sid, Math.max(lastActivity.get(sid) ?? 0, t));
  };
  for (const p of rows.progress) touch(p.student_id, p.updated_at);

  const submittedOf = new Set<string>();
  const scoresByStudent = new Map<string, { pct: number; at: number }[]>();
  for (const s of rows.submissions) {
    submittedOf.add(`${s.generation_id}|${s.student_id}`);
    touch(s.student_id, s.submitted_at);
    const max = s.max_score ?? 0;
    const raw = s.teacher_score ?? s.auto_score;
    if (max > 0 && raw != null) {
      if (!scoresByStudent.has(s.student_id)) scoresByStudent.set(s.student_id, []);
      scoresByStudent.get(s.student_id)!.push({ pct: raw / max, at: new Date(s.submitted_at).getTime() });
    }
  }

  const isDone = (gen: string, stu: string) => {
    const key = `${gen}|${stu}`;
    const st = statusOf.get(key);
    return st === "completed" || st === "revised" || submittedOf.has(key);
  };

  // Assigned instances per student (share × class roster). The class rides
  // along so an overdue item is attributed to the class it was assigned IN —
  // a student enrolled in two classes must not pool their overdue on the first.
  const assignedByStudent = new Map<string, { gen: string; due: string | null; cls: string }[]>();
  for (const sh of rows.shares) {
    if (!sh.class_id) continue; // direct-to-student shares aren't class analytics
    for (const stu of studentsByClass.get(sh.class_id) ?? []) {
      if (!assignedByStudent.has(stu)) assignedByStudent.set(stu, []);
      assignedByStudent.get(stu)!.push({ gen: sh.generation_id, due: sh.due_at, cls: sh.class_id });
    }
  }

  // ── Student-level rollup + at-risk reasons (port of school/page.tsx:156-227) ──
  let assignedTotal = 0;
  let completedTotal = 0;
  let overdueTotal = 0;
  let activeStudents = 0;
  const overdueByClass = new Map<string, number>();
  const atRisk: SchoolHealth["atRisk"] = [];

  for (const stu of allStudents) {
    const items = assignedByStudent.get(stu) ?? [];
    let completed = 0;
    let overdue = 0;
    for (const it of items) {
      assignedTotal++;
      if (isDone(it.gen, stu)) {
        completed++;
        completedTotal++;
      } else if (it.due && new Date(it.due).getTime() < now) {
        overdue++;
        overdueTotal++;
        overdueByClass.set(it.cls, (overdueByClass.get(it.cls) ?? 0) + 1);
      }
    }

    const last = lastActivity.get(stu);
    const inactiveDays = last ? Math.floor((now - last) / DAY) : Infinity;
    if (last && now - last <= INACTIVE_DAYS * DAY) activeStudents++;

    const scores = (scoresByStudent.get(stu) ?? []).slice().sort((a, b) => a.at - b.at);
    const avg = scores.length ? scores.reduce((s, x) => s + x.pct, 0) / scores.length : null;
    let declining = false;
    if (scores.length >= 2) {
      const mid = Math.floor(scores.length / 2);
      const earlier = scores.slice(0, mid);
      const recent = scores.slice(mid);
      const em = earlier.reduce((s, x) => s + x.pct, 0) / earlier.length;
      const rm = recent.reduce((s, x) => s + x.pct, 0) / recent.length;
      declining = rm < em - DECLINE_DELTA;
    }

    const reasons: string[] = [];
    const hasIncomplete = items.length > completed;
    if (items.length >= MIN_ASSIGNED && completed / items.length < LOW_COMPLETION)
      reasons.push(`${Math.round((completed / items.length) * 100)}% completion`);
    if (hasIncomplete && inactiveDays !== Infinity && inactiveDays > INACTIVE_DAYS)
      reasons.push(`inactive ${inactiveDays}d`);
    else if (hasIncomplete && inactiveDays === Infinity && items.length > 0) reasons.push("never started");
    if (avg != null && avg < LOW_SCORE) reasons.push(`avg score ${Math.round(avg * 100)}%`);
    if (declining) reasons.push("scores declining");
    if (overdue >= OVERDUE_FLAG) reasons.push(`${overdue} overdue`);

    if (reasons.length) {
      const cid = classOfStudent.get(stu);
      const cm = cid ? classMeta.get(cid) : undefined;
      atRisk.push({
        name: studentName.get(stu) || "Student",
        className: cm?.name || "—",
        grade: cm?.grade || "—",
        reasons,
        parentEmail: parentEmail.get(stu) ?? null,
      });
    }
  }
  atRisk.sort((a, b) => b.reasons.length - a.reasons.length);

  const byGrade = new Map<string, number>();
  for (const f of atRisk) byGrade.set(f.grade, (byGrade.get(f.grade) ?? 0) + 1);

  // ── Per-class completion ──────────────────────────────────────────────────────
  const classRows: SchoolHealth["classes"] = rows.classes.map((c) => {
    let total = 0;
    let done = 0;
    for (const sh of rows.shares) {
      if (sh.class_id !== c.id) continue;
      for (const stu of studentsByClass.get(c.id) ?? []) {
        total++;
        if (isDone(sh.generation_id, stu)) done++;
      }
    }
    return {
      name: clean(c.name) || "Class",
      grade: clean(c.grade, 20) || "—",
      teacher: clean(rows.teacherNames[c.teacher_id]) || "Teacher",
      students: (studentsByClass.get(c.id) ?? []).length,
      completionPct: total ? Math.round((done / total) * 100) : null,
      overdue: overdueByClass.get(c.id) ?? 0,
    };
  });

  // ── Teacher workload (port of teachers/page.tsx:95-166) ──────────────────────
  const genOwner = new Map(rows.generations.map((g) => [g.id, g.owner_id] as const));
  const classesByTeacher = new Map<string, string[]>();
  for (const c of rows.classes) {
    if (!classesByTeacher.has(c.teacher_id)) classesByTeacher.set(c.teacher_id, []);
    classesByTeacher.get(c.teacher_id)!.push(c.id);
  }
  const lessonsByTeacher = new Map<string, number>();
  for (const g of rows.generations) lessonsByTeacher.set(g.owner_id, (lessonsByTeacher.get(g.owner_id) ?? 0) + 1);
  const assignmentsByTeacher = new Map<string, number>();
  for (const s of rows.shares) assignmentsByTeacher.set(s.shared_by, (assignmentsByTeacher.get(s.shared_by) ?? 0) + 1);

  const pendingByTeacher = new Map<string, number>();
  const turnaround = new Map<string, { sum: number; n: number }>();
  let pendingTotal = 0;
  for (const s of rows.submissions) {
    const owner = genOwner.get(s.generation_id);
    if (!owner) continue;
    if (s.grade_status === "pending") {
      pendingByTeacher.set(owner, (pendingByTeacher.get(owner) ?? 0) + 1);
      pendingTotal++;
    }
    if (s.graded_at) {
      const d = (new Date(s.graded_at).getTime() - new Date(s.submitted_at).getTime()) / DAY;
      if (d >= 0) {
        const t = turnaround.get(owner) ?? { sum: 0, n: 0 };
        t.sum += d;
        t.n++;
        turnaround.set(owner, t);
      }
    }
  }

  const teacherIds = [...new Set(rows.classes.map((c) => c.teacher_id))];
  const teacherCompletion = (tid: string) => {
    let total = 0;
    let done = 0;
    const classSet = new Set(classesByTeacher.get(tid) ?? []);
    for (const sh of rows.shares) {
      if (!sh.class_id || !classSet.has(sh.class_id)) continue;
      for (const stu of studentsByClass.get(sh.class_id) ?? []) {
        total++;
        if (isDone(sh.generation_id, stu)) done++;
      }
    }
    return { total, done };
  };

  let baseTotal = 0;
  let baseDone = 0;
  const teacherRows = teacherIds.map((tid) => {
    const { total, done } = teacherCompletion(tid);
    baseTotal += total;
    baseDone += done;
    const ta = turnaround.get(tid);
    return {
      name: clean(rows.teacherNames[tid]) || "Teacher",
      lessons: lessonsByTeacher.get(tid) ?? 0,
      assignments: assignmentsByTeacher.get(tid) ?? 0,
      pendingToGrade: pendingByTeacher.get(tid) ?? 0,
      avgTurnaroundDays: ta && ta.n ? Math.round((ta.sum / ta.n) * 10) / 10 : null,
      completionPct: total ? Math.round((done / total) * 100) : null,
      flags: [] as string[],
    };
  });
  const baselinePct = baseTotal ? Math.round((baseDone / baseTotal) * 100) : 0;
  for (const r of teacherRows) {
    if (r.completionPct != null && r.completionPct < baselinePct - BELOW_BASELINE)
      r.flags.push(`${baselinePct - r.completionPct}pts below cohort`);
    if (r.pendingToGrade >= GRADING_BACKLOG) r.flags.push(`${r.pendingToGrade} to grade`);
    if (r.avgTurnaroundDays != null && r.avgTurnaroundDays > SLOW_GRADING_DAYS)
      r.flags.push(`${r.avgTurnaroundDays}d to grade`);
  }
  teacherRows.sort((a, b) => b.flags.length - a.flags.length || (a.completionPct ?? 101) - (b.completionPct ?? 101));

  return {
    totals: {
      students: allStudents.size,
      classes: rows.classes.length,
      teachers: teacherIds.length,
      activePct: allStudents.size ? Math.round((activeStudents / allStudents.size) * 100) : null,
      completionPct: assignedTotal ? Math.round((completedTotal / assignedTotal) * 100) : null,
      atRisk: atRisk.length,
      overdue: overdueTotal,
      pendingToGrade: pendingTotal,
    },
    atRiskByGrade: [...byGrade.entries()].map(([grade, count]) => ({ grade, count })).sort((a, b) => b.count - a.count),
    atRisk,
    classes: classRows,
    teachers: teacherRows,
  };
}
