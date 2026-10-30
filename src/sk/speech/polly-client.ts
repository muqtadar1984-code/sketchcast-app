// SK B9 — the client half of the Polly path: a SpeechProvider that asks
// POST /api/sk/speak for one line and plays the mp3 it gets back through one
// <audio> element, firing the word marks into `onWord` (the caption) and the
// viseme marks into `onViseme` (the avatar's mouth) off the element's own
// clock. A 404 from the route means the server flag is off: it throws
// `SpeakUnavailable` so the page stops asking and stays on the browser voice.
//
// 2026-10-30: the same client serves SK_TTS=google. It sends the line's
// language (`lang`, the BCP-47 tag the coordinator speaks in) so the route
// can pick the Google voice for it (a Polly server refuses a non-English
// one with 404). A 429 with reason
// "tts_cap" (the user's monthly Google characters are spent) is also
// `SpeakUnavailable`: the browser voice for the rest of the page.

import type { Marks } from "@/sk/board/engine";
import type { PlayOpts, SpeechProvider, SpeechResult, SynthesizeOpts, VoiceId } from "./provider";

export class SpeakUnavailable extends Error {
  /** "off" = the route answered 404; "tts_cap" = the monthly cap is reached. */
  constructor(readonly reason: "off" | "tts_cap" = "off") {
    super("server speech is not available");
    this.name = "SpeakUnavailable";
  }
}

type SpeakReply = { format?: unknown; audio?: unknown; marks?: unknown; reason?: unknown };

export type ServerSpeechOptions = {
  endpoint?: string;
  /** The line's language (BCP-47), sent with every request. */
  lang?: string;
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Only well-formed, finite marks reach the players (the reply is our own
 * route's, but the client never trusts shape it did not check). */
export function sanitiseMarks(raw: unknown): Marks {
  const m = raw && typeof raw === "object" ? (raw as { words?: unknown; visemes?: unknown }) : {};
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  const words = (Array.isArray(m.words) ? m.words : [])
    .filter((w): w is Marks["words"][number] => !!w && typeof w === "object" && num((w as { i: unknown }).i) && num((w as { t0: unknown }).t0) && num((w as { t1: unknown }).t1) && typeof (w as { text: unknown }).text === "string")
    .map((w) => ({ i: Math.floor(w.i), t0: w.t0, t1: w.t1, text: w.text }))
    .sort((a, b) => a.t0 - b.t0);
  const visemes = (Array.isArray(m.visemes) ? m.visemes : [])
    .filter((v): v is Marks["visemes"][number] => !!v && typeof v === "object" && num((v as { t: unknown }).t) && typeof (v as { v: unknown }).v === "string")
    .map((v) => ({ t: v.t, v: v.v }))
    .sort((a, b) => a.t - b.t);
  return { words, visemes };
}

export class PollyClientSpeechProvider implements SpeechProvider {
  readonly id = "polly-client";
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private inflight: AbortController | null = null;
  private stopCurrent: (() => void) | null = null;

  private readonly endpoint: string;
  readonly lang: string | undefined;

  constructor(
    private readonly look: () => "A" | "B",
    opts: ServerSpeechOptions = {},
  ) {
    this.endpoint = opts.endpoint ?? "/api/sk/speak";
    this.lang = opts.lang;
  }

  async synthesize(text: string, _voice: VoiceId, opts: SynthesizeOpts): Promise<SpeechResult> {
    void _voice; // the route maps the look (and lang) to the voice; the id is for the seam's bookkeeping
    this.cancel();
    const ac = new AbortController();
    this.inflight = ac;
    opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.lang ? { text, look: this.look(), lang: this.lang } : { text, look: this.look() }),
      signal: ac.signal,
    });
    if (this.inflight === ac) this.inflight = null;
    if (res.status === 404) throw new SpeakUnavailable();
    if (res.status === 429) {
      const r = (await res.json().catch(() => null)) as SpeakReply | null;
      if (r?.reason === "tts_cap") throw new SpeakUnavailable("tts_cap");
    }
    if (!res.ok) throw new Error(`speak: HTTP ${res.status}`);
    const j = (await res.json()) as SpeakReply;
    if (j.format !== "mp3" || typeof j.audio !== "string" || !j.audio) throw new Error("speak: malformed reply");
    const bytes = base64ToBytes(j.audio);
    const marks = sanitiseMarks(j.marks);
    return { audio: bytes, format: "mp3", marks, play: (o) => this.play(bytes, marks, o ?? {}) };
  }

  /** Barge-in: abort a pending request and stop whatever is playing. */
  cancel(): void {
    this.inflight?.abort();
    this.inflight = null;
    this.stopCurrent?.();
  }

  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
    }
    return this.audio;
  }

  private play(bytes: Uint8Array, marks: Marks, o: PlayOpts): Promise<void> {
    const a = this.element();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/mpeg" }));
    a.src = this.url;
    a.playbackRate = Math.min(2, Math.max(0.5, o.rate ?? 1));
    return new Promise<void>((resolve, reject) => {
      let wi = 0;
      let vi = 0;
      let raf = 0;
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        a.removeEventListener("ended", onEnd);
        a.removeEventListener("error", onErr);
        o.signal?.removeEventListener("abort", onAbort);
        if (this.stopCurrent === stop) this.stopCurrent = null;
        if (marks.visemes.length) o.onViseme?.("sil", a.currentTime * 1000);
        if (err) reject(err);
        else resolve();
      };
      const tick = () => {
        const t = a.currentTime * 1000;
        while (wi < marks.words.length && marks.words[wi]!.t0 <= t) o.onWord?.({ charIndex: marks.words[wi++]!.i, t });
        while (vi < marks.visemes.length && marks.visemes[vi]!.t <= t) o.onViseme?.(marks.visemes[vi++]!.v, t);
        raf = requestAnimationFrame(tick);
      };
      const onEnd = () => finish();
      const onErr = () => finish(new Error("speak: audio element error"));
      const onAbort = () => stop();
      const stop = () => {
        a.pause();
        finish();
      };
      this.stopCurrent = stop;
      a.addEventListener("ended", onEnd);
      a.addEventListener("error", onErr);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      a.currentTime = 0;
      a.play().then(
        () => {
          if (marks.words.length || marks.visemes.length) raf = requestAnimationFrame(tick);
        },
        (e: unknown) => finish(e instanceof Error ? e : new Error("speak: play blocked")),
      );
    });
  }
}
