import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { timetableEnabledFor } from "@/utils/flags";
import { shapeFromConfig, type Slot } from "@/utils/timetable";
import { isoWeekday, pickSubstitutes } from "@/utils/substitution";

export const runtime = "nodejs";

// Teacher absences + automatic substitution cover.
//
//   POST   { teacher_id, date, reason? }  — mark absent; recompute cover
//   DELETE { id }                         — unmark; substitutions cascade away
//   PATCH  { id, substitute_teacher_id }  — hand-override one cover assignment
//
// Everyone is assumed PRESENT until a row lands here. Marking is allowed for
// the school admin (principal) and any coordinator-scope holder — the same
// leadership circle that edits the grid. Writes go through the service role
// AFTER that check (the two tables deliberately have no RLS write policies),
// because cover assignment is a multi-row compute the client can't be trusted
// to do atomically.

type Authz =
  | { ok: true; userId: string; schoolId: string; admin: ReturnType<typeof createAdminClient> }
  | { ok: false; res: NextResponse };

async function authorize(): Promise<Authz> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Not signed in." }, { status: 401 }) };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!role || role === "student" || !schoolId) {
    return { ok: false, res: NextResponse.json({ error: "School staff only." }, { status: 403 }) };
  }
  if (role !== "school_admin") {
    // Coordinator check: RLS returns only the caller's own scope rows, and the
    // explicit school filter rejects stale grants from a school they've left.
    const { data: scopes } = await supabase
      .from("coordinator_scope")
      .select("grade")
      .eq("school_id", schoolId)
      .limit(1);
    if (!scopes?.length) {
      return {
        ok: false,
        res: NextResponse.json({ error: "Only the principal or a coordinator can mark absences." }, { status: 403 }),
      };
    }
  }
  if (!(await timetableEnabledFor(supabase, schoolId))) {
    return { ok: false, res: NextResponse.json({ error: "Not enabled." }, { status: 404 }) };
  }
  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return { ok: false, res: NextResponse.json({ error: (e as Error).message }, { status: 500 }) };
  }
  return { ok: true, userId: user.id, schoolId, admin };
}

export async function POST(request: Request) {
  const auth = await authorize();
  if (!auth.ok) return auth.res;
  const { userId, schoolId, admin } = auth;

  let body: { teacher_id?: string; date?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const teacherId = typeof body.teacher_id === "string" ? body.teacher_id : "";
  const date = typeof body.date === "string" ? body.date : "";
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : null;
  const day = isoWeekday(date);
  if (!teacherId || day === null) {
    return NextResponse.json({ error: "A teacher and a valid date (YYYY-MM-DD) are required." }, { status: 400 });
  }

  // The absent teacher must be staff of THIS school.
  const { data: teacher } = await admin
    .from("profiles")
    .select("id, role, school_id")
    .eq("id", teacherId)
    .maybeSingle();
  if (!teacher || teacher.school_id !== schoolId || teacher.role === "student") {
    return NextResponse.json({ error: "That teacher isn't on this school's staff." }, { status: 400 });
  }

  // Mark absent (idempotent: re-marking the same day recomputes cover).
  const { data: absRow, error: absErr } = await admin
    .from("teacher_absences")
    .upsert(
      { school_id: schoolId, teacher_id: teacherId, on_date: date, reason, created_by: userId },
      { onConflict: "teacher_id,on_date" },
    )
    .select("id")
    .maybeSingle();
  if (absErr || !absRow) {
    return NextResponse.json({ error: absErr?.message || "Could not record the absence." }, { status: 500 });
  }
  const absenceId = absRow.id as string;

  // Recompute this absence's cover from scratch.
  await admin.from("timetable_substitutions").delete().eq("absence_id", absenceId);

  // Weekend / outside the timetable week: absence recorded, nothing to cover.
  const { data: school } = await admin.from("schools").select("config").eq("id", schoolId).maybeSingle();
  const shape = shapeFromConfig(school?.config ?? null);
  if (day > shape.days) {
    return NextResponse.json({ ok: true, absence_id: absenceId, substitutions: [], note: "No school day on that date." });
  }

  const [{ data: slotsRaw }, { data: staffRaw }, { data: classesRaw }, { data: absRaw }, { data: otherSubsRaw }] =
    await Promise.all([
      admin
        .from("timetable_slots")
        .select("class_id, day, period, subject, teacher_id, kind")
        .eq("school_id", schoolId),
      admin
        .from("profiles")
        .select("id, full_name, username, profile")
        .eq("school_id", schoolId)
        .neq("role", "student"),
      admin.from("classes").select("id, teacher_id").eq("school_id", schoolId),
      admin.from("teacher_absences").select("teacher_id").eq("school_id", schoolId).eq("on_date", date),
      admin
        .from("timetable_substitutions")
        .select("id, class_id, period, subject, original_teacher_id, substitute_teacher_id, absence_id")
        .eq("school_id", schoolId)
        .eq("on_date", date),
    ]);

  const slots = (slotsRaw ?? []) as Slot[];
  const staff = ((staffRaw ?? []) as { id: string; full_name: string | null; username: string | null; profile: { subjects?: string[] } | null }[]).map(
    (t) => ({ id: t.id, name: t.full_name || t.username || "Teacher", subjects: t.profile?.subjects ?? [] }),
  );

  const subjectsByTeacher = new Map<string, Set<string>>();
  const addSubject = (tid: string, subject: string) => {
    if (!subjectsByTeacher.has(tid)) subjectsByTeacher.set(tid, new Set());
    subjectsByTeacher.get(tid)!.add(subject);
  };
  for (const t of staff) for (const s of t.subjects) addSubject(t.id, s);
  for (const s of slots) if (s.teacher_id) addSubject(s.teacher_id, s.subject);

  const absentSet = new Set(((absRaw ?? []) as { teacher_id: string }[]).map((a) => a.teacher_id));
  const classTeacherByClass = new Map(
    ((classesRaw ?? []) as { id: string; teacher_id: string | null }[])
      .filter((c) => c.teacher_id)
      .map((c) => [c.id, c.teacher_id!] as const),
  );
  const cap = shape.maxPerTeacherPerDay ?? 6;
  type SubRow = {
    id: string;
    class_id: string;
    period: number;
    subject: string;
    original_teacher_id: string | null;
    substitute_teacher_id: string | null;
    absence_id: string;
  };
  const dateSubs = ((otherSubsRaw ?? []) as SubRow[]).filter((s) => s.absence_id !== absenceId);

  // The newly absent teacher may have been COVERING other absences today —
  // those assignments are now orphaned. Re-pick each one before computing the
  // new absence's own cover, feeding every fresh booking into the busy list so
  // nobody gets double-assigned across the whole day.
  const liveSubs = dateSubs
    .filter((s) => s.substitute_teacher_id && s.substitute_teacher_id !== teacherId)
    .map((s) => ({ period: s.period, substitute_teacher_id: s.substitute_teacher_id }));
  const orphaned = dateSubs.filter((s) => s.substitute_teacher_id === teacherId);
  for (const o of orphaned) {
    const [pick] = pickSubstitutes({
      slots,
      day,
      targetTeacherId: o.original_teacher_id ?? teacherId,
      absentTeacherIds: absentSet,
      staff,
      subjectsByTeacher,
      classTeacherByClass,
      existingSubs: liveSubs,
      maxPerTeacherPerDay: cap,
      coverLessons: [
        { class_id: o.class_id, day, period: o.period, subject: o.subject, teacher_id: o.original_teacher_id },
      ],
    });
    const newSub = pick?.substitute_teacher_id ?? null;
    const { error: orphErr } = await admin
      .from("timetable_substitutions")
      .update({ substitute_teacher_id: newSub })
      .eq("id", o.id);
    if (orphErr) return NextResponse.json({ error: orphErr.message }, { status: 500 });
    if (newSub) liveSubs.push({ period: o.period, substitute_teacher_id: newSub });
  }

  const assignments = pickSubstitutes({
    slots,
    day,
    targetTeacherId: teacherId,
    absentTeacherIds: absentSet,
    staff,
    subjectsByTeacher,
    classTeacherByClass,
    existingSubs: liveSubs,
    maxPerTeacherPerDay: cap,
  });

  if (assignments.length) {
    const rows = assignments.map((a) => ({
      school_id: schoolId,
      absence_id: absenceId,
      class_id: a.class_id,
      on_date: date,
      day: a.day,
      period: a.period,
      subject: a.subject,
      original_teacher_id: a.original_teacher_id,
      substitute_teacher_id: a.substitute_teacher_id,
    }));
    // Upsert on the cell key: if the grid changed since an earlier absence was
    // computed, a stale row can already occupy this (class, date, period) — the
    // CURRENT grid is the truth, so the new assignment absorbs it instead of
    // blowing up the whole insert on the unique index.
    const { error: insErr } = await admin
      .from("timetable_substitutions")
      .upsert(rows, { onConflict: "class_id,on_date,period" });
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // Return the WHOLE date's plan (this absence + re-covered orphans) so the
  // panel can replace its state wholesale rather than merging fragments.
  const { data: finalSubs } = await admin
    .from("timetable_substitutions")
    .select("id, absence_id, class_id, on_date, period, subject, original_teacher_id, substitute_teacher_id")
    .eq("school_id", schoolId)
    .eq("on_date", date);
  return NextResponse.json({ ok: true, absence_id: absenceId, date, substitutions: finalSubs ?? [] });
}

export async function DELETE(request: Request) {
  const auth = await authorize();
  if (!auth.ok) return auth.res;
  const { schoolId, admin } = auth;

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "An absence id is required." }, { status: 400 });
  }
  // Scope check, then delete — substitutions cascade with the absence.
  const { data: row } = await admin.from("teacher_absences").select("id, school_id").eq("id", body.id).maybeSingle();
  if (!row || row.school_id !== schoolId) {
    return NextResponse.json({ error: "No such absence in your school." }, { status: 404 });
  }
  const { error: delErr } = await admin.from("teacher_absences").delete().eq("id", body.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const auth = await authorize();
  if (!auth.ok) return auth.res;
  const { schoolId, admin } = auth;

  let body: { id?: string; substitute_teacher_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "A substitution id is required." }, { status: 400 });
  }
  const subTeacher = body.substitute_teacher_id ?? null;
  if (subTeacher !== null && typeof subTeacher !== "string") {
    return NextResponse.json({ error: "Invalid substitute." }, { status: 400 });
  }

  const { data: row } = await admin
    .from("timetable_substitutions")
    .select("id, school_id, on_date, period, original_teacher_id")
    .eq("id", body.id)
    .maybeSingle();
  if (!row || row.school_id !== schoolId) {
    return NextResponse.json({ error: "No such substitution in your school." }, { status: 404 });
  }

  if (subTeacher !== null) {
    if (subTeacher === row.original_teacher_id) {
      return NextResponse.json({ error: "That's the absent teacher." }, { status: 400 });
    }
    const { data: t } = await admin
      .from("profiles")
      .select("id, role, school_id")
      .eq("id", subTeacher)
      .maybeSingle();
    if (!t || t.school_id !== schoolId || t.role === "student") {
      return NextResponse.json({ error: "The substitute must be on this school's staff." }, { status: 400 });
    }
    const { data: subAbsent } = await admin
      .from("teacher_absences")
      .select("id")
      .eq("teacher_id", subTeacher)
      .eq("on_date", row.on_date)
      .maybeSingle();
    if (subAbsent) {
      return NextResponse.json({ error: "That teacher is also absent on that date." }, { status: 400 });
    }

    // Only someone less than 100% busy can take cover: free that period (own
    // grid AND other covers) and under the per-day lesson cap. Same rule the
    // auto-picker applies — a manual override doesn't get to double-book.
    const subDay = isoWeekday(row.on_date as string);
    if (subDay !== null) {
      const [{ data: school }, { data: slotsRaw }, { data: dateSubsRaw }] = await Promise.all([
        admin.from("schools").select("config").eq("id", schoolId).maybeSingle(),
        admin.from("timetable_slots").select("day, period, teacher_id, kind").eq("school_id", schoolId),
        admin
          .from("timetable_substitutions")
          .select("id, period, substitute_teacher_id")
          .eq("school_id", schoolId)
          .eq("on_date", row.on_date),
      ]);
      const cap = shapeFromConfig(school?.config ?? null).maxPerTeacherPerDay ?? 6;
      const daySlots = ((slotsRaw ?? []) as { day: number; period: number; teacher_id: string | null; kind?: string }[]).filter(
        (s) => s.teacher_id === subTeacher && s.day === subDay,
      );
      if (daySlots.some((s) => s.period === row.period)) {
        return NextResponse.json({ error: "That teacher is teaching their own class that period." }, { status: 400 });
      }
      const otherCovers = ((dateSubsRaw ?? []) as { id: string; period: number; substitute_teacher_id: string | null }[]).filter(
        (s) => s.substitute_teacher_id === subTeacher && s.id !== row.id,
      );
      if (otherCovers.some((s) => s.period === row.period)) {
        return NextResponse.json({ error: "That teacher is already covering another class that period." }, { status: 400 });
      }
      const load = daySlots.filter((s) => (s.kind ?? "lesson") === "lesson").length + otherCovers.length;
      if (load >= cap) {
        return NextResponse.json(
          { error: `That teacher is fully booked — already at the daily limit of ${cap} lessons.` },
          { status: 400 },
        );
      }
    }
  }

  const { data: updated, error: updErr } = await admin
    .from("timetable_substitutions")
    .update({ substitute_teacher_id: subTeacher })
    .eq("id", body.id)
    .select("*")
    .maybeSingle();
  if (updErr || !updated) {
    return NextResponse.json({ error: updErr?.message || "Update failed." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, substitution: updated });
}
