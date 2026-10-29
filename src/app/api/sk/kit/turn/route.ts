import { NextResponse } from "next/server";
import { LOCALES } from "@/i18n/locales";
import { isEventId } from "@/sk/ids";
import { kitDeps, parseKitQuery, readyManifest, resolveKit } from "@/sk/kit-server";
import { runKitExplain } from "@/sk/kit-turn";
import { gate, readBody } from "@/sk/server";
import type { SseEvent } from "@/sk/types";

export const runtime = "nodejs";

// POST /api/sk/kit/turn — { eventId, product, chapter, kit, segment, question?, locale? }
//   → SSE: meta{move, segment} → text → done{usage, label, metered?, access}
//
// The student's "explain this" (no question) or a question about the section,
// answered by ONE model call grounded on the section's narration and points
// (src/sk/kit-turn.ts) and metered into sk_usage like every other model turn.
//
// Idempotent on eventId, as /api/sk/turn is: the claim is held under the
// scope key `kit:<student>` (no session row exists on the kit path — see
// store-supabase isScopeKey), so a double submit replays the first answer and
// does not reach the model, or the meter, twice.

const enc = new TextEncoder();
const frame = (ev: SseEvent) => enc.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data).replace(/\n/g, "\ndata: ")}\n\n`);
const KEY_RE = /^p\d{1,3}:[A-Za-z0-9_.-]{1,64}$/;
const HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" };

export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ eventId?: unknown; product?: unknown; chapter?: unknown; kit?: unknown; segment?: unknown; question?: unknown; locale?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  if (!isEventId(body.eventId)) return NextResponse.json({ error: "eventId must be a UUID." }, { status: 400 });
  const q = parseKitQuery(body);
  const segment = typeof body.segment === "string" ? body.segment : "";
  if (!q || !KEY_RE.test(segment)) return NextResponse.json({ error: "product, chapter and segment are required." }, { status: 400 });
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 600) : "";
  const language = LOCALES.find((l) => l.value === body.locale)?.label ?? "English";
  const eventId = body.eventId;

  const deps = kitDeps();
  let r: Awaited<ReturnType<typeof resolveKit>>;
  let ready: Awaited<ReturnType<typeof readyManifest>>;
  try {
    r = await resolveKit(deps, g.userId, q);
    if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason }, { status: r.status });
    ready = await readyManifest(deps, r);
  } catch (e) {
    console.error("[sk] kit turn failed:", (e as Error).message);
    return NextResponse.json({ error: "The lesson could not be loaded." }, { status: 500 });
  }
  if (!ready) return NextResponse.json({ status: "preparing" }, { status: 409 });
  const manifest = ready.manifest;
  const productSlug = r.product.slug;

  const scope = `kit:${g.userId}`;
  const claim = await deps.store.claimEvent<SseEvent[]>(scope, eventId);
  if (claim.status !== "new") {
    const stored = claim.status === "stored" ? claim.event : await claim.done.catch(() => null);
    const events: SseEvent[] = stored ? stored.result : [{ event: "error", data: { message: "The earlier attempt at this turn failed; send it again with a new eventId." } }];
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const ev of events) controller.enqueue(frame(ev.event === "done" ? { event: "done", data: { ...(ev.data as Record<string, unknown>), replayed: true } } : ev));
          controller.close();
        },
      }),
      { headers: HEADERS },
    );
  }

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
        for await (const ev of runKitExplain(deps, { studentId: g.userId, productSlug, manifest, segmentKey: segment, question: question || undefined, language, signal: abort.signal })) send(ev);
        await deps.store.completeEvent(scope, eventId, "kit_turn", sent);
      } catch (e) {
        console.error("[sk] kit turn failed:", e);
        send({ event: "error", data: { message: "Something went wrong with that turn." } });
        await deps.store.releaseEvent(scope, eventId, e);
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
  return new Response(stream, { headers: HEADERS });
}
