// SK B4 — the SpeechProvider seam (contracts §1.3). Adapters in order of
// arrival: browser (this PR, client-side only), Polly (word + viseme marks),
// Google, Edge, Transcribe. A provider that cannot produce a requested mark
// kind returns `marks.words = []`; it never fabricates word times.

import type { Marks } from "@/sk/board/engine";

/** "polly:Joanna", "edge:aria", "browser:default" … */
export type VoiceId = string;
export type MarkKind = "word" | "viseme";

export type SynthesizeOpts = { marks: MarkKind[]; stream?: boolean; signal?: AbortSignal };

export type PlayOpts = {
  rate?: number;
  signal?: AbortSignal;
  /** Word boundaries as they happen (the browser adapter's only timing). */
  onWord?: (w: { charIndex: number; t: number }) => void;
};

export type SpeechResult = {
  /** Bytes or a stream from a server-side adapter; null when the adapter can only play. */
  audio: Uint8Array | ReadableStream<Uint8Array> | null;
  format: "mp3" | "ogg" | "pcm16" | "none";
  marks: Marks;
  /** Client-only adapters (speechSynthesis) hand back a player instead of bytes. */
  play?: (opts?: PlayOpts) => Promise<void>;
};

export type TranscriptEvent = { partial: string } | { final: string };

export interface SpeechProvider {
  readonly id: string;
  synthesize(text: string, voice: VoiceId, opts: SynthesizeOpts): Promise<SpeechResult>;
  transcribe?(audio: ReadableStream<Uint8Array>, lang: string, opts: { signal?: AbortSignal }): AsyncGenerator<TranscriptEvent, void, void>;
  /** Stop whatever is playing (barge-in). */
  cancel?(): void;
}

export const EMPTY_MARKS: Marks = { words: [], visemes: [] };
