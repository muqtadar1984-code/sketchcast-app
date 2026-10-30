// The microphone GATE — lifecycle 1 of the four in Final Plan 2026-10-28 §2.6:
//
//   "Microphone capture | client | stops when: window hidden / blurred /
//    pagehide / idle 60 s (hands-free) / release (push-to-talk).
//    Never resumes by itself."
//
// AMENDED by the founder 2026-10-30 for the home hero's Mic switch: the stop
// conditions are unchanged, but while the switch is ON (`setAutoResume(true)`)
// a capture the gate stopped for blur / hidden / pagehide / idle / SK speaking
// comes back once the page is visible AND focused again, or on her next
// interaction with the page (pointerdown / keydown — how an idle pause on a
// page she never left ends), and SK is not speaking (the owner's `canResume`
// veto). NEVER on a timer: the 60 s idle stop stays, because it bounds how
// long a mic is open and what per-minute STT (Transcribe) costs. With the switch off, and always
// in the floating panel (which never passes `onResume`), "never resumes by
// itself" still holds exactly as before.
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

export type MicStopReason = "blur" | "hidden" | "pagehide" | "idle" | "speaking" | "release" | "manual" | "dispose";

/** The stops a Mic-on switch comes back from. `release` / `manual` are her
 *  own act (or the browser refusing) and `dispose` is the end: never resumed. */
export const RESUMABLE_STOPS: ReadonlySet<MicStopReason> = new Set<MicStopReason>(["blur", "hidden", "pagehide", "idle", "speaking"]);

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
  /** 2026-10-30 (home hero only): called, synchronously, when a resume is owed
   *  and the page is visible and focused again — the owner then start()s and
   *  dictates. Without it the gate registers no return listeners at all and
   *  never resumes (the panel, §2.6 as written). */
  onResume?: () => void;
  /** The owner's veto at resume time (SK is speaking: the mic must not hear
   *  her). A vetoed resume stays owed. */
  canResume?: () => boolean;
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
  /** The Mic switch (needs `onResume`). Off also forgets an owed resume. */
  setAutoResume: (on: boolean) => void;
  /** Owe a resume and take it now if the page allows (visible, focused, not
   *  vetoed); otherwise the next return to the page takes it. False when the
   *  switch is off, the gate is live or dead, or it could not resume yet. */
  resume: () => boolean;
  /** Whether a resume is owed (the switch is on and the mic is paused). */
  readonly pending: boolean;
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
  let autoResume = false;
  let owed = false;

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
    owed = autoResume && !!opts.onResume && RESUMABLE_STOPS.has(reason);
    opts.onStop(reason);
    return true;
  }

  const pageAllows = () => opts.doc.visibilityState === "visible" && (typeof opts.doc.hasFocus !== "function" || opts.doc.hasFocus());

  /** Take an owed resume when the page allows it; the owner restarts capture. */
  function tryResume(): boolean {
    if (disposed || active || !owed || !autoResume || !opts.onResume) return false;
    if (!pageAllows()) return false;
    if (opts.canResume && !opts.canResume()) return false;
    owed = false;
    opts.onResume();
    return true;
  }

  // Each handler stops synchronously. Without `onResume` there is NO focus /
  // pageshow handler and a visible state restarts nothing (§2.6); with it,
  // the return to the page takes an owed resume, and only while the switch is on.
  const onBlur = () => {
    stop("blur");
  };
  const onVisibility = () => {
    if (opts.doc.visibilityState !== "visible") stop("hidden");
    else if (opts.onResume) tryResume();
  };
  const onPageHide = () => {
    stop("pagehide");
  };
  const onReturn = () => {
    tryResume();
  };

  opts.win.addEventListener("blur", onBlur);
  opts.win.addEventListener("pagehide", onPageHide);
  opts.doc.addEventListener("visibilitychange", onVisibility);
  if (opts.onResume) {
    opts.win.addEventListener("focus", onReturn);
    opts.win.addEventListener("pageshow", onReturn);
    opts.doc.addEventListener("pointerdown", onReturn);
    opts.doc.addEventListener("keydown", onReturn);
  }

  return {
    get active() {
      return active;
    },
    get pending() {
      return owed && autoResume && !active && !disposed;
    },
    start(o) {
      if (disposed) return false;
      if (!pageAllows()) return false;
      owed = false;
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
      owed = false;
      opts.win.removeEventListener("blur", onBlur);
      opts.win.removeEventListener("pagehide", onPageHide);
      opts.doc.removeEventListener("visibilitychange", onVisibility);
      if (opts.onResume) {
        opts.win.removeEventListener("focus", onReturn);
        opts.win.removeEventListener("pageshow", onReturn);
        opts.doc.removeEventListener("pointerdown", onReturn);
        opts.doc.removeEventListener("keydown", onReturn);
      }
    },
    setAutoResume(on) {
      autoResume = on && !!opts.onResume;
      if (!autoResume) owed = false;
    },
    resume() {
      if (disposed || active || !autoResume) return false;
      owed = true;
      return tryResume();
    },
  };
}
