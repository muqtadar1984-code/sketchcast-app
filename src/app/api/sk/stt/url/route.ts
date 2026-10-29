// SK S6 slice B — POST /api/sk/stt/url: a presigned Amazon Transcribe
// streaming WebSocket URL for ONE dictation. { lang } → { url, expiresAt,
// languageCode }. The browser opens the socket itself, straight to AWS.
//
// Order of refusals (every one sends the client back to browser Web Speech):
//   SK_STT is not "transcribe"         → 404, before anything (nothing chargeable is on)
//   the SK gate (flag, allow-list, sign-in) → 404 / 401
//   lang not one of en / ms / ar / zh  → 400 { reason: "unsupported_language" }
//   a student without `voice` consent  → 403 { reason: "no_voice_consent" }  (adults need none)
//   30 URLs this hour for this user    → 429 { reason: "rate_limited" }      (per instance)
//   no credentials / signing failed    → 503 { reason: "unavailable" }
//
// The URL carries a session token and a signature. It is returned with
// no-store and NEVER logged — error logs carry the error message only.

import { NextResponse } from "next/server";
import { gate, readBody } from "@/sk/server";
import { memoryAllowed, type ConsentDb } from "@/sk/consent";
import { skSttMode, STT_URL_EXPIRES_S, transcribeLanguageFor } from "@/sk/speech/stt";
import { presignTranscribeUrl } from "@/sk/speech/transcribe-presign";
import { sttCredentials, sttRegion, takeSttUrl } from "@/sk/speech/transcribe-server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (skSttMode() !== "transcribe") return NextResponse.json({ error: "Not available." }, { status: 404 });
  const g = await gate();
  if (!g.ok) return g.response;

  const body = await readBody<{ lang?: unknown }>(request);
  const languageCode = transcribeLanguageFor(body?.lang);
  if (!languageCode) return NextResponse.json({ error: "Language not supported.", reason: "unsupported_language" }, { status: 400 });

  // §8.1 / decision 3: Transcribe for a STUDENT needs `voice` consent (a
  // verified guardian, or the school's switch). memoryAllowed applies the
  // adult rule (no one's consent needed for their own voice) and fails closed.
  let allowed = false;
  try {
    allowed = await memoryAllowed(createAdminClient() as unknown as ConsentDb, g.userId, "voice");
  } catch (e) {
    console.error("[sk] stt consent check failed:", (e as Error).message);
  }
  if (!allowed) return NextResponse.json({ error: "Voice consent is needed.", reason: "no_voice_consent" }, { status: 403 });

  if (!takeSttUrl(g.userId)) return NextResponse.json({ error: "Too many voice sessions this hour.", reason: "rate_limited" }, { status: 429 });

  try {
    const creds = await sttCredentials();
    const now = new Date();
    const url = presignTranscribeUrl({ region: sttRegion(), languageCode, creds, now, expiresS: STT_URL_EXPIRES_S });
    const expiresAt = new Date(now.getTime() + STT_URL_EXPIRES_S * 1000).toISOString();
    return NextResponse.json({ url, expiresAt, languageCode }, { headers: NO_STORE });
  } catch (e) {
    console.error("[sk] stt url failed:", (e as Error).message);
    return NextResponse.json({ error: "Voice is unavailable right now.", reason: "unavailable" }, { status: 503 });
  }
}
