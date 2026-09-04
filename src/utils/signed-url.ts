// When a Supabase signed URL stops working — read off the URL itself.
//
// The dashboard signs every artifact for one hour and never re-signs while the
// tab stays open. A student who comes back to a tab left open over lunch and
// clicks a link is handed a URL that storage will refuse — and for the deck
// (kind 'deck', 0103) that click is ALSO what records the item complete. The
// row would say "Completed" over a download that never happened.
//
// A signed URL carries its own lifetime: the `token` query parameter is a JWT
// whose payload is `{ url, iat, exp }`. Reading it costs no network. PURE — no
// next/*, no server-only — it runs in the client row.
//
// AGE, NOT INSTANT. `exp` is an instant on the SERVER's clock; comparing it
// against the student's device clock made a fast clock refuse every click
// forever (and a slow one never refuse). So the check measures how long the
// link has been HELD: the URL is minted at render, the row notes when it
// mounted, and the link is refused only once that age exceeds the token's
// own lifetime `(exp - iat)` less a small margin for the render-to-mount gap.
// A device clock only has to be steady for an hour, not correct.
//
// FAIL OPEN: anything that is not recognisably a signed URL with a readable
// lifetime (no token, a token that is not a JWT, a payload missing iat or exp,
// a lifetime that is not positive) reports "not expired". A future change to
// the URL shape must not turn every deck link into a refusal; the worst case
// is then the old behaviour, a storage error after the click.

/** Milliseconds allowed between the server minting the URL and the row
 * mounting on the student's device — the age the row cannot see. Small next
 * to the hour a link lives, large next to any hydration. */
export const SIGNED_URL_AGE_MARGIN_MS = 30_000;

/** The instants (ms since epoch, on the MINTING server's clock) a signed URL
 * was issued and stops working, or null when the URL does not carry both. */
export function signedUrlWindow(url: string): { issuedAt: number; expiresAt: number } | null {
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
    const payload = JSON.parse(atob(padded)) as { iat?: unknown; exp?: unknown };
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const iat = num(payload.iat);
    const exp = num(payload.exp);
    if (iat === null || exp === null) return null;
    return { issuedAt: iat * 1000, expiresAt: exp * 1000 };
  } catch {
    return null;
  }
}

/** The instant (ms since epoch) this signed URL stops working, or null when
 * the URL does not carry a readable window. A server-clock instant — compare
 * it with nothing on a device; it is here for display and for tests. */
export function signedUrlExpiresAt(url: string): number | null {
  return signedUrlWindow(url)?.expiresAt ?? null;
}

/** How long the URL works from the moment it was minted, in ms, or null when
 * the URL carries no readable POSITIVE lifetime (fail open). */
export function signedUrlLifetimeMs(url: string): number | null {
  const w = signedUrlWindow(url);
  if (!w) return null;
  const life = w.expiresAt - w.issuedAt;
  return life > 0 ? life : null;
}

/** True only when the URL carries a lifetime and the link has been HELD
 * longer than it, less the margin: `heldAt` is when the holder first had the
 * URL (the row's mount), `now` the same clock later. Both are the holder's
 * clock, so its offset from the server cancels out. */
export function signedUrlExpired(
  url: string,
  heldAt: number,
  now: number = Date.now(),
  marginMs: number = SIGNED_URL_AGE_MARGIN_MS,
): boolean {
  const life = signedUrlLifetimeMs(url);
  return life !== null && now - heldAt > life - marginMs;
}
