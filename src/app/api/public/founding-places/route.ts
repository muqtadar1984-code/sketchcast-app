import { NextResponse } from "next/server";
import { marketingCors, marketingPreflightCors } from "@/utils/marketing/cors";
import { resolveFoundingPlaces, type FoundingPlaces } from "@/utils/lemonsqueezy/founding-places";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/public/founding-places
//
// How many of the 50 Founding Teacher places are gone. Read cross-origin by the
// static marketing site (sketchcast.app/pricing) so its scarcity line can state
// a measured number instead of a written-down one. See
// src/utils/lemonsqueezy/founding-places.ts for where the number comes from and
// why no literal count or cap exists anywhere in this repo.
//
// ── WHY /api/public/ ────────────────────────────────────────────────────────
// Every other route in this tree is gated: a session, a role, a signed token, a
// webhook signature. This one is deliberately open to the internet, and the
// path segment says so, so nobody has to open the file to know its auth
// posture. It also gives the next marketing endpoint an obvious home instead of
// a second unguarded route hiding among the guarded ones in /api/billing.
//
// ── CONTRACT ────────────────────────────────────────────────────────────────
//   200 { status:"ok", claimed, max|null, remaining|null, source, asOf }
//   200 { status:"unknown" }          ← no numeric keys AT ALL (see below)
// ALWAYS 200. A marketing page's fetch must never see a 500: a 4xx/5xx here
// would put a red line in a visitor's console on a page whose whole job is
// trust, for a decoration. Failure is expressed IN the body, and the only
// failure shape carries no numbers, so a consumer cannot accidentally render
// "0 of 50" out of an outage. Zero is a real, publishable count; unknown is the
// absence of one, and the two must never be confusable.
//
// ── CACHING: Cache-Control s-maxage, NOT `export const revalidate` ──────────
// Two reasons, and the first is decisive. This handler reads the request's
// Origin header to decide which CORS header to echo, which makes it dynamic by
// definition — the route-segment cache caches a RENDER, and cannot express "one
// body, per-origin header". Second, s-maxage puts the cache where the traffic
// actually is: Vercel's CDN answers the reader without ever invoking this
// function, which is what keeps a busy pricing page off the Lemon Squeezy API.
// (Route-segment `revalidate` is also the option Next 16 has begun retiring —
// it disappears entirely under Cache Components.) The in-process memo in
// founding-places.ts covers the requests that get past the CDN.
//
// 300s: a counter on a 50-place cap that is five minutes stale is invisible to
// a reader and bounds LS traffic to ~12 calls/hour/region under any load.
// stale-while-revalidate=86400: if LS is down, the CDN keeps serving the last
// good body for a day rather than degrading the page — the counter's failure
// mode should be "slightly old", and only then "absent".
const CACHE_CONTROL_OK = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";

// ⚠️ A FAILURE IS NOT CACHED ON THE SAME TERMS AS AN ANSWER, and this is the
// difference between a blip and an outage. The CDN stores whatever body it was
// handed, so one request sampled during a 20-second Supabase wobble would
// otherwise EVICT the good body and pin `{"status":"unknown"}` — a page with no
// counter — in front of every reader for the next five minutes, with a
// day-long stale window behind it. The short window here matches the deliberate
// 10s MEMO_UNKNOWN_MS in founding-places.ts, which exists for exactly the same
// reason: caching a failure is how a 30-second blip becomes a 10-minute blank
// counter. No stale-while-revalidate at all — there is nothing worth serving
// stale about "we do not know".
const CACHE_CONTROL_UNKNOWN = "public, max-age=10, s-maxage=15";

const headersFor = (request: Request, body: FoundingPlaces | null) => ({
  ...(request.method === "OPTIONS"
    ? marketingPreflightCors(request.headers.get("origin"), request.headers.get("access-control-request-headers"))
    : marketingCors(request.headers.get("origin"))),
  // A preflight (body === null) is a fact about the ROUTE, not about the count,
  // so it keeps the long window whatever the counter is doing.
  "Cache-Control": body && body.status !== "ok" ? CACHE_CONTROL_UNKNOWN : CACHE_CONTROL_OK,
  // Vercel reads this in preference to Cache-Control for its own edge, so the
  // two can never drift apart into "browser cached, CDN did not".
  "CDN-Cache-Control": body && body.status !== "ok" ? CACHE_CONTROL_UNKNOWN : CACHE_CONTROL_OK,
  // UNCONDITIONAL, and it must stay that way. marketingCors() returns no
  // headers for a non-allow-listed origin; without Vary a shared cache could
  // store that header-less body and then hand it to sketchcast.app, breaking
  // the counter for everyone until the entry expired.
  Vary: "Origin",
});

// A simple cross-origin GET triggers no preflight, so this is belt-and-braces —
// but it costs four lines and means the route does not break the day a consumer
// adds a header that does trigger one. For that to be TRUE rather than merely
// intended, the preflight must answer the browser's Access-Control-Request-
// Headers: a 204 that names no allowed headers fails the preflight, and the GET
// is then never sent. marketingPreflightCors echoes what was asked for.
export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: headersFor(request, null) });
}

export async function GET(request: Request) {
  let body: FoundingPlaces;
  try {
    body = await resolveFoundingPlaces();
  } catch (e) {
    // resolveFoundingPlaces already swallows both sources' failures, so getting
    // here means something unexpected (a missing service-role key, say). Log it
    // loudly for us, say nothing to the reader beyond "unknown".
    console.error("public.founding_places.error", (e as Error).message);
    body = { status: "unknown" };
  }
  return NextResponse.json(body, { headers: headersFor(request, body) });
}
