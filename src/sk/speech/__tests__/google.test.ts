/**
 * SK voice (2026-10-30) — the Google adapter without Google: the voice map
 * and its allow-list, the service-account JWT and the token cache (a
 * throwaway RSA key, a fake clock, a fake token endpoint), the synthesize
 * request body, the MP3 frame walk over synthetic frames, the word spread,
 * and the monthly meter over a fake RPC. Never a live call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { GOOGLE_VOICES, googleLanguageCode, googleLocaleFor, googleVoiceFor, googleVoiceForLook, googleVoiceName } from "@/sk/speech/google-voices";
import { GOOGLE_TOKEN_URL, GOOGLE_TTS_SCOPE, GoogleTokenSource, parseServiceAccount, signAssertion, TOKEN_REFRESH_MARGIN_MS, type FetchLike } from "@/sk/speech/google-auth";
import { GOOGLE_TTS_URL, GoogleSpeechProvider } from "@/sk/speech/google";
import { estimateSpeechMs, frameAt, mp3DurationMs, spreadWords } from "@/sk/speech/google-marks";
import { DEFAULT_SK_TTS_MONTHLY_CHAR_CAP, reserveSkTts, SK_TTS_METER_PROVIDER, skTtsMonthlyCap } from "@/sk/speech/tts-meter";
import { MAX_SPEAK_CHARS } from "@/sk/speech/polly-marks";

// ── synthetic MP3 ────────────────────────────────────────────────────────────
/** MPEG-2 Layer III, 32 kbps, 24 kHz, mono (Google's MP3): 96-byte frames of 576 samples = 24 ms. */
const MPEG2_MONO = [0xff, 0xf3, 0x44, 0xc0];
/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames of 1152 samples. */
const MPEG1_STEREO = [0xff, 0xfb, 0x90, 0x00];

function frames(header: number[], n: number): Uint8Array {
  const len = frameAt(new Uint8Array(header), 0)!.len;
  const out = new Uint8Array(len * n);
  for (let k = 0; k < n; k++) out.set(header, k * len);
  return out;
}
const concat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// ── voices ───────────────────────────────────────────────────────────────────
describe("voice map", () => {
  it("mirrors the worker's teacher voices: Achernar female, Achird male; Malay WaveNet A/B; zh SK-only", () => {
    for (const loc of ["en-US", "ar-XA", "hi-IN", "ur-IN", "mr-IN", "te-IN", "fr-FR", "es-ES", "pt-BR", "cmn-CN"]) {
      expect(GOOGLE_VOICES[loc]).toEqual({ female: `${loc}-Chirp3-HD-Achernar`, male: `${loc}-Chirp3-HD-Achird` });
    }
    expect(GOOGLE_VOICES["ms-MY"]).toEqual({ female: "ms-MY-Wavenet-A", male: "ms-MY-Wavenet-B" });
    expect(Object.keys(GOOGLE_VOICES)).toHaveLength(11);
  });
  it("language → locale by the primary subtag, en-US for anything else", () => {
    expect(googleLocaleFor("ar-SA")).toBe("ar-XA");
    expect(googleLocaleFor("ms-MY")).toBe("ms-MY");
    expect(googleLocaleFor("ms-arab")).toBe("ms-MY");
    expect(googleLocaleFor("zh-CN")).toBe("cmn-CN");
    expect(googleLocaleFor("PT_br")).toBe("pt-BR");
    expect(googleLocaleFor("en-GB")).toBe("en-US");
    for (const x of ["ta-IN", "", undefined, null, 42, "../../etc"]) expect(googleLocaleFor(x)).toBe("en-US");
  });
  it("look/gender → VoiceId (A female, B and anything else male)", () => {
    expect(googleVoiceFor("hi-IN", "female")).toBe("google:hi-IN-Chirp3-HD-Achernar");
    expect(googleVoiceForLook("A", "ar-SA")).toBe("google:ar-XA-Chirp3-HD-Achernar");
    expect(googleVoiceForLook("B", "ms-MY")).toBe("google:ms-MY-Wavenet-B");
    expect(googleVoiceForLook(undefined, undefined)).toBe("google:en-US-Chirp3-HD-Achird");
    expect(googleVoiceForLook("Z", "fr-FR")).toBe("google:fr-FR-Chirp3-HD-Achird");
  });
  it("allow-list: only names in the map reach Google; anything else is the default male voice", () => {
    expect(googleVoiceName("google:te-IN-Chirp3-HD-Achernar")).toBe("te-IN-Chirp3-HD-Achernar");
    expect(googleVoiceName("google:ms-MY-Wavenet-A")).toBe("ms-MY-Wavenet-A");
    for (const bad of ["google:en-US-Chirp3-HD-Leda", "google:ja-JP-Neural2-B", "polly:Joanna", "en-US-Chirp3-HD-Achernar", "google:", ""]) {
      expect(googleVoiceName(bad)).toBe("en-US-Chirp3-HD-Achird");
    }
  });
  it("languageCode is the name's first two parts", () => {
    expect(googleLanguageCode("cmn-CN-Chirp3-HD-Achird")).toBe("cmn-CN");
    expect(googleLanguageCode("ms-MY-Wavenet-A")).toBe("ms-MY");
  });
});

// ── auth ─────────────────────────────────────────────────────────────────────
const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SA = { client_email: "sk-tts@test-project.iam.gserviceaccount.com", private_key: keys.privateKey };

describe("service-account key", () => {
  it("parses the key JSON, repairs double-escaped newlines, refuses junk", () => {
    expect(parseServiceAccount(JSON.stringify({ type: "service_account", ...SA }))).toEqual(SA);
    const escaped = JSON.stringify({ ...SA, private_key: SA.private_key.replace(/\n/g, "\\n") });
    expect(parseServiceAccount(escaped)?.private_key).toBe(SA.private_key);
    for (const bad of [undefined, "", "  ", "{nope", "[]", JSON.stringify({ client_email: "x" }), JSON.stringify({ client_email: "x", private_key: "abc" })]) {
      expect(parseServiceAccount(bad)).toBeNull();
    }
  });
});

describe("JWT bearer assertion", () => {
  it("RS256 header, the documented claims, a signature the public key verifies", () => {
    const jwt = signAssertion(SA, 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({
      iss: SA.client_email,
      scope: GOOGLE_TTS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    expect(GOOGLE_TTS_SCOPE).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), keys.publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});

describe("token source", () => {
  function tokenEndpoint(replies: Array<{ status?: number; body: unknown }>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    };
    return { calls, fetch };
  }

  it("posts the JWT-bearer grant to the fixed token URL and caches until 5 min before expiry", async () => {
    let now = 1_800_000_000_000;
    const ep = tokenEndpoint([{ body: { access_token: "tok-1", expires_in: 3600 } }, { body: { access_token: "tok-2", expires_in: 3600 } }]);
    const src = new GoogleTokenSource({ credentials: () => SA, fetch: ep.fetch, now: () => now });
    expect(await src.token()).toBe("tok-1");
    expect(ep.calls).toHaveLength(1);
    expect(ep.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(ep.calls[0]!.init.method).toBe("POST");
    const form = new URLSearchParams(String(ep.calls[0]!.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")!.split(".")).toHaveLength(3);

    now += 3600_000 - TOKEN_REFRESH_MARGIN_MS - 1000;
    expect(await src.token()).toBe("tok-1");
    expect(src.mints).toBe(1);
    now += 2000;
    expect(await src.token()).toBe("tok-2");
    expect(src.mints).toBe(2);
  });

  it("concurrent callers share one exchange; invalidate() forces a new one", async () => {
    const ep = tokenEndpoint([{ body: { access_token: "a", expires_in: 3600 } }, { body: { access_token: "b", expires_in: 3600 } }]);
    const src = new GoogleTokenSource({ credentials: () => SA, fetch: ep.fetch, now: () => 1e12 });
    expect(await Promise.all([src.token(), src.token(), src.token()])).toEqual(["a", "a", "a"]);
    expect(ep.calls).toHaveLength(1);
    src.invalidate();
    expect(await src.token()).toBe("b");
  });

  it("a refused exchange throws with the status and Google's code only — never the key or the assertion — and is not cached", async () => {
    const ep = tokenEndpoint([{ status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } }, { body: { access_token: "ok", expires_in: 3600 } }]);
    const src = new GoogleTokenSource({ credentials: () => SA, fetch: ep.fetch, now: () => 1e12 });
    const err = await src.token().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("google auth: token exchange failed (HTTP 400 invalid_grant)");
    expect((err as Error).message).not.toContain("PRIVATE KEY");
    expect(await src.token()).toBe("ok");
  });

  it("no key → a plain error, no request", async () => {
    const ep = tokenEndpoint([{ body: {} }]);
    const src = new GoogleTokenSource({ credentials: () => null, fetch: ep.fetch });
    await expect(src.token()).rejects.toThrow(/GOOGLE_APPLICATION_CREDENTIALS_JSON/);
    expect(ep.calls).toHaveLength(0);
  });
});

// ── MP3 duration ─────────────────────────────────────────────────────────────
describe("mp3 duration", () => {
  it("reads the header fields", () => {
    expect(frameAt(new Uint8Array(MPEG2_MONO), 0)).toMatchObject({ len: 96, samples: 576, rate: 24000, mono: true, layer: 3 });
    expect(frameAt(new Uint8Array(MPEG1_STEREO), 0)).toMatchObject({ len: 417, samples: 1152, rate: 44100, mono: false, mpeg1: true });
    expect(frameAt(new Uint8Array([0xff, 0xf3, 0xf4, 0xc0]), 0)).toBeNull(); // bitrate index 15
    expect(frameAt(new Uint8Array([0xff, 0xf3, 0x4c, 0xc0]), 0)).toBeNull(); // sample-rate index 3
  });
  it("sums the frames (50 × 24 ms = 1.2 s)", () => {
    expect(mp3DurationMs(frames(MPEG2_MONO, 50))).toBe(1200);
    expect(mp3DurationMs(frames(MPEG1_STEREO, 10))).toBe(Math.round((10 * 1152 * 1000) / 44100));
  });
  it("skips an ID3v2 tag (sync-looking bytes inside it included) and an ID3v1 tail", () => {
    const tagBody = [0xff, 0xfb, 0x90, 0x00, ...new Array(16).fill(7)];
    const id3 = [...ascii("ID3"), 3, 0, 0, 0, 0, 0, tagBody.length, ...tagBody];
    const v1 = [...ascii("TAG"), ...new Array(125).fill(0xff)];
    expect(mp3DurationMs(concat(id3, frames(MPEG2_MONO, 25), v1))).toBe(600);
  });
  it("resyncs past junk; a lone sync-looking word that is not followed by a frame is ignored", () => {
    expect(mp3DurationMs(concat([1, 2, 3, ...MPEG2_MONO, 9, 9], frames(MPEG2_MONO, 10)))).toBe(240);
  });
  it("a Xing frame count wins; an Info frame without a count is skipped and the rest summed", () => {
    const xing = frames(MPEG1_STEREO, 1);
    xing.set([...ascii("Xing"), 0, 0, 0, 1, 0, 0, 0, 100], 4 + 32);
    expect(mp3DurationMs(concat(xing, frames(MPEG1_STEREO, 3)))).toBe(Math.round((100 * 1152 * 1000) / 44100));
    const info = frames(MPEG2_MONO, 1);
    info.set([...ascii("Info"), 0, 0, 0, 0], 4 + 9);
    expect(mp3DurationMs(concat(info, frames(MPEG2_MONO, 10)))).toBe(240);
  });
  it("0 for no frames at all; the estimate is ~2.7 words a second, at least 0.6 s", () => {
    expect(mp3DurationMs(new Uint8Array([1, 2, 3, 4, 5]))).toBe(0);
    expect(mp3DurationMs(new Uint8Array(0))).toBe(0);
    expect(estimateSpeechMs("Hi")).toBe(600);
    expect(estimateSpeechMs("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven")).toBe(10000);
  });
});

// ── word spread ──────────────────────────────────────────────────────────────
describe("word spread", () => {
  it("first word at 0, the rest by character share (length + 1), last ends at the clip's end", () => {
    // Hi(2) there(5) friend(6): total = 13 + 2 = 15 → 1500·3/15 = 300, + 1500·6/15 = 900.
    expect(spreadWords("Hi there friend", 1500)).toEqual([
      { i: 0, t0: 0, t1: 300, text: "Hi" },
      { i: 3, t0: 300, t1: 900, text: "there" },
      { i: 9, t0: 900, t1: 1500, text: "friend" },
    ]);
  });
  it("indices are UTF-16 positions in the line; lengths count code points; monotonic", () => {
    const w = spreadWords("😀 مرحبا يا صديقي", 2000);
    expect(w.map((x) => x.i)).toEqual([0, 3, 9, 12]);
    for (let k = 1; k < w.length; k++) expect(w[k]!.t0).toBeGreaterThanOrEqual(w[k - 1]!.t0);
    expect(w.at(-1)!.t1).toBe(2000);
  });
  it("nothing to spread → no marks", () => {
    expect(spreadWords("   ", 1000)).toEqual([]);
  });
});

// ── provider ─────────────────────────────────────────────────────────────────
describe("GoogleSpeechProvider", () => {
  const MP3 = frames(MPEG2_MONO, 50); // 1.2 s
  function googleStub(reply: { status?: number; body: unknown } = { body: { audioContent: Buffer.from(MP3).toString("base64") } }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    };
    return { calls, fetch };
  }

  it("posts the v1 synthesize body with the allow-listed voice and a bearer token; mp3 + spread words, no visemes", async () => {
    const g = googleStub();
    const p = new GoogleSpeechProvider({ fetch: g.fetch, accessToken: async () => "tok" });
    const r = await p.synthesize("  Hello \n there ", "google:ar-XA-Chirp3-HD-Achird", { marks: ["word", "viseme"] });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.url).toBe(GOOGLE_TTS_URL);
    expect(GOOGLE_TTS_URL).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(g.calls[0]!.init.method).toBe("POST");
    expect((g.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(g.calls[0]!.init.body))).toEqual({
      input: { text: "Hello there" },
      voice: { languageCode: "ar-XA", name: "ar-XA-Chirp3-HD-Achird" },
      audioConfig: { audioEncoding: "MP3" },
    });
    expect(r.format).toBe("mp3");
    expect(r.audio).toEqual(MP3);
    expect(r.marks.visemes).toEqual([]);
    // Hello(5) there(5): total 11 → the second word at 1200·6/11 ≈ 655 ms of the measured 1.2 s.
    expect(r.marks.words).toEqual([
      { i: 0, t0: 0, t1: 655, text: "Hello" },
      { i: 6, t0: 655, t1: 1200, text: "there" },
    ]);
    expect(p.chars).toBe("Hello there".length);
  });

  it("a voice outside the map is sent as the default male voice", async () => {
    const g = googleStub();
    await new GoogleSpeechProvider({ fetch: g.fetch, accessToken: async () => "t" }).synthesize("Hi", "google:en-US-Studio-O", { marks: [] });
    expect(JSON.parse(String(g.calls[0]!.init.body)).voice).toEqual({ languageCode: "en-US", name: "en-US-Chirp3-HD-Achird" });
  });

  it("no word marks asked → none computed; unmeasurable audio → estimated duration", async () => {
    const g = googleStub();
    expect((await new GoogleSpeechProvider({ fetch: g.fetch, accessToken: async () => "t" }).synthesize("Hi there", "google:x", { marks: [] })).marks).toEqual({ words: [], visemes: [] });
    const junk = googleStub({ body: { audioContent: Buffer.from([1, 2, 3, 4]).toString("base64") } });
    const r = await new GoogleSpeechProvider({ fetch: junk.fetch, accessToken: async () => "t" }).synthesize("Hi there", "google:x", { marks: ["word"] });
    expect(r.marks.words.at(-1)!.t1).toBe(estimateSpeechMs("Hi there"));
  });

  it("an empty line makes no call", async () => {
    const g = googleStub();
    const r = await new GoogleSpeechProvider({ fetch: g.fetch, accessToken: async () => "t" }).synthesize("  ", "google:x", { marks: ["word"] });
    expect(r.audio).toEqual(new Uint8Array(0));
    expect(g.calls).toHaveLength(0);
  });

  it("refuses over MAX_SPEAK_CHARS; a full-length line of 3-byte characters (4,500 bytes) fits Google's 5,000-byte cap", async () => {
    const g = googleStub();
    const p = new GoogleSpeechProvider({ fetch: g.fetch, accessToken: async () => "t" });
    await expect(p.synthesize("x".repeat(MAX_SPEAK_CHARS + 1), "google:x", { marks: [] })).rejects.toThrow(/exceeds/);
    await p.synthesize("中".repeat(MAX_SPEAK_CHARS), "google:cmn-CN-Chirp3-HD-Achird", { marks: [] });
    expect(g.calls).toHaveLength(1);
  });

  it("HTTP errors throw with the status (and Google's status code); a 401 invalidates the token", async () => {
    const invalidate = vi.fn();
    const denied = googleStub({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "..." } } });
    await expect(new GoogleSpeechProvider({ fetch: denied.fetch, accessToken: async () => "t", invalidate }).synthesize("Hi", "google:x", { marks: [] })).rejects.toThrow("google tts: HTTP 403 PERMISSION_DENIED");
    expect(invalidate).not.toHaveBeenCalled();
    const unauth = googleStub({ status: 401, body: { error: { status: "UNAUTHENTICATED" } } });
    await expect(new GoogleSpeechProvider({ fetch: unauth.fetch, accessToken: async () => "t", invalidate }).synthesize("Hi", "google:x", { marks: [] })).rejects.toThrow(/401/);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const empty = googleStub({ body: { audioContent: "" } });
    await expect(new GoogleSpeechProvider({ fetch: empty.fetch, accessToken: async () => "t" }).synthesize("Hi", "google:x", { marks: [] })).rejects.toThrow(/empty audio/);
  });

  it("passes the request's signal to fetch; an already-aborted signal makes no call", async () => {
    const g = googleStub();
    const p = new GoogleSpeechProvider({ fetch: g.fetch, accessToken: async () => "t" });
    const ac = new AbortController();
    await p.synthesize("Hi", "google:x", { marks: [], signal: ac.signal });
    expect(g.calls[0]!.init.signal).toBe(ac.signal);
    ac.abort();
    await expect(p.synthesize("Hi", "google:x", { marks: [], signal: ac.signal })).rejects.toThrow();
    expect(g.calls).toHaveLength(1);
  });
});

// ── meter ────────────────────────────────────────────────────────────────────
describe("monthly meter", () => {
  afterEach(() => {
    delete process.env.SK_TTS_MONTHLY_CHAR_CAP;
  });
  const db = (reply: () => Promise<{ data: unknown; error: unknown }>) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return { calls, rpc: (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), reply()) };
  };

  it("reserves through tutor_tts_reserve as sk:google, this UTC month, the default cap", async () => {
    const d = db(async () => ({ data: true, error: null }));
    expect(await reserveSkTts(d, "user-1", 42, new Date("2026-10-31T23:30:00Z"))).toBe("ok");
    expect(d.calls).toEqual([{ fn: "tutor_tts_reserve", args: { p_user: "user-1", p_period: "2026-10", p_provider: "sk:google", p_chars: 42, p_cap: 200_000 } }]);
    expect(SK_TTS_METER_PROVIDER).toBe("sk:google");
  });
  it("SK_TTS_MONTHLY_CHAR_CAP sets the cap; junk falls back to the default", () => {
    process.env.SK_TTS_MONTHLY_CHAR_CAP = "5000";
    expect(skTtsMonthlyCap()).toBe(5000);
    for (const bad of ["0", "-1", "1.5", "lots", ""]) {
      process.env.SK_TTS_MONTHLY_CHAR_CAP = bad;
      expect(skTtsMonthlyCap()).toBe(DEFAULT_SK_TTS_MONTHLY_CHAR_CAP);
    }
  });
  it("false → cap; an error, a throw or a non-boolean → error (fail closed)", async () => {
    expect(await reserveSkTts(db(async () => ({ data: false, error: null })), "u", 1)).toBe("cap");
    expect(await reserveSkTts(db(async () => ({ data: null, error: { message: "boom" } })), "u", 1)).toBe("error");
    expect(await reserveSkTts(db(async () => Promise.reject(new Error("network"))), "u", 1)).toBe("error");
    expect(await reserveSkTts(db(async () => ({ data: null, error: null })), "u", 1)).toBe("error");
  });
});
