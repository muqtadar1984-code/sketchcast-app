/**
 * SK's voice coordinator (§2.6 lifecycle 2, S1 slice E): queue order, the
 * pause/resume rule against the Board's video, barge-in, provider selection
 * with the sticky browser fallback, the read-aloud toggle and sentence
 * splitting. Everything runs on fakes — no speechSynthesis, no fetch.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/speech.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechCoordinator, PREFETCH_AHEAD, SERVER_FAILURES_TO_STICK, serverProviderFor, speechMode, splitSentences, type SpeechBoard } from "../speech";
import type { PlayOpts, SpeechProvider, SpeechResult } from "@/sk/speech/provider";
import { EMPTY_MARKS } from "@/sk/speech/provider";
import { BrowserSpeechProvider } from "@/sk/speech/browser";
import { PollyClientSpeechProvider, SpeakUnavailable } from "@/sk/speech/polly-client";

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
  it("is google for NEXT_PUBLIC_SK_TTS=google (any case)", () => {
    expect(speechMode("google")).toBe("google");
    expect(speechMode(" GOOGLE ")).toBe("google");
  });
});

describe("server provider per language", () => {
  it("polly: English through the server client (no lang sent), any other language through the browser", () => {
    const en = serverProviderFor("polly", "en-US", () => "B");
    expect(en).toBeInstanceOf(PollyClientSpeechProvider);
    expect((en as PollyClientSpeechProvider).lang).toBeUndefined();
    expect(serverProviderFor("polly", "ar-SA", () => "B")).toBeInstanceOf(BrowserSpeechProvider);
  });
  it("google: every language through the server client, carrying its lang", () => {
    for (const lang of ["en-US", "ar-SA", "ms-MY", "zh-CN", "hi-IN"]) {
      const p = serverProviderFor("google", lang, () => "A");
      expect(p).toBeInstanceOf(PollyClientSpeechProvider);
      expect((p as PollyClientSpeechProvider).lang).toBe(lang);
    }
  });
});

describe("server client (POST /api/sk/speak)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  function route(status: number, body: unknown) {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return bodies;
  }
  const OK = { format: "mp3", audio: Buffer.from([1, 2, 3]).toString("base64"), marks: { words: [{ i: 0, t0: 0, t1: 100, text: "Hi" }], visemes: [] }, voice: "google:ar-XA-Chirp3-HD-Achird" };

  it("sends the line's lang with the look; without a lang the body is unchanged", async () => {
    const bodies = route(200, OK);
    const r = await new PollyClientSpeechProvider(() => "A", { lang: "ar-SA" }).synthesize("Hi", "google:ar-XA-Chirp3-HD-Achernar", { marks: ["word"] });
    await new PollyClientSpeechProvider(() => "B").synthesize("Hi", "polly:Matthew", { marks: ["word"] });
    expect(bodies).toEqual([
      { text: "Hi", look: "A", lang: "ar-SA" },
      { text: "Hi", look: "B" },
    ]);
    expect(r.format).toBe("mp3");
    expect(r.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.marks).toEqual({ words: [{ i: 0, t0: 0, t1: 100, text: "Hi" }], visemes: [] });
  });
  it("2026-10-30: a second request does not cancel the first (the next sentence is fetched while one plays); cancel() aborts both", async () => {
    const signals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const sig = init!.signal!;
          signals.push(sig);
          sig.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          releases.push(() => resolve(new Response(JSON.stringify(OK), { status: 200 })));
        }),
    ) as unknown as typeof fetch;
    const p = new PollyClientSpeechProvider(() => "A", { lang: "mr-IN" });
    const one = p.synthesize("एक.", "x", { marks: [] });
    const two = p.synthesize("दोन.", "x", { marks: [] });
    expect(signals.map((x) => x.aborted)).toEqual([false, false]);
    releases[0]!();
    releases[1]!();
    await expect(one).resolves.toMatchObject({ format: "mp3" });
    await expect(two).resolves.toMatchObject({ format: "mp3" });
    const three = p.synthesize("तीन.", "x", { marks: [] });
    const four = p.synthesize("चार.", "x", { marks: [] });
    p.cancel();
    await expect(three).rejects.toMatchObject({ name: "AbortError" });
    await expect(four).rejects.toMatchObject({ name: "AbortError" });
    // The caller's own signal aborts its request too.
    const ac = new AbortController();
    const five = p.synthesize("पाच.", "x", { marks: [], signal: ac.signal });
    ac.abort();
    await expect(five).rejects.toMatchObject({ name: "AbortError" });
  });
  it("404 and 429 tts_cap are SpeakUnavailable; any other 429 or a 503 is an ordinary failure", async () => {
    const p = new PollyClientSpeechProvider(() => "B", { lang: "en-US" });
    route(404, { error: "Not available." });
    await expect(p.synthesize("Hi", "x", { marks: [] })).rejects.toMatchObject({ name: "SpeakUnavailable", reason: "off" });
    route(429, { error: "Monthly voice limit reached.", reason: "tts_cap" });
    await expect(p.synthesize("Hi", "x", { marks: [] })).rejects.toMatchObject({ name: "SpeakUnavailable", reason: "tts_cap" });
    route(429, { error: "slow down" });
    await expect(p.synthesize("Hi", "x", { marks: [] })).rejects.toThrow("speak: HTTP 429");
    route(503, { error: "Speech is unavailable right now.", reason: "tts_meter" });
    await expect(p.synthesize("Hi", "x", { marks: [] })).rejects.toThrow("speak: HTTP 503");
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

  it("google mode: reported as google while asked; the monthly cap (tts_cap) makes the browser sticky like a 404", async () => {
    const why: string[] = [];
    const browser = fakeProvider("browser");
    const google = fakeProvider("polly-client", { fail: (_t, n) => (n === 2 ? new SpeakUnavailable("tts_cap") : null) });
    const c = createSpeechCoordinator({ server: true, serverMode: "google", makeProvider: () => google, fallback: () => browser, onFallback: (w) => why.push(w) });
    await c.say("One.");
    expect(c.mode).toBe("google");
    await c.say("Two.");
    await c.say("Three.");
    expect(google.spoken).toEqual(["One.", "Two."]);
    expect(browser.played).toEqual(["Two.", "Three."]);
    expect(why).toEqual(["unavailable"]);
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

// ── 2026-10-30: no gap — the next sentences' audio is fetched while one plays ──

/** A server provider whose requests resolve when the test says so, and whose
 *  lines play until the test finishes them. Records every request's signal. */
function slowServer(id = "polly-client") {
  type Req = { text: string; lang: string; signal?: AbortSignal; resolve: () => void; reject: (e: Error) => void };
  const requests: Req[] = [];
  const playing: Array<{ text: string; finish: () => void }> = [];
  const played: string[] = [];
  const cancels: number[] = [];
  const make = (lang: string): SpeechProvider => ({
    id,
    synthesize(text, _voice, opts) {
      return new Promise<SpeechResult>((resolve, reject) => {
        const r: Req = {
          text,
          lang,
          signal: opts.signal,
          reject,
          resolve: () =>
            resolve({
              audio: new Uint8Array([1]),
              format: "mp3",
              marks: EMPTY_MARKS,
              play: () =>
                new Promise<void>((done) => {
                  const me = {
                    text,
                    finish: () => {
                      const i = playing.indexOf(me);
                      if (i >= 0) playing.splice(i, 1);
                      played.push(text);
                      done();
                    },
                  };
                  playing.push(me);
                }),
            }),
        };
        opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        requests.push(r);
      });
    },
    cancel() {
      cancels.push(1);
      for (const p of [...playing]) p.finish();
    },
  });
  const req = (text: string) => requests.find((r) => r.text === text)!;
  return { make, requests, playing, played, cancels, req };
}

describe("prefetch: the next sentence is ready when this one ends", () => {
  it("asks for the first sentence the moment it is complete in the stream, before the pump runs", () => {
    const s = slowServer();
    const c = createSpeechCoordinator({ server: true, makeProvider: s.make, fallback: () => fakeProvider("browser") });
    const st = c.stream({ lang: "mr-IN" });
    st.push("प्रकाशसंश्लेषण ही एक प्रक्रिया आहे. ");
    // Synchronously — no tick has passed.
    expect(s.requests.map((r) => [r.text, r.lang])).toEqual([["प्रकाशसंश्लेषण ही एक प्रक्रिया आहे.", "mr-IN"]]);
  });

  it(`while sentence 1 plays, the next ${PREFETCH_AHEAD} are fetched (in order) and no more; each is played in order`, async () => {
    const s = slowServer();
    const c = createSpeechCoordinator({ server: true, makeProvider: s.make, fallback: () => fakeProvider("browser") });
    const done = c.say("One. Two. Three. Four. Five.");
    // At once: sentence 1 and the PREFETCH_AHEAD after it (1 + 2 = 3 requests).
    expect(s.requests.map((r) => r.text)).toEqual(["One.", "Two.", "Three."]);
    s.req("One.").resolve();
    await settle();
    expect(s.playing.map((p) => p.text)).toEqual(["One."]);
    // Sentence 2's audio arrives DURING sentence 1: nothing waits for it later.
    s.req("Two.").resolve();
    s.req("Three.").resolve();
    await settle();
    expect(s.requests.map((r) => r.text)).toEqual(["One.", "Two.", "Three."]);
    s.playing[0]!.finish();
    await settle();
    // Two plays at once (its audio was already there), and Four is now fetched.
    expect(s.playing.map((p) => p.text)).toEqual(["Two."]);
    expect(s.requests.map((r) => r.text)).toEqual(["One.", "Two.", "Three.", "Four."]);
    s.playing[0]!.finish();
    await settle();
    expect(s.requests.map((r) => r.text)).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
    // A later sentence's audio arriving FIRST never plays out of order.
    s.req("Five.").resolve();
    await settle();
    expect(s.playing.map((p) => p.text)).toEqual(["Three."]);
    s.playing[0]!.finish();
    await settle();
    expect(s.playing).toEqual([]); // Four's audio is not here yet: Four waits, Five waits behind it
    s.req("Four.").resolve();
    await settle();
    s.playing[0]!.finish();
    await settle();
    s.playing[0]!.finish();
    await done;
    expect(s.played).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
  });

  it("a language change costs nothing extra: each line goes to its own language's provider, fetched ahead the same way", async () => {
    const s = slowServer();
    const langs: string[] = [];
    const c = createSpeechCoordinator({
      server: true,
      makeProvider: (l) => {
        langs.push(l);
        return s.make(l);
      },
      fallback: () => fakeProvider("browser"),
    });
    void c.say("Hello.", { lang: "en-US" });
    void c.say("नमस्कार. कसे आहात?", { lang: "mr-IN" });
    expect(s.requests.map((r) => [r.text, r.lang])).toEqual([
      ["Hello.", "en-US"],
      ["नमस्कार.", "mr-IN"],
      ["कसे आहात?", "mr-IN"],
    ]);
    expect(langs).toEqual(["en-US", "mr-IN"]);
  });

  it("barge-in: stop() aborts every prefetch, plays none of them, and asks for nothing more", async () => {
    const s = slowServer();
    const browser = fakeProvider("browser");
    const c = createSpeechCoordinator({ server: true, makeProvider: s.make, fallback: () => browser });
    const done = c.say("One. Two. Three. Four.");
    s.req("One.").resolve();
    s.req("Two.").resolve(); // already fetched, never played
    await settle();
    expect(s.playing.map((p) => p.text)).toEqual(["One."]);
    c.stop();
    await done;
    await settle();
    expect(s.requests.map((r) => [r.text, !!r.signal?.aborted])).toEqual([
      ["One.", false], // its audio had arrived; the provider's cancel() stopped it
      ["Two.", false], // its audio had arrived too: dropped unplayed
      ["Three.", true], // still in flight: aborted
    ]);
    expect(s.cancels.length).toBeGreaterThan(0);
    expect(s.played).toEqual(["One."]); // cut short by cancel(), not followed by Two
    expect(browser.spoken).toEqual([]); // an aborted prefetch is not a failure
    expect(c.mode).toBe("polly");
    // A fresh line after the stop is asked for anew.
    void c.say("Again.");
    expect(s.requests.map((r) => r.text)).toEqual(["One.", "Two.", "Three.", "Again."]);
  });

  it("the server voice goes sticky (404): the prefetched requests are aborted and the browser speaks the rest", async () => {
    const s = slowServer();
    const browser = fakeProvider("browser");
    const c = createSpeechCoordinator({ server: true, makeProvider: s.make, fallback: () => browser });
    const done = c.say("One. Two. Three.");
    s.req("One.").reject(new SpeakUnavailable());
    await done;
    expect(s.requests.map((r) => [r.text, !!r.signal?.aborted])).toEqual([
      ["One.", false],
      ["Two.", true],
      ["Three.", true],
    ]);
    expect(browser.spoken).toEqual(["One.", "Two.", "Three."]);
    expect(c.mode).toBe("browser");
  });

  it("the browser voice is never prefetched (it synthesises as it speaks)", async () => {
    const { c, browser } = rig({ manual: true });
    void c.say("One. Two. Three.");
    await settle();
    expect(browser.spoken).toEqual(["One."]);
  });
});

// 2026-10-30 (founder: "SK voice is disappearing in the middle of the
// explanation… it does not continue to speak while walkthrough is happening").
describe("the walkthrough's lines: sayLine outcome, and a stop never strands the queue", () => {
  it("sayLine: 'spoken' only when EVERY sentence of the line played; 'stopped' when cut off; 'silent' when off or empty", async () => {
    const { c, browser } = rig({ manual: true });
    const line = c.sayLine("One. Two.");
    await settle();
    browser.pending[0]!.finish();
    await settle();
    expect(c.speaking).toBe(true); // between sentence 1 and 2 SK is still speaking
    browser.pending[0]!.finish();
    await expect(line).resolves.toBe("spoken");

    const cut = c.sayLine("Three. Four.");
    await settle();
    browser.pending[0]!.finish(); // "Three." played …
    await settle();
    c.stop(); // … then a barge-in during "Four."
    await expect(cut).resolves.toBe("stopped");

    await expect(c.sayLine("")).resolves.toBe("silent");
    c.setEnabled(false);
    await expect(c.sayLine("Off.")).resolves.toBe("silent");
  });

  it("a voice with no audio at all (every provider throws) is not 'spoken'", async () => {
    const broken: SpeechProvider = {
      id: "browser",
      async synthesize() {
        throw new Error("no voice");
      },
    };
    const c = createSpeechCoordinator({ server: false, makeProvider: () => broken, fallback: () => broken });
    await expect(c.sayLine("Hello.")).resolves.toBe("stopped");
  });

  it("REGRESSION: a provider whose play() never settles (a browser voice that drops its end event) no longer silences every later line — stop() frees the queue", async () => {
    let plays = 0;
    const stuckOnce: SpeechProvider & { spoken: string[] } = {
      id: "browser",
      spoken: [],
      async synthesize(text) {
        stuckOnce.spoken.push(text);
        return {
          audio: null,
          format: "none",
          marks: EMPTY_MARKS,
          // The first sentence hangs for ever (no end, no error); later ones play.
          play: () => (++plays === 1 ? new Promise<void>(() => {}) : Promise.resolve()),
        };
      },
      cancel() {
        /* the engine ignores the cancel: no event fires */
      },
    };
    const c = createSpeechCoordinator({ server: false, makeProvider: () => stuckOnce, fallback: () => stuckOnce });
    const first = c.sayLine("Stop one line.");
    await settle();
    expect(c.speaking).toBe(true);
    // The tour's next stop: the Shell stops the old line and says the new one.
    c.stop();
    await expect(first).resolves.toBe("stopped");
    const next = c.sayLine("Stop two line.");
    await expect(next).resolves.toBe("spoken");
    expect(stuckOnce.spoken).toEqual(["Stop one line.", "Stop two line."]);
    await settle();
    expect(c.speaking).toBe(false);
  });

  it("the server voice: a request that never answers is released by stop() too", async () => {
    const hung: SpeechProvider = { id: "polly-client", synthesize: () => new Promise<SpeechResult>(() => {}) };
    const browser = fakeProvider("browser");
    const c = createSpeechCoordinator({ server: true, makeProvider: () => hung, fallback: () => browser });
    const a = c.sayLine("Never comes.");
    await settle();
    c.stop();
    await expect(a).resolves.toBe("stopped");
    expect(browser.spoken).toEqual([]); // a stopped request is not a failure: no fallback
  });
});

// 2026-10-30: the corner avatar's speech bubble shows the sentence being said.
describe("the current sentence (onCurrent / current)", () => {
  it("reports each sentence as it starts, then null when the queue drains", async () => {
    const p = fakeProvider("browser", { manual: true });
    const seen: Array<string | null> = [];
    const c = createSpeechCoordinator({ server: false, makeProvider: () => p, fallback: () => p, defaultLang: "en-US", onCurrent: (s) => seen.push(s ? s.text : null) });
    const done = c.say("First sentence. Second one.");
    await settle();
    expect(c.current).toEqual({ text: "First sentence.", lang: "en-US" });
    p.pending[0].finish();
    await settle();
    expect(c.current?.text).toBe("Second one.");
    p.pending[0].finish();
    await done;
    await settle();
    expect(c.current).toBeNull();
    expect(seen).toEqual(["First sentence.", "Second one.", null]);
  });
  it("stop() clears it at once; read-aloud off never sets it", async () => {
    const p = fakeProvider("browser", { manual: true });
    const seen: Array<string | null> = [];
    const c = createSpeechCoordinator({ server: false, makeProvider: () => p, fallback: () => p, onCurrent: (s) => seen.push(s ? s.text : null) });
    void c.say("Hello there.");
    await settle();
    expect(c.current?.text).toBe("Hello there.");
    c.stop();
    expect(c.current).toBeNull();
    await settle();
    c.setEnabled(false);
    await c.say("Not spoken.");
    expect(seen).toEqual(["Hello there.", null]);
  });
});

