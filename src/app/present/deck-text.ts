// The deck's text map (worker `deck_pages` job, sketchcast-ai feat/deck-pages):
// what is written where on each rendered slide. PURE — no DOM, no fetch — so the
// route can parse it, the Board can keep a reference to it, and a later
// "highlight a portion and ask SK" can turn a highlighter stroke into the words
// under it without a second source of truth.
//
// Groundwork only (founder, 2026-10-28): "Later a teacher highlights a portion
// and asks SK to explain it — for that the document must be loaded." Nothing
// here draws a button. `textUnderBox(slide, pageBoxToSlide(strokeBounds(s), slide))`
// is the whole of what that feature will need from this file.
//
// BOXES ARE NORMALISED 0..1 TO THE SLIDE (x right, y down), taken by the worker
// from the rendered PDF so they line up with the PNG. The Board draws the PNG
// CONTAINED in its 1600x900 page, so a box in page units has to come back
// through that letterbox first (pageBoxToSlide).

import { PAGE_H, PAGE_W } from "@/board/model";

/** [x0, y0, x1, y1], normalised 0..1 to the slide. */
export type Box = [number, number, number, number];
export type DeckWord = { t: string; b: Box };

export type DeckMapSlide = {
  /** 1-based slide number. */
  n: number;
  part?: number;
  /** The PNG's file name in the deck_pages folder ("slide_01.png"). */
  png: string;
  /** The PNG's size in pixels. */
  w: number;
  h: number;
  title: string;
  notes: string;
  text: string;
  words: DeckWord[];
  blocks: DeckWord[];
};

export type DeckMap = { v: 1; renderer: string; slides: DeckMapSlide[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function box(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(fin)) return null;
  const [x0, y0, x1, y1] = v as number[];
  return x1 >= x0 && y1 >= y0 ? [x0, y0, x1, y1] : null;
}

function words(v: unknown): DeckWord[] {
  if (!Array.isArray(v)) return [];
  const out: DeckWord[] = [];
  for (const w of v) {
    if (!isObj(w) || typeof w.t !== "string" || !w.t.trim()) continue;
    const b = box(w.b);
    if (b) out.push({ t: w.t, b });
  }
  return out;
}

/**
 * Parse a pages.json. Null when it is not a v1 map at all; otherwise lenient
 * PER ENTRY — a word with a broken box is dropped, never the slide — because a
 * slide that lost one word is still a slide she can teach from.
 */
export function parseDeckMap(raw: unknown): DeckMap | null {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.slides)) return null;
  const slides: DeckMapSlide[] = [];
  for (const s of raw.slides) {
    if (!isObj(s) || !fin(s.n) || !Number.isInteger(s.n) || s.n < 1) continue;
    slides.push({
      n: s.n,
      ...(fin(s.part) ? { part: s.part } : {}),
      png: str(s.png),
      w: fin(s.w) && s.w > 0 ? s.w : PAGE_W,
      h: fin(s.h) && s.h > 0 ? s.h : PAGE_H,
      title: str(s.title),
      notes: str(s.notes),
      text: str(s.text),
      words: words(s.words),
      blocks: words(s.blocks),
    });
  }
  slides.sort((a, b) => a.n - b.n);
  return { v: 1, renderer: str(raw.renderer), slides };
}

/** Slide n (1-based) of a map, or null. */
export function slideOf(map: DeckMap | null | undefined, n: number): DeckMapSlide | null {
  return map?.slides.find((s) => s.n === n) ?? null;
}

/** What SK is told about a slide as a whole: its title, its speaker notes, its text. */
export function slideContext(slide: Pick<DeckMapSlide, "title" | "notes" | "text">): { title: string; notes: string; text: string } {
  return { title: slide.title.trim(), notes: slide.notes.trim(), text: slide.text.trim() };
}

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

function intersection(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export type UnderBoxOptions = {
  /** The share of a WORD's area the box must cover for the word to count. Default 0.5. */
  minOverlap?: number;
  /** Two words are on one line when their centres are within this many median
   *  word heights of each other vertically. Default 0.5. */
  lineTolerance?: number;
  /** The deck's own direction, when known (its language is Arabic, Jawi,
   *  Hebrew…). Decides only the lines that carry no letters of either kind
   *  (a row of numbers); a line with letters goes by its own script. */
  rtl?: boolean;
};

// Hebrew, Arabic (incl. the Jawi letters, which live in the Arabic blocks),
// Syriac, Thaana, NKo, Samaritan, Arabic Supplement/Extended-A, and the Hebrew
// and Arabic presentation forms.
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const LETTER = /\p{L}/u;

/**
 * Is this line right-to-left? By MAJORITY of its letters: an Arabic sentence
 * with one English term in it is still read right to left, and an English line
 * quoting one Arabic word is not. A line with no letters at all (numbers,
 * symbols) takes the deck's direction when it is known, else LTR.
 */
export function isRtlLine(words: Pick<DeckWord, "t">[], deckRtl = false): boolean {
  let rtl = 0;
  let other = 0;
  for (const w of words) {
    for (const ch of w.t) {
      if (RTL_CHAR.test(ch)) rtl++;
      else if (LETTER.test(ch)) other++;
    }
  }
  if (!rtl && !other) return deckRtl;
  return rtl > other;
}

/**
 * The words a box covers, in reading order.
 *
 * COVERAGE IS MEASURED AGAINST THE WORD, not the box: a highlighter stroke is
 * fat and sloppy and always bigger than what it marks, so "half of the word is
 * under the ink" is the question, never "half of the ink is over the word".
 *
 * Reading order is top-to-bottom by line; a line is the words whose vertical
 * centres sit within `lineTolerance` median word heights of the line's first
 * word. Within a line, left-to-right — or RIGHT-TO-LEFT when the line is
 * mostly Arabic / Jawi / Hebrew letters (isRtlLine), so a highlighted Arabic
 * phrase reads in the order it was written, not mirrored.
 */
export function wordsUnderBox(slide: Pick<DeckMapSlide, "words">, b: Box, opts: UnderBoxOptions = {}): DeckWord[] {
  const min = opts.minOverlap ?? 0.5;
  const hit = slide.words.filter((w) => {
    const a = area(w.b);
    return a > 0 && intersection(w.b, b) / a >= min;
  });
  if (hit.length < 2) return hit;
  const heights = hit.map((w) => w.b[3] - w.b[1]).sort((x, y) => x - y);
  const tol = (opts.lineTolerance ?? 0.5) * heights[Math.floor(heights.length / 2)];
  const cy = (w: DeckWord) => (w.b[1] + w.b[3]) / 2;
  const byY = [...hit].sort((p, q) => cy(p) - cy(q) || p.b[0] - q.b[0]);
  const lines: DeckWord[][] = [];
  for (const w of byY) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(cy(w) - cy(line[0])) <= tol) line.push(w);
    else lines.push([w]);
  }
  return lines.flatMap((l) => (isRtlLine(l, opts.rtl) ? l.sort((p, q) => q.b[2] - p.b[2]) : l.sort((p, q) => p.b[0] - q.b[0])));
}

/** `wordsUnderBox`, joined with spaces — the phrase she highlighted. */
export function textUnderBox(slide: Pick<DeckMapSlide, "words">, b: Box, opts: UnderBoxOptions = {}): string {
  return wordsUnderBox(slide, b, opts)
    .map((w) => w.t.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * A box in PAGE units (strokeBounds' {x, y, w, h}) → the same box normalised
 * to the slide, undoing the contain-fit the Board draws the PNG with. Clamped
 * to the slide; null when the box misses the slide entirely (all letterbox).
 */
export function pageBoxToSlide(
  r: { x: number; y: number; w: number; h: number },
  slide: { w: number; h: number },
  page: { w: number; h: number } = { w: PAGE_W, h: PAGE_H },
): Box | null {
  if (!(slide.w > 0 && slide.h > 0)) return null;
  const s = Math.min(page.w / slide.w, page.h / slide.h);
  const iw = slide.w * s;
  const ih = slide.h * s;
  const ox = (page.w - iw) / 2;
  const oy = (page.h - ih) / 2;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp((r.x - ox) / iw);
  const y0 = clamp((r.y - oy) / ih);
  const x1 = clamp((r.x + r.w - ox) / iw);
  const y1 = clamp((r.y + r.h - oy) / ih);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}
