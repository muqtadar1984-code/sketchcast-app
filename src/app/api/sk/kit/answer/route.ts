import { NextResponse } from "next/server";
import { boundResponse } from "@/app/api/sk/answer/route";
import { isEventId } from "@/sk/ids";
import { markKitAnswer, openKitSession } from "@/sk/kit-answer";
import { kitDeps, parseKitQuery, readyManifest, resolveKit } from "@/sk/kit-server";
import { kitItemIds } from "@/sk/kit-view";
import { gate, readBody } from "@/sk/server";

export const runtime = "nodejs";

// POST /api/sk/kit/answer — { eventId, product, chapter, kit, itemId, response }
//   → KitGrade { outcome, score, max, attemptNo, triesLeft, rungs, reveal }
//
// Marks a practice answer on a kit item with the loop's deterministic grader
// (gradeItem; short answers come back needs_review), RECORDS it and answers a
// wrong one with the next rung of the remediation ladder (SK S3 slice C —
// src/sk/kit-answer.ts, src/sk/remediation.ts):
//   * the attempt goes into item_attempts with objective_key, in the student's
//     kit session (sk_sessions, product_id "kit:<generation>");
//   * the attempt number is the SERVER's, counted from stored attempts — an
//     `attemptNo` in the body is ignored; at most 3 (then 409);
//   * idempotent on eventId (sk_events): a repeat replays the stored reply and
//     grades nothing again;
//   * sk_objective_mastery is recomputed for the item's objective (rule sk-b5.1).
// The item must be one the kit map assigns to this kit. Not metered: marking
// and the ladder are prepared teaching with no model call.

export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ eventId?: unknown; product?: unknown; chapter?: unknown; kit?: unknown; itemId?: unknown; response?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  if (!isEventId(body.eventId)) return NextResponse.json({ error: "eventId must be a UUID." }, { status: 400 });
  const q = parseKitQuery(body);
  const itemId = typeof body.itemId === "string" ? body.itemId.slice(0, 80) : "";
  const response = boundResponse(body.response);
  if (!q || !itemId || response === undefined) {
    return NextResponse.json({ error: "product, chapter, itemId and response are required." }, { status: 400 });
  }
  const deps = kitDeps();
  try {
    const r = await resolveKit(deps, g.userId, q);
    if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason }, { status: r.status });
    const ready = await readyManifest(deps, r);
    if (!ready) return NextResponse.json({ status: "preparing" }, { status: 409 });
    if (!kitItemIds(ready.manifest).has(itemId)) return NextResponse.json({ error: "That question is not part of this lesson." }, { status: 404 });
    const items = deps.items(ready.admin);
    if (!(await items.get(itemId))) return NextResponse.json({ error: "That question is not available." }, { status: 404 });
    const session = await openKitSession(deps.store, g.userId, r.kit.generationId, r.kit.chapterRef);
    const { reply } = await markKitAnswer({
      store: deps.store,
      items,
      bank: deps.bank(ready.admin),
      manifest: ready.manifest,
      session,
      itemId,
      eventId: body.eventId,
      response,
      now: deps.now ?? Date.now,
    });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (e) {
    console.error("[sk] kit answer failed:", (e as Error).message);
    return NextResponse.json({ error: "Could not mark that answer." }, { status: 500 });
  }
}
