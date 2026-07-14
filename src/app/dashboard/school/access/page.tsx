import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabledFor } from "@/utils/flags";

// "Who can see what" — a plain-language, read-only view of the access model so
// leadership can see exactly how the scoping works (and trust it with minors'
// data). The model in words, plus the concrete current mapping: for an admin,
// each coordinator's resolved footprint; for a coordinator, their own slice and
// an explicit statement of what's invisible to them. Behind the flag.

const MODEL: { role: string; sees: string }[] = [
  { role: "Student", sees: "Only their own lessons, progress, and submissions." },
  { role: "Teacher", sees: "Only their own classes, students, content, grading, and submissions." },
  {
    role: "Coordinator",
    sees: "A teacher granted oversight of specific grade(s) — and subject(s), if set: the students, teachers, and content in that slice. Nothing outside it. They keep their own teacher dashboard.",
  },
  {
    role: "Principal / Admin",
    sees: "Whole-school totals and trends. Named at-risk students are surfaced to the grade/subject coordinator, not profiled school-wide. Admin also manages scopes, reads the access-audit log, and can teach classes of their own.",
  },
];

export default async function AccessModelPage() {
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
  const isAdmin = role === "school_admin";

  // RLS-scoped: admin → school-wide; scope-holder → their slice. Coordinator
  // access is the grant itself (scope rows), so non-admins without rows bounce.
  const { data: scopesRaw } = await supabase.from("coordinator_scope").select("id, coordinator_id, grade, subject");
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
      name: p.full_name || p.username || "User",
      role: p.role,
    }));
  }
  const nameOf = new Map(people.map((p) => [p.id, p.name] as const));
  const coordinatorIds = [...new Set(scopes.map((s) => s.coordinator_id))];

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Who can see what</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">
          Exactly how data is scoped by role. Enforced in the database (row-level security), not just hidden in the UI.
        </p>

        <div className="card divide-y divide-[#EEF0EC] mb-10">
          {MODEL.map((m) => (
            <div key={m.role} className="px-5 py-3 grid sm:grid-cols-[160px_1fr] gap-x-4 gap-y-1">
              <span className="font-medium">{m.role}</span>
              <span className="text-sm text-[#5B6470]">{m.sees}</span>
            </div>
          ))}
        </div>

        {isAdmin ? (
          <>
            <h2 className="text-xl mb-1">Coordinators &amp; their reach</h2>
            <p className="text-sm text-[#5B6470] mb-3">
              What each coordinator&apos;s scope resolves to right now. Manage these on the Admin screen.
            </p>
            {coordinatorIds.length === 0 ? (
              <div className="card px-5 py-6 text-sm text-[#5B6470]">
                No coordinators yet — everyone is a teacher (own classes only) or admin (whole school).
              </div>
            ) : (
              <div className="card divide-y divide-[#EEF0EC]">
                {coordinatorIds.map((cid) => {
                  const mine = scopes.filter((s) => s.coordinator_id === cid);
                  const fp = footprint(new Set(mine.map((s) => s.grade)));
                  return (
                    <div key={cid} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-3 mb-1.5">
                        <span className="font-medium">{nameOf.get(cid) || "Coordinator"}</span>
                        <span className="text-xs text-[#5B6470] tabular">
                          {fp.classes} classes · {fp.students} students · {fp.teachers} teachers
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {mine.map((s) => (
                          <span key={s.id} className="chip font-sans bg-[#EEF0EC] text-[#14181F] normal-case tracking-normal">
                            Grade {s.grade}{s.subject ? ` · ${s.subject}` : ""}
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
            <h2 className="text-xl mb-1">Your access</h2>
            <p className="text-sm text-[#5B6470] mb-3">Exactly your slice — and nothing beyond it.</p>
            {scopes.length === 0 ? (
              <div className="card px-5 py-6 text-sm text-[#9A6400]">
                You have no scope assigned yet, so you can&apos;t see any student data. Ask your admin to assign you a grade.
              </div>
            ) : (
              <div className="card px-5 py-4">
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {scopes.map((s) => (
                    <span key={s.id} className="chip font-sans bg-[#E2F4F1] text-[#0C8175]">
                      Grade {s.grade}{s.subject ? ` · ${s.subject}` : ""}
                    </span>
                  ))}
                </div>
                {(() => {
                  const fp = footprint(new Set(scopes.map((s) => s.grade)));
                  return (
                    <p className="text-sm text-[#5B6470]">
                      That covers <span className="tabular text-[#14181F]">{fp.classes}</span> classes,{" "}
                      <span className="tabular text-[#14181F]">{fp.students}</span> students, and{" "}
                      <span className="tabular text-[#14181F]">{fp.teachers}</span> teachers. Anything in other grades is
                      invisible to you.
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
