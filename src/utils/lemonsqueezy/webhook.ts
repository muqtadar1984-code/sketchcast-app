import crypto from "node:crypto";

// Lemon Squeezy webhook signature verification. LS signs the RAW request body
// with HMAC-SHA256 (hex) using the per-endpoint signing secret and sends it in
// the `X-Signature` header. Timing-safe compare; reject anything that doesn't
// match. (This is the LS analogue of Stripe's constructEvent.)

export function verifyLsSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(signatureHeader, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// LS webhooks have no persistent event id (unlike Stripe's evt_…), so we build
// a stable idempotency key from the event name + object id + object timestamp.
// Two deliveries of the same state produce the same key; a genuine state change
// produces a new one.
export function lsEventKey(eventName: string, objectId: string | number, updatedAt: string | undefined): string {
  return `ls_${eventName}_${objectId}_${updatedAt ?? ""}`;
}
