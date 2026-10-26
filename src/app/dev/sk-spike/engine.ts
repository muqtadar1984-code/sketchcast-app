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
  audio: { uri: string; duration_ms: number };
  marks: Marks;
  assets: Record<string, AssetFixture>;
  actions: Action[];
  gestures: Gesture[];
  aside: { question: string; audio: { uri: string; duration_ms: number }; marks: Marks; actions: Action[]; gestures: Gesture[] };
  checkpoints: number[];
  narration: string;
};

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
