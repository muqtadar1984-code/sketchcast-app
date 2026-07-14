import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabledFor, schoolAssistantEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { SchoolAssistantCard } from "./school-assistant";

// School analytics — leadership oversight, scoped by RLS (school_admin/principal
// → whole school; coordinator → their grade/subject slice). Build order #1: the
// AT-RISK WORKLIST (surface students who need SUPPORT, not a ranking). Reuses the
// teacher metric definitions (assigned set = shares × enrollments ⋈ progress ⋈
// submissions), rolled up. Gated behind FEATURE_SCHOOL_ANALYTICS.

// At-risk rules, derived only from signals we already capture. Tunable.
const INACTIVE_DAYS = 14; // no progress/submission activity in this many days
const LOW_COMPLETION = 0.5; // completed / assigned below this
const MIN_ASSIGNED = 2; // ignore completion for students with too little assigned
const LOW_SCORE = 0.5; // average assessment score below this
const DECLINE_DELTA = 0.15; // recent average this much below earlier average
const OVERDUE_FLAG = 2; // this many overdue items

const DAY = 86400000;

type Flagged = {
  studentId: string;
  name: string;
  className: string;
  grade: string;
  parentEmail: string | null;
  reasons: string[];
};

export default async function SchoolAnalyticsPage() {
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
  // Global env flag OR this school's config override (the sales-demo tenant).
  if (!(await schoolAnalyticsEnabledFor(supabase, profile?.school_id as string | null)))
    redirect("/dashboard");
  const role = (profile?.role as string | null) ?? null;
  if (!role || role === "student") redirect("/dashboard");
  // One-hat mode: the School pages belong to the leadership hats.
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "leadership");
  if (hatAway) redirect(hatAway);
  // The briefing assistant rides its own per-tenant gate on top of the suite.
  const assistantOn = await schoolAssistantEnabledFor(supabase, profile?.school_id as string | null);
  const isAdmin = role === "school_admin";

  // Coordinator access is a GRANT (coordinator_scope rows), not an identity —
  // a teacher holding scope rows gets the coordinator view of their slice and
  // keeps their teacher dashboard. No grant and not an admin → no page.
  let scopeLabel = "Whole school";
  let isCoordinator = false;
  if (!isAdmin) {
    const { data: scopes } = await supabase.from("coordinator_scope").select("grade, subject");
    isCoordinator = (scopes?.length ?? 0) > 0;
    if (!isCoordinator) redirect("/dashboard");
    const grades = [...new Set((scopes ?? []).map((s) => s.grade as string))];
    const subjects = [...new Set((scopes ?? []).map((s) => s.subject).filter(Boolean))] as string[];
    scopeLabel =
      (grades.length ? `Grade ${grades.join(", ")}` : "Your grades") +
      (subjects.length ? ` · ${subjects.join(", ")}` : "");
  }

  // ── RLS-scoped reads (the policies return only in-scope rows per role) ──────
  const { data: classesRaw } = await supabase.from("classes").select("id, name, grade");
  const classes = (classesRaw ?? []) as { id: string; name: string; grade: string | null }[];

  type EnrRow = {
    class_id: string;
    student_id: string;
    profiles: { full_name: string | null; username: string | null; parent_email: string | null } | null;
  };
  const { data: enrRaw } = await supabase
    .from("enrollments")
    .select("class_id, student_id, profiles(full_name, username, parent_email)");
  const enr = (enrRaw ?? []) as unknown as EnrRow[];

  type ShareRow = { generation_id: string; class_id: string; due_at: string | null };
  const { data: sharesRaw } = await supabase
    .from("generation_shares")
    .select("generation_id, class_id, due_at");
  const shares = (sharesRaw ?? []) as ShareRow[];

  type ProgRow = { generation_id: string; student_id: string; status: string; updated_at: string };
  const { data: progRaw } = await supabase
    .from("student_progress")
    .select("generation_id, student_id, status, updated_at");
  const prog = (progRaw ?? []) as ProgRow[];

  type SubRow = {
    generation_id: string;
    student_id: string;
    auto_score: number | null;
    max_score: number | null;
    teacher_score: number | null;
    submitted_at: string;
  };
  const { data: subsRaw } = await supabase
    .from("submissions")
    .select("generation_id, student_id, auto_score, max_score, teacher_score, submitted_at");
  const subs = (subsRaw ?? []) as SubRow[];

  // ── Index ──────────────────────────────────────────────────────────────────
  const classMeta = new Map(classes.map((c) => [c.id, { name: c.name, grade: c.grade || "—" }] as const));
  const studentName = new Map<string, string>();
  const parentEmail = new Map<string, string | null>();
  const studentsByClass = new Map<string, string[]>();
  const classOfStudent = new Map<string, string>(); // first in-scope class (for labelling)
  const allStudents = new Set<string>();
  for (const e of enr) {
    studentName.set(e.student_id, e.profiles?.full_name || e.profiles?.username || "Student");
    parentEmail.set(e.student_id, e.profiles?.parent_email ?? null);
    if (!studentsByClass.has(e.class_id)) studentsByClass.set(e.class_id, []);
    studentsByClass.get(e.class_id)!.push(e.student_id);
    if (!classOfStudent.has(e.student_id)) classOfStudent.set(e.student_id, e.class_id);
    allStudents.add(e.student_id);
  }

  const statusOf = new Map<string, string>(prog.map((p) => [`${p.generation_id}|${p.student_id}`, p.status]));
  const lastActivity = new Map<string, number>();
  const touch = (sid: string, iso: string | null) => {
    if (!iso) return;
    const t = new Date(iso).getTime();
    if (!Number.isNaN(t)) lastActivity.set(sid, Math.max(lastActivity.get(sid) ?? 0, t));
  };
  for (const p of prog) touch(p.student_id, p.updated_at);

  const submittedOf = new Set<string>();
  const scoresByStudent = new Map<string, { pct: number; at: number }[]>();
  for (const s of subs) {
    submittedOf.add(`${s.generation_id}|${s.student_id}`);
    touch(s.student_id, s.submitted_at);
    const max = s.max_score ?? 0;
    const raw = s.teacher_score ?? s.auto_score;
    if (max > 0 && raw != null) {
      if (!scoresByStudent.has(s.student_id)) scoresByStudent.set(s.student_id, []);
      scoresByStudent.get(s.student_id)!.push({ pct: raw / max, at: new Date(s.submitted_at).getTime() });
    }
  }

  // Assigned instances per student (gen × the classes they're in).
  const assignedByStudent = new Map<string, { gen: string; due: string | null }[]>();
  for (const sh of shares) {
    for (const stu of studentsByClass.get(sh.class_id) ?? []) {
      if (!assignedByStudent.has(stu)) assignedByStudent.set(stu, []);
      assignedByStudent.get(stu)!.push({ gen: sh.generation_id, due: sh.due_at });
    }
  }

  // ── Aggregate + flag ────────────────────────────────────────────────────────
  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  let assignedTotal = 0;
  let completedTotal = 0;
  let overdueTotal = 0;
  let activeStudents = 0;
  const flagged: Flagged[] = [];

  for (const stu of allStudents) {
    const items = assignedByStudent.get(stu) ?? [];
    let completed = 0;
    let overdue = 0;
    for (const it of items) {
      const key = `${it.gen}|${stu}`;
      const done = statusOf.get(key) === "completed" || statusOf.get(key) === "revised" || submittedOf.has(key);
      assignedTotal++;
      if (done) {
        completed++;
        completedTotal++;
      } else if (it.due && new Date(it.due).getTime() < now) {
        overdue++;
        overdueTotal++;
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
      flagged.push({
        studentId: stu,
        name: studentName.get(stu) || "Student",
        className: cm?.name || "—",
        grade: cm?.grade || "—",
        parentEmail: parentEmail.get(stu) ?? null,
        reasons,
      });
    }
  }
  flagged.sort((a, b) => b.reasons.length - a.reasons.length);

  const completionPct = assignedTotal ? Math.round((completedTotal / assignedTotal) * 100) : 0;
  const activePct = allStudents.size ? Math.round((activeStudents / allStudents.size) * 100) : 0;

  // At-risk counts per grade (the aggregate principals see).
  const byGrade = new Map<string, number>();
  for (const f of flagged) byGrade.set(f.grade, (byGrade.get(f.grade) ?? 0) + 1);

  // ── DPDP audit trail: record this leadership view ───────────────────────────
  try {
    await supabase.from("analytics_access_log").insert({
      actor_id: user.id,
      actor_role: role,
      school_id: profile?.school_id ?? null,
      scope: isCoordinator ? "at_risk" : "school_health",
      target_kind: isCoordinator ? "student" : "school",
      detail: { at_risk: flagged.length, students: allStudents.size },
    });
  } catch {
    // Logging must never break the page; a missing audit row is recoverable.
  }

  // "—" for rates that have no denominator yet — no-data-yet ≠ measured zero.
  const metrics: { label: string; value: string | number; tone?: "warn" }[] = [
    { label: "Students", value: allStudents.size },
    { label: "Active (14d)", value: allStudents.size ? `${activePct}%` : "—" },
    { label: "Completion", value: assignedTotal ? `${completionPct}%` : "—" },
    { label: "At-risk", value: flagged.length, tone: "warn" },
    { label: "Overdue", value: overdueTotal },
  ];

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">School analytics</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">
          <span className="chip bg-[#E2F4F1] text-[#0C8175] mr-2">{scopeLabel}</span>
          Signals that prompt support — not a ranking.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-10">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
              <div className="text-xs text-[#5B6470]">{m.label}</div>
              <div className={`text-2xl tabular mt-0.5 ${m.tone === "warn" && Number(m.value) > 0 ? "text-[#9A6400]" : ""}`}>
                {m.value}
              </div>
            </div>
          ))}
        </div>

        {assistantOn && <SchoolAssistantCard />}

        <h2 className="text-xl mb-1">Students needing support</h2>
        <p className="text-sm text-[#5B6470] mb-3">
          Flagged by low/declining completion, falling scores, or inactivity — the worklist to act on first.
        </p>

        {flagged.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">
            No students flagged in this scope. 🎉
          </div>
        ) : isCoordinator ? (
          // Coordinator: the named, actionable worklist within their slice.
          <div className="card divide-y divide-[#EEF0EC]">
            {flagged.map((f) => (
              <div key={f.studentId} className="px-5 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-medium">
                    {f.name} <span className="text-[#5B6470] font-normal text-sm">· {f.className}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {f.reasons.map((r, i) => (
                      <span key={i} className="chip font-sans bg-[#FFF1D6] text-[#9A6400]">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
                {f.parentEmail && (
                  <a
                    href={`mailto:${f.parentEmail}?subject=${encodeURIComponent(`Check-in about ${f.name}`)}`}
                    className="btn-ghost h-9 px-3 text-sm whitespace-nowrap shrink-0"
                  >
                    Contact parent
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          // Principal/Admin: aggregate-first (DPDP) — counts by grade, not open
          // profiling. Coordinators see and act on the named students in-slice.
          <div className="card divide-y divide-[#EEF0EC]">
            {[...byGrade.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([grade, n]) => (
                <div key={grade} className="px-5 py-3 flex items-center justify-between">
                  <span className="font-medium">Grade {grade}</span>
                  <span className="tabular text-[#9A6400]">{n} at-risk</span>
                </div>
              ))}
            <div className="px-5 py-3 text-xs text-[#5B6470]">
              Names live in the grade/subject coordinator&apos;s worklist, so support stays close to the student.
              As principal you can also ask the school briefing above for names and reasons — every briefing is
              recorded in the access audit.
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
