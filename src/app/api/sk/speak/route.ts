// SK B9 — POST /api/sk/speak: one of SK's own lines → neural mp3 + word and
// viseme marks (Amazon Polly). { text, look } → { format: "mp3", audio:
// <base64>, marks, voice }. JSON with base64 audio rather than multipart:
// the client needs one fetch and one JSON parse, browsers have no multipart
// response parser, and SK's lines are 10–60 KB of mp3 — a third more on the
// wire for base64 is nothing against a round trip. Nothing is cached.
//
// Order of refusals: SK_TTS unset → 404 before anything (the client reads it
// as "no server voice" and stays on the browser adapter); then the SK gate
// (feature flag, allow-list, sign-in); then the body.

import { NextResponse } from "next/server";
import { gate, readBody, skSpeech, skTtsMode } from "@/sk/server";
import { MAX_SPEAK_CHARS, voiceForLook } from "@/sk/speech/polly-marks";

export const runtime = "nodejs";

async function bytesOf(audio: Uint8Array | ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!audio) return new Uint8Array(0);
  if (audio instanceof Uint8Array) return audio;
  const chunks: Uint8Array[] = [];
  const reader = audio.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function POST(request: Request) {
  if (skTtsMode() !== "polly") return NextResponse.json({ error: "Not available." }, { status: 404 });
  const g = await gate();
  if (!g.ok) return g.response;
  const body = await readBody<{ text?: unknown; look?: unknown }>(request);
  if (!body || typeof body.text !== "string") return NextResponse.json({ error: "text must be a string." }, { status: 400 });
  const text = body.text.replace(/\s+/g, " ").trim();
  if (!text) return NextResponse.json({ error: "Nothing to say." }, { status: 400 });
  if (text.length > MAX_SPEAK_CHARS) return NextResponse.json({ error: `Lines are capped at ${MAX_SPEAK_CHARS} characters.` }, { status: 413 });
  const provider = skSpeech();
  if (!provider) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const voice = voiceForLook(body.look);
  try {
    const r = await provider.synthesize(text, voice, { marks: ["word", "viseme"], signal: request.signal });
    if (r.format !== "mp3") throw new Error(`unexpected audio format ${r.format}`);
    const audio = Buffer.from(await bytesOf(r.audio)).toString("base64");
    return NextResponse.json({ format: "mp3", audio, marks: r.marks, voice }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[sk] speak failed:", e);
    return NextResponse.json({ error: "Speech is unavailable right now." }, { status: 502 });
  }
}
