// SK voice log (2026-10-30): the browser's report of how SK's voice behaved —
// each sentence's provider and outcome, an autoplay refusal, a fall back to the
// browser voice, the mic opening or closing during the tour. Written to the
// function log ONLY (one line per batch), so "the sound doesn't work" can be
// diagnosed from the logs instead of a screen share. No text SK said, no audio,
// nothing stored. Same gate as every SK route.

import { NextResponse } from "next/server";
import { gate, readBody } from "@/sk/server";
import { cleanVoiceEvents } from "@/sk/shell/client/voice-log";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ events?: unknown; ua?: unknown }>(request);
  const events = cleanVoiceEvents(body?.events);
  if (!events.length) return new NextResponse(null, { status: 204 });
  const ua = typeof body?.ua === "string" ? body.ua.slice(0, 160) : "";
  console.info(`[sk] voice-log ${JSON.stringify({ user: g.userId, ua, events })}`);
  return new NextResponse(null, { status: 204 });
}
