"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newRoll, type PageBackground, type Tool } from "@/board/model";
import type { Rect } from "@/board/render";
import { RollView, type RollHandle } from "@/board/roll";
import { BoardStore, type LogRecord } from "@/board/store";
import { exportRoll, warmExport } from "@/board/export-pdf";
import { probeStatic, newObservations, profileFor } from "@/board/capabilities";
import type { TouchMode } from "@/board/ink";
import type { PickerGroup } from "@/utils/present/kit";
import { Stage, type StageHandle, type StageMode } from "./stage";

// A lesson in progress: the bar's choice, the kit, the stage and the roll.
//
// FREEZING PUTS THE FRAME ON THE ROLL. That is the decision that makes the mock
// and the brief describe one feature rather than two: the frozen frame becomes a
// page background, she annotates it as part of the roll, and the live video
// parks in the corner still holding its position. Annotations therefore survive
// resume, reach the PDF, and reach a student who was absent — none of which is
// true of ink drawn on a transient overlay.
//
// THE UNIT IS CHOSEN HERE, NOT IN THE BAR. A chapter arrives as a list of units
// — its parts, or the whole chapter where it was never split — and she opens one
// while the lesson is running. Making her declare a part before starting would
// be a decision taken at the wrong moment: she often teaches the back half of
// part 2 and the front of part 3 in one period.
//
// WHAT SHE OPENS IS RECORDED WITH ITS OWN PLACE IN THE BOOK, never with the
// session's. A cumulative revision paper pulled onto the board during a Chapter
// 4 lesson belongs to no chapter, and stamping it with 4 would move the class's
// pointer on work that was revision.

const TOOLS: { key: Tool; label: string; color: string; width: number }[] = [
  { key: "pen", label: "Pen", color: "#14181F", width: 4 },
  { key: "highlighter", label: "Highlighter", color: "#F5D547", width: 26 },
  { key: "eraser", label: "Eraser", color: "#FFFFFF", width: 28 },
];

export type SessionInfo = {
  id: string;
  bookId: string;
  chapterNum: number;
};

export type KitDoc = {
  id: string;
  kind: string;
  label: string;
  projects: boolean;
  note?: string;
  title: string | null;
  download: string | null;
};

export type KitUnit = {
  /** null = a kit generated for the whole chapter rather than a part of it. */
  part: number | null;
  label: string;
  video: { id: string; title: string | null; urls: string[] } | null;
  docs: KitDoc[];
};

export type SessionKit = {
  units: KitUnit[];
  picker: {
    group: PickerGroup;
    items: { id: string; label: string; chapter: number | null; part: number | null }[];
  }[];
};

/** A stable key for a unit. `part` may legitimately be null, so the index is not
 *  usable as identity across a reload and null needs a name of its own. */
const unitKey = (u: { part: number | null }) => (u.part === null ? "whole" : `p${u.part}`);

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

  // Which unit is open. Held as the unit's own key rather than an index, and
  // DERIVED rather than synced: a kit that reloads with fewer units falls back
  // to the first one instead of pointing past the end, and no effect has to
  // reach in and correct the state afterwards.
  const units = useMemo(() => kit?.units ?? [], [kit]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const unit = units.find((u) => unitKey(u) === openKey) ?? units[0] ?? null;

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

  /** Tell the server what she put in front of the class, and WHERE IN THE BOOK
   *  it came from. Best-effort: a lost item costs the recap a little context,
   *  never the lesson. */
  const recordItem = useCallback(
    (
      kind: "video" | "worksheet",
      generationId: string | null,
      at: { chapterNum: number | null; part: number | null },
    ) => {
      void fetch("/api/present/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          items: [{ kind, generationId, detail: { bookId: session.bookId, ...at } }],
        }),
      }).catch(() => {});
    },
    [session.id, session.bookId],
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
    if (!unit?.video?.urls.length) return;
    setMode("full");
    void stage.current?.play();
    recordItem("video", unit.video.id, { chapterNum: session.chapterNum, part: unit.part });
  }, [unit, recordItem, session.chapterNum]);

  /** Pause, capture the frame, and land it on a NEW page of the roll. */
  const freeze = useCallback(async () => {
    const f = await stage.current?.freeze();
    if (!f) {
      setNote("Could not capture the frame.");
      return;
    }
    board.current?.push({ kind: "frame", src: f.url, generationId: unit?.video?.id, t: f.t });
    setMode("corner");
    setNote(`Frozen at ${f.t.toFixed(1)}s — the frame is on the board`);
  }, [unit]);

  const resume = useCallback(() => {
    setMode("full");
    void stage.current?.play();
  }, []);

  const openWorksheet = useCallback(
    (
      id: string,
      label: string,
      at: { chapterNum: number | null; part: number | null },
    ) => {
      board.current?.push({
        kind: "question",
        generationId: id,
        questionId: "q1",
        prompt: label,
      });
      setMode("away");
      recordItem("worksheet", id, at);
    },
    [recordItem],
  );

  /** Switching unit switches the video, which reloads it — correct here, because
   *  it is a DIFFERENT video, not the same one moving. The stage is parked while
   *  the new source loads so it does not flash a frame of the old part. */
  const openUnit = useCallback((key: string) => {
    setOpenKey(key);
    setMode("away");
    stage.current?.pause();
  }, []);

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
        {/* The chapter's units. Shown only when there is a choice to make. */}
        {units.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {units.map((u) => {
              const k = unitKey(u);
              const on = unit ? unitKey(unit) === k : false;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => openUnit(k)}
                  className={`rounded-lg border px-2 py-1.5 font-mono text-[11px] ${
                    on
                      ? "border-[#17544C] bg-[#12302C] text-[#4FD6C2]"
                      : "border-[#2A363B] bg-[#141B1F] text-[#93A09A]"
                  }`}
                >
                  {u.part === null ? "Whole" : `P${u.part}`}
                </button>
              );
            })}
          </div>
        )}

        {unit && (
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
            {unit.label}
          </p>
        )}

        {unit?.video && (
          <button
            type="button"
            onClick={playVideo}
            className="rounded-xl border border-[#17544C] bg-[#12302C] px-3 py-3 text-start text-sm text-[#4FD6C2]"
          >
            ▶ Video
            {unit.video.urls.length > 1 && (
              <span className="mt-0.5 block font-mono text-[10px] opacity-70">
                {unit.video.urls.length} parts — first one plays
              </span>
            )}
          </button>
        )}
        {mode === "corner" && (
          <button type="button" onClick={resume} className={btn}>
            Resume video
          </button>
        )}
        {unit?.docs.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() =>
              d.projects
                ? openWorksheet(d.id, d.label, {
                    chapterNum: session.chapterNum,
                    part: unit.part,
                  })
                : d.download && window.open(d.download)
            }
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

        {kit && !units.length && (
          <p className="text-sm text-[#93A09A]">Nothing generated for this chapter yet.</p>
        )}

        <button
          type="button"
          onClick={() => board.current?.push({ kind: "blank" })}
          className={btn}
        >
          Blank board
        </button>

        {/* Anything else in the book she may want mid-lesson — the other parts'
            worksheets, and the revision papers, which are the case the pointer
            rule exists for. Each one carries its OWN place in the book. */}
        {!!kit?.picker.length && (
          <>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
              Other worksheets
            </p>
            {kit.picker.map((g) => (
              <div key={g.group} className="grid gap-1">
                {g.items.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() =>
                      openWorksheet(i.id, i.label, { chapterNum: i.chapter, part: i.part })
                    }
                    className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-start text-sm text-[#C2CCC7]"
                  >
                    {i.label}
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
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
        src={unit?.video?.urls[0] ?? null}
        mode={mode}
        onTapToFreeze={freeze}
        onEnded={() => setMode("corner")}
        onError={() => setNote("The video link expired — reopen the lesson to refresh it.")}
      />
    </div>
  );
}
