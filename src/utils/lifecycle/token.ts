import { createHmac, timingSafeEqual } from "node:crypto";

/** Unsubscribe tokens.
 *
 * An HMAC of the user id, so the link works without a login (a user who can't
 * remember their password must still be able to unsubscribe — that's the whole
 * point) while remaining unguessable and un-enumerable. It grants exactly one
 * capability: setting your own email_optout_at. It is NOT a session.
 */

function secret(): string {
  const s = process.env.LIFECYCLE_TOKEN_SECRET;
  if (!s) throw new Error("LIFECYCLE_TOKEN_SECRET is not set");
  return s;
}

export function unsubscribeToken(userId: string): string {
  const mac = createHmac("sha256", secret()).update(userId).digest("hex").slice(0, 32);
  return `${userId}.${mac}`;
}

/** The user id if the token is authentic, else null. */
export function verifyUnsubscribeToken(token: string | null): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const given = token.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", secret()).update(userId).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}

/** Constant-time compare for the cron shared secret. */
export function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
