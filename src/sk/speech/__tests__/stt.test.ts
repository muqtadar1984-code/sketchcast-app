/**
 * SK S6 slice B — the STT flags, the Transcribe language map, and the SigV4
 * presigner. The signer is checked against AWS's own published presigned-URL
 * example (S3 "Authenticating Requests: Using Query Parameters": the
 * examplebucket/test.txt URL, signature aeeed9bb…), then the Transcribe URL's
 * shape against "Setting up a streaming transcription → WebSocket". No AWS call.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/speech/__tests__/stt.test.ts
 */
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientSttMode, skSttMode, STT_URL_EXPIRES_S, transcribeLanguageFor } from "@/sk/speech/stt";
import { skSttMode as fromServer } from "@/sk/server";
import { amzDates, presignQuery, presignTranscribeUrl, sigv4Encode } from "@/sk/speech/transcribe-presign";

describe("flags default to the browser", () => {
  it("SK_STT / NEXT_PUBLIC_SK_STT unset → browser", () => {
    expect(skSttMode(undefined)).toBe("browser");
    expect(clientSttMode(undefined)).toBe("browser");
    expect(skSttMode("")).toBe("browser");
    expect(skSttMode(null)).toBe("browser");
  });
  it("only the exact word 'transcribe' (any case, trimmed) switches it", () => {
    expect(skSttMode("transcribe")).toBe("transcribe");
    expect(clientSttMode(" Transcribe ")).toBe("transcribe");
    for (const v of ["polly", "aws", "true", "1", "browser", "transcribe-x"]) expect(skSttMode(v)).toBe("browser");
  });
  it("reads process.env by default, and server.ts re-exports the same helper", () => {
    const prev = process.env.SK_STT;
    delete process.env.SK_STT;
    expect(skSttMode()).toBe("browser");
    expect(fromServer()).toBe("browser");
    process.env.SK_STT = "transcribe";
    expect(skSttMode()).toBe("transcribe");
    if (prev === undefined) delete process.env.SK_STT;
    else process.env.SK_STT = prev;
  });
});

describe("app locale → Transcribe language code", () => {
  it("maps the four approved languages", () => {
    expect(transcribeLanguageFor("en")).toBe("en-US");
    expect(transcribeLanguageFor("ms")).toBe("ms-MY");
    expect(transcribeLanguageFor("ms-arab")).toBe("ms-MY");
    expect(transcribeLanguageFor("ar")).toBe("ar-SA");
    expect(transcribeLanguageFor("zh")).toBe("zh-CN");
  });
  it("accepts the BCP-47 tags the dictation call carries", () => {
    expect(transcribeLanguageFor("en-US")).toBe("en-US");
    expect(transcribeLanguageFor("ms-MY")).toBe("ms-MY");
    expect(transcribeLanguageFor("MS-Arab")).toBe("ms-MY");
    expect(transcribeLanguageFor("ar-SA")).toBe("ar-SA");
    expect(transcribeLanguageFor("zh-CN")).toBe("zh-CN");
  });
  it("everything else → null (the route answers 400)", () => {
    for (const v of ["fr", "es", "pt", "te", "mr", "hi", "hi-IN", "", "  ", "xx", 42, null, undefined, {}, "e".repeat(40)]) expect(transcribeLanguageFor(v)).toBeNull();
  });
});

describe("SigV4 query presign", () => {
  it("reproduces AWS's published presigned-URL example byte for byte", () => {
    const q = presignQuery({
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      service: "s3",
      region: "us-east-1",
      creds: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      now: new Date("2013-05-24T00:00:00Z"),
      expiresS: 86400,
      params: {},
      payloadHash: "UNSIGNED-PAYLOAD",
    });
    expect(q).toBe(
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
  it("RFC 3986 encoding: unreserved kept, the rest %XX upper-case", () => {
    expect(sigv4Encode("aZ09-_.~")).toBe("aZ09-_.~");
    expect(sigv4Encode("a/b+c=d e!*'()")).toBe("a%2Fb%2Bc%3Dd%20e%21%2A%27%28%29");
    expect(amzDates(new Date("2026-10-30T01:02:03.456Z"))).toEqual({ amzDate: "20261030T010203Z", dateStamp: "20261030" });
  });
});

describe("the Transcribe streaming URL", () => {
  const creds = { accessKeyId: "ASIAEXAMPLEKEY", secretAccessKey: "secret/with+chars", sessionToken: "IQoJb3JpZ2luX2Vj/tok+en=" };
  const now = new Date("2026-10-30T12:34:56Z");
  const url = presignTranscribeUrl({ region: "us-east-1", languageCode: "ms-MY", creds, now });
  const u = new URL(url);

  it("is wss to the regional streaming host on :8443 and the websocket path", () => {
    expect(u.protocol).toBe("wss:");
    expect(u.host).toBe("transcribestreaming.us-east-1.amazonaws.com:8443");
    expect(u.pathname).toBe("/stream-transcription-websocket");
  });
  it("carries the stream params, the temporary credentials and a ≤300 s expiry", () => {
    const p = u.searchParams;
    expect(p.get("language-code")).toBe("ms-MY");
    expect(p.get("media-encoding")).toBe("pcm");
    expect(p.get("sample-rate")).toBe("16000");
    expect(p.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(p.get("X-Amz-Credential")).toBe("ASIAEXAMPLEKEY/20261030/us-east-1/transcribe/aws4_request");
    expect(p.get("X-Amz-Date")).toBe("20261030T123456Z");
    expect(p.get("X-Amz-Expires")).toBe("300");
    expect(p.get("X-Amz-SignedHeaders")).toBe("host");
    expect(p.get("X-Amz-Security-Token")).toBe(creds.sessionToken);
    expect(p.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(STT_URL_EXPIRES_S).toBe(300);
    expect(new URL(presignTranscribeUrl({ region: "us-east-1", languageCode: "en-US", creds, now, expiresS: 9999 })).searchParams.get("X-Amz-Expires")).toBe("300");
  });
  it("the signature is the documented canonical request, recomputed independently", () => {
    // Rebuild per the Transcribe guide: sorted, encoded query (minus the
    // signature); "host:<host>:8443\n"; signed headers "host"; empty payload.
    const canonicalQuery = url.split("?")[1]!.replace(/&X-Amz-Signature=[0-9a-f]+$/, "");
    const host = "transcribestreaming.us-east-1.amazonaws.com:8443";
    const h = (s: string) => createHash("sha256").update(s).digest("hex");
    const creq = ["GET", "/stream-transcription-websocket", canonicalQuery, `host:${host}\n`, "host", h("")].join("\n");
    const sts = ["AWS4-HMAC-SHA256", "20261030T123456Z", "20261030/us-east-1/transcribe/aws4_request", h(creq)].join("\n");
    let k: Buffer = createHmac("sha256", `AWS4${creds.secretAccessKey}`).update("20261030").digest();
    for (const part of ["us-east-1", "transcribe", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
    expect(u.searchParams.get("X-Amz-Signature")).toBe(createHmac("sha256", k).update(sts).digest("hex"));
    // …and the query really is sorted by code point (upper-case X-Amz-* before lower-case).
    const keys = canonicalQuery.split("&").map((kv) => kv.split("=")[0]!);
    expect(keys).toEqual([...keys].sort());
    expect(keys.indexOf("X-Amz-SignedHeaders")).toBeLessThan(keys.indexOf("language-code"));
  });
  it("omits the token for long-lived keys, and refuses a malformed region", () => {
    const plain = new URL(presignTranscribeUrl({ region: "us-west-2", languageCode: "en-US", creds: { accessKeyId: "AKIA", secretAccessKey: "s" }, now }));
    expect(plain.searchParams.has("X-Amz-Security-Token")).toBe(false);
    expect(plain.host).toBe("transcribestreaming.us-west-2.amazonaws.com:8443");
    expect(() => presignTranscribeUrl({ region: "evil.com/x", languageCode: "en-US", creds, now })).toThrow(/region/);
  });
});
