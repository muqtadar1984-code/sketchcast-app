// The Board, callable from code — spike M2 of the SK assistant plan.
//
// WHY A PORT OBJECT AND NOT THE COMPONENT ITSELF. Every move here is one the
// Board already makes from a button; the controller adds no behaviour of its
// own beyond waiting for the browser to finish a seek. BoardSession hands it a
// set of ports that call the SAME callbacks its buttons call (playVideo, freeze,
// openWorksheet, push, goTo, end), so a move made by voice and a move made by a
// finger are one code path and cannot drift apart.
//
// EVERY MOVE IS LOGGED, AND THE LOGGER IS INJECTED. On the real page the logger
// would post `kind: "sk_move"` to /api/present/items — but that route's KINDS
// set and the table's `present_items_kind_check` constraint both admit only
// video | worksheet | blank today, so an sk_move posted there is dropped (400)
// until a migration widens the check. The dev harness injects an in-memory
// sink instead. The controller does not care which: a logger that throws or
// rejects never fails the move it was recording.
//
// THE SEEK RESOLVES ON `seeked`, NOT ON ASSIGNMENT. Setting currentTime starts
// an asynchronous seek; reading currentTime straight back returns the target,
// not where the decoder landed. The only honest "it is there" is the event.

import type { StageMode } from "./stage";

/** The parts of an HTMLVideoElement the controller touches. A fake in tests. */
export type VideoLike = {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  addEventListener(type: "seeked" | "error", fn: () => void): void;
  removeEventListener(type: "seeked" | "error", fn: () => void): void;
};

/** One script segment of the kit's video, in seconds from the start. */
export type ManifestSegment = { start_s: number; end_s: number };
export type BoardManifest = { segments: ManifestSegment[] };

export type SkMoveName =
  | "play"
  | "pause"
  | "seek"
  | "seekSegment"
  | "freeze"
  | "openWorksheetPage"
  | "blankPage"
  | "pageUp"
  | "pageDown"
  | "endSession";

export type SkMove = {
  kind: "sk_move";
  move: SkMoveName;
  args?: Record<string, unknown>;
  ok: boolean;
  /** What the move produced, when it produced something worth keeping. */
  result?: Record<string, unknown>;
  error?: string;
  /** Epoch ms when the move was asked for. */
  at: number;
  /** How long it took, ms. */
  ms: number;
};

export type MoveLogger = (move: SkMove) => void | Promise<void>;

/** What BoardSession gives the controller. Each port is a callback a Board
 *  button already uses. */
export type BoardPorts = {
  sessionId: () => string;
  video: () => VideoLike | null;
  /** The ▶ button: stage to full, play, record the video item. */
  play: () => Promise<void>;
  pause: () => void;
  /** Tap-to-freeze: pause, capture, push a frame page. False when nothing was captured. */
  freeze: () => Promise<boolean>;
  /** Open the current unit's first projectable worksheet. False when there is none. */
  openWorksheetPage: () => boolean;
  blankPage: () => void;
  goTo: (page: number) => void;
  /** Page index and count, as the page arrows see them. */
  where: () => { page: number; count: number };
  stageMode: () => StageMode;
  /** End lesson. Resolves true once the close landed. */
  endSession: () => Promise<boolean>;
};

export type BoardState = {
  sessionId: string;
  t: number;
  duration: number;
  paused: boolean;
  stageMode: StageMode;
  page: number;
  pageCount: number;
  ended: boolean;
  /** Every move made through the controller, in order. */
  moves: SkMove[];
};

export type SeekResult = { landed: number; target: number; errorMs: number; latencyMs: number };

export type BoardController = {
  play(): Promise<void>;
  pause(): void;
  /** Resolves when `seeked` fires, with the landed currentTime. */
  seek(t: number): Promise<number>;
  /** Same as seek, with the measurement attached. */
  seekMeasured(t: number): Promise<SeekResult>;
  /** Seek to a segment's start, or to its completed end frame. */
  seekSegment(k: number, edge: "start" | "end", manifest: BoardManifest): Promise<SeekResult>;
  freeze(): Promise<boolean>;
  openWorksheetPage(): boolean;
  blankPage(): void;
  pageUp(): void;
  pageDown(): void;
  getState(): BoardState;
  endSession(): Promise<boolean>;
};

export type ControllerOptions = {
  now?: () => number;
  /** A seek that has not landed by then rejects. */
  seekTimeoutMs?: number;
  /**
   * How far before a segment's end the "end" edge aims. The worker cuts a
   * keyframe at each segment boundary, so end_s itself is the FIRST frame of
   * the next segment; the completed slide is the frame before it. Two frames
   * at 24 fps is enough margin for the decoder's frame quantisation.
   */
  endBackoffS?: number;
  /**
   * How far after start_s the "start" edge aims. Measured on a real kit: each
   * segment's keyframe sits 6-26 ms AFTER its start_s (the stream's first pts is
   * 0.023 s), so start_s itself still shows the previous segment's last frame.
   * 30 ms lands on the segment's own first frame for every boundary measured.
   */
  startNudgeS?: number;
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

export function createBoardController(
  ports: BoardPorts,
  logger: MoveLogger,
  opts: ControllerOptions = {},
): BoardController {
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const wall = () => Date.now();
  const seekTimeoutMs = opts.seekTimeoutMs ?? 10_000;
  const endBackoffS = opts.endBackoffS ?? 0.1;
  const startNudgeS = opts.startNudgeS ?? 0.03;
  const moves: SkMove[] = [];
  let ended = false;

  const log = (m: SkMove) => {
    moves.push(m);
    try {
      const r = logger(m);
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
    } catch {
      /* a broken logger never fails the move */
    }
  };

  /** Run a move, time it and log it — success or failure. */
  async function run<T>(
    move: SkMoveName,
    args: Record<string, unknown> | undefined,
    fn: () => Promise<T> | T,
    describe?: (v: T) => Record<string, unknown> | undefined,
  ): Promise<T> {
    const at = wall();
    const t0 = now();
    try {
      const v = await fn();
      log({ kind: "sk_move", move, args, ok: true, result: describe?.(v), at, ms: now() - t0 });
      return v;
    } catch (e) {
      log({
        kind: "sk_move",
        move,
        args,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        at,
        ms: now() - t0,
      });
      throw e;
    }
  }

  /** Same as run, for the moves the Board makes synchronously. */
  function runSync<T>(
    move: SkMoveName,
    args: Record<string, unknown> | undefined,
    fn: () => T,
    describe?: (v: T) => Record<string, unknown> | undefined,
  ): T {
    const at = wall();
    const t0 = now();
    try {
      const v = fn();
      log({ kind: "sk_move", move, args, ok: true, result: describe?.(v), at, ms: now() - t0 });
      return v;
    } catch (e) {
      log({ kind: "sk_move", move, args, ok: false, error: e instanceof Error ? e.message : String(e), at, ms: now() - t0 });
      throw e;
    }
  }

  const guard = () => {
    if (ended) throw new Error("session ended");
  };

  /** The raw seek: listener first, then the assignment, then wait for seeked. */
  function rawSeek(target: number): Promise<SeekResult> {
    const v = ports.video();
    if (!v) return Promise.reject(new Error("no video"));
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    const t = Math.min(Math.max(0, target), dur);
    return new Promise<SeekResult>((resolve, reject) => {
      const t0 = now();
      const done = () => {
        cleanup();
        const landed = v.currentTime;
        resolve({ landed, target: t, errorMs: Math.abs(landed - t) * 1000, latencyMs: now() - t0 });
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
  }

  const describeSeek = (r: SeekResult) => ({
    target: r.target,
    landed: r.landed,
    errorMs: Math.round(r.errorMs * 10) / 10,
    latencyMs: Math.round(r.latencyMs * 10) / 10,
  });

  return {
    play: () =>
      run("play", undefined, async () => {
        guard();
        await ports.play();
      }),
    pause: () =>
      runSync("pause", undefined, () => {
        guard();
        ports.pause();
      }),
    seek: async (t) => (await run("seek", { t }, () => (guard(), rawSeek(t)), describeSeek)).landed,
    seekMeasured: (t) => run("seek", { t }, () => (guard(), rawSeek(t)), describeSeek),
    seekSegment: (k, edge, manifest) =>
      run(
        "seekSegment",
        { k, edge },
        () => {
          guard();
          return rawSeek(segmentTarget(manifest, k, edge, endBackoffS, startNudgeS));
        },
        describeSeek,
      ),
    freeze: () =>
      run(
        "freeze",
        undefined,
        async () => {
          guard();
          const ok = await ports.freeze();
          if (!ok) throw new Error("nothing to capture");
          return ok;
        },
        () => ({ pageCount: ports.where().count }),
      ),
    openWorksheetPage: () =>
      runSync(
        "openWorksheetPage",
        undefined,
        () => {
          guard();
          if (!ports.openWorksheetPage()) throw new Error("no projectable worksheet in this unit");
          return true;
        },
        () => ({ pageCount: ports.where().count }),
      ),
    blankPage: () =>
      runSync(
        "blankPage",
        undefined,
        () => {
          guard();
          ports.blankPage();
        },
        () => ({ pageCount: ports.where().count }),
      ),
    pageUp: () =>
      runSync("pageUp", undefined, () => {
        guard();
        const w = ports.where();
        ports.goTo(Math.max(0, w.page - 1));
      }),
    pageDown: () =>
      runSync("pageDown", undefined, () => {
        guard();
        const w = ports.where();
        ports.goTo(Math.min(w.count - 1, w.page + 1));
      }),
    getState: () => {
      const v = ports.video();
      const w = ports.where();
      return {
        sessionId: ports.sessionId(),
        t: v?.currentTime ?? 0,
        duration: v?.duration ?? 0,
        paused: v?.paused ?? true,
        stageMode: ports.stageMode(),
        page: w.page,
        pageCount: w.count,
        ended,
        moves: moves.slice(),
      };
    },
    endSession: () =>
      run(
        "endSession",
        undefined,
        async () => {
          guard();
          const ok = await ports.endSession();
          if (!ok) throw new Error("close did not land");
          ended = true;
          return ok;
        },
      ),
  };
}

/** The real page's logger: /api/present/items with kind "sk_move".
 *  ⚠️ Dropped server-side today — see the header. Best-effort, like recordItem. */
export function itemsRouteLogger(sessionId: string): MoveLogger {
  return (m) => {
    void fetch("/api/present/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, items: [{ kind: "sk_move", generationId: null, detail: m }] }),
    }).catch(() => {});
  };
}
