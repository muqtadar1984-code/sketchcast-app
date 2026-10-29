import { NextResponse } from "next/server";
import { isEventId } from "@/sk/ids";
import { kitDeps, parseKitQuery, readyManifest, resolveKit } from "@/sk/kit-server";
import { runKitExplain, runKitRepeat } from "@/sk/kit-turn";
import { kitLangScope, openKitLang, sealKitLang, type KitLangState } from "@/sk/kit-lang";
import { answerLanguage, canSpeakList, langMeta, languageName, overrideForBack, ownName, parseLanguageCommand, targetCode, type SkAnswerLang } from "@/sk/shell/language";
import { LANG_CAN_SPEAK, LANG_NOTHING_TO_REPEAT, LANG_SOURCE_UNSUPPORTED, LANG_SWITCHED, langLine } from "@/sk/shell/language-lines";
import { supportFrom, teachingSupportTokens } from "@/sk/shell/teach";
import { gate, readBody } from "@/sk/server";
import type { SseEvent } from "@/sk/types";

export const runtime = "nodejs";

// POST /api/sk/kit/turn — { eventId, product, chapter, kit, segment, question?, locale?, state? }
//   → SSE: meta{move, segment} → text → done{usage, label, metered?, access, lang, state}
//
// 2026-10-30 — the answer language. SK answers in the student's explicit
// choice, else the KIT's language (its manifest), else her UI locale
// (shell/language.ts answerLanguage). "say that in Malay" typed as the
// question repeats SK's LAST explanation in Malay with ONE translation call
// (kit-turn.ts runKitRepeat — tutor access required, metered ONCE like an
// explain) and keeps Malay for the turns after, until "back to …". The last
// explanation and the choice ride in `state`, a signed note the client echoes
// (kit-lang.ts); `done.lang` carries the direction and voice language.
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
  const body = await readBody<{ eventId?: unknown; product?: unknown; chapter?: unknown; kit?: unknown; segment?: unknown; question?: unknown; locale?: unknown; state?: unknown }>(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  if (!isEventId(body.eventId)) return NextResponse.json({ error: "eventId must be a UUID." }, { status: 400 });
  const q = parseKitQuery(body);
  const segment = typeof body.segment === "string" ? body.segment : "";
  if (!q || !KEY_RE.test(segment)) return NextResponse.json({ error: "product, chapter and segment are required." }, { status: 400 });
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 600) : "";
  const uiLocale = typeof body.locale === "string" ? body.locale : "en";
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
  const sources = manifest.language ? [manifest.language] : [];
  const scopeKey = kitLangScope(q.product, q.chapter);
  const st: KitLangState = openKitLang(body.state, g.userId, scopeKey, new Date());
  const command = question ? parseLanguageCommand(question) : null;

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

  /** The turn's events: an explain/ask in the answer language, or a language
   *  command. Every `done` carries the language and the next signed note. */
  const languageTurn = async function* (): AsyncGenerator<SseEvent, void, void> {
    const next: KitLangState = { ...st, at: new Date().toISOString() };
    let lang = answerLanguage({ override: st.override ?? null, sourceLanguages: sources, uiLocale });
    const finish = (data: Record<string, unknown>): SseEvent => ({
      event: "done",
      data: { ...data, lang: { ...langMeta(lang.lang), override: lang.from === "override" }, state: sealKitLang(next) },
    });
    const line = (text: string, label: "grounded" | "declined" | "supplementary"): SseEvent[] => [
      { event: "meta", data: { move: "lang", segment } },
      { event: "text", data: text },
      finish({ usage: { inputTokens: 0, outputTokens: 0 }, label }),
    ];

    if (command) {
      const code = targetCode(command.target, uiLocale);
      if (!code) {
        yield* line(langLine(LANG_CAN_SPEAK, lang.lang, { list: canSpeakList() }), "declined");
        return;
      }
      if (command.kind === "back") {
        const o = overrideForBack(code, { sourceLanguages: sources, uiLocale });
        if (o) next.override = o;
        else delete next.override;
        lang = answerLanguage({ override: o, sourceLanguages: sources, uiLocale });
        yield* line(langLine(LANG_SWITCHED, lang.lang, { language: ownName(lang.lang) }), "supplementary");
        return;
      }
      const last = st.last;
      if (!last) {
        yield* line(langLine(LANG_NOTHING_TO_REPEAT, lang.lang), "declined");
        return;
      }
      next.override = code;
      lang = { lang: code, from: "override" };
      if (last.lang === code) {
        yield* line(last.text, "grounded");
        return;
      }
      // The original's own section narration widens the support (numbers and
      // names must still occur in the original or the kit's words).
      const sup = supportFrom(manifest, { segmentId: last.segment });
      const support = sup.status === "ready" ? teachingSupportTokens(sup) : [];
      for await (const ev of runKitRepeat(deps, { studentId: g.userId, productSlug, original: last.text, target: code as SkAnswerLang, support, question, signal: abort.signal })) {
        yield ev.event === "done" ? finish(ev.data as Record<string, unknown>) : ev;
      }
      return;
    }

    // An explain / ask, in the answer language; a source SK cannot answer in is said once.
    let text = "";
    let label = "";
    if (lang.unsupportedSource && st.noted !== lang.unsupportedSource) {
      next.noted = lang.unsupportedSource;
      yield { event: "text", data: `${langLine(LANG_SOURCE_UNSUPPORTED, lang.lang, { source: lang.unsupportedSource, language: ownName(lang.lang) })} ` };
    }
    for await (const ev of runKitExplain(deps, { studentId: g.userId, productSlug, manifest, segmentKey: segment, question: question || undefined, language: languageName(lang.lang), signal: abort.signal })) {
      if (ev.event === "text") text += String(ev.data ?? "");
      if (ev.event === "done") {
        label = String((ev.data as { label?: unknown }).label ?? "");
        // The last explanation, whole, for "say that in Malay".
        if (label === "grounded" && text.trim()) next.last = { text: text.trim().slice(0, 4000), lang: lang.lang, segment };
        yield finish(ev.data as Record<string, unknown>);
      } else yield ev;
    }
  };

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
        for await (const ev of languageTurn()) send(ev);
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
