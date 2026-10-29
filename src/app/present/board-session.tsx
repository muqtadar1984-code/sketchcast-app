"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { createClient } from "@/utils/supabase/client";
import { newRoll, type PageBackground, type Stroke, type Tool } from "@/board/model";
import { CHIP_MS, chipPosition, createDeckMapCache, payloadOf, selectionFromStroke, strokePointsBox, type DeckMapReply, type SkSelectionPayload } from "./highlight-select";
import type { Rect } from "@/board/render";
import { RollView, type RollHandle } from "@/board/roll";
import { BoardStore, type LogRecord } from "@/board/store";
import { exportRoll, warmExport } from "@/board/export-pdf";
import { probeStatic, newObservations, profileFor } from "@/board/capabilities";
import type { TouchMode } from "@/board/ink";
import type { PickerGroup, Scope } from "@/utils/present/kit";
import { fmt } from "@/i18n/format";
import { docLabel, docNote, groupLabel, scopeLabel, toolLabel, unitLabel, unitShort } from "./words";
import type { RailAction } from "./rail-state";
import type { PresentWords } from "./present-client";
import { framePath, rollPdfPath } from "@/utils/present/paths";
import { Stage, type StageHandle, type StageMode } from "./stage";
import WrapUp from "./wrap-up";
import {
  createBoardController,
  MemorySkActionSink,
  type BoardController,
  type BoardUnit,
  type QuestionSet,
  type SkActionSink,
} from "./board-controller";
import { answerKey, cardPng, drawCard, questionCards, type CardWords } from "./text-card";

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

const TOOLS: { key: Tool; color: string; width: number }[] = [
  { key: "pen", color: "#14181F", width: 4 },
  { key: "highlighter", color: "#F5D547", width: 26 },
  { key: "eraser", color: "#FFFFFF", width: 28 },
];

export type SessionInfo = {
  id: string;
  /** Every path this lesson writes begins with her uid — that is what the
   *  artifacts storage policy checks, and it is why the board can upload
   *  directly instead of streaming bytes through a route. */
  teacherId: string;
  /** Null for a READY-MADE KIT lesson (a catalogue kit copied into the
   *  library has no book and no chapter); then `kitId` names the kit. */
  bookId: string | null;
  chapterNum: number | null;
  kitId?: string | null;
};

export type KitDoc = {
  id: string;
  kind: string;
  projects: boolean;
  /** A reason, not a sentence — the UI renders it. `deck`: the slide deck's
   *  .pptx, downloadable only (Board UX 2026-10-28). */
  note?: "never-project" | "no-text" | "deck";
  title: string | null;
  download: string | null;
  /** Signed URL of the worksheet's questions.json, when the board may project it. */
  questions?: string | null;
};

export type KitUnit = {
  /** null = a kit generated for the whole chapter rather than a part of it. */
  part: number | null;
  total: number;
  video: { id: string; title: string | null; urls: string[] } | null;
  docs: KitDoc[];
};

export type SessionKit = {
  units: KitUnit[];
  picker: {
    group: PickerGroup;
    items: {
      id: string;
      scope: Scope;
      title: string | null;
      chapter: number | null;
      part: number | null;
    }[];
  }[];
};

/** A stable key for a unit. `part` may legitimately be null, so the index is not
 *  usable as identity across a reload and null needs a name of its own. */
const unitKey = (u: { part: number | null }) => (u.part === null ? "whole" : `p${u.part}`);

/**
 * Everything the board sends over the network, in one place so a host can swap
 * it. The default is exactly what the board always did; the SK dev harness
 * injects an in-memory version so driving the board from code writes nothing.
 */
export type BoardIO = {
  sync: (records: LogRecord[]) => Promise<void>;
  items: (items: { kind: string; generationId: string | null; detail: Record<string, unknown> }[]) => Promise<void>;
  signFrame: (path: string) => Promise<string | null>;
  upload: (path: string, blob: Blob, contentType: string) => Promise<void>;
  recordRoll: () => Promise<void>;
  /** Resolves true once the close landed. */
  close: (pageCount: number) => Promise<boolean>;
};

export function defaultIO(db: ReturnType<typeof createClient>, sessionId: string): BoardIO {
  return {
    sync: async (records) => {
      const r = await fetch("/api/present/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, records }),
      });
      if (!r.ok) throw new Error(`sync ${r.status}`);
    },
    items: async (items) => {
      await fetch("/api/present/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, items }),
      });
    },
    signFrame: async (src) => {
      const { data } = await db.storage.from("artifacts").createSignedUrl(src, 8 * 60 * 60);
      return data?.signedUrl ?? null;
    },
    upload: async (path, blob, contentType) => {
      const { error } = await db.storage.from("artifacts").upload(path, blob, { contentType, upsert: true });
      if (error) throw error;
    },
    recordRoll: async () => {
      // The route records pdf_path only after confirming the object is there,
      // so the row can never point at a file that failed to arrive.
      const r = await fetch("/api/present/roll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!r.ok) throw new Error(`recording failed (${r.status})`);
    },
    close: (pageCount) =>
      fetch("/api/present/session", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, pageCount }),
      })
        .then((r) => r.ok)
        .catch(() => false),
  };
}

type Props = {
  session: SessionInfo;
  kit: SessionKit | null;
  t: PresentWords;
  onEnd: () => void;
  /** Network seam; omitted on the real page. */
  io?: BoardIO;
  /** The Board driven from code (SK). Purely additive: no control changes. */
  controllerRef?: Ref<BoardController>;
  /** Where SK actions are recorded. Defaults to an in-memory buffer — never the network
   *  (the sk_actions table lands in S0). */
  skSink?: SkActionSink;
  /** S1 slice C (additive): told which unit is open, whenever that changes —
   *  the SK bridge loads the lesson map for it. Null until a unit has a video. */
  onUnit?: (unit: BoardUnit | null) => void;
  /** Board UX (2026-10-28): the unit rail as an overlay over the stage, opened
   *  from a handle on the left edge in every stage mode. The host owns the
   *  state (rail-state.ts) so SK's `rail` move and the handle agree. Without
   *  `onRail` there is no handle and no overlay — the Board as it was. */
  railOpen?: boolean;
  onRail?: (action: RailAction) => void;
  /** "Load slides as pages": present only when the lesson map is ready (the
   *  host runs it through the SK bridge, which owns the manifest). */
  onLoadSlides?: () => void;
  /** A line about the slides load in progress or just finished, already in
   *  her words. Null shows nothing. */
  slideStatus?: string | null;
  /** "Load the deck as pages" on the deck doc (founder 2026-10-28): the host
   *  fetches the rendered slides (asking the worker when they are missing)
   *  and calls the controller's loadDeck. Absent = the deck only downloads. */
  onLoadDeck?: (deckGenerationId: string) => void;
  /** "Highlight a portion and ask SK" (founder 2026-10-28), present only when
   *  the SK Shell is on: told the words under each highlighter stroke on a
   *  deck page (null when the highlight is dropped — a page turn). */
  onHighlight?: (selection: SkSelectionPayload | null) => void;
  /** The chip's click: ask SK to explain the highlighted part. */
  onAskSelection?: () => void;
};

/** The deck-pages GET, for the text map's signed URL. */
async function fetchDeckMapReply(generationId: string): Promise<DeckMapReply> {
  const r = await fetch(`/api/present/deck-pages?generationId=${encodeURIComponent(generationId)}`, { cache: "no-store" });
  if (!r.ok) return { status: "missing" };
  return (await r.json()) as DeckMapReply;
}
async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`map ${r.status}`);
  return r.json();
}

/** The open unit as the controller's `unit` port and `onUnit` report it. */
function boardUnitOf(u: KitUnit | null): BoardUnit | null {
  return u ? { generationId: u.video?.id ?? null, part: u.part, title: u.video?.title ?? null } : null;
}

export default function BoardSession({ session, kit, t, onEnd, io: ioProp, controllerRef, skSink, onUnit, railOpen = false, onRail, onLoadSlides, slideStatus = null, onLoadDeck, onHighlight, onAskSelection }: Props) {
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
  /** A seek is under way (SK): the stage says "Moving…" until its frame shows. */
  const [moving, setMoving] = useState(false);
  /** Question pages (SK): the answer key, in memory only, and which answers are showing. */
  const answers = useRef(new Map<string, string>());
  const revealedRef = useRef(new Set<string>());
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [answerKeys, setAnswerKeys] = useState<ReadonlySet<string>>(() => new Set());
  const cardWords = useMemo<CardWords>(
    () => ({
      questionOf: t.board.questionOf,
      marks: t.board.marks,
      answer: t.board.answer,
      answerTrue: t.board.answerTrue,
      answerFalse: t.board.answerFalse,
    }),
    [t],
  );
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
  const io = useMemo(() => ioProp ?? defaultIO(db, session.id), [ioProp, db, session.id]);
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
  // The host learns of the open unit by callback (S1 slice C) — the controller's
  // `unit` port answers the same question on demand. `unit` is derived from the
  // memoised units list, so this fires on a real switch, not on every render.
  useEffect(() => {
    onUnit?.(boardUnitOf(unit));
  }, [onUnit, unit]);

  // The store. Local first; the flush is a mirror, and a failure there is the
  // store's problem to retry rather than something the lesson notices.
  useEffect(() => {
    const s = new BoardStore(session.id, {
      flush: (records: LogRecord[]) => io.sync(records),
    });
    storeRef.current = s;
    void s.open();
    void warmExport(); // pay pdf-lib's import now, not at the bell
    return () => {
      void s.flush();
      s.close();
      storeRef.current = null;
    };
  }, [session.id, io]);

  /** Tell the server what she put in front of the class, and WHERE IN THE BOOK
   *  it came from. Best-effort: a lost item costs the recap a little context,
   *  never the lesson. */
  const recordItem = useCallback(
    (
      kind: "video" | "worksheet",
      generationId: string | null,
      at: { chapterNum: number | null; part: number | null },
    ) => {
      void io.items([{ kind, generationId, detail: { bookId: session.bookId, ...(session.kitId ? { kitId: session.kitId } : {}), ...at } }]).catch(() => {});
    },
    [io, session.bookId, session.kitId],
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
      return io.signFrame(src);
    },
    [io],
  );

  const drawBackground = useCallback(
    (ctx: CanvasRenderingContext2D, bg: PageBackground, page: Rect) => {
      // A deck slide is an image at a storage path exactly as a frozen frame
      // is: drawn contained, cached once, re-signed with her own session.
      if (bg.kind === "frame" || bg.kind === "deckPage") {
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
      if (bg.kind === "card") {
        const k = answerKey(bg.card.generationId, bg.card.questionId);
        drawCard(ctx, bg.card, page, cardWords, revealedRef.current.has(k) ? (answers.current.get(k) ?? null) : null);
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
    [frameUrl, cardWords],
  );

  const playVideo = useCallback(async () => {
    if (!unit?.video?.urls.length) return;
    setMode("full");
    const playing = stage.current?.play();
    recordItem("video", unit.video.id, { chapterNum: session.chapterNum, part: unit.part });
    await playing;
  }, [unit, recordItem, session.chapterNum]);

  /** Pause, capture the frame, and land it on a NEW page of the roll.
   *
   *  The page carries the frame's STORAGE PATH, decided before the upload
   *  finishes. She must be able to write on it immediately — the whole gesture
   *  is "stop, and explain this" — so the capture is cached locally under that
   *  path and the network catches up in the background. If the upload fails the
   *  page still renders for the rest of the lesson and still reaches the PDF;
   *  only a reload would lose it, and the note says so. */
  const freeze = useCallback(async (opts?: { replaceBlank?: boolean }): Promise<boolean> => {
    const f = await stage.current?.freeze();
    if (!f) {
      setNote(t.board.freezeFailed);
      return false;
    }
    // The slides load (Board UX 2026-10-28) lays its first frame ON a pristine
    // roll's blank first page, so slide 1 is page 1. Pristine = one page, still
    // paper, no live ink on it; anything else and the frame is appended.
    const pristine =
      !!opts?.replaceBlank &&
      roll.pages.length === 1 &&
      roll.pages[0].background.kind === "blank" &&
      !roll.strokes.some((st) => st.page === 0 && !st.voided);
    // addPage appends, so the page it is about to occupy is the current count —
    // a number no earlier freeze has used, because the count only grows. Path
    // 0 is never taken by an append (the roll starts with page 0), so the
    // pristine replacement uses it.
    const path = framePath(session.teacherId, session.id, pristine ? 0 : roll.pages.length);
    localFrames.current.set(path, f.url);
    const bg: PageBackground = { kind: "frame", src: path, generationId: unit?.video?.id, t: f.t };
    if (pristine) board.current?.replace(0, bg);
    else board.current?.push(bg);
    setMode("corner");
    setNote(fmt(t.board.frozen, { t: f.t.toFixed(1) }));

    void (async () => {
      try {
        const blob = await (await fetch(f.url)).blob();
        await io.upload(path, blob, "image/jpeg");
      } catch {
        // Not worth interrupting a lesson for. The frame is on the board and in
        // the export; what it loses is surviving a reload.
        setNote(t.board.frozenUnsaved);
      }
    })();
    return true;
  }, [unit, session.teacherId, session.id, roll, io, t]);

  const resume = useCallback(async () => {
    setMode("full");
    await stage.current?.play();
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

  // "Highlight a portion and ask SK" (founder 2026-10-28). A highlighter
  // stroke on a deck page → the words under it (highlight-select.ts) → the
  // host (SK's state) and a small chip by the stroke. The chip goes on the
  // next stroke, a page turn, or after 15 s; the highlight itself stays live
  // for SK's voice ("explain this") until the host's 60 s window closes or
  // the page turns. The deck's text map is fetched once per deck.
  const rollBox = useRef<HTMLDivElement | null>(null);
  const [chip, setChip] = useState<{ left: number; top: number } | null>(null);
  const chipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chipSeq = useRef(0);
  const [deckMaps] = useState(() => createDeckMapCache(fetchDeckMapReply, fetchJson));
  const hideChip = useCallback(() => {
    chipSeq.current++;
    if (chipTimer.current) clearTimeout(chipTimer.current);
    chipTimer.current = null;
    setChip(null);
  }, []);
  useEffect(() => () => {
    if (chipTimer.current) clearTimeout(chipTimer.current);
  }, []);

  const onStroke = useCallback(
    (s: Parameters<NonNullable<Parameters<typeof RollView>[0]["onStroke"]>>[0]) => {
      void storeRef.current?.addStroke(s);
      hideChip();
      if (!onAskSelection || s.tool !== "highlighter") return;
      const bg = roll.pages[s.page]?.background;
      if (bg?.kind !== "deckPage") return;
      const seq = chipSeq.current;
      void deckMaps.get(bg.generationId).then((map) => {
        if (seq !== chipSeq.current) return; // another stroke or a page turn since
        const sel = selectionFromStroke(s, { background: bg, map });
        const payload = sel ? payloadOf(sel, bg, map) : null;
        if (!payload) return;
        onHighlight?.(payload);
        const box = rollBox.current?.getBoundingClientRect();
        const r = strokePointsBox(s);
        if (!box || !r) return;
        setChip(chipPosition(r, { w: box.width, h: box.height }));
        chipTimer.current = setTimeout(() => {
          if (seq === chipSeq.current) setChip(null);
        }, CHIP_MS);
      });
    },
    [roll, deckMaps, hideChip, onAskSelection, onHighlight],
  );

  const lastPage = useRef(0);
  const onPageChange = useCallback(
    (page: number, count: number) => {
      setWhere({ page, count });
      if (page !== lastPage.current) {
        lastPage.current = page;
        hideChip();
        onHighlight?.(null);
      }
    },
    [hideChip, onHighlight],
  );

  /** A page inserted mid-roll renumbers the pages after it, and the ink on
   *  them with it (model.insertPage): re-recorded under each stroke's own seq
   *  so the log and the server follow the stroke to its new page. */
  const onStrokesMoved = useCallback((moved: Stroke[]) => {
    for (const st of moved) void storeRef.current?.moveStroke(st);
  }, []);

  /** A blank page right AFTER the page on screen (Board UX 2026-10-28): on
   *  page 3 of the slides it is the note between slides 3 and 4. */
  const blankAfterCurrent = useCallback(() => {
    board.current?.push({ kind: "blank" }, { after: where.page });
  }, [where.page]);

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
        if (bg.kind === "card") {
          // Pixels, not pdf-lib text: the export's font is WinAnsi-only and a
          // Hindi question would throw and take the whole PDF with it.
          const bytes = await cardPng(bg.card, cardWords).catch(() => null);
          return bytes ? { bytes, type: "png" as const } : null;
        }
        if (bg.kind !== "frame" && bg.kind !== "deckPage") return null;
        try {
          const url = await frameUrl(bg.src);
          if (!url) return null;
          const res = await fetch(url);
          if (!res.ok) return null;
          const bytes = new Uint8Array(await res.arrayBuffer());
          // stage.freeze() captures JPEG; deck slides are PNG. Sniffed rather than assumed, because
          // a PNG handed to embedJpg throws and takes the whole export with it.
          const png = bytes[0] === 0x89 && bytes[1] === 0x50;
          return { bytes, type: png ? ("png" as const) : ("jpg" as const) };
        } catch {
          return null;
        }
      },
    }),
    [frameUrl, cardWords],
  );

  const exportPdf = useCallback(async () => {
    setNote(t.board.buildingPdf);
    const bytes = await exportRoll(roll, exportOpts);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "board.pdf";
    a.click();
    URL.revokeObjectURL(url);
    setNote(fmt(t.board.pdfReady, { kb: (bytes.length / 1024).toFixed(0), pages: roll.pages.length }));
  }, [roll, exportOpts, t]);

  /**
   * End the lesson: reconcile, export, upload, close.
   *
   * The order matters and each step is allowed to fail on its own. The CLOSE is
   * what moves the class's pointer and it is the one thing that must happen, so
   * it goes last and is not conditional on the export succeeding — a board whose
   * PDF failed to upload is still a lesson that was taught.
   */
  const end = useCallback(async (): Promise<boolean> => {
    if (phase !== "board") return false;
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
      await io.upload(path, new Blob([bytes as BlobPart], { type: "application/pdf" }), "application/pdf");
      await io.recordRoll();
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
    const closed = await io.close(where.count);

    if (!closed) {
      setPhase("board");
      setNote(t.board.endFailed);
      return false;
    }

    setPhase("wrap");
    return true;
  }, [phase, roll, exportOpts, session.teacherId, session.id, where.count, io, t]);

  // -- The Board from code (SK spike M2) --------------------------------------
  // The ports call the SAME callbacks the buttons below call. They read the
  // latest render through a ref, so the controller is built once per session
  // and never goes stale. It exists whether or not a host asks for it; with no
  // controllerRef nothing calls it, and its default sink is a buffer in memory.
  const live = useRef({ playVideo, resume, freeze, openWorksheet, end, recordItem, unit, where, mode, session });
  useEffect(() => {
    live.current = { playVideo, resume, freeze, openWorksheet, end, recordItem, unit, where, mode, session };
  });
  const sink = useMemo(() => skSink ?? new MemorySkActionSink(), [skSink]);
  // Built in the commit phase (useImperativeHandle), never during render: the
  // ports read refs. The Board's own question buttons reach it through ctlRef.
  const ctlRef = useRef<BoardController | null>(null);
  useImperativeHandle(
    ctlRef,
    () =>
      createBoardController(
        {
          sessionId: () => live.current.session.id,
          actorId: () => live.current.session.teacherId,
          generationId: () => live.current.unit?.video?.id ?? null,
          video: () => stage.current?.element() ?? null,
          play: () => live.current.playVideo(),
          resume: () => live.current.resume(),
          pause: () => stage.current?.pause(),
          setStage: (m) => setMode(m),
          freeze: (o) => live.current.freeze(o),
          openWorksheetPage: () => {
            const { unit: u, session: s } = live.current;
            const d = u?.docs.find((x) => x.projects);
            if (!u || !d) return false;
            live.current.openWorksheet(d.id, docLabel(t, d.kind), { chapterNum: s.chapterNum, part: u.part });
            return true;
          },
          // No `after` = the append it always was; with one, an insert.
          blankPage: (o) => board.current?.push({ kind: "blank" }, o?.after !== undefined ? { after: o.after } : undefined),
          pushCard: (card) => board.current?.push({ kind: "card", card }),
          loadQuestions: async (): Promise<QuestionSet | null> => {
            const { unit: u, session: s } = live.current;
            const d = u?.docs.find((x) => x.projects && x.questions);
            if (!u || !d?.questions) return null;
            const r = await fetch(d.questions);
            if (!r.ok) throw new Error(`questions ${r.status}`);
            const { cards, answers: key } = questionCards(await r.json(), d.id, cardWords);
            for (const [k, v] of key) answers.current.set(k, v);
            setAnswerKeys(new Set(answers.current.keys()));
            // Logged as what it is in present_items' terms: a worksheet she put up.
            live.current.recordItem("worksheet", d.id, { chapterNum: s.chapterNum, part: u.part });
            return { generationId: d.id, cards };
          },
          goTo: (p) => board.current?.goTo(p),
          // Deck pages (founder 2026-10-28). A pristine roll — one blank page,
          // no live ink — takes slide 1 ON that page; otherwise the page goes
          // right after `after` (an append when that is the last page).
          putPage: (bg, o) => {
            const pristine =
              !!o.replaceBlank &&
              roll.pages.length === 1 &&
              roll.pages[0].background.kind === "blank" &&
              !roll.strokes.some((st) => st.page === 0 && !st.voided);
            if (pristine) {
              board.current?.replace(0, bg);
              return 0;
            }
            const len = roll.pages.length;
            const at = o.after !== undefined && Number.isInteger(o.after) && o.after < len - 1 ? Math.max(0, o.after) + 1 : len;
            board.current?.push(bg, o.after !== undefined ? { after: o.after } : undefined);
            return at;
          },
          findDeckPage: (n, g) => {
            const i = roll.pages.findIndex((p) => p.background.kind === "deckPage" && p.background.n === n && (!g || p.background.generationId === g));
            return i < 0 ? null : i;
          },
          // The roll's own count is current the moment push returns; `where`
          // follows a render later.
          where: () => ({
            page: live.current.where.page,
            count: Math.max(live.current.where.count, roll.pages.length),
          }),
          stageMode: () => live.current.mode,
          endSession: () => live.current.end(),
          unit: () => boardUnitOf(live.current.unit),
        },
        sink,
        { onMoving: setMoving },
      ),
    [sink, roll, t, cardWords],
  );
  // No deps: it follows ctlRef whenever that is rebuilt.
  useImperativeHandle(controllerRef, () => ctlRef.current as BoardController);

  // Escape closes the rail overlay, and only while it is open, so the key
  // stays free for everything else the rest of the time.
  useEffect(() => {
    if (!railOpen || !onRail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onRail("close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen, onRail]);

  /** The question card on the current page, if it is one. */
  const currentCard = (() => {
    const bg = roll.pages[where.page]?.background;
    return bg?.kind === "card" && bg.card.source === "question" ? bg.card : null;
  })();
  const currentKey = currentCard ? answerKey(currentCard.generationId, currentCard.questionId) : null;
  const toggleAnswer = useCallback(() => {
    if (!currentKey) return;
    const next = new Set(revealedRef.current);
    if (next.has(currentKey)) next.delete(currentKey);
    else next.add(currentKey);
    revealedRef.current = next;
    setRevealed(next);
    board.current?.repaint();
  }, [currentKey]);

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
        <WrapUp sessionId={session.id} roll={rollSaved} t={t} onDone={onEnd} />
      </div>
    );
  }

  /** A choice from the rail closes the overlay (rail-state "pick"); in the
   *  column beside the board it is a no-op. */
  const pick = () => onRail?.("pick");

  /** The rail's contents: the column beside the board AND the overlay the
   *  left-edge handle opens (Board UX 2026-10-28). One list, so the two can
   *  never offer different things. */
  const railBody = () => (
    <>
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
                onClick={() => {
                  openUnit(k);
                  pick();
                }}
                className={`rounded-lg border px-2 py-1.5 font-mono text-[11px] ${
                  on
                    ? "border-[#17544C] bg-[#12302C] text-[#4FD6C2]"
                    : "border-[#2A363B] bg-[#141B1F] text-[#93A09A]"
                }`}
              >
                {unitShort(t, u)}
              </button>
            );
          })}
        </div>
      )}

      {unit && (
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
          {unitLabel(t, unit)}
        </p>
      )}

      {unit?.video && (
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            pick();
            void playVideo();
          }}
          className="rounded-xl border border-[#17544C] bg-[#12302C] px-3 py-3 text-start text-sm text-[#4FD6C2]"
        >
          ▶ {t.doc.presentation}
          {unit.video.urls.length > 1 && (
            <span className="mt-0.5 block font-mono text-[10px] opacity-70">
              {fmt(t.kit.videoPartsFirst, { n: unit.video.urls.length })}
            </span>
          )}
        </button>
      )}
      {mode === "corner" && (
        <button
          type="button"
          onClick={() => {
            pick();
            void resume();
          }}
          className={btn}
        >
          {t.board.resumeVideo}
        </button>
      )}
      {/* Every slide of the lesson onto the roll, one page each: the video's
          own finished frames (Board UX 2026-10-28). Only when the lesson map
          is ready; the host passes the action then and not before. */}
      {unit?.video && onLoadSlides && (
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            pick();
            onLoadSlides();
          }}
          className={`${btn} text-start`}
          data-board="load-slides"
        >
          ▤ {t.bar.loadSlides}
        </button>
      )}
      {unit?.docs.map((d) => {
        const why = docNote(t, d.note);
        return (
          <button
            key={d.id}
            type="button"
            disabled={saving}
            onClick={() => {
              pick();
              if (d.projects) {
                openWorksheet(d.id, docLabel(t, d.kind), {
                  chapterNum: session.chapterNum,
                  part: unit.part,
                });
              } else if (d.download) {
                window.open(d.download);
              }
            }}
            className={`rounded-xl border px-3 py-3 text-start text-sm ${
              d.projects
                ? "border-[#2A363B] bg-[#141B1F] text-[#E7EDE9]"
                : "border-[#2A363B] bg-[#0F1417] text-[#7C8A85]"
            }`}
            data-board-doc={d.kind}
          >
            {/* The deck downloads from here; its pages load from the button below. */}
            {d.note === "deck" ? "⤓ " : ""}
            {docLabel(t, d.kind)}
            {why && (
              <span className="mt-0.5 block font-mono text-[10px] leading-snug text-[#5F6F69]">
                {why}
              </span>
            )}
          </button>
        );
      })}
      {/* The kit's .pptx as pages, one slide each (founder 2026-10-28). The
          host renders it on demand, so the first press may take ~30 s; the
          status line under the roll says so. */}
      {onLoadDeck &&
        unit?.docs
          .filter((d) => d.note === "deck")
          .map((d) => (
            <button
              key={`load-${d.id}`}
              type="button"
              disabled={saving}
              onClick={() => {
                pick();
                onLoadDeck(d.id);
              }}
              className={`${btn} text-start`}
              data-board="load-deck"
            >
              ▤ {t.bar.loadDeck}
            </button>
          ))}

      {kit && !units.length && (
        <p className="text-sm text-[#93A09A]">{t.kit.empty}</p>
      )}

      {/* AFTER THE PAGE ON SCREEN (Board UX 2026-10-28), not at the end: on a
          roll of slide pages this is the note between two slides. On the last
          page it is the append it always was, and PUSH still appends. */}
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          pick();
          blankAfterCurrent();
        }}
        className={btn}
      >
        {t.board.blank}
      </button>

      {/* Anything else in the book she may want mid-lesson: the other parts'
          worksheets, and the revision papers, which are the case the pointer
          rule exists for. Each one carries its OWN place in the book. */}
      {!!kit?.picker.length && (
        <>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">
            {t.kit.otherWorksheets}
          </p>
          {kit.picker.map((g) => (
            <div key={g.group} className="grid gap-1">
              <p className="font-mono text-[10px] text-[#5F6F69]">{groupLabel(t, g.group)}</p>
              {g.items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    pick();
                    openWorksheet(i.id, scopeLabel(t, i.scope, i.title), {
                      chapterNum: i.chapter,
                      part: i.part,
                    });
                  }}
                  className="rounded-lg border border-[#2A363B] bg-[#141B1F] px-3 py-2 text-start text-sm text-[#C2CCC7]"
                >
                  {scopeLabel(t, i.scope, i.title)}
                </button>
              ))}
            </div>
          ))}
        </>
      )}
    </>
  );

  return (
    // ps-10 when there is a rail handle: the handle sits on the left edge in
    // every mode and must not cover the column's buttons.
    <div className={`grid gap-3 p-3 lg:grid-cols-[220px_1fr_96px] ${onRail ? "ps-10" : ""}`}>
      <aside className="grid content-start gap-2">{railBody()}</aside>

      <div className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          {TOOLS.map((tool2) => (
            <button
              key={tool2.key}
              type="button"
              onClick={() => setTool(tool2.key)}
              disabled={saving}
              className={`rounded-lg border px-3 py-2 text-sm ${
                tool === tool2.key
                  ? "border-[#17544C] bg-[#12302C] text-[#4FD6C2]"
                  : "border-[#2A363B] bg-[#141B1F] text-[#C2CCC7]"
              }`}
            >
              {toolLabel(t, tool2.key)}
            </button>
          ))}
          <button type="button" className={btn} disabled={saving} onClick={() => board.current?.undo()}>
            {t.board.undo}
          </button>
          <button type="button" className={btn} disabled={saving} onClick={() => board.current?.redo()}>
            {t.board.redo}
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => setTouchMode((m) => (m === "draw" ? "scroll" : "draw"))}
          >
            {touchMode === "draw" ? t.board.touchDraw : t.board.touchScroll}
          </button>
          <button type="button" className={`${btn} ms-auto`} disabled={saving} onClick={exportPdf}>
            {t.board.exportPdf}
          </button>
          <button type="button" className={btn} disabled={phase !== "board"} onClick={end}>
            {phase === "ending" ? t.board.ending : t.board.endLesson}
          </button>
        </div>

        <div ref={rollBox} className="relative">
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
          onStrokesMoved={onStrokesMoved}
          onPageChange={onPageChange}
          className="rounded-xl border border-[#222C30] overflow-hidden bg-white"
          style={{ height: "68dvh", minHeight: 320 }}
        />
        {chip && onAskSelection && (
          <button
            type="button"
            data-board="ask-sk"
            onClick={() => {
              hideChip();
              onAskSelection();
            }}
            className="absolute z-10 rounded-full bg-[#0C8175] px-3 py-1.5 text-sm font-medium text-white shadow-lg"
            style={{ left: chip.left, top: chip.top }}
          >
            {t.board.askAboutThis}
          </button>
        )}
        </div>
        {note && <p className="font-mono text-[11px] text-[#4FD6C2]">{note}</p>}
        {slideStatus && (
          <p role="status" className="font-mono text-[11px] text-[#4FD6C2]" data-board="slide-status">
            {slideStatus}
          </p>
        )}
        {moving && mode === "away" && (
          <p role="status" className="font-mono text-[11px] text-[#4FD6C2]">
            {t.board.moving}
          </p>
        )}
      </div>

      <aside className="grid content-start gap-2">
        {/* The big one, beside the page arrows. It was labelled "PUSH" — the
            roll metaphor, pushing the paper up for fresh space — and eight of
            the nine translators read it as "send" because nothing on the button
            says which. It appends a blank page, so it now says so.
            ⚠️ "Blank board" in the left rail calls exactly this, with the same
            argument. Two controls, one behaviour; one of them should go, and
            which is a product call rather than a translation one. */}
        <button
          type="button"
          disabled={saving}
          onClick={() => board.current?.push({ kind: "blank" })}
          className="rounded-lg bg-[#0C8175] px-3 py-4 text-sm font-medium text-white disabled:opacity-50"
        >
          {t.board.push}
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
          {fmt(t.board.pageOf, { n: where.page + 1, total: where.count })}
        </p>
        {/* Only on a question page, which only SK puts up. */}
        {currentCard && (
          <>
            <button
              type="button"
              className={btn}
              disabled={saving || (currentCard.index ?? 0) <= 0}
              aria-label={t.board.prevQuestion}
              title={t.board.prevQuestion}
              onClick={() => void ctlRef.current?.prevQuestion().catch(() => {})}
            >
              ‹
            </button>
            <button
              type="button"
              className={btn}
              disabled={saving || (currentCard.index ?? 0) >= (currentCard.total ?? 1) - 1}
              aria-label={t.board.nextQuestion}
              title={t.board.nextQuestion}
              onClick={() => void ctlRef.current?.nextQuestion().catch(() => {})}
            >
              ›
            </button>
            {currentKey && answerKeys.has(currentKey) && (
              <button type="button" className={btn} disabled={saving} onClick={toggleAnswer}>
                {revealed.has(currentKey) ? t.board.hideAnswer : t.board.showAnswer}
              </button>
            )}
          </>
        )}
      </aside>

      {/* Mounted for the whole lesson, whatever the mode. See stage.tsx. */}
      <Stage
        ref={stage}
        src={unit?.video?.urls[0] ?? null}
        mode={mode}
        status={moving ? t.board.moving : null}
        onTapToFreeze={freeze}
        onEnded={() => setMode("corner")}
        onError={() => setNote(t.board.videoExpired)}
      />

      {/* THE RAIL, REACHABLE IN EVERY MODE (Board UX 2026-10-28, founder:
          "full-screen video hides the left column"). The handle sits above the
          stage (z 30) and below the SK launcher (z 40), so neither the video
          nor the overlay ever hides SK. */}
      {onRail && (
        <button
          type="button"
          onClick={() => onRail("toggle")}
          aria-expanded={railOpen}
          data-board="rail-handle"
          className="fixed start-0 top-1/2 z-[35] -translate-y-1/2 rounded-e-lg border border-s-0 border-[#17544C] bg-[#12302C] px-1.5 py-3 font-mono text-[11px] text-[#4FD6C2] shadow-lg [writing-mode:vertical-rl]"
        >
          {t.board.railHandle} <span className="rtl-flip inline-block">▸</span>
        </button>
      )}
      {onRail && railOpen && (
        <div className="fixed inset-0 z-[36]" role="dialog" aria-modal="true" aria-label={t.board.railHandle} data-board="rail-overlay">
          <button type="button" aria-label={t.board.railClose} className="absolute inset-0 cursor-default bg-black/50" onClick={() => onRail("close")} />
          {/* pb-24: the SK launcher sits bottom-start, above this panel. */}
          <aside className="absolute inset-y-0 start-0 grid w-[min(300px,85vw)] content-start gap-2 overflow-y-auto border-e border-[#222C30] bg-[#0F1417] p-3 pb-24 text-[#E7EDE9] shadow-2xl">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#5F6F69]">{t.board.railHandle}</p>
              <button type="button" className={btn} onClick={() => onRail("close")}>
                {t.board.railClose}
              </button>
            </div>
            {railBody()}
          </aside>
        </div>
      )}
    </div>
  );
}
