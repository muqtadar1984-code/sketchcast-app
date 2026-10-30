/**
 * The browser voice (window.speechSynthesis) — 2026-10-30 regression: SK's
 * voice cut out mid-line during the walkthrough and stayed silent. Chrome
 * drops a speak() that follows a cancel() too closely, with no event at all;
 * the provider cancelled before EVERY sentence and waited for ever on a
 * sentence that never started, holding SK's queue (and the tour) behind it.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/speech/__tests__/browser.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_START_TIMEOUT_MS, BrowserSpeechProvider } from "../browser";

type FakeU = { text: string; onstart?: () => void; onend?: () => void; onerror?: () => void; onboundary?: unknown; lang?: string; rate?: number; voice?: unknown };

function fakeSynth(opts: { dropAfterCancel?: boolean } = {}) {
  const spoken: FakeU[] = [];
  let cancels = 0;
  let lastCancelAt = -1;
  let now = 0;
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => [],
    cancel() {
      cancels++;
      lastCancelAt = now;
      const cur = spoken[spoken.length - 1];
      if (synth.speaking && cur) {
        synth.speaking = false;
        cur.onerror?.();
      }
    },
    speak(u: FakeU) {
      spoken.push(u);
      // Chrome's bug: a speak() in the same tick as a cancel() is dropped silently.
      if (opts.dropAfterCancel && lastCancelAt === now) return;
      synth.speaking = true;
      u.onstart?.();
    },
    tick() {
      now++;
    },
    end() {
      const cur = spoken[spoken.length - 1];
      synth.speaking = false;
      cur?.onend?.();
    },
    get cancels() {
      return cancels;
    },
    spoken,
  };
  return synth;
}

let synth: ReturnType<typeof fakeSynth>;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function install(s: ReturnType<typeof fakeSynth>) {
  synth = s;
  vi.stubGlobal("window", { speechSynthesis: s });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      constructor(t: string) {
        this.text = t;
      }
    },
  );
}

describe("BrowserSpeechProvider", () => {
  it("does not cancel the engine before a sentence when nothing is speaking (the cancel→speak drop)", async () => {
    install(fakeSynth({ dropAfterCancel: true }));
    const p = new BrowserSpeechProvider("en-US");
    const r1 = await p.synthesize("One.", "browser:default", { marks: [] });
    const a = r1.play!();
    expect(synth.speaking).toBe(true); // started: no cancel ahead of it
    synth.end();
    await a;
    synth.tick();
    const r2 = await p.synthesize("Two.", "browser:default", { marks: [] });
    const b = r2.play!();
    expect(synth.speaking).toBe(true);
    synth.end();
    await b;
    expect(synth.cancels).toBe(0);
  });

  it("a sentence that never starts fails after the start timeout instead of hanging for ever", async () => {
    install(fakeSynth({ dropAfterCancel: true }));
    const p = new BrowserSpeechProvider("en-US");
    const r1 = await p.synthesize("One.", "browser:default", { marks: [] });
    void r1.play!(); // speaking …
    const r2 = await p.synthesize("Two.", "browser:default", { marks: [] });
    const b = r2.play!(); // … so this one cancels first, in the same tick: Chrome drops it
    const settled = b.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(BROWSER_START_TIMEOUT_MS + 10);
    await expect(settled).resolves.toMatch(/never started/);
  });
});
