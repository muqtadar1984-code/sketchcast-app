// Browser voice adapter (client) for the AI Teaching Assistant. Wraps the Web
// Speech APIs behind a small interface so a hosted TTS/STT can be swapped in
// later without touching the panel. Read-aloud starts AS the answer streams
// (sentence by sentence), and is interruptible.

import { speakableText } from "@/utils/speakable";
import { clientSttMode, transcribeLanguageFor } from "@/sk/speech/stt";
import { noticeBrowserFallback, startTranscribeDictation, transcribeUsable } from "./transcribe-client";

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

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
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
};

export function startDictation(onText: (t: string) => void, onEnd: () => void, opts: DictationOptions = {}): (() => void) | null {
  const browserOpts = { ...(opts.lang ? { lang: opts.lang } : {}) };
  if (clientSttMode() === "transcribe" && micSupported() && transcribeUsable()) {
    const lang = opts.lang ?? (typeof document !== "undefined" ? document.documentElement.lang : "") ?? "";
    if (!transcribeLanguageFor(lang)) {
      noticeBrowserFallback(); // a language Transcribe is not set up for
      return startBrowserDictation(onText, onEnd, browserOpts);
    }
    return startTranscribeDictation(onText, onEnd, {
      lang,
      fallback: () => startBrowserDictation(onText, onEnd, browserOpts),
      ...(opts.identify ? { session: { identify: true } } : {}),
      ...(opts.onLanguage ? { onLanguage: opts.onLanguage } : {}),
    });
  }
  return startBrowserDictation(onText, onEnd, browserOpts);
}

/** Browser Web Speech dictation — the default path, and Transcribe's fallback.
 * (Browser STT is weaker on some accents; Transcribe is the hosted option.) */
export function startBrowserDictation(
  onText: (t: string) => void,
  onEnd: () => void,
  opts: { lang?: string } = {},
): (() => void) | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  try {
    const rec = new Ctor();
    rec.lang = opts.lang ?? pageSpeechLang();
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i]![0]!.transcript;
      onText(t);
    };
    rec.onerror = onEnd;
    rec.onend = onEnd;
    rec.start();
    return () => rec.stop();
  } catch {
    return null;
  }
}
