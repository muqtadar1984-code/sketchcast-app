// The Board, callable from code — spike M2 of the SK assistant plan.
//
// WHY A PORT OBJECT AND NOT THE COMPONENT ITSELF. Every move here is one the
// Board already makes from a button; the controller adds no behaviour of its
// own beyond waiting for the browser to finish a seek and keeping its place in a
// question set. BoardSession hands it ports that call the SAME callbacks its
// buttons call (playVideo, resume, freeze, openWorksheet, push, goTo, end), so a
// move made by voice and a move made by a finger are one code path.
//
// EVERY MOVE IS RECORDED AS AN `sk_actions` ROW — and goes NOWHERE ON THE
// NETWORK YET. The audit table (§2.5 of the plan) lands in S0 with its
// migration; until then the sink is an in-memory buffer. `present_items` is NOT
// a destination: it feeds the recap and the class pointer, and its kinds
// (video | worksheet | blank) are unchanged by this spike. A sink that throws
// never fails the move it was recording.
//
// THE SEEK RESOLVES ON THE DISPLAYED FRAME, NOT ON ASSIGNMENT. Setting
// currentTime starts an asynchronous seek; `seeked` says the element has a
// position, and requestVideoFrameCallback says a frame for it reached the
// screen. `state.moving` is true across the whole of that, so the Board can say
// "Moving…" on a slow network instead of looking frozen.

import type { StageMode } from "./stage";
import type { PageBackground, TextCard } from "@/board/model";
import { deckPageOf, type DeckSlideRef } from "./deck-load";

/** The parts of an HTMLVideoElement the controller touches. A fake in tests. */
export type VideoLike = {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  addEventListener(type: "seeked" | "error", fn: () => void): void;
  removeEventListener(type: "seeked" | "error", fn: () => void): void;
  requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number;
};

// ── the manifest contract (M1) ────────────────────────────────────────────────

export type VisualVerdict = {
  status: "distinct" | "reused_relevant" | "misleading" | "unknown";
  show: "frame" | "fallback_frame" | "caption_only";
  fallback_k?: number;
  reason: string;
};

/** One script segment of the kit's video, in seconds from the start. */
export type ManifestSegment = {
  start_s: number;
  end_s: number;
  /** The completed-slide frame. Falls back to end_s minus a small backoff. */
  slide_t?: number;
  heading?: string;
  points?: string[];
  /** Absent = "unknown": the frame is not shown. */
  visual?: VisualVerdict;
};
export type BoardManifest = { segments: ManifestSegment[] };

// ── the audit record (planned `sk_actions` table) ────────────────────────────

export type SkActionName =
  | "board.play"
  | "board.resume"
  | "board.pause"
  | "board.seek"
  | "board.seek_segment"
  | "board.slide"
  | "board.freeze"
  | "board.worksheet_page"
  | "board.blank_page"
  | "board.page_up"
  | "board.page_down"
  | "board.show_questions"
  | "board.next_question"
  | "board.prev_question"
  | "board.end_session"
  /** Board UX (2026-10-28): every slide onto the roll as pages — ONE row for
   *  the whole load (params count/from/to), not one per frame. */
  | "board.load_slides"
  /** The kit's .pptx as pages (founder 2026-10-28): ONE row for the whole
   *  load (params generationId/count/from/to), not one per slide. */
  | "board.load_deck"
  /** Wind to a deck page already on the roll ("skip to the PowerPoint"). */
  | "board.deck_page";

/** One row of the planned `sk_actions` audit table. */
export type SkActionRecord = {
  actor_id: string | null;
  action: SkActionName;
  /** §2.5: every Board move is reversible and safe. */
  tier: "immediate";
  kind: "board";
  params: Record<string, unknown>;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  session_id: string;
  generation_id: string | null;
  /** ISO timestamp of the request. */
  at: string;
  /** Duration, ms. */
  ms: number;
};

export interface SkActionSink {
  record(r: SkActionRecord): void | Promise<void>;
}

/** The only sink today: a buffer in the tab. NO network — the sk_actions
 *  migration lands in S0 and needs the founder's yes. */
export class MemorySkActionSink implements SkActionSink {
  readonly records: SkActionRecord[] = [];
  record(r: SkActionRecord): void {
    this.records.push(r);
  }
}

// ── ports ────────────────────────────────────────────────────────────────────

export type QuestionSet = { generationId: string; cards: TextCard[] };

/** The open unit, as the SK bridge needs it (S1 slice C): which video the
 *  lesson map is for, which part of the chapter, and its title for the record. */
export type BoardUnit = { generationId: string | null; part: number | null; title: string | null };

/** What BoardSession gives the controller. Each port is a callback a Board
 *  button already uses. */
export type BoardPorts = {
  sessionId: () => string;
  actorId: () => string | null;
  /** The video generation of the open unit — what most moves are about. */
  generationId: () => string | null;
  video: () => VideoLike | null;
  /** The ▶ button: stage to full, play, RECORD the video item. */
  play: () => Promise<void>;
  /** The Resume button: stage to full, play, record NOTHING. */
  resume: () => Promise<void>;
  pause: () => void;
  setStage: (mode: StageMode) => void;
  /** Tap-to-freeze: pause, capture, push a frame page. False when nothing was captured.
   *  `replaceBlank` (the slides load): a pristine roll — one blank page, no
   *  ink — takes the frame ON that page, so the first slide is page 1. */
  freeze: (opts?: { replaceBlank?: boolean }) => Promise<boolean>;
  /** Open the current unit's first projectable worksheet. False when there is none. */
  openWorksheetPage: () => boolean;
  /** Append a blank page; with `after`, insert it right after that page. */
  blankPage: (opts?: { after?: number }) => void;
  /** Append a text page and wind to it. */
  pushCard: (card: TextCard) => void;
  /** The open unit's first worksheet that carries questions.json, as cards. */
  loadQuestions: () => Promise<QuestionSet | null>;
  goTo: (page: number) => void;
  /** Page index and count, as the page arrows see them. */
  where: () => { page: number; count: number };
  stageMode: () => StageMode;
  /** End lesson. Resolves true once the close landed. */
  endSession: () => Promise<boolean>;
  /** S1 slice C (additive): the open unit — null before a lesson has one. A
   *  port rather than a field because BoardSession switches units mid-lesson. */
  unit?: () => BoardUnit | null;
  /** Deck pages (founder 2026-10-28, additive): put a page with this
   *  background on the roll — inserted right after `after` (appended when that
   *  is the last page), or ON a pristine roll's blank first page with
   *  `replaceBlank`. Returns the roll index it landed on. */
  putPage?: (background: PageBackground, opts: { after?: number; replaceBlank?: boolean }) => number;
  /** The roll index of slide n of a deck on the roll (any deck when no
   *  generation is named), or null when there is none. */
  findDeckPage?: (n: number, generationId?: string) => number | null;
};

export type BoardState = {
  sessionId: string;
  t: number;
  duration: number;
  paused: boolean;
  /** True from a seek's start until its frame is on screen (or gave up waiting). */
  moving: boolean;
  stageMode: StageMode;
  page: number;
  pageCount: number;
  ended: boolean;
  /** Where the question set stands, when one is open. */
  questions: { generationId: string; index: number; total: number } | null;
  /** Every action made through the controller, in order. */
  actions: SkActionRecord[];
};

export type SeekResult = {
  target: number;
  /** currentTime at `seeked`. */
  landed: number;
  errorMs: number;
  /** Request → `seeked`. */
  latencyMs: number;
  /** requestVideoFrameCallback's mediaTime for the first frame shown; null if it never fired. */
  presentedMediaTime: number | null;
  frameErrorMs: number | null;
  /** Request → displayed frame. */
  frameLatencyMs: number | null;
};

export type SlideResult = {
  shown: "frame" | "fallback_frame" | "caption";
  /** The segment whose frame or caption is on screen. */
  shownK: number;
  reason: string;
  seek?: SeekResult;
};

export type BoardController = {
  /** The ▶ button: records a `video` item, like the button. */
  play(): Promise<void>;
  /** The Resume button: no item. */
  resume(): Promise<void>;
  pause(): void;
  /** Resolves once the frame is displayed, with the landed currentTime. */
  seek(t: number): Promise<number>;
  /** Same as seek, with the measurement attached. */
  seekMeasured(t: number): Promise<SeekResult>;
  /** Seek to a segment's start, or to its completed end frame. */
  seekSegment(k: number, edge: "start" | "end", manifest: BoardManifest): Promise<SeekResult>;
  /** Show slide k as the manifest's visual verdict allows: its frame, a fallback frame, or a caption card. */
  slide(k: number, manifest: BoardManifest): Promise<SlideResult>;
  freeze(): Promise<boolean>;
  openWorksheetPage(): boolean;
  /** Append a blank page — or, with `after` (Board UX 2026-10-28), insert one
   *  right after that page so a note between two slides stays between them. */
  blankPage(opts?: { after?: number }): void;
  /**
   * Board UX (2026-10-28, founder): every slide of the lesson onto the roll as
   * pages, in order — seek to each segment's completed frame (slide_t, else
   * end_s − backoff), wait for it to be DISPLAYED, freeze it, next. One audit
   * row for the whole load. Abortable (`cancelLoad`, or `opts.signal`): pages
   * already made stay. Additive and optional, so an older host or a fake
   * controller need not carry it.
   */
  loadSlides?(manifest: BoardManifest, opts?: LoadSlidesOptions): Promise<LoadSlidesResult>;
  /** Stop a running loadSlides after the frame in hand. No-op when none runs. */
  cancelLoad?(): void;
  /**
   * The kit's .pptx as pages (founder 2026-10-28: "each slide as 1 page"): one
   * `deckPage` per rendered slide, in order — ON a pristine roll's blank first
   * page, else right after the page on screen (so a deck loaded mid-lesson
   * sits where she is, and a blank page added between two slides later stays
   * between them). ONE audit row `board.load_deck`. Abortable (`cancelLoad`
   * or `signal`): pages already made stay. Lands on the first new page, stage
   * away. Additive and optional, like loadSlides.
   */
  loadDeck?(req: LoadDeckRequest): Promise<LoadSlidesResult>;
  /** Wind to slide n (default 1) of a deck already on the roll; throws when
   *  there is none. Audited `board.deck_page`. */
  goToDeckPage?(n?: number, generationId?: string): number;
  /** Where slide n of a deck sits on the roll, or null. A read: not audited. */
  findDeckPage?(n?: number, generationId?: string): number | null;
  pageUp(): void;
  pageDown(): void;
  /** Put the unit's real questions on the board, one page per question.
   *  With `count` (S1 slice C) only that WINDOW of the set is open:
   *  next/prev stay within [start, start+count) and the result also says how
   *  many are in the window (`shown`) out of the set (`of`). Without `count`
   *  the whole set is open from `start`, as in M2. */
  showQuestions(start?: number, count?: number): Promise<QuestionsShown>;
  nextQuestion(): Promise<{ index: number; total: number }>;
  prevQuestion(): Promise<{ index: number; total: number }>;
  getState(): BoardState;
  endSession(): Promise<boolean>;
  /** S1 slice C: the open unit, from BoardSession's `unit` port; null when the
   *  host gave no port or no unit is open. */
  getUnit(): BoardUnit | null;
};

/** `shown`/`of` are present only when a window (`count`) was asked for. */
export type QuestionsShown = { index: number; total: number; shown?: number; of?: number };

export type LoadSlidesOptions = {
  /** First and last segment index to load (inclusive); the whole manifest by default. */
  from?: number;
  to?: number;
  /** After each page lands: k is 1-based within the load, n its size. */
  onProgress?: (k: number, n: number) => void;
  signal?: AbortSignal;
};

export type LoadDeckRequest = {
  /** The deck generation the slides were rendered from. */
  generationId: string;
  /** /api/present/deck-pages' slides, in order. */
  slides: Pick<DeckSlideRef, "n" | "path" | "w" | "h" | "title">[];
  /** The deck's text map by storage path, for every page to keep. */
  map?: string | null;
  /** First and last index into `slides` (inclusive); all of them by default. */
  from?: number;
  to?: number;
  onProgress?: (k: number, n: number) => void;
  signal?: AbortSignal;
};

export type LoadSlidesResult = {
  /** Pages made by this load. */
  pages: number;
  /** Roll indices (0-based) of the first and last page made; -1 when none. */
  firstPage: number;
  lastPage: number;
  /** True when the loop was cancelled before the last slide. */
  aborted: boolean;
};

export type ControllerOptions = {
  now?: () => number;
  /** A seek that has not reached `seeked` by then rejects. */
  seekTimeoutMs?: number;
  /** How long to wait for the displayed frame after `seeked` before giving up (not failing). */
  frameTimeoutMs?: number;
  /**
   * How far before a segment's end the "end" edge aims when the manifest has no
   * slide_t. The worker cuts a keyframe at each boundary, so end_s itself is the
   * FIRST frame of the next segment; the completed slide is the frame before.
   */
  endBackoffS?: number;
  /**
   * How far after start_s the "start" edge aims. Measured on a real kit: each
   * segment's keyframe sits 6-26 ms AFTER its start_s (the stream's first pts is
   * 0.023 s), so start_s itself still shows the previous segment's last frame.
   */
  startNudgeS?: number;
  /** Called whenever `moving` flips — the Board's "Moving…" indicator. */
  onMoving?: (moving: boolean) => void;
};

export function segmentTarget(
  manifest: BoardManifest,
  k: number,
  edge: "start" | "end",
  endBackoffS = 0.1,
  startNudgeS = 0.03,
): number {
  const seg = manifest.segments[k];
  if (!seg) throw new RangeError(`no segment ${k} (manifest has ${manifest.segments.length})`);
  if (edge === "start") return Math.min(seg.end_s, seg.start_s + startNudgeS);
  return Math.max(seg.start_s, seg.end_s - endBackoffS);
}

/** Where slide k's frame is: the manifest's own slide_t, else the end edge. */
export function slideTime(manifest: BoardManifest, k: number, endBackoffS = 0.1): number {
  const seg = manifest.segments[k];
  if (!seg) throw new RangeError(`no segment ${k} (manifest has ${manifest.segments.length})`);
  return typeof seg.slide_t === "number" ? seg.slide_t : segmentTarget(manifest, k, "end", endBackoffS);
}

const UNKNOWN: VisualVerdict = { status: "unknown", show: "caption_only", reason: "no visual verdict in the manifest" };

/**
 * Decide what slide k may show. A frame is shown ONLY when the verdict says so
 * and the frame is not misleading; anything malformed degrades to the caption,
 * never to a frame. Pure, so the rule is testable on its own.
 */
export function slidePlan(
  manifest: BoardManifest,
  k: number,
): { show: "frame" | "fallback_frame" | "caption"; frameK: number; reason: string } {
  const seg = manifest.segments[k];
  if (!seg) throw new RangeError(`no segment ${k} (manifest has ${manifest.segments.length})`);
  const v = seg.visual ?? UNKNOWN;
  if (v.show === "frame" && (v.status === "distinct" || v.status === "reused_relevant")) {
    return { show: "frame", frameK: k, reason: v.reason };
  }
  if (v.show === "fallback_frame" && typeof v.fallback_k === "number" && v.fallback_k !== k) {
    const f = manifest.segments[v.fallback_k];
    const fv = f?.visual;
    // The fallback's OWN frame must be trustworthy, or we would be showing a
    // misleading frame under this segment's heading.
    if (f && fv && fv.show === "frame" && (fv.status === "distinct" || fv.status === "reused_relevant")) {
      return { show: "fallback_frame", frameK: v.fallback_k, reason: v.reason };
    }
    return { show: "caption", frameK: k, reason: `fallback ${v.fallback_k} is not a trusted frame; ${v.reason}` };
  }
  return { show: "caption", frameK: k, reason: v.reason };
}

export function captionCard(manifest: BoardManifest, k: number, generationId: string | null): TextCard {
  const seg = manifest.segments[k];
  if (!seg) throw new RangeError(`no segment ${k}`);
  return {
    source: "caption",
    heading: seg.heading ?? "",
    body: (seg.points ?? []).filter((p) => typeof p === "string" && p.trim()),
    ...(generationId ? { generationId } : {}),
    index: k,
  };
}

export function createBoardController(
  ports: BoardPorts,
  sink: SkActionSink,
  opts: ControllerOptions = {},
): BoardController {
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const seekTimeoutMs = opts.seekTimeoutMs ?? 10_000;
  const frameTimeoutMs = opts.frameTimeoutMs ?? 1_500;
  const endBackoffS = opts.endBackoffS ?? 0.1;
  const startNudgeS = opts.startNudgeS ?? 0.03;
  const actions: SkActionRecord[] = [];
  let ended = false;
  let moving = 0;
  /** The running slides load, so a new move can stop it. */
  let loading: AbortController | null = null;
  // `window` (S1 slice C) is the open subset [start, end) when practise(n)
  // asked for n questions; null = the whole set, as M2 had it.
  let qs: (QuestionSet & { pages: Map<number, number>; current: number; window: { start: number; end: number } | null }) | null = null;

  const setMoving = (delta: 1 | -1) => {
    const was = moving > 0;
    moving = Math.max(0, moving + delta);
    if (was !== moving > 0) opts.onMoving?.(moving > 0);
  };

  const log = (r: SkActionRecord) => {
    actions.push(r);
    try {
      const p = sink.record(r);
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
    } catch {
      /* a broken sink never fails the move */
    }
  };

  const base = (action: SkActionName, params: Record<string, unknown>) => ({
    actor_id: ports.actorId(),
    action,
    tier: "immediate" as const,
    kind: "board" as const,
    params,
    session_id: ports.sessionId(),
    generation_id: ports.generationId(),
    at: new Date().toISOString(),
  });

  async function run<T>(
    action: SkActionName,
    params: Record<string, unknown>,
    fn: () => Promise<T> | T,
    describe?: (v: T) => Record<string, unknown> | undefined,
  ): Promise<T> {
    const head = base(action, params);
    const t0 = now();
    try {
      if (ended) throw new Error("session ended");
      const v = await fn();
      log({ ...head, ok: true, result: describe?.(v), ms: now() - t0 });
      return v;
    } catch (e) {
      log({ ...head, ok: false, error: e instanceof Error ? e.message : String(e), ms: now() - t0 });
      throw e;
    }
  }

  function runSync<T>(
    action: SkActionName,
    params: Record<string, unknown>,
    fn: () => T,
    describe?: (v: T) => Record<string, unknown> | undefined,
  ): T {
    const head = base(action, params);
    const t0 = now();
    try {
      if (ended) throw new Error("session ended");
      const v = fn();
      log({ ...head, ok: true, result: describe?.(v), ms: now() - t0 });
      return v;
    } catch (e) {
      log({ ...head, ok: false, error: e instanceof Error ? e.message : String(e), ms: now() - t0 });
      throw e;
    }
  }

  /** The raw seek: listeners first, then the assignment, then `seeked`, then the displayed frame. */
  function rawSeek(target: number): Promise<SeekResult> {
    const v = ports.video();
    if (!v) return Promise.reject(new Error("no video"));
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    const t = Math.min(Math.max(0, target), dur);
    setMoving(1);
    const t0 = now();

    // The displayed frame. Registered BEFORE the seek, because Chromium presents
    // the seeked frame around the event itself — a callback registered after
    // `seeked` can miss it and, on a paused video, wait forever. A frame from
    // before the seek (a playing video) is skipped by re-arming.
    let seekedAt: number | null = null;
    let frameDone: (md: { mediaTime: number } | null) => void = () => {};
    const frame = new Promise<{ mediaTime: number; at: number } | null>((res) => {
      frameDone = (md) => res(md ? { mediaTime: md.mediaTime, at: now() } : null);
    });
    const rvfc = v.requestVideoFrameCallback?.bind(v);
    if (rvfc) {
      const arm = () =>
        rvfc((_n, md) => {
          if (seekedAt !== null || Math.abs(md.mediaTime - t) < 1) frameDone(md);
          else arm();
        });
      arm();
    } else {
      frameDone(null);
    }

    const seeked = new Promise<number>((resolve, reject) => {
      const done = () => {
        cleanup();
        seekedAt = now();
        resolve(v.currentTime);
      };
      const failed = () => {
        cleanup();
        reject(new Error("video error during seek"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`seek to ${t}s did not land within ${seekTimeoutMs} ms`));
      }, seekTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        v.removeEventListener("seeked", done);
        v.removeEventListener("error", failed);
      };
      // Listen BEFORE assigning: a cached frame can fire seeked synchronously.
      v.addEventListener("seeked", done);
      v.addEventListener("error", failed);
      v.currentTime = t;
    });

    return seeked
      .then(async (landed) => {
        const latencyMs = (seekedAt ?? now()) - t0;
        const shown = await Promise.race([
          frame,
          new Promise<null>((res) => setTimeout(() => res(null), frameTimeoutMs)),
        ]);
        return {
          target: t,
          landed,
          errorMs: Math.abs(landed - t) * 1000,
          latencyMs,
          presentedMediaTime: shown ? shown.mediaTime : null,
          frameErrorMs: shown ? Math.abs(shown.mediaTime - t) * 1000 : null,
          frameLatencyMs: shown ? shown.at - t0 : null,
        };
      })
      .finally(() => setMoving(-1));
  }

  const round = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  const describeSeek = (r: SeekResult) => ({
    target: r.target,
    landed: r.landed,
    errorMs: round(r.errorMs),
    latencyMs: round(r.latencyMs),
    presentedMediaTime: r.presentedMediaTime,
    frameErrorMs: round(r.frameErrorMs),
    frameLatencyMs: round(r.frameLatencyMs),
  });

  const pageCount = () => ({ pageCount: ports.where().count });

  /** Show question i of the open set: wind to its page if it has one, else push it. */
  const showQuestion = (i: number) => {
    if (!qs) throw new Error("no question set open");
    // Inside a window the edges hold rather than throw: "next" on the last of
    // three stays on the third — the teacher asked for three.
    if (qs.window) i = Math.min(Math.max(i, qs.window.start), qs.window.end - 1);
    if (i < 0 || i >= qs.cards.length) throw new RangeError(`no question ${i + 1} (set has ${qs.cards.length})`);
    const page = qs.pages.get(i);
    if (page !== undefined) {
      ports.goTo(page);
    } else {
      ports.pushCard(qs.cards[i]);
      qs.pages.set(i, ports.where().count - 1);
    }
    qs.current = i;
    return { index: i, total: qs.cards.length };
  };

  return {
    play: () => run("board.play", {}, () => ports.play()),
    resume: () => run("board.resume", {}, () => ports.resume()),
    pause: () => runSync("board.pause", {}, () => ports.pause()),
    seek: async (t) => (await run("board.seek", { t }, () => rawSeek(t), describeSeek)).landed,
    seekMeasured: (t) => run("board.seek", { t }, () => rawSeek(t), describeSeek),
    seekSegment: (k, edge, manifest) =>
      run(
        "board.seek_segment",
        { k, edge },
        () => rawSeek(segmentTarget(manifest, k, edge, endBackoffS, startNudgeS)),
        describeSeek,
      ),
    slide: (k, manifest) =>
      run(
        "board.slide",
        { k },
        async (): Promise<SlideResult> => {
          const plan = slidePlan(manifest, k);
          ports.pause();
          if (plan.show === "caption") {
            ports.pushCard(captionCard(manifest, k, ports.generationId()));
            ports.setStage("away");
            return { shown: "caption", shownK: k, reason: plan.reason };
          }
          ports.setStage("full");
          const seek = await rawSeek(slideTime(manifest, plan.frameK, endBackoffS));
          return { shown: plan.show, shownK: plan.frameK, reason: plan.reason, seek };
        },
        (r) => ({ shown: r.shown, shownK: r.shownK, reason: r.reason, ...(r.seek ? describeSeek(r.seek) : {}) }),
      ),
    freeze: () =>
      run(
        "board.freeze",
        {},
        async () => {
          if (!(await ports.freeze())) throw new Error("nothing to capture");
          return true;
        },
        pageCount,
      ),
    openWorksheetPage: () =>
      runSync(
        "board.worksheet_page",
        {},
        () => {
          if (!ports.openWorksheetPage()) throw new Error("no projectable worksheet in this unit");
          return true;
        },
        pageCount,
      ),
    blankPage: (o) => runSync("board.blank_page", o?.after !== undefined ? { after: o.after } : {}, () => ports.blankPage(o), pageCount),
    cancelLoad: () => loading?.abort(),
    loadSlides: (manifest, o = {}) => {
      const n = manifest.segments.length;
      const from = Math.max(0, o.from ?? 0);
      const to = Math.min(n - 1, o.to ?? n - 1);
      const count = Math.max(0, to - from + 1);
      return run(
        "board.load_slides",
        { count, from, to },
        async (): Promise<LoadSlidesResult> => {
          if (!count) throw new Error("no slides in the lesson map");
          loading?.abort();
          const ac = new AbortController();
          loading = ac;
          const aborted = () => ac.signal.aborted || !!o.signal?.aborted;
          const out: LoadSlidesResult = { pages: 0, firstPage: -1, lastPage: -1, aborted: false };
          try {
            ports.pause();
            for (let k = from; k <= to; k++) {
              if (aborted()) break;
              // The completed frame, DISPLAYED: rawSeek resolves on the
              // presented frame (rVFC) or its timeout; with no rVFC at all it
              // resolves on `seeked`, so give the decoder a beat to paint.
              const r = await rawSeek(slideTime(manifest, k, endBackoffS));
              if (r.presentedMediaTime === null) await new Promise<void>((res) => setTimeout(res, 80));
              if (aborted()) break;
              // The first slide may take a pristine roll's blank first page.
              if (!(await ports.freeze(k === from ? { replaceBlank: true } : undefined))) throw new Error(`nothing to capture for slide ${k + 1}`);
              const page = ports.where().page;
              if (out.firstPage < 0) out.firstPage = page;
              out.lastPage = page;
              out.pages++;
              o.onProgress?.(k - from + 1, count);
            }
            out.aborted = aborted() && out.pages < count;
          } finally {
            if (loading === ac) loading = null;
            // The roll is the surface now: the video steps aside and the
            // first slide is the page on screen. resume/intro bring it back.
            ports.setStage("away");
            if (out.firstPage >= 0) ports.goTo(out.firstPage);
          }
          return out;
        },
        (r) => ({ pages: r.pages, firstPage: r.firstPage, lastPage: r.lastPage, aborted: r.aborted, ...pageCount() }),
      );
    },
    loadDeck: (req) => {
      const n = req.slides.length;
      const from = Math.max(0, req.from ?? 0);
      const to = Math.min(n - 1, req.to ?? n - 1);
      const count = Math.max(0, to - from + 1);
      return run(
        "board.load_deck",
        { generationId: req.generationId, count, from, to },
        async (): Promise<LoadSlidesResult> => {
          if (!count) throw new Error("no slides in the deck");
          const put = ports.putPage;
          if (!put) throw new Error("this Board cannot hold deck pages");
          loading?.abort();
          const ac = new AbortController();
          loading = ac;
          const aborted = () => ac.signal.aborted || !!req.signal?.aborted;
          const out: LoadSlidesResult = { pages: 0, firstPage: -1, lastPage: -1, aborted: false };
          try {
            ports.pause();
            let after = ports.where().page;
            for (let k = from; k <= to; k++) {
              if (aborted()) break;
              const bg = deckPageOf(req.generationId, req.slides[k], req.map ?? null);
              const page = put(bg, k === from ? { after, replaceBlank: true } : { after });
              after = page;
              if (out.firstPage < 0) out.firstPage = page;
              out.lastPage = page;
              out.pages++;
              req.onProgress?.(k - from + 1, count);
              // A beat between pages, so a cancel (a new move, a second press)
              // lands between two slides rather than after the last.
              await new Promise<void>((res) => setTimeout(res, 0));
            }
            out.aborted = aborted() && out.pages < count;
          } finally {
            if (loading === ac) loading = null;
            ports.setStage("away");
            if (out.firstPage >= 0) ports.goTo(out.firstPage);
          }
          return out;
        },
        (r) => ({ pages: r.pages, firstPage: r.firstPage, lastPage: r.lastPage, aborted: r.aborted, ...pageCount() }),
      );
    },
    findDeckPage: (n = 1, generationId) => ports.findDeckPage?.(n, generationId) ?? null,
    goToDeckPage: (n = 1, generationId) =>
      runSync(
        "board.deck_page",
        generationId ? { n, generationId } : { n },
        () => {
          const page = ports.findDeckPage?.(n, generationId) ?? null;
          if (page === null) throw new Error("no deck pages on the roll");
          ports.pause();
          ports.setStage("away");
          ports.goTo(page);
          return page;
        },
        (page) => ({ page }),
      ),
    pageUp: () =>
      runSync("board.page_up", {}, () => {
        const w = ports.where();
        ports.goTo(Math.max(0, w.page - 1));
      }),
    pageDown: () =>
      runSync("board.page_down", {}, () => {
        const w = ports.where();
        ports.goTo(Math.min(w.count - 1, w.page + 1));
      }),
    showQuestions: (start = 0, count?: number) =>
      run(
        "board.show_questions",
        count === undefined ? { start } : { start, count },
        async (): Promise<QuestionsShown> => {
          if (!qs) {
            const set = await ports.loadQuestions();
            if (!set || !set.cards.length) throw new Error("no questions for this unit");
            qs = { ...set, pages: new Map(), current: 0, window: null };
          }
          const total = qs.cards.length;
          if (start < 0 || start >= total) throw new RangeError(`no question ${start + 1} (set has ${total})`);
          // A new call re-sets the window: practise(3) after a walkthrough
          // narrows, walkthrough after practise(3) widens again.
          qs.window = count !== undefined && Number.isInteger(count) && count > 0 ? { start, end: Math.min(total, start + count) } : null;
          ports.pause();
          ports.setStage("away");
          const r = showQuestion(start);
          return qs.window ? { ...r, shown: qs.window.end - qs.window.start, of: total } : r;
        },
        (r) => ({ ...r }),
      ),
    nextQuestion: () =>
      run("board.next_question", {}, () => showQuestion((qs?.current ?? -1) + 1), (r) => ({ ...r })),
    prevQuestion: () =>
      run("board.prev_question", {}, () => showQuestion((qs?.current ?? 1) - 1), (r) => ({ ...r })),
    getState: () => {
      const v = ports.video();
      const w = ports.where();
      return {
        sessionId: ports.sessionId(),
        t: v?.currentTime ?? 0,
        duration: v?.duration ?? 0,
        paused: v?.paused ?? true,
        moving: moving > 0,
        stageMode: ports.stageMode(),
        page: w.page,
        pageCount: w.count,
        ended,
        questions: qs ? { generationId: qs.generationId, index: qs.current, total: qs.cards.length } : null,
        actions: actions.slice(),
      };
    },
    getUnit: () => ports.unit?.() ?? null,
    endSession: () =>
      run("board.end_session", {}, async () => {
        if (!(await ports.endSession())) throw new Error("close did not land");
        ended = true;
        return true;
      }),
  };
}
