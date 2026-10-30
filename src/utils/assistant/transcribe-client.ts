// SK S6 slice B — Amazon Transcribe streaming, the BROWSER half. Client-only
// code (window, getUserMedia, AudioWorklet, WebSocket), but deliberately NOT a
// "use client" module: voice-client.ts (a plain module) calls into it, and the
// server/client boundary test forbids calling a "use client" module's
// functions from a plain one. Every browser global is read lazily inside a
// function, so importing it on the server is harmless.
//
// One dictation:
//   1. POST /api/sk/stt/url { lang } → a presigned wss:// URL (or a refusal);
//   2. the mic → AudioWorklet (public/worklets/pcm16-worklet.js) → 16 kHz
//      mono PCM16 in ~100 ms chunks;
//   3. each chunk framed as an event-stream AudioEvent and sent on the socket;
//      TranscriptEvents come back → partial text, then the final text;
//   4. the socket stays open across FINAL results (Transcribe emits one after
//      any short pause); the finals are joined with spaces, and her turn ends
//      when the endpointer (endpointing.ts) hears ~1.5 s of silence with no
//      new words (longer when the words so far sound unfinished): an empty
//      AudioEvent (end of audio), then close. Until 2026-10-30 the FIRST final
//      ended the dictation, so a mid-sentence pause sent half a sentence.
//
// Any failure BEFORE words arrive — a 404/403/429/400 from the route, no mic,
// a socket error, a service exception — hands the dictation to browser Web
// Speech, sticky for the page, and tells the user once ("Using your browser's
// speech recognition."). A failure AFTER words arrived just ends the
// dictation with the words kept.
//
// stop() is SYNCHRONOUS: the socket, the tracks, the worklet and the
// AudioContext are all closed before it returns — so the §2.6 mic gate, whose
// onStop calls the handle inside the blur/hidden/pagehide event, cuts the paid
// stream in the same tick.

import { audioEvent, MessageReader, readServiceEvent } from "./event-stream";
import { pcm16Bytes, PCM_TARGET_RATE } from "./pcm16";
import { createEndpointer, type Endpointer } from "./endpointing";

export const WORKLET_URL = "/worklets/pcm16-worklet.js";
export const WORKLET_NAME = "sk-pcm16-capture";
export const STT_URL_ROUTE = "/api/sk/stt/url";

/** Nothing heard for this long → end, like Web Speech's no-speech timeout. */
export const NO_SPEECH_MS = 8_000;
/** One dictation never streams longer than this (a cost brake). */
export const MAX_DICTATION_MS = 60_000;
/** Audio captured before the socket opens is held, up to ~2 s of chunks. */
const MAX_QUEUED_CHUNKS = 20;
const OPEN = 1;

// ── the seams (real browser objects by default; fakes in tests) ─────────────

export type SttSocket = {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((e: { code?: number }) => void) | null;
};

/** A running capture graph. stop() must release everything synchronously. */
export type AudioGraph = { stop(): void };

export type TranscribeEnv = {
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  openSocket: (url: string) => SttSocket;
  startAudio: (onPcm: (pcm: Int16Array) => void) => Promise<AudioGraph>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
};

type MediaDevicesLike = { getUserMedia(c: MediaStreamConstraints): Promise<{ getTracks(): Array<{ stop(): void }> }> };
type PortLike = { onmessage: ((e: { data: unknown }) => void) | null };
type NodeLike = { connect(n: unknown): unknown; disconnect(): void };
type WorkletNodeLike = NodeLike & { port: PortLike };
type CtxLike = {
  state?: string;
  destination: unknown;
  audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(s: unknown): NodeLike;
  resume?(): Promise<void>;
  close(): Promise<void>;
};

export type BrowserAudioDeps = {
  mediaDevices: MediaDevicesLike;
  AudioContextCtor: new () => CtxLike;
  WorkletNodeCtor: new (ctx: CtxLike, name: string, opts: unknown) => WorkletNodeLike;
  workletUrl?: string;
};

/** getUserMedia → MediaStreamSource → the PCM16 worklet. The worklet's output
 * is silence and is wired to the destination only so the graph is pulled. */
export async function startBrowserAudio(onPcm: (pcm: Int16Array) => void, d: BrowserAudioDeps): Promise<AudioGraph> {
  const stream = await d.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const tracks = stream.getTracks();
  let ctx: CtxLike | null = null;
  let src: NodeLike | null = null;
  let node: WorkletNodeLike | null = null;
  const stop = () => {
    if (node) node.port.onmessage = null;
    try {
      src?.disconnect();
    } catch {
      /* already gone */
    }
    try {
      node?.disconnect();
    } catch {
      /* already gone */
    }
    for (const t of tracks) t.stop();
    if (ctx) void ctx.close().catch(() => undefined);
    src = node = ctx = null;
  };
  try {
    ctx = new d.AudioContextCtor();
    await ctx.audioWorklet.addModule(d.workletUrl ?? WORKLET_URL);
    src = ctx.createMediaStreamSource(stream);
    node = new d.WorkletNodeCtor(ctx, WORKLET_NAME, { processorOptions: { targetRate: PCM_TARGET_RATE, batchSamples: 1600 } });
    node.port.onmessage = (e) => {
      if (e.data instanceof Int16Array) onPcm(e.data);
    };
    src.connect(node);
    node.connect(ctx.destination);
    if (ctx.state === "suspended") void ctx.resume?.().catch(() => undefined);
  } catch (e) {
    stop();
    throw e;
  }
  return { stop };
}

function browserEnv(): TranscribeEnv | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new () => CtxLike;
    webkitAudioContext?: new () => CtxLike;
    AudioWorkletNode?: new (ctx: CtxLike, name: string, opts: unknown) => WorkletNodeLike;
    WebSocket?: new (url: string) => SttSocket;
  };
  const md = typeof navigator !== "undefined" ? (navigator.mediaDevices as unknown as MediaDevicesLike | undefined) : undefined;
  const Ctx = w.AudioContext ?? w.webkitAudioContext;
  const Node = w.AudioWorkletNode;
  const WS = w.WebSocket;
  if (!md?.getUserMedia || !Ctx || !Node || !WS) return null;
  return {
    fetch: (url, init) => window.fetch(url, init),
    openSocket: (url) => new WS(url),
    startAudio: (onPcm) => startBrowserAudio(onPcm, { mediaDevices: md, AudioContextCtor: Ctx, WorkletNodeCtor: Node }),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
  };
}

// ── one streaming session ────────────────────────────────────────────────────

export type FallbackReason = `route_${number}` | "route_failed" | "bad_reply" | "no_audio" | "socket_error" | "socket_closed" | `service_${string}`;

export type TranscribeHandlers = {
  /** Words so far: every final result + the current partial. */
  onPartial(text: string): void;
  /** Words so far after a result became final. */
  onFinal(text: string): void;
  /** The dictation ended (stopped, finished, silent, capped). Called once, async. */
  onEnd(): void;
  /** Transcribe could not serve this dictation and nothing was heard yet: the
   * caller takes over (browser Web Speech). onEnd is NOT called after this. */
  onFallback(reason: FallbackReason): void;
  /** 2026-10-30: the language Transcribe identified for a FINAL result
   * ("ms-MY") — identify-language sessions only. Called before onFinal. */
  onLanguage?(languageCode: string): void;
};

/** `identify`: ask the route for automatic language identification among
 *  the streaming languages, preferring `lang` (stt.ts TRANSCRIBE_ID_OPTIONS).
 *  `endpointing` (default on): her turn ends after a stretch of silence with
 *  no new words (endpointing.ts; `endSilenceMs` / `hesitantMs` tune it). Off
 *  (push-to-talk): it ends only when stopped, silent for `noSpeechMs`, or
 *  capped at `maxMs`. */
export type SessionOptions = {
  endpointing?: boolean;
  endSilenceMs?: number;
  hesitantMs?: number;
  noSpeechMs?: number;
  maxMs?: number;
  identify?: boolean;
};

export type TranscribeSession = { stop(): void };

export function startTranscribeSession(lang: string, h: TranscribeHandlers, env: TranscribeEnv, o: SessionOptions = {}): TranscribeSession {
  let done = false;
  let heard = false;
  let committed = "";
  let socket: SttSocket | null = null;
  let graph: AudioGraph | null = null;
  const queue: Uint8Array[] = [];
  const reader = new MessageReader();
  let noSpeech: unknown = null;
  let maxTimer: unknown = null;
  const endpointer: Endpointer | null =
    o.endpointing === false
      ? null
      : createEndpointer({
          onEndOfTurn: () => finish(),
          setTimeout: env.setTimeout,
          clearTimeout: env.clearTimeout,
          ...(o.endSilenceMs != null ? { silenceMs: o.endSilenceMs } : {}),
          ...(o.hesitantMs != null ? { hesitantMs: o.hesitantMs } : {}),
        });

  const join = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);

  /** Release everything, synchronously. */
  function teardown(sendEnd: boolean) {
    if (noSpeech != null) env.clearTimeout(noSpeech);
    if (maxTimer != null) env.clearTimeout(maxTimer);
    noSpeech = maxTimer = null;
    endpointer?.cancel();
    queue.length = 0;
    const s = socket;
    socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = null;
      s.onclose = null;
      try {
        if (sendEnd && s.readyState === OPEN) s.send(audioEvent(new Uint8Array(0))); // end of audio
      } catch {
        /* closing anyway */
      }
      try {
        s.close(1000);
      } catch {
        /* already closed */
      }
    }
    const g = graph;
    graph = null;
    g?.stop();
  }

  function finish() {
    if (done) return;
    done = true;
    teardown(true);
    queueMicrotask(() => h.onEnd());
  }

  function fail(reason: FallbackReason) {
    if (done) return;
    if (heard) return finish(); // keep the words; just end
    done = true;
    teardown(false);
    h.onFallback(reason);
  }

  function sendPcm(pcm: Int16Array) {
    if (done) return;
    const frame = audioEvent(pcm16Bytes(pcm));
    if (socket && socket.readyState === OPEN) {
      try {
        socket.send(frame);
      } catch {
        fail("socket_error");
      }
    } else if (queue.length < MAX_QUEUED_CHUNKS) queue.push(frame);
  }

  function onMessage(data: unknown) {
    if (done) return;
    let bytes: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (data instanceof Uint8Array) bytes = data;
    if (!bytes) return;
    let events;
    try {
      events = reader.push(bytes).map(readServiceEvent);
    } catch {
      return fail("socket_error");
    }
    for (const ev of events) {
      if (done) return;
      if (ev.kind === "exception") return fail(`service_${ev.type}`);
      if (ev.kind !== "transcript") continue;
      for (const r of ev.results) {
        const text = r.text.trim();
        if (!text) continue;
        heard = true;
        if (r.partial) {
          const sofar = join(committed, text);
          h.onPartial(sofar);
          endpointer?.heard(sofar);
        } else {
          // A final is NOT the end of her turn (a pause makes one): keep
          // listening; the endpointer decides when she has finished. The
          // last final's language is the one reported last.
          committed = join(committed, text);
          if (r.languageCode) h.onLanguage?.(r.languageCode);
          h.onFinal(committed);
          endpointer?.heard(committed);
        }
      }
      if (heard) armNoSpeech(); // words are activity
    }
  }

  function armNoSpeech() {
    if (done) return;
    if (noSpeech != null) env.clearTimeout(noSpeech);
    noSpeech = env.setTimeout(() => finish(), o.noSpeechMs ?? NO_SPEECH_MS);
  }

  void (async () => {
    let url: string;
    try {
      const res = await env.fetch(STT_URL_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(o.identify ? { lang, identify: true } : { lang }),
        cache: "no-store",
      });
      if (done) return;
      if (!res.ok) return fail(`route_${res.status}`);
      const j = (await res.json()) as { url?: unknown };
      if (done) return;
      if (typeof j?.url !== "string" || !j.url.startsWith("wss://")) return fail("bad_reply");
      url = j.url;
    } catch {
      return fail("route_failed");
    }

    // Socket and microphone start together; audio before the socket opens is queued.
    try {
      const s = env.openSocket(url);
      socket = s;
      s.binaryType = "arraybuffer";
      s.onopen = () => {
        if (done || socket !== s) return;
        for (const f of queue.splice(0)) s.send(f);
      };
      s.onmessage = (e) => onMessage(e.data);
      s.onerror = () => fail("socket_error");
      s.onclose = () => fail("socket_closed");
    } catch {
      return fail("socket_error");
    }
    armNoSpeech();
    maxTimer = env.setTimeout(() => finish(), o.maxMs ?? MAX_DICTATION_MS);

    try {
      const g = await env.startAudio(sendPcm);
      if (done) return g.stop(); // stopped while the mic was opening
      graph = g;
    } catch {
      fail("no_audio");
    }
  })();

  return {
    stop() {
      finish();
    },
  };
}

// ── the dictation adapter voice-client.ts swaps in ───────────────────────────

let disabled = false; // sticky for the page once Transcribe has failed
let noticed = false;
let noticeHandler: ((text: string) => void) | null = null;

/** Is Transcribe worth trying in this page? (Browser support and not yet failed.) */
export function transcribeUsable(): boolean {
  return !disabled && browserEnv() !== null;
}

/** Panels may render the one-time notice themselves; otherwise a small
 * transient status line is shown. */
export function setSttNoticeHandler(fn: ((text: string) => void) | null): void {
  noticeHandler = fn;
}

// "Using your browser's speech recognition." — non-English lines await a
// translator's review (ms-arab shows the Rumi Malay line).
const FALLBACK_NOTICE: Readonly<Record<string, string>> = {
  en: "Using your browser's speech recognition.",
  ms: "Menggunakan pengecaman pertuturan pelayar anda.",
  ar: "يتم استخدام التعرّف على الكلام في متصفحك.",
  fr: "Utilisation de la reconnaissance vocale de votre navigateur.",
  es: "Usando el reconocimiento de voz de su navegador.",
  pt: "Usando o reconhecimento de fala do seu navegador.",
  hi: "आपके ब्राउज़र की वाक् पहचान का उपयोग हो रहा है।",
  mr: "तुमच्या ब्राउझरची आवाज ओळख वापरली जात आहे.",
  te: "మీ బ్రౌజర్ యొక్క స్పీచ్ రికగ్నిషన్ ఉపయోగిస్తున్నాం.",
  zh: "正在使用浏览器的语音识别。",
};

export function fallbackNoticeText(lang: string | null | undefined): string {
  const key = (lang ?? "").trim().toLowerCase();
  return FALLBACK_NOTICE[key] ?? FALLBACK_NOTICE[key.split("-")[0]!] ?? FALLBACK_NOTICE.en!;
}

function showStatusLine(text: string): void {
  if (typeof document === "undefined" || !document.body) return;
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = text;
  el.style.cssText =
    "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;max-width:min(90vw,420px);padding:8px 14px;border-radius:10px;background:#1F2933;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);pointer-events:none";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4_000);
}

/** Tell the user ONCE per page that dictation is on the browser's recognizer. */
export function noticeBrowserFallback(): void {
  if (noticed) return;
  noticed = true;
  const text = fallbackNoticeText(typeof document !== "undefined" ? document.documentElement.lang : "en");
  (noticeHandler ?? showStatusLine)(text);
}

export type TranscribeDictationOptions = {
  /** Locale or BCP-47 tag sent to the route ("ms-arab", "en-US"…). */
  lang: string;
  /** Starts browser Web Speech with the SAME callbacks; null if unsupported. */
  fallback: () => (() => void) | null;
  env?: TranscribeEnv;
  session?: SessionOptions;
  /** 2026-10-30: the identified language of the words (with session.identify). */
  onLanguage?: (languageCode: string) => void;
};

/** startDictation's Transcribe branch: same callbacks, same synchronous stop
 * handle. onText gets the words so far; onEnd fires once. */
export function startTranscribeDictation(onText: (t: string) => void, onEnd: () => void, o: TranscribeDictationOptions): (() => void) | null {
  const env = o.env ?? browserEnv();
  if (!env) return o.fallback();
  let inner: (() => void) | null = null;
  let stopped = false;
  const session = startTranscribeSession(
    o.lang,
    {
      onPartial: onText,
      onFinal: onText,
      onEnd,
      ...(o.onLanguage ? { onLanguage: o.onLanguage } : {}),
      onFallback: () => {
        disabled = true;
        noticeBrowserFallback();
        if (stopped) return queueMicrotask(onEnd);
        inner = o.fallback();
        if (!inner) queueMicrotask(onEnd);
      },
    },
    env,
    o.session,
  );
  return () => {
    stopped = true;
    if (inner) {
      const f = inner;
      inner = null;
      f();
    } else session.stop();
  };
}

/** Tests: forget the sticky fallback, the notice and the handler. */
export function __resetTranscribeClientForTests(): void {
  disabled = false;
  noticed = false;
  noticeHandler = null;
}
