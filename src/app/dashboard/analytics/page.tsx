import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import GradeList, { type PendingSub } from "../grade-list";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabled } from "@/utils/flags";

const KIND_LABEL: Record<string, string> = {
  presentation: "Lesson",
  worksheet: "Worksheet",
  exam_paper: "Exam",
  activity: "Activities",
  case_study: "Case study",
};

// Teacher analytics — everything in one place: headline metrics, per-class
// completion, revision hotspots (topics students re-open most), and a grading
// queue. All from the assigned set (shares × enrollments) ⋈ progress ⋈ submissions.
export default async function AnalyticsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", user.id)
    .single();
  const role = (profile?.role as string | null) ?? null;
  if (role === "student") redirect("/dashboard");

  const { data: classesRaw } = await supabase
    .from("classes")
    .select("id, name")
    .order("created_at", { ascending: false });
  const classes = (classesRaw ?? []) as { id: string; name: string }[];

  type EnrRow = { class_id: string; student_id: string; profiles: { full_name: string | null; username: string | null } | null };
  const { data: enrRaw } = await supabase
    .from("enrollments")
    .select("class_id, student_id, profiles(full_name, username)");
  const enr = (enrRaw ?? []) as unknown as EnrRow[];

  type ShareRow = { generation_id: string; class_id: string; due_at: string | null; generations: { kind: string; chapter_ref: string | null; title: string | null } | null };
  const { data: sharesRaw } = await supabase
    .from("generation_shares")
    .select("generation_id, class_id, due_at, generations(kind, chapter_ref, title)");
  const shares = (sharesRaw ?? []) as unknown as ShareRow[];

  type ProgRow = { generation_id: string; student_id: string; status: string };
  const { data: progRaw } = await supabase
    .from("student_progress")
    .select("generation_id, student_id, status");
  const prog = (progRaw ?? []) as ProgRow[];

  type SubRow = { id: string; generation_id: string; student_id: string; mode: string; grade_status: string; auto_score: number | null; max_score: number | null };
  const { data: subsRaw } = await supabase
    .from("submissions")
    .select("id, generation_id, student_id, mode, grade_status, auto_score, max_score");
  const subs = (subsRaw ?? []) as SubRow[];

  // ── Index the raw rows ──────────────────────────────────────────────────
  const studentName = new Map<string, string>();
  const studentsByClass = new Map<string, string[]>();
  const allStudents = new Set<string>();
  for (const e of enr) {
    studentName.set(e.student_id, e.profiles?.full_name || e.profiles?.username || "Student");
    if (!studentsByClass.has(e.class_id)) studentsByClass.set(e.class_id, []);
    studentsByClass.get(e.class_id)!.push(e.student_id);
    allStudents.add(e.student_id);
  }
  const genInfo = new Map<string, { kind: string; chapter_ref: string | null; title: string | null }>();
  for (const s of shares) if (s.generations) genInfo.set(s.generation_id, s.generations);
  const className = new Map(classes.map((c) => [c.id, c.name] as const));
  const statusOf = new Map<string, string>(prog.map((p) => [`${p.generation_id}|${p.student_id}`, p.status]));
  const submittedOf = new Set<string>(subs.map((s) => `${s.generation_id}|${s.student_id}`));

  const genLabel = (gid: string): string => {
    const g = genInfo.get(gid);
    if (!g) return "Item";
    const kind = KIND_LABEL[g.kind] ?? g.kind;
    return g.chapter_ref != null ? `${kind} · Ch ${Number(g.chapter_ref) + 1}` : g.title || kind;
  };

  // ── Aggregate over assigned instances (each gen × each enrolled student) ──
  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  let total = 0;
  let completed = 0;
  let overdue = 0;
  const perClass = new Map<string, { name: string; total: number; completed: number }>();
  for (const s of shares) {
    for (const stu of studentsByClass.get(s.class_id) ?? []) {
      total++;
      const key = `${s.generation_id}|${stu}`;
      const done = statusOf.get(key) === "completed" || statusOf.get(key) === "revised" || submittedOf.has(key);
      const pc = perClass.get(s.class_id) ?? { name: className.get(s.class_id) || "Class", total: 0, completed: 0 };
      pc.total++;
      if (done) {
        completed++;
        pc.completed++;
      } else if (s.due_at && new Date(s.due_at).getTime() < now) {
        overdue++;
      }
      perClass.set(s.class_id, pc);
    }
  }

  const revByGen = new Map<string, number>();
  for (const p of prog) if (p.status === "revised") revByGen.set(p.generation_id, (revByGen.get(p.generation_id) ?? 0) + 1);
  const hotspots = [...revByGen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([gid, n]) => ({ label: genLabel(gid), n }));

  const pending: PendingSub[] = subs
    .filter((s) => s.grade_status === "pending")
    .map((s) => ({ id: s.id, studentName: studentName.get(s.student_id) || "Student", label: genLabel(s.generation_id), mode: s.mode, auto: s.auto_score, max: s.max_score }));

  const completionPct = total ? Math.round((completed / total) * 100) : 0;
  const metrics: { label: string; value: string | number }[] = [
    { label: "Classes", value: classes.length },
    { label: "Students", value: allStudents.size },
    { label: "Assignments", value: shares.length },
    // "—" until something is assigned: a measured 0% and no-data-yet are different stories.
    { label: "Completion", value: total ? `${completionPct}%` : "—" },
    { label: "Overdue", value: overdue },
    { label: "To grade", value: pending.length },
  ];

  // What the school sees about this teacher (transparency — only when the school
  // analytics feature is on). The same activity metrics leadership sees, computed
  // from the teacher's OWN data, so there are no surprises.
  let schoolView: { label: string; value: string | number }[] | null = null;
  if (schoolAnalyticsEnabled()) {
    const { count: lessons } = await supabase
      .from("generations")
      .select("*", { count: "exact", head: true })
      .eq("owner_id", user.id);
    const { data: gradedRaw } = await supabase
      .from("submissions")
      .select("submitted_at, graded_at")
      .not("graded_at", "is", null);
    const graded = (gradedRaw ?? []) as { submitted_at: string; graded_at: string | null }[];
    let tSum = 0;
    let tN = 0;
    for (const g of graded) {
      if (!g.graded_at) continue;
      const d = (new Date(g.graded_at).getTime() - new Date(g.submitted_at).getTime()) / 86400000;
      if (d >= 0) {
        tSum += d;
        tN++;
      }
    }
    schoolView = [
      { label: "Lessons made", value: lessons ?? 0 },
      { label: "Assignments", value: shares.length },
      { label: "Grading turnaround", value: tN ? `${Math.round((tSum / tN) * 10) / 10}d` : "—" },
      { label: "To grade", value: pending.length },
    ];
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Analytics</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">How your classes are progressing through what you&apos;ve assigned.</p>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-10">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
              <div className="text-xs text-[#5B6470]">{m.label}</div>
              <div className="text-2xl tabular mt-0.5">{m.value}</div>
            </div>
          ))}
        </div>

        {schoolView && (
          <div className="rounded-xl bg-[#F5F6F3] border border-[#E6E8E4] px-5 py-4 mb-10">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-sm font-medium">What your school sees about your teaching</h2>
              <span className="chip bg-[#E2F4F1] text-[#0C8175]">transparency</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {schoolView.map((m) => (
                <div key={m.label}>
                  <div className="text-xs text-[#5B6470]">{m.label}</div>
                  <div className="text-xl tabular mt-0.5">{m.value}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-[#5B6470] mt-2">
              Leadership sees these to spot where to help — never as a ranking.
            </p>
          </div>
        )}

        <h2 className="text-xl mb-2">By class</h2>
        <div className="card divide-y divide-[#EEF0EC] mb-10">
          {perClass.size === 0 ? (
            <div className="px-5 py-3 text-sm text-[#5B6470]">No assignments yet.</div>
          ) : (
            [...perClass.entries()].map(([id, c]) => {
              const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
              return (
                <div key={id} className="px-5 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-sm text-[#5B6470]">
                      <span className="tabular">{c.completed}/{c.total}</span> done · <span className="tabular text-[#0C8175] font-medium">{pct}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#EEF0EC] overflow-hidden">
                    <div className="h-full bg-[#1FB8A6]" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {hotspots.length > 0 && (
          <>
            <h2 className="text-xl mb-2">Most revised</h2>
            <p className="text-sm text-[#5B6470] mb-2">Topics students re-open most — often the trickiest ones.</p>
            <div className="card px-5 py-3 mb-10">
              <ul className="text-sm space-y-1">
                {hotspots.map((h, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span>{h.label}</span>
                    <span className="text-[#9A6400]">↻ {h.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        <h2 className="text-xl mb-2">To grade</h2>
        <p className="text-sm text-[#5B6470] mb-3">Submitted worksheets &amp; exams awaiting a mark.</p>
        <GradeList pending={pending} />
      </main>
    </div>
  );
}
