import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { noticesEnabledFor } from "@/utils/flags";

export const runtime = "nodejs";

// School notices — withdraw one (0068).
//
//   POST { eventId }  →  { ok: true }
//
// The principal's act, and only the principal's: 0068's se_revoke_admin_only is
// a RESTRICTIVE policy in BOTH directions, so a coordinator can neither land a
// row in the revoked state nor touch one that is already there. Withdrawal
// removes the notice from the banner, the dashboards, the diary fan-in and the
// ICS feed (calendar_events_for filters status) while the ROW SURVIVES for
// audit — leadership keeps reading it.
//
// The update writes status alone; revoked_by / revoked_at are stamped by the
// school_events_stamp_revocation trigger, so the client can't forge either.
//
// Withdrawal is REVERSIBLE — see ./unrevoke. It has to be: se_revoked_nodelete
// blocks deleting a row while it wears the marker, so without a way back a
// mistaken notice could never be cleared up.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { eventId?: string };

export async function POST(request: Request) {
  // The migration half of the gate — no session needed (see /api/notices).
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
  const eventId = typeof body.eventId === "string" && UUID_RE.test(body.eventId) ? body.eventId : null;
  if (!eventId) return NextResponse.json({ error: "A notice id is required." }, { status: 400 });

  const { data: me } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = (me?.role as string | null) ?? null;
  const schoolId = (me?.school_id as string | null) ?? null;
  if (role !== "school_admin" || !schoolId) {
    return NextResponse.json({ error: "Only the principal can withdraw a notice." }, { status: 403 });
  }
  if (!(await noticesEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

  // No status filter on the update: withdrawing an already-withdrawn notice is
  // a no-op the trigger declines to re-stamp, and matching zero rows would
  // otherwise read as a denial. is_notice IS filtered — this endpoint may only
  // touch rows the composer published as notices, so it can never be pointed at
  // an ordinary calendar event and quietly pull it from every subscribed
  // calendar. .select() so an RLS-filtered no-op (0 rows) reads as failure
  // rather than a silent success.
  const { data: rows, error: uErr } = await supabase
    .from("school_events")
    .update({ status: "revoked" })
    .eq("id", eventId)
    .eq("is_notice", true)
    .select("id");
  if (uErr) {
    if (uErr.code === "42501") {
      return NextResponse.json({ error: "That notice isn't yours to withdraw." }, { status: 403 });
    }
    console.error("notices revoke:", uErr.message);
    return NextResponse.json({ error: "Could not withdraw the notice." }, { status: 500 });
  }
  // Another school's notice and a notice that never existed are
  // indistinguishable on purpose — nothing leaks about rows the caller
  // can't see.
  if (!rows?.length) {
    return NextResponse.json({ error: "That notice isn't yours to withdraw." }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
