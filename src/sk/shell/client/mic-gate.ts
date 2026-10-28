// The microphone GATE — lifecycle 1 of the four in Final Plan 2026-10-28 §2.6:
//
//   "Microphone capture | client | stops when: window hidden / blurred /
//    pagehide / idle 60 s (hands-free) / release (push-to-talk).
//    Never resumes by itself."
//
// The gate owns exactly that decision. It does not know what a microphone is;
// it tells its owner to stop (`onStop(reason)`) and the owner stops dictation.
// `onStop` runs SYNCHRONOUSLY inside the event handler — no microtask, no
// timer — so the mic is off before the browser's blur/hidden dispatch even
// returns, which is how S0's acceptance ("mic stops within 200 ms of
// blur/hidden") is met with margin and asserted in the suite.
//
// PURE: `win` and `doc` are the two listener targets injected as the smallest
// shapes the gate needs, and the timers are injected too, so the tests run in
// node with fake targets and fake clocks.

export type MicStopReason = "blur" | "hidden" | "pagehide" | "idle" | "release" | "manual" | "dispose";

export type ListenerTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export type GateDocument = ListenerTarget & {
  visibilityState: string;
  hasFocus?: () => boolean;
};

export type MicGateOptions = {
  win: ListenerTarget;
  doc: GateDocument;
  onStop: (reason: MicStopReason) => void;
  /** Hands-free idle budget; §2.6 says 60 s. */
  idleMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export type MicGate = {
  /** True while capture is allowed. */
  readonly active: boolean;
  /** Arm the gate. Refuses (returns false) when the document is not visible or
   *  not focused — the §2.6 lifecycle must not START in a state it would stop
   *  in. `idle: true` (hands-free) arms the idle timer; push-to-talk never
   *  idles out because the finger on the button IS the activity. */
  start: (opts?: { idle?: boolean }) => boolean;
  /** Activity (a transcript chunk, a press) — pushes the idle deadline back. */
  touch: () => void;
  /** Stop now. Calls onStop once if the gate was active; returns whether it was. */
  stop: (reason?: MicStopReason) => boolean;
  /** Stop and remove every listener. The gate is dead afterwards. */
  dispose: () => void;
};

export const DEFAULT_IDLE_MS = 60_000;

export function createMicGate(opts: MicGateOptions): MicGate {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let active = false;
  let idleEnabled = false;
  let idleHandle: unknown = null;
  let disposed = false;

  const clearIdle = () => {
    if (idleHandle != null) {
      clearT(idleHandle);
      idleHandle = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    if (!idleEnabled || !active) return;
    idleHandle = setT(() => {
      idleHandle = null;
      stop("idle");
    }, idleMs);
  };

  function stop(reason: MicStopReason = "manual"): boolean {
    clearIdle();
    if (!active) return false;
    active = false; // flipped BEFORE onStop so a re-entrant stop() is a no-op
    opts.onStop(reason);
    return true;
  }

  // Each handler stops synchronously. There is deliberately NO focus /
  // visible / pageshow handler: nothing here ever restarts capture (§2.6).
  const onBlur = () => {
    stop("blur");
  };
  const onVisibility = () => {
    if (opts.doc.visibilityState !== "visible") stop("hidden");
  };
  const onPageHide = () => {
    stop("pagehide");
  };

  opts.win.addEventListener("blur", onBlur);
  opts.win.addEventListener("pagehide", onPageHide);
  opts.doc.addEventListener("visibilitychange", onVisibility);

  return {
    get active() {
      return active;
    },
    start(o) {
      if (disposed) return false;
      if (opts.doc.visibilityState !== "visible") return false;
      if (typeof opts.doc.hasFocus === "function" && !opts.doc.hasFocus()) return false;
      active = true;
      idleEnabled = !!o?.idle;
      armIdle();
      return true;
    },
    touch() {
      if (active && idleEnabled) armIdle();
    },
    stop,
    dispose() {
      if (disposed) return;
      stop("dispose");
      disposed = true;
      opts.win.removeEventListener("blur", onBlur);
      opts.win.removeEventListener("pagehide", onPageHide);
      opts.doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
