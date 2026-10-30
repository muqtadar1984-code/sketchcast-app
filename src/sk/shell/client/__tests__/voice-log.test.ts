/**
 * SK's voice, 2026-10-30 (founder: "the sound still doesnt seem to be working"):
 * a refused play() (autoplay) must bring "Tap for sound" back instead of the
 * tour going silent, and every sentence's outcome reaches the voice log so a
 * silent machine can be diagnosed from the function logs.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/client/__tests__/voice-log.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanVoiceEvents, createVoiceLog, type VoiceEvent } from "../voice-log";
import { createSpeechCoordinator } from "../speech";
import { EMPTY_MARKS, type SpeechProvider, type SpeechResult } from "@/sk/speech/provider";
import { BrowserSpeechProvider } from "@/sk/speech/browser";

const notAllowed = () => Object.assign(new Error("play() failed because the user didn't interact"), { name: "NotAllowedError" });

/** A provider whose play() resolves, or rejects with `fail`. */
function provider(id: string, fail?: () => Error): SpeechProvider & { played: string[] } {
  const played: string[] = [];
  return {
    id,
    played,
    async synthesize(text): Promise<SpeechResult> {
      return {
        audio: null,
        format: "none",
        marks: EMPTY_MARKS,
        play: () => {
          if (fail) return Promise.reject(fail());
          played.push(text);
          return Promise.resolve();
        },
      };
    },
    cancel() {},
  };
}

describe("cleanVoiceEvents — the server's view of a client batch", () => {
  it("keeps known keys, trims strings, caps the batch at 40, drops junk", () => {
    const long = "x".repeat(500);
    const out = cleanVoiceEvents([{ k: "sentence", t: 12.6, provider: "polly-client", ok: false, error: long, ms: 830.2, extra: "no" }, null, 5, { t: 1 }, ...Array.from({ length: 60 }, () => ({ k: "mic", t: 1 }))]);
    expect(out[0]).toEqual({ k: "sentence", t: 13, provider: "polly-client", ok: false, error: "x".repeat(60), ms: 830 });
    expect(out.length).toBe(37); // only the first 40 raw entries are looked at; null, 5 and {t:1} are dropped
    expect(cleanVoiceEvents("nope")).toEqual([]);
  });
});

describe("createVoiceLog — buffered, flushed on a timer or on demand", () => {
  it("sends once per window with times relative to its start, and flush() sends now", () => {
    let now = 1000;
    const timers: Array<() => void> = [];
    const sent: VoiceEvent[][] = [];
    const log = createVoiceLog({ send: (e) => sent.push(e), now: () => now, setTimer: (fn) => timers.push(fn), clearTimer: () => {} });
    log.push({ k: "sentence", ok: true, provider: "browser", ms: 5 });
    now = 1250;
    log.push({ k: "blocked" });
    expect(timers.length).toBe(1);
    timers[0]!();
    expect(sent).toEqual([[{ k: "sentence", ok: true, provider: "browser", ms: 5, t: 0 }, { k: "blocked", t: 250 }]]);
    log.push({ k: "mic", why: "closed for the tour" });
    log.flush();
    expect(sent.length).toBe(2);
    log.flush(); // nothing buffered: nothing sent
    expect(sent.length).toBe(2);
  });
});

describe("the coordinator reports what the voice did", () => {
  it("a refused play() (NotAllowedError) calls onPlayBlocked and logs the failure; the line is cut off, not 'spoken'", async () => {
    const blocked: number[] = [];
    const sentences: Array<{ provider: string; ok: boolean; error?: string }> = [];
    const c = createSpeechCoordinator({
      server: true,
      makeProvider: () => provider("polly-client", notAllowed),
      fallback: () => provider("browser", notAllowed),
      onPlayBlocked: () => blocked.push(1),
      onSentence: (e) => sentences.push(e),
    });
    const outcome = await c.sayLine("Hello there.");
    expect(outcome).not.toBe("spoken");
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(sentences.map((s) => `${s.provider}:${s.ok}:${s.error}`)).toEqual(["polly-client:false:NotAllowedError", "browser:false:NotAllowedError"]);
  });

  it("a played sentence is logged ok with its provider; nothing is reported as blocked", async () => {
    const blocked: number[] = [];
    const sentences: Array<{ provider: string; ok: boolean }> = [];
    const google = provider("polly-client");
    const c = createSpeechCoordinator({ server: true, serverMode: "google", makeProvider: () => google, fallback: () => provider("browser"), onPlayBlocked: () => blocked.push(1), onSentence: (e) => sentences.push(e) });
    expect(await c.sayLine("One. Two.")).toBe("spoken");
    expect(google.played).toEqual(["One.", "Two."]);
    expect(sentences.every((s) => s.ok && s.provider === "polly-client")).toBe(true);
    expect(blocked).toEqual([]);
  });
});

describe("the browser voice reports a refused utterance as NotAllowedError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("speechSynthesis 'not-allowed' rejects with NotAllowedError; a cancel/interruption still resolves", async () => {
    type U = { text: string; onerror?: (e: { error: string }) => void; onstart?: () => void; onend?: () => void };
    const spoken: U[] = [];
    const synth = { speaking: false, pending: false, getVoices: () => [], cancel: () => {}, speak: (u: U) => spoken.push(u) };
    vi.stubGlobal("window", { speechSynthesis: synth });
    vi.stubGlobal("SpeechSynthesisUtterance", function (this: U, text: string) {
      this.text = text;
    } as unknown as typeof SpeechSynthesisUtterance);
    const p = new BrowserSpeechProvider("en-US");
    const r1 = await p.synthesize("Hello.", "browser:default", { marks: [] });
    const first = r1.play!({});
    spoken[0]!.onerror!({ error: "not-allowed" });
    await expect(first).rejects.toMatchObject({ name: "NotAllowedError" });
    const r2 = await p.synthesize("Again.", "browser:default", { marks: [] });
    const second = r2.play!({});
    spoken[1]!.onerror!({ error: "interrupted" });
    await expect(second).resolves.toBeUndefined();
  });
});
