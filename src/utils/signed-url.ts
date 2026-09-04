// When a Supabase signed URL stops working — read off the URL itself.
//
// The dashboard signs every artifact for one hour and never re-signs while the
// tab stays open. A student who comes back to a tab left open over lunch and
// clicks a link is handed a URL that storage will refuse — and for the deck
// (kind 'deck', 0103) that click is ALSO what records the item complete. The
// row would say "Completed" over a download that never happened.
//
// A signed URL carries its own expiry: the `token` query parameter is a JWT
// whose payload is `{ url, iat, exp }`. Reading `exp` costs no network and is
// the same number storage checks, so the click can refuse BEFORE recording
// anything. PURE — no next/*, no server-only — it runs in the client row.
//
// FAIL OPEN: anything that is not recognisably a signed URL with a readable
// expiry (no token, a token that is not a JWT, a payload with no exp) reports
// "not expired". A future change to the URL shape must not turn every deck
// link into a refusal; the worst case is then the old behaviour, a storage
// error after the click.

/** The instant (ms since epoch) this signed URL stops working, or null when
 * the URL does not carry a readable expiry. */
export function signedUrlExpiresAt(url: string): number | null {
  let token: string | null;
  try {
    token = new URL(url).searchParams.get("token");
  } catch {
    return null;
  }
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url → base64; atob needs the padding a JWT strips.
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True only when the URL carries an expiry and it has passed. */
export function signedUrlExpired(url: string, now: number = Date.now()): boolean {
  const at = signedUrlExpiresAt(url);
  return at !== null && at <= now;
}
