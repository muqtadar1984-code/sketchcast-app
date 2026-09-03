import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { notifyActivationRequest } from "@/utils/notify";

export const runtime = "nodejs";

// "Request activation" from a trial or expired school (0100, Phase 3). Any adult
// member of the school may ask; the request is stamped once on the school's
// private registration row (console-only table — service role) and the founder
// is emailed on the FIRST request only. Idempotent: later clicks return
// already=true and send nothing.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("school_id, role, full_name").eq("id", user.id).maybeSingle();
  if (!me?.school_id) return NextResponse.json({ error: "Your account is not part of a school." }, { status: 400 });
  if (me.role === "student") return NextResponse.json({ error: "Not available." }, { status: 403 });

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const [{ data: school }, { data: reg }] = await Promise.all([
    admin.from("schools").select("id, name, slug").eq("id", me.school_id).maybeSingle(),
    admin.from("school_registrations").select("activation_requested_at").eq("school_id", me.school_id).maybeSingle(),
  ]);
  if (!school) return NextResponse.json({ error: "School not found." }, { status: 404 });
  if (reg?.activation_requested_at) return NextResponse.json({ ok: true, already: true });

  const now = new Date().toISOString();
  // A pre-0100 school has no registration row; the upsert creates one so the
  // console sees the request either way.
  const { error } = await admin
    .from("school_registrations")
    .upsert({ school_id: school.id, activation_requested_at: now, updated_at: now }, { onConflict: "school_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("platform_audit_log").insert({
    actor_id: user.id,
    action: "school.activation_requested",
    target_kind: "school",
    target_id: school.id,
    detail: { by_role: me.role },
  });

  await notifyActivationRequest({
    schoolId: school.id,
    name: (school.name as string) || "School",
    slug: (school.slug as string) ?? null,
    requesterEmail: user.email ?? null,
    requesterName: (me.full_name as string) ?? null,
    requesterRole: me.role as string,
  });

  return NextResponse.json({ ok: true });
}
