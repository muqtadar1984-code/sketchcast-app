// SK voice (founder 2026-10-30) — the Google Cloud TTS voice map: the same
// premium TEACHER voices the lesson videos use (worker shared/tts/registry.py,
// `g-<lang>-f` / `g-<lang>-m`), one female + one male per locale. Pure: no
// I/O, no node imports, safe for client code and tests.
//
// The look picks the gender (avatar.ts voiceGenderForChoice: A female, B male,
// default B); the answer language picks the locale. The voice NAME sent to
// Google only ever comes from this table (`googleVoiceName`), never from the
// client verbatim — the same rule as pollyVoiceName.

import type { VoiceId } from "./provider";
import type { VoiceGender } from "./polly-marks";

type Pair = Readonly<Record<VoiceGender, string>>;

const chirp = (locale: string): Pair => ({ female: `${locale}-Chirp3-HD-Achernar`, male: `${locale}-Chirp3-HD-Achird` });

/** Locale → { female, male }. Chirp 3 HD everywhere the worker has it;
 * Malay is WaveNet (Chirp 3 HD has no ms-MY), as in the worker. */
export const GOOGLE_VOICES: Readonly<Record<string, Pair>> = {
  "en-US": chirp("en-US"),
  "ar-XA": chirp("ar-XA"),
  "hi-IN": chirp("hi-IN"),
  "ur-IN": chirp("ur-IN"),
  "mr-IN": chirp("mr-IN"),
  "te-IN": chirp("te-IN"),
  "fr-FR": chirp("fr-FR"),
  "es-ES": chirp("es-ES"),
  "pt-BR": chirp("pt-BR"),
  "ms-MY": { female: "ms-MY-Wavenet-A", male: "ms-MY-Wavenet-B" },
  // SK-only, not in the worker registry: SK answers in zh (language.ts), the
  // lesson videos do not.
  "cmn-CN": chirp("cmn-CN"),
};

export const GOOGLE_DEFAULT_LOCALE = "en-US";

/** Primary language subtag → locale. "ms-arab" (Jawi) and "ms-MY" both land
 * on ms-MY; zh / cmn on cmn-CN. */
const LANG_TO_LOCALE: Readonly<Record<string, string>> = {
  en: "en-US",
  ar: "ar-XA",
  hi: "hi-IN",
  ur: "ur-IN",
  mr: "mr-IN",
  te: "te-IN",
  fr: "fr-FR",
  es: "es-ES",
  pt: "pt-BR",
  ms: "ms-MY",
  zh: "cmn-CN",
  cmn: "cmn-CN",
};

/** A BCP-47 tag ("ar-SA", "zh-CN", "ms-arab", "en") → a locale in the map;
 * en-US for anything unknown, missing or malformed. */
export function googleLocaleFor(lang: unknown): string {
  if (typeof lang !== "string") return GOOGLE_DEFAULT_LOCALE;
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return LANG_TO_LOCALE[primary] ?? GOOGLE_DEFAULT_LOCALE;
}

/** "google:en-US-Chirp3-HD-Achird" for a language and gender. */
export function googleVoiceFor(lang: unknown, gender: VoiceGender): VoiceId {
  return `google:${GOOGLE_VOICES[googleLocaleFor(lang)]![gender]}`;
}

/** The look (A | B, anything else = the default B) + the language → VoiceId. */
export function googleVoiceForLook(look: unknown, lang: unknown): VoiceId {
  return googleVoiceFor(lang, look === "A" ? "female" : "male");
}

const ALLOWED: ReadonlySet<string> = new Set(Object.values(GOOGLE_VOICES).flatMap((p) => [p.female, p.male]));

/** "google:ar-XA-Chirp3-HD-Achird" → "ar-XA-Chirp3-HD-Achird". Any other
 * scheme or a name not in the map falls back to the default male voice: the
 * name is sent to Google verbatim, so only our own ever go. */
export function googleVoiceName(voice: VoiceId): string {
  const name = typeof voice === "string" && voice.startsWith("google:") ? voice.slice(7) : "";
  return ALLOWED.has(name) ? name : GOOGLE_VOICES[GOOGLE_DEFAULT_LOCALE]!.male;
}

/** The request's languageCode is the voice name's first two parts
 * ("cmn-CN-Chirp3-HD-Achird" → "cmn-CN"), as the worker's language_code. */
export function googleLanguageCode(name: string): string {
  const parts = name.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : GOOGLE_DEFAULT_LOCALE;
}
