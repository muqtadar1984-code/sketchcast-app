// SK B9 — the pure half of the Polly adapter: voice mapping, SSML escaping
// with a byte→char map, and the speech-mark parser. No AWS imports, no I/O,
// safe to import from client code and from tests.
//
// Polly speech marks arrive as JSON lines, one object per line:
//   {"time":6,"type":"word","start":31,"end":35,"value":"Mary"}
//   {"time":73,"type":"viseme","value":"E"}
// `time` is milliseconds into the audio; `start`/`end` are BYTE offsets into
// the request text — the whole SSML document when TextType is ssml (the
// docs' example puts "Mary" at byte 31, after `<speak><prosody …>`). The
// caption highlight wants a JS string index into the ORIGINAL line, so
// `ssmlFor` records where every original character lands in the document
// and `parseSpeechMarks` maps each word back through that table.

import type { Marks, WordMark } from "@/sk/board/engine";
import type { VoiceId } from "./provider";

/** One neural English voice per look (A female, B male). */
export const POLLY_VOICES = { female: "Joanna", male: "Matthew" } as const;
export type VoiceGender = keyof typeof POLLY_VOICES;

/** The route's cap on one line. SK's lines are a sentence or three; Polly
 * itself stops at 3,000 billed characters per request. */
export const MAX_SPEAK_CHARS = 1500;

export const pollyVoiceFor = (gender: VoiceGender): VoiceId => `polly:${POLLY_VOICES[gender]}`;

/** The look (A | B, anything else = the default B) → the Polly VoiceId. */
export function voiceForLook(look: unknown): VoiceId {
  return pollyVoiceFor(look === "A" ? "female" : "male");
}

/** "polly:Joanna" → "Joanna". Any other scheme, or a name that is not a
 * plain identifier, falls back to the default male voice: the voice name
 * is sent to AWS verbatim, so only our own two ever go. */
export function pollyVoiceName(voice: VoiceId): string {
  const name = voice.startsWith("polly:") ? voice.slice(6) : "";
  return (Object.values(POLLY_VOICES) as string[]).includes(name) ? name : POLLY_VOICES.male;
}

const SSML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Escape a line for use as SSML character data: the student's words (a
 * typed question echoed back, a quoted answer) can never open a tag. */
export function escapeSsml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => SSML_ESCAPES[c]!);
}

const utf8Bytes = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
const SPEAK_OPEN = "<speak>";
const SPEAK_CLOSE = "</speak>";

export type SsmlDoc = {
  ssml: string;
  /** The original string index (UTF-16 units, what the caption and
   * SpeechSynthesis use) of the character whose bytes cover `byte` in the
   * document, or null when the byte lies in the wrapper. */
  charAtByte: (byte: number) => number | null;
};

/** `<speak>` + the escaped line + `</speak>`, with the byte→char table. */
export function ssmlFor(text: string): SsmlDoc {
  const starts: number[] = []; // byte offset where original char k's bytes begin
  const idx: number[] = []; // its UTF-16 index
  let byte = SPEAK_OPEN.length; // the wrapper is ASCII
  let i = 0;
  let body = "";
  for (const ch of text) {
    const out = SSML_ESCAPES[ch] ?? ch;
    starts.push(byte);
    idx.push(i);
    body += out;
    let n = 0;
    for (const c of out) n += utf8Bytes(c.codePointAt(0)!);
    byte += n;
    i += ch.length;
  }
  const end = byte;
  const charAtByte = (b: number): number | null => {
    if (b < SPEAK_OPEN.length || b >= end || starts.length === 0) return null;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= b) lo = mid;
      else hi = mid - 1;
    }
    return idx[lo]!;
  };
  return { ssml: SPEAK_OPEN + body + SPEAK_CLOSE, charAtByte };
}

/** Polly's en-US viseme symbols → the board's set (contracts §1.3: the
 * Oculus 15). Polly folds voiced/voiceless pairs already (p = p b m,
 * t = t d n l, k = k g ng h …); the vowels map by mouth shape. */
const VISEME_MAP: Record<string, string> = {
  p: "PP",
  t: "DD",
  S: "CH",
  T: "TH",
  f: "FF",
  k: "kk",
  i: "ih",
  r: "RR",
  s: "SS",
  u: "ou",
  "@": "E",
  a: "aa",
  e: "E",
  E: "E",
  o: "oh",
  O: "oh",
  sil: "sil",
};

export function mapViseme(polly: string): string {
  return VISEME_MAP[polly] ?? "sil";
}

type RawMark = { time?: unknown; type?: unknown; start?: unknown; end?: unknown; value?: unknown };

/** Polly's JSON-lines speech marks → Marks. Words carry `i` = the string
 * index of the word in the ORIGINAL line (through `charAtByte`), `t0` =
 * Polly's time and `t1` = the next word's time — Polly gives no end time, so
 * the last word's t1 is the latest mark time (the closing `sil` viseme when
 * visemes were asked for), never an invented duration. Lines that do not
 * parse, marks of other types, and words that land in the wrapper (an SSML
 * tag reported as a word) are dropped. */
export function parseSpeechMarks(jsonLines: string, doc: Pick<SsmlDoc, "charAtByte">): Marks {
  const words: WordMark[] = [];
  const visemes: Marks["visemes"] = [];
  let last = 0;
  for (const line of jsonLines.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let m: RawMark;
    try {
      m = JSON.parse(s) as RawMark;
    } catch {
      continue;
    }
    if (typeof m.time !== "number" || !Number.isFinite(m.time) || m.time < 0) continue;
    const t = Math.round(m.time);
    last = Math.max(last, t);
    if (m.type === "word") {
      if (typeof m.start !== "number" || typeof m.value !== "string" || m.value.startsWith("<")) continue;
      const i = doc.charAtByte(m.start);
      if (i == null) continue;
      words.push({ i, t0: t, t1: t, text: m.value });
    } else if (m.type === "viseme" && typeof m.value === "string") {
      visemes.push({ t, v: mapViseme(m.value) });
    }
  }
  for (let k = 0; k < words.length; k++) words[k]!.t1 = k + 1 < words.length ? words[k + 1]!.t0 : Math.max(last, words[k]!.t0);
  return { words, visemes };
}

/** The [start, end) of the whitespace-delimited word containing string index
 * `at` in `text`, for the caption highlight; null when `at` is outside. */
export function spokenWordSpan(text: string, at: number): { start: number; end: number } | null {
  if (!Number.isInteger(at) || at < 0 || at >= text.length || /\s/.test(text[at]!)) return null;
  let start = at;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = at;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return end > start ? { start, end } : null;
}
