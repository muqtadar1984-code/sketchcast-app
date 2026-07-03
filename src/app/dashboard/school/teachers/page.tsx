import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabled } from "@/utils/flags";

// Layer B — the teacher layer, for leadership. Two things kept distinct:
//   * teacher activity (their OWN output): lessons generated, assignments made,
//     grading backlog/turnaround;
//   * their students' outcomes (class completion).
// Framed as SUPPORT, not a ranking: sorted by who may need help, shown against
// the cohort's own baseline — no leaderboard, no naked scores. Scoped by RLS
// (admin → school; coordinator → slice). Behind FEATURE_SCHOOL_ANALYTICS.

const SLOW_GRADING_DAYS = 7;
const GRADING_BACKLOG = 3;
const BELOW_BASELINE = 15; // completion this many points under the cohort baseline

type TeacherRow = {
  id: string;
  name: string;
  lessons: number;
  assignments: number;
  pending: number;
  turnaroundDays: number | null;
  completionPct: number | null;
  flags: string[];
};

export default async function SchoolTeachersPage() {
  if (!schoolAnalyticsEnabled()) redirect("/dashboard");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .single();
  const role = (profile?.role as string | null) ?? null;
  if (role !== "school_admin" && role !== "coordinator") redirect("/dashboard");
  const displayName = profile?.full_name || user.email || "";

  // ── RLS-scoped reads ────────────────────────────────────────────────────────
  const { data: classesRaw } = await supabase.from("classes").select("id, name, grade, teacher_id");
  const classes = (classesRaw ?? []) as { id: string; name: string; grade: string | null; teacher_id: string }[];

  const { data: enrRaw } = await supabase.from("enrollments").select("class_id, student_id");
  const enr = (enrRaw ?? []) as { class_id: string; student_id: string }[];

  const { data: sharesRaw } = await supabase
    .from("generation_shares")
    .select("generation_id, class_id, shared_by, due_at");
  const shares = (sharesRaw ?? []) as { generation_id: string; class_id: string; shared_by: string; due_at: string | null }[];

  const { data: progRaw } = await supabase.from("student_progress").select("generation_id, student_id, status");
  const prog = (progRaw ?? []) as { generation_id: string; student_id: string; status: string }[];

  const { data: subsRaw } = await supabase
    .from("submissions")
    .select("generation_id, student_id, submitted_at, graded_at, grade_status");
  const subs = (subsRaw ?? []) as { generation_id: string; student_id: string; submitted_at: string; graded_at: string | null; grade_status: string }[];

  const { data: gensRaw } = await supabase.from("generations").select("id, owner_id");
  const gens = (gensRaw ?? []) as { id: string; owner_id: string }[];

  const teacherIds = [...new Set(classes.map((c) => c.teacher_id))];
  const { data: tProfRaw } = await supabase.from("profiles").select("id, full_name, username").in("id", teacherIds.length ? teacherIds : ["00000000-0000-0000-0000-000000000000"]);
  const tProf = (tProfRaw ?? []) as { id: string; full_name: string | null; username: string | null }[];
  const nameOf = new Map(tProf.map((p) => [p.id, p.full_name || p.username || "Teacher"] as const));

  // ── Index ────────────────────────────────────────────────────────────────────
  const genOwner = new Map(gens.map((g) => [g.id, g.owner_id] as const));
  const studentsByClass = new Map<string, string[]>();
  for (const e of enr) {
    if (!studentsByClass.has(e.class_id)) studentsByClass.set(e.class_id, []);
    studentsByClass.get(e.class_id)!.push(e.student_id);
  }
  const statusOf = new Map<string, string>(prog.map((p) => [`${p.generation_id}|${p.student_id}`, p.status]));
  const submittedOf = new Set<string>(subs.map((s) => `${s.generation_id}|${s.student_id}` as string));
  const classesByTeacher = new Map<string, string[]>();
  for (const c of classes) {
    if (!classesByTeacher.has(c.teacher_id)) classesByTeacher.set(c.teacher_id, []);
    classesByTeacher.get(c.teacher_id)!.push(c.id);
  }
  const lessonsByTeacher = new Map<string, number>();
  for (const g of gens) lessonsByTeacher.set(g.owner_id, (lessonsByTeacher.get(g.owner_id) ?? 0) + 1);
  const assignmentsByTeacher = new Map<string, number>();
  for (const s of shares) assignmentsByTeacher.set(s.shared_by, (assignmentsByTeacher.get(s.shared_by) ?? 0) + 1);

  // Grading backlog + turnaround per teacher (via the generation's owner).
  const pendingByTeacher = new Map<string, number>();
  const turnaround = new Map<string, { sum: number; n: number }>();
  const DAY = 86400000;
  for (const s of subs) {
    const owner = genOwner.get(s.generation_id);
    if (!owner) continue;
    if (s.grade_status === "pending") pendingByTeacher.set(owner, (pendingByTeacher.get(owner) ?? 0) + 1);
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

  // Completion of each teacher's own students (assigned set within their classes).
  function teacherCompletion(teacherId: string): { total: number; done: number } {
    let total = 0;
    let done = 0;
    const classSet = new Set(classesByTeacher.get(teacherId) ?? []);
    for (const sh of shares) {
      if (!classSet.has(sh.class_id)) continue;
      for (const stu of studentsByClass.get(sh.class_id) ?? []) {
        total++;
        const key = `${sh.generation_id}|${stu}`;
        if (statusOf.get(key) === "completed" || statusOf.get(key) === "revised" || submittedOf.has(key)) done++;
      }
    }
    return { total, done };
  }

  // Cohort baseline (the scope's overall completion), used for context not ranking.
  let baseTotal = 0;
  let baseDone = 0;
  const rows: TeacherRow[] = [];
  for (const tid of teacherIds) {
    const { total, done } = teacherCompletion(tid);
    baseTotal += total;
    baseDone += done;
    const ta = turnaround.get(tid);
    rows.push({
      id: tid,
      name: nameOf.get(tid) || "Teacher",
      lessons: lessonsByTeacher.get(tid) ?? 0,
      assignments: assignmentsByTeacher.get(tid) ?? 0,
      pending: pendingByTeacher.get(tid) ?? 0,
      turnaroundDays: ta && ta.n ? Math.round((ta.sum / ta.n) * 10) / 10 : null,
      completionPct: total ? Math.round((done / total) * 100) : null,
    } as TeacherRow);
  }
  const baselinePct = baseTotal ? Math.round((baseDone / baseTotal) * 100) : 0;

  // Support flags (need-based, not a score).
  for (const r of rows) {
    const flags: string[] = [];
    if (r.completionPct != null && r.completionPct < baselinePct - BELOW_BASELINE)
      flags.push(`${baselinePct - r.completionPct}pts below cohort`);
    if (r.pending >= GRADING_BACKLOG) flags.push(`${r.pending} to grade`);
    if (r.turnaroundDays != null && r.turnaroundDays > SLOW_GRADING_DAYS) flags.push(`${r.turnaroundDays}d to grade`);
    r.flags = flags;
  }
  // Need-first ordering: flagged teachers on top, then lowest completion. Not a leaderboard.
  rows.sort((a, b) => b.flags.length - a.flags.length || (a.completionPct ?? 101) - (b.completionPct ?? 101));

  // Audit the access (teacher-level view).
  try {
    await supabase.from("analytics_access_log").insert({
      actor_id: user.id,
      actor_role: role,
      school_id: profile?.school_id ?? null,
      scope: "teacher_detail",
      target_kind: "teacher",
      detail: { teachers: rows.length },
    });
  } catch {
    // never block the page on the audit write
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader name={displayName} role={role} />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Teachers</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-6">
          Activity and how each teacher&apos;s students are doing — to spot who could use support
          {baseTotal > 0 && (
            <>
              , against the cohort baseline (
              <span className="tabular text-[#0C8175]">{baselinePct}%</span> completion)
            </>
          )}
          . Not a ranking.
        </p>

        {rows.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">No teachers in this scope yet.</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            <div className="hidden sm:grid grid-cols-[2fr_repeat(4,1fr)] gap-3 px-5 py-2 text-xs text-[#5B6470] font-medium">
              <span>Teacher</span>
              <span className="text-right">Lessons</span>
              <span className="text-right">Assigned</span>
              <span className="text-right">To grade</span>
              <span className="text-right">Completion</span>
            </div>
            {rows.map((r) => (
              <div key={r.id} className="px-5 py-3">
                <div className="grid sm:grid-cols-[2fr_repeat(4,1fr)] gap-x-3 gap-y-1 items-center">
                  <span className="font-medium truncate">{r.name}</span>
                  <span className="tabular sm:text-right text-sm">
                    <span className="sm:hidden text-[#5B6470]">Lessons </span>{r.lessons}
                  </span>
                  <span className="tabular sm:text-right text-sm">
                    <span className="sm:hidden text-[#5B6470]">Assigned </span>{r.assignments}
                  </span>
                  <span className={`tabular sm:text-right text-sm ${r.pending >= GRADING_BACKLOG ? "text-[#9A6400]" : ""}`}>
                    <span className="sm:hidden text-[#5B6470]">To grade </span>{r.pending}
                  </span>
                  <span className="tabular sm:text-right text-sm">
                    <span className="sm:hidden text-[#5B6470]">Completion </span>
                    {r.completionPct == null ? "—" : `${r.completionPct}%`}
                  </span>
                </div>
                {r.flags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <span className="text-xs text-[#5B6470]">may need support:</span>
                    {r.flags.map((f, i) => (
                      <span key={i} className="chip font-sans bg-[#FFF1D6] text-[#9A6400]">{f}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-[#5B6470] mt-4">
          Teachers can see their own school-visible metrics on their Analytics page — the school sees no more about a
          teacher than the teacher can see about themselves.
        </p>
      </main>
    </div>
  );
}
