import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

// Records ONE tour analytics event to `tour_events`. The caller is AUTHENTICATED
// via their session, but the row is written with the SERVICE ROLE so this route's
// event-whitelist + size caps are the only write path (the table is not
// client-writable). user_id is taken from the session, never the body. Best-effort:
// called via sendBeacon on unload, so it must be cheap and tolerant.

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

  // Bound the free-form meta so a client can't bloat the staff-read table.
  let meta: Record<string, unknown> | null = null;
  if (b.meta && typeof b.meta === "object" && JSON.stringify(b.meta).length <= 2000) {
    meta = b.meta as Record<string, unknown>;
  }

  await createAdminClient().from("tour_events").insert({
    user_id: user.id,
    role: b.role ? String(b.role).slice(0, 40) : null,
    tour_key: tourKey,
    version,
    event,
    meta,
  });
  return NextResponse.json({ ok: true });
}
