/**
 * SK's voice coordinator (§2.6 lifecycle 2, S1 slice E): queue order, the
 * pause/resume rule against the Board's video, barge-in, provider selection
 * with the sticky browser fallback, the read-aloud toggle and sentence
 * splitting. Everything runs on fakes — no speechSynthesis, no fetch.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/speech.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { createSpeechCoordinator, SERVER_FAILURES_TO_STICK, speechMode, splitSentences, type SpeechBoard } from "../speech";
import type { PlayOpts, SpeechProvider, SpeechResult } from "@/sk/speech/provider";
import { EMPTY_MARKS } from "@/sk/speech/provider";
import { SpeakUnavailable } from "@/sk/speech/polly-client";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** Let every queued microtask and timer settle. */
async function settle(n = 6) {
  for (let i = 0; i < n; i++) await tick();
}

type Pending = { text: string; finish: () => void; abort: () => void };

/** A provider whose lines play until the test finishes them (or instantly). */
function fakeProvider(id: string, opts: { manual?: boolean; fail?: (text: string, n: number) => Error | null } = {}) {
  const spoken: string[] = []; // synthesize() calls, in order
  const played: string[] = []; // lines whose play() completed
  const cancels: string[] = [];
  const pending: Pending[] = [];
  let n = 0;
  const p: SpeechProvider & { spoken: string[]; played: string[]; cancels: string[]; pending: Pending[]; log: string[] } = {
    id,
    spoken,
    played,
    cancels,
    pending,
    log: [],
    async synthesize(text): Promise<SpeechResult> {
      spoken.push(text);
      p.log.push(`${id}:${text}`);
      const err = opts.fail?.(text, ++n);
      if (err) throw err;
      return {
        audio: null,
        format: "none",
        marks: EMPTY_MARKS,
        play: (o?: PlayOpts) =>
          new Promise<void>((resolve) => {
            o?.onWord?.({ charIndex: 0, t: 1 });
            const done = () => {
              const i = pending.findIndex((x) => x.text === text);
              if (i >= 0) pending.splice(i, 1);
              resolve();
            };
            if (!opts.manual) {
              played.push(text);
              done();
              return;
            }
            pending.push({
              text,
              finish: () => {
                played.push(text);
                done();
              },
              abort: done,
            });
          }),
      };
    },
    cancel() {
      cancels.push("cancel");
      for (const x of pending.splice(0, pending.length)) x.abort();
    },
  };
  return p;
}

function fakeBoard(playing: boolean) {
  const b: SpeechBoard & { playing: boolean; pauses: number; resumes: number; log: string[] } = {
    playing,
    pauses: 0,
    resumes: 0,
    log: [],
    isPlaying: () => b.playing,
    pause: async () => {
      b.pauses++;
      b.playing = false;
      b.log.push("pause");
    },
    resume: async () => {
      b.resumes++;
      b.playing = true;
      b.log.push("resume");
    },
  };
  return b;
}

function rig(opts: { server?: boolean; board?: SpeechBoard | null; manual?: boolean; serverFail?: (t: string, n: number) => Error | null; onSpeaking?: (s: boolean) => void; onFallback?: (w: string) => void } = {}) {
  const browser = fakeProvider("browser", { manual: opts.manual });
  const polly = fakeProvider("polly-client", { manual: opts.manual, fail: opts.serverFail });
  const makeProvider = vi.fn(() => polly);
  const fallback = vi.fn(() => browser);
  const c = createSpeechCoordinator({
    server: opts.server ?? false,
    makeProvider,
    fallback,
    board: opts.board ?? null,
    defaultLang: "en-US",
    onSpeaking: opts.onSpeaking,
    onFallback: opts.onFallback,
  });
  return { c, browser, polly, makeProvider, fallback };
}

describe("speechMode", () => {
  it("is polly only for NEXT_PUBLIC_SK_TTS=polly (any case); unset/other → browser", () => {
    expect(speechMode("polly")).toBe("polly");
    expect(speechMode(" Polly ")).toBe("polly");
    expect(speechMode(undefined)).toBe("browser");
    expect(speechMode(null)).toBe("browser");
    expect(speechMode("")).toBe("browser");
    expect(speechMode("browser")).toBe("browser");
    expect(speechMode("edge")).toBe("browser");
  });
});

describe("splitSentences", () => {
  it("splits on . ! ? like StreamSpeaker, plus the Arabic ؟ and the danda", () => {
    expect(splitSentences("One. Two! Three? Four")).toEqual(["One.", "Two!", "Three?", "Four"]);
    expect(splitSentences("ما هو الانتشار؟ هو حركة الجزيئات.")).toEqual(["ما هو الانتشار؟", "هو حركة الجزيئات."]);
    expect(splitSentences("यह क्या है। यह कोशिका है।")).toEqual(["यह क्या है।", "यह कोशिका है।"]);
  });
  it("strips markdown through speakableText and drops markup-only sentences", () => {
    expect(splitSentences("**Diffusion** is *net* movement. ---")).toEqual(["Diffusion is net movement."]);
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });
  it("does not split inside a sentence (no whitespace after the mark)", () => {
    expect(splitSentences("Version 2.5 of the kit. Done.")).toEqual(["Version 2.5 of the kit.", "Done."]);
  });
});

describe("queue", () => {
  it("speaks lines in order across say() calls and resolves each say when ITS lines are done", async () => {
    const { c, browser } = rig({ manual: true });
    const order: string[] = [];
    const a = c.say("A one. A two.").then(() => order.push("a"));
    const b = c.say("B one!").then(() => order.push("b"));
    await settle();
    expect(browser.spoken).toEqual(["A one."]);
    browser.pending[0]!.finish();
    await settle();
    expect(browser.spoken).toEqual(["A one.", "A two."]);
    expect(order).toEqual([]);
    browser.pending[0]!.finish();
    await settle();
    expect(order).toEqual(["a"]);
    expect(browser.spoken).toEqual(["A one.", "A two.", "B one!"]);
    browser.pending[0]!.finish();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect(browser.played).toEqual(["A one.", "A two.", "B one!"]);
  });

  it("reports speaking while the queue runs and quiet once it drains", async () => {
    const states: boolean[] = [];
    const { c, browser } = rig({ manual: true, onSpeaking: (s) => states.push(s) });
    const p = c.say("Hello.");
    await settle();
    expect(states).toEqual([true]);
    expect(c.speaking).toBe(true);
    browser.pending[0]!.finish();
    await p;
    await settle();
    expect(states).toEqual([true, false]);
    expect(c.speaking).toBe(false);
  });

  it("stream(): whole sentences go as they complete; flush speaks the tail", async () => {
    const { c, browser } = rig();
    const s = c.stream();
    s.push("Diffusion is the net ");
    s.push("movement of particles. From high to ");
    await settle();
    expect(browser.spoken).toEqual(["Diffusion is the net movement of particles."]);
    s.push("low concentration");
    await s.flush();
    expect(browser.spoken).toEqual(["Diffusion is the net movement of particles.", "From high to low concentration"]);
  });

  it("say('') and markup-only text resolve at once and speak nothing", async () => {
    const { c, browser } = rig();
    await c.say("");
    await c.say("---");
    expect(browser.spoken).toEqual([]);
  });
});

describe("the Board's video", () => {
  it("playing → paused ONCE before the first line, resumed ONCE after the last line of the whole queue", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board, manual: true });
    const a = c.say("First. Second.");
    const b = c.say("Third.");
    await settle();
    expect(board.pauses).toBe(1);
    expect(board.playing).toBe(false);
    expect(browser.spoken).toEqual(["First."]);
    browser.pending[0]!.finish();
    await settle();
    expect(board.resumes).toBe(0);
    browser.pending[0]!.finish();
    await settle();
    expect(board.resumes).toBe(0); // "Third." still queued
    browser.pending[0]!.finish();
    await Promise.all([a, b]);
    await settle();
    expect(board.pauses).toBe(1);
    expect(board.resumes).toBe(1);
    expect(board.playing).toBe(true);
    expect(board.log).toEqual(["pause", "resume"]);
  });

  it("already paused by the teacher → never paused again, never resumed", async () => {
    const board = fakeBoard(false);
    const { c } = rig({ board });
    await c.say("A line. Another.");
    await settle();
    expect(board.pauses).toBe(0);
    expect(board.resumes).toBe(0);
    expect(board.playing).toBe(false);
  });

  it("the teacher restarts the video while SK talks → SK neither re-pauses nor resumes", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board, manual: true });
    const p = c.say("One. Two. Three.");
    await settle();
    expect(board.pauses).toBe(1);
    board.playing = true; // the teacher pressed play on the Board
    browser.pending[0]!.finish();
    await settle();
    expect(board.pauses).toBe(1); // not paused again
    expect(board.playing).toBe(true);
    browser.pending[0]!.finish();
    await settle();
    browser.pending[0]!.finish();
    await p;
    await settle();
    expect(board.resumes).toBe(0);
    expect(board.playing).toBe(true);
    // The next ask is a new claim: SK pauses for it and gives it back.
    const later = c.say("Later.");
    await settle();
    expect(board.log).toEqual(["pause", "pause"]);
    browser.pending[0]!.finish();
    await later;
    await settle();
    expect(board.log).toEqual(["pause", "pause", "resume"]);
  });

  it("the teacher paused during SK's speech via SK's own pause move → not resumed", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board, manual: true });
    const answer = c.say("Here is the answer. It has two parts.");
    await settle();
    expect(board.pauses).toBe(1);
    // "Stop there." arrives as a `board` event with move `pause` while SK is mid-answer.
    const move = c.announceMove("Pausing.", async () => {
      board.log.push("move:pause");
      board.playing = false;
      return { ok: true };
    });
    browser.pending[0]!.finish();
    await settle();
    browser.pending[0]!.finish();
    await settle();
    browser.pending[0]!.finish();
    await Promise.all([answer, move]);
    await settle();
    expect(board.resumes).toBe(0);
    expect(board.playing).toBe(false);
  });

  it("announceMove: pause → line → move, in that order, and no resume after a slide", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board });
    const r = await c.announceMove("Here is slide four.", async () => {
      board.log.push("move:slide");
      return { ok: true, summary: "Slide 4." };
    });
    await settle();
    expect(r).toEqual({ ok: true, summary: "Slide 4." });
    expect(browser.played).toEqual(["Here is slide four."]);
    expect(board.log).toEqual(["pause", "move:slide"]);
    expect(board.resumes).toBe(0);
    expect(board.playing).toBe(false);
  });

  it("announceMove with a PLAYING move (intro/segment/resume): no pause/resume fight afterwards", async () => {
    const board = fakeBoard(false);
    const { c, browser } = rig({ board });
    await c.announceMove("From the start.", async () => {
      board.log.push("move:intro");
      board.playing = true;
      return { ok: true, plays: true };
    });
    await settle();
    expect(board.log).toEqual(["move:intro"]);
    expect(board.pauses).toBe(0);
    expect(board.resumes).toBe(0);
    expect(board.playing).toBe(true);
    // A later aside while the video the move started plays: pause, speak, give it back.
    await c.say("Watch the membrane here.");
    await settle();
    expect(board.log).toEqual(["move:intro", "pause", "resume"]);
    expect(browser.played).toEqual(["From the start.", "Watch the membrane here."]);
  });

  it("announceMove pauses the video even with nothing to say (read-aloud off)", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board });
    c.setEnabled(false);
    await c.announceMove("Freezing.", async () => board.log.push("move:freeze"));
    expect(browser.spoken).toEqual([]);
    expect(board.log).toEqual(["pause", "move:freeze"]);
    expect(board.resumes).toBe(0);
  });

  it("a text line queued behind a move's line does not resume once the move has run", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board, manual: true });
    const move = c.announceMove("Slide two.", async () => {
      board.log.push("move:slide");
      return { ok: true };
    });
    const tail = c.say("Any questions?");
    await settle();
    browser.pending[0]!.finish(); // "Slide two." → the move runs
    await settle();
    await move;
    browser.pending[0]!.finish(); // "Any questions?"
    await tail;
    await settle();
    expect(board.log).toEqual(["pause", "move:slide"]);
    expect(board.resumes).toBe(0);
  });
});

describe("barge-in: stop()", () => {
  it("cancels the provider, clears the queue, resolves every pending say and does NOT resume the video", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board, manual: true });
    const a = c.say("One. Two.");
    const b = c.say("Three.");
    await settle();
    expect(browser.spoken).toEqual(["One."]);
    expect(board.pauses).toBe(1);
    c.stop();
    await Promise.all([a, b]);
    await settle();
    expect(browser.cancels).toEqual(["cancel"]);
    expect(browser.spoken).toEqual(["One."]); // Two and Three never reached the voice
    expect(browser.played).toEqual([]);
    expect(board.resumes).toBe(0);
    expect(board.playing).toBe(false);
    expect(c.speaking).toBe(false);
    // Speech after a stop works again (a fresh generation).
    const back = c.say("Back.");
    await settle();
    expect(browser.spoken).toEqual(["One.", "Back."]);
    browser.pending[0]!.finish();
    await back;
  });

  it("a request aborted by stop() is not a provider failure: no browser fallback, server still asked next time", async () => {
    let abortNext: (() => void) | null = null;
    const polly: SpeechProvider & { spoken: string[] } = {
      id: "polly-client",
      spoken: [],
      synthesize(text) {
        polly.spoken.push(text);
        return new Promise<SpeechResult>((_, reject) => {
          abortNext = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      },
      cancel() {
        abortNext?.();
      },
    };
    const browser = fakeProvider("browser");
    const c = createSpeechCoordinator({ server: true, makeProvider: () => polly, fallback: () => browser });
    const p = c.say("Hello there.");
    await settle();
    expect(polly.spoken).toEqual(["Hello there."]);
    c.stop();
    await p;
    await settle();
    expect(browser.spoken).toEqual([]);
    expect(c.mode).toBe("polly");
  });
});

describe("provider selection", () => {
  it("server: false never builds the server provider", async () => {
    const { c, browser, makeProvider } = rig({ server: false });
    await c.say("Hi.");
    expect(makeProvider).not.toHaveBeenCalled();
    expect(browser.spoken).toEqual(["Hi."]);
    expect(c.mode).toBe("browser");
  });

  it("server: true speaks through the server provider and never touches the browser while it works", async () => {
    const { c, browser, polly, fallback } = rig({ server: true });
    await c.say("Hi. There.");
    expect(polly.played).toEqual(["Hi.", "There."]);
    expect(browser.spoken).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
    expect(c.mode).toBe("polly");
  });

  it("SpeakUnavailable (404 = SK_TTS unset) → the browser speaks THIS line and every later one; the server is not asked again", async () => {
    const why: string[] = [];
    const { c, browser, polly } = rig({ server: true, serverFail: () => new SpeakUnavailable(), onFallback: (w) => why.push(w) });
    await c.say("First.");
    await c.say("Second.");
    expect(polly.spoken).toEqual(["First."]);
    expect(browser.played).toEqual(["First.", "Second."]);
    expect(why).toEqual(["unavailable"]);
    expect(c.mode).toBe("browser");
  });

  it("another error (502, network, autoplay) falls back for that line only; the server is asked again", async () => {
    const { c, browser, polly } = rig({ server: true, serverFail: (_t, n) => (n === 1 ? new Error("speak: HTTP 502") : null) });
    await c.say("First.");
    await c.say("Second.");
    expect(polly.spoken).toEqual(["First.", "Second."]);
    expect(polly.played).toEqual(["Second."]);
    expect(browser.played).toEqual(["First."]);
    expect(c.mode).toBe("polly");
  });

  it(`${SERVER_FAILURES_TO_STICK} such errors in a row make the browser sticky; a success in between resets the count`, async () => {
    const why: string[] = [];
    // fail, ok, fail, fail, fail → sticks on the third consecutive failure
    const plan = [true, false, true, true, true];
    const { c, browser, polly } = rig({ server: true, serverFail: (_t, n) => (plan[n - 1] ? new Error("speak: HTTP 502") : null), onFallback: (w) => why.push(w) });
    for (const l of ["L1.", "L2.", "L3.", "L4.", "L5.", "L6."]) await c.say(l);
    expect(polly.spoken).toEqual(["L1.", "L2.", "L3.", "L4.", "L5."]);
    expect(browser.played).toEqual(["L1.", "L3.", "L4.", "L5.", "L6."]);
    expect(why).toEqual(["failing"]);
    expect(c.mode).toBe("browser");
  });

  it("builds one provider per language and hands the language to both factories", async () => {
    const langs: string[] = [];
    const c = createSpeechCoordinator({
      server: false,
      makeProvider: () => fakeProvider("polly-client"),
      fallback: (lang) => {
        langs.push(lang);
        return fakeProvider("browser");
      },
      defaultLang: "en-US",
    });
    await c.say("Hello.");
    await c.say("Hello again.");
    await c.say("مرحبا.", { lang: "ar-SA" });
    expect(langs).toEqual(["en-US", "ar-SA"]);
  });

  it("asks the voice resolver by provider id and language, and passes word marks through", async () => {
    const words: Array<{ charIndex: number; text: string }> = [];
    const asked: string[] = [];
    const browser = fakeProvider("browser");
    const c = createSpeechCoordinator({
      server: false,
      makeProvider: () => fakeProvider("polly-client"),
      fallback: () => browser,
      defaultLang: "ms-MY",
      voice: (id, lang) => {
        asked.push(`${id}/${lang}`);
        return "browser:Rishi";
      },
      onWord: (w) => words.push({ charIndex: w.charIndex, text: w.text }),
    });
    await c.say("Selamat pagi.");
    expect(asked).toEqual(["browser/ms-MY"]);
    expect(words).toEqual([{ charIndex: 0, text: "Selamat pagi." }]);
  });
});

describe("read-aloud toggle", () => {
  it("setEnabled(false): say resolves at once, nothing is spoken, the video is never paused", async () => {
    const board = fakeBoard(true);
    const { c, browser } = rig({ board });
    c.setEnabled(false);
    expect(c.enabled).toBe(false);
    await c.say("Silent line.");
    const s = c.stream();
    s.push("Also silent. ");
    await s.flush();
    expect(browser.spoken).toEqual([]);
    expect(board.pauses).toBe(0);
    expect(board.playing).toBe(true);
  });

  it("setEnabled(true) afterwards speaks again", async () => {
    const { c, browser } = rig();
    c.setEnabled(false);
    await c.say("No.");
    c.setEnabled(true);
    await c.say("Yes.");
    expect(browser.spoken).toEqual(["Yes."]);
  });
});
