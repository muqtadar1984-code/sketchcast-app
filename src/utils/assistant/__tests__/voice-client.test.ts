/**
 * 2026-10-30 — the browser (Web Speech) dictation: continuous, ended by the
 * endpointer, restarted transparently when Chrome ends a session by itself,
 * and onEnd exactly once. A fake recogniser and a fake clock.
 * Run: node node_modules/vitest/vitest.mjs run src/utils/assistant/__tests__/voice-client.test.ts
 */
import { describe, expect, it } from "vitest";
import { startBrowserDictation, type SpeechRec, type SpeechRecResult } from "@/utils/assistant/voice-client";
import { MAX_DICTATION_MS, NO_SPEECH_MS } from "@/utils/assistant/transcribe-client";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    get pending() {
      return timers.size;
    },
  };
}

/** Chrome's recogniser, as far as dictation uses it. Each start() is a new
 *  session: its results list starts empty. stop() delivers onend (async in
 *  Chrome; synchronous here is the harder case for double-ends). */
class FakeRec implements SpeechRec {
  static all: FakeRec[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  starts = 0;
  stops = 0;
  running = false;
  results: SpeechRecResult[] = [];
  onresult: SpeechRec["onresult"] = null;
  onend: SpeechRec["onend"] = null;
  onerror: SpeechRec["onerror"] = null;
  constructor() {
    FakeRec.all.push(this);
  }
  start() {
    if (this.running) throw new Error("InvalidStateError");
    this.running = true;
    this.starts++;
    this.results = [];
  }
  stop() {
    this.stops++;
    this.end();
  }
  /** Words in this session: an interim replaces the last interim; a final stays. */
  say(transcript: string, isFinal = false) {
    const last = this.results[this.results.length - 1];
    const r = Object.assign([{ transcript }], { isFinal });
    if (last && !last.isFinal) this.results[this.results.length - 1] = r;
    else this.results.push(r);
    this.onresult?.({ results: this.results });
  }
  /** Chrome ends the session (by itself, or after stop()). */
  end() {
    if (!this.running) return;
    this.running = false;
    this.onend?.();
  }
  fail(error: string) {
    this.onerror?.({ error });
    this.end();
  }
}

function start(o: { endpointing?: boolean } = {}) {
  FakeRec.all = [];
  const clock = fakeClock();
  const texts: string[] = [];
  let ends = 0;
  const stop = startBrowserDictation((t) => texts.push(t), () => ends++, { lang: "en-US", Recognition: FakeRec, clock, ...o });
  return { clock, texts, ends: () => ends, stop: stop!, rec: FakeRec.all[0]! };
}

describe("startBrowserDictation (Web Speech)", () => {
  it("continuous with interim results, in the asked language", () => {
    const { rec } = start();
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe("en-US");
    expect(rec.starts).toBe(1);
  });

  it("a pause mid-sentence is NOT the end: the turn ends after the endpointer's silence, words joined", () => {
    const { clock, texts, ends, rec } = start();
    rec.say("I want to know about photosynthesis");
    rec.say("I want to know about photosynthesis and", true);
    clock.advance(2000); // hesitation after "and" (2.5 s grace)
    expect(ends()).toBe(0);
    rec.say(" why plants need light", true);
    clock.advance(1499);
    expect(ends()).toBe(0);
    clock.advance(1);
    expect(rec.stops).toBe(1);
    expect(ends()).toBe(1);
    expect(texts.at(-1)).toBe("I want to know about photosynthesis and why plants need light");
  });

  it("Chrome ending the session by itself mid-turn: restarted transparently, earlier words kept, ONE onEnd", () => {
    const { clock, texts, ends, rec } = start();
    rec.say("what is osmosis", true);
    rec.end(); // Chrome's own end (a quiet spell, or ~1 min)
    expect(ends()).toBe(0);
    expect(rec.starts).toBe(2);
    rec.say("in plant cells", true);
    expect(texts.at(-1)).toBe("what is osmosis in plant cells");
    clock.advance(1500);
    expect(ends()).toBe(1);
    expect(rec.starts).toBe(2);
    expect(clock.pending).toBe(0);
  });

  it("Chrome ending again and again with no words: gives up after a few restarts (no spin)", () => {
    const { ends, rec } = start();
    for (let i = 0; i < 10 && rec.running; i++) rec.end();
    expect(rec.starts).toBe(4); // the first + 3 restarts
    expect(ends()).toBe(1);
  });

  it("an error then onend (Web Speech's double end) → onEnd ONCE, no restart", () => {
    const a = start();
    a.rec.say("half a", false);
    a.rec.fail("network");
    expect(a.ends()).toBe(1);
    expect(a.rec.starts).toBe(1);
    const b = start();
    b.rec.fail("no-speech");
    expect(b.ends()).toBe(1);
    expect(b.rec.starts).toBe(1);
    const c = start();
    c.rec.fail("not-allowed");
    expect(c.ends()).toBe(1);
  });

  it("stop(): ends now, words kept, once — even called twice, or after the turn already ended", () => {
    const { clock, texts, ends, rec, stop } = start();
    rec.say("tell me about", false);
    stop();
    stop();
    expect(ends()).toBe(1);
    expect(rec.starts).toBe(1);
    expect(texts).toEqual(["tell me about"]);
    clock.advance(MAX_DICTATION_MS);
    expect(ends()).toBe(1);
  });

  it("nothing heard: the no-speech timeout ends it, as before", () => {
    const { clock, ends, rec } = start();
    clock.advance(NO_SPEECH_MS - 1);
    expect(ends()).toBe(0);
    clock.advance(1);
    expect(rec.stops).toBe(1);
    expect(ends()).toBe(1);
  });

  it("push-to-talk (endpointing off): long pauses never end it; Chrome's own ends restart; stop() ends it", () => {
    const { clock, ends, rec, stop, texts } = start({ endpointing: false });
    rec.say("what is osmosis.", true);
    clock.advance(10_000);
    rec.end();
    expect(rec.starts).toBe(2);
    rec.say("and diffusion", true);
    clock.advance(10_000);
    expect(ends()).toBe(0);
    stop();
    expect(ends()).toBe(1);
    expect(texts.at(-1)).toBe("what is osmosis. and diffusion");
  });

  it("the hard cap still ends a turn that never pauses", () => {
    const { clock, ends, rec } = start({ endpointing: false });
    rec.say("talking", true);
    clock.advance(MAX_DICTATION_MS);
    expect(ends()).toBe(1);
  });
});
