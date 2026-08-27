// The board's capability probe and capture-tier selection.
//
// Present mode has to run on whatever panel is in the room — an Android
// interactive flat panel on a three-year-old WebView, a Windows OPS module on
// current Chrome, a teacher's iPad — so the device is NOT a build-time choice.
// This module asks the browser what it can actually do, watches the first real
// strokes, and picks one of three capture profiles.
//
// THE POINT OF THE THREE TIERS: the stroke MODEL is identical in all of them.
// Only capture fidelity and the render path differ. That is what makes "works
// anywhere" one codebase instead of three, and it is why this file returns a
// profile rather than branching the drawing code.
//
//   A  pen + coalesced events + desynchronised canvas + pressure that genuinely
//      varies                        → full rate, pressure-varied width
//   B  touch or mouse, coalesced events, standard canvas
//                                    → full rate, velocity-varied width
//   C  no coalesced events (old WebView)
//                                    → raw pointermove sampling, heavy smoothing
//
// HALF OF THIS CANNOT BE ANSWERED STATICALLY. Whether a panel reports varying
// pressure, and how many coalesced points actually arrive per frame, are only
// knowable once someone draws — most interactive panels advertise pressure and
// then report a constant 0.5 forever. So the probe has two halves: `probeStatic`
// (API presence, once) and `observePointer` (what real strokes reveal), and the
// tier is chosen from the union. A board that has seen no strokes yet is
// deliberately pessimistic.
//
// ZERO imports, zero DOM assumptions it does not guard: this file is Phase 1's
// `src/board/` library arriving early, so it must stay portable to the standalone
// board SPA. Everything is injectable so it unit-tests in node.

// ── shapes ───────────────────────────────────────────────────────────────────

export type Tier = "A" | "B" | "C";

/** What the environment claims it can do. Answered once, at load. */
export type StaticCaps = {
  pointerEvents: boolean;
  /** `getCoalescedEvents` — the difference between full input rate and one point per frame. */
  coalesced: boolean;
  /** `getPredictedEvents` — a frame of lead, if it helps more than it smears. */
  predicted: boolean;
  /** A 2d context that ACCEPTED `desynchronized` (asked for it AND got it back). */
  desynchronized: boolean;
  maxTouchPoints: number;
  /** Reported by `(pointer: coarse)` — a touch-first device. */
  coarsePointer: boolean;
  /** `(any-hover: hover)` — a mouse or trackpad exists somewhere. */
  anyHover: boolean;
  devicePixelRatio: number;
  screen: { width: number; height: number } | null;
  hardwareConcurrency: number | null;
  /** Chrome's `navigator.deviceMemory`, in GB. Absent on Safari/Firefox. */
  deviceMemory: number | null;
  offscreenCanvas: boolean;
  indexedDB: boolean;
  userAgent: string;
  /** `navigator.userAgentData` when present — far more reliable than UA sniffing. */
  uaPlatform: string | null;
  uaMobile: boolean | null;
};

/** What real strokes revealed. Accumulated; never reset mid-session. */
export type Observations = {
  strokes: number;
  points: number;
  /** Every `pointerType` seen — "pen" here is what unlocks Tier A. */
  pointerTypes: string[];
  pressureMin: number;
  pressureMax: number;
  /** Distinct pressure values, capped — a panel reporting a constant 0.5 lands on 1. */
  pressureDistinct: number;
  /** Contact size varied ⇒ size-based palm rejection is viable on this device. */
  contactSizeVaries: boolean;
  /** Any nonzero tilt ⇒ a real active stylus, not a passive nib. */
  sawTilt: boolean;
  /** Coalesced points per pointermove: how much input a single frame is hiding. */
  coalescedMax: number;
  coalescedTotal: number;
  coalescedSamples: number;
};

/** How the ink pipeline should behave on THIS device. The only output that matters. */
export type CaptureProfile = {
  tier: Tier;
  /** Drain `getCoalescedEvents()` rather than taking one point per move. */
  useCoalesced: boolean;
  /** Draw `getPredictedEvents()` as throwaway lead ink. */
  usePrediction: boolean;
  /** Ask for a low-latency 2d context. */
  desynchronized: boolean;
  /** Where stroke width comes from. Velocity unless the panel proved pressure real. */
  widthFrom: "pressure" | "velocity";
  /** A pen has been seen ⇒ pen contacts win exclusively and palm rejection is solved. */
  penOnly: boolean;
  /** No pen ⇒ finger drawing is first-class, and the tool rail needs the toggle. */
  touchDrawsDefault: boolean;
  /** Fewer real points arrive ⇒ interpolate harder to keep the line smooth. */
  smoothing: "normal" | "heavy";
};

// ── static probe ─────────────────────────────────────────────────────────────

/** The subset of `window` this module touches. Injectable so tests need no DOM. */
export type ProbeHost = {
  navigator?: Partial<Navigator> & {
    deviceMemory?: number;
    userAgentData?: { platform?: string; mobile?: boolean };
  };
  screen?: { width: number; height: number };
  devicePixelRatio?: number;
  matchMedia?: (q: string) => { matches: boolean };
  document?: { createElement: (tag: string) => unknown };
  PointerEvent?: unknown;
  OffscreenCanvas?: unknown;
  indexedDB?: unknown;
};

const has = (o: unknown, k: string): boolean => {
  try {
    const proto = (o as { prototype?: object } | undefined)?.prototype;
    return !!proto && k in proto;
  } catch {
    return false;
  }
};

/**
 * Does a 2d context actually honour `desynchronized`? Asking is not enough —
 * every browser accepts the attribute and most ignore it, so the only honest
 * check is to read the attributes BACK off the context we were given.
 */
function probeDesynchronized(doc: ProbeHost["document"]): boolean {
  try {
    const el = doc?.createElement("canvas") as HTMLCanvasElement | undefined;
    if (!el?.getContext) return false;
    const ctx = el.getContext("2d", { desynchronized: true, alpha: true }) as
      | (CanvasRenderingContext2D & { getContextAttributes?: () => { desynchronized?: boolean } })
      | null;
    if (!ctx) return false;
    const attrs = ctx.getContextAttributes?.();
    // No getContextAttributes at all (older WebViews) ⇒ assume it did NOT honour
    // the hint. Pessimism here costs a tier; optimism costs a laggy classroom.
    return attrs?.desynchronized === true;
  } catch {
    return false;
  }
}

export function probeStatic(host?: ProbeHost): StaticCaps {
  const w: ProbeHost =
    host ?? (typeof window !== "undefined" ? (window as unknown as ProbeHost) : {});
  const nav = w.navigator ?? {};
  const mm = (q: string): boolean => {
    try {
      return !!w.matchMedia?.(q).matches;
    } catch {
      return false;
    }
  };
  const uad = (nav as { userAgentData?: { platform?: string; mobile?: boolean } }).userAgentData;
  return {
    pointerEvents: !!w.PointerEvent,
    coalesced: has(w.PointerEvent, "getCoalescedEvents"),
    predicted: has(w.PointerEvent, "getPredictedEvents"),
    desynchronized: probeDesynchronized(w.document),
    maxTouchPoints: typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : 0,
    coarsePointer: mm("(pointer: coarse)"),
    anyHover: mm("(any-hover: hover)"),
    devicePixelRatio: typeof w.devicePixelRatio === "number" ? w.devicePixelRatio : 1,
    screen: w.screen ? { width: w.screen.width, height: w.screen.height } : null,
    hardwareConcurrency:
      typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    offscreenCanvas: !!w.OffscreenCanvas,
    indexedDB: !!w.indexedDB,
    userAgent: typeof nav.userAgent === "string" ? nav.userAgent : "",
    uaPlatform: uad?.platform ?? null,
    uaMobile: typeof uad?.mobile === "boolean" ? uad.mobile : null,
  };
}

// ── observation ──────────────────────────────────────────────────────────────

export function newObservations(): Observations {
  return {
    strokes: 0,
    points: 0,
    pointerTypes: [],
    // Inverted sentinels so the first real sample sets both ends.
    pressureMin: 1,
    pressureMax: 0,
    pressureDistinct: 0,
    contactSizeVaries: false,
    sawTilt: false,
    coalescedMax: 0,
    coalescedTotal: 0,
    coalescedSamples: 0,
  };
}

/** The event fields this module reads. Keeps `observePointer` testable with plain objects. */
export type PointerSample = {
  pointerType?: string;
  pressure?: number;
  width?: number;
  height?: number;
  tiltX?: number;
  tiltY?: number;
};

// Pressure is a float; bucketing to 1/100 is what separates "genuinely varying"
// from "0.5 with float noise". Kept small and bounded — this set lives for the
// whole session and a pen emits thousands of distinct values.
const PRESSURE_BUCKETS = 100;
const DISTINCT_CAP = 64;

/**
 * Fold one pointer sample into the observations. Called on every point,
 * including coalesced ones, so it must stay allocation-free in the common case.
 * `seen` carries the distinct-pressure and contact-size sets across calls without
 * putting a Set on the serialisable Observations record — Observations has to
 * survive a JSON round trip into the database, and a Set does not.
 */
export function observePointer(
  obs: Observations,
  ev: PointerSample,
  // REQUIRED, not optional. It used to be optional, and a caller that omitted it
  // still "worked": every point was counted, but pressureDistinct stayed pinned
  // at 0 for ever, so pressureVaries() could never be true and Tier A was
  // silently unreachable on a device that deserved it. A parameter whose absence
  // disables a tier is not an optional parameter.
  seen: { pressure: Set<number>; size: Set<number> },
): void {
  obs.points++;
  const t = ev.pointerType;
  if (t && !obs.pointerTypes.includes(t)) obs.pointerTypes.push(t);

  const p = typeof ev.pressure === "number" ? ev.pressure : 0;
  // pressure === 0 is what a mouse and many touch panels report for "down with
  // no force sensor". Counting it would make every device look like it varies
  // the moment one stray 0 arrives, so only real force readings count.
  if (p > 0) {
    if (p < obs.pressureMin) obs.pressureMin = p;
    if (p > obs.pressureMax) obs.pressureMax = p;
    if (seen.pressure.size < DISTINCT_CAP) {
      seen.pressure.add(Math.round(p * PRESSURE_BUCKETS));
      obs.pressureDistinct = seen.pressure.size;
    }
  }

  const size = (ev.width ?? 0) * (ev.height ?? 0);
  if (size > 0 && seen.size.size < DISTINCT_CAP) {
    seen.size.add(Math.round(size));
    // One contact size is the panel reporting a constant; two or more means the
    // number tracks the real contact patch, which is what palm rejection needs.
    if (seen.size.size > 1) obs.contactSizeVaries = true;
  }

  if ((ev.tiltX ?? 0) !== 0 || (ev.tiltY ?? 0) !== 0) obs.sawTilt = true;
}

/** Record how many points one `pointermove` was actually hiding. */
export function observeCoalesced(obs: Observations, n: number): void {
  obs.coalescedSamples++;
  obs.coalescedTotal += n;
  if (n > obs.coalescedMax) obs.coalescedMax = n;
}

// ── derived answers ──────────────────────────────────────────────────────────

/** A pen has actually touched this screen. */
export const sawPen = (obs: Observations): boolean => obs.pointerTypes.includes("pen");

/**
 * Pressure is REAL on this device, not advertised. Needs both a spread and more
 * than a couple of distinct values — a panel that reports 0.5 forever, or flips
 * between 0 and 1 like a switch, is not a pressure sensor.
 */
export const pressureVaries = (obs: Observations): boolean =>
  obs.pressureDistinct >= 4 && obs.pressureMax - obs.pressureMin >= 0.1;

/** Mean coalesced points per move — the honest measure of captured input rate. */
export const coalescedMean = (obs: Observations): number =>
  obs.coalescedSamples ? obs.coalescedTotal / obs.coalescedSamples : 0;

export function tierFor(caps: StaticCaps, obs: Observations): Tier {
  if (!caps.coalesced) return "C";
  if (caps.desynchronized && sawPen(obs) && pressureVaries(obs)) return "A";
  return "B";
}

export function profileFor(caps: StaticCaps, obs: Observations): CaptureProfile {
  const tier = tierFor(caps, obs);
  const pen = sawPen(obs);
  return {
    tier,
    useCoalesced: caps.coalesced,
    // Prediction stays OFF until Phase 0 measures whether it helps more than it
    // smears. The capability is recorded; the decision is not made here.
    usePrediction: false,
    desynchronized: caps.desynchronized,
    widthFrom: tier === "A" ? "pressure" : "velocity",
    penOnly: pen,
    touchDrawsDefault: !pen,
    smoothing: tier === "C" ? "heavy" : "normal",
  };
}

// ── stats ────────────────────────────────────────────────────────────────────

/** Percentile of an UNSORTED sample. Returns null for an empty one — never 0,
 *  which would read as "instant" on a latency chart. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

export const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
