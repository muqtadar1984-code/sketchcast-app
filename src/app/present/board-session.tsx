"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newRoll, type PageBackground, type Tool } from "@/board/model";
import type { Rect } from "@/board/render";
import { RollView, type RollHandle } from "@/board/roll";
import { BoardStore, type LogRecord } from "@/board/store";
import { exportRoll, warmExport } from "@/board/export-pdf";
import { probeStatic, newObservations, profileFor } from "@/board/capabilities";
import type { TouchMode } from "@/board/ink";
import { Stage, type StageHandle, type StageMode } from "./stage";

// A lesson in progress: the bar's choice, the kit, the stage and the roll.
//
// FREEZING PUTS THE FRAME ON THE ROLL. That is the decision that makes the mock
// and the brief describe one feature rather than two: the frozen frame becomes a
// page background, she annotates it as part of the roll, and the live video
// parks in the corner still holding its position. Annotations therefore survive
// resume, reach the PDF, and reach a student who was absent — none of which is
// true of ink drawn on a transient overlay.

const TOOLS: { key: Tool; label: string; color: string; width: number }[] = [
  { key: "pen", label: "Pen", color: "#14181F", width: 4 },
  { key: "highlighter", label: "Highlighter", color: "#F5D547", width: 26 },
  { key: "eraser", label: "Eraser", color: "#FFFFFF", width: 28 },
];

export type SessionInfo = {
  id: string;
  bookId: string;
  chapterNum: number;
  part: number | null;
};

export type SessionKit = {
  video: { id: string; title: string | null; urls: string[] } | null;
  docs: { id: string; kind: string; label: string; projects: boolean; note?: string; download: string | null }[];
  picker: { group: string; items: { id: string; label: string }[] }[];
};

type Props = { session: SessionInfo; kit: SessionKit | null; onEnd: () => void };

export default function BoardSession({ session, kit, onEnd }: Props) {
  const roll = useMemo(() => newRoll(session.id), [session.id]);
  const profile = useMemo(() => profileFor(probeStatic(), newObservations()), []);
  const board = useRef<RollHandle | null>(null);
  const stage = useRef<StageHandle | null>(null);
  const storeRef = useRef<BoardStore | null>(null);

  const [tool, setTool] = useState<Tool>("pen");
  const [touchMode, setTouchMode] = useState<TouchMode>("draw");
  const [mode, setMode] = useState<StageMode>("away");
  const [where, setWhere] = useState({ page: 0, count: 1 });
  const [note, setNote] = useState<string | null>(null);
  const spec = TOOLS.find((t) => t.key === tool)!;

  // The store. Local first; the flush is a mirror, and a failure there is the
  // store's problem to retry rather than something the lesson notices.
  useEffect(() => {
    const s = new BoardStore(session.id, {
      flush: async (records: LogRecord[]) => {
        const r = await fetch("/api/present/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, records }),
        });
        if (!r.ok) throw new Error(`sync ${r.status}`);
      },
    });
    storeRef.current = s;
    void s.open();
    void warmExport(); // pay pdf-lib's import now, not at the bell
    return () => {
      void s.flush();
      s.close();
      storeRef.current = null;
    };
  }, [session.id]);

  /** Tell the server what she put in front of the class. Best-effort: a lost
   *  item costs the recap a little context, never the lesson. */
  const recordItem = useCallback(
    (kind: "video" | "worksheet", generationId: string | null, detail: Record<string, unknown>) => {
      void fetch("/api/present/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, items: [{ kind, generationId, detail }] }),
      }).catch(() => {});
    },
    [session.id],
  );

  // Frozen frames are images the renderer draws synchronously, so they have to
  // be decoded before it asks. Missing ones load and then trigger a repaint;
  // the cache means that happens once per frame rather than once per commit.
  const images = useRef(new Map<string, HTMLImageElement>());
  const drawBackground = useCallback(
    (ctx: CanvasRenderingContext2D, bg: PageBackground, page: Rect) => {
      if (bg.kind === "frame") {
        const img = images.current.get(bg.src);
        if (img?.complete && img.naturalWidth) {
          const s = Math.min(page.w / img.naturalWidth, page.h / img.naturalHeight);
          const w = img.naturalWidth * s;
          const h = img.naturalHeight * s;
          // Contain, never cover: the cropped part of a frame is often exactly
          // the part she is about to annotate.
          ctx.drawImage(img, (page.w - w) / 2, (page.h - h) / 2, w, h);
        } else if (!img) {
          const el = new Image();
          el.onload = () => board.current?.repaint();
          el.src = bg.src;
          images.current.set(bg.src, el);
        }
        return;
      }
      if (bg.kind === "question") {
        ctx.fillStyle = "#F1F5F3";
        ctx.fillRect(0, 0, page.w, 150);
        ctx.fillStyle = "#14181F";
        ctx.font = "44px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(bg.prompt.slice(0, 60), 40, 75);
      }
    },
    [],
  );

  const playVideo = useCallback(() => {
    if (!kit?.video?.urls.length) return;
    setMode("full");
    void stage.current?.play();
    recordItem("video", kit.video.id, {
      bookId: session.bookId,
      chapterNum: session.chapterNum,
      part: session.part,
    });
  }, [kit, recordItem, session]);

  /** Pause, capture the frame, and land it on a NEW page of the roll. */
  const freeze = useCallback(async () => {
    const f = await stage.current?.freeze();
    if (!f) {
      setNote("Could not capture the frame.");
      return;
    }
    board.current?.push({ kind: "frame", src: f.url, generationId: kit?.video?.id, t: f.t });
    setMode("corner");
    setNote(`Frozen at ${f.t.toFixed(1)}s — the frame is on the board`);
  }, [kit]);

  const resume = useCallback(() => {
    setMode("full");
    void stage.current?.play();
  }, []);

  const openWorksheet = useCallback(
    (id: string) => {
      board.current?.push({
        kind: "question",
        generationId: id,
        questionId: "q1",
        prompt: "Worksheet on the board",
      });
      setMode("away");
      recordItem("worksheet", id, {
        bookId: session.bookId,
        chapterNum: session.chapterNum,
        part: session.part,
      });
    },
    [recordItem, session],
  );

  const onStroke = useCallback((s: Parameters<NonNullable<Parameters<typeof RollView>[0]["onStroke"]>>[0]) => {
    void storeRef.current?.addStroke(s);
  }, []);

  const onPageChange = useCallback((page: number, count: number) => setWhere({ page, count }), []);

  const end = useCallback(async () => {
    const store = storeRef.current;
    await store?.flush();
    await fetch("/api/present/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, pageCount: where.count }),
    }).catch(() => {});
    onEnd();
  }, [session.id, where.count, onEnd]);

  const exportPdf = useCallback(async () => {
    setNote("Building the PDF…");
    const bytes = await exportRoll(roll, {
      title: "Board",
      text: (bg) => (bg.kind === "question" ? bg.prompt : null),
    });
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "board.pdf";
    a.click();
    URL.revokeObjectURL(url);
    setNote(`PDF ready — ${(bytes.length / 1024).toFixed(0)} KB, ${roll.pages.length} pages`);
  }, [roll]);

  const btn = "rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm text-[#C2CCC7]";

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[220px_1fr_96px]">
      <aside className="grid content-start gap-2">
        {kit?.video && (
          <button
            type="button"
            onClick={playVideo}
            className="rounded-xl border border-[#17544C] bg-[#12302C] px-3 py-3 text-start text-sm text-[#4FD6C2]"
          >
            ▶ Video
          </button>
        )}
        {mode === "corner" && (
          <button type="button" onClick={resume} className={btn}>
            Resume video
          </button>
        )}
        {kit?.docs.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => (d.projects ? openWorksheet(d.id) : d.download && window.open(d.download))}
            className={`rounded-xl border px-3 py-3 text-start text-sm ${
              d.projects
                ? "border-[#2A363B] bg-[#141B1F] text-[#E7EDE9]"
                : "border-[#2A363B] bg-[#0F1417] text-[#7C8A85]"
            }`}
          >
            {d.label}
            {d.note && (
              <span className="mt-0.5 block font-mono text-[10px] leading-snug text-[#5F6F69]">
                {d.note}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => board.current?.push({ kind: "blank" })}
          className={btn}
        >
          Blank board
        </button>
      </aside>

      <div className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTool(t.key)}
              className={`rounded-lg border px-3 py-2 text-sm ${
                tool === t.key
                  ? "border-[#17544C] bg-[#12302C] text-[#4FD6C2]"
                  : "border-[#2A363B] bg-[#141B1F] text-[#C2CCC7]"
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
          >
            Touch: {touchMode}
          </button>
          <button type="button" className={`${btn} ms-auto`} onClick={exportPdf}>
            Export PDF
          </button>
          <button type="button" className={btn} onClick={end}>
            End lesson
          </button>
        </div>

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
          className="rounded-xl border border-[#222C30] overflow-hidden bg-white"
          style={{ height: "68dvh", minHeight: 320 }}
        />
        {note && <p className="font-mono text-[11px] text-[#4FD6C2]">{note}</p>}
      </div>

      <aside className="grid content-start gap-2">
        <button
          type="button"
          onClick={() => board.current?.push({ kind: "blank" })}
          className="rounded-lg bg-[#0C8175] px-3 py-4 text-sm font-medium text-white"
        >
          PUSH
        </button>
        <button
          type="button"
          className={btn}
          disabled={where.page === 0}
          onClick={() => board.current?.goTo(where.page - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className={btn}
          disabled={where.page >= where.count - 1}
          onClick={() => board.current?.goTo(where.page + 1)}
        >
          ↓
        </button>
        <p className="text-center font-mono text-[11px] text-[#5F6F69]">
          {where.page + 1} / {where.count}
        </p>
      </aside>

      {/* Mounted for the whole lesson, whatever the mode. See stage.tsx. */}
      <Stage
        ref={stage}
        src={kit?.video?.urls[0] ?? null}
        mode={mode}
        onTapToFreeze={freeze}
        onEnded={() => setMode("corner")}
        onError={() => setNote("The video link expired — reopen the lesson to refresh it.")}
      />
    </div>
  );
}
