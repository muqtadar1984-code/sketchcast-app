/**
 * SK B9 — POST /api/sk/speak: 404 with SK_TTS unset (before auth is even
 * consulted — the client reads it as "no server voice"), the SK gate after
 * it (FEATURE_SK off → 404, signed out → 401), the body checks (400 / 413),
 * the look → voice mapping, and the JSON + base64 reply over a stubbed
 * provider. No Polly call anywhere.
 *
 * 2026-10-30 — SK_TTS=google: mode selection, lang → the Google voice, and
 * the monthly meter (tutor_tts_reserve over a mocked admin client): over the
 * cap → 429 tts_cap, a failed reserve → 503, never unmetered speech. No
 * Google call anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn(), rpc: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { POST as speak } from "@/app/api/sk/speak/route";
import { __setSkSpeechForTests, skSpeech } from "@/sk/server";
import { GoogleSpeechProvider } from "@/sk/speech/google";
import { PollySpeechProvider } from "@/sk/speech/polly";
import type { SpeechProvider, SpeechResult } from "@/sk/speech/provider";

const STU = "22222222-2222-4222-8222-222222222222";
const signedIn = (id: string | null) => mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } });
const req = (body: unknown) => new Request("http://x/api/sk/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function stubProvider() {
  const calls: { text: string; voice: string; marks: string[] }[] = [];
  const provider: SpeechProvider = {
    id: "stub",
    async synthesize(text, voice, opts): Promise<SpeechResult> {
      calls.push({ text, voice, marks: opts.marks });
      return { audio: new Uint8Array([1, 2, 3, 255]), format: "mp3", marks: { words: [{ i: 0, t0: 0, t1: 200, text: "Hi" }], visemes: [{ t: 0, v: "kk" }] } };
    },
  };
  return { calls, provider };
}

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  process.env.SK_TTS = "polly";
  signedIn(STU);
  mocks.createAdminClient.mockImplementation(() => ({ rpc: mocks.rpc }));
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => {
  __setSkSpeechForTests(undefined);
  delete process.env.FEATURE_SK;
  delete process.env.SK_TTS;
  delete process.env.SK_TTS_MONTHLY_CHAR_CAP;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  vi.clearAllMocks();
});

describe("flags and gate", () => {
  it("404 when SK_TTS is unset — before auth is consulted, whatever the provider", async () => {
    delete process.env.SK_TTS;
    __setSkSpeechForTests(stubProvider().provider);
    const res = await speak(req({ text: "Hi", look: "B" }));
    expect(res.status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("404 for any SK_TTS value other than polly or google", async () => {
    for (const v of ["edge", "Google", "on", ""]) {
      process.env.SK_TTS = v;
      expect((await speak(req({ text: "Hi" }))).status).toBe(404);
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("404 when FEATURE_SK is off even with SK_TTS=polly", async () => {
    delete process.env.FEATURE_SK;
    expect((await speak(req({ text: "Hi" }))).status).toBe(404);
  });
  it("401 when signed out", async () => {
    signedIn(null);
    expect((await speak(req({ text: "Hi" }))).status).toBe(401);
  });
});

describe("body", () => {
  beforeEach(() => __setSkSpeechForTests(stubProvider().provider));
  it("400 on bad JSON, a missing text, or a blank one", async () => {
    expect((await speak(req("{nope"))).status).toBe(400);
    expect((await speak(req({ look: "A" }))).status).toBe(400);
    expect((await speak(req({ text: 42 }))).status).toBe(400);
    expect((await speak(req({ text: "   " }))).status).toBe(400);
  });
  it("413 over the cap", async () => {
    expect((await speak(req({ text: "x".repeat(1501) }))).status).toBe(413);
    expect((await speak(req({ text: "x".repeat(1500) }))).status).toBe(200);
  });
});

describe("reply", () => {
  it("base64 mp3 + marks + the voice for the look, no-store, whitespace folded, both mark kinds asked for", async () => {
    const { calls, provider } = stubProvider();
    __setSkSpeechForTests(provider);
    const res = await speak(req({ text: "  Hi \n there ", look: "A" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = (await res.json()) as { format: string; audio: string; marks: unknown; voice: string };
    expect(j.format).toBe("mp3");
    expect(Buffer.from(j.audio, "base64")).toEqual(Buffer.from([1, 2, 3, 255]));
    expect(j.marks).toEqual({ words: [{ i: 0, t0: 0, t1: 200, text: "Hi" }], visemes: [{ t: 0, v: "kk" }] });
    expect(j.voice).toBe("polly:Joanna");
    expect(calls).toEqual([{ text: "Hi there", voice: "polly:Joanna", marks: ["word", "viseme"] }]);
  });
  it("look B and a missing look are the male voice", async () => {
    const { calls, provider } = stubProvider();
    __setSkSpeechForTests(provider);
    await speak(req({ text: "Hi", look: "B" }));
    await speak(req({ text: "Hi" }));
    expect(calls.map((c) => c.voice)).toEqual(["polly:Matthew", "polly:Matthew"]);
  });
  it("502 when the provider throws (the client then falls back for that line)", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    __setSkSpeechForTests({
      id: "boom",
      async synthesize() {
        throw new Error("AccessDeniedException");
      },
    });
    const res = await speak(req({ text: "Hi" }));
    expect(res.status).toBe(502);
    quiet.mockRestore();
  });
  it("404 when SK_TTS=polly but no provider could be built", async () => {
    __setSkSpeechForTests(null);
    expect((await speak(req({ text: "Hi" }))).status).toBe(404);
  });
  it("polly is not metered; an English lang is spoken, another language is refused 404 (never Joanna reading Arabic)", async () => {
    const { calls, provider } = stubProvider();
    __setSkSpeechForTests(provider);
    expect((await speak(req({ text: "Hi", look: "A", lang: "en-US" }))).status).toBe(200);
    expect((await speak(req({ text: "Hi", look: "A", lang: "en" }))).status).toBe(200);
    expect((await speak(req({ text: "Hi", look: "A", lang: "ar-SA" }))).status).toBe(404);
    expect((await speak(req({ text: "Hi", look: "A", lang: "eng" }))).status).toBe(404);
    expect(calls.map((c) => c.voice)).toEqual(["polly:Joanna", "polly:Joanna"]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("mode selection", () => {
  it("SK_TTS picks the provider: polly → Polly, google + a key → Google, google without a key or unset → none", () => {
    process.env.SK_TTS = "polly";
    expect(skSpeech()).toBeInstanceOf(PollySpeechProvider);
    process.env.SK_TTS = "google";
    expect(skSpeech()).toBeNull();
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = "{}";
    expect(skSpeech()).toBeInstanceOf(GoogleSpeechProvider);
    expect(skSpeech()).toBe(skSpeech()); // one per process
    delete process.env.SK_TTS;
    expect(skSpeech()).toBeNull();
  });
  it("google without a key → 404 before the meter is touched", async () => {
    process.env.SK_TTS = "google";
    expect((await speak(req({ text: "Hi" }))).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("SK_TTS=google", () => {
  beforeEach(() => {
    process.env.SK_TTS = "google";
  });

  it("404 when the server flag is unset, before auth and the meter", async () => {
    delete process.env.SK_TTS;
    __setSkSpeechForTests(stubProvider().provider);
    expect((await speak(req({ text: "Hi", lang: "ar-SA" }))).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("the gate and the body still come before the meter", async () => {
    __setSkSpeechForTests(stubProvider().provider);
    signedIn(null);
    expect((await speak(req({ text: "Hi" }))).status).toBe(401);
    signedIn(STU);
    expect((await speak(req({ text: "   " }))).status).toBe(400);
    expect((await speak(req({ text: "x".repeat(1501) }))).status).toBe(413);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("lang picks the voice: Arabic for ar-SA, the look picks the gender; en-US for no lang or an unknown one", async () => {
    const { calls, provider } = stubProvider();
    __setSkSpeechForTests(provider);
    const res = await speak(req({ text: "مرحبا", look: "B", lang: "ar-SA" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { voice: string }).voice).toBe("google:ar-XA-Chirp3-HD-Achird");
    await speak(req({ text: "Hi", look: "A", lang: "zh-CN" }));
    await speak(req({ text: "Hi", look: "A", lang: "ms-MY" }));
    await speak(req({ text: "Hi" }));
    await speak(req({ text: "Hi", lang: "ta-IN" }));
    await speak(req({ text: "Hi", lang: "google:evil-voice" }));
    expect(calls.map((c) => c.voice)).toEqual([
      "google:ar-XA-Chirp3-HD-Achird",
      "google:cmn-CN-Chirp3-HD-Achernar",
      "google:ms-MY-Wavenet-A",
      "google:en-US-Chirp3-HD-Achird",
      "google:en-US-Chirp3-HD-Achird",
      "google:en-US-Chirp3-HD-Achird",
    ]);
  });
  it("reserves the line's characters for this user under sk:google before speaking", async () => {
    process.env.SK_TTS_MONTHLY_CHAR_CAP = "9000";
    const { calls, provider } = stubProvider();
    __setSkSpeechForTests(provider);
    expect((await speak(req({ text: "  Hello \n there ", lang: "en-US" }))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("tutor_tts_reserve", { p_user: STU, p_period: new Date().toISOString().slice(0, 7), p_provider: "sk:google", p_chars: "Hello there".length, p_cap: 9000 });
    expect(calls).toHaveLength(1);
  });
  it("over the monthly cap → 429 tts_cap and nothing is synthesised", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const { calls, provider } = stubProvider();
    __setSkSpeechForTests(provider);
    const res = await speak(req({ text: "Hi", lang: "ar-SA" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ reason: "tts_cap" });
    expect(calls).toHaveLength(0);
  });
  it("a failed reserve fails closed (503, no speech): RPC error, RPC throw, no admin client", async () => {
    const { calls, provider } = stubProvider();
    __setSkSpeechForTests(provider);
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });
    expect((await speak(req({ text: "Hi" }))).status).toBe(503);
    mocks.rpc.mockRejectedValueOnce(new Error("network"));
    expect((await speak(req({ text: "Hi" }))).status).toBe(503);
    mocks.createAdminClient.mockImplementationOnce(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });
    expect((await speak(req({ text: "Hi" }))).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
  it("a provider failure after the reserve is a 502 (the client falls back for that line)", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    __setSkSpeechForTests({
      id: "boom",
      async synthesize() {
        throw new Error("google tts: HTTP 403 PERMISSION_DENIED");
      },
    });
    expect((await speak(req({ text: "Hi" }))).status).toBe(502);
    quiet.mockRestore();
  });
});
