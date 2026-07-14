import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { schoolAnalyticsEnabledFor } from "@/utils/flags";

export const runtime = "nodejs";

// Manage coordinator GRANTS. Coordinator is a capability, not an identity: a
// teacher granted coordinator_scope rows keeps their teacher role and dashboard
// and gains oversight of the granted slice (the RLS policies key off the scope
// rows, not the role enum). Admin-only and flag-gated. Writes go through the
// service role AFTER we verify the caller is a school_admin and the target is
// in the SAME school (multi-tenant safety).

type Body = {
  action?: "add_scope" | "remove_scope" | "revoke_coordinator";
  userId?: string;
  grade?: string;
  subject?: string;
  scopeId?: string;
};

export async function POST(request: Request) {
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

  // Global env flag OR this school's config override (the sales-demo tenant).
  if (!(await schoolAnalyticsEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

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

  if (body.action === "revoke_coordinator") {
    const userId = (body.userId ?? "").trim();
    if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });
    const target = await targetInSchool(userId);
    if (!target) return NextResponse.json({ error: "User not in your school." }, { status: 403 });
    if (target.role !== "teacher" && target.role !== "coordinator") {
      return NextResponse.json({ error: "Only teachers/coordinators can be changed." }, { status: 400 });
    }
    // Remove ALL their grants; normalize legacy enum-coordinators back to teacher
    // (the enum is no longer what powers coordinator access).
    const { error: dErr } = await admin.from("coordinator_scope").delete().eq("coordinator_id", userId);
    if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });
    if (target.role === "coordinator") {
      await admin.from("profiles").update({ role: "teacher" }).eq("id", userId);
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
    // Grants go to teachers (incl. legacy enum-coordinators) — never admins/students.
    if (target.role !== "teacher" && target.role !== "coordinator") {
      return NextResponse.json({ error: "Coordinator access can only be granted to teachers." }, { status: 400 });
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
