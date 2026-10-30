// SK voice (founder 2026-10-30) — the monthly character cap on SK's paid
// Google voice, per user, through the AI Tutor's existing atomic meter
// (`tutor_tts_reserve`, 0027: commits the characters only if the new total
// stays within the cap; service role only since 0044). Provider key
// "sk:google" keeps SK's count apart from the tutor's ElevenLabs one.
//
// Fails CLOSED: a reserve that errors is "error", and the route answers with
// the browser voice — never unmetered speech.

export const SK_TTS_METER_PROVIDER = "sk:google";
export const DEFAULT_SK_TTS_MONTHLY_CHAR_CAP = 200_000;

/** SK_TTS_MONTHLY_CHAR_CAP (a positive integer), else 200,000 characters. */
export function skTtsMonthlyCap(): number {
  const n = Number((process.env.SK_TTS_MONTHLY_CHAR_CAP ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SK_TTS_MONTHLY_CHAR_CAP;
}

export type ReserveDb = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export type ReserveOutcome = "ok" | "cap" | "error";

/** Reserve `chars` for this user this month (UTC "YYYY-MM"). */
export async function reserveSkTts(db: ReserveDb, userId: string, chars: number, now: Date = new Date()): Promise<ReserveOutcome> {
  try {
    const { data, error } = await db.rpc("tutor_tts_reserve", {
      p_user: userId,
      p_period: now.toISOString().slice(0, 7),
      p_provider: SK_TTS_METER_PROVIDER,
      p_chars: chars,
      p_cap: skTtsMonthlyCap(),
    });
    if (error) return "error";
    return data === true ? "ok" : data === false ? "cap" : "error";
  } catch {
    return "error";
  }
}
