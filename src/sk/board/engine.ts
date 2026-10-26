// SK board engine (pure, no DOM): the segment manifest types, the hit-map
// types, coordinate mapping, trace sampling, handwriting path building and
// the checkpoint rule. Everything the player needs that can be unit-tested.
// Started as the S1 spike's engine; B4 moved it here; B2 added the hit-map
// gate and the helpers the live overlay and the avatar share.
//
// Board space is ERE's logical 0–100 square for authored (live) actions; a
// hit map is in the clip's world pixels (1280×720). Assets carry their own
// pixel space (regions, trace); `toBoard` maps between the two.

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
export type GestureKind = "point" | "write" | "listen" | "think" | "idle";
export const GESTURE_KINDS: ReadonlySet<string> = new Set<GestureKind>(["point", "write", "listen", "think", "idle"]);
export type Gesture = { t: number; kind: GestureKind; target?: string; until?: number };
export type Aside = { question: string; audio: { uri: string; duration_ms: number }; marks: Marks; actions: Action[]; gestures: Gesture[] };
export type Segment = {
  segment_id: string;
  /** From the TTS voice registry: picks the SK character (A female, B male). */
  voice_gender?: "female" | "male";
  audio: { uri: string; duration_ms: number };
  /** Option S (B3 packager): the rendered clip and its hit map, relative to the manifest. */
  clip?: { uri: string; duration_ms: number };
  hitmap?: string;
  marks: Marks;
  /** Option E only; a B3 (Option S) manifest carries none — see normaliseSegment. */
  assets: Record<string, AssetFixture>;
  actions: Action[];
  gestures: Gesture[];
  /** The S1 fixture's scripted aside; B4's live asides arrive from the server instead. */
  aside?: Aside;
  checkpoints: number[];
  narration: string;
};

/** A B3 manifest has no assets/actions/aside (the clip carries the board):
 * fill the Option-E fields so one Segment type serves both. Pure. */
export function normaliseSegment(raw: Segment): Segment {
  return {
    ...raw,
    assets: raw.assets ?? {},
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    gestures: Array.isArray(raw.gestures) ? raw.gestures : [],
    marks: raw.marks ?? { words: [], visemes: [] },
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [0],
  };
}

// ── Segment validation (the security gate, contracts §2) ────────────────────
// A segment is DATA from a file or a model. Nothing in it may reach the DOM
// unchecked: ids are tokens, text is plain and short, numbers are finite and
// inside the world, asset sources are local filenames, ops are from the
// allow-list, and counts are bounded. The runtime refuses the whole segment
// on the first violation — never a partial render (the ERE rule).
export const LIMITS = { actions: 500, text: 200, trace: 5000, words: 5000, coord: 10_000, elements: 2000, regions: 200, timeline: 2000, checkpoints: 1000, world: 8192 } as const;
const ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/i;
const SRC_RE = /^[a-z0-9_-]+\.(png|jpg|jpeg|svg)$/i;
/** A local media/json path (relative to the manifest or site-absolute): no scheme, no `..`. */
const URI_RE = /^\/?(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(mp3|mp4|ogg|webm|json)$/i;
/** Timeline verbs the scene engine exports (`spike/scene_engine`). */
export const HIT_VERBS: ReadonlySet<string> = new Set(["draw", "write", "circle", "underline", "strike", "arrow", "erase", "fade", "move", "highlight", "point"]);
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
/** True for a site-local media path (what `uri()` accepts). */
export const isLocalMediaUri = (v: unknown): v is string => typeof v === "string" && v.length <= 256 && URI_RE.test(v) && !v.includes("..");
function uri(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > 256 || !URI_RE.test(v) || v.includes("..")) throw new SegmentError(`${what}: must be a local media path`);
  return v;
}

/** Throws SegmentError on the first violation; returns the segment otherwise. */
export function validateSegment(input: Segment): Segment {
  const seg = normaliseSegment(input);
  if (!Array.isArray(seg.actions) || seg.actions.length > LIMITS.actions) throw new SegmentError("too many actions");
  if (!Array.isArray(seg.marks?.words) || seg.marks.words.length > LIMITS.words) throw new SegmentError("too many words");
  // Media and companion files: local paths only (a manifest from a model or a
  // bucket must never point the player at another origin).
  uri(seg.audio?.uri, "audio.uri");
  num(seg.audio.duration_ms, "audio.duration_ms", 0, MAX_T);
  if (seg.clip != null) {
    uri(seg.clip.uri, "clip.uri");
    num(seg.clip.duration_ms, "clip.duration_ms", 0, MAX_T);
  }
  if (seg.hitmap != null) uri(seg.hitmap, "hitmap");
  if (seg.aside?.audio?.uri) uri(seg.aside.audio.uri, "aside.audio.uri");
  if (seg.voice_gender != null && seg.voice_gender !== "female" && seg.voice_gender !== "male") throw new SegmentError("bad voice_gender");
  if (!Array.isArray(seg.checkpoints) || seg.checkpoints.length > LIMITS.checkpoints) throw new SegmentError("too many checkpoints");
  for (const c of seg.checkpoints) num(c, "checkpoint", 0, MAX_T);
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
  const gs = [...(seg.gestures ?? []), ...(seg.aside?.gestures ?? [])];
  if (gs.length > LIMITS.actions) throw new SegmentError("too many gestures");
  for (const g of gs) {
    if (!GESTURE_KINDS.has(g?.kind)) throw new SegmentError(`gesture: bad gesture kind ${String(g?.kind)}`);
    num(g.t, "gesture.t", 0, MAX_T);
    if (g.until != null) num(g.until, "gesture.until", 0, MAX_T);
    if (g.target != null) text(g.target, "gesture.target");
  }
  return seg;
}

// ── Hit map (the renderer's export; the scene graph of a prepared segment) ──
export type Box4 = [number, number, number, number]; // x0,y0,x1,y1 in world pixels
export type HitElement = { box: Box4 };
export type HitAsset = { box: Box4; regions: Record<string, Box4> };
export type HitTimed = { target: string; verb: string; start_ms: number; end_ms: number };
export type HitMap = {
  world: { w: number; h: number };
  fps?: number;
  duration_ms: number;
  /** Every element the clip drew, keyed as the renderer named it ("w1", "l1", "ill"). */
  elements: Record<string, HitElement>;
  /** The clip's illustration(s) ("mic", "ill") with their labelled regions, world pixels. */
  asset: Record<string, HitAsset>;
  timeline: HitTimed[];
};

const clampBox4 = (v: unknown, what: string, W: number, H: number): Box4 => {
  if (!Array.isArray(v) || v.length !== 4) throw new SegmentError(`${what}: box must be [x0,y0,x1,y1]`);
  const n = v.map((x, i) => num(x, `${what}[${i}]`)) as Box4;
  const cl = (x: number, hi: number) => Math.min(hi, Math.max(0, x));
  return [cl(Math.min(n[0], n[2]), W), cl(Math.min(n[1], n[3]), H), cl(Math.max(n[0], n[2]), W), cl(Math.max(n[1], n[3]), H)];
};

/** Validates a hit map and returns a NORMALISED copy: every box numeric,
 * ordered and clamped into the world; ids allow-listed tokens; verbs from the
 * renderer's set; every timeline target an element the map declares; counts
 * bounded. Throws SegmentError on the first violation. */
export function validateHitMap(hm: HitMap): HitMap {
  const W = num(hm?.world?.w, "world.w", 1, LIMITS.world);
  const H = num(hm?.world?.h, "world.h", 1, LIMITS.world);
  const duration_ms = num(hm.duration_ms, "duration_ms", 0, MAX_T);
  if (hm.fps != null) num(hm.fps, "fps", 1, 240);
  const elements: Record<string, HitElement> = {};
  const entries = Object.entries(hm.elements ?? {});
  if (entries.length > LIMITS.elements) throw new SegmentError("too many elements");
  for (const [k, e] of entries) elements[id(k, "element id")] = { box: clampBox4(e?.box, `element ${k}.box`, W, H) };
  const asset: Record<string, HitAsset> = {};
  const assets = Object.entries(hm.asset ?? {});
  if (assets.length > LIMITS.elements) throw new SegmentError("too many assets");
  for (const [k, a] of assets) {
    id(k, "asset id");
    const regions: Record<string, Box4> = {};
    const rs = Object.entries(a?.regions ?? {});
    if (rs.length > LIMITS.regions) throw new SegmentError(`asset ${k}: too many regions`);
    for (const [name, b] of rs) {
      if (name.length > 64 || name.includes(".")) throw new SegmentError(`asset ${k}: bad region name`);
      regions[text(name, `asset ${k} region name`)] = clampBox4(b, `asset ${k}.${name}`, W, H);
    }
    asset[k] = { box: clampBox4(a?.box, `asset ${k}.box`, W, H), regions };
  }
  if (!Array.isArray(hm.timeline) || hm.timeline.length > LIMITS.timeline) throw new SegmentError("too many timeline entries");
  const timeline: HitTimed[] = hm.timeline.map((t, i) => {
    if (!HIT_VERBS.has(t?.verb)) throw new SegmentError(`timeline[${i}]: bad verb ${String(t?.verb)}`);
    const target = id(t.target, `timeline[${i}].target`);
    if (!elements[target]) throw new SegmentError(`timeline[${i}]: target ${target} is not an element`);
    const start_ms = num(t.start_ms, `timeline[${i}].start_ms`, 0, MAX_T);
    const end_ms = num(t.end_ms, `timeline[${i}].end_ms`, start_ms, MAX_T);
    return { target, verb: t.verb, start_ms, end_ms };
  });
  return { world: { w: W, h: H }, fps: hm.fps, duration_ms, elements, asset, timeline };
}

export const box4 = (b: Box4): Box => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });

/** World box of a hit-map target: "ill" → the element or asset; "ill.eyepiece
 * lens" → that asset region; null when the map has neither. */
export function hitBox(hm: HitMap, target: string): Box | null {
  const dot = target.indexOf(".");
  if (dot > 0) {
    const r = hm.asset[target.slice(0, dot)]?.regions[target.slice(dot + 1)];
    return r ? box4(r) : null;
  }
  const e = hm.elements[target] ?? hm.asset[target];
  return e ? box4(e.box) : null;
}

/** Every id the hit map can resolve — what a live aside may target. */
export function hitTargets(hm: HitMap): string[] {
  const out = Object.keys(hm.elements);
  for (const [k, a] of Object.entries(hm.asset)) {
    if (!out.includes(k)) out.push(k);
    for (const r of Object.keys(a.regions)) out.push(`${k}.${r}`);
  }
  return out;
}

/** Element ids whose first timeline entry has started by t — what is on the
 * board at that moment, in drawing order. */
export function drawnAt(hm: HitMap, t: number): string[] {
  const out: string[] = [];
  for (const e of [...hm.timeline].sort((a, b) => a.start_ms - b.start_ms)) if (e.start_ms <= t && !out.includes(e.target)) out.push(e.target);
  return out;
}

/** The element most recently started at t, or null before the first. */
export function lastDrawnAt(hm: HitMap, t: number): string | null {
  return drawnAt(hm, t).at(-1) ?? null;
}

/** The gesture in force at t: the latest one started, for 2.5 s unless `until` says otherwise. */
export function activeGesture(gestures: Gesture[], t: number): Gesture | undefined {
  return [...gestures].reverse().find((ge) => t >= ge.t && (ge.until == null ? t < ge.t + 2500 : t < ge.until));
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
