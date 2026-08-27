"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  probeStatic,
  newObservations,
  observePointer,
  observeCoalesced,
  tierFor,
  profileFor,
  percentile,
  mean,
  coalescedMean,
  sawPen,
  pressureVaries,
  type StaticCaps,
  type Observations,
  type PointerSample,
} from "@/board/capabilities";

// Present mode, Phase 0 — the ink-latency harness.
//
// WHAT IT MEASURES, AND WHAT IT HONESTLY CANNOT. A browser can see when an
// input event arrived and when it finished a draw call; it cannot see photons.
// So this reports two numbers per strategy and labels them for what they are:
//
//   input → draw   the event's own timestamp to the moment the canvas call
//                  returned. This is where the strategies actually differ —
//                  routing a point through React state costs a render and at
//                  least one frame, and that shows up here.
//   input → paint  the same, measured after the frame containing it has been
//                  composited. Adds the compositor, still not the panel.
//
// The panel's own scan-out — often the largest term on a cheap interactive flat
// panel — is invisible to all of it. That is why the camera test below is not
// optional garnish: it is the only measurement that includes the glass.
//
// FOUR STRATEGIES, ONE GESTURE AREA EACH, so the same squiggle can be drawn in
// all four and compared by feel as well as by number. The React pad is the
// deliberate worst case and is here to make the cost of the obvious
// implementation visible rather than argued about.
//
// Not translated: see the note in page.tsx.

// ── types ────────────────────────────────────────────────────────────────────

type Strategy = "react" | "canvas" | "desync" | "predict";

type Sample = { toDraw: number; toPaint: number | null };

/** The accumulator. Lives in a REF and is mutated on the pointer path. */
type PadStats = {
  strokes: number;
  points: number;
  toDraw: number[];
  toPaint: number[];
  coalescedMax: number;
};

/** What a pad RENDERS. Derived from the accumulator once a second.
 *
 *  These are two types on purpose, and the reason is the whole point of this
 *  harness. The first version pushed every sample through setState, which put
 *  React on the hot path of all four pads — including the three whose only job
 *  is to show what NOT having React there is worth. The instrument was
 *  measuring itself. Samples now land in a ref and the summary is published on
 *  the same 1 Hz timer as everything else. */
type PadSummary = {
  strokes: number;
  n: number;
  p50: number | null;
  p95: number | null;
  paint95: number | null;
  coalescedMax: number;
};

const STRATEGIES: { key: Strategy; title: string; note: string }[] = [
  {
    key: "react",
    title: "React state",
    note: "Points into useState, drawn in an effect. The obvious implementation, and the control.",
  },
  {
    key: "canvas",
    title: "Canvas 2D",
    note: "Drawn synchronously inside the pointer handler. No React on the hot path.",
  },
  {
    key: "desync",
    title: "Canvas, desynchronized",
    note: "Same, with a low-latency context that may bypass the compositor.",
  },
  {
    key: "predict",
    title: "Desync + prediction",
    note: "Adds getPredictedEvents() as throwaway lead ink. Watch for smear on direction changes.",
  },
];

// Below this many samples a percentile is noise wearing a decimal point. The
// first live run of this harness produced "p50 7.3ms" off SIX points and the
// number looked authoritative — which is exactly how a measurement tool lies.
// Under the threshold the readout is marked, and the sample count is always on
// screen next to it.
const MIN_SAMPLES = 50;

const emptyStats = (): PadStats => ({
  strokes: 0,
  points: 0,
  toDraw: [],
  toPaint: [],
  coalescedMax: 0,
});

const emptySummary = (): PadSummary => ({
  strokes: 0,
  n: 0,
  p50: null,
  p95: null,
  paint95: null,
  coalescedMax: 0,
});

// A long session on a panel would otherwise grow these without bound. Well past
// MIN_SAMPLES, so the percentiles stay meaningful; the oldest samples are the
// least interesting anyway (they are the ones taken while the page settled).
const MAX_SAMPLES = 5000;

/** Keep the newest samples without paying for it on the pointer path.
 *
 *  This was `shift()` once per sample past the cap — an O(n) memmove of up to
 *  5000 doubles, running inside the very handler whose cost the harness is
 *  measuring. Dropping the oldest half in one splice makes it amortised O(1):
 *  one 2500-element move every 2500 samples instead of a 5000-element move
 *  every single one. */
function trim(a: number[]): void {
  if (a.length > MAX_SAMPLES) a.splice(0, MAX_SAMPLES / 2);
}

const summarise = (s: PadStats): PadSummary => ({
  strokes: s.strokes,
  n: s.toDraw.length,
  p50: percentile(s.toDraw, 50),
  p95: percentile(s.toDraw, 95),
  paint95: percentile(s.toPaint, 95),
  coalescedMax: s.coalescedMax,
});

// ── timing helpers ───────────────────────────────────────────────────────────

/**
 * Run `cb` after the frame currently being built has been painted. rAF fires
 * BEFORE paint, so the timeout chained off it is the first callback that can
 * claim the pixels went out. Not exact — nothing in the platform is — but it is
 * the same approximation for all four strategies, which is what makes the
 * comparison between them fair.
 */
function afterPaint(cb: () => void): void {
  requestAnimationFrame(() => {
    setTimeout(cb, 0);
  });
}

/**
 * Pointer timestamps are supposed to share `performance.now()`'s origin, and on
 * some older WebViews they are epoch milliseconds instead. Left unhandled that
 * turns every latency reading into ~1.7e12, which is obviously wrong — but the
 * failure mode we actually care about is the quieter one, where a reviewer
 * eyeballs a nonsense number and assumes the harness is broken rather than the
 * clock. Detect once, convert, and record which clock was used in the report.
 */
type ClockMode = "hi-res" | "epoch";
function detectClock(ts: number): ClockMode {
  return Math.abs(performance.now() - ts) < 5000 ? "hi-res" : "epoch";
}
function toHiRes(ts: number, mode: ClockMode): number {
  return mode === "epoch" ? ts - performance.timeOrigin : ts;
}

// ── drawing ──────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };

const INK = "#14181F";
const LEAD = "#1FB8A6";

function line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, width: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

/** Size a canvas to its box at device resolution and return a CSS-pixel context. */
function fitCanvas(
  canvas: HTMLCanvasElement,
  desynchronized: boolean,
): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext(
    "2d",
    desynchronized ? { desynchronized: true, alpha: true } : undefined,
  ) as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// PointerEvent.getPredictedEvents is not in every TS lib yet.
type PredictingPointer = PointerEvent & { getPredictedEvents?: () => PointerEvent[] };

// ── one pad ──────────────────────────────────────────────────────────────────

function Pad({
  strategy,
  title,
  note,
  stats,
  onSample,
  onStroke,
  record,
  recordCoalesced,
  clockRef,
  focused,
  onToggleFocus,
}: {
  strategy: Strategy;
  title: string;
  note: string;
  stats: PadSummary;
  onSample: (s: Strategy, sample: Sample) => void;
  onStroke: (s: Strategy, points: number, coalescedMax: number) => void;
  // Recorders, NOT the parent's refs. A child that mutates a ref handed to it
  // through props is invisible to React's compiler — it sees a prop being
  // written after render and (correctly) refuses. Passing the two closures
  // instead keeps the mutation inside the component that owns the ref, and has
  // the side benefit that Pad knows nothing about Observations at all.
  record: (ev: PointerSample) => void;
  recordCoalesced: (n: number) => void;
  clockRef: React.RefObject<ClockMode | null>;
  focused: boolean;
  onToggleFocus: () => void;
}) {
  const inkRef = useRef<HTMLCanvasElement | null>(null);
  const leadRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const leadCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const lastRef = useRef<Pt | null>(null);
  const activeRef = useRef<number | null>(null);
  const strokePoints = useRef(0);
  const strokeCoalesced = useRef(0);

  // The React-state path. Deliberately the slow route: every batch of points
  // goes through setState, so a render and an effect stand between the finger
  // and the pixels. Nothing else in this file uses React on the hot path.
  const [reactPts, setReactPts] = useState<{ pts: Pt[]; t: number; stroke: number } | null>(null);
  /** Bumped on every pointerdown, so a deferred React batch can tell whether the
   *  stroke it belongs to is still the one being drawn. */
  const strokeIdRef = useRef(0);

  const desynchronized = strategy === "desync" || strategy === "predict";

  const setup = useCallback(() => {
    const ink = inkRef.current;
    if (!ink) return;
    ctxRef.current = fitCanvas(ink, desynchronized);
    const lead = leadRef.current;
    if (lead) leadCtxRef.current = fitCanvas(lead, desynchronized);
    rectRef.current = ink.getBoundingClientRect();
  }, [desynchronized]);

  useEffect(() => {
    setup();
    const ink = inkRef.current;
    if (!ink) return;
    // The rect is cached at pointerdown to keep a forced layout off the pointer
    // path — but this page scrolls, and a stroke that survives a scroll would
    // otherwise be offset by the scroll distance for the rest of its length.
    // Re-reading it on scroll costs one layout per scroll event, never per point.
    const refreshRect = () => {
      rectRef.current = ink.getBoundingClientRect();
    };
    window.addEventListener("scroll", refreshRect, { passive: true, capture: true });
    window.addEventListener("resize", refreshRect, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => setup()) : null;
    ro?.observe(ink);
    return () => {
      window.removeEventListener("scroll", refreshRect, { capture: true });
      window.removeEventListener("resize", refreshRect);
      ro?.disconnect();
    };
  }, [setup, focused]);

  // Draw whatever the React path handed us, then close the measurement. This
  // effect IS the latency being measured for that strategy.
  useEffect(() => {
    if (strategy !== "react" || !reactPts) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    // A setState from a pointer handler is not guaranteed to have flushed before
    // pointerup, so this effect can run AFTER endStroke has nulled lastRef and a
    // new stroke has begun. Drawing the stale batch would then join it to the new
    // stroke's origin with a line across the pad. Stroke-scoped: a batch that
    // outlived its stroke is dropped, not drawn.
    if (reactPts.stroke !== strokeIdRef.current) return;
    for (const p of reactPts.pts) {
      const prev = lastRef.current;
      if (prev) line(ctx, prev, p, 2.4, INK);
      lastRef.current = p;
    }
    const drawn = performance.now();
    const t0 = reactPts.t;
    // toDraw ONCE, toPaint on the deferred leg with toDraw: NaN — identical to
    // the canvas path at the bottom of onMove. Spreading the sample here pushed
    // every React measurement twice, which both doubled this pad's `n` against
    // the other three and let it clear the MIN_SAMPLES honesty gate on half the
    // drawing.
    onSample("react", { toDraw: drawn - t0, toPaint: null });
    afterPaint(() => onSample("react", { toDraw: NaN, toPaint: performance.now() - t0 }));
  }, [reactPts, strategy, onSample]);

  const pointFrom = useCallback((e: PointerEvent | React.PointerEvent): Pt => {
    const r = rectRef.current;
    // clientX/Y minus a rect cached at pointerdown: offsetX is unreliable on
    // coalesced events, and re-reading the rect per point forces layout inside
    // the hot path — the exact thing this harness exists to keep out of it.
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }, []);

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (activeRef.current !== null) return; // one stroke at a time
      activeRef.current = e.pointerId;
      rectRef.current = e.currentTarget.getBoundingClientRect();
      if (clockRef.current === null) clockRef.current = detectClock(e.timeStamp);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* some panels refuse capture; the stroke still works without it */
      }
      lastRef.current = pointFrom(e);
      strokeIdRef.current++;
      strokePoints.current = 1;
      strokeCoalesced.current = 0;
      record(e.nativeEvent);
      // NO React seed here. It used to be `setReactPts({ pts: [], t: e.timeStamp })`
      // and carried two defects in one line: it recorded a latency sample for a
      // draw of ZERO points (so the React pad alone got a free fast sample per
      // stroke), and `e.timeStamp` was the ONLY timestamp in this file that
      // skipped toHiRes(). On an epoch-clock WebView — the old Android panels
      // this harness exists to characterise — that produced a finite, negative
      // ~-1.7e12 ms sample which sailed past the NaN guard and destroyed the
      // saved mean for the control strategy. The stroke starts on the first
      // pointermove instead, exactly like the other three pads.
    },
    [clockRef, record, pointFrom],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (activeRef.current !== e.pointerId) return;
      const native = e.nativeEvent as PredictingPointer;
      const clock = clockRef.current ?? "hi-res";

      // An EMPTY coalesced list is a real answer, not just a missing API: some
      // browsers return one for a move that carried no intermediate samples, and
      // untrusted events return one always. Falling through to the event itself
      // keeps the stroke drawing; taking `[]` at face value would silently drop
      // every point and leave a harness that measures nothing while looking fine.
      const raw =
        typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : null;
      const batch: PointerEvent[] = raw && raw.length ? raw : [native];
      const n = batch.length;
      recordCoalesced(n);
      if (n > strokeCoalesced.current) strokeCoalesced.current = n;

      const pts: Pt[] = [];
      for (const c of batch) {
        record(c);
        pts.push(pointFrom(c));
      }
      strokePoints.current += pts.length;

      // The latency that matters is the NEWEST input's: that is the point under
      // the nib right now. Older coalesced points are historical fill-in and
      // are drawn, but timing them would flatter nothing and confuse everything.
      const newest = batch[batch.length - 1] ?? native;
      const t0 = toHiRes(newest.timeStamp, clock);

      if (strategy === "react") {
        setReactPts({ pts, t: t0, stroke: strokeIdRef.current });
        return;
      }

      const ctx = ctxRef.current;
      if (!ctx) return;
      for (const p of pts) {
        const prev = lastRef.current;
        if (prev) line(ctx, prev, p, 2.4, INK);
        lastRef.current = p;
      }

      if (strategy === "predict") {
        const lead = leadCtxRef.current;
        const leadCanvas = leadRef.current;
        if (lead && leadCanvas) {
          const dpr = window.devicePixelRatio || 1;
          lead.clearRect(0, 0, leadCanvas.width / dpr, leadCanvas.height / dpr);
          const predicted = native.getPredictedEvents?.() ?? [];
          let prev = lastRef.current;
          for (const p of predicted) {
            const q = pointFrom(p);
            if (prev) line(lead, prev, q, 2.4, LEAD);
            prev = q;
          }
        }
      }

      const drawn = performance.now();
      onSample(strategy, { toDraw: drawn - t0, toPaint: null });
      afterPaint(() => onSample(strategy, { toDraw: NaN, toPaint: performance.now() - t0 }));
    },
    [clockRef, record, recordCoalesced, pointFrom, strategy, onSample],
  );

  const endStroke = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (activeRef.current !== e.pointerId) return;
      activeRef.current = null;
      lastRef.current = null;
      try {
        // Still throws on some panels even when capture was granted — the
        // optional call is not enough, it needs the catch.
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      } catch {
        /* nothing to release */
      }
      const lead = leadCtxRef.current;
      const leadCanvas = leadRef.current;
      if (lead && leadCanvas) {
        const dpr = window.devicePixelRatio || 1;
        lead.clearRect(0, 0, leadCanvas.width / dpr, leadCanvas.height / dpr);
      }
      onStroke(strategy, strokePoints.current, strokeCoalesced.current);
    },
    [onStroke, strategy],
  );

  const clear = () => {
    const ink = inkRef.current;
    const ctx = ctxRef.current;
    if (ink && ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, ink.width / dpr, ink.height / dpr);
    }
  };

  const { p50, p95, paint95, n } = stats;
  const thin = n > 0 && n < MIN_SAMPLES;

  return (
    <div className="rounded-xl border border-[#DCE6E2] bg-white overflow-hidden flex flex-col">
      <div className="flex items-baseline gap-2 px-3 py-2 border-b border-[#EEF0EC]">
        <span className="text-sm font-medium text-[#14181F]">{title}</span>
        <span className="ms-auto flex gap-1.5">
          <button
            type="button"
            onClick={onToggleFocus}
            className="text-[11px] rounded border border-[#DCE6E2] px-2 py-1 text-[#5B6470] active:bg-[#F1F5F3]"
          >
            {focused ? "Shrink" : "Expand"}
          </button>
          <button
            type="button"
            onClick={clear}
            className="text-[11px] rounded border border-[#DCE6E2] px-2 py-1 text-[#5B6470] active:bg-[#F1F5F3]"
          >
            Clear
          </button>
        </span>
      </div>

      <div className="relative" style={{ height: focused ? "58vh" : "34vh", minHeight: 180 }}>
        <canvas
          ref={inkRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
          className="absolute inset-0 h-full w-full"
          // touch-action:none is what stops the panel scrolling instead of
          // drawing; overscroll containment stops a stroke that runs off the pad
          // from pulling the page.
          style={{ touchAction: "none", overscrollBehavior: "contain", cursor: "crosshair" }}
        />
        {strategy === "predict" && (
          <canvas
            ref={leadRef}
            className="absolute inset-0 h-full w-full pointer-events-none"
            style={{ touchAction: "none" }}
          />
        )}
      </div>

      <div className="px-3 py-2 border-t border-[#EEF0EC] text-[11px] leading-relaxed">
        <p className="text-[#5B6470] mb-1">{note}</p>
        <div
          className={`flex flex-wrap gap-x-3 gap-y-0.5 font-mono ${
            thin ? "text-[#A0621C]" : "text-[#14181F]"
          }`}
        >
          <span>
            draw p50 <b>{p50 === null ? "—" : `${p50.toFixed(1)}ms`}</b>
          </span>
          <span>
            p95 <b>{p95 === null ? "—" : `${p95.toFixed(1)}ms`}</b>
          </span>
          <span className={thin ? "" : "text-[#5B6470]"}>
            paint p95 {paint95 === null ? "—" : `${paint95.toFixed(1)}ms`}
          </span>
          <span className={thin ? "" : "text-[#5B6470]"}>
            n={n}
            {thin ? ` — keep drawing, ${MIN_SAMPLES - n} more` : ""}
          </span>
          <span className="text-[#5B6470]">
            {stats.strokes} strokes · max {stats.coalescedMax}/move
          </span>
        </div>
      </div>
    </div>
  );
}


// ── the harness ──────────────────────────────────────────────────────────────

// The static probe is a one-shot read of an environment that cannot change
// while the tab is open, so it is cached at module scope and served through
// useSyncExternalStore with a subscribe that never fires. That is the shape
// React wants for "an external system I read once": computing it in an effect
// and setState-ing it would cascade a render, and computing it during render
// would run it on the server, where there is no window to ask.
let capsCache: StaticCaps | null = null;
const capsSnapshot = (): StaticCaps => (capsCache ??= probeStatic());
const capsServerSnapshot = (): StaticCaps | null => null;
const capsSubscribe = () => () => {};

/** What the sidebars show. Refreshed on a timer, never per point. */
type LiveSnapshot = {
  obs: Observations;
  pads: Record<Strategy, PadSummary>;
  refreshHz: number | null;
  longFrames: number;
  framesSampled: number;
  clock: ClockMode | null;
};

export default function ProbeClient() {
  const caps = useSyncExternalStore(capsSubscribe, capsSnapshot, capsServerSnapshot);

  // THE ACCUMULATOR IS A REF, not state — see the note on PadSummary. Nothing
  // on the pointer path may call setState, or the harness measures itself.
  const statsRef = useRef<Record<Strategy, PadStats>>({
    react: emptyStats(),
    canvas: emptyStats(),
    desync: emptyStats(),
    predict: emptyStats(),
  });
  const [focused, setFocused] = useState<Strategy | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const obs = useRef<Observations>(newObservations());
  const seen = useRef({ pressure: new Set<number>(), size: new Set<number>() });
  const clockRef = useRef<ClockMode | null>(null);

  // Frame health: the refresh rate we actually get, and how often a frame is
  // missed. A panel that claims 60 Hz and delivers 45 under load is a finding in
  // itself, and it would be invisible in a latency percentile alone.
  const frames = useRef<{ deltas: number[]; last: number }>({ deltas: [], last: 0 });

  // ONE snapshot, published on a 1 Hz timer. Observations and frame deltas are
  // written thousands of times a second on the pointer path; rendering from them
  // directly would mean either reading refs during render (which React forbids,
  // because that render is not reproducible) or a setState per point — the exact
  // cost the React pad exists to demonstrate. So the hot path writes refs, and
  // this timer copies them into state slowly enough that the copying is free.
  const [live, setLive] = useState<LiveSnapshot>({
    obs: newObservations(),
    pads: {
      react: emptySummary(),
      canvas: emptySummary(),
      desync: emptySummary(),
      predict: emptySummary(),
    },
    refreshHz: null,
    longFrames: 0,
    framesSampled: 0,
    clock: null,
  });

  useEffect(() => {
    let raf = 0;
    const tick = (t: number) => {
      const f = frames.current;
      if (f.last) {
        f.deltas.push(t - f.last);
        // ~10s at 60 Hz. Bounded so a probe left open all afternoon does not
        // grow an array until the tab dies.
        if (f.deltas.length > 600) f.deltas.shift();
      }
      f.last = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const id = setInterval(() => {
      const d = frames.current.deltas;
      const med = percentile(d, 50);
      const o = obs.current;
      const cur = statsRef.current;
      setLive({
        // A shallow copy with the array cloned: the render must not hold a
        // reference to something the pointer path keeps mutating underneath it.
        obs: { ...o, pointerTypes: [...o.pointerTypes] },
        // Percentiles, not the sample arrays — the render never needs thousands
        // of numbers, and copying them every second would be the one expensive
        // thing in an otherwise free timer.
        pads: {
          react: summarise(cur.react),
          canvas: summarise(cur.canvas),
          desync: summarise(cur.desync),
          predict: summarise(cur.predict),
        },
        refreshHz: med && med > 0 ? Math.round(1000 / med) : null,
        longFrames: med ? d.filter((x) => x > med * 1.5).length : 0,
        framesSampled: d.length,
        clock: clockRef.current,
      });
    }, 1000);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);

  // The only two writers of the observations ref, both owned by the component
  // that owns it. Called for EVERY point, coalesced ones included.
  const record = useCallback((ev: PointerSample) => {
    observePointer(obs.current, ev, seen.current);
  }, []);
  const recordCoalesced = useCallback((n: number) => {
    observeCoalesced(obs.current, n);
  }, []);

  // Push, don't copy. One array append per sample, no allocation of a new stats
  // object, no render scheduled. The 1 Hz timer above is the only reader.
  const onSample = useCallback((s: Strategy, sample: Sample) => {
    const cur = statsRef.current[s];
    if (!Number.isNaN(sample.toDraw)) {
      cur.toDraw.push(sample.toDraw);
      trim(cur.toDraw);
    }
    if (sample.toPaint !== null) {
      cur.toPaint.push(sample.toPaint);
      trim(cur.toPaint);
    }
  }, []);

  const onStroke = useCallback((s: Strategy, points: number, coalescedMax: number) => {
    obs.current.strokes++;
    const cur = statsRef.current[s];
    cur.strokes++;
    cur.points += points;
    if (coalescedMax > cur.coalescedMax) cur.coalescedMax = coalescedMax;
  }, []);

  /** Assemble the run. Reads the LIVE refs rather than the 1 Hz snapshot — a
   *  save must never miss the last second of drawing. */
  const report = useCallback(() => {
    const o = obs.current;
    const d = frames.current.deltas;
    const med = percentile(d, 50);
    const refreshHz = med && med > 0 ? Math.round(1000 / med) : null;
    const strategies = Object.fromEntries(
      STRATEGIES.map(({ key }) => {
        const s = statsRef.current[key];
        return [
          key,
          {
            strokes: s.strokes,
            points: s.points,
            coalescedMax: s.coalescedMax,
            inputToDraw: {
              n: s.toDraw.length,
              p50: percentile(s.toDraw, 50),
              p95: percentile(s.toDraw, 95),
              mean: mean(s.toDraw),
            },
            inputToPaint: {
              n: s.toPaint.length,
              p50: percentile(s.toPaint, 50),
              p95: percentile(s.toPaint, 95),
              mean: mean(s.toPaint),
            },
          },
        ];
      }),
    );
    return {
      caps,
      observations: {
        ...o,
        // newObservations() seeds min=1/max=0 so the first real sample sets both
        // ends. Left alone, a device that reports no pressure at all saves a
        // "pressure range" of 1 to 0 — a negative span that reads as a bug in
        // the device rather than an absence of data. The screen already guards
        // this; the stored row did not.
        pressureMin: o.pressureMax > 0 ? o.pressureMin : null,
        pressureMax: o.pressureMax > 0 ? o.pressureMax : null,
        coalescedMean: coalescedMean(o),
        sawPen: sawPen(o),
        pressureVaries: pressureVaries(o),
      },
      results: {
        clock: clockRef.current ?? "unknown",
        refreshHz,
        frameBudgetMs: refreshHz ? 1000 / refreshHz : null,
        longFrames: med ? d.filter((x) => x > med * 1.5).length : 0,
        framesSampled: d.length,
        strategies,
        tier: caps ? tierFor(caps, o) : null,
        profile: caps ? profileFor(caps, o) : null,
      },
    };
    // statsRef is deliberately not a dependency: it is a ref, its identity never
    // changes, and the callback must always read the newest samples.
  }, [caps]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const r = report();
      const res = await fetch("/api/present/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label,
          caps: r.caps,
          observations: r.observations,
          results: r.results,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.error || `Save failed (${res.status})`);
      setSaved(d?.id ?? "saved");
    } catch (e) {
      // A failed save on a wall panel is the one error that must be visible:
      // the numbers are gone the moment the tab closes.
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
      setSaved("copied to clipboard");
    } catch {
      setError("Clipboard refused — use Save run instead.");
    }
  }

  const o = live.obs;
  const tier = caps ? tierFor(caps, o) : null;
  const budget = live.refreshHz ? 1000 / live.refreshHz : null;

  const row = (k: string, v: unknown, warn = false) => (
    <div key={k} className="flex justify-between gap-3 py-0.5 border-b border-[#F4F7F6]">
      <span className="text-[#5B6470]">{k}</span>
      <span className={`font-mono ${warn ? "text-[#A0621C]" : "text-[#14181F]"}`}>
        {typeof v === "boolean"
          ? v
            ? "yes"
            : "no"
          : v === null || v === undefined || v === ""
            ? "—"
            : String(v)}
      </span>
    </div>
  );

  // select-none across the whole surface: a stroke that runs off a pad was
  // selecting the sidebar text behind it, which on a panel means a blue
  // highlight over the very readings the teacher is trying to read. Drawing
  // surfaces never want text selection; the one input opts back in.
  return (
    <main className="min-h-dvh select-none bg-[#FAFBFA] text-[#14181F] p-3 sm:p-5">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <p className="font-mono text-[10px] tracking-[0.14em] text-[#5B6470] uppercase">
            Present mode · Phase 0
          </p>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Ink latency probe</h1>
        </div>
        <div
          className={`ms-auto rounded-lg px-3 py-2 font-mono text-sm ${
            tier === "A"
              ? "bg-[#E4F4F1] text-[#0C8175]"
              : tier === "B"
                ? "bg-[#F1F5F3] text-[#14181F]"
                : "bg-[#FAF0E2] text-[#A0621C]"
          }`}
        >
          Tier {tier ?? "—"}
          <span className="ms-2 text-[11px] opacity-70">
            {live.refreshHz
              ? `${live.refreshHz} Hz · ${budget?.toFixed(1)}ms/frame`
              : "measuring…"}
          </span>
        </div>
      </header>

      {/* Draw first, read second: the tier cannot be decided until real strokes
          have shown whether pressure varies on this panel. */}
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className={`grid gap-3 ${focused ? "" : "sm:grid-cols-2"}`}>
          {STRATEGIES.filter((s) => !focused || s.key === focused).map((s) => (
            <Pad
              key={s.key}
              strategy={s.key}
              title={s.title}
              note={s.note}
              stats={live.pads[s.key]}
              onSample={onSample}
              onStroke={onStroke}
              record={record}
              recordCoalesced={recordCoalesced}
              clockRef={clockRef}
              focused={focused === s.key}
              onToggleFocus={() => setFocused((f) => (f === s.key ? null : s.key))}
            />
          ))}
        </div>

        <aside className="grid gap-3 content-start">
          <section className="rounded-xl border border-[#DCE6E2] bg-white p-3">
            <h2 className="text-[11px] font-mono uppercase tracking-[0.1em] text-[#5B6470] mb-2">
              What real strokes showed
            </h2>
            <div className="text-[12px]">
              {row("pointer types", o.pointerTypes.join(", "))}
              {row("pressure varies", pressureVaries(o), !pressureVaries(o))}
              {row(
                "pressure range",
                o.pressureMax > 0
                  ? `${o.pressureMin.toFixed(2)}–${o.pressureMax.toFixed(2)}`
                  : "",
              )}
              {row("distinct pressures", o.pressureDistinct)}
              {row("contact size varies", o.contactSizeVaries)}
              {row("tilt seen", o.sawTilt)}
              {row("coalesced mean", o.coalescedSamples ? coalescedMean(o).toFixed(2) : "")}
              {row("coalesced max", o.coalescedMax)}
              {row("long frames", `${live.longFrames}/${live.framesSampled}`, live.longFrames > 0)}
              {row("clock", live.clock ?? "", live.clock === "epoch")}
            </div>
          </section>

          <section className="rounded-xl border border-[#DCE6E2] bg-white p-3">
            <h2 className="text-[11px] font-mono uppercase tracking-[0.1em] text-[#5B6470] mb-2">
              What the browser claims
            </h2>
            <div className="text-[12px]">
              {caps ? (
                <>
                  {row("coalesced events", caps.coalesced, !caps.coalesced)}
                  {row("predicted events", caps.predicted)}
                  {row("desynchronized", caps.desynchronized, !caps.desynchronized)}
                  {row("max touch points", caps.maxTouchPoints)}
                  {row("coarse pointer", caps.coarsePointer)}
                  {row("any hover", caps.anyHover)}
                  {row("device pixel ratio", caps.devicePixelRatio)}
                  {row("screen", caps.screen ? `${caps.screen.width}×${caps.screen.height}` : "")}
                  {row("cores", caps.hardwareConcurrency)}
                  {row("memory (GB)", caps.deviceMemory)}
                  {row("OffscreenCanvas", caps.offscreenCanvas)}
                  {row("IndexedDB", caps.indexedDB, !caps.indexedDB)}
                  {row("platform", caps.uaPlatform)}
                </>
              ) : (
                <p className="text-[#5B6470]">probing…</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-[#DCE6E2] bg-white p-3">
            <h2 className="text-[11px] font-mono uppercase tracking-[0.1em] text-[#5B6470] mb-2">
              The measurement the browser cannot make
            </h2>
            <ol className="text-[12px] text-[#5B6470] list-decimal ps-4 grid gap-1">
              <li>Expand the winning pad.</li>
              <li>Film the screen at 240 fps while dragging steadily across it.</li>
              <li>
                Measure the gap between nib and ink tip. At {live.refreshHz ?? "—"} Hz one
                frame is {budget ? `${budget.toFixed(1)}ms` : "—"}.
              </li>
              <li>Write what you saw into the label before saving.</li>
            </ol>
            <p className="text-[11px] text-[#A0621C] mt-2">
              Everything above stops at the compositor. Only the camera includes the glass.
            </p>
          </section>

          <section className="rounded-xl border border-[#DCE6E2] bg-white p-3 grid gap-2">
            <label
              htmlFor="probe-label"
              className="text-[11px] font-mono uppercase tracking-[0.1em] text-[#5B6470]"
            >
              This device
            </label>
            <input
              id="probe-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Hisense 75in, Block B — nib gap ~2 finger widths"
              className="w-full select-text rounded-lg border border-[#DCE6E2] px-2.5 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex-1 rounded-lg bg-[#0C8175] px-3 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save run"}
              </button>
              <button
                type="button"
                onClick={copyJson}
                className="rounded-lg border border-[#DCE6E2] px-3 py-2.5 text-sm text-[#5B6470]"
              >
                Copy
              </button>
            </div>
            {saved && <p className="text-[12px] text-[#0C8175]">Recorded ({saved}).</p>}
            {error && <p className="text-[12px] text-[#A33A46]">{error}</p>}
            <p className="text-[11px] text-[#5B6470]">
              Save before closing the tab — nothing here survives a reload.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
