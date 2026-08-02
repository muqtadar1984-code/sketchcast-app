import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { noticesEnabledFor } from "@/utils/flags";

export const runtime = "nodejs";

// School notices — put a withdrawn one back (0068).
//
//   POST { eventId }  →  { ok: true }
//
// The mirror of ./revoke, and the principal's act for the same reason: 0068's
// se_revoke_admin_only is RESTRICTIVE in BOTH directions, so only a school_admin
// of the row's own school may touch a notice that already wears the marker —
// without that USING half the notice's AUTHOR could simply publish it again and
// overturn the principal's decision.
//
// WHY THIS EXISTS AT ALL: se_revoked_nodelete freezes a revoked row against
// DELETE, because the row IS the audit trail of what the school said and when it
// took it back. Withdrawal without a way back would therefore be a one-way door
// — a notice published by mistake (wrong school year, wrong fee, a test row)
// could be hidden but never cleaned up. Un-revoke first, then delete.
//
// The update writes status alone; the school_events_stamp_revocation trigger
// CLEARS revoked_by / revoked_at on the way back, so a second withdrawal can't
// wear the first one's date.

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
    return NextResponse.json({ error: "Only the principal can restore a notice." }, { status: 403 });
  }
  if (!(await noticesEnabledFor(supabase, schoolId))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }

  // No status filter, mirroring ./revoke: restoring an already-live notice is a
  // harmless no-op, and matching zero rows would otherwise read as a denial.
  // is_notice IS filtered — this endpoint may only touch rows the composer
  // published as notices, never an ordinary calendar event. .select() so an
  // RLS-filtered no-op (0 rows) reads as failure rather than a silent success.
  const { data: rows, error: uErr } = await supabase
    .from("school_events")
    .update({ status: "published" })
    .eq("id", eventId)
    .eq("is_notice", true)
    .select("id");
  if (uErr) {
    if (uErr.code === "42501") {
      return NextResponse.json({ error: "That notice isn't yours to restore." }, { status: 403 });
    }
    console.error("notices unrevoke:", uErr.message);
    return NextResponse.json({ error: "Could not restore the notice." }, { status: 500 });
  }
  // Another school's notice and a notice that never existed are
  // indistinguishable on purpose — nothing leaks about rows the caller
  // can't see.
  if (!rows?.length) {
    return NextResponse.json({ error: "That notice isn't yours to restore." }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}
