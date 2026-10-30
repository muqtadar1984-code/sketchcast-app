// Browser voice adapter (client) for the AI Teaching Assistant. Wraps the Web
// Speech APIs behind a small interface so a hosted TTS/STT can be swapped in
// later without touching the panel. Read-aloud starts AS the answer streams
// (sentence by sentence), and is interruptible.

import { speakableText } from "@/utils/speakable";
import { clientSttMode, transcribeLanguageFor } from "@/sk/speech/stt";
import { MAX_DICTATION_MS, NO_SPEECH_MS, noticeBrowserFallback, startTranscribeDictation, transcribeUsable } from "./transcribe-client";
import { createEndpointer } from "./endpointing";

// ── Read-aloud (TTS) — streaming speaker ─────────────────────────────────────

export class StreamSpeaker {
  private buf = "";
  private queue: string[] = [];
  private speaking = false;
  private stopped = false;

  get supported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /** Feed streamed text; complete sentences are spoken as they arrive. */
  push(chunk: string): void {
    if (!this.supported || this.stopped) return;
    this.buf += chunk;
    // Flush whole sentences; keep the trailing partial in the buffer.
    const parts = this.buf.split(/(?<=[.!?])\s+/);
    this.buf = parts.pop() ?? "";
    for (const s of parts) if (s.trim()) this.enqueue(s.trim());
  }

  /** Speak whatever remains (call when the stream ends). */
  flush(): void {
    if (this.buf.trim()) this.enqueue(this.buf.trim());
    this.buf = "";
  }

  private enqueue(sentence: string): void {
    // Models answer in markdown despite their prompts — sanitize at the
    // speech boundary so the voice never says "asterisk" (2026-08-18).
    // A sentence that was ONLY markup (e.g. a "---" rule) speaks nothing.
    const clean = speakableText(sentence);
    if (!clean) return;
    this.queue.push(clean);
    if (!this.speaking) this.next();
  }

  private next(): void {
    if (this.stopped || !this.queue.length) {
      this.speaking = false;
      return;
    }
    this.speaking = true;
    const u = new SpeechSynthesisUtterance(this.queue.shift()!);
    u.rate = 1;
    u.pitch = 1.05;
    u.onend = () => this.next();
    u.onerror = () => this.next();
    window.speechSynthesis.speak(u);
  }

  /** Stop immediately and drop the queue. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.buf = "";
    this.speaking = false;
    if (this.supported) window.speechSynthesis.cancel();
  }
}

// ── Mic input (STT) ──────────────────────────────────────────────────────────

export type SpeechRecResult = ArrayLike<{ transcript: string }> & { isFinal?: boolean };
export type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<SpeechRecResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e?: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

function recognitionCtor(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function micSupported(): boolean {
  return !!recognitionCtor();
}

// The recognition language per UI/lesson locale (the same ten codes as
// src/i18n/locales.ts). Before SK B0 this was hard-coded to en-US, so a Malay
// or Hindi learner's speech was transcribed as English. Jawi is spoken Malay.
// Regional picks: es-ES / pt-BR / ar-SA are the variants with the widest
// Web Speech support; a lesson's own voice region can override later.
const SPEECH_LANG: Readonly<Record<string, string>> = {
  en: "en-US",
  ms: "ms-MY",
  "ms-arab": "ms-MY",
  ar: "ar-SA",
  fr: "fr-FR",
  es: "es-ES",
  pt: "pt-BR",
  te: "te-IN",
  mr: "mr-IN",
  hi: "hi-IN",
  // Not an app locale (yet): a Chinese lesson's tag, for Web Speech and as
  // the browser fallback when Transcribe (zh-CN) is on (SK S6 slice B).
  zh: "zh-CN",
};

/** BCP-47 tag for speech recognition from a locale code OR an <html lang>
 * value ("ms-arab", "ms-Arab", "EN", "hi-IN" all resolve). Unknown → en-US,
 * the pre-B0 behaviour, so nothing regresses for a locale we haven't mapped. */
export function speechLangFor(locale: string | null | undefined): string {
  const key = (locale ?? "").trim().toLowerCase();
  if (!key) return SPEECH_LANG.en!;
  return SPEECH_LANG[key] ?? SPEECH_LANG[key.split("-")[0]!] ?? SPEECH_LANG.en!;
}

/** The page's resolved locale — the server writes it to <html lang>. */
export function pageSpeechLang(): string {
  if (typeof document === "undefined") return SPEECH_LANG.en!;
  return speechLangFor(document.documentElement.lang);
}

/** Start dictation; onText gets the (interim + final) transcript, onEnd fires
 * when recognition stops. Returns a stop() handle, or null if unsupported.
 * `lang` is the recognition language (default: the page's locale).
 *
 * THE swap point for speech-to-text (SK S6 slice B). With
 * NEXT_PUBLIC_SK_STT=transcribe, and a language Transcribe streams (en, ms,
 * ar, zh), the words come from Amazon Transcribe through a presigned
 * WebSocket (transcribe-client.ts); any refusal or failure before words
 * arrive falls back to the browser below — sticky for the page, with one
 * notice. Same signature, same callbacks, same synchronous stop handle, so the
 * SK panel, the Board, the assistant panels and the §2.6 mic gate (whose
 * onStop calls the handle) all inherit it unchanged. */
export type DictationOptions = {
  /** Recognition language (BCP-47 or a locale); default: the page's. */
  lang?: string;
  /** 2026-10-30: with Transcribe, let it identify the spoken language among
   * the streaming languages (en / ms / ar / zh), preferring `lang`, and report
   * it through `onLanguage` ("ms-MY") — so she can switch by speaking. The
   * browser recognizer ignores both (it has no identification). */
  identify?: boolean;
  onLanguage?: (languageCode: string) => void;
  /** 2026-10-30 (default on): her turn ends after a stretch of silence with no
   *  new words (endpointing.ts), not at her first pause. Push-to-talk passes
   *  false: releasing the button ends it. */
  endpointing?: boolean;
};

export function startDictation(onText: (t: string) => void, onEnd: () => void, opts: DictationOptions = {}): (() => void) | null {
  const endpointing = opts.endpointing !== false;
  const browserOpts = { ...(opts.lang ? { lang: opts.lang } : {}), endpointing };
  if (clientSttMode() === "transcribe" && micSupported() && transcribeUsable()) {
    const lang = opts.lang ?? (typeof document !== "undefined" ? document.documentElement.lang : "") ?? "";
    if (!transcribeLanguageFor(lang)) {
      noticeBrowserFallback(); // a language Transcribe is not set up for
      return startBrowserDictation(onText, onEnd, browserOpts);
    }
    return startTranscribeDictation(onText, onEnd, {
      lang,
      fallback: () => startBrowserDictation(onText, onEnd, browserOpts),
      session: { endpointing, ...(opts.identify ? { identify: true } : {}) },
      ...(opts.onLanguage ? { onLanguage: opts.onLanguage } : {}),
    });
  }
  return startBrowserDictation(onText, onEnd, browserOpts);
}

/** Timers for the browser recogniser (the real ones by default; fakes in tests). */
export type DictationClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
};

export type BrowserDictationOptions = {
  lang?: string;
  /** Default on: end her turn by the endpointer, not at the first pause. */
  endpointing?: boolean;
  /** Tests: the recogniser constructor and the clock. */
  Recognition?: new () => SpeechRec;
  clock?: DictationClock;
};

/** Chrome ending a continuous session on its own this many times in a row
 *  with no new words in between = it will not listen; the turn ends. */
const MAX_IDLE_RESTARTS = 3;

/** Browser Web Speech dictation — the default path, and Transcribe's fallback.
 * (Browser STT is weaker on some accents; Transcribe is the hosted option.)
 *
 * 2026-10-30: continuous, so a pause is not the end of her turn — the
 * endpointer (endpointing.ts) ends it after a stretch of silence. Chrome still
 * ends a continuous session by itself now and then (about a minute in, or
 * after a quiet spell): while her turn is not over it is restarted
 * transparently, the earlier words kept. onEnd fires exactly once — an error
 * (onerror, then onend) no longer ends it twice. */
export function startBrowserDictation(onText: (t: string) => void, onEnd: () => void, opts: BrowserDictationOptions = {}): (() => void) | null {
  const Ctor = opts.Recognition ?? recognitionCtor();
  if (!Ctor) return null;
  const clock: DictationClock = opts.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let rec: SpeechRec;
  try {
    rec = new Ctor();
  } catch {
    return null;
  }

  let over = false; // her turn is over: no restart, end at the next onend
  let ended = false; // onEnd has fired
  let earlier = ""; // the words of the sessions Chrome already ended
  let current = ""; // this session's words (finals + the interim)
  let idleRestarts = 0;
  let wordsSinceRestart = false;
  let heardAny = false;
  const timers: unknown[] = [];
  const join = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const sofar = () => join(earlier, current);

  function release() {
    for (const h of timers.splice(0)) clock.clearTimeout(h);
    endpointer?.cancel();
  }
  function finish() {
    if (ended) return;
    ended = over = true;
    release();
    onEnd();
  }
  /** End her turn: stop the recogniser; its onend (after any last words) ends it. */
  function endTurn() {
    if (over) return;
    over = true;
    try {
      rec.stop();
    } catch {
      finish();
    }
  }
  const endpointer =
    opts.endpointing === false ? null : createEndpointer({ onEndOfTurn: endTurn, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

  try {
    rec.lang = opts.lang ?? pageSpeechLang();
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      if (ended) return;
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i]![0]!.transcript;
      current = norm(t);
      const words = sofar();
      if (!words) return;
      heardAny = wordsSinceRestart = true;
      onText(words);
      endpointer?.heard(words);
    };
    // Any error ends her turn, words kept: no-speech (nothing heard), no
    // permission, no device, network, aborted. onend follows and ends it once.
    rec.onerror = () => {
      over = true;
    };
    rec.onend = () => {
      if (ended) return;
      if (over) return finish();
      // Chrome ended the session by itself: her turn goes on.
      earlier = sofar();
      current = "";
      if (wordsSinceRestart) idleRestarts = 0;
      else if (++idleRestarts > MAX_IDLE_RESTARTS) return finish();
      wordsSinceRestart = false;
      try {
        rec.start();
      } catch {
        finish();
      }
    };
    rec.start();
  } catch {
    release();
    return null;
  }
  // The no-speech timeout (nothing at all heard) and the hard cap, as with Transcribe.
  timers.push(
    clock.setTimeout(() => {
      if (!heardAny) endTurn();
    }, NO_SPEECH_MS),
    clock.setTimeout(endTurn, MAX_DICTATION_MS),
  );
  return () => endTurn();
}
