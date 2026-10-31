import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { decidePlan, parseDecision } from "@/sk/practice/plan-decide";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/learn/plan — the approver's decision on a recommended plan
// (SK student Board plan 2026-10-31, phase 4).
//
//   { planId, decision: "approve" | "decline" | "edit", items?, wholeClass?, note? }
//   → { outcome: "done", status, applied? } | { outcome: "refused" | "not_found", reason? }
//
// The decision runs AS THE SIGNED-IN USER through sk_learn_plan_decide()
// (0179): the database checks she is the plan's approver (the class teacher;
// a home student's parent), refuses anyone else — the student, another
// teacher, the parent of a school student (read-only) — and on approve writes
// the shares (her My lessons / student Board) and SK's focus rows in one
// transaction. Nothing here uses the service role.

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const d = parseDecision(raw);
  if ("error" in d) return NextResponse.json({ error: d.error }, { status: 400 });
  const r = await decidePlan(supabase as never, d);
  const status = r.outcome === "done" ? 200 : r.outcome === "not_found" ? 404 : r.outcome === "error" ? 500 : 403;
  return NextResponse.json(r, { status, headers: { "Cache-Control": "no-store" } });
}
