import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { learnerGate } from "@/utils/present/learner-server";
import { skDbFrom } from "@/sk/store-supabase";
import { readPracticeMastery } from "@/sk/practice/mastery-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/present/learn/mastery?kitId=<uuid> — HER practice mastery for one
// kit (SK student Board plan 2026-10-31, phase 4): the short summary at the
// end of a worksheet ("Secure: … · Still learning: …").
//
// Signed-in learner only (learnerGate). Read through HER session: RLS
// (0178 sk_practice_attempts_read_own, 0179 tags) returns her own rows only;
// the student id is the session's. No model call, no service role.
//   → { concepts: [{ key, name, score, band, evidence }] }  (weakest first)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!(await learnerGate(supabase, user)).ok) return NextResponse.json({ error: "For students." }, { status: 403 });
  const kitId = new URL(request.url).searchParams.get("kitId") ?? "";
  if (!UUID.test(kitId)) return NextResponse.json({ error: "Bad kit." }, { status: 400 });
  const read = await readPracticeMastery(skDbFrom(supabase as never), [user.id], { kitId });
  return NextResponse.json(
    { concepts: read.rows.map((r) => ({ key: r.key, name: r.name, score: r.score, band: r.band, evidence: r.evidence })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
