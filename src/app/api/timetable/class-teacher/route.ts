import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { timetableEnabledFor } from "@/utils/flags";

export const runtime = "nodejs";

// Reassign a class's CLASS TEACHER — principal only. classes.teacher_id is
// the class-teacher position AND the owning teacher (RLS, join codes,
// assignments follow it), so this is an ownership transfer, not a label
// change: the previous holder stops seeing the class as theirs. That's the
// intended meaning of "changing the class teacher" — and why coordinators
// don't get this button. A class always HAS a teacher (the column is NOT
// NULL); positions change hands, they never fall vacant.
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
    return NextResponse.json({ error: "Only the principal can reassign a class teacher." }, { status: 403 });
  }
  if (!(await timetableEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

  let body: { class_id?: string; teacher_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof body.class_id !== "string" || !body.class_id || typeof body.teacher_id !== "string" || !body.teacher_id) {
    return NextResponse.json({ error: "A class and a teacher are required." }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const [{ data: cls }, { data: teacher }] = await Promise.all([
    admin.from("classes").select("id, school_id, teacher_id, name").eq("id", body.class_id).maybeSingle(),
    admin.from("profiles").select("id, role, school_id").eq("id", body.teacher_id).maybeSingle(),
  ]);
  if (!cls || cls.school_id !== schoolId) {
    return NextResponse.json({ error: "No such class in your school." }, { status: 404 });
  }
  if (!teacher || teacher.school_id !== schoolId || teacher.role === "student") {
    return NextResponse.json({ error: "The class teacher must be on this school's staff." }, { status: 400 });
  }
  if (cls.teacher_id === body.teacher_id) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const { error: updErr } = await admin.from("classes").update({ teacher_id: body.teacher_id }).eq("id", body.class_id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
