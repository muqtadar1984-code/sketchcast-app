import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

// Finalize "Set up your school": create a NEW school and make the signed-in user
// its school_admin. Self-serve is SAFE here because the school is brand-new and
// empty — the admin only ever sees their own school's data (not a claim over an
// existing school's students). Guarded so it can't move an already-attached user
// or re-run for someone who already has a school.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { schoolName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const schoolName = (body.schoolName ?? "").trim();
  if (schoolName.length < 2) {
    return NextResponse.json({ error: "Please enter your school's name." }, { status: 400 });
  }

  // Guard: only an unattached account (no school yet) may create a school here.
  const { data: me } = await supabase.from("profiles").select("school_id").eq("id", user.id).single();
  if (me?.school_id) {
    return NextResponse.json({ error: "Your account is already part of a school." }, { status: 400 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const { data: school, error: sErr } = await admin
    .from("schools")
    .insert({ name: schoolName })
    .select("id")
    .single();
  if (sErr || !school) {
    return NextResponse.json({ error: sErr?.message ?? "Could not create the school." }, { status: 500 });
  }

  // role/school_id are service-role-only (migration 0010), so this must go through admin.
  const { error: pErr } = await admin
    .from("profiles")
    .update({ role: "school_admin", school_id: school.id })
    .eq("id", user.id);
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
