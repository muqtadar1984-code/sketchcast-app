// Scoped, short-lived token for the standalone board app (Phase 2). The board
// runs on a different origin (board.sketchcast.app) inside an iframe, so it can't
// present the portal's Supabase cookie. Instead the PORTAL (which is
// cookie-authenticated) mints this compact HMAC token bound to (student,
// generation) and hands it to the iframe via postMessage; the iframe sends it as
// `Authorization: Bearer <token>` to /api/tutor/turn.
//
// The token proves "this user was allowed to open this lesson's board at mint
// time"; the turn route STILL re-runs resolveTutorContext + the Pro+ gate, so a
// leaked/replayed token can never exceed the (user, generation) scope and only
// works while access holds. Short TTL bounds replay. Format: `<b64url(payload)>.
// <b64url(hmac)>` — self-contained, no DB round-trip.

import crypto from "node:crypto";

const TTL_SEC = 600; // 10 minutes — the portal re-mints on expiry

function secret(): string {
  const s = process.env.BOARD_TOKEN_SECRET;
  if (!s || s.length < 16) throw new Error("BOARD_TOKEN_SECRET is not set (need a ≥16-char random secret).");
  return s;
}

const hmac = (body: string): string =>
  crypto.createHmac("sha256", secret()).update(body).digest("base64url");

export type BoardTokenClaims = { sub: string; gen: string };

/** Mint a token for (userId, generationId). `now` is injectable for tests. */
export function signBoardToken(userId: string, generationId: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload = { sub: userId, gen: generationId, scope: "board", iat, exp: iat + TTL_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** Verify signature + scope + expiry. Returns the claims, or null if invalid.
 * Constant-time signature check; never throws on malformed input. */
export function verifyBoardToken(token: string, now: number = Date.now()): BoardTokenClaims | null {
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

  let p: { sub?: unknown; gen?: unknown; scope?: unknown; exp?: unknown };
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (p.scope !== "board" || typeof p.sub !== "string" || typeof p.gen !== "string") return null;
  if (typeof p.exp !== "number" || p.exp * 1000 < now) return null;
  return { sub: p.sub, gen: p.gen };
}

export const BOARD_TOKEN_TTL_SEC = TTL_SEC;
