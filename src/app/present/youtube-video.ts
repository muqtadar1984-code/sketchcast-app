// The Board's stage playing a YouTube video — the FALLBACK, for a lesson with
// no stored MP4 (founder 2026-10-30: "the quality matters in the app so lets
// use stored mp4 wherever possible"; stageSource below picks the stored file
// whenever there is one, and /api/present/kit sends YouTube ids only for a
// lesson that has none). src/utils/catalogue/kit-youtube.ts finds the id.
//
// The Board drives video by TIME — the controller seeks to a segment's slide,
// SK reads the position, ink is recorded against it — so the player sits
// behind the SAME interface the <video> element gives the controller
// (board-controller.ts VideoLike: currentTime get/set, duration, paused,
// `seeked`/`error` listeners) plus play/pause. Nothing above the stage can
// tell which it is driving.
//
// WHAT YOUTUBE CANNOT DO: give us its pixels. The player is a cross-origin
// iframe, so a frame can never be drawn into a canvas — freeze-frame and
// "Load slides" (both capture video frames) are unavailable on a YouTube
// lesson; the stage says the frame could not be captured, and the Board hides
// "Load slides" (the deck still loads as pages). The stored MP4 has neither
// limit, which is one more reason it comes first.
//
// CAPTIONS OFF BY DEFAULT: cc_load_policy 0 in the player vars, and on ready
// captionsOff() unloads the captions module — a viewer's YouTube account can
// force captions on whatever the vars say, and the Board shows no YouTube
// controls to turn them off again.
//
// THE SEEK. seekTo() has no `seeked` event; the adapter emits one when the
// player reports a position near the target (or after a short wait, with
// whatever position it has), always asynchronously — the controller registers
// its listener before assigning, as it does for the element.
//
// No DOM here beyond loadYouTubeApi's one <script>; the adapter is driven by an
// injected player and clock, so it is unit-tested without a browser.

import type { VideoLike } from "./board-controller";

export const YOUTUBE_IFRAME_API = "https://www.youtube.com/iframe_api";

/** YT.PlayerState */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

/** The slice of YT.Player this file uses. */
export type YTPlayerLike = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
  /** Undocumented but long-standing: the captions module ("captions", or "cc"
   *  on older players). Optional: a player without them is left alone. */
  unloadModule?(name: string): void;
  setOption?(module: string, option: string, value: unknown): void;
};

export type YTNamespace = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: { onReady?: () => void; onStateChange?: (e: { data: number }) => void; onError?: (e: { data: number }) => void; onApiChange?: () => void };
    },
  ) => YTPlayerLike;
};

type Win = Window & { YT?: Partial<YTNamespace>; onYouTubeIframeAPIReady?: () => void };
let apiPromise: Promise<YTNamespace> | null = null;

/** The IFrame Player API, loaded once per page from youtube.com. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  const w = window as Win;
  if (w.YT?.Player) return Promise.resolve(w.YT as YTNamespace);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (w.YT?.Player) resolve(w.YT as YTNamespace);
      else reject(new Error("YouTube player API did not initialise"));
    };
    const s = document.createElement("script");
    s.src = YOUTUBE_IFRAME_API;
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error("YouTube player API failed to load"));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

/** The player options the stage uses: no YouTube chrome, inline, this
 *  origin, captions not loaded by default. */
export function youtubePlayerVars(origin: string): Record<string, string | number> {
  return { controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3, cc_load_policy: 0, origin };
}

/**
 * Captions off, on ready. There is no guaranteed parameter — a viewer's
 * YouTube preference can switch them on regardless of cc_load_policy — so the
 * captions module is unloaded (both of its names) and its track cleared. Each
 * call is defensive: the API is undocumented and a failure must never stop
 * the lesson from playing.
 */
export function captionsOff(player: Partial<Pick<YTPlayerLike, "unloadModule" | "setOption">>): void {
  for (const name of ["captions", "cc"]) {
    try {
      player.unloadModule?.(name);
    } catch {
      // not loaded, or not this player's name for it
    }
  }
  try {
    player.setOption?.("captions", "track", {});
  } catch {
    // no captions module to talk to
  }
}

/**
 * The IFrame player's events for the stage: on ready, captions off and the
 * player handed to the adapter; captions off again whenever the player loads
 * a module (the captions module can arrive after ready, from a viewer's
 * YouTube preference); state and errors to the adapter. `player` is read
 * lazily — the events are built before `new YT.Player` returns.
 */
export function stagePlayerEvents(video: YouTubeVideo, player: () => YTPlayerLike | null) {
  return {
    onReady: () => {
      const p = player();
      if (!p) return;
      captionsOff(p);
      video.attach(p);
    },
    onApiChange: () => {
      const p = player();
      if (p) captionsOff(p);
    },
    onStateChange: (e: { data: number }) => video.handleState(e.data),
    onError: () => video.handleError(),
  };
}

type Clock = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
type Ev = "seeked" | "error" | "ended";

/**
 * A YouTube player as the Board's VideoLike. Built before the player exists
 * (the API loads asynchronously); `attach` hands it the ready player. A seek
 * asked for before then is applied on attach.
 */
export class YouTubeVideo implements VideoLike {
  private player: YTPlayerLike | null = null;
  private readonly on: Record<Ev, Set<() => void>> = { seeked: new Set(), error: new Set(), ended: new Set() };
  private pendingSeek: number | null = null;
  private seekTimer: unknown = null;
  private wantPlay = false;
  private destroyed = false;
  constructor(
    private readonly clock: Clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    /** How close counts as landed, and how long to wait before emitting `seeked` anyway. */
    private readonly opts: { toleranceS?: number; pollMs?: number; maxWaitMs?: number } = {},
  ) {}

  attach(player: YTPlayerLike): void {
    if (this.destroyed) return void player.destroy();
    this.player = player;
    if (this.pendingSeek !== null) this.currentTime = this.pendingSeek;
    if (this.wantPlay) player.playVideo();
  }

  get ready(): boolean {
    return !!this.player;
  }

  get currentTime(): number {
    if (!this.player) return this.pendingSeek ?? 0;
    const t = Number(this.player.getCurrentTime());
    return Number.isFinite(t) ? t : 0;
  }

  set currentTime(t: number) {
    const target = Math.max(0, Number(t) || 0);
    if (!this.player) {
      this.pendingSeek = target;
      return;
    }
    this.pendingSeek = null;
    this.player.seekTo(target, true);
    if (this.seekTimer) this.clock.clearTimeout(this.seekTimer);
    const tol = this.opts.toleranceS ?? 0.75;
    const poll = this.opts.pollMs ?? 100;
    let waited = 0;
    const check = () => {
      this.seekTimer = null;
      if (this.destroyed) return;
      waited += poll;
      if (Math.abs(this.currentTime - target) <= tol || waited >= (this.opts.maxWaitMs ?? 3000)) this.emit("seeked");
      else this.seekTimer = this.clock.setTimeout(check, poll);
    };
    // never synchronously: the listener may be added in the same tick
    this.seekTimer = this.clock.setTimeout(check, 0);
  }

  get duration(): number {
    const d = this.player ? Number(this.player.getDuration()) : NaN;
    return Number.isFinite(d) && d > 0 ? d : NaN;
  }

  get paused(): boolean {
    if (!this.player) return !this.wantPlay;
    const s = this.player.getPlayerState();
    return s !== YT_STATE.PLAYING && s !== YT_STATE.BUFFERING;
  }

  async play(): Promise<void> {
    this.wantPlay = true;
    this.player?.playVideo();
  }

  pause(): void {
    this.wantPlay = false;
    this.player?.pauseVideo();
  }

  /** YT onStateChange. */
  handleState(state: number): void {
    if (state === YT_STATE.ENDED) {
      this.wantPlay = false;
      this.emit("ended");
    }
  }

  /** YT onError (an embedding refusal, a removed video, a bad id). */
  handleError(): void {
    this.emit("error");
  }

  addEventListener(type: Ev, fn: () => void): void {
    this.on[type]?.add(fn);
  }

  removeEventListener(type: Ev, fn: () => void): void {
    this.on[type]?.delete(fn);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.seekTimer) this.clock.clearTimeout(this.seekTimer);
    for (const s of Object.values(this.on)) s.clear();
    try {
      this.player?.destroy();
    } catch {
      // a player torn down mid-load has nothing left to destroy
    }
    this.player = null;
  }

  private emit(type: Ev): void {
    for (const fn of [...this.on[type]]) {
      try {
        fn();
      } catch {
        // a listener's failure is its own
      }
    }
  }
}

/**
 * Which source the stage plays: the stored file whenever there is one (founder
 * 2026-10-30: quality first — and its frames can be captured), a YouTube id
 * only when there is no file, nothing when neither.
 */
export function stageSource(src: string | null | undefined, youtubeId: string | null | undefined): "youtube" | "file" | "none" {
  if (src) return "file";
  if (typeof youtubeId === "string" && /^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return "youtube";
  return "none";
}
