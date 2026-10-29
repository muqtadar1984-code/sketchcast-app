import { NextResponse } from "next/server";
import type { FactsDb } from "@/sk/facts";
import { savePrefs } from "@/sk/settings";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sk/prefs { readAloud?, handsFree?, suggestions? } → 200 { ok, saved }
//
// SK S6 slice C: the three SK preferences as WORKFLOW FACTS (kind
// "preference"), so they follow the user across devices (src/sk/prefs.ts).
// Written through the caller's OWN session: RLS lets a user write only their
// own rows. Session-gated only, like DELETE /api/sk/memory — a setting must be
// changeable whether or not SK is switched on for this account.

export async function POST(request: Request) {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const reply = await savePrefs(session as unknown as FactsDb, user.id, body);
  return NextResponse.json(reply.body, { status: reply.status });
}
