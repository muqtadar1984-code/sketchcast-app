// SK voice log (2026-10-30): a small client buffer of what SK's voice did,
// flushed to POST /api/sk/voice-log every few seconds and on pagehide, so a
// silent tour on someone's machine shows up in the function logs. Events carry
// no spoken text. Pure enough to test: the sender and the clock are injected.

export type VoiceEvent = {
  /** "sentence" | "blocked" | "fallback" | "mic" | "tour" */
  k: string;
  /** Milliseconds since the log was created. */
  t: number;
  provider?: string;
  ok?: boolean;
  error?: string;
  ms?: number;
  why?: string;
};

const MAX_EVENTS = 40;
const STR = 60;

/** The server's view of a client batch: known keys, short strings, at most 40. */
export function cleanVoiceEvents(raw: unknown): VoiceEvent[] {
  if (!Array.isArray(raw)) return [];
  const s = (v: unknown) => (typeof v === "string" ? v.slice(0, STR) : undefined);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
  return raw.slice(0, MAX_EVENTS).flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const k = s(o.k);
    if (!k) return [];
    const out: VoiceEvent = { k, t: n(o.t) ?? 0 };
    const provider = s(o.provider);
    if (provider) out.provider = provider;
    if (typeof o.ok === "boolean") out.ok = o.ok;
    const error = s(o.error);
    if (error) out.error = error;
    const ms = n(o.ms);
    if (ms !== undefined) out.ms = ms;
    const why = s(o.why);
    if (why) out.why = why;
    return [out];
  });
}

export type VoiceLog = { push: (e: Omit<VoiceEvent, "t">) => void; flush: () => void; dispose: () => void };

export function createVoiceLog(deps: {
  send: (events: VoiceEvent[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  everyMs?: number;
}): VoiceLog {
  const now = deps.now ?? (() => Date.now());
  const setT = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const t0 = now();
  let buf: VoiceEvent[] = [];
  let timer: unknown = null;
  const flush = () => {
    if (timer !== null) clearT(timer);
    timer = null;
    if (!buf.length) return;
    const out = buf.slice(0, MAX_EVENTS);
    buf = [];
    deps.send(out);
  };
  return {
    push(e) {
      if (buf.length >= MAX_EVENTS) return;
      buf.push({ ...e, t: now() - t0 });
      if (timer === null) timer = setT(flush, deps.everyMs ?? 8000);
    },
    flush,
    dispose() {
      flush();
    },
  };
}

/** The browser sender: a beacon (survives pagehide), else a keepalive fetch. */
export function beaconVoiceEvents(events: VoiceEvent[]): void {
  const body = JSON.stringify({ events, ua: typeof navigator !== "undefined" ? navigator.userAgent : "" });
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.("/api/sk/voice-log", new Blob([body], { type: "application/json" }))) return;
  } catch {
    /* fall through */
  }
  void fetch("/api/sk/voice-log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
}

// ── the tour's stops (2026-10-30) ───────────────────────────────────────────
// "The tour skipped the readymade kits section": WHY a stop was passed over
// used to reach only the browser console. Each stop now reports one "tour"
// event to the same log — shown (with how long the page took), or skipped and
// why — so a slow or broken page shows up in the function logs.
//
//   k        "tour"
//   provider the stop id ("kits")
//   ok       true when the stop was shown
//   why      "shown" | "missing" (the page settled without the anchor) |
//            "cap" (the page never settled in SETTLE_CAP_MS) | "away" (she
//            left the stop's page herself)
//   error    "<route> <page>": the route, then what the page looked like —
//            "settled", "still-loading:<signal>" (which loading UI was still
//            on screen), "off-route", "not-ready" or "never-quiet"
//   ms       the wait: from the navigation to the highlight (shown) or to the
//            skip; for "away", how long the stop had been on screen

//   2026-10-31: "abandoned" — the stop's wait was cut off before it decided
//   (the run paused, moved or ended under it); `error` names the run's state.

export type TourOutcome = "shown" | "missing" | "cap" | "away" | "abandoned";

/** A skip's reason: the settled-page wait gives up at its cap, otherwise it
 *  only ever skips a page that settled without the anchor. */
export const skipOutcome = (waitedMs: number, capMs: number): "missing" | "cap" => (waitedMs >= capMs ? "cap" : "missing");

/** What the page looked like when the stop was decided (see above). `loading`
 *  names the loading UI still visible ("aria-busy", "data-loading",
 *  "data-sk-loading", "animate-pulse"), or null. */
export function tourPageState(p: { pathOk: boolean; ready: boolean; loading: string | null }, outcome: TourOutcome): string {
  if (!p.pathOk) return "off-route";
  if (p.loading) return `still-loading:${p.loading}`;
  if (!p.ready) return "not-ready";
  return outcome === "cap" ? "never-quiet" : "settled";
}

/** One "tour" event. The route is shortened (never the page state) so the
 *  pair fits the log's 60-character strings. No spoken text, no page content. */
export function tourEvent(o: { stop: string; route: string; outcome: TourOutcome; ms: number; page: string }): Omit<VoiceEvent, "t"> {
  const page = o.page.slice(0, 40);
  const room = STR - page.length - 1;
  const route = o.route.length > room ? `${o.route.slice(0, Math.max(0, room - 1))}…` : o.route;
  return {
    k: "tour",
    provider: o.stop.slice(0, STR),
    ok: o.outcome === "shown",
    why: o.outcome,
    error: `${route} ${page}`,
    ms: Math.max(0, Math.round(o.ms)),
  };
}

// ── the tour's START (2026-10-31) ───────────────────────────────────────────
// Founder: "Hi SK, show me around" by microphone started nothing. The server
// log had the turn (model → start_tour → the `walkthrough` event) and the voice
// log had SK saying "Here's the tour…", then nothing for five minutes: no
// stop, no skip. Every step between the event and stop 1 now reports:
//
//   k        "walk"
//   provider who asked: "turn-voice" | "turn-text" | "phrase" | "menu" |
//            "bus" (the header 🧭) | "auto" | "retry"
//   why      "asked" | "joined" (one already starting) | "ready" | "empty" |
//            "aborted" | "failed" | "retry" | "no-run" (the retry found nothing)
//   ok       true for "asked" and "ready"
//   error    "stops=<n>", the failure's message, or the run's state
//   ms       since the start was asked

export type WalkVia = "turn-voice" | "turn-text" | "phrase" | "menu" | "bus" | "auto" | "retry";

export function walkEvent(o: { via: WalkVia; why: string; ms?: number; stops?: number; error?: string }): Omit<VoiceEvent, "t"> {
  const e: Omit<VoiceEvent, "t"> = { k: "walk", provider: o.via, why: o.why, ok: o.why === "asked" || o.why === "ready" };
  const error = o.stops !== undefined ? `stops=${o.stops}` : o.error;
  if (error) e.error = error.slice(0, STR);
  if (o.ms !== undefined) e.ms = Math.max(0, Math.round(o.ms));
  return e;
}
