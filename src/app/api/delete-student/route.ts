import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

// Hierarchical DELETION of a student/child account — the destructive sibling
// of /api/reset-password's adult-manages-accounts-below model:
//   · parent       → children they created themselves (parent_links.source
//                    'self'); school-issued links are school-managed
//   · teacher      → students enrolled ONLY in that teacher's classes (an
//                    account shared with another teacher needs the admin)
//   · school_admin → any student of their own school
// Only role='student' targets — adults are never deletable here. Deleting the
// auth user cascades profiles → enrollments / parent_links / progress /
// submissions / shares (0001/0006/0018 FKs); submission uploads aren't FK'd,
// so they're swept from storage first, best-effort.
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
  if (targetId === user.id) {
    return NextResponse.json({ error: "You can't delete your own account here." }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const { data: target } = await admin
    .from("profiles")
    .select("id, role, school_id")
    .eq("id", targetId)
    .maybeSingle();
  if (!target) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  if ((target as { role?: string }).role !== "student") {
    return NextResponse.json({ error: "Only student accounts can be deleted here." }, { status: 403 });
  }

  const { data: callerRow } = await admin
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const caller = callerRow as { role?: string; school_id?: string | null } | null;

  let allowed = false;
  let reason = "You don't manage this account.";

  // Parent path: a self-created child is theirs to remove.
  const { data: linkRow } = await admin
    .from("parent_links")
    .select("source")
    .eq("parent_id", user.id)
    .eq("child_id", targetId)
    .maybeSingle();
  const link = linkRow as { source?: string } | null;
  if (link) {
    if (link.source === "self") allowed = true;
    else reason = "This child's account was created by their school — ask the school to remove it.";
  }

  // School-admin path: any student of their own school.
  if (!allowed && caller?.role === "school_admin" && caller.school_id
      && (target as { school_id?: string | null }).school_id === caller.school_id) {
    allowed = true;
  }

  // Teacher path: the student exists only within the caller's classes.
  if (!allowed) {
    const { data: enr } = await admin
      .from("enrollments")
      .select("class_id, classes!inner(teacher_id)")
      .eq("student_id", targetId);
    const teacherIds = new Set(
      ((enr ?? []) as unknown as { classes: { teacher_id: string } | null }[])
        .map((e) => e.classes?.teacher_id)
        .filter(Boolean),
    );
    if (teacherIds.has(user.id)) {
      if (teacherIds.size === 1) allowed = true;
      else reason = "This student is also in another teacher's class — ask your school admin to remove the account.";
    }
  }

  if (!allowed) return NextResponse.json({ error: reason }, { status: 403 });

  // Storage sweep: submission uploads live under submissions/{uid}/… and are
  // not FK'd — remove them before the rows cascade away with the user.
  const { data: subs } = await admin.from("submissions").select("file_path").eq("student_id", targetId);
  const paths = ((subs ?? []) as { file_path: string | null }[])
    .map((s) => s.file_path)
    .filter((p): p is string => !!p);
  if (paths.length) await admin.storage.from("submissions").remove(paths);

  const { error: dErr } = await admin.auth.admin.deleteUser(targetId);
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
