import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

// Records ONE tour analytics event to `tour_events` (RLS pins user_id to the
// caller). Best-effort: called via sendBeacon on unload, so it must be cheap and
// tolerant — a failure never affects the user. Reads happen elsewhere (console).

const EVENTS = new Set([
  "tour_started",
  "tour_step_viewed",
  "tour_skipped",
  "tour_step_target_missing",
  "tour_completed",
]);

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  let b: Record<string, unknown>;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const event = String(b.event ?? "");
  const tourKey = String(b.tourKey ?? "").slice(0, 80);
  const version = Number.isFinite(Number(b.version)) ? Number(b.version) : 0;
  if (!EVENTS.has(event) || !tourKey) return NextResponse.json({ ok: false }, { status: 400 });

  await supabase.from("tour_events").insert({
    user_id: user.id,
    role: b.role ? String(b.role).slice(0, 40) : null,
    tour_key: tourKey,
    version,
    event,
    meta: (b.meta ?? null) as Record<string, unknown> | null,
  });
  return NextResponse.json({ ok: true });
}
