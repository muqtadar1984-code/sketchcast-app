import { NextResponse } from "next/server";
import { marketingOrigins } from "@/utils/marketing/cors";
import { createAdminClient } from "@/utils/supabase/admin";
import { countryFromHeaders } from "@/utils/geo";
import { cleanPath, deviceOf, isBotUserAgent, refHost, utcDay, visitorHash } from "@/utils/traffic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The visit beacon — the one write behind /console/traffic (migration 0118).
//
// ONE SITE: sketchcast.app, the public website. The marketing pages post
// here cross-origin from assets/visit.js; the app, the console and the
// library are not counted — they are customers' and staff's working tools,
// not the shop window, and the number this feeds is "how many people come
// to the website", the one an advertiser asks for (founder, 2026-09-21).
// So the allow-list is exactly the marketing origins, and a post from any
// other origin — our own app included — is dropped.
//
// The body is a small JSON document sent with navigator.sendBeacon as
// text/plain, which is a CORS "simple request" — no preflight, so a page
// that is closing can still get it out. The response is 204, empty.
//
// WHAT IS STORED, AND WHAT IS NOT. The host (from the Origin header, which
// the browser sets and a page cannot forge), the path without its query
// string, the referrer's HOST, the edge's country code, a coarse device kind,
// and a visitor token: sha256 of a salt that rotates every UTC day plus the
// address and the user agent. No cookie is set, no IP is written, no
// full URL is kept. A crawler's user agent is refused before the row exists.
//
// WHAT THIS IS NOT. Not authentication and not a secret: a curl can post a
// visit, exactly as it could load the page. The Origin gate keeps a third-
// party page from posting under our host; the bot filter and the daily
// hash keep the numbers honest enough to read, not tamper-proof.

/** The allow-listed origins: the marketing site's, and nothing else
 *  (utils/marketing/cors.ts adds localhost outside production). */
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  return marketingOrigins().includes(origin) ? origin : null;
}

function cors(origin: string | null): Record<string, string> {
  const ok = allowedOrigin(origin);
  if (!ok) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: cors(request.headers.get("origin")) });
}

type Body = { p?: unknown; r?: unknown };

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = cors(origin);
  const ok = allowedOrigin(origin);
  // A post from an origin we do not serve is dropped, silently: 204 either
  // way, so nothing about the allow-list is learnable from the response.
  if (!ok) return new NextResponse(null, { status: 204, headers });

  const ua = request.headers.get("user-agent");
  if (isBotUserAgent(ua)) return new NextResponse(null, { status: 204, headers });

  let body: Body = {};
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Body) : {};
  } catch {
    body = {};
  }
  const path = cleanPath(typeof body.p === "string" ? body.p : "/");
  const host = new URL(ok).hostname.toLowerCase();
  const ref = refHost(typeof body.r === "string" ? body.r : null);
  const ip = request.headers.get("x-real-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const secret = process.env.VISIT_HASH_SECRET || process.env.CRON_SECRET || "sketchcast-visits";
  const visitor = visitorHash(secret, ip, ua, utcDay());

  try {
    const admin = createAdminClient();
    await admin.from("site_visits").insert({
      host,
      path,
      ref_host: ref,
      country: countryFromHeaders(request.headers),
      visitor,
      device: deviceOf(ua),
    });
  } catch (e) {
    // A counter must never surface as an error on somebody's page.
    console.error("visit beacon insert failed:", (e as Error).message);
  }
  return new NextResponse(null, { status: 204, headers });
}
