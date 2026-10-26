// SK S1 spike — Option E engine (pure, no DOM): the segment manifest types,
// coordinate mapping, trace sampling, handwriting path building and the
// checkpoint rule. Everything the player needs that can be unit-tested.
//
// Board space is ERE's logical 0–100 square. Assets carry their own pixel
// space (regions, trace); `assetBox` maps between the two.

export type WordMark = { i: number; t0: number; t1: number; text: string };
export type Marks = { words: WordMark[]; visemes: { t: number; v: string }[] };
export type Box = { x: number; y: number; w: number; h: number };
export type AssetFixture = {
  src: string;
  w: number;
  h: number;
  regions: Record<string, number[][]>; // [x0,y0,x1,y1] in asset pixels
  trace: [number, number][]; // drawing-order walk, asset pixels
};
export type Action =
  | { op: "place"; as: string; ref: string; at: Box; t: number }
  | { op: "reveal"; id: string; target: string; order: "stroke"; t: number; dur: number }
  | { op: "label"; id: string; target: string; text: string; side: "right" | "left"; t: number; dur: number }
  | { op: "write"; id: string; text: string; at: { x: number; y: number }; size: number; style?: "muted"; t: number; dur: number }
  | { op: "highlight"; id: string; target: string; style: "circle" | "strike"; t: number; dur: number };
export type Gesture = { t: number; kind: "point" | "write" | "listen" | "idle"; target?: string; until?: number };
export type Segment = {
  segment_id: string;
  /** From the TTS voice registry: picks the SK character (A female, B male). */
  voice_gender?: "female" | "male";
  audio: { uri: string; duration_ms: number };
  marks: Marks;
  assets: Record<string, AssetFixture>;
  actions: Action[];
  gestures: Gesture[];
  aside: { question: string; audio: { uri: string; duration_ms: number }; marks: Marks; actions: Action[]; gestures: Gesture[] };
  checkpoints: number[];
  narration: string;
};

// ── Segment validation (the security gate, contracts §2) ────────────────────
// A segment is DATA from a file or a model. Nothing in it may reach the DOM
// unchecked: ids are tokens, text is plain and short, numbers are finite and
// inside the world, asset sources are local filenames, ops are from the
// allow-list, and counts are bounded. The runtime refuses the whole segment
// on the first violation — never a partial render (the ERE rule).
export const LIMITS = { actions: 500, text: 200, trace: 5000, words: 5000, coord: 10_000 } as const;
const ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/i;
const SRC_RE = /^[a-z0-9_-]+\.(png|jpg|jpeg|svg)$/i;
const OPS = new Set(["place", "reveal", "label", "write", "highlight"]);
// Bidi/format controls and C0/C1 controls: these can disguise what a label says.
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/;

export class SegmentError extends Error {}

const MAX_T = 24 * 3600 * 1000; // ms
function num(v: unknown, what: string, lo: number = -LIMITS.coord, hi: number = LIMITS.coord): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new SegmentError(`${what}: bad number ${String(v)}`);
  return v;
}
function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new SegmentError(`${what}: bad id ${JSON.stringify(v)}`);
  return v;
}
function text(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > LIMITS.text || BAD_CHARS.test(v)) throw new SegmentError(`${what}: bad text`);
  return v;
}
function box(v: unknown, what: string): Box {
  const b = v as Box;
  return { x: num(b?.x, what + ".x"), y: num(b?.y, what + ".y"), w: num(b?.w, what + ".w", 0), h: num(b?.h, what + ".h", 0) };
}

/** Throws SegmentError on the first violation; returns the segment otherwise. */
export function validateSegment(seg: Segment): Segment {
  if (!Array.isArray(seg.actions) || seg.actions.length > LIMITS.actions) throw new SegmentError("too many actions");
  if (!Array.isArray(seg.marks?.words) || seg.marks.words.length > LIMITS.words) throw new SegmentError("too many words");
  for (const [key, a] of Object.entries(seg.assets ?? {})) {
    id(key, "asset key");
    if (typeof a.src !== "string" || !SRC_RE.test(a.src)) throw new SegmentError(`asset ${key}: src must be a local image filename`);
    num(a.w, "asset.w", 1);
    num(a.h, "asset.h", 1);
    if (!Array.isArray(a.trace) || a.trace.length > LIMITS.trace) throw new SegmentError(`asset ${key}: trace too long`);
    for (const p of a.trace) {
      num(p[0], "trace.x");
      num(p[1], "trace.y");
    }
    for (const [name, boxes] of Object.entries(a.regions ?? {})) {
      text(name, "region name");
      for (const b of boxes) b.forEach((n) => num(n, "region"));
    }
  }
  const seen = new Set<string>();
  const check = (actions: Action[], where: string) => {
    for (const a of actions) {
      if (!OPS.has(a.op)) throw new SegmentError(`${where}: unknown op ${String((a as { op: unknown }).op)}`);
      num(a.t, `${where}.t`, 0, MAX_T);
      if ("dur" in a) num(a.dur, `${where}.dur`, 0, 3600 * 1000);
      if (a.op === "place") {
        if (!a.ref.startsWith("asset:") || !seg.assets[a.ref.slice(6)]) throw new SegmentError(`${where}: place ref must name a bundled asset`);
        box(a.at, `${where}.at`);
        const k = id(a.as, `${where}.as`);
        if (seen.has(k)) throw new SegmentError(`${where}: duplicate id ${k}`);
        seen.add(k);
        continue;
      }
      const k = id(a.id, `${where}.id`);
      if (seen.has(k)) throw new SegmentError(`${where}: duplicate id ${k}`);
      seen.add(k);
      if (a.op === "label" || a.op === "write") text(a.text, `${where}.text`);
      if (a.op === "label" && a.side !== "left" && a.side !== "right") throw new SegmentError(`${where}: bad side`);
      if (a.op === "write") {
        num(a.at?.x, `${where}.at.x`);
        num(a.at?.y, `${where}.at.y`);
        num(a.size, `${where}.size`, 0.1, 1000);
        if (a.style != null && a.style !== "muted") throw new SegmentError(`${where}: bad style`);
      }
      if (a.op === "highlight" && a.style !== "circle" && a.style !== "strike") throw new SegmentError(`${where}: bad highlight`);
      if ("target" in a) {
        const [root, ...rest] = a.target.split(".");
        id(root, `${where}.target`);
        if (rest.length) text(rest.join("."), `${where}.target part`);
      }
    }
  };
  check(seg.actions, "actions");
  check(seg.aside?.actions ?? [], "aside");
  for (const g of [...(seg.gestures ?? []), ...(seg.aside?.gestures ?? [])]) {
    num(g.t, "gesture.t", 0, MAX_T);
    if (g.until != null) num(g.until, "gesture.until", 0, MAX_T);
    if (g.target != null) text(g.target, "gesture.target");
  }
  return seg;
}

/** The region's union box in asset pixels. "mic.eyepiece lens" → the asset's
 * "eyepiece lens" region; a bare "mic" → the whole asset. */
export function regionBox(asset: AssetFixture, part: string | undefined): Box {
  const boxes = part ? asset.regions[part] : undefined;
  if (!boxes?.length) return { x: 0, y: 0, w: asset.w, h: asset.h };
  const x0 = Math.min(...boxes.map((b) => b[0]!));
  const y0 = Math.min(...boxes.map((b) => b[1]!));
  const x1 = Math.max(...boxes.map((b) => b[2]!));
  const y1 = Math.max(...boxes.map((b) => b[3]!));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Asset-pixel box → board box, given where the asset was placed. */
export function toBoard(placed: Box, asset: AssetFixture, px: Box): Box {
  const sx = placed.w / asset.w;
  const sy = placed.h / asset.h;
  return { x: placed.x + px.x * sx, y: placed.y + px.y * sy, w: px.w * sx, h: px.h * sy };
}

export const centre = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];

/** Point on the drawing-order walk at fraction p ∈ [0,1] (asset pixels). */
export function traceAt(trace: [number, number][], p: number): [number, number] {
  if (!trace.length) return [0, 0];
  const k = Math.min(trace.length - 1, Math.max(0, Math.floor(p * (trace.length - 1))));
  return trace[k]!;
}

/** The trace as an SVG path (asset pixels). Consecutive points further apart
 * than `jump` start a new subpath so the pen lifts between components instead
 * of dragging a reveal stripe across the board. */
export function tracePath(trace: [number, number][], jump = 40): string {
  let d = "";
  let prev: [number, number] | null = null;
  for (const p of trace) {
    const lift = !prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > jump;
    d += (lift ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1);
    prev = p;
  }
  return d;
}

/** Which checkpoint a reload resumes from: the last one at or before t. */
export function checkpointFor(checkpoints: number[], t: number): number {
  let best = 0;
  for (const c of checkpoints) if (c <= t && c > best) best = c;
  return best;
}

/** Word being spoken at t (for the mouth), or null between words. */
export function wordAt(words: WordMark[], t: number): WordMark | null {
  for (const w of words) if (t >= w.t0 && t < w.t1) return w;
  return null;
}

/** Progress of an action at time t: 0 before, 1 after, linear within. */
export function progress(t: number, start: number, dur: number): number {
  if (dur <= 0) return t >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (t - start) / dur));
}

// ── Handwriting: glyph outlines → per-glyph stroke paths ────────────────────
// A handwriting font is outlines, so "stroke by stroke" here means tracing each
// glyph's outline in writing order, left to right, then filling it. Real pen
// strokes (centre-line data) would come from a stroke font; noted in the report.
export type GlyphPath = { d: string; advanceEnd: number; bbox: Box };

export type OpentypeLike = {
  getPaths: (text: string, x: number, y: number, size: number) => { toPathData: (dp?: number) => string; getBoundingBox: () => { x1: number; y1: number; x2: number; y2: number } }[];
  getAdvanceWidth: (text: string, size: number) => number;
};

export function handwritingPaths(font: OpentypeLike, text: string, x: number, y: number, size: number): GlyphPath[] {
  const paths = font.getPaths(text, x, y, size);
  const out: GlyphPath[] = [];
  let i = 0;
  for (const p of paths) {
    const d = p.toPathData(2);
    const bb = p.getBoundingBox();
    const advanceEnd = x + font.getAdvanceWidth(text.slice(0, i + 1), size);
    i++;
    if (!d) continue; // a space has no outline but still advances
    out.push({ d, advanceEnd, bbox: { x: bb.x1, y: bb.y1, w: bb.x2 - bb.x1, h: bb.y2 - bb.y1 } });
  }
  return out;
}

/** Share the write duration across glyphs by outline length proxy (bbox
 * perimeter), so a wide "m" takes longer than a dot. Returns [start,end] ms
 * per glyph, relative to the action start. */
export function glyphSchedule(glyphs: GlyphPath[], dur: number): [number, number][] {
  const weights = glyphs.map((g) => Math.max(1, 2 * (g.bbox.w + g.bbox.h)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return weights.map((w) => {
    const d = (dur * w) / total;
    const s: [number, number] = [t, t + d];
    t += d;
    return s;
  });
}
