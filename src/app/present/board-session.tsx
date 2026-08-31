"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { newRoll, type PageBackground, type Tool } from "@/board/model";
import type { Rect } from "@/board/render";
import { RollView, type RollHandle } from "@/board/roll";
import { BoardStore, type LogRecord } from "@/board/store";
import { exportRoll, warmExport } from "@/board/export-pdf";
import { probeStatic, newObservations, profileFor } from "@/board/capabilities";
import type { TouchMode } from "@/board/ink";
import type { PickerGroup } from "@/utils/present/kit";
import { framePath, rollPdfPath } from "@/utils/present/paths";
import { Stage, type StageHandle, type StageMode } from "./stage";
import WrapUp from "./wrap-up";

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
//
// A FROZEN FRAME IS UPLOADED, AND THE PAGE STORES ITS PATH — not the object URL
// the capture produced. `URL.createObjectURL` is meaningless outside the tab
// that made it, so a page background holding one is a background that exists
// until the panel is closed and not one second longer: gone from a reload, gone
// from the PDF, gone from anything a student could ever open. The model already
// says `src` may be "a blob/object URL or a storage path" and holds no opinion
// about how a host fetches it, so the durable value goes straight in and this
// file resolves it — from the local capture while the lesson is running, from a
// signed URL afterwards.
//
// THE TOMBSTONES ARE SENT AT THE END, not as she presses undo. RollView's undo
// and redo are in-memory History operations and the log has no un-void record,
// so streaming each undo would leave the server holding a tombstone for a stroke
// she brought back. The final voided set is one authoritative statement and
// cannot disagree with itself.

const TOOLS: { key: Tool; label: string; color: string; width: number }[] = [
  { key: "pen", label: "Pen", color: "#14181F", width: 4 },
  { key: "highlighter", label: "Highlighter", color: "#F5D547", width: 26 },
  { key: "eraser", label: "Eraser", color: "#FFFFFF", width: 28 },
];

export type SessionInfo = {
  id: string;
  /** Every path this lesson writes begins with her uid — that is what the
   *  artifacts storage policy checks, and it is why the board can upload
   *  directly instead of streaming bytes through a route. */
  teacherId: string;
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

  // The lesson has three states, and the middle one is load-bearing: the board,
  // the seconds in which it is being saved, and the note.
  //
  // "ending" EXISTS BECAUSE THE WRAP-UP DRAFTS ON MOUNT. /api/present/recap
  // refuses a session that is still open — the evidence is not complete until
  // the lesson is — so showing the note panel the instant she taps End would ask
  // for a draft before the close had landed and answer 409 every time. The panel
  // appears once the close has actually happened.
  const [phase, setPhase] = useState<"board" | "ending" | "wrap">("board");
  const [rollSaved, setRollSaved] = useState<
    { ok: true; pages: number } | { ok: false; why: string } | null
  >(null);

  const db = useMemo(() => createClient(), []);
  /** Storage path -> the object URL captured in THIS tab. The fast path: a frame
   *  she just froze is already decoded, and going back to the network for it
   *  would blank the page she is about to write on. */
  const localFrames = useRef(new Map<string, string>());

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

  /** A background's `src` is either something a browser can load directly or a
   *  path in the artifacts bucket. Signed with her OWN session — the bucket
   *  policy lets a teacher read her own uid folder, so this needs no route. */
  const frameUrl = useCallback(
    async (src: string): Promise<string | null> => {
      const local = localFrames.current.get(src);
      if (local) return local;
      if (/^(?:blob:|data:|https?:)/i.test(src)) return src;
      const { data } = await db.storage.from("artifacts").createSignedUrl(src, 8 * 60 * 60);
      return data?.signedUrl ?? null;
    },
    [db],
  );

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
          // Cached BEFORE the source is resolved, because resolving may be a
          // round trip and this runs on every repaint — without the placeholder
          // a slow signature would start one request per frame.
          images.current.set(bg.src, el);
          void frameUrl(bg.src).then((u) => {
            if (u) el.src = u;
          });
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
    [frameUrl],
  );

  const playVideo = useCallback(() => {
    if (!unit?.video?.urls.length) return;
    setMode("full");
    void stage.current?.play();
    recordItem("video", unit.video.id, { chapterNum: session.chapterNum, part: unit.part });
  }, [unit, recordItem, session.chapterNum]);

  /** Pause, capture the frame, and land it on a NEW page of the roll.
   *
   *  The page carries the frame's STORAGE PATH, decided before the upload
   *  finishes. She must be able to write on it immediately — the whole gesture
   *  is "stop, and explain this" — so the capture is cached locally under that
   *  path and the network catches up in the background. If the upload fails the
   *  page still renders for the rest of the lesson and still reaches the PDF;
   *  only a reload would lose it, and the note says so. */
  const freeze = useCallback(async () => {
    const f = await stage.current?.freeze();
    if (!f) {
      setNote("Could not capture the frame.");
      return;
    }
    // addPage appends, so the page it is about to occupy is the current count.
    const path = framePath(session.teacherId, session.id, roll.pages.length);
    localFrames.current.set(path, f.url);
    board.current?.push({ kind: "frame", src: path, generationId: unit?.video?.id, t: f.t });
    setMode("corner");
    setNote(`Frozen at ${f.t.toFixed(1)}s — the frame is on the board`);

    void (async () => {
      try {
        const blob = await (await fetch(f.url)).blob();
        const { error } = await db.storage
          .from("artifacts")
          .upload(path, blob, { contentType: "image/jpeg", upsert: true });
        if (error) throw error;
      } catch {
        // Not worth interrupting a lesson for. The frame is on the board and in
        // the export; what it loses is surviving a reload.
        setNote("Frozen — but this frame could not be saved, so a reload would lose it.");
      }
    })();
  }, [unit, session.teacherId, session.id, roll, db]);

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

  /** Every page she pushes, with what sits under it. Without this the server
   *  holds strokes and no backgrounds, and a rebuilt roll is her annotations
   *  floating on blank paper — precisely the pages she cared about most. */
  const onPage = useCallback((index: number, background: PageBackground) => {
    void storeRef.current?.addPage(index, background);
  }, []);

  /** Turn a page background into bytes pdf-lib can embed.
   *
   *  The export module deliberately does not know how to fetch anything — a
   *  frozen frame is a blob the host captured — so this is where a page stops
   *  being a reference and starts being an image. Returning null leaves the page
   *  as paper, which is the right failure: a missing frame costs a background,
   *  never the ink drawn on top of it. */
  const exportOpts = useMemo(
    () => ({
      title: "Board",
      text: (bg: PageBackground) => (bg.kind === "question" ? bg.prompt : null),
      image: async (bg: PageBackground) => {
        if (bg.kind !== "frame") return null;
        try {
          const url = await frameUrl(bg.src);
          if (!url) return null;
          const res = await fetch(url);
          if (!res.ok) return null;
          const bytes = new Uint8Array(await res.arrayBuffer());
          // stage.freeze() captures JPEG. Sniffed rather than assumed, because
          // a PNG handed to embedJpg throws and takes the whole export with it.
          const png = bytes[0] === 0x89 && bytes[1] === 0x50;
          return { bytes, type: png ? ("png" as const) : ("jpg" as const) };
        } catch {
          return null;
        }
      },
    }),
    [frameUrl],
  );

  const exportPdf = useCallback(async () => {
    setNote("Building the PDF…");
    const bytes = await exportRoll(roll, exportOpts);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "board.pdf";
    a.click();
    URL.revokeObjectURL(url);
    setNote(`PDF ready — ${(bytes.length / 1024).toFixed(0)} KB, ${roll.pages.length} pages`);
  }, [roll, exportOpts]);

  /**
   * End the lesson: reconcile, export, upload, close.
   *
   * The order matters and each step is allowed to fail on its own. The CLOSE is
   * what moves the class's pointer and it is the one thing that must happen, so
   * it goes last and is not conditional on the export succeeding — a board whose
   * PDF failed to upload is still a lesson that was taught.
   */
  const end = useCallback(async () => {
    if (phase !== "board") return;
    setPhase("ending");
    const store = storeRef.current;

    // 1. Tombstones. The server has every stroke she drew, including the ones
    //    she undid — voidStroke is not called as she presses undo, because the
    //    log has no un-void record and a redo would then disagree with it. The
    //    final voided set is one statement that cannot contradict itself.
    try {
      for (const st of roll.strokes) if (st.voided) await store?.voidStroke(st.id);
      await store?.flush();
    } catch {
      /* the ink is already local; a failed mirror is not a failed lesson */
    }

    // 2. The roll as a file. Uploaded with her OWN session, straight to her own
    //    uid folder — the bucket policy is what authorises it, and the app has
    //    no precedent for pushing binaries through a route.
    try {
      const bytes = await exportRoll(roll, exportOpts);
      const path = rollPdfPath(session.teacherId, session.id);
      const { error } = await db.storage
        .from("artifacts")
        .upload(path, new Blob([bytes as BlobPart], { type: "application/pdf" }), {
          contentType: "application/pdf",
          upsert: true,
        });
      if (error) throw error;
      // The route records pdf_path only after confirming the object is there,
      // so the row can never point at a file that failed to arrive.
      const r = await fetch("/api/present/roll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id }),
      });
      if (!r.ok) throw new Error(`recording failed (${r.status})`);
      setRollSaved({ ok: true, pages: roll.pages.length });
    } catch (e) {
      setRollSaved({ ok: false, why: e instanceof Error ? e.message : "upload failed" });
    }

    // 3. Close. This is where the pointer moves, server-side, from what she
    //    actually showed — and it must land BEFORE the note panel opens, because
    //    drafting a recap for an open session is refused.
    //
    //    THE ONE STEP WHOSE RESULT IS CHECKED. Steps 1 and 2 are allowed to fail
    //    quietly; this one is not, because a close that did not happen leaves a
    //    lesson that can never be written up — the note panel would open on a
    //    session the recap route refuses, with no way back to the board. The
    //    route is idempotent by design precisely so this can be retried, and
    //    until now nothing retried it.
    const closed = await fetch("/api/present/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, pageCount: where.count }),
    })
      .then((r) => r.ok)
      .catch(() => false);

    if (!closed) {
      setPhase("board");
      setNote("Could not end the lesson — check the connection and tap End lesson again.");
      return;
    }

    setPhase("wrap");
  }, [phase, roll, exportOpts, session.teacherId, session.id, where.count, db]);

  const btn = "rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-sm text-[#C2CCC7]";
  // EVERY CONTROL, not just the End button. The export walks the live roll page
  // by page with an await per background, the tombstones have already been
  // reconciled, and `where.count` is captured in the closure — so a stroke, an
  // undo or a PUSH landing during those few seconds goes into the PDF
  // non-deterministically, produces no tombstone at all, or leaves page_count
  // one short. The board is finished; it should behave as if it is.
  const saving = phase === "ending";

  // The wrap-up REPLACES the board's chrome, but this component does not
  // unmount: the roll, the store and its flush-on-unmount effect all belong to
  // the same instance, so ending a lesson never races the last batch of ink out
  // of the door. The stage goes with the JSX, which is correct — the lesson is
  // over and a video element held open is a video element still buffering.
  if (phase === "wrap") {
    return (
      <div className="min-h-[70dvh]">
        <WrapUp sessionId={session.id} roll={rollSaved} onDone={onEnd} />
      </div>
    );
  }

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
            disabled={saving}
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
            disabled={saving}
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
          disabled={saving}
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
                    disabled={saving}
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
              disabled={saving}
              className={`rounded-lg border px-3 py-2 text-sm ${
                tool === t.key
                  ? "border-[#17544C] bg-[#12302C] text-[#4FD6C2]"
                  : "border-[#2A363B] bg-[#141B1F] text-[#C2CCC7]"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button type="button" className={btn} disabled={saving} onClick={() => board.current?.undo()}>
            Undo
          </button>
          <button type="button" className={btn} disabled={saving} onClick={() => board.current?.redo()}>
            Redo
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => setTouchMode((m) => (m === "draw" ? "scroll" : "draw"))}
          >
            Touch: {touchMode}
          </button>
          <button type="button" className={`${btn} ms-auto`} disabled={saving} onClick={exportPdf}>
            Export PDF
          </button>
          <button type="button" className={btn} disabled={phase !== "board"} onClick={end}>
            {phase === "ending" ? "Saving the board…" : "End lesson"}
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
          readOnly={saving}
          drawBackground={drawBackground}
          onStroke={onStroke}
          onPage={onPage}
          onPageChange={onPageChange}
          className="rounded-xl border border-[#222C30] overflow-hidden bg-white"
          style={{ height: "68dvh", minHeight: 320 }}
        />
        {note && <p className="font-mono text-[11px] text-[#4FD6C2]">{note}</p>}
      </div>

      <aside className="grid content-start gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => board.current?.push({ kind: "blank" })}
          className="rounded-lg bg-[#0C8175] px-3 py-4 text-sm font-medium text-white disabled:opacity-50"
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
