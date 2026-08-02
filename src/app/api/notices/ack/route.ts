import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { noticesEnabledFor } from "@/utils/flags";

export const runtime = "nodejs";

// School notices — "I have read this" (0068).
//
//   POST { eventId }  →  { ok: true } | { ok: true, already: true }
//
// ONE ack per (notice × PERSON), not per child like the diary: a diary note is
// about one family's child, a notice is about the school, so a parent of three
// signs once. Insert-only — a receipt, never a toggle. The insert runs under
// the CALLER'S session so RLS (na_insert → school_event_readable) proves both
// that the caller is in the notice's audience and that it is still published.
//
// RLS cannot tell a notice from an ordinary calendar event, though — both are
// school_events rows — so the app checks 0068's is_notice before the insert.
// Without it, a staff meeting that predates notices could start collecting
// signatures from every member of staff.

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

  // Read the notice first, under the caller's session. Two jobs: the tenant
  // half of the flag gate resolves from the NOTICE'S school, not the caller's
  // — a parent carries no school_id, so gating on their own profile would 404
  // the very people an Everyone notice is written for. And an unreadable
  // notice is indistinguishable from one that never existed, on purpose.
  const { data: ev } = await supabase
    .from("school_events")
    .select("school_id, status, is_notice")
    .eq("id", eventId)
    .maybeSingle();
  if (!ev) return NextResponse.json({ error: "That notice isn't yours to sign." }, { status: 403 });
  if (!(await noticesEnabledFor(supabase, ev.school_id as string))) {
    return NextResponse.json({ error: "Not enabled." }, { status: 404 });
  }
  // An ordinary calendar event shares this table and can be perfectly READABLE
  // to the caller (se_read/school_event_readable only ask about audience) — but
  // it was never published as a notice and must never collect a signature.
  // 0068's is_notice is the marker; same answer as a row that doesn't exist, so
  // nothing leaks about the school's calendar either way.
  if (!ev.is_notice) return NextResponse.json({ error: "That notice isn't yours to sign." }, { status: 403 });
  // Leadership still READ withdrawn notices (0068's se_read keeps the audit
  // trail visible to them) — but a withdrawn notice is un-signable for
  // everyone, which school_event_readable enforces anyway. Say it plainly here
  // instead of letting it surface as a policy denial.
  if (ev.status !== "published") {
    return NextResponse.json({ error: "That notice has been withdrawn." }, { status: 403 });
  }

  const { error: iErr } = await supabase.from("notice_acks").insert({ event_id: eventId, user_id: user.id });
  if (iErr) {
    // Signing twice is fine — the receipt already exists.
    if (iErr.code === "23505") return NextResponse.json({ ok: true, already: true });
    // RLS denial → outside the notice's audience (or a suspended account).
    if (iErr.code === "42501") {
      return NextResponse.json({ error: "That notice isn't yours to sign." }, { status: 403 });
    }
    console.error("notices ack:", iErr.message);
    return NextResponse.json({ error: "Could not record that." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
