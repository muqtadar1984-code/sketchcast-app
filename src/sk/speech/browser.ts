// SK B4 — the browser adapter: window.speechSynthesis. Client-side only. It
// cannot return bytes, so `audio` is null and the result carries `play()`;
// word boundaries are reported live through onWord (when the engine fires
// them) and `marks.words` stays empty — the contract forbids fabricated times.
// Polly replaces this for the real voice (B3); the seam does not change.

import { EMPTY_MARKS, type PlayOpts, type SpeechProvider, type SpeechResult, type SynthesizeOpts, type VoiceId } from "./provider";

export function browserSpeechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export class BrowserSpeechProvider implements SpeechProvider {
  readonly id = "browser";
  private current: SpeechSynthesisUtterance | null = null;

  constructor(private readonly lang: string = "en-GB") {}

  async synthesize(text: string, voice: VoiceId, _opts: SynthesizeOpts): Promise<SpeechResult> {
    void _opts;
    const play = (opts: PlayOpts = {}) => this.play(text, voice, opts);
    return { audio: null, format: "none", marks: EMPTY_MARKS, play };
  }

  cancel(): void {
    if (!browserSpeechAvailable()) return;
    this.current = null;
    window.speechSynthesis.cancel();
  }

  private play(text: string, voice: VoiceId, opts: PlayOpts): Promise<void> {
    if (!browserSpeechAvailable() || !text.trim()) return Promise.resolve();
    this.cancel();
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang;
      u.rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));
      const wanted = voice.startsWith("browser:") ? voice.slice(8) : "";
      if (wanted && wanted !== "default") {
        const v = window.speechSynthesis.getVoices().find((x) => x.name === wanted || x.voiceURI === wanted);
        if (v) u.voice = v;
      }
      const t0 = performance.now();
      u.onboundary = (e) => {
        if (e.name === "word") opts.onWord?.({ charIndex: e.charIndex, t: performance.now() - t0 });
      };
      const finish = () => {
        if (this.current === u) this.current = null;
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      const onAbort = () => {
        window.speechSynthesis.cancel();
        finish();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.current = u;
      window.speechSynthesis.speak(u);
    });
  }
}
