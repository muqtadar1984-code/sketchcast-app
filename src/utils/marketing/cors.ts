// CORS for the PUBLIC marketing endpoints — the handful of routes the static
// site at sketchcast.app reads cross-origin from app.sketchcast.app.
//
// WHY THIS EXISTS AT ALL. The marketing site is a hand-written static site on
// Cloudflare with no runtime and, by design, no secrets: it cannot call Lemon
// Squeezy or Supabase itself, because doing so would put a server key in a file
// any visitor can read. So anything the page needs to KNOW rather than assert
// has to be served by this app and fetched across an origin boundary.
//
// THE INVARIANT: never a wildcard. `Access-Control-Allow-Origin: *` on a route
// that is public today is a standing invitation for the next route added beside
// it to be public by accident, and it makes any later move to credentialed
// requests silently impossible. So we echo ONE exact allow-listed origin or we
// send no CORS header at all — the browser then blocks the read, which is the
// correct outcome for a caller we did not mean to serve. Modelled on
// boardCors() in src/utils/tutor/board.ts, which does the same for the board app.
//
// NOTE ON WHAT THIS IS *NOT*. CORS is not authentication and these routes carry
// no secret: a curl with no Origin header still gets the body, because the data
// is meant to be public and blocking it would only break uptime checks. The
// allow-list exists so a THIRD-PARTY PAGE cannot mount our marketing data in a
// reader's browser under its own branding, not to keep the numbers private.

/** The production marketing origins. Literals, not env, because these are our
 * own public domains — there is no secret here and an unset env var in
 * production must not silently break the pricing page's counter. */
const PRODUCTION_ORIGINS = ["https://sketchcast.app", "https://www.sketchcast.app"];

/** Local static-site dev servers: `wrangler dev` (8787/8788) and the Next app
 * itself (3000), so the counter can be exercised end to end without a deploy.
 * Never added in production — a localhost origin is trivially forgeable, and
 * while that costs nothing here it is a habit worth not forming. */
const DEV_ORIGINS = ["http://localhost:8787", "http://localhost:8788", "http://localhost:3000"];

/** Normalise to a bare scheme://host[:port], so a trailing slash or a stray
 * path in an env value can never produce an origin that matches nothing. */
function toOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

/** The allow-list. `MARKETING_ORIGINS` (comma-separated) EXTENDS the built-ins
 * rather than replacing them — a Cloudflare preview deployment needs to be
 * added for a day without anyone being able to knock production off the list by
 * fat-fingering the same variable. */
export function marketingOrigins(): string[] {
  const extra = (process.env.MARKETING_ORIGINS ?? "")
    .split(",")
    .map(toOrigin)
    .filter((o): o is string => !!o);
  const base = process.env.NODE_ENV === "production" ? PRODUCTION_ORIGINS : [...PRODUCTION_ORIGINS, ...DEV_ORIGINS];
  return Array.from(new Set([...base, ...extra]));
}

/** Preflight headers for a public marketing OPTIONS.
 *
 * WHY THE REQUESTED HEADERS ARE ECHOED. A preflight only happens because the
 * caller wants to send a header that makes the request non-simple; answering it
 * with an allow-list that does not name that header is the same as refusing it,
 * and the browser then never sends the GET at all. Echoing what was asked for
 * is the standard pattern and gives away nothing: these routes carry no secret
 * and read no cookie, so there is no header a caller could smuggle in that
 * would change what it is allowed to see. The origin gate above is what
 * actually decides that, and this function inherits it — no allow-listed
 * origin, no CORS headers at all, preflight included.
 *
 * The value is filtered to the RFC 7230 token characters (plus the comma and
 * space that separate a list) rather than reflected raw, so a hand-rolled
 * client cannot get anything but a header name list into a response header. */
export function marketingPreflightCors(reqOrigin: string | null, requestedHeaders: string | null): Record<string, string> {
  const base = marketingCors(reqOrigin);
  if (!Object.keys(base).length) return base;
  const asked = (requestedHeaders ?? "").replace(/[^A-Za-z0-9!#$%&'*+.^_`|~,\- ]/g, "").trim();
  return asked ? { ...base, "Access-Control-Allow-Headers": asked } : base;
}

/** CORS headers for a public marketing GET. Echoes the caller's origin only
 * when it is EXACTLY on the allow-list; `{}` otherwise (including for a request
 * with no Origin at all, which needs no CORS header to succeed).
 *
 * No `Access-Control-Allow-Credentials` and no cookie is ever read here: the
 * landing page fetches with `credentials: "omit"`, so a signed-in reader's
 * session never crosses the boundary and this response can never be
 * user-specific — which is also what makes it safe to cache at the CDN. */
export function marketingCors(reqOrigin: string | null): Record<string, string> {
  if (!reqOrigin) return {};
  const allowed = marketingOrigins();
  if (!allowed.includes(reqOrigin)) return {};
  return {
    "Access-Control-Allow-Origin": reqOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "600",
    // Vary is repeated UNCONDITIONALLY by the route (see route.ts): a shared
    // cache that stored the no-CORS variant without it would then serve that
    // header-less body to an allow-listed origin and break the counter.
    Vary: "Origin",
  };
}
