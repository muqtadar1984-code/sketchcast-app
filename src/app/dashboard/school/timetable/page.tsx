import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { timetableEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { shapeFromConfig, type Slot } from "@/utils/timetable";
import TimetableEditor from "./timetable-editor";

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
    const { data: scopes } = await supabase.from("coordinator_scope").select("grade");
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
  if (!classes.length) redirect("/dashboard/school");

  const { data: slotsRaw } = await supabase
    .from("timetable_slots")
    .select("id, class_id, day, period, subject, teacher_id, room");
  const slots = (slotsRaw ?? []) as Slot[];

  // Teachers of the school for the assign dropdown (adults only).
  const { data: staffRaw } = await supabase
    .from("profiles")
    .select("id, full_name, username, role")
    .eq("school_id", schoolId)
    .neq("role", "student");
  const teachers = ((staffRaw ?? []) as { id: string; full_name: string | null; username: string | null }[])
    .map((t) => ({ id: t.id, name: t.full_name || t.username || "Teacher" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Timetable</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">
          Build each class&apos;s week — clashes where a teacher is in two rooms at once light up instantly.
          {!isAdmin && (
            <span className="chip bg-[#E2F4F1] text-[#0C8175] ml-2">Grade {coordGrades.join(", ")}</span>
          )}
        </p>
        <TimetableEditor
          schoolId={schoolId}
          shape={shape}
          classes={classes}
          teachers={teachers}
          initialSlots={slots}
        />
      </main>
    </div>
  );
}
