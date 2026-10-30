/**
 * The microphone gate (Final Plan §2.6, S0 acceptance: "mic stops within
 * 200 ms of blur/hidden in an automated test"). Fake window/document targets
 * and a fake clock; no DOM.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/mic-gate.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { SPEECH_TAIL_MS, createDictationPasses, createMicGate, createSpeechHold, type GateDocument, type ListenerTarget, type MicStopReason } from "../mic-gate";
import { createSpeechCoordinator } from "../speech";
import { EMPTY_MARKS } from "@/sk/speech/provider";
import type { SpeechProvider } from "@/sk/speech/provider";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** A listener target that records (de)registrations and dispatches synchronously, like the DOM. */
function target() {
  const listeners = new Map<string, Set<() => void>>();
  const t: ListenerTarget & { dispatch: (type: string) => void; count: () => number } = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count() {
      let n = 0;
      for (const s of listeners.values()) n += s.size;
      return n;
    },
  };
  return t;
}

function fakeDoc(state = "visible", focused = true) {
  const base = target();
  const doc = Object.assign(base, { visibilityState: state, hasFocus: () => focused }) as GateDocument &
    ReturnType<typeof target> & { visibilityState: string };
  return doc;
}

/** A manual clock for the idle timer. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, p] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (p.at <= now) {
          pending.delete(id);
          p.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

function build(docState = "visible", focused = true) {
  const win = target();
  const doc = fakeDoc(docState, focused);
  const timers = fakeTimers();
  const stops: MicStopReason[] = [];
  const onStop = vi.fn((r: MicStopReason) => {
    stops.push(r);
  });
  const gate = createMicGate({ win, doc, onStop, idleMs: 60_000, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  return { win, doc, timers, gate, stops, onStop };
}

describe("mic gate: starting", () => {
  it("arms when the document is visible and focused", () => {
    const { gate } = build();
    expect(gate.start()).toBe(true);
    expect(gate.active).toBe(true);
  });
  it("refuses to start while hidden — the lifecycle never starts in a state it would stop in", () => {
    const { gate, onStop } = build("hidden");
    expect(gate.start()).toBe(false);
    expect(gate.active).toBe(false);
    expect(onStop).not.toHaveBeenCalled();
  });
  it("refuses to start while the window is not focused", () => {
    const { gate } = build("visible", false);
    expect(gate.start()).toBe(false);
  });
  it("starts when hasFocus is not available (older embedders) as long as it is visible", () => {
    const win = target();
    const doc = Object.assign(target(), { visibilityState: "visible" }) as GateDocument;
    const gate = createMicGate({ win, doc, onStop: () => {} });
    expect(gate.start()).toBe(true);
    gate.dispose();
  });
});

describe("mic gate: each §2.6 stop condition fires exactly once, synchronously", () => {
  for (const [name, fire, reason] of [
    ["window blur", (b: ReturnType<typeof build>) => b.win.dispatch("blur"), "blur"],
    [
      "visibilitychange → hidden",
      (b: ReturnType<typeof build>) => {
        b.doc.visibilityState = "hidden";
        b.doc.dispatch("visibilitychange");
      },
      "hidden",
    ],
    ["pagehide", (b: ReturnType<typeof build>) => b.win.dispatch("pagehide"), "pagehide"],
  ] as const) {
    it(`${name} stops the mic once, before the dispatch returns, well inside 200 ms`, () => {
      const b = build();
      expect(b.gate.start()).toBe(true);

      let ranBeforeDispatchReturned = false;
      let stoppedAt = 0;
      b.onStop.mockImplementation(() => {
        ranBeforeDispatchReturned = true;
        stoppedAt = Date.now();
      });
      const firedAt = Date.now();
      fire(b);
      const returnedAt = Date.now();

      // The strong claim: onStop ran INSIDE the dispatch (no microtask, no timer).
      expect(ranBeforeDispatchReturned).toBe(true);
      // The acceptance-criterion number, measured on the wall clock.
      const latencyMs = stoppedAt - firedAt;
      expect(latencyMs).toBeLessThan(200);
      expect(returnedAt - firedAt).toBeLessThan(200);
      expect(b.onStop).toHaveBeenCalledTimes(1);
      expect(b.onStop).toHaveBeenCalledWith(reason);
      expect(b.gate.active).toBe(false);

      // A second dispatch of the same event does nothing: the mic is already off.
      fire(b);
      expect(b.onStop).toHaveBeenCalledTimes(1);
    });
  }

  it("visibilitychange back to visible is NOT a stop (and never a restart)", () => {
    const b = build();
    b.gate.start();
    b.doc.dispatch("visibilitychange"); // state still "visible"
    expect(b.onStop).not.toHaveBeenCalled();
    expect(b.gate.active).toBe(true);
  });

  it("reports the stop latency for the record", () => {
    const b = build();
    b.gate.start();
    const t0 = performance.now();
    let t1 = 0;
    b.onStop.mockImplementation(() => {
      t1 = performance.now();
    });
    b.win.dispatch("blur");
    const ms = t1 - t0;
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(200);
    // Surfaced in the run output so the figure can be quoted.
    console.log(`[mic-gate] blur → onStop latency: ${ms.toFixed(3)} ms`);
  });
});

describe("mic gate: never auto-resumes", () => {
  it("focus / visible / pageshow after a stop leave the gate off", () => {
    const b = build();
    b.gate.start();
    b.win.dispatch("blur");
    expect(b.gate.active).toBe(false);
    b.win.dispatch("focus");
    b.win.dispatch("pageshow");
    b.doc.visibilityState = "visible";
    b.doc.dispatch("visibilitychange");
    expect(b.gate.active).toBe(false);
    expect(b.onStop).toHaveBeenCalledTimes(1);
  });
  it("only an explicit start() re-arms it", () => {
    const b = build();
    b.gate.start();
    b.win.dispatch("blur");
    expect(b.gate.start()).toBe(true);
    expect(b.gate.active).toBe(true);
  });
});

describe("mic gate: idle (hands-free only)", () => {
  it("push-to-talk never idles out", () => {
    const b = build();
    b.gate.start();
    expect(b.timers.pendingCount()).toBe(0);
    b.timers.advance(10 * 60_000);
    expect(b.onStop).not.toHaveBeenCalled();
    expect(b.gate.active).toBe(true);
  });
  it("hands-free stops after 60 s of silence, once", () => {
    const b = build();
    b.gate.start({ idle: true });
    b.timers.advance(59_999);
    expect(b.onStop).not.toHaveBeenCalled();
    b.timers.advance(1);
    expect(b.onStop).toHaveBeenCalledTimes(1);
    expect(b.onStop).toHaveBeenCalledWith("idle");
    expect(b.gate.active).toBe(false);
    b.timers.advance(120_000);
    expect(b.onStop).toHaveBeenCalledTimes(1);
  });
  it("touch() pushes the idle deadline back", () => {
    const b = build();
    b.gate.start({ idle: true });
    b.timers.advance(50_000);
    b.gate.touch();
    b.timers.advance(50_000); // 100 s since start, 50 s since the touch
    expect(b.onStop).not.toHaveBeenCalled();
    b.timers.advance(10_000);
    expect(b.onStop).toHaveBeenCalledWith("idle");
  });
  it("a blur stop also cancels the idle timer, so idle cannot fire a second stop", () => {
    const b = build();
    b.gate.start({ idle: true });
    b.win.dispatch("blur");
    expect(b.timers.pendingCount()).toBe(0);
    b.timers.advance(120_000);
    expect(b.onStop).toHaveBeenCalledTimes(1);
  });
});

describe("mic gate: stop() and dispose()", () => {
  it("stop() calls onStop once with the given reason and returns whether it was active", () => {
    const b = build();
    expect(b.gate.stop("release")).toBe(false); // not active yet → nothing to report
    expect(b.onStop).not.toHaveBeenCalled();
    b.gate.start();
    expect(b.gate.stop("release")).toBe(true);
    expect(b.onStop).toHaveBeenCalledWith("release");
    expect(b.gate.stop("release")).toBe(false);
    expect(b.onStop).toHaveBeenCalledTimes(1);
  });
  it("a re-entrant stop from inside onStop is a no-op", () => {
    const b = build();
    b.onStop.mockImplementation(() => {
      b.gate.stop("manual");
    });
    b.gate.start();
    b.win.dispatch("blur");
    expect(b.onStop).toHaveBeenCalledTimes(1);
  });
  it("dispose() removes every listener and the gate stays dead", () => {
    const b = build();
    expect(b.win.count() + b.doc.count()).toBe(3);
    b.gate.start({ idle: true });
    b.gate.dispose();
    expect(b.onStop).toHaveBeenCalledWith("dispose");
    expect(b.win.count() + b.doc.count()).toBe(0);
    expect(b.timers.pendingCount()).toBe(0);
    expect(b.gate.start()).toBe(false);
    b.win.dispatch("blur");
    expect(b.onStop).toHaveBeenCalledTimes(1);
  });
});

// ── Founder decision 2026-10-30: the home hero's Mic switch ──────────────────
// The stop conditions are unchanged; with the switch ON a stop for blur /
// hidden / pagehide / idle / speaking comes back once the page is visible AND
// focused again. Switch off, or no onResume (the panel): never.

function buildHero(opts: { speaking?: () => boolean } = {}) {
  const win = target();
  const doc = fakeDoc();
  const timers = fakeTimers();
  const stops: MicStopReason[] = [];
  const onStop = vi.fn((r: MicStopReason) => {
    stops.push(r);
  });
  let focused = true;
  doc.hasFocus = () => focused;
  const b = {
    win,
    doc,
    timers,
    stops,
    onStop,
    resumes: 0,
    setFocused: (f: boolean) => {
      focused = f;
    },
    gate: null as unknown as ReturnType<typeof createMicGate>,
  };
  b.gate = createMicGate({
    win,
    doc,
    onStop,
    idleMs: 60_000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    // The owner restarts capture inside onResume, as sk-shell.tsx does.
    onResume: () => {
      b.resumes++;
      b.gate.start({ idle: true });
    },
    canResume: () => !(opts.speaking?.() ?? false),
  });
  return b;
}

describe("mic gate: the Mic switch resumes (home hero, 2026-10-30)", () => {
  it("blur stops synchronously, focus brings it back while the switch is on", () => {
    const b = buildHero();
    b.gate.setAutoResume(true);
    expect(b.gate.start({ idle: true })).toBe(true);
    b.setFocused(false);
    b.win.dispatch("blur");
    expect(b.onStop).toHaveBeenCalledWith("blur");
    expect(b.gate.active).toBe(false);
    expect(b.gate.pending).toBe(true);
    b.setFocused(true);
    b.win.dispatch("focus");
    expect(b.resumes).toBe(1);
    expect(b.gate.active).toBe(true);
    expect(b.gate.pending).toBe(false);
  });

  it("hidden → visible resumes only once the window is focused too", () => {
    const b = buildHero();
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    b.doc.visibilityState = "hidden";
    b.doc.dispatch("visibilitychange");
    expect(b.stops).toEqual(["hidden"]);
    b.setFocused(false);
    b.doc.visibilityState = "visible";
    b.doc.dispatch("visibilitychange");
    expect(b.gate.active).toBe(false); // visible but not focused: still owed
    expect(b.gate.pending).toBe(true);
    b.setFocused(true);
    b.win.dispatch("focus");
    expect(b.gate.active).toBe(true);
    expect(b.resumes).toBe(1);
  });

  it("pagehide → pageshow (back/forward cache) resumes", () => {
    const b = buildHero();
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    b.win.dispatch("pagehide");
    expect(b.gate.active).toBe(false);
    b.win.dispatch("pageshow");
    expect(b.gate.active).toBe(true);
  });

  it("the 60 s idle stop stays — and nothing resumes it on a timer", () => {
    const b = buildHero();
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    b.timers.advance(60_000);
    expect(b.stops).toEqual(["idle"]);
    expect(b.gate.active).toBe(false);
    expect(b.gate.pending).toBe(true); // "Paused" in the hero
    b.timers.advance(24 * 60 * 60_000);
    expect(b.gate.active).toBe(false);
    expect(b.resumes).toBe(0);
    expect(b.timers.pendingCount()).toBe(0);
  });

  for (const ev of ["pointerdown", "keydown"] as const) {
    it(`after an idle pause, her next ${ev} on the page resumes it`, () => {
      const b = buildHero();
      b.gate.setAutoResume(true);
      b.gate.start({ idle: true });
      b.timers.advance(60_000);
      b.doc.dispatch(ev);
      expect(b.resumes).toBe(1);
      expect(b.gate.active).toBe(true);
      // A live mic ignores further interaction.
      b.doc.dispatch(ev);
      expect(b.resumes).toBe(1);
    });
  }

  it("after an idle pause, focus coming back resumes it", () => {
    const b = buildHero();
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    b.timers.advance(60_000);
    b.win.dispatch("focus");
    expect(b.gate.active).toBe(true);
  });

  it("interaction does nothing while the switch is off", () => {
    const b = buildHero();
    b.gate.start({ idle: true });
    b.timers.advance(60_000);
    b.doc.dispatch("pointerdown");
    b.doc.dispatch("keydown");
    expect(b.gate.active).toBe(false);
    expect(b.resumes).toBe(0);
  });

  it("never resumes while SK is speaking (no echo); the owed resume waits for resume()", () => {
    let speaking = true;
    const b = buildHero({ speaking: () => speaking });
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    expect(b.gate.stop("speaking")).toBe(true);
    b.win.dispatch("focus");
    expect(b.gate.active).toBe(false);
    expect(b.gate.resume()).toBe(false); // vetoed, still owed
    expect(b.gate.pending).toBe(true);
    speaking = false;
    expect(b.gate.resume()).toBe(true);
    expect(b.gate.active).toBe(true);
  });

  it("a stop she made (manual / release) is never resumed", () => {
    for (const reason of ["manual", "release"] as const) {
      const b = buildHero();
      b.gate.setAutoResume(true);
      b.gate.start({ idle: true });
      b.gate.stop(reason);
      expect(b.gate.pending).toBe(false);
      b.win.dispatch("focus");
      b.win.dispatch("pageshow");
      expect(b.gate.active).toBe(false);
      expect(b.resumes).toBe(0);
    }
  });

  it("switch OFF: never auto-resumes, and switching off forgets an owed resume", () => {
    const b = buildHero();
    b.gate.start({ idle: true });
    b.win.dispatch("blur");
    b.win.dispatch("focus");
    expect(b.gate.active).toBe(false);
    expect(b.gate.resume()).toBe(false);

    const c = buildHero();
    c.gate.setAutoResume(true);
    c.gate.start({ idle: true });
    c.win.dispatch("blur");
    expect(c.gate.pending).toBe(true);
    c.gate.setAutoResume(false);
    expect(c.gate.pending).toBe(false);
    c.gate.setAutoResume(true); // on again: nothing was owed any more
    c.win.dispatch("focus");
    expect(c.gate.active).toBe(false);
    expect(c.resumes).toBe(0);
  });

  it("resume() starts a fresh switch-on gate once the page allows it (first load in a background tab)", () => {
    const b = buildHero();
    b.gate.setAutoResume(true);
    b.setFocused(false);
    expect(b.gate.resume()).toBe(false);
    expect(b.gate.pending).toBe(true);
    b.setFocused(true);
    b.win.dispatch("focus");
    expect(b.gate.active).toBe(true);
  });

  it("the panel (no onResume) ignores setAutoResume and registers no return listeners", () => {
    const b = build();
    expect(b.win.count() + b.doc.count()).toBe(3);
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    b.win.dispatch("blur");
    b.win.dispatch("focus");
    expect(b.gate.active).toBe(false);
    expect(b.gate.resume()).toBe(false);
  });

  it("dispose removes the return listeners too", () => {
    const b = buildHero();
    expect(b.win.count() + b.doc.count()).toBe(7);
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    b.gate.dispose();
    expect(b.win.count() + b.doc.count()).toBe(0);
    expect(b.gate.resume()).toBe(false);
  });
});

// ── 2026-10-30: SK's voice must not cut out during the walkthrough ─────────

/** A provider whose sentences play until the test ends them. */
function manualVoice() {
  const pending: Array<() => void> = [];
  const played: string[] = [];
  let cancels = 0;
  const p: SpeechProvider = {
    id: "browser",
    async synthesize(text) {
      return {
        audio: null,
        format: "none",
        marks: EMPTY_MARKS,
        play: () =>
          new Promise<void>((r) =>
            pending.push(() => {
              played.push(text);
              r();
            }),
          ),
      };
    },
    cancel() {
      cancels++;
    },
  };
  return { p, pending, played, cancels: () => cancels };
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

describe("the hero mic's no-echo hold (the coordinator's WHOLE queue + a tail)", () => {
  it("between two sentences of one line the mic stays paused; it listens again SPEECH_TAIL_MS after the queue drains", async () => {
    const voice = manualVoice();
    const timers = fakeTimers();
    let coordSpeaking = () => false;
    const resumes: string[] = [];
    const hold = createSpeechHold({ isSpeaking: () => coordSpeaking(), onClear: () => resumes.push("resume"), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, now: () => 0 });
    const c = createSpeechCoordinator({ server: false, makeProvider: () => voice.p, fallback: () => voice.p, onSpeaking: (on) => hold.speaking(on) });
    coordSpeaking = () => c.speaking;
    const b = buildHero({ speaking: () => hold.holding });
    b.gate.setAutoResume(true);
    b.gate.start({ idle: true });
    const line = c.sayLine("Here is your library. Every book lives here.");
    b.gate.stop("speaking");
    await flush();
    voice.pending.shift()!(); // sentence 1 ends …
    await flush();
    // … the gap before sentence 2: still speaking, so a tap does not bring the mic back.
    expect(hold.holding).toBe(true);
    b.doc.dispatch("pointerdown");
    expect(b.gate.active).toBe(false);
    voice.pending.shift()!();
    await expect(line).resolves.toBe("spoken");
    expect(voice.played).toHaveLength(2);
    expect(voice.cancels()).toBe(0); // nothing cut the line
    // The queue drained: the tail holds the mic …
    expect(resumes).toEqual([]);
    timers.advance(SPEECH_TAIL_MS - 1);
    expect(resumes).toEqual([]);
    // … and then the owed resume is taken.
    timers.advance(1);
    expect(resumes).toEqual(["resume"]);
  });

  it("a new line inside the tail cancels the pending resume", () => {
    const timers = fakeTimers();
    let talking = false;
    const resumes: string[] = [];
    const hold = createSpeechHold({ isSpeaking: () => talking, onClear: () => resumes.push("r"), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    hold.speaking(true);
    talking = true;
    hold.speaking(false);
    talking = false;
    timers.advance(SPEECH_TAIL_MS / 2);
    hold.speaking(true);
    talking = true;
    timers.advance(SPEECH_TAIL_MS * 2);
    expect(resumes).toEqual([]);
    expect(hold.holding).toBe(true);
    hold.dispose();
  });
});

describe("hands-free dictation passes (Web Speech ends twice on an error)", () => {
  /** The Shell's hands-free loop, reduced: each end with no words restarts dictation. */
  function loop(guarded: boolean) {
    const passes = createDictationPasses();
    const live: Array<{ onText: (t: string) => void; onEnd: () => void; stopped: boolean }> = [];
    const sent: string[] = [];
    let dictated = "";
    const begin = () => {
      dictated = "";
      const h = {
        onText: (t: string) => {
          dictated = t;
        },
        onEnd: () => {
          const text = dictated.trim();
          dictated = "";
          if (text) sent.push(text);
          begin();
        },
      };
      const cb = guarded ? passes.open(h) : { id: 0, ...h };
      live.push({ onText: cb.onText, onEnd: cb.onEnd, stopped: false });
    };
    begin();
    return { live, sent, passes };
  }

  it("UNGUARDED (the old loop): onerror + onend restart twice — two recognizers, one the gate cannot stop — and a stale pass's words are sent", () => {
    const l = loop(false);
    const first = l.live[0]!;
    first.onEnd(); // onerror ("no-speech")
    first.onEnd(); // onend
    expect(l.live).toHaveLength(3); // 2 restarts from ONE recognizer's end
    // The orphan (live[1]) hears SK speaking; the current pass then ends empty.
    l.live[1]!.onText("Here is your library");
    l.live[2]!.onEnd();
    expect(l.sent).toEqual(["Here is your library"]); // SK's own words became her turn → barge-in
  });

  it("GUARDED: one end per pass, only the current pass acts, and its stale words are never sent", () => {
    const l = loop(true);
    const first = l.live[0]!;
    first.onEnd();
    first.onEnd();
    expect(l.live).toHaveLength(2); // exactly one restart
    first.onText("late words from a stopped recognizer");
    l.live[1]!.onEnd();
    expect(l.sent).toEqual([]);
  });

  it("retire() (the gate stopped the hands-free mic for SK's voice) silences the pass", () => {
    const passes = createDictationPasses();
    const got: string[] = [];
    const pass = passes.open({ onText: (t) => got.push(t), onEnd: () => got.push("end") });
    passes.retire();
    pass.onText("SK's own voice");
    pass.onEnd();
    expect(got).toEqual([]);
    expect(passes.isCurrent(pass.id)).toBe(false);
  });
});

describe("the Shell's wiring (source pins)", () => {
  const shell = readFileSync(resolve(__dirname, "..", "..", "..", "..", "app", "dashboard", "sk-shell.tsx"), "utf8").replace(/\r\n/g, "\n");
  const code = shell.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("the hero gate's veto is the hold (coordinator + tail), and the resume comes from the hold, not from the speaking flag", () => {
    expect(code).toContain("canResume: () => !(holdRef.current?.holding ?? speakingRef.current)");
    expect(code).toContain("isSpeaking: () => coord.speaking");
    expect(code).not.toMatch(/if \(speaking\) gate\.stop\("speaking"\);\s*else gate\.resume\(\);/);
  });
  it("a hands-free resume never stops SK's voice", () => {
    const listenNow = code.slice(code.indexOf("function listenNow()"), code.indexOf("useEffect(() => {\n    listenNowRef.current = listenNow;"));
    expect(listenNow).toContain("beginDictation(\"handsFree\")");
    expect(listenNow).not.toContain("stop()");
  });
  it("dictation runs through guarded passes, retired when the gate stops a hands-free capture", () => {
    expect(code).toContain("const stop = startDictation(\n      pass.onText,\n      pass.onEnd,");
    expect(code).toContain('if (micModeRef.current === "handsFree") passesRef.current.retire();');
  });
  it("the voice survives page moves and hero ↔ dock: one coordinator per Shell, stopped only by pagehide or unmount", () => {
    const eff = shell.slice(shell.indexOf("const coord = createSpeechCoordinator("), shell.indexOf("// ── the cross-page memory store"));
    expect(eff).toMatch(/\}, \[\]\);\s*$/);
    expect(eff).toContain('window.addEventListener("pagehide", onPageHide);');
    expect(eff.match(/coord\.stop\(\)/g)?.length).toBe(2); // pagehide + unmount
  });
});
