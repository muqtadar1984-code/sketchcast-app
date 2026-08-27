"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notFound } from "next/navigation";
import { probeStatic, newObservations, profileFor, type CaptureProfile } from "@/board/capabilities";
import type { TouchMode } from "@/board/ink";
import { newRoll, PAGE_W, PAGE_H, type PageBackground, type Tool } from "@/board/model";
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
        </aside>
      </div>

      <p className="mt-2 font-mono text-[11px] text-[#5B6470]">
        tier {profile.tier} · {strokes} strokes drawn · page {PAGE_W}×{PAGE_H}, letterboxed to fit ·
        touch draws by default: {profile.touchDrawsDefault ? "yes" : "no"}
        {pdf ? ` · pdf ${pdf}` : ""}
      </p>
    </main>
  );
}
