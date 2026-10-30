// What is on the roll, page by page (2026-10-31). PURE.
//
// Production 2026-10-30: the roll showed "30 / 54" with the video's slides on
// pages 4–25 and the deck on pages 27–54, and SK could not tell "page 31",
// "slide 4 in the deck" and "the next page" apart, because nothing told it
// what the roll held. This module reads it OFF THE ROLL'S OWN PAGES:
//
//   - a deck page carries its deck and its slide number (deckPage n);
//   - a video slide loaded as a page is a frozen frame whose time is that
//     slide's completed frame (loadSlides seeks to slideTime(k) and freezes
//     there), so a frame of the open unit's video within SLIDE_T_TOLERANCE_S
//     of slideTime(k) IS video slide k + 1. A frame she froze herself at some
//     other moment is just a frame.
//
// Why read the roll instead of keeping a ledger of loads: the roll is the one
// truth. A page inserted ANYWHERE — SK's "blank page", the Board's own blank
// button, the rail's "Load the deck", a frozen frame, a caption card — shifts
// every later page, and a ledger would have to hear about each of them (the
// SK bridge is also rebuilt whenever the deck's status changes, so a ledger in
// it would be lost right after a deck load). Reading the pages gives the
// shifted ranges for free, every turn.

import type { PageBackground } from "@/board/model";
import type { SkRollAt, SkRollRange } from "@/sk/shell/types";
import { slideTime, type BoardManifest } from "./board-controller";

/** How close a frame's time must be to a slide's completed frame. */
export const SLIDE_T_TOLERANCE_S = 0.3;
/** At most this many ranges travel with a turn. */
export const ROLL_RANGES_MAX = 20;

/** A loaded item on one page: deck page n of `generationId`, or video slide n (k + 1). */
export type RollItem = { kind: "video" | "deck"; n: number; generationId: string };

/** The open unit's video and its lesson map, to recognise its slide frames. */
export type RollVideo = { generationId: string | null; manifest: BoardManifest | null };

/** The video slide (1-based) a frame of `video` at time `t` is, or null. */
export function videoSlideAt(t: number, video: RollVideo): number | null {
  const m = video.manifest;
  if (!m?.segments.length || !Number.isFinite(t)) return null;
  let best: { k: number; d: number } | null = null;
  for (let k = 0; k < m.segments.length; k++) {
    const d = Math.abs(slideTime(m, k) - t);
    if (d <= SLIDE_T_TOLERANCE_S && (!best || d < best.d)) best = { k, d };
  }
  return best ? best.k + 1 : null;
}

/** Each page's loaded item (null for a page that is not one). */
export function rollItems(pages: readonly PageBackground[], video: RollVideo): Array<RollItem | null> {
  return pages.map((bg) => {
    if (bg.kind === "deckPage") return Number.isInteger(bg.n) && bg.n >= 1 ? { kind: "deck", n: bg.n, generationId: bg.generationId } : null;
    if (bg.kind === "frame" && video.generationId && bg.generationId === video.generationId && typeof bg.t === "number") {
      const n = videoSlideAt(bg.t, video);
      return n ? { kind: "video", n, generationId: bg.generationId } : null;
    }
    return null;
  });
}

/** The items grouped into runs: consecutive pages holding consecutive items
 *  of the same deck / video. Page numbers 1-based, as the Board shows them. */
export function rollRanges(items: ReadonlyArray<RollItem | null>): SkRollRange[] {
  const out: Array<SkRollRange & { g: string }> = [];
  items.forEach((it, i) => {
    if (!it) return;
    const page = i + 1;
    const last = out[out.length - 1];
    if (last && last.kind === it.kind && last.g === it.generationId && last.to === page - 1 && last.last === it.n - 1) {
      last.to = page;
      last.last = it.n;
    } else out.push({ kind: it.kind, from: page, to: page, first: it.n, last: it.n, g: it.generationId });
  });
  return out.slice(0, ROLL_RANGES_MAX).map(({ kind, from, to, first, last }) => ({ kind, from, to, first, last }));
}

/** What the page at `page` (0-based) is. */
export function rollAt(pages: readonly PageBackground[], items: ReadonlyArray<RollItem | null>, page: number): SkRollAt | undefined {
  const it = items[page];
  if (it) return { kind: it.kind, n: it.n };
  const bg = pages[page];
  if (!bg) return undefined;
  if (bg.kind === "blank" || bg.kind === "frame" || bg.kind === "card" || bg.kind === "question") return { kind: bg.kind };
  return { kind: "other" };
}

/** The 0-based roll page holding `kind` item `n` — the one nearest `near` when
 *  it is on the roll more than once — or null. */
export function rollPageOf(items: ReadonlyArray<RollItem | null>, kind: RollItem["kind"], n: number, near = 0): number | null {
  let best: number | null = null;
  items.forEach((it, i) => {
    if (it && it.kind === kind && it.n === n && (best === null || Math.abs(i - near) < Math.abs(best - near))) best = i;
  });
  return best;
}
