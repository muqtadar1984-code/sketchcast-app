import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

// Records that the caller completed/skipped a tour version (upsert keyed
// user+tour). RLS pins user_id to the caller. Best-effort — a failure just means
// the tour may re-offer on the next visit, never a crash.

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

  const tourKey = String(b.tourKey ?? "").slice(0, 80);
  const version = Number.isFinite(Number(b.version)) ? Number(b.version) : 0;
  const status = b.status === "skipped" ? "skipped" : b.status === "completed" ? "completed" : null;
  if (!tourKey || !status) return NextResponse.json({ ok: false }, { status: 400 });

  await supabase.from("user_tour_progress").upsert(
    { user_id: user.id, tour_key: tourKey, version, status, updated_at: new Date().toISOString() },
    { onConflict: "user_id,tour_key" },
  );
  return NextResponse.json({ ok: true });
}
