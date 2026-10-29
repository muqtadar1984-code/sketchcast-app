import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { noticesEnabledFor } from "@/utils/flags";
import { buildNoticeRow, validateNotice, type NoticeInput } from "@/utils/notice-row";

export const runtime = "nodejs";

// School notices — publish one (0068).
//
//   POST { title, body?, audience: "school" | "staff", kind?, link_url?,
//          link_label?, startsAt?, actionBy?, actionLabel?, importance?,
//          featuredUntil? }
//
// A notice IS a school_events row, never a table of its own: that way it
// inherits the audience RLS, the parent resolution (parents carry no school_id
// — they belong through parent_links) and the ICS feed without a second copy of
// any of it. Only two audiences are publishable here — 'school' (Everyone) and
// 'staff' — because 'leadership' and 'class' remain ordinary calendar business
// with their own editor.
//
// Sharing the table means a notice must be EXPLICIT about being one: only the
// notice writers set is_notice = true — this route and SK's click-only
// `notice.school` action, both through buildNoticeRow (utils/notice-row.ts) —
// and every reader surface filters on it. Audience alone would have been enough to sweep the school's
// existing school/staff calendar rows onto the banner — and to start demanding
// a signature for a staff meeting nobody published as a notice.
//
// The insert runs under the CALLER'S session, so RLS (se_admin_write /
// se_coordinator_write) is the authority on who may publish where; this route
// only shapes and pre-validates so denials come back as friendly 400/403s.

type Body = NoticeInput;

export async function POST(request: Request) {
  // Flag gate FIRST (the diary idiom). The env half of noticesEnabledFor is the
  // MIGRATION gate and needs no session, so an app deployed before 0068 has run
  // answers 404 to everyone; the per-tenant half needs the caller's school and
  // runs once the profile is loaded, below.
  if (process.env.FEATURE_NOTICES !== "true") {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // The shape rules live in ONE builder (src/utils/notice-row.ts), shared with
  // SK's click-only notice.school action: same checks, same messages.
  const shaped = validateNotice(body ?? {});
  if (!shaped.ok) return NextResponse.json({ error: shaped.error }, { status: 400 });

  // ── Standing ────────────────────────────────────────────────────────────────
  const { data: me } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (me?.role as string | null) ?? null;
  const schoolId = (me?.school_id as string | null) ?? null;
  if (!schoolId) {
    return NextResponse.json({ error: "Notices belong to a school — your account isn't attached to one." }, { status: 403 });
  }
  // The tenant half of the gate (calendar on for this school, per flags.ts).
  if (!(await noticesEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  // Standing shaping BEFORE the insert so a denial reads as intent, not RLS
  // noise. Coordinators publish school-wide here (0068 gave them their first
  // write path); teachers keep their class events, students write nothing.
  //
  // COORDINATOR IS A GRANT, NOT A ROLE. /api/coordinators deliberately leaves
  // profiles.role at 'teacher' ("a capability, not an identity") and normalises
  // legacy role='coordinator' rows back to teacher, so gating on the enum would
  // 403 every real coordinator out of the write path 0068 opened for them.
  // Detect them the way every other leadership surface does (dashboard/school,
  // timetable/absence, school-assistant): scope rows in THIS school — RLS
  // returns only the caller's own, and the explicit school filter rejects a
  // stale grant from a school they have left.
  if (!role || role === "student") {
    return NextResponse.json({ error: "Only the principal and coordinators publish notices." }, { status: 403 });
  }
  if (role !== "school_admin") {
    const { data: scopes } = await supabase
      .from("coordinator_scope")
      .select("grade")
      .eq("school_id", schoolId)
      .limit(1);
    if (!scopes?.length) {
      return NextResponse.json({ error: "Only the principal and coordinators publish notices." }, { status: 403 });
    }
  }

  const { data: row, error: iErr } = await supabase
    .from("school_events")
    .insert(buildNoticeRow(shaped.fields, { schoolId, createdBy: user.id }))
    .select("id")
    .single();
  if (iErr || !row) {
    // RLS denial → no standing to publish in this school.
    if (iErr?.code === "42501") {
      return NextResponse.json({ error: "You can't publish notices for this school." }, { status: 403 });
    }
    // A CHECK the app didn't already catch (23514) is a shape problem, not a
    // server fault — say so without quoting the constraint at the publisher.
    if (iErr?.code === "23514") {
      return NextResponse.json({ error: "That notice doesn't fit — check the link and the dates." }, { status: 400 });
    }
    // Log the detail; never hand PostgREST internals to the client.
    console.error("notices publish:", iErr?.message);
    return NextResponse.json({ error: "Could not publish the notice." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: row.id });
}
