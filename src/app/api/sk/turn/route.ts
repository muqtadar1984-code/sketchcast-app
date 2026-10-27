import { NextResponse } from "next/server";
import { isEventId } from "@/sk/ids";
import { runTurn } from "@/sk/loop";
import { gate, loopDepsFor, readBody, skDeps } from "@/sk/server";
import type { SseEvent } from "@/sk/types";
import { parseCursor } from "../command/route";

export const runtime = "nodejs";

// POST /api/sk/turn — { eventId, sessionId, utterance: { text, modality, transcriptConfirmed? }, cursor }
//   → SSE: meta{intent, …} → text / tal … → done{latency, usage, view}   (contracts §4)
// Idempotent on eventId: the FULL event list of the first run is stored; a
// repeat (reconnect replay, double submit) streams the stored list and runs
// nothing — no second model call, no second state change. A concurrent
// duplicate waits for the first run to finish, then replays it.

const enc = new TextEncoder();
const frame = (ev: SseEvent) => enc.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data).replace(/\n/g, "\ndata: ")}\n\n`);

export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ eventId?: unknown; sessionId?: unknown; utterance?: unknown; cursor?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  if (!isEventId(body.eventId)) return NextResponse.json({ error: "eventId must be a UUID." }, { status: 400 });
  const u = body.utterance && typeof body.utterance === "object" ? (body.utterance as Record<string, unknown>) : null;
  const text = String(u?.text ?? "").trim().slice(0, 600);
  if (!u) return NextResponse.json({ error: "utterance is required." }, { status: 400 });
  const utterance = { text, modality: u.modality === "spoken" ? ("spoken" as const) : ("typed" as const), transcriptConfirmed: u.transcriptConfirmed === true };

  const d = await skDeps();
  const s = await d.store.getSession(String(body.sessionId ?? ""));
  if (!s || s.studentId !== g.userId) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  const deps = loopDepsFor(d, s.productId, s.chapter);
  if (!deps) return NextResponse.json({ error: "The session's lesson graph is no longer available." }, { status: 410 });
  const eventId = body.eventId;
  const cursor = parseCursor(body.cursor);

  const claim = await deps.store.claimEvent<SseEvent[]>(s.id, eventId);
  const headers = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" };
  if (claim.status !== "new") {
    const stored = claim.status === "stored" ? claim.event : await claim.done.catch(() => null);
    const events: SseEvent[] = stored ? stored.result : [{ event: "error", data: { message: "The earlier attempt at this turn failed; send it again with a new eventId." } }];
    const replay = new ReadableStream({
      start(controller) {
        for (const ev of events) controller.enqueue(frame(ev.event === "done" ? { event: "done", data: { ...(ev.data as Record<string, unknown>), replayed: true } } : ev));
        controller.close();
      },
    });
    return new Response(replay, { headers });
  }

  // Cancellation (contracts §1.1): the client leaving aborts the model call; the
  // turn still settles (RESUMING → PRESENTING) and is stored so a replay is consistent.
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", onRequestAbort, { once: true });

  const stream = new ReadableStream({
    cancel() {
      abort.abort();
    },
    async start(controller) {
      const sent: SseEvent[] = [];
      const send = (ev: SseEvent) => {
        sent.push(ev);
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(frame(ev));
        } catch {
          /* client gone */
        }
      };
      try {
        for await (const ev of runTurn(deps, s, { eventId, utterance, cursor, signal: abort.signal })) send(ev);
        await deps.store.completeEvent(s.id, eventId, "turn", sent);
      } catch (e) {
        console.error("[sk] turn failed:", e);
        send({ event: "error", data: { message: "Something went wrong with that turn." } });
        await deps.store.releaseEvent(s.id, eventId, e);
      } finally {
        request.signal.removeEventListener("abort", onRequestAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, { headers });
}
