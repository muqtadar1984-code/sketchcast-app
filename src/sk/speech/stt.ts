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

/** Presigned URL lifetime. 300 s is the documented MAXIMUM for
 * X-Amz-Expires on the streaming WebSocket ("Setting up a streaming
 * transcription", 2026-10-30). The client opens the socket at once, so the
 * URL only needs to be valid for the upgrade request. */
export const STT_URL_EXPIRES_S = 300;

/** In-memory budget: presigned URLs per user per rolling hour, PER INSTANCE. */
export const STT_URLS_PER_HOUR = 30;
