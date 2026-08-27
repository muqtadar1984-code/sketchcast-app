// The ink pipeline: which contacts are allowed to draw, how a stream of pointer
// samples becomes a stroke, and how that stroke becomes a smooth path.
//
// PURE. Takes plain samples in PAGE units and returns data; it never touches a
// canvas, a pointer event or the DOM. That is what lets the hard parts — the
// palm policy and the smoothing — be tested in node rather than judged by eye on
// a panel nobody currently has.
//
// The width multiplier is resolved HERE, at capture time, and baked into the
// stroke (see the note on Stroke.pts in model.ts). Everything downstream —
// screen, PDF, a student's phone — just multiplies.

import type { CaptureProfile } from "./capabilities";
import { PAGE_W, PAGE_H, type Stroke, type Tool } from "./model";

// ── who is allowed to draw ───────────────────────────────────────────────────

/** The tool-rail toggle. The escape hatch that exists because "runs on any
 *  device" means finger drawing is first-class and there is often no pen to
 *  prefer, so no heuristic can be right for everyone. */
export type TouchMode = "draw" | "scroll";

export type InputPolicy = {
  profile: CaptureProfile;
  touchMode: TouchMode;
  /** Contact area, in PAGE units squared, above which a touch is treated as a
   *  palm. Only meaningful where the device reports a varying contact size —
   *  `capabilities.contactSizeVaries` says whether it does. */
  maxContactArea?: number;
};

/** What `accepts` needs off a pointer event. Kept structural so this module
 *  never imports a DOM type. */
export type Contact = {
  pointerType?: string;
  /** Contact size in PAGE units, if the device reports one. */
  width?: number;
  height?: number;
};

/**
 * May this contact draw?
 *
 * The order matters and encodes the whole palm story:
 *
 *   a pen always draws — it is the most deliberate thing on the glass;
 *   once a pen has EVER been seen, nothing else draws — that is the only
 *     palm rejection that actually works, and it is free;
 *   otherwise a finger draws only if the teacher has left touch in draw mode,
 *     and only if the contact is not palm-sized;
 *   a mouse always draws, because a mouse has no palm.
 */
export function accepts(policy: InputPolicy, c: Contact): boolean {
  const type = c.pointerType ?? "mouse";
  if (type === "pen") return true;
  if (policy.profile.penOnly) return false;
  if (type === "mouse") return true;
  if (type !== "touch") return true; // an unknown type is not a palm
  if (policy.touchMode !== "draw") return false;
  const area = (c.width ?? 0) * (c.height ?? 0);
  // area === 0 means the device does not report contact size; rejecting on it
  // would reject every touch on such a panel, which is most of them.
  if (policy.maxContactArea && area > policy.maxContactArea) return false;
  return true;
}

// ── width ────────────────────────────────────────────────────────────────────

/** Widths are clamped into this band so a stroke never vanishes or blobs. */
export const MIN_W = 0.35;
export const MAX_W = 1.5;

/** Speed, in page units per millisecond, at which velocity-driven width bottoms
 *  out. Calibrated on a 1600-unit-wide page: a fast swipe crosses it in about a
 *  second, so ~1.6 units/ms is "fast". */
const FAST = 1.6;

const clampW = (w: number): number => Math.min(MAX_W, Math.max(MIN_W, w));

/**
 * The multiplier for one point.
 *
 * On a device whose pressure is real, pressure drives it. Everywhere else
 * VELOCITY does, and faster means thinner — the way a pen lightens when you move
 * quickly. A device that merely CLAIMS pressure must not reach this with
 * `widthFrom: "pressure"`; that is capabilities.ts's job and it withholds the
 * claim until a stroke proves it.
 */
export function widthFactor(
  profile: CaptureProfile,
  sample: { pressure?: number; speed?: number },
): number {
  if (profile.widthFrom === "pressure") {
    const p = sample.pressure ?? 0.5;
    // 0..1 pressure spread across the band, centred so a normal press is ~1.
    return clampW(MIN_W + p * (MAX_W - MIN_W));
  }
  const speed = Math.max(0, sample.speed ?? 0);
  return clampW(MAX_W - (speed / FAST) * (MAX_W - MIN_W));
}

// ── building a stroke ────────────────────────────────────────────────────────

/** One input sample, already projected into PAGE units by the caller. */
export type InkSample = {
  x: number;
  y: number;
  /** Raw device pressure, if any. Ignored unless the profile says it is real. */
  pressure?: number;
  /** Timestamp in ms. Used for velocity; any monotonic clock will do. */
  t: number;
};

/** Samples closer together than this (page units) are dropped. Panels emit
 *  clusters of near-identical points while a finger rests; keeping them costs
 *  bytes and makes smoothing wobble around a stationary nib. */
export const MIN_STEP = 0.6;

/**
 * Accumulates samples into a Stroke.
 *
 * Stateful on purpose and deliberately dumb: it does no drawing, schedules
 * nothing, and holds no timers. The host feeds it points as they arrive
 * (including every coalesced one) and asks for the stroke at the end.
 */
export class StrokeBuilder {
  private pts: number[] = [];
  private lastX = NaN;
  private lastY = NaN;
  private lastT = NaN;

  constructor(
    readonly id: string,
    readonly page: number,
    readonly tool: Tool,
    readonly color: string,
    readonly width: number,
    private readonly profile: CaptureProfile,
  ) {}

  /** Points kept so far. */
  get length(): number {
    return this.pts.length / 3;
  }

  /**
   * Add one sample. Returns true if it was kept.
   *
   * Points outside the page are CLAMPED rather than dropped: a stroke that runs
   * off the edge should stop at the edge, not develop a hole in the middle and
   * then rejoin somewhere else.
   */
  push(s: InkSample): boolean {
    const x = Math.min(PAGE_W, Math.max(0, s.x));
    const y = Math.min(PAGE_H, Math.max(0, s.y));

    let speed = 0;
    if (Number.isFinite(this.lastX)) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      const dist = Math.hypot(dx, dy);
      if (dist < MIN_STEP) return false;
      const dt = s.t - this.lastT;
      // dt <= 0 happens with coalesced samples that share a timestamp. Treat it
      // as "no time passed, so no speed information" rather than dividing by it.
      speed = dt > 0 ? dist / dt : 0;
    }

    this.pts.push(x, y, widthFactor(this.profile, { pressure: s.pressure, speed }));
    this.lastX = x;
    this.lastY = y;
    this.lastT = s.t;
    return true;
  }

  /**
   * The finished stroke.
   *
   * A single-point stroke is kept, not discarded: a deliberate tap is a dot, and
   * a full stop is a mark a teacher makes constantly. `toSegments` renders it.
   */
  finish(): Stroke {
    return {
      id: this.id,
      page: this.page,
      tool: this.tool,
      color: this.color,
      width: this.width,
      pts: this.pts.slice(),
    };
  }
}

// ── smoothing ────────────────────────────────────────────────────────────────

/** One cubic Bézier with a width at each end. Renderers stroke these. */
export type Segment = {
  x0: number;
  y0: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x1: number;
  y1: number;
  w0: number;
  w1: number;
};

/**
 * Catmull-Rom through every captured point, expressed as cubic Béziers.
 *
 * Catmull-Rom rather than a fitted curve because it INTERPOLATES: the curve
 * passes through the points the teacher actually made, so her handwriting stays
 * her handwriting. A fit that merely approximates them reads as someone else's.
 *
 * `tension` is the knob the capture tier turns. On a device with no coalesced
 * events, far fewer real points arrive and the polyline between them is visibly
 * angular, so it interpolates harder to compensate — that is what
 * `CaptureProfile.smoothing === "heavy"` buys.
 */
export function toSegments(stroke: Stroke, tension = 1): Segment[] {
  const n = stroke.pts.length / 3;
  if (n === 0) return [];

  const px = (i: number) => stroke.pts[i * 3];
  const py = (i: number) => stroke.pts[i * 3 + 1];
  const pw = (i: number) => stroke.pts[i * 3 + 2];

  // A single point is a dot: a zero-length segment the renderer caps round.
  if (n === 1) {
    const x = px(0);
    const y = py(0);
    const w = pw(0);
    return [{ x0: x, y0: y, c1x: x, c1y: y, c2x: x, c2y: y, x1: x, y1: y, w0: w, w1: w }];
  }

  const out: Segment[] = [];
  for (let i = 0; i < n - 1; i++) {
    // Ends are duplicated so the first and last segments curve like the rest
    // instead of flattening into the endpoint.
    const i0 = i === 0 ? 0 : i - 1;
    const i3 = i + 2 > n - 1 ? n - 1 : i + 2;
    const k = tension / 6;
    out.push({
      x0: px(i),
      y0: py(i),
      c1x: px(i) + (px(i + 1) - px(i0)) * k,
      c1y: py(i) + (py(i + 1) - py(i0)) * k,
      c2x: px(i + 1) - (px(i3) - px(i)) * k,
      c2y: py(i + 1) - (py(i3) - py(i)) * k,
      x1: px(i + 1),
      y1: py(i + 1),
      w0: pw(i),
      w1: pw(i + 1),
    });
  }
  return out;
}

/** The tension a profile asks for. Heavier smoothing on the tier that captures
 *  the fewest real points. */
export const tensionFor = (profile: CaptureProfile): number =>
  profile.smoothing === "heavy" ? 1.25 : 1;

// ── width runs ───────────────────────────────────────────────────────────────

/**
 * Quantise a width so a slowly-varying stroke does not start a new path on every
 * segment. A quarter of a page unit is well under a pixel at any sane zoom.
 */
export const quantise = (w: number): number => Math.max(0.1, Math.round(w * 4) / 4);

/** Consecutive segments that share a quantised width, and that width. */
export type Run = { width: number; segs: Segment[] };

/**
 * A stroke as runs of constant width.
 *
 * SHARED BY THE SCREEN AND THE PDF, deliberately. Both need to break a stroke
 * wherever its width changes — a canvas path and a PDF path each carry ONE line
 * width — and if they computed the break points separately they would eventually
 * disagree, so the exported page would stop being what the teacher saw. One
 * function, one answer.
 */
export function strokeRuns(stroke: Stroke, tension = 1): Run[] {
  const runs: Run[] = [];
  for (const s of toSegments(stroke, tension)) {
    const w = quantise(stroke.width * ((s.w0 + s.w1) / 2));
    const last = runs[runs.length - 1];
    if (last && last.width === w) last.segs.push(s);
    else runs.push({ width: w, segs: [s] });
  }
  return runs;
}
