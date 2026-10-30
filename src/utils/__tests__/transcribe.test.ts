/**
 * SK S6 slice B — the browser half of Amazon Transcribe streaming, in node
 * with fakes (no microphone, no network, no AWS):
 *   - the event-stream codec: CRC-32, round trip, AWS's documented frames;
 *   - 16 kHz PCM16 downsampling as pure math, and the AudioWorklet file run
 *     in a sandbox agreeing with it sample for sample;
 *   - one streaming session: partial → final → (her turn ends by the
 *     endpointer, 2026-10-30, not at the first final) → end frame → close;
 *   - every fallback: route 404/403, a socket error, a service exception →
 *     browser Web Speech, sticky, with ONE notice;
 *   - the §2.6 mic gate closing the socket and the audio graph in the SAME tick;
 *   - startDictation's swap point (flag off = Web Speech, untouched).
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/transcribe.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioEvent, crc32, decodeMessage, encodeMessage, MessageReader, readServiceEvent } from "@/utils/assistant/event-stream";
import { createDownsampler, downsampleToPcm16, floatToInt16, pcm16Bytes } from "@/utils/assistant/pcm16";
import {
  __resetTranscribeClientForTests,
  fallbackNoticeText,
  setSttNoticeHandler,
  startTranscribeSession,
  type AudioGraph,
  type SttSocket,
  type TranscribeEnv,
  type TranscribeHandlers,
} from "@/utils/assistant/transcribe-client";
import { speechLangFor, startDictation } from "@/utils/assistant/voice-client";
import { createMicGate } from "@/sk/shell/client/mic-gate";

const ROOT = path.resolve(__dirname, "../../..");
const enc = new TextEncoder();
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// ── event-stream codec ──────────────────────────────────────────────────────

describe("event-stream codec", () => {
  it("CRC-32 is the IEEE/zlib one (check value 0xCBF43926)", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("an AudioEvent round-trips with the three documented headers", () => {
    const pcm = new Uint8Array([1, 2, 3, 250, 0, 7]);
    const m = decodeMessage(audioEvent(pcm));
    expect(m.headers[":content-type"]).toEqual({ type: "string", value: "application/octet-stream" });
    expect(m.headers[":event-type"]).toEqual({ type: "string", value: "AudioEvent" });
    expect(m.headers[":message-type"]).toEqual({ type: "string", value: "event" });
    expect([...m.payload]).toEqual([...pcm]);
  });

  it("the prelude: total length, headers length, and a CRC of the first 8 bytes; the last 4 bytes CRC the rest", () => {
    const b = audioEvent(new Uint8Array(10));
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(0)).toBe(b.length);
    // 3 string headers: (1+13+1+2+24) + (1+11+1+2+10) + (1+13+1+2+5)
    expect(dv.getUint32(4)).toBe(41 + 25 + 22);
    expect(dv.getUint32(8)).toBe(crc32(b, 0, 8));
    expect(dv.getUint32(b.length - 4)).toBe(crc32(b, 0, b.length - 4));
    // the empty end-of-audio event: 16 bytes of framing + headers, no payload
    expect(audioEvent(new Uint8Array(0)).length).toBe(16 + 88);
  });

  it("decodes AWS's documented end frame (:date timestamp + :chunk-signature bytes), CRCs intact", () => {
    // "Setting up a streaming transcription" — the signed empty frame, base64 as printed.
    const b = Uint8Array.from(Buffer.from("AAAAUwAAAEP1RHpYBTpkYXRlCAAAAWiXUkMLEDpjaHVuay1zaWduYXR1cmUGACCt6Zy+uymwEK2SrLp/zVBI5eGn83jdBwCaRUBJA+eaDafqjqI=", "base64"));
    const m = decodeMessage(b);
    expect(m.headers[":date"]!.type).toBe("timestamp");
    expect(new Date(Number((m.headers[":date"] as { value: bigint }).value)).toISOString()).toBe("2019-01-29T01:56:17.291Z");
    expect(m.headers[":chunk-signature"]!.type).toBe("bytes");
    expect((m.headers[":chunk-signature"] as { value: Uint8Array }).value.length).toBe(32);
    expect(m.payload.length).toBe(0);
  });

  it("rejects a corrupted message by CRC (the doc's audio frame has a valid prelude but an illustrative body)", () => {
    const docFrame = Uint8Array.from(
      Buffer.from(
        "AAAA0gAAAIKVoRFcTTcjb250ZW50LXR5cGUHABhhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0LOmV2ZW50LXR5cGUHAApBdWRpb0V2ZW50DTptZXNzYWdlLXR5cGUHAAVldmVudAxDb256ZW50LVR5cGUHABphcHBsaWNhdGlvbi94LWFtei1qc29uLTEuMVJJRkY88T0AV0FWRWZtdCAQAAAAAQABAIA+AAAAfQAAAgAQAGRhdGFU8D0AAAAAAAAAAAAAAAAA//8CAP3/BAC7QLFf",
        "base64",
      ),
    );
    expect(new DataView(docFrame.buffer).getUint32(8)).toBe(crc32(docFrame, 0, 8)); // prelude CRC holds
    expect(() => decodeMessage(docFrame)).toThrow(/message CRC/);
    const good = audioEvent(new Uint8Array([5, 6, 7]));
    const bad = good.slice();
    bad[bad.length - 6] ^= 0xff;
    expect(() => decodeMessage(bad)).toThrow(/message CRC/);
    const badPrelude = good.slice();
    badPrelude[5] ^= 0x01;
    expect(() => decodeMessage(badPrelude)).toThrow(/prelude CRC/);
  });

  it("MessageReader: split across chunks, or two in one chunk", () => {
    const a = encodeMessage({ ":message-type": "event", ":event-type": "TranscriptEvent" }, enc.encode('{"Transcript":{"Results":[]}}'));
    const b = audioEvent(new Uint8Array([9]));
    const r = new MessageReader();
    expect(r.push(a.slice(0, 7))).toEqual([]);
    expect(r.push(a.slice(7, 30))).toEqual([]);
    const both = new Uint8Array(a.length - 30 + b.length);
    both.set(a.slice(30));
    both.set(b, a.length - 30);
    expect(r.push(both).length).toBe(2);
  });

  it("reads TranscriptEvents and exceptions", () => {
    const t = readServiceEvent(
      decodeMessage(
        encodeMessage(
          { ":content-type": "application/json", ":event-type": "TranscriptEvent", ":message-type": "event" },
          enc.encode(JSON.stringify({ Transcript: { Results: [{ Alternatives: [{ Transcript: "hello wor" }], IsPartial: true, ResultId: "r1" }, { Alternatives: [{ Transcript: "hello world" }], IsPartial: false }] } })),
        ),
      ),
    );
    expect(t).toEqual({ kind: "transcript", results: [{ text: "hello wor", partial: true, resultId: "r1" }, { text: "hello world", partial: false }] });
    const x = readServiceEvent(decodeMessage(encodeMessage({ ":exception-type": "BadRequestException", ":message-type": "exception" }, enc.encode('{"Message":"bad sample rate"}'))));
    expect(x).toEqual({ kind: "exception", type: "BadRequestException", message: "bad sample rate" });
    expect(readServiceEvent(decodeMessage(encodeMessage({ ":message-type": "event", ":event-type": "Other" }, new Uint8Array(0))))).toEqual({ kind: "other" });
  });
});

// ── PCM16 at 16 kHz ─────────────────────────────────────────────────────────

describe("PCM16 downsampling (pure)", () => {
  it("float → int16: clamped, asymmetric, rounded", () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(32767);
    expect(floatToInt16(-1)).toBe(-32768);
    expect(floatToInt16(2)).toBe(32767);
    expect(floatToInt16(-3)).toBe(-32768);
    expect(floatToInt16(0.5)).toBe(16384);
    expect(floatToInt16(Number.NaN)).toBe(0);
  });
  it("48 kHz → 16 kHz averages each group of 3 samples", () => {
    const out = downsampleToPcm16(Float32Array.from([0.3, 0.3, 0.3, -0.6, 0, 0, 1, 1, 1]), 48000);
    expect([...out]).toEqual([floatToInt16(0.3), floatToInt16(-0.2), 32767]);
  });
  it("16 kHz in = 16 kHz out (identity)", () => {
    const x = Float32Array.from([0.1, -0.2, 0.3, -0.4]);
    expect([...downsampleToPcm16(x, 16000)]).toEqual([...x].map(floatToInt16));
  });
  it("44.1 kHz: one second → 16000 samples, and chunking changes nothing (no drift)", () => {
    const n = 44100;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / n) * 0.8;
    const whole = downsampleToPcm16(x, 44100);
    expect(whole.length).toBe(16000);
    const d = createDownsampler(44100);
    const parts: number[] = [];
    for (let i = 0; i < n; i += 128) parts.push(...d.push(x.subarray(i, i + 128)));
    expect(parts).toEqual([...whole]);
  });
  it("little-endian bytes", () => {
    expect([...pcm16Bytes(Int16Array.from([1, -1, 0x1234]))]).toEqual([1, 0, 0xff, 0xff, 0x34, 0x12]);
  });
  it("the AudioWorklet file computes exactly the same samples", () => {
    const src = readFileSync(path.join(ROOT, "public/worklets/pcm16-worklet.js"), "utf8");
    for (const rate of [48000, 44100]) {
      const posted: Int16Array[] = [];
      let Ctor: (new (o: unknown) => { process(i: Float32Array[][]): boolean }) | null = null;
      class AudioWorkletProcessor {
        port = { postMessage: (d: Int16Array) => posted.push(d.slice()) };
      }
      vm.runInNewContext(src, {
        sampleRate: rate,
        AudioWorkletProcessor,
        registerProcessor: (name: string, c: typeof Ctor) => {
          expect(name).toBe("sk-pcm16-capture");
          Ctor = c;
        },
        Float32Array,
        Int16Array,
        Math,
        Number,
      });
      const proc = new Ctor!({ processorOptions: { targetRate: 16000, batchSamples: 1600 } });
      const x = new Float32Array(rate); // one second
      for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 7) * 0.9 + (i % 13) / 40 - 0.15;
      for (let i = 0; i < x.length; i += 128) expect(proc.process([[x.slice(i, i + 128)]])).toBe(true);
      const fromWorklet = posted.flatMap((p) => [...p]);
      expect(posted.every((p) => p.length === 1600)).toBe(true);
      expect(fromWorklet.length).toBe(16000);
      expect(fromWorklet).toEqual([...downsampleToPcm16(x, rate)]);
    }
  });
});

// ── fakes ───────────────────────────────────────────────────────────────────

class FakeSocket implements SttSocket {
  static all: FakeSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  sent: Uint8Array[] = [];
  closed: number[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code?: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: Uint8Array) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(d);
  }
  close(code?: number) {
    this.closed.push(code ?? 1005);
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSays(results: Array<{ text: string; partial: boolean; lang?: string }>) {
    const body = { Transcript: { Results: results.map((r) => ({ Alternatives: [{ Transcript: r.text }], IsPartial: r.partial, ...(r.lang ? { LanguageCode: r.lang } : {}) })) } };
    const m = encodeMessage({ ":content-type": "application/json", ":event-type": "TranscriptEvent", ":message-type": "event" }, enc.encode(JSON.stringify(body)));
    this.onmessage?.({ data: m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) });
  }
  serverThrows(type: string) {
    const m = encodeMessage({ ":content-type": "application/json", ":exception-type": type, ":message-type": "exception" }, enc.encode('{"Message":"nope"}'));
    this.onmessage?.({ data: m.buffer });
  }
  get endFrames() {
    return this.sent.filter((f) => decodeMessage(f).payload.length === 0).length;
  }
}

type Reply = { ok: boolean; status: number; body?: unknown };
const URL_OK: Reply = { ok: true, status: 200, body: { url: "wss://transcribestreaming.us-east-1.amazonaws.com:8443/stream-transcription-websocket?X-Amz-Signature=abc", expiresAt: "x", languageCode: "en-US" } };

function fakeEnv(reply: Reply | Promise<Reply> = URL_OK) {
  const graph = { stopped: 0, stop() {
    this.stopped++;
  } };
  let onPcm: ((p: Int16Array) => void) | null = null;
  let audioGate: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const env: TranscribeEnv = {
    fetch: async (url, init) => {
      fetches.push({ url, init });
      const r = await reply;
      return { ok: r.ok, status: r.status, json: async () => r.body };
    },
    openSocket: (url) => new FakeSocket(url),
    startAudio: (cb) =>
      new Promise<AudioGraph>((resolve, reject) => {
        onPcm = cb;
        audioGate = { resolve: () => resolve(graph), reject };
      }),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      if (h) (h as { cleared: boolean }).cleared = true;
    },
  };
  return {
    env,
    graph,
    fetches,
    timers,
    pcm: (n = 1600) => onPcm?.(new Int16Array(n).fill(7)),
    micOpens: () => audioGate?.resolve(),
    micFails: () => audioGate?.reject(new Error("NotAllowedError")),
    fire: (ms: number) => timers.filter((t) => t.ms === ms && !t.cleared).forEach((t) => t.fn()),
  };
}

function handlers() {
  const log: string[] = [];
  const h: TranscribeHandlers = {
    onPartial: (t) => log.push(`partial:${t}`),
    onFinal: (t) => log.push(`final:${t}`),
    onEnd: () => log.push("end"),
    onFallback: (r) => log.push(`fallback:${r}`),
  };
  return { h, log };
}

beforeEach(() => {
  FakeSocket.all = [];
  __resetTranscribeClientForTests();
});

// ── one session ─────────────────────────────────────────────────────────────

describe("a Transcribe session", () => {
  it("asks the route for a URL, streams PCM as AudioEvents, partial → final → silence → end frame → close", async () => {
    const f = fakeEnv();
    const { h, log } = handlers();
    startTranscribeSession("en-US", h, f.env);
    await flush();
    expect(f.fetches).toHaveLength(1);
    expect(f.fetches[0]!.url).toBe("/api/sk/stt/url");
    expect(JSON.parse(String(f.fetches[0]!.init.body))).toEqual({ lang: "en-US" });
    const s = FakeSocket.all[0]!;
    expect(s.url).toBe((URL_OK.body as { url: string }).url);
    expect(s.binaryType).toBe("arraybuffer");
    f.micOpens();
    await flush();
    f.pcm(); // before open → queued
    s.open();
    expect(s.sent).toHaveLength(1);
    f.pcm();
    expect(s.sent).toHaveLength(2);
    const m = decodeMessage(s.sent[1]!);
    expect(m.headers[":event-type"]).toEqual({ type: "string", value: "AudioEvent" });
    expect(m.payload.length).toBe(3200); // 1600 samples × 2 bytes = 100 ms at 16 kHz
    s.serverSays([{ text: "what is", partial: true }]);
    s.serverSays([{ text: "what is osmosis", partial: false }]);
    expect(log).toEqual(["partial:what is", "final:what is osmosis"]);
    // 2026-10-30: a final is not the end of her turn — the socket stays open…
    expect(s.endFrames).toBe(0);
    expect(s.closed).toEqual([]);
    expect(f.graph.stopped).toBe(0);
    // …until END_SILENCE_MS with no new words.
    f.fire(1500);
    expect(s.endFrames).toBe(1);
    expect(s.closed).toEqual([1000]);
    expect(f.graph.stopped).toBe(1);
    await flush();
    expect(log).toEqual(["partial:what is", "final:what is osmosis", "end"]);
    f.pcm(); // late audio after the end goes nowhere
    expect(s.sent.filter((x) => decodeMessage(x).payload.length > 0)).toHaveLength(2);
  });

  it("2026-10-30 identify: asks the route for identification; the identified language of a FINAL result is reported before its words", async () => {
    const f = fakeEnv();
    const log: string[] = [];
    startTranscribeSession(
      "en-US",
      { onPartial: (t) => log.push(`partial:${t}`), onFinal: (t) => log.push(`final:${t}`), onEnd: () => log.push("end"), onFallback: (r) => log.push(`fallback:${r}`), onLanguage: (l) => log.push(`lang:${l}`) },
      f.env,
      { identify: true },
    );
    await flush();
    expect(JSON.parse(String(f.fetches[0]!.init.body))).toEqual({ lang: "en-US", identify: true });
    const s = FakeSocket.all[0]!;
    f.micOpens();
    await flush();
    s.open();
    s.serverSays([{ text: "apa itu", partial: true, lang: "ms-MY" }]);
    s.serverSays([{ text: "apa itu osmosis", partial: false, lang: "ms-MY" }]);
    expect(log).toEqual(["partial:apa itu", "lang:ms-MY", "final:apa itu osmosis"]);
  });

  it("2026-10-30: final, final, then silence → ONE turn, the finals joined with spaces; the last final's language reported last", async () => {
    const f = fakeEnv();
    const log: string[] = [];
    startTranscribeSession(
      "en-US",
      { onPartial: (t) => log.push(`partial:${t}`), onFinal: (t) => log.push(`final:${t}`), onEnd: () => log.push("end"), onFallback: (r) => log.push(`fallback:${r}`), onLanguage: (l) => log.push(`lang:${l}`) },
      f.env,
      { identify: true },
    );
    await flush();
    const s = FakeSocket.all[0]!;
    f.micOpens();
    await flush();
    s.open();
    s.serverSays([{ text: "I want to know about photosynthesis and", partial: false, lang: "en-US" }]);
    f.fire(1500); // the old cut-off point: a pause after "and" is NOT the end (2.5 s grace)
    f.pcm();
    expect(s.endFrames).toBe(0);
    s.serverSays([{ text: "why plants", partial: true, lang: "en-US" }]);
    s.serverSays([{ text: "why plants need light.", partial: false, lang: "en-US" }]);
    f.fire(2500); // the stale grace from the first final was cleared
    expect(s.endFrames).toBe(0);
    f.fire(1500);
    expect(s.endFrames).toBe(1);
    expect(s.closed).toEqual([1000]);
    expect(f.graph.stopped).toBe(1);
    await flush();
    expect(log).toEqual([
      "lang:en-US",
      "final:I want to know about photosynthesis and",
      "partial:I want to know about photosynthesis and why plants",
      "lang:en-US",
      "final:I want to know about photosynthesis and why plants need light.",
      "end",
    ]);
  });

  it("2026-10-30: the timings are tunable per session", async () => {
    const f = fakeEnv();
    const { h, log } = handlers();
    startTranscribeSession("en", h, f.env, { endSilenceMs: 900, hesitantMs: 3000 });
    await flush();
    const s = FakeSocket.all[0]!;
    s.open();
    s.serverSays([{ text: "tell me about the water cycle.", partial: false }]);
    f.fire(900);
    await flush();
    expect(log).toEqual(["final:tell me about the water cycle.", "end"]);
  });

  it("2026-10-30 push-to-talk (endpointing off): finals and silence never end it; stop() does, words kept", async () => {
    const f = fakeEnv();
    const { h, log } = handlers();
    const sess = startTranscribeSession("en", h, f.env, { endpointing: false });
    await flush();
    const s = FakeSocket.all[0]!;
    s.open();
    s.serverSays([{ text: "what is osmosis.", partial: false }]);
    f.fire(1500);
    f.fire(2500);
    expect(s.endFrames).toBe(0);
    s.serverSays([{ text: "in plants", partial: true }]);
    sess.stop();
    expect(s.endFrames).toBe(1);
    await flush();
    expect(log).toEqual(["final:what is osmosis.", "partial:what is osmosis. in plants", "end"]);
  });

  it("a malformed LanguageCode is ignored", async () => {
    const f = fakeEnv();
    const langs: string[] = [];
    startTranscribeSession("en-US", { onPartial: () => undefined, onFinal: () => undefined, onEnd: () => undefined, onFallback: () => undefined, onLanguage: (l) => langs.push(l) }, f.env, { identify: true });
    await flush();
    const s = FakeSocket.all[0]!;
    f.micOpens();
    await flush();
    s.open();
    s.serverSays([{ text: "hello there", partial: false, lang: "<script>" }]);
    expect(langs).toEqual([]);
  });

  it.each([403, 404, 429, 400, 503])("route %i → fallback, no socket, no microphone", async (status) => {
    const f = fakeEnv({ ok: false, status });
    const { h, log } = handlers();
    startTranscribeSession("en", h, f.env);
    await flush();
    expect(log).toEqual([`fallback:route_${status}`]);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("a socket error before any words → fallback, everything released", async () => {
    const f = fakeEnv();
    const { h, log } = handlers();
    startTranscribeSession("en", h, f.env);
    await flush();
    f.micOpens();
    await flush();
    FakeSocket.all[0]!.onerror?.();
    expect(log).toEqual(["fallback:socket_error"]);
    expect(f.graph.stopped).toBe(1);
    expect(FakeSocket.all[0]!.closed).toEqual([1000]);
  });

  it("a service exception before words → fallback; after words → just the end, words kept", async () => {
    const f = fakeEnv();
    const a = handlers();
    startTranscribeSession("en", a.h, f.env);
    await flush();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.serverThrows("BadRequestException");
    expect(a.log).toEqual(["fallback:service_BadRequestException"]);

    const g = fakeEnv();
    const b = handlers();
    startTranscribeSession("en", b.h, g.env);
    await flush();
    const s = FakeSocket.all[1]!;
    s.open();
    s.serverSays([{ text: "half a", partial: true }]);
    s.onclose?.({ code: 1006 });
    await flush();
    expect(b.log).toEqual(["partial:half a", "end"]);
  });

  it("no microphone (permission refused) → fallback", async () => {
    const f = fakeEnv();
    const { h, log } = handlers();
    startTranscribeSession("en", h, f.env);
    await flush();
    f.micFails();
    await flush();
    expect(log).toEqual(["fallback:no_audio"]);
    expect(FakeSocket.all[0]!.closed).toEqual([1000]);
  });

  it("silence: nothing heard for the no-speech window → ends (like Web Speech)", async () => {
    const f = fakeEnv();
    const { h, log } = handlers();
    startTranscribeSession("en", h, f.env, { noSpeechMs: 8000 });
    await flush();
    f.micOpens();
    await flush();
    FakeSocket.all[0]!.open();
    f.fire(8000);
    await flush();
    expect(log).toEqual(["end"]);
    expect(f.graph.stopped).toBe(1);
    expect(FakeSocket.all[0]!.endFrames).toBe(1);
  });

  it("stop() while the URL is still being fetched → no socket is ever opened; onEnd once", async () => {
    let release!: (r: Reply) => void;
    const f = fakeEnv(new Promise<Reply>((r) => (release = r)));
    const { h, log } = handlers();
    const s = startTranscribeSession("en", h, f.env);
    s.stop();
    s.stop();
    release(URL_OK);
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    expect(log).toEqual(["end"]);
  });

  it("stop() while the microphone is opening → the graph is released the moment it arrives", async () => {
    const f = fakeEnv();
    const { h } = handlers();
    const s = startTranscribeSession("en", h, f.env);
    await flush();
    s.stop();
    expect(f.graph.stopped).toBe(0);
    f.micOpens();
    await flush();
    expect(f.graph.stopped).toBe(1);
  });
});

// ── the swap point, the fallback, the notice, the gate ──────────────────────

class FakeRecognition {
  static all: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = true;
  started = 0;
  stopped = 0;
  onresult: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeRecognition.all.push(this);
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
    this.onend?.();
  }
}

type Tracks = { stopped: number };
function installBrowser(reply: Reply = URL_OK, lang = "en") {
  FakeRecognition.all = [];
  const fetches: string[] = [];
  const tracks: Tracks = { stopped: 0 };
  const audio = { closed: 0, disconnected: 0, addModule: [] as string[], port: null as null | { onmessage: unknown } };
  class Ctx {
    state = "running";
    destination = {};
    audioWorklet = { addModule: async (u: string) => void audio.addModule.push(u) };
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => void audio.disconnected++ };
    }
    close() {
      audio.closed++;
      return Promise.resolve();
    }
  }
  class WorkletNode {
    port = { onmessage: null as unknown };
    constructor(_c: unknown, name: string) {
      expect(name).toBe("sk-pcm16-capture");
      audio.port = this.port;
    }
    connect() {}
    disconnect() {
      audio.disconnected++;
    }
  }
  const win = {
    SpeechRecognition: FakeRecognition,
    AudioContext: Ctx,
    AudioWorkletNode: WorkletNode,
    WebSocket: FakeSocket,
    fetch: async (u: string) => {
      fetches.push(u);
      return { ok: reply.ok, status: reply.status, json: async () => reply.body };
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => void tracks.stopped++ }] }) } });
  vi.stubGlobal("document", { documentElement: { lang } });
  return { fetches, tracks, audio };
}

describe("startDictation: the one swap point", () => {
  let notices: string[];
  beforeEach(() => {
    notices = [];
    setSttNoticeHandler((t) => notices.push(t));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_SK_STT;
  });

  it("flag unset → browser Web Speech exactly as before; no URL is asked for", () => {
    const b = installBrowser();
    const stop = startDictation(() => undefined, () => undefined, { lang: "ms-MY" });
    expect(typeof stop).toBe("function");
    expect(FakeRecognition.all).toHaveLength(1);
    expect(FakeRecognition.all[0]!.lang).toBe("ms-MY");
    expect(b.fetches).toHaveLength(0);
    expect(notices).toEqual([]);
  });

  it("flag on → Transcribe: the route, the socket, the worklet", async () => {
    process.env.NEXT_PUBLIC_SK_STT = "transcribe";
    const b = installBrowser();
    const texts: string[] = [];
    let ends = 0;
    startDictation((t) => texts.push(t), () => ends++, { lang: "en-US" });
    await flush(12);
    expect(b.fetches).toEqual(["/api/sk/stt/url"]);
    expect(FakeSocket.all).toHaveLength(1);
    expect(b.audio.addModule).toEqual(["/worklets/pcm16-worklet.js"]);
    expect(FakeRecognition.all).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      FakeSocket.all[0]!.open();
      FakeSocket.all[0]!.serverSays([{ text: "hello", partial: false }]);
      await flush();
      expect(ends).toBe(0); // 2026-10-30: one short word → the longer grace
      vi.advanceTimersByTime(2500);
      await flush();
    } finally {
      vi.useRealTimers();
    }
    expect(texts).toEqual(["hello"]);
    expect(ends).toBe(1);
    expect(b.tracks.stopped).toBe(1);
    expect(b.audio.closed).toBe(1);
  });

  it("route 404 → browser Web Speech for this dictation AND the next ones; ONE notice", async () => {
    process.env.NEXT_PUBLIC_SK_STT = "transcribe";
    const b = installBrowser({ ok: false, status: 404 });
    let ends = 0;
    const stop = startDictation(() => undefined, () => ends++, { lang: "en-US" });
    await flush(12);
    expect(FakeRecognition.all).toHaveLength(1);
    expect(FakeRecognition.all[0]!.started).toBe(1);
    expect(FakeRecognition.all[0]!.lang).toBe("en-US");
    expect(notices).toEqual(["Using your browser's speech recognition."]);
    stop!(); // the handle now stops the browser recognizer
    expect(FakeRecognition.all[0]!.stopped).toBe(1);
    expect(ends).toBe(1);
    // sticky: the next dictation goes straight to the browser — no URL, no second notice
    startDictation(() => undefined, () => undefined, { lang: "en-US" });
    expect(b.fetches).toHaveLength(1);
    expect(FakeRecognition.all).toHaveLength(2);
    expect(notices).toHaveLength(1);
  });

  it("403 no_voice_consent → browser, one notice", async () => {
    process.env.NEXT_PUBLIC_SK_STT = "transcribe";
    installBrowser({ ok: false, status: 403, body: { reason: "no_voice_consent" } });
    startDictation(() => undefined, () => undefined, { lang: "en-US" });
    await flush(12);
    expect(FakeRecognition.all).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it("a socket error → browser + one notice, the mic released", async () => {
    process.env.NEXT_PUBLIC_SK_STT = "transcribe";
    const b = installBrowser();
    startDictation(() => undefined, () => undefined, { lang: "en-US" });
    await flush(12);
    FakeSocket.all[0]!.onerror?.();
    expect(FakeRecognition.all).toHaveLength(1);
    expect(notices).toEqual(["Using your browser's speech recognition."]);
    expect(b.tracks.stopped).toBe(1);
    expect(b.audio.closed).toBe(1);
  });

  it("a language Transcribe does not stream (Hindi) → browser, without asking the route", () => {
    process.env.NEXT_PUBLIC_SK_STT = "transcribe";
    const b = installBrowser(URL_OK, "hi");
    startDictation(() => undefined, () => undefined, { lang: "hi-IN" });
    expect(b.fetches).toHaveLength(0);
    expect(FakeRecognition.all).toHaveLength(1);
    expect(FakeRecognition.all[0]!.lang).toBe("hi-IN");
  });

  it("the notice is localized by <html lang>; zh is in the Web Speech table", () => {
    expect(fallbackNoticeText("ms")).toBe("Menggunakan pengecaman pertuturan pelayar anda.");
    expect(fallbackNoticeText("xx")).toBe("Using your browser's speech recognition.");
    expect(speechLangFor("zh")).toBe("zh-CN");
    expect(speechLangFor("zh-CN")).toBe("zh-CN");
  });
});

describe("the §2.6 mic gate closes the Transcribe socket in the same tick", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_SK_STT;
  });

  function fakeTargets() {
    const ls: Record<string, Array<() => void>> = {};
    const t = {
      addEventListener: (k: string, f: () => void) => void (ls[k] ??= []).push(f),
      removeEventListener: (k: string, f: () => void) => void (ls[k] = (ls[k] ?? []).filter((x) => x !== f)),
      fire: (k: string) => (ls[k] ?? []).forEach((f) => f()),
    };
    return { win: t, doc: { ...t, visibilityState: "visible", hasFocus: () => true } };
  }

  it.each(["blur", "pagehide"])("%s → socket closed, end frame sent, tracks + worklet + context released — synchronously", async (evt) => {
    process.env.NEXT_PUBLIC_SK_STT = "transcribe";
    setSttNoticeHandler(() => undefined);
    const b = installBrowser();
    const { win, doc } = fakeTargets();
    let stopMic: (() => void) | null = null;
    let ends = 0;
    const gate = createMicGate({ win, doc, onStop: () => stopMic?.() });
    expect(gate.start({ idle: false })).toBe(true);
    stopMic = startDictation(() => undefined, () => ends++, { lang: "en-US" });
    await flush(12);
    const s = FakeSocket.all[0]!;
    s.open();
    expect(b.audio.port).not.toBeNull();

    win.fire(evt); // ← the gate's handler; NO await between here and the asserts
    expect(s.closed).toEqual([1000]);
    expect(s.endFrames).toBe(1);
    expect(s.onmessage).toBeNull();
    expect(b.tracks.stopped).toBe(1);
    expect(b.audio.disconnected).toBe(2); // source + worklet node
    expect(b.audio.closed).toBe(1);
    expect(b.audio.port!.onmessage).toBeNull();
    expect(gate.active).toBe(false);

    await flush();
    expect(ends).toBe(1);
  });

  it("hidden while the URL is still in flight → no socket is ever opened", async () => {
    process.env.NEXT_PUBLIC_SK_STT = "transcribe";
    installBrowser();
    const { win, doc } = fakeTargets();
    let stopMic: (() => void) | null = null;
    const gate = createMicGate({ win, doc, onStop: () => stopMic?.() });
    gate.start();
    stopMic = startDictation(() => undefined, () => undefined, { lang: "en-US" });
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await flush(12);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

// ── nothing sent unasked ────────────────────────────────────────────────────

describe("nothing is sent unasked: the STT modules talk only to the STT route and the signed socket", () => {
  const FILES = [
    "src/utils/assistant/transcribe-client.ts",
    "src/utils/assistant/event-stream.ts",
    "src/utils/assistant/pcm16.ts",
    "public/worklets/pcm16-worklet.js",
  ];
  it("the only fetch is POST /api/sk/stt/url; the worklet and codecs make no network call", () => {
    const client = readFileSync(path.join(ROOT, FILES[0]!), "utf8");
    expect(client.match(/\bfetch\(/g)?.length).toBe(2); // the env seam + window.fetch inside browserEnv
    expect(client).toContain('STT_URL_ROUTE = "/api/sk/stt/url"');
    for (const f of FILES.slice(1)) expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket/);
  });
});
