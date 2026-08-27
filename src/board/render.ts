// Rendering one page of the roll.
//
// ONE OPAQUE CANVAS. This is not a style preference; it is what Phase 0 found on
// real hardware. A desynchronised canvas — the only kind fast enough for ink,
// 0.7ms input-to-draw against 4.5ms — may be promoted to a low-latency overlay,
// and an overlay is not blended with the page behind it, so every transparent
// pixel presents as BLACK. The obvious design of stacking wet ink over dry ink
// over content is therefore impossible: the top layer would hide everything
// under it. Background, committed ink and the live stroke all go into the SAME
// bitmap, and nothing is stacked above it.
//
// The cost of that is having to un-draw without a transparent layer to clear, so
// there is a second canvas — an ordinary, never-displayed one — holding the page
// exactly as it looks with every COMMITTED stroke and no live one. Erasing the
// live stroke is then a blit of its bounding box out of that backing store. That
// is the machinery the layered model would have avoided, and it is the price of
// the fast context.
//
// The pure geometry lives at the bottom and is unit-tested; everything above it
// needs a canvas and is exercised in the dev gallery.

import type { CaptureProfile } from "./capabilities";
import { quantise, toSegments, tensionFor, type Run, type Segment } from "./ink";
import {
  PAGE_W,
  PAGE_H,
  fitPage,
  type PageBackground,
  type Projection,
  type Stroke,
} from "./model";

export const PAPER = "#FFFFFF";

/** A rectangle in PAGE units. */
export type Rect = { x: number; y: number; w: number; h: number };

// ── pure geometry ────────────────────────────────────────────────────────────

/**
 * A page-unit rect as DEVICE pixels, rounded OUTWARDS.
 *
 * Outwards matters. A dirty rect rounded to nearest can land half a pixel inside
 * the mark it is meant to erase, and what is left behind is a hairline of the
 * old stroke that never goes away — on an opaque canvas there is no clear to
 * rescue it. Growing by a pixel costs nothing and is always safe.
 */
export function deviceRect(r: Rect, proj: Projection, dpr: number): Rect {
  const x0 = Math.floor((r.x * proj.scale + proj.offsetX) * dpr) - 1;
  const y0 = Math.floor((r.y * proj.scale + proj.offsetY) * dpr) - 1;
  const x1 = Math.ceil(((r.x + r.w) * proj.scale + proj.offsetX) * dpr) + 1;
  const y1 = Math.ceil(((r.y + r.h) * proj.scale + proj.offsetY) * dpr) + 1;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Clip a device rect to a bitmap, returning null when nothing is left. Blitting
 *  a rect that starts off-canvas is a silent no-op in some engines and an
 *  exception in others; neither is a good way to find out. */
export function clipRect(r: Rect, w: number, h: number): Rect | null {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const x1 = Math.min(w, r.x + r.w);
  const y1 = Math.min(h, r.y + r.h);
  if (x1 <= x || y1 <= y) return null;
  return { x, y, w: x1 - x, h: y1 - y };
}

/** Union of two rects, for growing a dirty region as a stroke extends. */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x1 - x, h: y1 - y };
}

/** The bounding box of a run of segments, grown by the widest end. */
export function segmentBounds(segs: Segment[], baseWidth: number): Rect | null {
  if (!segs.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxW = 0;
  for (const s of segs) {
    // Control points are included deliberately: the curve stays inside their
    // hull, so this over-estimates slightly and never under-estimates.
    for (const [x, y] of [
      [s.x0, s.y0],
      [s.c1x, s.c1y],
      [s.c2x, s.c2y],
      [s.x1, s.y1],
    ]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    maxW = Math.max(maxW, s.w0, s.w1);
  }
  const grow = (baseWidth * maxW) / 2 + 1;
  return { x: minX - grow, y: minY - grow, w: maxX - minX + grow * 2, h: maxY - minY + grow * 2 };
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** How a tool paints. The eraser is a stroke like any other — it is only the
 *  compositing that differs, which is what keeps it in the append-only log
 *  instead of destroying the strokes underneath it. */
function applyTool(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  switch (stroke.tool) {
    case "highlighter":
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.4;
      break;
    case "eraser":
      // NOT destination-out: on an opaque canvas that would punch a transparent
      // hole, which on a promoted overlay is a black hole. The eraser paints
      // paper, which is what an eraser on paper does anyway.
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.strokeStyle = PAPER;
      break;
    default:
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
  }
}

const resetTool = (ctx: CanvasRenderingContext2D): void => {
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
};

/**
 * Stroke a run of segments.
 *
 * Each segment is drawn as its own path because the width changes along the
 * stroke and a single path can only carry one lineWidth. That is more path
 * objects than a naive implementation, and it is why the width is quantised
 * below: consecutive segments that round to the same width are batched into one
 * path, which on a fast scribble collapses most of them.
 */
export function drawSegments(
  ctx: CanvasRenderingContext2D,
  segs: Segment[],
  stroke: Stroke,
): void {
  if (!segs.length) return;
  applyTool(ctx, stroke);
  // Runs come from ink.ts so the PDF exporter breaks a stroke in exactly the
  // same places — see strokeRuns().
  for (const run of runsOf(segs, stroke)) {
    ctx.beginPath();
    ctx.lineWidth = run.width;
    ctx.moveTo(run.segs[0].x0, run.segs[0].y0);
    for (const s of run.segs) {
      if (s.x0 === s.x1 && s.y0 === s.y1 && segs.length === 1) {
        // A lone point: a zero-length line with a round cap is a dot.
        ctx.lineTo(s.x1 + 0.01, s.y1);
      } else {
        ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x1, s.y1);
      }
    }
    ctx.stroke();
  }
  resetTool(ctx);
}

/** Group already-computed segments into constant-width runs. */
function runsOf(segs: Segment[], stroke: Stroke): Run[] {
  const runs: Run[] = [];
  for (const s of segs) {
    const w = quantise(stroke.width * ((s.w0 + s.w1) / 2));
    const last = runs[runs.length - 1];
    if (last && last.width === w) last.segs.push(s);
    else runs.push({ width: w, segs: [s] });
  }
  return runs;
}

/** Draw a stroke end to end. */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  profile: CaptureProfile,
): void {
  drawSegments(ctx, toSegments(stroke, tensionFor(profile)), stroke);
}

// ── the page renderer ────────────────────────────────────────────────────────

type Surface = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

function makeContext(canvas: HTMLCanvasElement, desynchronized: boolean): CanvasRenderingContext2D | null {
  return canvas.getContext(
    "2d",
    // alpha:false on BOTH surfaces. The visible one because a transparent pixel
    // on a promoted overlay is black; the backing store because it must match
    // the visible one pixel for pixel or a blit out of it would introduce the
    // very transparency the visible canvas cannot tolerate.
    desynchronized ? { desynchronized: true, alpha: false } : { alpha: false },
  ) as CanvasRenderingContext2D | null;
}

/**
 * One page, drawn onto one opaque canvas, with an offscreen twin for un-drawing.
 *
 * Lifecycle a host drives:
 *   fit()                once the element has a box, and on every resize
 *   setBackground()      when the page's content changes
 *   commit(strokes)      after a stroke ends, or to repaint everything
 *   wet(segs, stroke)    while a stroke is in progress
 *   undoWet()            to take the live stroke back off
 */
export class PageRenderer {
  private visible: Surface | null = null;
  private backing: Surface | null = null;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private proj: Projection = { scale: 1, offsetX: 0, offsetY: 0 };
  /** Device-pixel region the live stroke has dirtied since the last commit. */
  private wetRect: Rect | null = null;

  constructor(private readonly profile: CaptureProfile) {}

  get projection(): Projection {
    return this.proj;
  }

  /** Bind a canvas and size it to its box. Safe to call repeatedly. */
  fit(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));

    canvas.width = w;
    canvas.height = h;
    const ctx = makeContext(canvas, this.profile.desynchronized);
    if (!ctx) return;
    this.visible = { canvas, ctx };

    // The backing store is created through the DOM but never attached to it.
    const back = canvas.ownerDocument.createElement("canvas");
    back.width = w;
    back.height = h;
    const bctx = makeContext(back, false);
    if (!bctx) return;
    this.backing = { canvas: back, ctx: bctx };

    this.proj = fitPage(cssW, cssH);
    this.wetRect = null;
  }

  /** Paper across the WHOLE bitmap, in device pixels — see fitCanvas in the
   *  probe for why CSS pixels leave a transparent fringe here. */
  private paper(s: Surface): void {
    s.ctx.setTransform(1, 0, 0, 1, 0, 0);
    s.ctx.fillStyle = PAPER;
    s.ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
  }

  /** Put the page's own transform on a context: page units in, device px out. */
  private page(s: Surface): CanvasRenderingContext2D {
    const { scale, offsetX, offsetY } = this.proj;
    s.ctx.setTransform(
      scale * this.dpr,
      0,
      0,
      scale * this.dpr,
      offsetX * this.dpr,
      offsetY * this.dpr,
    );
    return s.ctx;
  }

  /**
   * Repaint the backing store from scratch and show it.
   *
   * `drawBackground` is a callback rather than a switch on PageBackground
   * because a frozen video frame is an <img>/ImageBitmap the HOST loaded and a
   * question is text the HOST lays out — neither belongs in a module that has to
   * stay portable to the standalone board.
   */
  commit(
    strokes: Stroke[],
    background?: PageBackground,
    drawBackground?: (ctx: CanvasRenderingContext2D, bg: PageBackground, page: Rect) => void,
  ): void {
    const back = this.backing;
    const vis = this.visible;
    if (!back || !vis) return;

    this.paper(back);
    const ctx = this.page(back);
    if (background && background.kind !== "blank" && drawBackground) {
      ctx.save();
      // Clipped to the page so a background that misbehaves cannot paint into
      // the letterbox and leave debris outside the paper.
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      drawBackground(ctx, background, { x: 0, y: 0, w: PAGE_W, h: PAGE_H });
      ctx.restore();
    }
    for (const s of strokes) drawStroke(ctx, s, this.profile);

    this.blitAll();
    this.wetRect = null;
  }

  /** Copy the whole backing store onto the visible canvas. */
  private blitAll(): void {
    const back = this.backing;
    const vis = this.visible;
    if (!back || !vis) return;
    vis.ctx.setTransform(1, 0, 0, 1, 0, 0);
    vis.ctx.globalCompositeOperation = "source-over";
    vis.ctx.globalAlpha = 1;
    vis.ctx.drawImage(back.canvas, 0, 0);
  }

  /**
   * Draw the live stroke onto the visible canvas only.
   *
   * The backing store is deliberately NOT updated: it holds the page without the
   * live stroke, which is exactly what makes undoWet() a blit rather than a full
   * repaint.
   */
  wet(segs: Segment[], stroke: Stroke): void {
    const vis = this.visible;
    if (!vis || !segs.length) return;
    const ctx = this.page(vis);
    drawSegments(ctx, segs, stroke);
    const b = segmentBounds(segs, stroke.width);
    if (b) this.wetRect = unionRect(this.wetRect, deviceRect(b, this.proj, this.dpr));
  }

  /** Take the live stroke back off, by restoring what the backing store holds
   *  for the region it touched. This is the erase that the opaque canvas costs
   *  us, and it is why the wet region is tracked at all. */
  undoWet(): void {
    const back = this.backing;
    const vis = this.visible;
    if (!back || !vis || !this.wetRect) return;
    const r = clipRect(this.wetRect, vis.canvas.width, vis.canvas.height);
    this.wetRect = null;
    if (!r) return;
    vis.ctx.setTransform(1, 0, 0, 1, 0, 0);
    vis.ctx.globalCompositeOperation = "source-over";
    vis.ctx.globalAlpha = 1;
    vis.ctx.drawImage(back.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }

  /** For the exporter and for tests: the page as it stands, committed only. */
  get backingCanvas(): HTMLCanvasElement | null {
    return this.backing?.canvas ?? null;
  }

  get size(): { cssW: number; cssH: number; dpr: number } {
    return { cssW: this.cssW, cssH: this.cssH, dpr: this.dpr };
  }
}
