// AI Tutor voice (M4) — server-side synthesis for the PREMIUM path only. The free
// path never reaches here: the route tells the client to speak with the browser's
// own voice ($0). Premium (ElevenLabs) audio is character-capped and cached in
// storage, so a repeated coach answer is synthesised once and replayed for free.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ttsCacheKey,
  TUTOR_TTS_MONTHLY_CHAR_CAP,
  type TutorVoice,
} from "./models";

const VOICE_BUCKET = "tutor-voice";
const SIGNED_URL_TTL = 60 * 60; // 1h — long enough to play, short enough to expire

/** Reserve `chars` of paid synthesis against this account's monthly cap. Atomic
 * (the RPC only commits the chars if they fit), so concurrent requests can't
 * overspend. Returns false when the cap would be exceeded → caller falls back to
 * the free browser voice. */
async function reserveBudget(admin: SupabaseClient, userId: string, chars: number): Promise<boolean> {
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  try {
    const { data, error } = await admin.rpc("tutor_tts_reserve", {
      p_user: userId,
      p_period: period,
      p_provider: "elevenlabs",
      p_chars: chars,
      p_cap: TUTOR_TTS_MONTHLY_CHAR_CAP,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Signed URL for already-cached audio, or null if we haven't synthesised it. */
async function cachedUrl(admin: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await admin.storage.from(VOICE_BUCKET).createSignedUrl(`${key}.mp3`, SIGNED_URL_TTL);
  return data?.signedUrl ?? null;
}

/** Synthesise via ElevenLabs REST (same model/format as the worker) → MP3 bytes. */
async function synthElevenLabs(text: string, ref: string): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set.");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ref}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_turbo_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export type VoiceResult =
  | { provider: "browser"; ref: string; voiceId: string; capped?: boolean } // client speaks
  | { provider: "elevenlabs"; voiceId: string; audioUrl: string }; // play this URL

/** Produce playable audio for a coach reply in the resolved voice. Premium is
 * cache-first (free replay), then cap-reserved, then synthesised + cached. ANY
 * failure degrades to the free browser voice so the tutor always has a voice. */
export async function synthesizeVoice(
  admin: SupabaseClient,
  userId: string,
  voice: TutorVoice,
  text: string,
): Promise<VoiceResult> {
  const browser = (capped?: boolean): VoiceResult => ({ provider: "browser", ref: "warm", voiceId: "browser-warm", capped });

  // Free voices (and anything non-premium) are spoken client-side.
  if (voice.provider !== "elevenlabs") {
    return { provider: "browser", ref: voice.ref, voiceId: voice.voiceId };
  }

  try {
    const key = ttsCacheKey(voice.provider, voice.ref, text);

    // 1) Cache hit → $0 replay, no cap spend.
    const hit = await cachedUrl(admin, key);
    if (hit) return { provider: "elevenlabs", voiceId: voice.voiceId, audioUrl: hit };

    // 2) Reserve the character budget; over cap → free voice.
    if (!(await reserveBudget(admin, userId, text.length))) return browser(true);

    // 3) Synthesise, cache, hand back a signed URL.
    const mp3 = await synthElevenLabs(text, voice.ref);
    const up = await admin.storage.from(VOICE_BUCKET).upload(`${key}.mp3`, mp3, {
      contentType: "audio/mpeg",
      upsert: true,
    });
    if (up.error) return browser();
    const url = await cachedUrl(admin, key);
    return url ? { provider: "elevenlabs", voiceId: voice.voiceId, audioUrl: url } : browser();
  } catch {
    return browser();
  }
}
