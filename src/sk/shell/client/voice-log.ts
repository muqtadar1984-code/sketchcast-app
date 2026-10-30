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
