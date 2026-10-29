import { NextResponse } from "next/server";
import { boundResponse } from "@/app/api/sk/answer/route";
import { gradeItem, MAX_ATTEMPTS } from "@/sk/grade";
import type { KitGrade } from "@/sk/kit-player";
import { kitDeps, parseKitQuery, readyManifest, resolveKit } from "@/sk/kit-server";
import { kitItemIds } from "@/sk/kit-view";
import { gate, readBody } from "@/sk/server";

export const runtime = "nodejs";

// POST /api/sk/kit/answer — { product, chapter, kit, itemId, attemptNo, response }
//   → KitGrade { outcome, score, max, attemptNo, triesLeft }   (SK S3 slice B)
//
// Marks a practice answer on a kit item with the loop's own deterministic
// grader (gradeItem: mcq / true_false / fill_blank / match; short answers come
// back needs_review). The item must be one the kit map assigns to this kit.
// Not metered — marking is prepared teaching, as in /api/sk/answer.
//
// /api/sk/answer cannot take kit items: it marks against a graph session's
// open check. This route is the kit path's equivalent.
//
// ── SLICE C SEAM ─────────────────────────────────────────────────────────────
// Nothing is WRITTEN here yet. Slice C (the remediation ladder) adds, at the
// marked point below: the item_attempts row with objective_key
// (src/sk/objective-key.ts), the sk_objective_mastery update, the
// misconception → hint → slide(k) → check-question ladder, and server-side
// attempt numbering (today the client's attemptNo is trusted, bounded to
// MAX_ATTEMPTS, because nothing is recorded that it could cheat).

export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ product?: unknown; chapter?: unknown; kit?: unknown; itemId?: unknown; attemptNo?: unknown; response?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  const q = parseKitQuery(body);
  const itemId = typeof body.itemId === "string" ? body.itemId.slice(0, 80) : "";
  const attemptNo = Number(body.attemptNo);
  const response = boundResponse(body.response);
  if (!q || !itemId || !Number.isInteger(attemptNo) || attemptNo < 1 || response === undefined) {
    return NextResponse.json({ error: "product, chapter, itemId, attemptNo and response are required." }, { status: 400 });
  }
  if (attemptNo > MAX_ATTEMPTS) return NextResponse.json({ error: "No tries left on this question." }, { status: 409 });
  const deps = kitDeps();
  try {
    const r = await resolveKit(deps, g.userId, q);
    if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason }, { status: r.status });
    const ready = await readyManifest(deps, r);
    if (!ready) return NextResponse.json({ status: "preparing" }, { status: 409 });
    if (!kitItemIds(ready.manifest).has(itemId)) return NextResponse.json({ error: "That question is not part of this lesson." }, { status: 404 });
    const item = await deps.items(ready.admin).get(itemId);
    if (!item) return NextResponse.json({ error: "That question is not available." }, { status: 404 });
    const grade = gradeItem(item, response, { attemptNo, hintsUsed: 0 });
    // SLICE C SEAM: record the attempt (objective_key) and update mastery here.
    const done = grade.outcome === "correct" || grade.outcome === "needs_review";
    const out: KitGrade = { outcome: grade.outcome, score: grade.score, max: grade.max, attemptNo, triesLeft: done ? 0 : Math.max(0, MAX_ATTEMPTS - attemptNo) };
    return NextResponse.json(out);
  } catch (e) {
    console.error("[sk] kit answer failed:", (e as Error).message);
    return NextResponse.json({ error: "Could not mark that answer." }, { status: 500 });
  }
}
