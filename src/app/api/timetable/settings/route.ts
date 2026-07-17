import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { timetableEnabledFor } from "@/utils/flags";
import { shapeFromConfig } from "@/utils/timetable";

export const runtime = "nodejs";

// Timetable structure settings — school hours, period list, breaks, per-day
// teacher cap. Principal (school_admin) only: this is the school's skeleton,
// not a per-grade tweak. The body is sanitized by the SAME parser the app
// reads config through (shapeFromConfig), so whatever lands in
// schools.config.timetable is exactly what every page will see — garbage
// fields fall back to defaults instead of being stored.
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
    return NextResponse.json({ error: "School admin only." }, { status: 403 });
  }
  if (!(await timetableEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

  let body: { timetable?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.timetable || typeof body.timetable !== "object") {
    return NextResponse.json({ error: "A timetable settings object is required." }, { status: 400 });
  }

  // Round-trip through the app's own parser: what we store is what we'd read.
  const shape = shapeFromConfig({ timetable: body.timetable });

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const { data: school } = await admin.from("schools").select("config").eq("id", schoolId).maybeSingle();
  const cfg = (school?.config ?? {}) as Record<string, unknown>;
  const prevTimetable = (cfg.timetable ?? {}) as Record<string, unknown>;

  // Merge: structure fields are replaced wholesale; anything else living under
  // config.timetable (the per-grade curriculum overrides) is preserved.
  const nextConfig = {
    ...cfg,
    timetable: {
      ...prevTimetable,
      days: shape.days,
      periods: shape.periods,
      start: shape.start,
      end: shape.end,
      breaks: shape.breaks,
      periodMinutes: shape.periodMinutes,
      maxPerTeacherPerDay: shape.maxPerTeacherPerDay,
    },
  };

  const { error: updErr } = await admin.from("schools").update({ config: nextConfig }).eq("id", schoolId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Shrinking the week can strand existing slots (period 8 rows under a
  // 6-period shape). They aren't deleted — surface the count so the principal
  // knows to tidy up or grow the shape back.
  const { count } = await admin
    .from("timetable_slots")
    .select("id", { count: "exact", head: true })
    .eq("school_id", schoolId)
    .or(`period.gt.${shape.periods.length},day.gt.${shape.days}`);

  return NextResponse.json({ ok: true, shape, orphaned: count ?? 0 });
}
