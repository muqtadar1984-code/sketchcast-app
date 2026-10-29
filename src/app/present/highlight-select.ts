// "Highlight a portion and ask SK to explain it" (founder, 2026-10-28): a
// highlighter stroke on a deck page → the words under it. PURE — no DOM, no
// fetch of its own (the map loader takes its fetches injected) — so the Board,
// the bridge and the tests share one rule.
//
// THE RULE. The stroke's POINTS (not its fat rendered width) give a bounding
// box in page units, padded by 2 % of the page on each side; that box comes
// back through the slide's contain-fit letterbox (pageBoxToSlide) and the
// words of the slide's text map that it covers by at least 40 % of THEIR area
// are the selection, in reading order (deck-text.ts wordsUnderBox — lines top
// to bottom, each line left-to-right or right-to-left by its own script).
// No deck page, no map, or nothing under the ink → null: there is nothing to ask about.

import { PAGE_H, PAGE_W, fitPage, toScreen, type PageBackground, type Stroke } from "@/board/model";
import { pageBoxToSlide, parseDeckMap, slideOf, wordsUnderBox, type Box, type DeckMap, type DeckWord } from "./deck-text";

/** Share of the page added on each side of the stroke's points. */
export const HIGHLIGHT_PAD = 0.02;
/** Share of a WORD's area the box must cover for the word to count. */
export const HIGHLIGHT_MIN_OVERLAP = 0.4;
/** The most of a selection that travels to SK (SkBoardState.selection.text). */
export const SELECTION_MAX_CHARS = 600;
/** How long the "Ask SK about this" chip stays up. */
export const CHIP_MS = 15_000;
/** How long a selection answers "explain this" by voice. */
export const SELECTION_WINDOW_MS = 60_000;

export type HighlightSelection = {
  /** Normalised 0..1 to the SLIDE (not the page). */
  box: Box;
  /** The words under the ink, joined with spaces, at most SELECTION_MAX_CHARS. */
  text: string;
  words: DeckWord[];
  /** 1-based slide number. */
  slideN: number;
};

/** A roll page as the selection needs it: its background, and the deck's
 *  text map when the host has it (deckPage backgrounds name it by path). */
export type HighlightPage = { background: PageBackground; map?: DeckMap | null };

/** A box in PAGE units, clamped to the page. */
export type PageRect = { x: number; y: number; w: number; h: number };

/** The bounding box of a stroke's points, padded by `pad` of the page on each side. Null without points. */
export function strokePointsBox(stroke: Pick<Stroke, "pts">, pad = HIGHLIGHT_PAD, page = { w: PAGE_W, h: PAGE_H }): PageRect | null {
  const n = Math.floor(stroke.pts.length / 3);
  if (!n) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = stroke.pts[i * 3];
    const y = stroke.pts[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return null;
  const px = pad * page.w;
  const py = pad * page.h;
  const clampX = (v: number) => Math.min(page.w, Math.max(0, v));
  const clampY = (v: number) => Math.min(page.h, Math.max(0, v));
  const ax = clampX(x0 - px);
  const ay = clampY(y0 - py);
  const bx = clampX(x1 + px);
  const by = clampY(y1 + py);
  return bx > ax && by > ay ? { x: ax, y: ay, w: bx - ax, h: by - ay } : null;
}

/** Cut on a word boundary at `max` characters. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

/** A box in PAGE units on a deck page → the selection under it, or null. */
export function selectionFromBox(r: PageRect, page: HighlightPage, opts: { rtl?: boolean } = {}): HighlightSelection | null {
  const bg = page.background;
  if (bg.kind !== "deckPage" || !page.map) return null;
  const slide = slideOf(page.map, bg.n);
  if (!slide) return null;
  const box = pageBoxToSlide(r, { w: slide.w || bg.w || PAGE_W, h: slide.h || bg.h || PAGE_H });
  if (!box) return null;
  const words = wordsUnderBox(slide, box, { minOverlap: HIGHLIGHT_MIN_OVERLAP, ...(opts.rtl ? { rtl: true } : {}) });
  const text = clip(
    words
      .map((w) => w.t.trim())
      .filter(Boolean)
      .join(" "),
    SELECTION_MAX_CHARS,
  );
  if (!text) return null;
  return { box, text, words, slideN: slide.n };
}

/** A finished highlighter stroke → the selection under it, or null (another
 *  tool, a non-deck page, no map, or no text under the ink). */
export function selectionFromStroke(stroke: Pick<Stroke, "pts" | "tool">, page: HighlightPage, opts: { rtl?: boolean } = {}): HighlightSelection | null {
  if (stroke.tool !== "highlighter") return null;
  const r = strokePointsBox(stroke);
  return r ? selectionFromBox(r, page, opts) : null;
}

// ── the selection SK is told about ──────────────────────────────────────────

/** What rides in SkBoardState.selection (src/sk/shell/types.ts). */
export type SkSelectionPayload = { generationId: string; n: number; text: string; title?: string };

/** The Board's live selection with the time it was made. */
export type HeldSelection = { selection: SkSelectionPayload; at: number };

export function payloadOf(sel: HighlightSelection, bg: PageBackground, map?: DeckMap | null): SkSelectionPayload | null {
  if (bg.kind !== "deckPage") return null;
  const title = (slideOf(map ?? null, sel.slideN)?.title || bg.title || "").trim();
  return { generationId: bg.generationId, n: sel.slideN, text: sel.text.slice(0, SELECTION_MAX_CHARS), ...(title ? { title: title.slice(0, 160) } : {}) };
}

/** The selection while it can still answer "explain this" (60 s), else undefined. */
export function activeSelection(held: HeldSelection | null | undefined, now: number, windowMs = SELECTION_WINDOW_MS): SkSelectionPayload | undefined {
  if (!held) return undefined;
  const age = now - held.at;
  return age >= 0 && age <= windowMs ? held.selection : undefined;
}

// ── the deck's text map, once per deck ──────────────────────────────────────

/** /api/present/deck-pages GET, as the loader needs it. */
export type DeckMapReply = { status: string; mapUrl?: string | null };

/**
 * One loader per Board: the deck's map is fetched the first time a stroke on
 * one of its pages needs it (the deck-pages GET for the signed URL, then the
 * JSON) and kept for the lesson. A failure is remembered as null for that deck
 * — the chip simply does not appear — and retried on the next lesson.
 */
export function createDeckMapCache(fetchReply: (generationId: string) => Promise<DeckMapReply>, fetchJson: (url: string) => Promise<unknown>) {
  const cache = new Map<string, Promise<DeckMap | null>>();
  return {
    get(generationId: string): Promise<DeckMap | null> {
      let p = cache.get(generationId);
      if (!p) {
        p = (async () => {
          try {
            const r = await fetchReply(generationId);
            if (r.status !== "ready" || !r.mapUrl) return null;
            return parseDeckMap(await fetchJson(r.mapUrl));
          } catch {
            return null;
          }
        })();
        cache.set(generationId, p);
      }
      return p;
    },
  };
}

// ── where the chip goes ─────────────────────────────────────────────────────

/** The "Ask SK about this" chip's spot in the roll's box (CSS px from its
 *  top-left): just under the highlighted box, or just above it when there is
 *  no room below, kept inside the view. `r` is in page units. */
export function chipPosition(r: PageRect, view: { w: number; h: number }, chip: { w: number; h: number } = { w: 190, h: 36 }, gap = 8): { left: number; top: number } {
  const proj = fitPage(view.w, view.h);
  const a = toScreen(r.x, r.y, proj);
  const b = toScreen(r.x + r.w, r.y + r.h, proj);
  const left = Math.max(gap, Math.min(view.w - chip.w - gap, a.x));
  const below = b.y + gap;
  const top = below + chip.h <= view.h - gap ? below : Math.max(gap, a.y - chip.h - gap);
  return { left: Math.round(left), top: Math.round(top) };
}

// ── the chip → the SK panel ─────────────────────────────────────────────────

/** What the Board asks the SK panel to do on her behalf. */
export type BoardAsk = "explain_selection";

/**
 * The one-way line from the Board's chip to the SK panel, made once per Board.
 * The panel mounts lazily (the launcher opens it), so a post is HELD until the
 * panel takes it; subscribers are told so an open panel acts at once and the
 * launcher can open a closed one. A newer post replaces an untaken one.
 */
export function createAskChannel() {
  let pending: BoardAsk | null = null;
  const subs = new Set<(a: BoardAsk) => void>();
  return {
    post(a: BoardAsk) {
      pending = a;
      for (const f of [...subs]) f(a);
    },
    take(): BoardAsk | null {
      const a = pending;
      pending = null;
      return a;
    },
    subscribe(f: (a: BoardAsk) => void): () => void {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}
export type AskChannel = ReturnType<typeof createAskChannel>;
