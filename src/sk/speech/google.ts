// SK voice (founder 2026-10-30) — the Google Cloud Text-to-Speech adapter
// (server only): SK's own lines in the lesson videos' premium voices (Chirp 3
// HD; WaveNet for Malay), through the SpeechProvider seam.
//
// One REST call per line (v1 text:synthesize, plain text in, MP3 out) with a
// service-account access token (google-auth.ts) — no API key, no SDK. Chirp
// returns no timepoints, so the word marks are spread over the measured clip
// (google-marks.ts) and there are no visemes. Billed by input character.
// Nothing is cached; no live call is ever made without SK_TTS=google, and
// tests pass `fetch` and `accessToken`.

import { MAX_SPEAK_CHARS } from "./polly-marks";
import { EMPTY_MARKS, type SpeechProvider, type SpeechResult, type SynthesizeOpts, type VoiceId } from "./provider";
import { googleTokenSource, type FetchLike } from "./google-auth";
import { estimateSpeechMs, mp3DurationMs, spreadWords } from "./google-marks";
import { googleLanguageCode, googleVoiceName } from "./google-voices";

export const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
/** Google's cap on one request's input, in UTF-8 bytes. SK's lines stop at
 * MAX_SPEAK_CHARS (1,500 UTF-16 units ≤ 4,500 bytes), so this only guards. */
export const GOOGLE_MAX_INPUT_BYTES = 5000;

export type GoogleSynthesizeBody = {
  input: { text: string };
  voice: { languageCode: string; name: string };
  audioConfig: { audioEncoding: "MP3" };
};

export type GoogleSpeechOptions = {
  fetch?: FetchLike;
  /** A valid access token; `invalidate` drops it after a 401. Default: the shared token source. */
  accessToken?: () => Promise<string>;
  invalidate?: () => void;
};

export class GoogleSpeechProvider implements SpeechProvider {
  readonly id = "google";
  /** Characters billed so far by this instance. */
  chars = 0;
  private readonly fetchImpl: FetchLike;
  private readonly accessToken: () => Promise<string>;
  private readonly invalidate: () => void;

  constructor(opts: GoogleSpeechOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.accessToken = opts.accessToken ?? (() => googleTokenSource().token());
    this.invalidate = opts.invalidate ?? (opts.accessToken ? () => {} : () => googleTokenSource().invalidate());
  }

  async synthesize(text: string, voice: VoiceId, opts: SynthesizeOpts): Promise<SpeechResult> {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return { audio: new Uint8Array(0), format: "mp3", marks: EMPTY_MARKS };
    if (line.length > MAX_SPEAK_CHARS) throw new Error(`google tts: line of ${line.length} chars exceeds ${MAX_SPEAK_CHARS}`);
    const bytes = new TextEncoder().encode(line).length;
    if (bytes > GOOGLE_MAX_INPUT_BYTES) throw new Error(`google tts: line of ${bytes} bytes exceeds ${GOOGLE_MAX_INPUT_BYTES}`);
    const name = googleVoiceName(voice);
    const body: GoogleSynthesizeBody = { input: { text: line }, voice: { languageCode: googleLanguageCode(name), name }, audioConfig: { audioEncoding: "MP3" } };
    const token = await this.accessToken();
    opts.signal?.throwIfAborted();
    const res = await this.fetchImpl(GOOGLE_TTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (res.status === 401) this.invalidate();
    const j = (await res.json().catch(() => null)) as { audioContent?: unknown; error?: { status?: unknown } } | null;
    if (!res.ok) {
      const status = j?.error && typeof j.error.status === "string" ? ` ${j.error.status}` : "";
      throw new Error(`google tts: HTTP ${res.status}${status}`);
    }
    const b64 = j && typeof j.audioContent === "string" ? j.audioContent : "";
    const audio = new Uint8Array(Buffer.from(b64, "base64"));
    if (!audio.length) throw new Error("google tts: empty audio");
    this.chars += line.length;
    if (!opts.marks.includes("word")) return { audio, format: "mp3", marks: EMPTY_MARKS };
    const ms = mp3DurationMs(audio) || estimateSpeechMs(line);
    return { audio, format: "mp3", marks: { words: spreadWords(line, ms), visemes: [] } };
  }
}
