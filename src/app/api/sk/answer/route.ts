import { NextResponse } from "next/server";
import { isEventId } from "@/sk/ids";
import { LoopError, submitAnswer, type AnswerResult } from "@/sk/loop";
import { gate, loopDepsFor, readBody, skDeps } from "@/sk/server";
import { withEvent } from "@/sk/store";

export const runtime = "nodejs";

// POST /api/sk/answer — { eventId, sessionId, itemId, attemptNo, response, modality, transcriptConfirmed }
//   → { outcome, score, max, feedback, hintAvailable, independent, … }  (contracts §4)
// Graded ONCE per (itemId, attemptNo): the store's unique key, plus the event
// envelope for the request itself. mcq / true_false / fill_blank / match are
// deterministic (the quiz scorers); short answers come back needs_review.
export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ eventId?: unknown; sessionId?: unknown; itemId?: unknown; attemptNo?: unknown; response?: unknown; modality?: unknown; transcriptConfirmed?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  if (!isEventId(body.eventId)) return NextResponse.json({ error: "eventId must be a UUID." }, { status: 400 });
  const itemId = String(body.itemId ?? "").slice(0, 80);
  const attemptNo = Number(body.attemptNo);
  if (!itemId || !Number.isInteger(attemptNo) || attemptNo < 1) return NextResponse.json({ error: "itemId and attemptNo are required." }, { status: 400 });
  const modality = body.modality === "spoken" ? "spoken" : "typed";
  // Bound the response: a string, boolean, or a small object/array of strings (match).
  const response = boundResponse(body.response);
  if (response === undefined) return NextResponse.json({ error: "response is required." }, { status: 400 });

  const d = await skDeps();
  const s = await d.store.getSession(String(body.sessionId ?? ""));
  if (!s || s.studentId !== g.userId) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const deps = loopDepsFor(d, s.productId, s.chapter);
  if (!deps) return NextResponse.json({ error: "The session's lesson graph is no longer available." }, { status: 410 });

  try {
    const { result } = await withEvent<AnswerResult>(deps.store, s.id, body.eventId, "answer", () =>
      submitAnswer(deps, s, { eventId: body.eventId as string, itemId, attemptNo, response, modality, transcriptConfirmed: body.transcriptConfirmed === true }),
    );
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof LoopError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[sk] answer failed:", e);
    return NextResponse.json({ error: "Could not mark that answer." }, { status: 500 });
  }
}

export function boundResponse(v: unknown): unknown {
  if (typeof v === "string") return v.slice(0, 500);
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => String(x ?? "").slice(0, 200));
  if (v && typeof v === "object") {
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) if (/^\d{1,2}$/.test(k)) out[k] = String(x ?? "").slice(0, 200);
    return out;
  }
  return undefined;
}
