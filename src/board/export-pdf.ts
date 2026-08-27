// The roll as a PDF: one PDF page per roll page, ink as real vector paths.
//
// VECTOR, NOT A SCREENSHOT. The obvious export is to blit each page's canvas
// into an image, and it is wrong twice over: the file would be a device's pixel
// count rather than the drawing, and a student zooming in on a phone would find
// mush where a diagram was. The roll stores curves, so the PDF gets curves, and
// the page prints as crisply as the printer allows.
//
// TWO EXPORTS MUST BE BYTE-IDENTICAL — a Phase 1 gate, and the reason for the
// fixed metadata below. PDF writers habitually stamp the current time into
// /CreationDate and /ModDate, which would make every export of an unchanged
// board a different file: pointless re-uploads, and no cheap way for a sync to
// tell "she changed something" from "she pressed export twice".
//
// pdf-lib is imported LAZILY. It is a large dependency and the board is mostly
// used without ever exporting; a static import would put it in the bundle of
// every lesson that only ever draws.

import { strokeRuns, type Run } from "./ink";
import { PAGE_W, pageStrokes, type PageBackground, type Roll, type Stroke } from "./model";

/**
 * The PDF page, in points. 960x540 is the standard 16:9 slide box (13.33in by
 * 7.5in) — the same shape as a roll page, so the projection is a scale and
 * nothing is cropped or letterboxed.
 */
export const PDF_W = 960;
export const PDF_H = 540;
export const PDF_SCALE = PDF_W / PAGE_W;

/**
 * Export uses a FIXED tension rather than the drawing device's.
 *
 * Smoothing is a rendering choice, not part of the record: the points are what
 * she drew. If export took the tension from whatever device happened to be open,
 * the same roll would produce different files on a laptop and a panel, and the
 * byte-identical gate would be untestable.
 */
const EXPORT_TENSION = 1;

export type RgbColor = { r: number; g: number; b: number };

/**
 * A CSS hex colour as 0..1 components. Hex only, deliberately: the board writes
 * its own colours and they are all hex, so accepting `rgb()`/`hsl()`/names would
 * be untested surface. Anything unparseable becomes black, which is visible and
 * wrong rather than invisible and wrong.
 */
export function parseHexColor(css: string): RgbColor {
  const s = css.trim().replace(/^#/, "");
  const hex =
    s.length === 3
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/**
 * A run of segments as SVG path data, in PAGE units.
 *
 * Coordinates are rounded to two decimals. At the export scale that is well
 * under a thousandth of a point — invisible — and it keeps a float's last binary
 * digit from making two otherwise identical exports differ in the bytes.
 */
export function runToSvgPath(run: Run): string {
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const first = run.segs[0];
  const parts: string[] = [`M ${n(first.x0)} ${n(first.y0)}`];
  for (const s of run.segs) {
    if (s.x0 === s.x1 && s.y0 === s.y1 && run.segs.length === 1) {
      // A lone point. A zero-length path draws nothing even with a round cap in
      // some viewers, so nudge it into a hair of a line.
      parts.push(`L ${n(s.x1 + 0.01)} ${n(s.y1)}`);
    } else {
      parts.push(`C ${n(s.c1x)} ${n(s.c1y)} ${n(s.c2x)} ${n(s.c2y)} ${n(s.x1)} ${n(s.y1)}`);
    }
  }
  return parts.join(" ");
}

/** How a tool prints. The eraser paints paper here exactly as it does on screen —
 *  strokes are drawn in order, so a white stroke covers what came before it. */
export function toolPaint(stroke: Stroke): { color: RgbColor; opacity: number } {
  if (stroke.tool === "eraser") return { color: { r: 1, g: 1, b: 1 }, opacity: 1 };
  if (stroke.tool === "highlighter") return { color: parseHexColor(stroke.color), opacity: 0.4 };
  return { color: parseHexColor(stroke.color), opacity: 1 };
}

/**
 * Load pdf-lib ahead of time.
 *
 * The first export pays for the dynamic import — measured at several seconds
 * cold, which is a long time to stare at a button that has visibly done
 * nothing. A host should call this when the lesson opens, so the cost lands
 * while she is teaching rather than when she presses Export at the bell.
 * Safe to call repeatedly; the module cache makes every call after the first
 * free, and a failure is swallowed because warming is an optimisation and must
 * never be the thing that breaks a board.
 */
export async function warmExport(): Promise<void> {
  try {
    await import("pdf-lib");
  } catch {
    /* the real export will surface the failure */
  }
}

export type ExportOpts = {
  title?: string;
  /**
   * Resolve a page background to image bytes. The HOST does this because a
   * frozen video frame is a blob it captured and this module must not know how
   * to fetch anything. Returning null simply leaves the page as paper.
   */
  image?: (bg: PageBackground) => Promise<{ bytes: Uint8Array; type: "jpg" | "png" } | null>;
  /** Text to print at the top of a page — a worksheet question's prompt. */
  text?: (bg: PageBackground) => string | null;
};

/**
 * The whole roll as PDF bytes.
 *
 * Every page is emitted, including empty ones: the page numbers a teacher wrote
 * on the board and referred to out loud have to match the ones in the file a
 * student opens afterwards.
 */
export async function exportRoll(roll: Roll, opts: ExportOpts = {}): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts, LineCapStyle } = await import("pdf-lib");
  const doc = await PDFDocument.create();

  // Fixed metadata — see the header. A constant epoch, not "now".
  const epoch = new Date(0);
  doc.setTitle(opts.title ?? `SketchCast board ${roll.id}`);
  doc.setProducer("SketchCast");
  doc.setCreator("SketchCast");
  doc.setAuthor("SketchCast");
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);

  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const p of roll.pages) {
    const page = doc.addPage([PDF_W, PDF_H]);

    // Paper. Explicit rather than relying on the viewer's default, so a page
    // prints white on a reader that renders an unpainted page grey.
    page.drawRectangle({ x: 0, y: 0, width: PDF_W, height: PDF_H, color: rgb(1, 1, 1) });

    if (p.background.kind !== "blank" && opts.image) {
      const img = await opts.image(p.background);
      if (img) {
        const embedded =
          img.type === "jpg" ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
        // Contain, not cover: a frame that does not match 16:9 must not be
        // cropped — the part cropped away is often the part she annotated.
        const s = Math.min(PDF_W / embedded.width, PDF_H / embedded.height);
        const w = embedded.width * s;
        const h = embedded.height * s;
        page.drawImage(embedded, { x: (PDF_W - w) / 2, y: (PDF_H - h) / 2, width: w, height: h });
      }
    }

    const label = opts.text?.(p.background);
    if (label) {
      page.drawText(label, {
        x: 24,
        y: PDF_H - 40,
        size: 18,
        font,
        color: rgb(0.05, 0.09, 0.12),
        maxWidth: PDF_W - 48,
      });
    }

    for (const stroke of pageStrokes(roll, p.index)) {
      const { color, opacity } = toolPaint(stroke);
      for (const run of strokeRuns(stroke, EXPORT_TENSION)) {
        page.drawSvgPath(runToSvgPath(run), {
          // The SVG origin sits at the page's TOP-left; pdf-lib flips the y-axis
          // for drawSvgPath, and PDF's own origin is bottom-left.
          x: 0,
          y: PDF_H,
          scale: PDF_SCALE,
          borderColor: rgb(color.r, color.g, color.b),
          borderWidth: run.width * PDF_SCALE,
          borderOpacity: opacity,
          borderLineCap: LineCapStyle.Round,
        });
      }
    }
  }

  // Object streams off: they compress better but the packing is not something
  // this module controls, and byte-identical output matters more here than a
  // few kilobytes on a file nobody stores at scale.
  return doc.save({ useObjectStreams: false });
}

/** Page count a roll will produce. Every page, empty ones included. */
export const pdfPageCount = (roll: Roll): number => roll.pages.length;

/** Rough guide for a progress indicator: how many vector paths the export will
 *  emit. A long lesson is thousands, and a host that shows nothing for eight
 *  seconds looks broken. */
export function pdfPathCount(roll: Roll): number {
  let n = 0;
  for (const p of roll.pages) {
    for (const s of pageStrokes(roll, p.index)) n += strokeRuns(s, EXPORT_TENSION).length;
  }
  return n;
}
