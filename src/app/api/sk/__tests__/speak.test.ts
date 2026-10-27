/**
 * SK B9 — POST /api/sk/speak: 404 with SK_TTS unset (before auth is even
 * consulted — the client reads it as "no server voice"), the SK gate after
 * it (FEATURE_SK off → 404, signed out → 401), the body checks (400 / 413),
 * the look → voice mapping, and the JSON + base64 reply over a stubbed
 * provider. No Polly call anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST as speak } from "@/app/api/sk/speak/route";
import { __setSkSpeechForTests } from "@/sk/server";
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
});
afterEach(() => {
  __setSkSpeechForTests(undefined);
  delete process.env.FEATURE_SK;
  delete process.env.SK_TTS;
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
  it("404 for any SK_TTS value other than polly", async () => {
    process.env.SK_TTS = "google";
    expect((await speak(req({ text: "Hi" }))).status).toBe(404);
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
});
