"use client";

// The viewport: paper on a roll.
//
// ONE PAGE IS VISIBLE AT A TIME, and that is a decision, not a simplification.
// A roll of paper shows about a screen; you wind it. On a classroom panel a
// half-visible page is worse than useless — the class reads the top half of
// something and the bottom half of something else — so the roll advances a whole
// screen at a time, which is exactly what the PUSH button means. Three things
// fall out of it: memory is constant however long the lesson ran, the visible
// page is ALWAYS the low-latency canvas, and there is no scroll position to get
// subtly wrong while someone is writing.
//
// THE SLIDE IS DRAWN INSIDE THE ONE CANVAS. The obvious way to animate a page
// change is a second canvas sliding over the first, and that is precisely what
// Phase 0 forbids: nothing may be stacked above a desynchronised canvas. So the
// outgoing page is snapshotted to an ordinary offscreen canvas and the two are
// blitted at an animating offset into the same bitmap.
//
// Pointer handling lives HERE rather than in the host, because a host that had
// to reimplement the palm policy would eventually get it wrong.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { CaptureProfile } from "./capabilities";
import { accepts, StrokeBuilder, toSegments, tensionFor, type InkSample, type TouchMode } from "./ink";
import {
  addPage,
  addStroke,
  pageStrokes,
  toPage,
  History,
  type PageBackground,
  type Roll,
  type Stroke,
  type Tool,
} from "./model";
import { PageRenderer, type Rect } from "./render";

const SLIDE_MS = 260;
const easeOutCubic = (k: number): number => 1 - Math.pow(1 - k, 3);

const reducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export type RollHandle = {
  /** Append a page and wind to it — what the PUSH button does. */
  push: (background?: PageBackground) => void;
  /** Wind to an existing page. Out-of-range is clamped, not an error: this is
   *  driven by buttons a teacher taps quickly, and a thrown error mid-lesson is
   *  never the right answer to a double-tap. */
  goTo: (page: number) => void;
  undo: () => void;
  redo: () => void;
  /** Repaint the current page — after the host changes a background. */
  repaint: () => void;
};

export type RollViewProps = {
  roll: Roll;
  profile: CaptureProfile;
  tool: Tool;
  color: string;
  /** Base stroke width in PAGE units. */
  width: number;
  touchMode: TouchMode;
  /** Draws a page's background. The host owns this because a frozen video frame
   *  is an image it loaded and a question is text it lays out — neither belongs
   *  in a module that must stay portable to the standalone board. */
  drawBackground?: (ctx: CanvasRenderingContext2D, bg: PageBackground, page: Rect) => void;
  /** Called once per finished stroke — the hook a store flushes from. */
  onStroke?: (stroke: Stroke) => void;
  onPageChange?: (page: number, pageCount: number) => void;
  className?: string;
  style?: CSSProperties;
};

type PredictingPointer = PointerEvent & { getPredictedEvents?: () => PointerEvent[] };

export const RollView = forwardRef<RollHandle, RollViewProps>(function RollView(
  { roll, profile, tool, color, width, touchMode, drawBackground, onStroke, onPageChange, className, style },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PageRenderer | null>(null);
  const historyRef = useRef(new History());
  const builderRef = useRef<StrokeBuilder | null>(null);
  const activeRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const pageRef = useRef(0);
  const animRef = useRef<number | null>(null);
  /** Lands the slide immediately. Set while one is running, null otherwise. */
  const settleRef = useRef<(() => void) | null>(null);

  const [page, setPage] = useState(0);

  // Everything the pointer path reads goes through a ref. A handler that closed
  // over `tool` from a render would keep drawing with the tool she had selected
  // when that render happened.
  const live = useRef({ roll, profile, tool, color, width, touchMode, drawBackground, onStroke });
  useEffect(() => {
    live.current = { roll, profile, tool, color, width, touchMode, drawBackground, onStroke };
  }, [roll, profile, tool, color, width, touchMode, drawBackground, onStroke]);

  const paintPage = useCallback((n: number) => {
    const r = rendererRef.current;
    const { roll: rl, drawBackground: bg } = live.current;
    if (!r || !rl.pages[n]) return;
    r.commit(pageStrokes(rl, n), rl.pages[n].background, bg);
  }, []);

  const fit = useCallback(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const box = host.getBoundingClientRect();
    if (!box.width || !box.height) return;
    rendererRef.current ??= new PageRenderer(live.current.profile);
    rendererRef.current.fit(canvas, box.width, box.height, window.devicePixelRatio || 1);
    paintPage(pageRef.current);
  }, [paintPage]);

  useEffect(() => {
    fit();
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    };
  }, [fit]);

  /**
   * Wind from the current page to `next`, sliding.
   *
   * The outgoing page is copied out of the backing store BEFORE the incoming one
   * is committed over it — the backing store is the only place the outgoing
   * pixels exist, and commit() is about to overwrite them.
   */
  const wind = useCallback(
    (next: number) => {
      const r = rendererRef.current;
      const canvas = canvasRef.current;
      const { roll: rl } = live.current;
      const target = Math.max(0, Math.min(rl.pages.length - 1, next));
      if (!r || !canvas || target === pageRef.current) return;

      const dir = target > pageRef.current ? 1 : -1;
      const from = r.backingCanvas;
      const w = canvas.width;
      const h = canvas.height;

      let snapshot: HTMLCanvasElement | null = null;
      if (from && !reducedMotion()) {
        snapshot = canvas.ownerDocument.createElement("canvas");
        snapshot.width = w;
        snapshot.height = h;
        snapshot.getContext("2d", { alpha: false })?.drawImage(from, 0, 0);
      }

      pageRef.current = target;
      setPage(target);
      paintPage(target);
      onPageChange?.(target, rl.pages.length);

      if (!snapshot) return; // reduced motion, or nothing to slide from
      const incoming = r.backingCanvas;
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
      if (!incoming || !ctx) return;

      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      // Landing the slide is its own operation because a pointerdown can demand
      // it early — see settleRef below.
      settleRef.current = () => {
        if (animRef.current !== null) cancelAnimationFrame(animRef.current);
        animRef.current = null;
        settleRef.current = null;
        paintPage(target);
      };
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / SLIDE_MS);
        const off = easeOutCubic(k) * h * dir;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.drawImage(snapshot!, 0, -off);
        ctx.drawImage(incoming, 0, dir === 1 ? h - off : -h - off);
        if (k < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          // Settle on the real thing rather than on the last animated frame, so
          // a rounding error in the offset cannot leave the page a pixel off.
          settleRef.current?.();
        }
      };
      animRef.current = requestAnimationFrame(step);
    },
    [onPageChange, paintPage],
  );

  useImperativeHandle(
    ref,
    (): RollHandle => ({
      push(background) {
        const { roll: rl } = live.current;
        const n = addPage(rl, background ?? { kind: "blank" });
        wind(n);
      },
      goTo(n) {
        wind(n);
      },
      undo() {
        historyRef.current.undo(live.current.roll, pageRef.current);
        paintPage(pageRef.current);
      },
      redo() {
        historyRef.current.redo(live.current.roll, pageRef.current);
        paintPage(pageRef.current);
      },
      repaint() {
        paintPage(pageRef.current);
      },
    }),
    [wind, paintPage],
  );

  // ── pointer ────────────────────────────────────────────────────────────────

  const sample = useCallback((e: PointerEvent | React.PointerEvent, box: DOMRect): InkSample => {
    const r = rendererRef.current!;
    const p = toPage(e.clientX - box.left, e.clientY - box.top, r.projection);
    return { x: p.x, y: p.y, pressure: e.pressure, t: e.timeStamp };
  }, []);

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const r = rendererRef.current;
      if (!r || activeRef.current !== null) return;
      const { profile: prof, touchMode: tm, tool: tl, color: c, width: w, roll: rl } = live.current;
      if (!accepts({ profile: prof, touchMode: tm }, e.nativeEvent)) return;

      // A stroke started mid-slide would land at the wrong place on a page that
      // is still moving — so LAND THE SLIDE and take the stroke, rather than
      // dropping it. Refusing was the first version, and it had a failure mode
      // worse than the one it prevented: requestAnimationFrame does not run in a
      // hidden or non-compositing tab, so the animation would never finish, and
      // the board became permanently un-drawable with no way back. Never gate
      // input on an animation completing.
      settleRef.current?.();

      activeRef.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* some panels refuse capture; the stroke still works */
      }
      const b = new StrokeBuilder(
        `${rl.id}:${seqRef.current++}`,
        pageRef.current,
        tl,
        c,
        w,
        prof,
      );
      b.push(sample(e, e.currentTarget.getBoundingClientRect()));
      builderRef.current = b;
    },
    [sample],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const b = builderRef.current;
      const r = rendererRef.current;
      if (!b || !r || activeRef.current !== e.pointerId) return;
      const native = e.nativeEvent as PredictingPointer;
      const box = e.currentTarget.getBoundingClientRect();
      const raw = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : null;
      const batch = raw && raw.length ? raw : [native];

      let added = false;
      for (const c of batch) if (b.push(sample(c, box))) added = true;
      if (!added) return;

      // The live stroke is REDRAWN whole each move rather than extended: its
      // width varies along its length, so an extended path would keep whatever
      // width it began with. undoWet() puts back the page underneath first,
      // which is the entire reason the backing store exists.
      const stroke = b.finish();
      r.undoWet();
      r.wet(toSegments(stroke, tensionFor(live.current.profile)), stroke);
    },
    [sample],
  );

  const onUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const b = builderRef.current;
      if (!b || activeRef.current !== e.pointerId) return;
      activeRef.current = null;
      builderRef.current = null;
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      } catch {
        /* nothing to release */
      }
      if (!b.length) return;
      const stroke = b.finish();
      addStroke(live.current.roll, stroke);
      historyRef.current.clear(); // drawing ends the redo chain
      paintPage(pageRef.current);
      live.current.onStroke?.(stroke);
    },
    [paintPage],
  );

  return (
    <div ref={hostRef} className={className} style={style} data-page={page}>
      <canvas
        ref={canvasRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
        className="h-full w-full"
        style={{ touchAction: "none", overscrollBehavior: "contain", cursor: "crosshair" }}
      />
    </div>
  );
});
