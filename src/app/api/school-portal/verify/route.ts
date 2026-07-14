import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isPortalRole } from "@/utils/school-routing";

export const runtime = "nodejs";

// Post-sign-in tenant/role check for the school portal. The slug in the URL
// only chose which login page rendered; THIS is where the server decides the
// signed-in account actually belongs to that school and fits that door. On any
// mismatch the client signs out immediately. Data was never at stake either way
// — RLS on school_id guards every row — this keeps the EXPERIENCE per-tenant:
// no landing in a portal your account doesn't belong to.
//
// Door rules:
//   principal → role school_admin, same school
//   teacher   → role teacher/coordinator/school_admin, same school
//   student   → role student, same school
//   parent    → any non-student with a parent_links row to a child IN this
//               school (parents deliberately carry no school_id — multi-school)
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { slug?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const slug = (body.slug ?? "").trim().toLowerCase();
  const role = (body.role ?? "").trim();
  if (!slug || !isPortalRole(role)) {
    return NextResponse.json({ error: "slug and a valid role are required." }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Resolve the tenant server-side — never trust a slug for data access.
  const { data: school } = await admin
    .from("schools")
    .select("id")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle();
  if (!school) return NextResponse.json({ error: "Unknown school." }, { status: 404 });
  const schoolId = school.id as string;

  const { data: me } = await admin
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!me) return NextResponse.json({ error: "No profile." }, { status: 403 });
  const myRole = me.role as string;

  const wrongSchool = { error: "This account belongs to a different school." };

  if (role === "parent") {
    if (myRole === "student") return NextResponse.json({ error: "Students sign in through the student door." }, { status: 403 });
    // A parent belongs to a school through their children, not a school_id.
    const { data: links } = await admin.from("parent_links").select("child_id").eq("parent_id", user.id);
    const childIds = (links ?? []).map((l: { child_id: string }) => l.child_id);
    if (childIds.length) {
      const { data: kids } = await admin
        .from("profiles")
        .select("id")
        .in("id", childIds)
        .eq("school_id", schoolId)
        .limit(1);
      if (kids?.length) return NextResponse.json({ ok: true, redirect: "/dashboard/children" });
    }
    return NextResponse.json({ error: "No child of this account is enrolled at this school." }, { status: 403 });
  }

  if (me.school_id !== schoolId) return NextResponse.json(wrongSchool, { status: 403 });

  if (role === "principal" && myRole !== "school_admin") {
    return NextResponse.json({ error: "This door is for the principal — try the teacher sign in." }, { status: 403 });
  }
  if (role === "teacher" && !["teacher", "coordinator", "school_admin"].includes(myRole)) {
    return NextResponse.json({ error: "This door is for school staff." }, { status: 403 });
  }
  if (role === "student" && myRole !== "student") {
    return NextResponse.json({ error: "This door is for students — staff sign in as Teacher." }, { status: 403 });
  }

  return NextResponse.json({ ok: true, redirect: "/dashboard" });
}
