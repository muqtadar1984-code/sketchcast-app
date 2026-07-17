import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { timetableEnabledFor } from "@/utils/flags";
import { shapeFromConfig, type Slot } from "@/utils/timetable";
import { generateTimetable, type GenClass } from "@/utils/timetable-solver";

export const runtime = "nodejs";

// Auto-generate the school timetable. Admin-only (coordinators hand-tune their
// slice in the grid afterwards). The caller sends the subject→teacher mapping
// they confirmed in the dialog; everything else (classes, shape, per-grade
// curriculum overrides) is resolved server-side. Modes:
//   "fill"    — keep every existing slot as a PIN and only fill gaps
//   "replace" — wipe the school's grid and generate from scratch
// Writes go through the service role AFTER authorization (the caller is a
// verified school_admin and every row is pinned to their school_id) because a
// full school is ~2000 rows — but the mapping is validated so only this
// school's adults can ever be timetabled.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (role !== "school_admin" || !schoolId) {
    return NextResponse.json({ error: "School admin only." }, { status: 403 });
  }
  if (!(await timetableEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

  let body: { mode?: string; mapping?: Record<string, string[]> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const mode = body.mode === "replace" ? "replace" : "fill";
  const rawMapping = body.mapping ?? {};

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Validate the mapping: only THIS school's adults may be timetabled.
  const { data: staffRaw } = await admin
    .from("profiles")
    .select("id")
    .eq("school_id", schoolId)
    .neq("role", "student");
  const staffIds = new Set(((staffRaw ?? []) as { id: string }[]).map((s) => s.id));
  const subjectTeachers: Record<string, string[]> = {};
  for (const [subject, ids] of Object.entries(rawMapping)) {
    if (typeof subject !== "string" || subject.length > 60 || !Array.isArray(ids)) continue;
    const clean = ids.filter((id): id is string => typeof id === "string" && staffIds.has(id));
    if (clean.length) subjectTeachers[subject.trim()] = [...new Set(clean)];
  }
  if (!Object.keys(subjectTeachers).length) {
    return NextResponse.json({ error: "Assign at least one teacher to a subject first." }, { status: 400 });
  }

  const { data: school } = await admin.from("schools").select("config").eq("id", schoolId).maybeSingle();
  const cfg = (school?.config ?? null) as {
    timetable?: { curriculum?: Record<string, Record<string, number>>; coreSubjects?: unknown };
  } | null;
  const shape = shapeFromConfig(school?.config ?? null);
  // Per-school core set (subjects that must run daily); default lives in the solver.
  const coreSubjects = Array.isArray(cfg?.timetable?.coreSubjects)
    ? cfg!.timetable!.coreSubjects.filter((s): s is string => typeof s === "string" && !!s && s.length <= 60).slice(0, 10)
    : undefined;

  const { data: classesRaw } = await admin
    .from("classes")
    .select("id, name, grade, teacher_id")
    .eq("school_id", schoolId);
  const classes = (classesRaw ?? []) as GenClass[];
  if (!classes.length) return NextResponse.json({ error: "No classes to timetable yet." }, { status: 400 });

  const { data: existingRaw } = await admin
    .from("timetable_slots")
    .select("class_id, day, period, subject, teacher_id, locked, kind")
    .eq("school_id", schoolId);
  const existing = (existingRaw ?? []) as Slot[];
  // Locked cells are pins in BOTH modes: fill keeps everything, replace keeps
  // only what a human pinned and rebuilds around it.
  const lockedPins = existing.filter((s) => s.locked);

  const result = generateTimetable({
    shape,
    classes,
    subjectTeachers,
    curriculum: cfg?.timetable?.curriculum,
    pinned: mode === "fill" ? existing : lockedPins,
    maxPerTeacherPerDay: shape.maxPerTeacherPerDay ?? 6,
    coreSubjects,
  });

  // Writes are NOT one transaction over PostgREST, so contain the blast radius:
  //   fill    — upsert with ignoreDuplicates: a manual save racing the generator
  //             degrades to "the human's cell wins", never a failed chunk.
  //   replace — rebuild CLASS BY CLASS (delete+insert per class, ~40 rows each):
  //             a mid-run failure leaves one class to redo, never an empty school.
  const rows = result.slots.map((s) => ({
    school_id: schoolId,
    class_id: s.class_id,
    day: s.day,
    period: s.period,
    subject: s.subject,
    teacher_id: s.teacher_id,
    room: null as string | null,
    locked: false,
    kind: "lesson",
    created_by: user.id,
  }));

  let placed = 0;
  const failures: string[] = [];
  if (mode === "fill") {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { data, error: insErr } = await admin
        .from("timetable_slots")
        .upsert(chunk, { onConflict: "class_id,day,period", ignoreDuplicates: true })
        .select("id");
      if (insErr) failures.push(insErr.message);
      else placed += data?.length ?? 0;
    }
  } else {
    const className = new Map(classes.map((c) => [c.id, c.name] as const));
    const byClass = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byClass.has(r.class_id)) byClass.set(r.class_id, []);
      byClass.get(r.class_id)!.push(r);
    }
    // Classes the solver produced nothing for still get cleared in a true
    // "start over" — walk every class, not just the generated ones.
    for (const c of classes) {
      const mine = byClass.get(c.id) ?? [];
      // Replace never deletes a locked cell — those were the pins.
      const { error: delErr } = await admin
        .from("timetable_slots")
        .delete()
        .eq("school_id", schoolId)
        .eq("class_id", c.id)
        .eq("locked", false);
      if (delErr) {
        failures.push(`${className.get(c.id)}: ${delErr.message}`);
        continue;
      }
      if (!mine.length) continue;
      const { error: insErr } = await admin.from("timetable_slots").insert(mine);
      if (insErr) failures.push(`${className.get(c.id)}: ${insErr.message}`);
      else placed += mine.length;
    }
  }
  if (failures.length) {
    return NextResponse.json(
      {
        error: `Placed ${placed} lessons but ${failures.length} batch(es) failed — re-run "fill gaps" to finish. First error: ${failures[0]}`,
      },
      { status: 500 },
    );
  }

  // Name the gaps for the dialog (class names read better than ids). Anchor
  // misses join the list as a pseudo-subject: "5B: Class teacher (P1) ×2".
  const className = new Map(classes.map((c) => [c.id, c.name] as const));
  return NextResponse.json({
    ok: true,
    placed: rows.length,
    kept: mode === "fill" ? existing.length : lockedPins.length,
    unplaced: [
      ...result.unplaced.map((u) => ({ class: className.get(u.classId) ?? "Class", subject: u.subject, count: u.count })),
      ...result.anchorMisses.map((m) => ({
        class: className.get(m.classId) ?? "Class",
        subject: "Class teacher (P1)",
        count: m.count,
      })),
    ],
  });
}
