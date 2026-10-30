// SK S6 slice B — which speech-to-text listens, and in which language.
// PURE and safe on both sides of the boundary: the server route reads
// skSttMode() (SK_STT), the client reads clientSttMode() (NEXT_PUBLIC_SK_STT).
//
// Both default to "browser" (Web Speech). Nothing chargeable switches on until
// BOTH flags say "transcribe" and the founder has added the IAM allow
// (docs/sk-transcribe.md). The client flag only makes the client ASK for a
// presigned URL; the server flag decides (404 → the browser, sticky) — the
// same split as SK_TTS / NEXT_PUBLIC_SK_TTS.

export type SttMode = "browser" | "transcribe";

function modeOf(v: string | undefined | null): SttMode {
  return (v ?? "").trim().toLowerCase() === "transcribe" ? "transcribe" : "browser";
}

/** Server: SK_STT. Unset (the default) or anything but "transcribe" = browser. */
export function skSttMode(env: string | undefined | null = process.env.SK_STT): SttMode {
  return modeOf(env);
}

/** Client: NEXT_PUBLIC_SK_STT (inlined at build time). Same rule. */
export function clientSttMode(env: string | undefined | null = process.env.NEXT_PUBLIC_SK_STT): SttMode {
  return modeOf(env);
}

// The four languages decision 6 approves for streaming. All four stream in
// us-east-1 (the default STT_REGION) — verified on the Transcribe "Supported
// languages" page 2026-10-30. Anything else → null → the route answers 400
// and the client stays on the browser for that language.
const TRANSCRIBE_LANG: Readonly<Record<string, string>> = {
  en: "en-US",
  ms: "ms-MY",
  "ms-arab": "ms-MY", // Jawi is written Malay; it is SPOKEN Malay
  ar: "ar-SA",
  zh: "zh-CN",
};

/** Transcribe language code for an app locale ("ms-arab") or a BCP-47 tag
 * ("ms-MY", "en-US", "zh-CN" — what pageSpeechLang() hands the dictation
 * call). Exact key first, then the primary subtag. Unknown → null. */
export function transcribeLanguageFor(lang: unknown): string | null {
  if (typeof lang !== "string") return null;
  const key = lang.trim().toLowerCase();
  if (!key || key.length > 35) return null;
  return TRANSCRIBE_LANG[key] ?? TRANSCRIBE_LANG[key.split("-")[0]!] ?? null;
}

// ── automatic language identification (2026-10-30) ─────────────────────────
//
// Transcribe streaming identifies the spoken language itself when the
// request carries `identify-language=true` + `language-options` (two or
// more codes, one dialect per language, "more than five is not recommended")
// + an optional `preferred-language` from those options — and it is
// available on the WebSocket API. Each Result then carries `LanguageCode`.
// Source (read 2026-10-30): "Language identification with streaming
// transcriptions", https://docs.aws.amazon.com/transcribe/latest/dg/lang-id-stream.html,
// and the StartStreamTranscription API reference (IdentifyLanguage,
// LanguageOptions, PreferredLanguage; Result.LanguageCode). It needs at
// least one second of speech; when no option matches, Transcribe picks the
// CLOSEST option (so only languages SK streams are offered).
//
// The options are exactly the four approved streaming languages; the
// preferred one is the language the conversation is in now (which speeds
// identification of a short utterance). SK_STT_IDENTIFY=off turns it off
// (fixed-language streaming, as before) without a client deploy.

/** The language options offered to Transcribe's identification, in order. */
export const TRANSCRIBE_ID_OPTIONS: readonly string[] = ["en-US", "ms-MY", "ar-SA", "zh-CN"];

/** Server: SK_STT_IDENTIFY. On unless it says "off" (or "0" / "false" / "no"). */
export function sttIdentifyEnabled(env: string | undefined | null = process.env.SK_STT_IDENTIFY): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** A Transcribe language code ("ms-MY") → the SK answer language it means
 *  ("ms"), for the four streaming languages only; anything else → null. */
export function answerLangOfTranscribe(code: unknown): "en" | "ms" | "ar" | "zh" | null {
  if (typeof code !== "string") return null;
  const k = code.trim().toLowerCase();
  if (k === "en-us") return "en";
  if (k === "ms-my") return "ms";
  if (k === "ar-sa") return "ar";
  if (k === "zh-cn") return "zh";
  return null;
}

/** Presigned URL lifetime. 300 s is the documented MAXIMUM for
 * X-Amz-Expires on the streaming WebSocket ("Setting up a streaming
 * transcription", 2026-10-30). The client opens the socket at once, so the
 * URL only needs to be valid for the upgrade request. */
export const STT_URL_EXPIRES_S = 300;

/** In-memory budget: presigned URLs per user per rolling hour, PER INSTANCE. */
export const STT_URLS_PER_HOUR = 30;
