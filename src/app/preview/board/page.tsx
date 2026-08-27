"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notFound } from "next/navigation";
import { probeStatic, newObservations, profileFor, type CaptureProfile } from "@/board/capabilities";
import type { TouchMode } from "@/board/ink";
import {
  newRoll,
  addPage,
  addStroke,
  pageStrokes,
  PAGE_W,
  PAGE_H,
  type PageBackground,
  type Stroke,
  type Tool,
} from "@/board/model";
import { percentile } from "@/board/capabilities";
import type { Rect } from "@/board/render";
import { RollView, type RollHandle } from "@/board/roll";
import { exportRoll, pdfPageCount, pdfPathCount, warmExport } from "@/board/export-pdf";

// The board library, driven from outside it — DEV ONLY (notFound in production,
// the same guard /preview/kit uses).
//
// This page is the honest test of "src/board/ is a standalone library": it
// imports the modules the way the standalone board SPA eventually will, and it
// owns only the things a host is supposed to own — which tool is selected, and
// how a page background is painted. If this file cannot be written without
// reaching into the library's internals, the boundary is wrong.
//
// Not translated, and it never ships.

const TOOLS: { key: Tool; label: string; color: string; width: number }[] = [
  { key: "pen", label: "Pen", color: "#14181F", width: 4 },
  { key: "highlighter", label: "Highlighter", color: "#F5D547", width: 26 },
  { key: "eraser", label: "Eraser", color: "#FFFFFF", width: 28 },
];

export default function BoardGallery() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Board />;
}

function Board() {
  const board = useRef<RollHandle | null>(null);
  const roll = useMemo(() => newRoll("gallery"), []);
  const profile = useMemo<CaptureProfile>(
    () => profileFor(probeStatic(), newObservations()),
    [],
  );

  const [tool, setTool] = useState<Tool>("pen");
  const [touchMode, setTouchMode] = useState<TouchMode>("draw");
  const [where, setWhere] = useState({ page: 0, count: 1 });
  const [strokes, setStrokes] = useState(0);
  const [pdf, setPdf] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);

  // Pay pdf-lib's dynamic import while she is teaching, not when she presses
  // Export at the bell.
  useEffect(() => {
    void warmExport();
  }, []);

  const spec = TOOLS.find((t) => t.key === tool)!;

  /**
   * The host's job, not the library's. A frozen video frame would be an image
   * this page had loaded; a worksheet question would be text it laid out. Here
   * they stand in as something visibly different per page, which is what makes a
   * page change legible while testing the slide.
   */
  const drawBackground = useCallback(
    (ctx: CanvasRenderingContext2D, bg: PageBackground, page: Rect) => {
      if (bg.kind !== "question") return;
      ctx.fillStyle = "#F1F5F3";
      ctx.fillRect(0, 0, page.w, 120);
      ctx.fillStyle = "#0C8175";
      ctx.font = "48px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(bg.prompt, 40, 60);
    },
    [],
  );

  const onPageChange = useCallback((page: number, count: number) => {
    setWhere({ page, count });
  }, []);
  const onStroke = useCallback(() => {
    setStrokes((n) => n + 1);
  }, []);

  const push = useCallback(() => {
    board.current?.push({
      kind: "question",
      generationId: "demo",
      questionId: "q",
      prompt: `Page ${Date.now() % 1000}`,
    });
  }, []);

  const onExport = useCallback(async () => {
    setPdf("working…");
    const t0 = performance.now();
    const bytes = await exportRoll(roll, {
      title: "Board gallery",
      text: (bg) => (bg.kind === "question" ? bg.prompt : null),
    });
    const ms = Math.round(performance.now() - t0);
    setPdf(
      `${(bytes.length / 1024).toFixed(1)} KB · ${pdfPageCount(roll)} pages · ` +
        `${pdfPathCount(roll)} paths · ${ms}ms`,
    );
    // A viewer download, so the file can actually be opened and looked at.
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "board.pdf";
    a.click();
    URL.revokeObjectURL(url);
  }, [roll]);

  /**
   * THE PHASE 1 GATE: 500 strokes over 10 pages, still at 60 fps.
   *
   * What is actually timed is `repaint()` — a full redraw of one page from the
   * backing store — because that is what runs after EVERY stroke ends. If a page
   * carrying fifty strokes cannot repaint inside a frame, the teacher feels it
   * as a hitch every time she lifts the pen, and the one-canvas design needs
   * tiling. The wind between pages is given time to settle first so its own
   * animation is not counted.
   */
  const runGate = useCallback(async () => {
    setGate("building 500 strokes…");
    const PAGES = 10;
    const PER_PAGE = 50;
    while (roll.pages.length < PAGES) addPage(roll, { kind: "blank" });
    let n = 0;
    for (let p = 0; p < PAGES; p++) {
      for (let i = 0; i < PER_PAGE; i++) {
        const pts: number[] = [];
        const y = 60 + (i % PER_PAGE) * 16;
        for (let k = 0; k <= 24; k++) {
          pts.push(40 + k * 62, y + Math.sin(k / 3 + i) * 22, 0.6 + ((k + i) % 5) / 10);
        }
        const s: Stroke = {
          id: `gate-${n++}`,
          page: p,
          tool: i % 7 === 0 ? "highlighter" : "pen",
          color: i % 7 === 0 ? "#F5D547" : "#14181F",
          width: i % 7 === 0 ? 26 : 4,
          pts,
        };
        addStroke(roll, s);
      }
    }

    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const samples: number[] = [];
    for (let p = 0; p < PAGES; p++) {
      board.current?.goTo(p);
      await wait(420); // let the wind settle so its animation is not timed
      for (let k = 0; k < 12; k++) {
        const t0 = performance.now();
        board.current?.repaint();
        samples.push(performance.now() - t0);
        await wait(8);
      }
    }
    const p50 = percentile(samples, 50) ?? 0;
    const p95 = percentile(samples, 95) ?? 0;
    const worst = Math.max(...samples);
    setWhere({ page: 0, count: roll.pages.length });
    setStrokes(roll.strokes.length);
    setGate(
      `${roll.strokes.length} strokes / ${roll.pages.length} pages · ` +
        `repaint p50 ${p50.toFixed(1)}ms · p95 ${p95.toFixed(1)}ms · worst ${worst.toFixed(1)}ms · ` +
        `${p95 < 16.7 ? "WITHIN a 60fps frame" : "OVER a 60fps frame"} · ` +
        `page 0 has ${pageStrokes(roll, 0).length}`,
    );
  }, [roll]);

  const btn =
    "rounded-lg border border-[#DCE6E2] bg-white px-3 py-2 text-sm text-[#5B6470] disabled:opacity-40";

  return (
    <main className="min-h-dvh select-none bg-[#FAFBFA] text-[#14181F] p-3 sm:p-5">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <div className="me-auto">
          <p className="font-mono text-[10px] tracking-[0.14em] text-[#5B6470] uppercase">
            Board · Phase 1 · the roll
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
        <button type="button" className={btn} onClick={() => board.current?.undo()}>
          Undo
        </button>
        <button type="button" className={btn} onClick={() => board.current?.redo()}>
          Redo
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => setTouchMode((m) => (m === "draw" ? "scroll" : "draw"))}
          title="With no pen to prefer, no heuristic can be right for everyone"
        >
          Touch: {touchMode}
        </button>
      </header>

      <div className="flex gap-3">
        <RollView
          ref={board}
          roll={roll}
          profile={profile}
          tool={tool}
          color={spec.color}
          width={spec.width}
          touchMode={touchMode}
          drawBackground={drawBackground}
          onStroke={onStroke}
          onPageChange={onPageChange}
          className="flex-1 rounded-xl border border-[#DCE6E2] overflow-hidden"
          style={{ height: "72vh", minHeight: 320 }}
        />
        <aside className="flex w-24 shrink-0 flex-col gap-2">
          <button
            type="button"
            className="rounded-lg bg-[#0C8175] px-3 py-4 text-sm font-medium text-white"
            onClick={push}
          >
            PUSH
          </button>
          <button
            type="button"
            className={btn}
            disabled={where.page === 0}
            onClick={() => board.current?.goTo(where.page - 1)}
          >
            ↑ Back
          </button>
          <button
            type="button"
            className={btn}
            disabled={where.page >= where.count - 1}
            onClick={() => board.current?.goTo(where.page + 1)}
          >
            ↓ Forward
          </button>
          <p className="text-center font-mono text-[11px] text-[#5B6470]">
            {where.page + 1} / {where.count}
          </p>
          <button type="button" className={btn} onClick={onExport}>
            Export
          </button>
          <button type="button" className={btn} onClick={runGate}>
            Gate
          </button>
        </aside>
      </div>

      <p className="mt-2 font-mono text-[11px] text-[#5B6470]">
        tier {profile.tier} · {strokes} strokes drawn · page {PAGE_W}×{PAGE_H}, letterboxed to fit ·
        touch draws by default: {profile.touchDrawsDefault ? "yes" : "no"}
        {pdf ? ` · pdf ${pdf}` : ""}
      </p>
      {gate && <p className="mt-1 font-mono text-[11px] text-[#0C8175]">GATE · {gate}</p>}
    </main>
  );
}
