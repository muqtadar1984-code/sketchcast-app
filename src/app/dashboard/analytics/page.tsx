import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import AppHeader from "../app-header";
import GradeList, { type PendingSub } from "../grade-list";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

// The DB's kind codes are snake_case and never translated — this maps them to
// the dictionary's camelCase keys, so a kind we don't recognise falls through
// to the raw code rather than a blank label.
const KIND_KEY: Record<string, keyof Dictionary["school"]["myAnalytics"]["kind"]> = {
  presentation: "presentation",
  worksheet: "worksheet",
  exam_paper: "examPaper",
  exam: "exam",
  activity: "activity",
  case_study: "caseStudy",
};

// Teacher analytics — everything in one place: headline metrics, per-class
// completion, revision hotspots (topics students re-open most), and a grading
// queue. All from the assigned set (shares × enrollments) ⋈ progress ⋈ submissions.
export default async function AnalyticsPage() {
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.school.myAnalytics;
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
  if (role === "student") redirect("/dashboard");
  // One-hat mode: "My Analytics" belongs to the Teacher hat.
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "teacher");
  if (hatAway) redirect(hatAway);

  // "My Analytics" is the person's OWN teaching. Admins/coordinators can read
  // school-wide rows under RLS, so pin every dataset to their classes/lessons
  // (a no-op for plain teachers, whose RLS already equals ownership).
  const { data: classesRaw } = await supabase
    .from("classes")
    .select("id, name")
    .eq("teacher_id", user.id)
    .order("created_at", { ascending: false });
  const classes = (classesRaw ?? []) as { id: string; name: string }[];
  const myClassIds = new Set(classes.map((c) => c.id));

  type EnrRow = { class_id: string; student_id: string; profiles: { full_name: string | null; username: string | null } | null };
  const { data: enrRaw } = await supabase
    .from("enrollments")
    .select("class_id, student_id, profiles(full_name, username)");
  const enr = ((enrRaw ?? []) as unknown as EnrRow[]).filter((e) => myClassIds.has(e.class_id));

  type ShareRow = { generation_id: string; class_id: string; due_at: string | null; generations: { kind: string; chapter_ref: string | null; title: string | null } | null };
  const { data: sharesRaw } = await supabase
    .from("generation_shares")
    .select("generation_id, class_id, due_at, generations(kind, chapter_ref, title)");
  const shares = ((sharesRaw ?? []) as unknown as ShareRow[]).filter((s) => myClassIds.has(s.class_id));
  const myGenIds = new Set(shares.map((s) => s.generation_id));

  type ProgRow = { generation_id: string; student_id: string; status: string };
  const { data: progRaw } = await supabase
    .from("student_progress")
    .select("generation_id, student_id, status");
  const prog = ((progRaw ?? []) as ProgRow[]).filter((p) => myGenIds.has(p.generation_id));

  type SubRow = { id: string; generation_id: string; student_id: string; mode: string; grade_status: string; auto_score: number | null; max_score: number | null; answers: Record<string, unknown> | null };
  const { data: subsRaw } = await supabase
    .from("submissions")
    .select("id, generation_id, student_id, mode, grade_status, auto_score, max_score, answers");
  const subs = ((subsRaw ?? []) as SubRow[]).filter((s) => myGenIds.has(s.generation_id));

  // ── Index the raw rows ──────────────────────────────────────────────────
  const studentName = new Map<string, string>();
  const studentsByClass = new Map<string, string[]>();
  const allStudents = new Set<string>();
  for (const e of enr) {
    studentName.set(e.student_id, e.profiles?.full_name || e.profiles?.username || dict.school.fallback.student);
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
    if (!g) return dict.school.fallback.item;
    const key = KIND_KEY[g.kind];
    const kind = key ? t.kind[key] : g.kind;
    return g.chapter_ref != null
      ? fmt(t.chapterLabel, { kind, n: Number(g.chapter_ref) + 1 })
      : g.title || kind;
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
      const pc = perClass.get(s.class_id) ?? {
        name: className.get(s.class_id) || dict.school.fallback.class,
        total: 0,
        completed: 0,
      };
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

  // For interactive submissions still needing a mark, sign the quiz questions so the
  // teacher can READ each written answer (short/subjective) instead of scoring blind.
  const pendingInteractiveGenIds = [
    ...new Set(subs.filter((s) => s.grade_status === "pending" && s.mode !== "file").map((s) => s.generation_id)),
  ];
  const quizUrlByGen = new Map<string, string>();
  if (pendingInteractiveGenIds.length) {
    try {
      const admin = createAdminClient();
      const { data: qArts } = await admin
        .from("artifacts")
        .select("generation_id, storage_path")
        .eq("kind", "questions_json")
        .in("generation_id", pendingInteractiveGenIds);
      for (const a of (qArts ?? []) as { generation_id: string; storage_path: string }[]) {
        const { data } = await admin.storage.from("artifacts").createSignedUrl(a.storage_path, 3600);
        if (data?.signedUrl) quizUrlByGen.set(a.generation_id, data.signedUrl);
      }
    } catch {
      // no service key / storage hiccup → the teacher still gets the score box, just no review panel.
    }
  }

  const pending: PendingSub[] = subs
    .filter((s) => s.grade_status === "pending")
    .map((s) => ({
      id: s.id,
      studentName: studentName.get(s.student_id) || dict.school.fallback.student,
      label: genLabel(s.generation_id),
      mode: s.mode,
      auto: s.auto_score,
      max: s.max_score,
      answers: s.answers ?? null,
      quizUrl: s.mode !== "file" ? quizUrlByGen.get(s.generation_id) ?? null : null,
    }));

  const completionPct = total ? Math.round((completed / total) * 100) : 0;
  const metrics: { label: string; value: string | number }[] = [
    { label: t.metric.classes, value: classes.length },
    { label: t.metric.students, value: allStudents.size },
    { label: t.metric.assignments, value: shares.length },
    // "—" until something is assigned: a measured 0% and no-data-yet are different stories.
    { label: t.metric.completion, value: total ? `${completionPct}%` : "—" },
    { label: t.metric.overdue, value: overdue },
    { label: t.metric.toGrade, value: pending.length },
  ];

  // What the school sees about this teacher (transparency — only when the school
  // analytics feature is on). The same activity metrics leadership sees, computed
  // from the teacher's OWN data, so there are no surprises.
  let schoolView: { label: string; value: string | number }[] | null = null;
  if (await schoolAnalyticsEnabledFor(supabase, profile?.school_id as string | null)) {
    const { count: lessons } = await supabase
      .from("generations")
      .select("*", { count: "exact", head: true })
      .eq("owner_id", user.id);
    const { data: gradedRaw } = await supabase
      .from("submissions")
      .select("submitted_at, graded_at, generations!inner(owner_id)")
      .eq("generations.owner_id", user.id)
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
      { label: t.schoolView.lessonsMade, value: lessons ?? 0 },
      { label: t.schoolView.assignments, value: shares.length },
      { label: t.schoolView.turnaround, value: tN ? `${Math.round((tSum / tN) * 10) / 10}d` : "—" },
      { label: t.schoolView.toGrade, value: pending.length },
    ];
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">{t.subtitle}</p>

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
              <h2 className="text-sm font-medium">{t.schoolView.title}</h2>
              <span className="chip bg-[#E2F4F1] text-[#0C8175]">{t.schoolView.chip}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {schoolView.map((m) => (
                <div key={m.label}>
                  <div className="text-xs text-[#5B6470]">{m.label}</div>
                  <div className="text-xl tabular mt-0.5">{m.value}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-[#5B6470] mt-2">{t.schoolView.note}</p>
          </div>
        )}

        <h2 className="text-xl mb-2">{t.byClass}</h2>
        <div className="card divide-y divide-[#EEF0EC] mb-10">
          {perClass.size === 0 ? (
            <div className="px-5 py-3 text-sm text-[#5B6470]">{t.noAssignments}</div>
          ) : (
            [...perClass.entries()].map(([id, c]) => {
              const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
              return (
                <div key={id} className="px-5 py-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-sm text-[#5B6470]">
                      <span className="tabular">{c.completed}/{c.total}</span> {t.done} · <span className="tabular text-[#0C8175] font-medium">{pct}%</span>
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
            <h2 className="text-xl mb-2">{t.mostRevised}</h2>
            <p className="text-sm text-[#5B6470] mb-2">{t.mostRevisedHint}</p>
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

        <h2 className="text-xl mb-2">{t.toGradeTitle}</h2>
        <p className="text-sm text-[#5B6470] mb-3">{t.toGradeHint}</p>
        <GradeList pending={pending} />
      </main>
    </div>
  );
}
