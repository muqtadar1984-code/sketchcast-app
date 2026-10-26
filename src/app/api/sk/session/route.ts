import { NextResponse } from "next/server";
import { isEventId } from "@/sk/ids";
import { LoopError, openSession, sessionView } from "@/sk/loop";
import { gate, loopDepsFor, readBody, skDeps } from "@/sk/server";
import { withEvent } from "@/sk/store";

export const runtime = "nodejs";

// POST /api/sk/session — create or resume (contracts §4).
// { eventId, productId, chapter, resume? } → { sessionId, graphVersion, state, cursor, bookmarks, access, … }
// Idempotent on eventId: the event is keyed on the STUDENT (no session exists
// yet) so a double-click creates one session, not two.
export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ eventId?: unknown; productId?: unknown; chapter?: unknown; resume?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  if (!isEventId(body.eventId)) return NextResponse.json({ error: "eventId must be a UUID." }, { status: 400 });
  const productId = String(body.productId ?? "").trim().slice(0, 120);
  const chapter = Number(body.chapter);
  if (!productId || !Number.isInteger(chapter) || chapter < 0) return NextResponse.json({ error: "productId and chapter are required." }, { status: 400 });

  const d = await skDeps();
  const deps = loopDepsFor(d, productId, chapter);
  if (!deps) return NextResponse.json({ error: "No lesson graph for that product and chapter." }, { status: 404 });
  try {
    const { result } = await withEvent(deps.store, `student:${g.userId}`, body.eventId, "session.open", async () => {
      const s = await openSession(deps, { studentId: g.userId, productId, chapter, resume: body.resume !== false });
      return sessionView(deps, s);
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof LoopError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[sk] session open failed:", e);
    return NextResponse.json({ error: "Could not open the session." }, { status: 500 });
  }
}
