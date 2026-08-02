import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

// "Who can see what" — a plain-language, read-only view of the access model so
// leadership can see exactly how the scoping works (and trust it with minors'
// data). The model in words, plus the concrete current mapping: for an admin,
// each coordinator's resolved footprint; for a coordinator, their own slice and
// an explicit statement of what's invisible to them. Behind the flag.

// The four rows are read out of the dictionary in this fixed order — the model
// reads top-down from the narrowest view to the widest, in every language.
const MODEL_ROWS = ["student", "teacher", "coordinator", "principal"] as const;

export default async function AccessModelPage() {
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.school.access;
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
  const isAdmin = role === "school_admin";

  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!schoolId) redirect("/dashboard");

  // RLS-scoped + explicit school filter: admin → school-wide; scope-holder →
  // their slice in THIS school (a stale grant from a former school won't gate in).
  const { data: scopesRaw } = await supabase
    .from("coordinator_scope")
    .select("id, coordinator_id, grade, subject")
    .eq("school_id", schoolId);
  const scopes = (scopesRaw ?? []) as { id: string; coordinator_id: string; grade: string; subject: string | null }[];
  if (!isAdmin && scopes.length === 0) redirect("/dashboard");
  const { data: classesRaw } = await supabase.from("classes").select("id, grade, teacher_id");
  const classes = (classesRaw ?? []) as { id: string; grade: string | null; teacher_id: string }[];
  const { data: enrRaw } = await supabase.from("enrollments").select("class_id, student_id");
  const enr = (enrRaw ?? []) as { class_id: string; student_id: string }[];
  const studentsByClass = new Map<string, string[]>();
  for (const e of enr) {
    if (!studentsByClass.has(e.class_id)) studentsByClass.set(e.class_id, []);
    studentsByClass.get(e.class_id)!.push(e.student_id);
  }

  // Resolve a set of grades → how many classes / students / teachers it covers.
  function footprint(grades: Set<string>) {
    const cls = classes.filter((c) => c.grade && grades.has(c.grade));
    const students = new Set<string>();
    const teachers = new Set<string>();
    for (const c of cls) {
      teachers.add(c.teacher_id);
      for (const s of studentsByClass.get(c.id) ?? []) students.add(s);
    }
    return { classes: cls.length, students: students.size, teachers: teachers.size };
  }

  // Admin: per-coordinator footprint + who holds elevated access.
  let people: { id: string; name: string; role: string }[] = [];
  if (isAdmin) {
    const { data: peopleRaw } = await supabase
      .from("profiles")
      .select("id, full_name, username, role")
      .eq("school_id", profile!.school_id);
    people = ((peopleRaw ?? []) as { id: string; full_name: string | null; username: string | null; role: string }[]).map((p) => ({
      id: p.id,
      name: p.full_name || p.username || dict.school.fallback.user,
      role: p.role,
    }));
  }
  const nameOf = new Map(people.map((p) => [p.id, p.name] as const));
  const coordinatorIds = [...new Set(scopes.map((s) => s.coordinator_id))];

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">{t.subtitle}</p>

        <div className="card divide-y divide-[#EEF0EC] mb-10">
          {MODEL_ROWS.map((key) => (
            <div key={key} className="px-5 py-3 grid sm:grid-cols-[160px_1fr] gap-x-4 gap-y-1">
              <span className="font-medium">{t.model[key].role}</span>
              <span className="text-sm text-[#5B6470]">{t.model[key].sees}</span>
            </div>
          ))}
        </div>

        {isAdmin ? (
          <>
            <h2 className="text-xl mb-1">{t.reach.title}</h2>
            <p className="text-sm text-[#5B6470] mb-3">{t.reach.hint}</p>
            {coordinatorIds.length === 0 ? (
              <div className="card px-5 py-6 text-sm text-[#5B6470]">{t.reach.empty}</div>
            ) : (
              <div className="card divide-y divide-[#EEF0EC]">
                {coordinatorIds.map((cid) => {
                  const mine = scopes.filter((s) => s.coordinator_id === cid);
                  const fp = footprint(new Set(mine.map((s) => s.grade)));
                  return (
                    <div key={cid} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-3 mb-1.5">
                        <span className="font-medium">{nameOf.get(cid) || dict.school.fallback.coordinator}</span>
                        <span className="text-xs text-[#5B6470] tabular">
                          {fmt(t.reach.footprint, { classes: fp.classes, students: fp.students, teachers: fp.teachers })}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {mine.map((s) => (
                          <span key={s.id} className="chip font-sans bg-[#EEF0EC] text-[#14181F] normal-case tracking-normal">
                            {fmt(t.grade, { grade: s.grade })}{s.subject ? ` · ${s.subject}` : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <h2 className="text-xl mb-1">{t.mine.title}</h2>
            <p className="text-sm text-[#5B6470] mb-3">{t.mine.hint}</p>
            {scopes.length === 0 ? (
              <div className="card px-5 py-6 text-sm text-[#9A6400]">{t.mine.noScope}</div>
            ) : (
              <div className="card px-5 py-4">
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {scopes.map((s) => (
                    <span key={s.id} className="chip font-sans bg-[#E2F4F1] text-[#0C8175]">
                      {fmt(t.grade, { grade: s.grade })}{s.subject ? ` · ${s.subject}` : ""}
                    </span>
                  ))}
                </div>
                {(() => {
                  const fp = footprint(new Set(scopes.map((s) => s.grade)));
                  return (
                    <p className="text-sm text-[#5B6470]">
                      {fmt(t.mine.covers, { classes: fp.classes, students: fp.students, teachers: fp.teachers })}
                    </p>
                  );
                })()}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
