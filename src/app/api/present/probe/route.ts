import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentAllowed } from "@/utils/flags";

// STILL ON THE EMAIL ALLOWLIST, AND NOW THE ONLY THING ON IT. Present mode moved
// to a plan gate on 2026-08-29 (utils/present/access.ts); this harness did not.
// That is the whole point: docs/PRESENT-MODE.md warned that widening
// PRESENT_ALLOWED_EMAILS would widen the probe with it, and the fix turned out
// to be separating the two rather than deleting this — so the Phase 0 panel gate
// can still be run when a panel is finally in front of somebody.
export const runtime = "nodejs";

// Present mode, Phase 0 — records ONE ink-latency probe run against a real
// device (migration 0096). The caller is authenticated via their session and
// must be on the Present allowlist; the row is written with the SERVICE ROLE so
// present_probe stays not-client-writable and a signed-in stranger cannot forge
// a device report.
//
// EVERY FAILURE HERE IS A 404, NEVER A 403. Present mode is unreleased and
// restricted to a named account; a 403 would tell anyone probing the app that
// the surface exists and that they merely lack permission. Not signed in, not
// on the list, feature off — all the same reply. teacher_id comes from the
// session, never the body.
//
// Bodies are bounded: a probe report is a few kilobytes of summary statistics,
// never the raw point stream (a two-minute stroke test is megabytes of
// coordinates, and none of it survives the p50/p95 that decides the tier).

const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404 });

/** Accept an object only if it is a plain JSON object within budget. */
function boundedObject(v: unknown, maxBytes: number): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  try {
    if (JSON.stringify(v).length > maxBytes) return null;
  } catch {
    return null; // circular / non-serialisable
  }
  return v as Record<string, unknown>;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !presentAllowed(user)) return NOT_FOUND();

  let b: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    // `JSON.parse` is happy with `null`, `7` and `"x"` — all valid JSON, none of
    // them a body. Without this the first property read throws a TypeError and
    // the caller gets a 500 that looks like a server fault instead of the 400
    // this branch exists to return.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
    }
    b = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const caps = boundedObject(b.caps, 8000);
  const observations = boundedObject(b.observations, 8000);
  const results = boundedObject(b.results, 24000);
  // caps and results are the run; without either there is nothing to record.
  if (!caps || !results) return NextResponse.json({ error: "Nothing to record." }, { status: 400 });

  // The UA is read SERVER-SIDE from the request rather than taken from the body:
  // it is the one field that identifies the panel, and it is the one field a
  // client could most usefully lie about when a result looks bad.
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 500);
  const label = String(b.label ?? "").trim().slice(0, 120) || null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("present_probe")
    .insert({
      teacher_id: user.id,
      label,
      user_agent: userAgent,
      caps,
      observations: observations ?? {},
      results,
    })
    .select("id")
    .single();

  if (error) {
    // A missing table (0096 not applied yet) must read as a clear failure on the
    // panel, not a silent success — the whole point of the run is the record.
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, id: data?.id ?? null });
}

// GET — the runs recorded so far, newest first. This is how the device table is
// read back without a database client: the founder opens it on a laptop after
// walking a building with a tablet. Own rows only (RLS would enforce it anyway;
// the explicit filter means the service role is never the thing standing between
// one teacher's runs and another's).
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !presentAllowed(user)) return NOT_FOUND();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("present_probe")
    .select("id, created_at, label, user_agent, caps, observations, results")
    .eq("teacher_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data ?? [] });
}

// Next auto-implements OPTIONS when a route file does not, replying 204 with an
// `Allow: GET, POST, OPTIONS` header to ANY caller, signed in or not. That is a
// existence disclosure, and it quietly contradicts the rule at the top of this
// file — every other verb answers 404 precisely so the surface is not
// advertised. Defining it here takes that reply back.
export async function OPTIONS() {
  return NOT_FOUND();
}
