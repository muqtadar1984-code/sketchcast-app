// Signed, single-use-ish decision token for the email Approve/Reject links. The
// email is the only place these links exist; tapping one hits /api/autofix/decide,
// which verifies the HMAC here and then enforces true single-use via the run's
// decided_at column. Self-contained `<b64url(payload)>.<b64url(hmac)>` — no DB
// round-trip to validate the signature. Mirrors src/utils/tutor/board-token.ts.

import crypto from "node:crypto";

const TTL_SEC = 7 * 24 * 60 * 60; // 7 days — plenty of time to tap from a phone

function secret(): string {
  const s = process.env.AUTOFIX_TOKEN_SECRET;
  if (!s || s.length < 16) throw new Error("AUTOFIX_TOKEN_SECRET is not set (need a ≥16-char random secret).");
  return s;
}

const hmac = (body: string): string =>
  crypto.createHmac("sha256", secret()).update(body).digest("base64url");

export type Decision = "approve" | "reject";
export type DecisionClaims = { run: string; action: Decision };

/** Mint a decision link token for (runId, action). `now` injectable for tests. */
export function signDecisionToken(runId: string, action: Decision, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload = { run: runId, action, scope: "autofix", iat, exp: iat + TTL_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** Verify signature + scope + expiry. Returns claims, or null. Constant-time
 * signature check; never throws on malformed input (or an unset secret). */
export function verifyDecisionToken(token: string, now: number = Date.now()): DecisionClaims | null {
  const dot = (token || "").indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = hmac(body);
  } catch {
    return null; // secret not configured
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let p: { run?: unknown; action?: unknown; scope?: unknown; exp?: unknown };
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (p.scope !== "autofix" || typeof p.run !== "string") return null;
  if (p.action !== "approve" && p.action !== "reject") return null;
  if (typeof p.exp !== "number" || p.exp * 1000 < now) return null;
  return { run: p.run, action: p.action };
}

export const AUTOFIX_TOKEN_TTL_SEC = TTL_SEC;
