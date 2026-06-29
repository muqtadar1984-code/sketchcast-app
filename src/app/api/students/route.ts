import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { studentEmail, usernameBase } from "@/utils/student";

export const runtime = "nodejs";

type NewStudent = { firstName?: string; lastName?: string; parentEmail?: string };

function tempPassword(): string {
  // 10-char password from an unambiguous alphabet (no 0/O/1/l/I).
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Provision invited students for a class. Teacher-only: the caller must own the
// target class. Creates an auth user (synthetic email + temp password) per
// student, fills the profile (username/parent_email/must_reset_password) and
// enrolls them. Returns the credentials so the teacher can hand them to parents.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: { classId?: string; students?: NewStudent[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const classId = (body.classId ?? "").trim();
  const students = (body.students ?? []).filter(
    (s) => (s.firstName ?? "").trim() || (s.lastName ?? "").trim(),
  );
  if (!classId || students.length === 0) {
    return NextResponse.json({ error: "classId and at least one student are required." }, { status: 400 });
  }

  // Authorize: the caller must teach this class (RLS-scoped read).
  const { data: cls } = await supabase
    .from("classes")
    .select("id, school_id")
    .eq("id", classId)
    .eq("teacher_id", user.id)
    .maybeSingle();
  if (!cls) {
    return NextResponse.json({ error: "Class not found or not yours." }, { status: 403 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const created: { firstName: string; lastName: string; username: string; password: string; parentEmail: string | null }[] = [];
  const errors: string[] = [];

  for (const s of students) {
    const firstName = (s.firstName ?? "").trim();
    const lastName = (s.lastName ?? "").trim();
    const parentEmail = (s.parentEmail ?? "").trim() || null;
    const fullName = [firstName, lastName].filter(Boolean).join(" ");

    // Find an unused username (first.last, then first.last2, …).
    const base = usernameBase(firstName, lastName);
    let username = base;
    for (let n = 2; n < 1000; n++) {
      const { data: taken } = await admin
        .from("profiles")
        .select("id")
        .eq("username", username)
        .maybeSingle();
      if (!taken) break;
      username = `${base}${n}`;
    }

    const password = tempPassword();
    const { data: createdUser, error: cErr } = await admin.auth.admin.createUser({
      email: studentEmail(username),
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: "student" },
    });
    if (cErr || !createdUser?.user) {
      errors.push(`${fullName || username}: ${cErr?.message ?? "could not create user"}`);
      continue;
    }

    const sid = createdUser.user.id;
    // handle_new_user() already created the profile (role student) — fill the rest.
    const { error: pErr } = await admin
      .from("profiles")
      .update({
        username,
        full_name: fullName || null,
        parent_email: parentEmail,
        must_reset_password: true,
        school_id: cls.school_id,
        role: "student",
      })
      .eq("id", sid);
    if (pErr) errors.push(`${fullName || username}: profile — ${pErr.message}`);

    const { error: eErr } = await admin
      .from("enrollments")
      .insert({ class_id: classId, student_id: sid });
    if (eErr) errors.push(`${fullName || username}: enroll — ${eErr.message}`);

    created.push({ firstName, lastName, username, password, parentEmail });
  }

  return NextResponse.json({ created, errors });
}
