import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { decideReset, type ResetEvidence } from "@/utils/reset-scope";
import { generateTempPassword } from "@/utils/temp-password";

export const runtime = "nodejs";

// Hierarchical password reset: an adult resets an account below them and is
// handed a readable temporary password to pass on (shown ONCE — never stored,
// never retrievable). Students can't self-recover (their synthetic
// @students.sketchcast.app addresses receive no mail), so teacher/parent/
// admin/coordinator resets are the recovery path for them.
//
// Guard → mutate → audit, same shape as /api/console/ops: the session client
// only identifies the caller; every read that crosses tenants goes through the
// service role AFTER we know who's asking, and the pure decideReset() helper
// (src/utils/reset-scope.ts) makes the allow/deny call on plain data.

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { targetId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const targetId = (body.targetId ?? "").trim();
  if (!targetId) return NextResponse.json({ error: "targetId is required." }, { status: 400 });

  // Caller's own profile (RLS: read self always works).
  const { data: me } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!me) return NextResponse.json({ error: "No profile." }, { status: 403 });
  const callerSchoolId = (me.school_id as string | null) ?? null;

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const { data: target } = await admin
    .from("profiles")
    .select("id, role, school_id, username")
    .eq("id", targetId)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  // Evidence for the decision — all four reads are independent.
  const emptyRows = Promise.resolve({ data: [] as unknown[] });
  const [staffQ, taughtQ, parentQ, scopeQ, gradesQ] = await Promise.all([
    // Unrevoked platform staff are never resettable from the school side.
    admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", targetId)
      .is("revoked_at", null)
      .maybeSingle(),
    // (a) target enrolled in a class the caller teaches?
    admin
      .from("enrollments")
      .select("class_id, classes!inner(teacher_id)")
      .eq("student_id", targetId)
      .eq("classes.teacher_id", user.id)
      .limit(1),
    // (b) caller ←parent_links→ target?
    admin
      .from("parent_links")
      .select("child_id")
      .eq("parent_id", user.id)
      .eq("child_id", targetId)
      .limit(1),
    // (d) the caller's coordinator grades + the target's enrolled grades, both
    // scoped to the caller's school (skip when the caller has no school).
    callerSchoolId
      ? admin
          .from("coordinator_scope")
          .select("grade")
          .eq("coordinator_id", user.id)
          .eq("school_id", callerSchoolId)
      : emptyRows,
    callerSchoolId
      ? admin
          .from("enrollments")
          .select("classes!inner(grade, school_id)")
          .eq("student_id", targetId)
          .eq("classes.school_id", callerSchoolId)
      : emptyRows,
  ]);

  // (to-one embeds come back as objects at runtime; supabase-js types them as arrays)
  const gradeRows = (gradesQ.data ?? []) as unknown as { classes: { grade: string | null } | null }[];
  const evidence: ResetEvidence = {
    targetInCallerClass: (taughtQ.data ?? []).length > 0,
    parentLinked: (parentQ.data ?? []).length > 0,
    coordinatorGrades: ((scopeQ.data ?? []) as { grade: string | null }[])
      .map((r) => r.grade ?? "")
      .filter(Boolean),
    targetGradesInCallerSchool: gradeRows.map((r) => r.classes?.grade ?? "").filter(Boolean),
  };

  const decision = decideReset(
    { id: user.id, role: (me.role as string | null) ?? null, schoolId: callerSchoolId },
    {
      id: target.id as string,
      role: (target.role as string | null) ?? null,
      schoolId: (target.school_id as string | null) ?? null,
      isPlatformAdmin: !!staffQ.data,
    },
    evidence,
  );
  if (!decision.allowed) {
    return NextResponse.json({ error: "You can't reset this account's password." }, { status: 403 });
  }

  const tempPassword = generateTempPassword();
  const { error: pwErr } = await admin.auth.admin.updateUserById(targetId, {
    password: tempPassword,
  });
  if (pwErr) return NextResponse.json({ error: pwErr.message }, { status: 500 });

  // Force a real password at the next sign-in (dashboard redirects to
  // /auth/update-password while this is set). Best-effort: the password IS
  // already changed, so surface a warning rather than failing the call.
  const { error: flagErr } = await admin
    .from("profiles")
    .update({ must_reset_password: true })
    .eq("id", targetId);

  await admin.from("platform_audit_log").insert({
    actor_id: user.id,
    action: "reset_password",
    target_kind: "profile",
    target_id: targetId,
    detail: { via: decision.via },
  });

  return NextResponse.json({
    ok: true,
    tempPassword,
    username: (target.username as string | null) ?? null,
    ...(flagErr ? { warning: "Password changed, but the change-at-next-sign-in flag could not be set." } : {}),
  });
}
