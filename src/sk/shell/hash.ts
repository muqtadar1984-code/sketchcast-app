// SK Shell — hashing primitives (Final Plan §8.2). Node crypto only; no app
// imports, so the memory blob and the action tokens (S1) share one seam.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ContextHashParts = {
  role: string | null | undefined;
  schoolId: string | null | undefined;
  hat: string | null | undefined;
  plan: string | null | undefined;
};

/** sha256 hex of `role|schoolId|hat|plan`. A hat, school, role or plan change
 *  yields a new hash, which is what invalidates memory and tokens (§5.4). */
export function contextHash(p: ContextHashParts): string {
  const line = [p.role ?? "", p.schoolId ?? "", p.hat ?? "", p.plan ?? ""].join("|");
  return createHash("sha256").update(line, "utf8").digest("hex");
}

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Constant-time compare of two hex strings; false on a length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function base64UrlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

export function base64UrlDecode(s: string): string | null {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
}
