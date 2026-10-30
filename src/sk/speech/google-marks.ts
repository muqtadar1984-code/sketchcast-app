// SK voice (founder 2026-10-30) — word marks for Google voices, which give
// none: Chirp 3 HD ignores <mark>, so there are no timepoints to read. The
// worker's answer (shared/tts/providers/google.py, chunks.interpolate_words):
// measure the clip, then spread the words over it in proportion to their
// character length. Here the clip is measured by walking its MPEG frame
// headers — no ffmpeg on Vercel, no new dependency. Pure, no I/O.
//
// The times are APPROXIMATE (the worker additionally trims the ~0.5 s of
// silence Chirp leaves at a clip's edges with an ffmpeg pass; this does
// not). No visemes: there is nothing to derive them from.

import type { WordMark } from "@/sk/board/engine";

// kbps by [version row][layer row][index]; index 0 (free) and 15 (bad) are invalid.
const BITRATES: Readonly<Record<string, readonly number[]>> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
// Hz by version bits (0 = MPEG 2.5, 2 = MPEG 2, 3 = MPEG 1).
const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = { 0: [11025, 12000, 8000], 2: [22050, 24000, 16000], 3: [44100, 48000, 32000] };

type Frame = { len: number; samples: number; rate: number; mpeg1: boolean; mono: boolean; layer: number };

/** The frame header at `p`, or null when the four bytes are not one. */
export function frameAt(b: Uint8Array, p: number): Frame | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[p + 1]! >> 3) & 3;
  const layerBits = (b[p + 1]! >> 1) & 3;
  const brIdx = b[p + 2]! >> 4;
  const srIdx = (b[p + 2]! >> 2) & 3;
  const pad = (b[p + 2]! >> 1) & 1;
  if (version === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const layer = 4 - layerBits; // 3 → I, 2 → II, 1 → III
  const mpeg1 = version === 3;
  const kbps = BITRATES[`${mpeg1 ? 1 : 2}-${layer}`]![brIdx]!;
  const rate = SAMPLE_RATES[version]![srIdx]!;
  const bps = kbps * 1000;
  let len: number;
  let samples: number;
  if (layer === 1) {
    len = (Math.floor((12 * bps) / rate) + pad) * 4;
    samples = 384;
  } else if (layer === 2 || mpeg1) {
    len = Math.floor((144 * bps) / rate) + pad;
    samples = 1152;
  } else {
    len = Math.floor((72 * bps) / rate) + pad;
    samples = 576;
  }
  return { len, samples, rate, mpeg1, mono: b[p + 3]! >> 6 === 3, layer };
}

/** Past an ID3v2 tag (10-byte header + syncsafe size, + a footer if flagged). */
function afterId3v2(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0; // "ID3"
  const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
  return 10 + size + (b[5]! & 0x10 ? 10 : 0);
}

const ascii = (b: Uint8Array, p: number, s: string): boolean => {
  for (let k = 0; k < s.length; k++) if (b[p + k] !== s.charCodeAt(k)) return false;
  return true;
};
const u32 = (b: Uint8Array, p: number): number => ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;

/** A Xing / Info / VBRI header in the first frame: `{ frames }` (null when the
 * header carries no frame count), or null when the frame is ordinary audio. */
function vbrHeader(b: Uint8Array, p: number, f: Frame): { frames: number | null } | null {
  if (f.layer === 3) {
    const side = f.mpeg1 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17;
    const x = p + 4 + side;
    if (x + 8 <= b.length && (ascii(b, x, "Xing") || ascii(b, x, "Info"))) {
      const flags = u32(b, x + 4);
      return { frames: flags & 1 && x + 12 <= b.length ? u32(b, x + 8) : null };
    }
  }
  const v = p + 36;
  if (v + 18 <= b.length && ascii(b, v, "VBRI")) return { frames: u32(b, v + 14) };
  return null;
}

/** The audio's duration in ms from its frames: a Xing/Info/VBRI frame count
 * when the first frame carries one, else the sum of every frame. 0 when no
 * frame is found (the caller estimates). */
export function mp3DurationMs(b: Uint8Array): number {
  let p = afterId3v2(b);
  let secs = 0;
  let locked = false;
  while (p + 4 <= b.length) {
    const f = frameAt(b, p);
    if (!f) {
      if (ascii(b, p, "TAG")) break; // ID3v1 at the end
      p++;
      continue;
    }
    // Before the first frame is trusted, the next header must agree (a stray
    // 0xFFE in junk is not a frame).
    if (!locked && p + f.len + 4 <= b.length && !frameAt(b, p + f.len)) {
      p++;
      continue;
    }
    if (p + f.len > b.length) break; // a truncated last frame
    if (!locked) {
      locked = true;
      const vbr = vbrHeader(b, p, f);
      if (vbr) {
        if (vbr.frames) return Math.round(((vbr.frames * f.samples) / f.rate) * 1000);
        p += f.len; // an info frame without a count is silence, not audio
        continue;
      }
    }
    secs += f.samples / f.rate;
    p += f.len;
  }
  return Math.round(secs * 1000);
}

/** When the clip cannot be measured: the worker's ~2.7 words a second, at
 * least 0.6 s. */
export function estimateSpeechMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(Math.max(0.6, words / 2.7) * 1000);
}

/** Whitespace-delimited words of `text`, the first at 0 and the rest spread
 * over `durationMs` by character share — chunks.interpolate_words: each word
 * weighs its length + 1 (the space after it). `i` is the word's UTF-16 index
 * in `text` (what the caption and onWord use); t1 is the next word's t0, the
 * last word's is the clip's end. */
export function spreadWords(text: string, durationMs: number): WordMark[] {
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ i: m.index!, text: m[0], n: [...m[0]].length }));
  if (!words.length) return [];
  const span = Math.max(0, durationMs);
  const total = words.reduce((s, w) => s + w.n, 0) + words.length - 1;
  const out: WordMark[] = [];
  let cursor = 0;
  for (const w of words) {
    out.push({ i: w.i, t0: Math.round(cursor), t1: 0, text: w.text });
    cursor += total ? (span * (w.n + 1)) / total : 0;
  }
  for (let k = 0; k < out.length; k++) out[k]!.t1 = k + 1 < out.length ? out[k + 1]!.t0 : Math.round(span);
  return out;
}
