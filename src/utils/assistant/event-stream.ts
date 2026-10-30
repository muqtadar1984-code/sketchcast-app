// AWS event-stream binary framing (PURE; runs in the browser and in node
// tests). Amazon Transcribe's streaming WebSocket speaks it both ways: the
// client sends AudioEvent messages, the service answers TranscriptEvent
// messages (or one exception message, then a close).
//
//   [total length u32][headers length u32][prelude CRC32 u32]
//   [headers …][payload …][message CRC32 u32]          all big-endian
//
// The prelude CRC covers the first 8 bytes; the message CRC covers everything
// before it. A header is [name length u8][name][type u8][value]; type 7
// (string) and 6 (bytes) carry a u16 length. Every type is decoded so a
// service message with a timestamp or bytes header never derails the parser.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, the zlib one) — crc32("123456789") = 0xCBF43926. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type HeaderValue =
  | { type: "string"; value: string }
  | { type: "bytes"; value: Uint8Array }
  | { type: "boolean"; value: boolean }
  | { type: "byte" | "short" | "integer"; value: number }
  | { type: "long" | "timestamp"; value: bigint }
  | { type: "uuid"; value: Uint8Array };

export type EventMessage = { headers: Record<string, HeaderValue>; payload: Uint8Array };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encode one message. String headers only — all a client ever sends. */
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let hLen = 0;
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    if (n.length > 255) throw new Error("event-stream: header name too long");
    if (v.length > 0xffff) throw new Error("event-stream: header value too long");
    const h = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    h[0] = n.length;
    h.set(n, 1);
    h[1 + n.length] = 7;
    new DataView(h.buffer).setUint16(2 + n.length, v.length);
    h.set(v, 4 + n.length);
    parts.push(h);
    hLen += h.length;
  }
  const total = 12 + hLen + payload.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, hLen);
  dv.setUint32(8, crc32(out, 0, 8));
  let o = 12;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  out.set(payload, o);
  dv.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}

function decodeHeaders(b: Uint8Array, start: number, end: number): Record<string, HeaderValue> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Record<string, HeaderValue> = {};
  let o = start;
  const need = (n: number) => {
    if (o + n > end) throw new Error("event-stream: truncated header");
  };
  while (o < end) {
    need(1);
    const nLen = b[o++]!;
    need(nLen + 1);
    const name = dec.decode(b.subarray(o, o + nLen));
    o += nLen;
    const type = b[o++]!;
    switch (type) {
      case 0:
      case 1:
        out[name] = { type: "boolean", value: type === 0 };
        break;
      case 2:
        need(1);
        out[name] = { type: "byte", value: dv.getInt8(o) };
        o += 1;
        break;
      case 3:
        need(2);
        out[name] = { type: "short", value: dv.getInt16(o) };
        o += 2;
        break;
      case 4:
        need(4);
        out[name] = { type: "integer", value: dv.getInt32(o) };
        o += 4;
        break;
      case 5:
      case 8:
        need(8);
        out[name] = { type: type === 5 ? "long" : "timestamp", value: dv.getBigInt64(o) };
        o += 8;
        break;
      case 6:
      case 7: {
        need(2);
        const len = dv.getUint16(o);
        o += 2;
        need(len);
        const bytes = b.slice(o, o + len);
        o += len;
        out[name] = type === 7 ? { type: "string", value: dec.decode(bytes) } : { type: "bytes", value: bytes };
        break;
      }
      case 9:
        need(16);
        out[name] = { type: "uuid", value: b.slice(o, o + 16) };
        o += 16;
        break;
      default:
        throw new Error(`event-stream: unknown header type ${type}`);
    }
  }
  return out;
}

/** Decode exactly one message; throws on a bad length or either CRC. */
export function decodeMessage(b: Uint8Array): EventMessage {
  if (b.length < 16) throw new Error("event-stream: message too short");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const total = dv.getUint32(0);
  const hLen = dv.getUint32(4);
  if (total !== b.length) throw new Error("event-stream: length mismatch");
  if (dv.getUint32(8) !== crc32(b, 0, 8)) throw new Error("event-stream: prelude CRC mismatch");
  if (dv.getUint32(total - 4) !== crc32(b, 0, total - 4)) throw new Error("event-stream: message CRC mismatch");
  if (12 + hLen > total - 4) throw new Error("event-stream: headers overrun");
  return { headers: decodeHeaders(b, 12, 12 + hLen), payload: b.slice(12 + hLen, total - 4) };
}

/** Split a byte stream into messages: feed chunks, get whole messages back.
 * (A WebSocket frame normally holds one whole message; this does not rely on it.) */
export class MessageReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): EventMessage[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    const out: EventMessage[] = [];
    let o = 0;
    while (joined.length - o >= 4) {
      const total = new DataView(joined.buffer, o, 4).getUint32(0);
      if (total < 16 || total > 16 * 1024 * 1024) throw new Error("event-stream: bad message length");
      if (joined.length - o < total) break;
      out.push(decodeMessage(joined.slice(o, o + total)));
      o += total;
    }
    this.buf = joined.slice(o);
    return out;
  }
}

/** The client's one message kind: a chunk of 16 kHz PCM16 (empty = end of audio). */
export function audioEvent(pcm: Uint8Array): Uint8Array {
  return encodeMessage({ ":content-type": "application/octet-stream", ":event-type": "AudioEvent", ":message-type": "event" }, pcm);
}

const str = (h: HeaderValue | undefined) => (h && h.type === "string" ? h.value : undefined);

/** `languageCode`: the language Transcribe identified (identify-language
 *  sessions only — Result.LanguageCode). */
export type TranscriptResult = { text: string; partial: boolean; resultId?: string; languageCode?: string };

/** What a service message means to the dictation client. */
export type ServiceEvent =
  | { kind: "transcript"; results: TranscriptResult[] }
  | { kind: "exception"; type: string; message: string }
  | { kind: "other" };

export function readServiceEvent(m: EventMessage): ServiceEvent {
  const mt = str(m.headers[":message-type"]);
  if (mt === "exception" || mt === "error") {
    const type = str(m.headers[":exception-type"]) ?? str(m.headers[":error-code"]) ?? "Exception";
    let message = dec.decode(m.payload);
    try {
      const j = JSON.parse(message) as { Message?: unknown; message?: unknown };
      message = String(j.Message ?? j.message ?? message);
    } catch {
      /* plain text body */
    }
    return { kind: "exception", type, message };
  }
  if (mt !== "event" || str(m.headers[":event-type"]) !== "TranscriptEvent") return { kind: "other" };
  let j: unknown;
  try {
    j = JSON.parse(dec.decode(m.payload));
  } catch {
    return { kind: "other" };
  }
  const raw = (j as { Transcript?: { Results?: unknown } })?.Transcript?.Results;
  const results: TranscriptResult[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw as Array<{ Alternatives?: Array<{ Transcript?: unknown }>; IsPartial?: unknown; ResultId?: unknown; LanguageCode?: unknown }>) {
      const text = r?.Alternatives?.[0]?.Transcript;
      if (typeof text !== "string") continue;
      results.push({
        text,
        partial: r.IsPartial !== false,
        ...(typeof r.ResultId === "string" ? { resultId: r.ResultId } : {}),
        ...(typeof r.LanguageCode === "string" && /^[a-z]{2,3}-[A-Z]{2}$/.test(r.LanguageCode) ? { languageCode: r.LanguageCode } : {}),
      });
    }
  }
  return { kind: "transcript", results };
}
