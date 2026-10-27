// UUIDv7 (contracts: "all ids are UUIDv7 — time-ordered, so event logs sort by
// id"). Node ≥ 20 and every browser give us crypto.getRandomValues; the 48-bit
// ms timestamp fills the first 12 hex digits so lexical order ≈ time order.
// Isomorphic: used by the server for session ids and by the student page for
// client-generated eventIds.

const HEX = "0123456789abcdef";

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 48-bit ms timestamp, big-endian, without BigInt (the app targets ES2017).
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += HEX[bytes[i]! >> 4]! + HEX[bytes[i]! & 15]!;
  }
  return s;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Client-generated event ids are untrusted input: a loose shape check so a
 * junk string can't become a storage key. */
export function isEventId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
