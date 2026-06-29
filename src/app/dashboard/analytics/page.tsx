import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import GradeList, { type PendingSub } from "../grade-list";

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
  const displayName = profile?.full_name || user.email || "";

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

  type SubRow = { id: string; generation_id: string; student_id: string; mode: string; grade_status: string };
  const { data: subsRaw } = await supabase
    .from("submissions")
    .select("id, generation_id, student_id, mode, grade_status");
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
    .map((s) => ({ id: s.id, studentName: studentName.get(s.student_id) || "Student", label: genLabel(s.generation_id), mode: s.mode }));

  const completionPct = total ? Math.round((completed / total) * 100) : 0;
  const metrics: { label: string; value: string | number }[] = [
    { label: "Classes", value: classes.length },
    { label: "Students", value: allStudents.size },
    { label: "Assignments", value: shares.length },
    { label: "Completion", value: `${completionPct}%` },
    { label: "Overdue", value: overdue },
    { label: "To grade", value: pending.length },
  ];

  return (
    <div className="min-h-screen bg-[#FBF6EC] text-[#2C2A26]">
      <AppHeader name={displayName} role={role} />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Analytics</h1>
        <div className="h-1 w-14 rounded-full bg-[#C77F2A] mb-3" />
        <p className="text-[#6F6A5F] mb-7">How your classes are progressing through what you&apos;ve assigned.</p>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-10">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-xl bg-white border border-[#EBE3D3] px-4 py-3">
              <div className="text-xs text-[#6F6A5F]">{m.label}</div>
              <div className="text-2xl font-serif mt-0.5">{m.value}</div>
            </div>
          ))}
        </div>

        <h2 className="text-xl mb-2">By class</h2>
        <div className="card divide-y divide-[#F1ECE0] mb-10">
          {perClass.size === 0 ? (
            <div className="px-5 py-3 text-sm text-[#6F6A5F]">No assignments yet.</div>
          ) : (
            [...perClass.entries()].map(([id, c]) => {
              const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
              return (
                <div key={id} className="px-5 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-sm text-[#6F6A5F]">
                      {c.completed}/{c.total} done · <span className="text-[#2E6B4E] font-medium">{pct}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#F1ECE0] overflow-hidden">
                    <div className="h-full bg-[#2E6B4E]" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {hotspots.length > 0 && (
          <>
            <h2 className="text-xl mb-2">Most revised</h2>
            <p className="text-sm text-[#6F6A5F] mb-2">Topics students re-open most — often the trickiest ones.</p>
            <div className="card px-5 py-3 mb-10">
              <ul className="text-sm space-y-1">
                {hotspots.map((h, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span>{h.label}</span>
                    <span className="text-[#854F0B]">↻ {h.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        <h2 className="text-xl mb-2">To grade</h2>
        <p className="text-sm text-[#6F6A5F] mb-3">Submitted worksheets &amp; exams awaiting a mark.</p>
        <GradeList pending={pending} />
      </main>
    </div>
  );
}
