import { NextResponse } from "next/server";
import { kitDeps, kitReply, parseKitQuery, resolveKit } from "@/sk/kit-server";
import { gate, readBody } from "@/sk/server";

export const runtime = "nodejs";
// A first open derives the kit map in the request (as the Board's POST does).
export const maxDuration = 60;

// /api/sk/kit — the student kit player's kit (SK S3 slice B).
//
//   GET  ?product=<slug|id>&chapter=<ref>[&kit=<generation id>]
//        → { status: "ready", kits, kit: { generationId, title, chapterRef,
//              language, videoUrl, videos[], segments[] } }
//        | { status: "preparing", kits, kit: { generationId, title } }
//        | { status: "unavailable", kits, kit, reason: "map_failed" }
//        Reads the kit map; never builds it.
//   POST { product, chapter, kit? }
//        Builds the kit map on first open (the Board's pattern: GET, then one
//        POST on missing/stale, then poll GET) and answers like GET.
//
// Refusals answer { error, reason }: 403 not_entitled; 404 unknown_product,
// not_mapped, no_kit. The order of checks is in src/sk/kit-server.ts.

async function handle(src: Record<string, unknown> | null, mode: "read" | "build"): Promise<Response> {
  const g = await gate();
  if (!g.ok) return g.response;
  const q = src ? parseKitQuery(src) : null;
  if (!q) return NextResponse.json({ error: "product and chapter are required." }, { status: 400 });
  const deps = kitDeps();
  try {
    const r = await resolveKit(deps, g.userId, q);
    if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason }, { status: r.status });
    return NextResponse.json(await kitReply(deps, r, mode));
  } catch (e) {
    console.error("[sk] kit failed:", (e as Error).message);
    return NextResponse.json({ error: "The lesson could not be loaded." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  return handle({ product: sp.get("product"), chapter: sp.get("chapter"), kit: sp.get("kit") }, "read");
}

export async function POST(request: Request) {
  return handle(await readBody(request), "build");
}
