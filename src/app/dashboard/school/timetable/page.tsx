import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { timetableEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { shapeFromConfig, type Slot } from "@/utils/timetable";
import { canonicalSubject, curriculumForGrade, DEFAULT_CORE_SUBJECTS } from "@/utils/timetable-solver";
import TimetableEditor from "./timetable-editor";
import GenerateButton from "./generate-button";
import AbsencePanel, { type AbsenceRow, type SubRow } from "./absence-panel";

// Onboarding subject labels → curriculum subject names (loose aliases so a
// teacher who picked "Computing / ICT" prefills onto the ICT row).
const SUBJECT_ALIASES: Record<string, string[]> = {
  "Computing / ICT": ["ICT"],
  Languages: ["Bahasa Melayu"],
  "Social studies": ["History", "Geography"],
};

export const dynamic = "force-dynamic";

// The timetable builder (leadership): pick a class, fill the period grid, and
// teacher double-bookings light up as you type — the DB owns the hard rule (one
// lesson per class-cell), the editor owns the soft one. The by-teacher view is
// derived from the same rows. Coordinators edit only classes in their grade
// slice (the RLS write policies are the enforcement; the UI mirrors them).
export default async function TimetablePage() {
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
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!role || role === "student" || !schoolId) redirect("/dashboard");
  if (!(await timetableEnabledFor(supabase, schoolId))) redirect("/dashboard");

  // Leadership only: school_admin, or a coordinator-scope holder.
  const isAdmin = role === "school_admin";
  let coordGrades: string[] = [];
  if (!isAdmin) {
    // School-scoped on purpose: a stale coordinator grant from a school this
    // user has since left must not open THIS school's timetable.
    const { data: scopes } = await supabase.from("coordinator_scope").select("grade").eq("school_id", schoolId);
    coordGrades = [...new Set(((scopes ?? []) as { grade: string }[]).map((s) => s.grade))];
    if (!coordGrades.length) redirect("/dashboard");
  }
  const hatAway = await enforceHat(supabase, role, schoolId, "leadership");
  if (hatAway) redirect(hatAway);

  // Shape from per-school config (fallback Mon–Fri × 8).
  const { data: school } = await supabase.from("schools").select("config").eq("id", schoolId).maybeSingle();
  const shape = shapeFromConfig(school?.config ?? null);

  // RLS-scoped: classes + slots + teacher roster for the pickers.
  const { data: classesRaw } = await supabase
    .from("classes")
    .select("id, name, grade, teacher_id")
    .order("name");
  const classes = ((classesRaw ?? []) as { id: string; name: string; grade: string | null; teacher_id: string }[]).map(
    (c) => ({
      ...c,
      // The UI mirrors the RLS write rule: admin edits all, coordinator their grades.
      editable: isAdmin || coordGrades.includes(c.grade ?? ""),
    }),
  );
  // ZERO classes must render, not redirect: when analytics is off this page IS
  // the leadership hat's home, and bouncing to a teacher-domain page re-enters
  // enforceHat → hatHome → here (ERR_TOO_MANY_REDIRECTS). Loop-safety invariant.
  if (!classes.length) {
    return (
      <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
        <AppHeader />
        <main className="max-w-5xl mx-auto px-6 py-10">
          <h1 className="text-4xl mb-2">Timetable</h1>
          <InkUnderline className="block h-3 w-28 mb-3" />
          <p className="text-[#5B6470]">
            No classes yet — the timetable appears once your school&apos;s classes are set up. SketchCast
            provisions staff and classes with you during onboarding; contact support to get started.
          </p>
        </main>
      </div>
    );
  }

  const { data: slotsRaw } = await supabase
    .from("timetable_slots")
    .select("id, class_id, day, period, subject, teacher_id, room, locked, kind, updated_at");
  const slotRows = (slotsRaw ?? []) as (Slot & { updated_at: string })[];
  const slots: Slot[] = slotRows.map(({ updated_at: _u, ...s }) => s);
  // The editor holds the grid in useState, and router.refresh() deliberately
  // preserves client state — so after Auto-generate rewrites the DB, the editor
  // must REMOUNT to pick up fresh rows. Key it by a data version.
  const slotsVersion = `${slotRows.length}:${slotRows.reduce((m, s) => (s.updated_at > m ? s.updated_at : m), "")}`;

  // Teachers of the school for the assign dropdown (adults only), plus their
  // onboarding profile (subjects) for the generator's prefill. Fetched via the
  // service role AFTER the leadership check above: a coordinator's RLS view of
  // profiles is deliberately narrow (self + their grade's class teachers), but
  // the pickers, roster and cover names need the full adult roster. Falls back
  // to the session-visible slice if the admin key is missing.
  type StaffRow = {
    id: string;
    full_name: string | null;
    username: string | null;
    profile: { subjects?: string[] } | null;
  };
  let staff: StaffRow[] = [];
  try {
    const adminClient = createAdminClient();
    const { data: staffRaw } = await adminClient
      .from("profiles")
      .select("id, full_name, username, role, profile")
      .eq("school_id", schoolId)
      .neq("role", "student");
    staff = (staffRaw ?? []) as StaffRow[];
  } catch {
    const { data: staffRaw } = await supabase
      .from("profiles")
      .select("id, full_name, username, role, profile")
      .eq("school_id", schoolId)
      .neq("role", "student");
    staff = (staffRaw ?? []) as StaffRow[];
  }
  const teachers = staff
    .map((t) => ({ id: t.id, name: t.full_name || t.username || "Teacher" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const staffDetails = staff
    .map((t) => ({
      id: t.id,
      name: t.full_name || t.username || "Teacher",
      subjects: (t.profile?.subjects ?? []).filter((s): s is string => typeof s === "string"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Absences & cover: recent past for context, everything upcoming (RLS-read).
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const [{ data: absRaw }, { data: subsRaw }] = await Promise.all([
    supabase
      .from("teacher_absences")
      .select("id, teacher_id, on_date, reason")
      .gte("on_date", since)
      .order("on_date"),
    supabase
      .from("timetable_substitutions")
      .select("id, absence_id, class_id, on_date, period, subject, original_teacher_id, substitute_teacher_id")
      .gte("on_date", since),
  ]);
  const absences = (absRaw ?? []) as AbsenceRow[];
  const substitutions = (subsRaw ?? []) as SubRow[];

  // ── Generator inputs (admin only) ────────────────────────────────────────────
  // Subjects = the union of every present grade's curriculum; the prefill maps
  // teachers onto them from (a) their onboarding "subjects I teach" and (b)
  // whatever they already teach on the current grid.
  const cfgTimetable = (school?.config as {
    timetable?: { curriculum?: Record<string, Record<string, number>>; coreSubjects?: unknown };
  } | null)?.timetable;
  const cfgCurriculum = cfgTimetable?.curriculum;
  const subjectSet = new Set<string>();
  for (const c of classes) for (const s of Object.keys(curriculumForGrade(c.grade, cfgCurriculum))) subjectSet.add(s);
  // Core subjects (config override or the default set) always get a dialog
  // row — a custom core the school can't staff from the dialog would report
  // gaps forever with no way to fix them.
  const coreNames = [
    ...new Set(
      (Array.isArray(cfgTimetable?.coreSubjects)
        ? cfgTimetable!.coreSubjects.filter((s): s is string => typeof s === "string" && !!s)
        : DEFAULT_CORE_SUBJECTS
      ).map((s) => canonicalSubject(s.trim(), [...subjectSet])),
    ),
  ];
  for (const s of coreNames) subjectSet.add(s);
  const subjects = [...subjectSet].sort();
  const initialMapping: Record<string, string[]> = {};
  const mapTeacher = (subject: string, tid: string) => {
    if (!subjectSet.has(subject)) return;
    if (!initialMapping[subject]) initialMapping[subject] = [];
    if (!initialMapping[subject].includes(tid)) initialMapping[subject].push(tid);
  };
  for (const t of staff) {
    for (const declared of t.profile?.subjects ?? []) {
      mapTeacher(declared, t.id);
      for (const alias of SUBJECT_ALIASES[declared] ?? []) mapTeacher(alias, t.id);
    }
  }
  for (const s of slots) if (s.teacher_id) mapTeacher(s.subject, s.teacher_id);

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <div className="print:hidden">
        <AppHeader />
      </div>
      <main className="max-w-5xl mx-auto px-6 py-10 print:py-2">
        <h1 className="text-4xl mb-2">Timetable</h1>
        <InkUnderline className="block h-3 w-28 mb-3 print:hidden" />
        <div className="flex flex-wrap items-center justify-between gap-3 mb-7 print:hidden">
          <p className="text-[#5B6470]">
            Build each class&apos;s week — clashes where a teacher is in two rooms at once light up instantly.
            {!isAdmin && (
              <span className="chip bg-[#E2F4F1] text-[#0C8175] ml-2">Grade {coordGrades.join(", ")}</span>
            )}
          </p>
          {isAdmin && (
            <GenerateButton teachers={teachers} subjects={subjects} initialMapping={initialMapping} coreNames={coreNames} />
          )}
        </div>
        <AbsencePanel
          teachers={teachers}
          classNames={Object.fromEntries(classes.map((c) => [c.id, c.name]))}
          periodLabels={shape.periods.map((p) => p.label)}
          initialAbsences={absences}
          initialSubs={substitutions}
          canMark={isAdmin || coordGrades.length > 0}
          slots={slots}
          maxPerDay={shape.maxPerTeacherPerDay ?? 6}
        />
        <TimetableEditor
          key={slotsVersion}
          schoolId={schoolId}
          shape={shape}
          classes={classes}
          teachers={teachers}
          staffDetails={staffDetails}
          initialSlots={slots}
          isAdmin={isAdmin}
        />
      </main>
    </div>
  );
}
