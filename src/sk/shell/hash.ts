// SK Shell — hashing primitives (Final Plan §8.2). Node crypto only; no app
// imports, so the memory blob and the action tokens (S1) share one seam.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ContextHashParts = {
  role: string | null | undefined;
  schoolId: string | null | undefined;
  hat: string | null | undefined;
  plan: string | null | undefined;
  /** S5 (design decision 8): the coordinator_scope rows. Absent or empty →
   *  the hash is exactly the pre-S5 one, so no other user's tokens change. */
  scope?: ReadonlyArray<{ grade: string | null; subject: string | null }> | null;
};

/** A stable digest of coordinator_scope rows: each row folded to
 *  `grade|subject` (trimmed, lower-cased, a null subject as "*"), de-duplicated
 *  and sorted, so row order and spelling case never change it. "" when empty. */
export function scopeDigest(scope: ContextHashParts["scope"]): string {
  const fold = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const rows = [...new Set((scope ?? []).map((r) => `${fold(r.grade)}|${fold(r.subject) || "*"}`).filter((r) => !r.startsWith("|")))].sort();
  return rows.length ? createHash("sha256").update(rows.join("\n"), "utf8").digest("hex").slice(0, 32) : "";
}

/** sha256 hex of `role|schoolId|hat|plan` (+ `|scope:<digest>` when the user
 *  holds coordinator scope). A hat, school, role, plan or SCOPE change yields
 *  a new hash, which is what invalidates memory and tokens (§5.4, §8.1). */
export function contextHash(p: ContextHashParts): string {
  const parts = [p.role ?? "", p.schoolId ?? "", p.hat ?? "", p.plan ?? ""];
  const digest = scopeDigest(p.scope);
  if (digest) parts.push(`scope:${digest}`);
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
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
