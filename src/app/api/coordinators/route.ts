import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { schoolAnalyticsEnabled } from "@/utils/flags";

export const runtime = "nodejs";

// Manage the coordinator role + scope mapping — the ONLY new writes this feature
// introduces. Admin-only and flag-gated. Promoting a user to `coordinator` and
// setting profiles.role can't be done under the caller's RLS (profiles update is
// self-only), so it goes through the service role AFTER we verify the caller is
// a school_admin and the target is in the SAME school (multi-tenant safety).

type Body = {
  action?: "set_role" | "add_scope" | "remove_scope";
  userId?: string;
  role?: "coordinator" | "teacher";
  grade?: string;
  subject?: string;
  scopeId?: string;
};

export async function POST(request: Request) {
  if (!schoolAnalyticsEnabled()) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // Authorize: caller must be a school_admin with a school.
  const { data: me } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .single();
  if (me?.role !== "school_admin" || !me?.school_id) {
    return NextResponse.json({ error: "School admin only." }, { status: 403 });
  }
  const schoolId = me.school_id as string;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Helper: confirm a target user is a member of THIS school before touching them.
  async function targetInSchool(userId: string): Promise<{ role: string } | null> {
    const { data } = await admin
      .from("profiles")
      .select("role, school_id")
      .eq("id", userId)
      .maybeSingle();
    if (!data || data.school_id !== schoolId) return null;
    return { role: data.role as string };
  }

  if (body.action === "set_role") {
    const userId = (body.userId ?? "").trim();
    const role = body.role;
    if (!userId || (role !== "coordinator" && role !== "teacher")) {
      return NextResponse.json({ error: "userId and a valid role are required." }, { status: 400 });
    }
    const target = await targetInSchool(userId);
    if (!target) return NextResponse.json({ error: "User not in your school." }, { status: 403 });
    // Only promote/demote between teacher and coordinator — never touch admins/students.
    if (target.role !== "teacher" && target.role !== "coordinator") {
      return NextResponse.json({ error: "Only teachers/coordinators can be changed." }, { status: 400 });
    }

    const { error: uErr } = await admin.from("profiles").update({ role }).eq("id", userId);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    // Demoting clears their scope rows so no stale access lingers.
    if (role === "teacher") {
      await admin.from("coordinator_scope").delete().eq("coordinator_id", userId);
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "add_scope") {
    const userId = (body.userId ?? "").trim();
    const grade = (body.grade ?? "").trim();
    const subject = (body.subject ?? "").trim() || null;
    if (!userId || !grade) {
      return NextResponse.json({ error: "userId and grade are required." }, { status: 400 });
    }
    const target = await targetInSchool(userId);
    if (!target) return NextResponse.json({ error: "User not in your school." }, { status: 403 });
    if (target.role !== "coordinator") {
      return NextResponse.json({ error: "Make the user a coordinator first." }, { status: 400 });
    }
    const { error: iErr } = await admin
      .from("coordinator_scope")
      .insert({ coordinator_id: userId, school_id: schoolId, grade, subject });
    if (iErr) {
      const msg = iErr.code === "23505" ? "That grade/subject slice already exists." : iErr.message;
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  if (body.action === "remove_scope") {
    const scopeId = (body.scopeId ?? "").trim();
    if (!scopeId) return NextResponse.json({ error: "scopeId is required." }, { status: 400 });
    // Scope by school so an admin can only remove their own school's rows.
    const { error: dErr } = await admin
      .from("coordinator_scope")
      .delete()
      .eq("id", scopeId)
      .eq("school_id", schoolId);
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
