// SK S6 slice B — presign the Amazon Transcribe streaming WebSocket (SERVER
// ONLY: it touches AWS credentials and node:crypto).
//
// The browser opens the socket itself, straight to AWS; Vercel never holds the
// stream. This module only signs the upgrade URL, following "Setting up a
// streaming transcription → WebSocket" in the Transcribe developer guide
// (read 2026-10-30), step for step:
//   GET wss://transcribestreaming.<region>.amazonaws.com:8443/stream-transcription-websocket
//   service "transcribe"; canonical headers "host:<host>:8443\n"; signed
//   headers "host"; payload hash = SHA-256 of the empty string; the query
//   (X-Amz-* incl. X-Amz-Security-Token, then language-code, media-encoding,
//   sample-rate) URI-encoded per RFC 3986 and sorted by code point; then
//   X-Amz-Signature appended. X-Amz-Expires max 300.
// SigV4 itself is a dozen lines of HMAC, so no SDK signer is pulled in; the
// test suite checks the algorithm against AWS's published presign example.
//
// The URL carries a live session token and signature: it is RETURNED, never
// logged. No call to AWS is made here — signing is local.

import { createHash, createHmac } from "node:crypto";
import { STT_URL_EXPIRES_S } from "./stt";

export type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** RFC 3986 encoding as SigV4 wants it: unreserved A-Z a-z 0-9 - _ . ~ kept,
 * everything else %XX upper-case (encodeURIComponent leaves !'()* alone). */
export function sigv4Encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** "20260130T235959Z" and "20260130" for a Date. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export type PresignInput = {
  method?: string;
  /** "host[:port]" exactly as the client will send it in the Host header. */
  host: string;
  path: string;
  service: string;
  region: string;
  creds: AwsCreds;
  now: Date;
  expiresS: number;
  /** Non-auth query params (already plain strings; encoded here). */
  params: Record<string, string>;
  /** Hex SHA-256 of the payload; S3 presigns use "UNSIGNED-PAYLOAD". */
  payloadHash?: string;
};

/** Generic SigV4 query-string presign (signed headers: host). Returns the
 * canonical query string WITH X-Amz-Signature appended. */
export function presignQuery(p: PresignInput): string {
  const { amzDate, dateStamp } = amzDates(p.now);
  const scope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const q: Record<string, string> = {
    ...p.params,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${p.creds.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(p.expiresS),
    "X-Amz-SignedHeaders": "host",
  };
  if (p.creds.sessionToken) q["X-Amz-Security-Token"] = p.creds.sessionToken;
  const canonicalQuery = Object.keys(q)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) // code-point order: upper before lower
    .map((k) => `${sigv4Encode(k)}=${sigv4Encode(q[k]!)}`)
    .join("&");
  const canonicalRequest = [
    p.method ?? "GET",
    p.path,
    canonicalQuery,
    `host:${p.host}\n`,
    "host",
    p.payloadHash ?? sha256Hex(""),
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${p.creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, p.region);
  const kService = hmac(kRegion, p.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export const TRANSCRIBE_PORT = 8443;
export const TRANSCRIBE_PATH = "/stream-transcription-websocket";
export const TRANSCRIBE_SAMPLE_RATE = 16000;

export function transcribeHost(region: string): string {
  return `transcribestreaming.${region}.amazonaws.com:${TRANSCRIBE_PORT}`;
}

/** Automatic language identification: the options (two or more, one dialect
 *  per language) and the preferred one (one of them). */
export type TranscribeIdentify = { options: readonly string[]; preferred?: string };

const LANG_CODE_RE = /^[a-z]{2,3}-[A-Z]{2}$/;

/** The presigned wss:// URL for one streaming session: 16 kHz PCM, one
 *  language — or, with `identify`, the language Transcribe identifies among
 *  the options (`identify-language` + `language-options` [+
 *  `preferred-language`] in place of `language-code`: the API refuses both). */
export function presignTranscribeUrl(input: { region: string; languageCode: string; creds: AwsCreds; now: Date; expiresS?: number; identify?: TranscribeIdentify }): string {
  if (!/^[a-z]{2}-[a-z0-9-]+$/.test(input.region)) throw new Error("transcribe: bad region");
  const id = input.identify;
  if (id) {
    const bases = id.options.map((o) => o.split("-")[0]);
    if (id.options.length < 2 || !id.options.every((o) => LANG_CODE_RE.test(o)) || new Set(bases).size !== bases.length) throw new Error("transcribe: bad language options");
    if (id.preferred && !id.options.includes(id.preferred)) throw new Error("transcribe: preferred language not among the options");
  }
  const language: Record<string, string> = id
    ? { "identify-language": "true", "language-options": id.options.join(","), ...(id.preferred ? { "preferred-language": id.preferred } : {}) }
    : { "language-code": input.languageCode };
  const host = transcribeHost(input.region);
  const query = presignQuery({
    host,
    path: TRANSCRIBE_PATH,
    service: "transcribe",
    region: input.region,
    creds: input.creds,
    now: input.now,
    expiresS: Math.min(input.expiresS ?? STT_URL_EXPIRES_S, STT_URL_EXPIRES_S),
    params: {
      ...language,
      "media-encoding": "pcm",
      "sample-rate": String(TRANSCRIBE_SAMPLE_RATE),
    },
  });
  return `wss://${host}${TRANSCRIBE_PATH}?${query}`;
}
