"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notFound } from "next/navigation";
import {
  probeStatic,
  newObservations,
  observePointer,
  observeCoalesced,
  profileFor,
  tierFor,
  type Observations,
  type CaptureProfile,
} from "@/board/capabilities";
import {
  accepts,
  StrokeBuilder,
  toSegments,
  tensionFor,
  type InkSample,
  type TouchMode,
} from "@/board/ink";
import {
  newRoll,
  addStroke,
  pageStrokes,
  toPage,
  History,
  type Roll,
  type Tool,
} from "@/board/model";
import { PageRenderer } from "@/board/render";

// The board library, driven from outside it — DEV ONLY (notFound in production,
// the same guard /preview/kit uses).
//
// This page is the honest test of "src/board/ is a standalone library". It
// imports the modules the way the standalone board SPA eventually will and wires
// them to a canvas itself; nothing here reaches back into the library's private
// state. If this file cannot be written without adding an export, the boundary
// is wrong.
//
// Not translated, and it never ships: measurement and development scaffolding.

const TOOLS: { key: Tool; label: string; color: string; width: number }[] = [
  { key: "pen", label: "Pen", color: "#14181F", width: 4 },
  { key: "highlighter", label: "Highlighter", color: "#F5D547", width: 26 },
  { key: "eraser", label: "Eraser", color: "#FFFFFF", width: 28 },
];

type PredictingPointer = PointerEvent & { getPredictedEvents?: () => PointerEvent[] };

export default function BoardGallery() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Board />;
}

function Board() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PageRenderer | null>(null);
  const rollRef = useRef<Roll>(newRoll("gallery"));
  const historyRef = useRef(new History());
  const builderRef = useRef<StrokeBuilder | null>(null);
  const activeRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const obsRef = useRef<Observations>(newObservations());
  const seenRef = useRef({ pressure: new Set<number>(), size: new Set<number>() });
  const profileRef = useRef<CaptureProfile | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const toolRef = useRef<Tool>("pen");
  const [touchMode, setTouchMode] = useState<TouchMode>("draw");
  const touchModeRef = useRef<TouchMode>("draw");
  const [stat, setStat] = useState({ tier: "—", strokes: 0, points: 0, pen: false });

  // Refs shadow the state so the pointer path never reads through a closure that
  // a render might have staled — the same discipline as the probe.
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    touchModeRef.current = touchMode;
  }, [touchMode]);

  const profile = useCallback((): CaptureProfile => {
    const caps = probeStatic();
    return profileFor(caps, obsRef.current);
  }, []);

  const repaint = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.commit(pageStrokes(rollRef.current, 0), rollRef.current.pages[0].background);
  }, []);

  const fit = useCallback(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    profileRef.current ??= profile();
    rendererRef.current ??= new PageRenderer(profileRef.current);
    rendererRef.current.fit(canvas, rect.width, rect.height, window.devicePixelRatio || 1);
    repaint();
  }, [profile, repaint]);

  useEffect(() => {
    fit();
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit]);

  const sampleFrom = useCallback((e: PointerEvent | React.PointerEvent, rect: DOMRect): InkSample => {
    const r = rendererRef.current!;
    const p = toPage(e.clientX - rect.left, e.clientY - rect.top, r.projection);
    return { x: p.x, y: p.y, pressure: e.pressure, t: e.timeStamp };
  }, []);

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const r = rendererRef.current;
      if (!r || activeRef.current !== null) return;
      // Observe BEFORE the policy check: a pen must be able to announce itself
      // even on the very contact the policy is about to judge.
      observePointer(obsRef.current, e.nativeEvent, seenRef.current);
      const prof = profileFor(probeStatic(), obsRef.current);
      profileRef.current = prof;
      if (!accepts({ profile: prof, touchMode: touchModeRef.current }, e.nativeEvent)) return;

      activeRef.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* some panels refuse capture; the stroke still works */
      }
      const spec = TOOLS.find((t) => t.key === toolRef.current)!;
      const b = new StrokeBuilder(`k${seqRef.current++}`, 0, spec.key, spec.color, spec.width, prof);
      b.push(sampleFrom(e, e.currentTarget.getBoundingClientRect()));
      builderRef.current = b;
    },
    [sampleFrom],
  );

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const b = builderRef.current;
      const r = rendererRef.current;
      if (!b || !r || activeRef.current !== e.pointerId) return;
      const native = e.nativeEvent as PredictingPointer;
      const rect = e.currentTarget.getBoundingClientRect();

      const raw = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : null;
      const batch = raw && raw.length ? raw : [native];
      observeCoalesced(obsRef.current, batch.length);
      let added = false;
      for (const c of batch) {
        observePointer(obsRef.current, c, seenRef.current);
        if (b.push(sampleFrom(c, rect))) added = true;
      }
      if (!added) return;

      // The live stroke is REDRAWN from scratch each move, not extended: the
      // width varies along it, so the tail of an extended path would keep the
      // width it was started with. undoWet() restores the page underneath first,
      // which is the whole reason the backing store exists.
      r.undoWet();
      r.wet(toSegments(b.finish(), tensionFor(profileRef.current!)), b.finish());
    },
    [sampleFrom],
  );

  const end = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const b = builderRef.current;
      const r = rendererRef.current;
      if (!b || !r || activeRef.current !== e.pointerId) return;
      activeRef.current = null;
      builderRef.current = null;
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      } catch {
        /* nothing to release */
      }
      const stroke = b.finish();
      if (b.length) {
        addStroke(rollRef.current, stroke);
        historyRef.current.clear(); // drawing ends the redo chain
      }
      repaint();
      const o = obsRef.current;
      setStat({
        tier: tierFor(probeStatic(), o),
        strokes: pageStrokes(rollRef.current, 0).length,
        points: o.points,
        pen: o.pointerTypes.includes("pen"),
      });
    },
    [repaint],
  );

  // Stable handlers rather than a helper invoked in the JSX. `act(() => ...)`
  // built its closure DURING render, and React's compiler correctly refuses a
  // ref read on that path — it cannot see that the closure only ever runs on a
  // click. useCallback moves the construction off the render path.
  const after = useCallback(() => {
    repaint();
    setStat((s) => ({ ...s, strokes: pageStrokes(rollRef.current, 0).length }));
  }, [repaint]);

  const onUndo = useCallback(() => {
    historyRef.current.undo(rollRef.current, 0);
    after();
  }, [after]);

  const onRedo = useCallback(() => {
    historyRef.current.redo(rollRef.current, 0);
    after();
  }, [after]);

  return (
    <main className="min-h-dvh select-none bg-[#FAFBFA] text-[#14181F] p-3 sm:p-5">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <div className="me-auto">
          <p className="font-mono text-[10px] tracking-[0.14em] text-[#5B6470] uppercase">
            Board · Phase 1 · one page
          </p>
          <h1 className="text-xl font-semibold tracking-tight">src/board gallery</h1>
        </div>
        {TOOLS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTool(t.key)}
            className={`rounded-lg border px-3 py-2 text-sm ${
              tool === t.key
                ? "border-[#0C8175] bg-[#E4F4F1] text-[#0C8175]"
                : "border-[#DCE6E2] bg-white text-[#5B6470]"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onUndo}
          className="rounded-lg border border-[#DCE6E2] bg-white px-3 py-2 text-sm text-[#5B6470]"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={onRedo}
          className="rounded-lg border border-[#DCE6E2] bg-white px-3 py-2 text-sm text-[#5B6470]"
        >
          Redo
        </button>
        <button
          type="button"
          onClick={() => setTouchMode((m) => (m === "draw" ? "scroll" : "draw"))}
          className="rounded-lg border border-[#DCE6E2] bg-white px-3 py-2 text-sm text-[#5B6470]"
          title="With no pen to prefer, no heuristic can be right for everyone"
        >
          Touch: {touchMode}
        </button>
      </header>

      <div
        ref={hostRef}
        className="rounded-xl border border-[#DCE6E2] overflow-hidden"
        style={{ height: "72vh", minHeight: 320 }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
          className="h-full w-full"
          style={{ touchAction: "none", overscrollBehavior: "contain", cursor: "crosshair" }}
        />
      </div>

      <p className="mt-2 font-mono text-[11px] text-[#5B6470]">
        tier {stat.tier} · {stat.strokes} strokes · {stat.points} pts · pen seen:{" "}
        {stat.pen ? "yes" : "no"} · page 1600×900, letterboxed to fit
      </p>
    </main>
  );
}
