import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { studentEmail, usernameBase } from "@/utils/student";
import { generateTempPassword } from "@/utils/temp-password";

export const runtime = "nodejs";

type NewStudent = { firstName?: string; lastName?: string; parentEmail?: string };

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

  // Cap pre-check: friendly message + avoids creating auth users that the
  // enrollments trigger (migrations 0011/0016, the real enforcement) would then
  // block. Honors per-teacher overrides (profiles.max_students); best-effort —
  // if columns don't exist yet, the query degrades to the beta default.
  type CapRow = { beta_tester?: boolean; max_students?: number | null };
  let me: CapRow | null = null;
  {
    const withCaps = await admin
      .from("profiles")
      .select("beta_tester, max_students")
      .eq("id", user.id)
      .maybeSingle();
    if (withCaps.error) {
      const betaOnly = await admin.from("profiles").select("beta_tester").eq("id", user.id).maybeSingle();
      me = betaOnly.data as CapRow | null;
    } else {
      me = withCaps.data as CapRow | null;
    }
  }
  // The 2-student default is a TRIAL shape, not a flag shape: beta_tester is
  // never cleared on upgrade (0012), so gate on the DB's own trial scope
  // (my_trial_pin, 0057 — trial tier, no school, not a parent, no override).
  // Best-effort: before 0057 runs the RPC is absent → fall back to the flag.
  let trialScope = !!me?.beta_tester;
  {
    const { data: tp, error: tpErr } = await supabase.rpc("my_trial_pin");
    const scope = (Array.isArray(tp) ? tp[0] : tp) as { in_scope?: boolean } | null;
    if (!tpErr && scope) trialScope = !!scope.in_scope;
  }
  const cap = me?.max_students ?? (trialScope ? 2 : null);
  if (cap != null) {
    const { data: enr } = await admin
      .from("enrollments")
      .select("student_id, classes!inner(teacher_id)")
      .eq("classes.teacher_id", user.id);
    const current = new Set(((enr ?? []) as { student_id: string }[]).map((e) => e.student_id)).size;
    if (current + students.length > cap) {
      return NextResponse.json(
        {
          error:
            current >= cap
              ? `Your account is limited to ${cap} student${cap === 1 ? "" : "s"} — you've already added ${current}.`
              : `Your account is limited to ${cap} student${cap === 1 ? "" : "s"} — you can add ${cap - current} more.`,
        },
        { status: 400 },
      );
    }
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

    const password = generateTempPassword();
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
        // Provisioned with a known identity → skip the new-joiner onboarding gate
        // (0038). Students are also exempted by role in the gate, belt-and-braces.
        onboarded_at: new Date().toISOString(),
      })
      .eq("id", sid);
    if (pErr) errors.push(`${fullName || username}: profile — ${pErr.message}`);

    const { error: eErr } = await admin
      .from("enrollments")
      .insert({ class_id: classId, student_id: sid });
    if (eErr) {
      // Enrollment refused (e.g. the beta student cap) — remove the just-created
      // auth user so the teacher isn't handed credentials for a student who
      // isn't enrolled anywhere.
      errors.push(`${fullName || username}: ${eErr.message}`);
      await admin.auth.admin.deleteUser(sid).catch(() => undefined);
      continue;
    }

    created.push({ firstName, lastName, username, password, parentEmail });
  }

  return NextResponse.json({ created, errors });
}
