// The UI locale registry — the languages the PORTAL CHROME is shown in.
//
// These are deliberately the SAME ten codes, in the SAME order, as the lesson
// languages in src/utils/narration.ts (LANGUAGES, which itself mirrors the
// worker's shared/languages.py). Content language and interface language are
// ONE set on purpose: a parent who receives Jawi worksheets should be able to
// read the app in Jawi too, one list means one thing to translate and one CHECK
// constraint (migration 0069), and there is no "supported for lessons but not
// for buttons" gap to explain to a school. Adding a language means: add it
// there, add the code here, add src/i18n/messages/<code>.json, extend 0069.
//
// Labels are each language's OWN name — someone hunting for their language in
// the picker never has to read English to find it. Same strings as narration.ts
// so the two pickers can't drift apart on screen.
//
// PURE module — no next/* imports, no dictionaries — so the API route, the
// server-side resolver AND client components (the switcher) can all import it.
// The dictionaries themselves are server-only (see ./dictionaries.ts).

export type LocaleOpt = { value: Locale; label: string };

export const LOCALES = [
  { value: "en", label: "English" },
  { value: "ms", label: "Bahasa Melayu" },
  { value: "ar", label: "العربية (Arabic)" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "te", label: "తెలుగు (Telugu)" },
  { value: "mr", label: "मराठी (Marathi)" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  // Jawi — Malay in the Arabic script, and right-to-left like Arabic.
  { value: "ms-arab", label: "بهاس ملايو — Jawi (Malay)" },
] as const satisfies readonly { value: string; label: string }[];

/** The ten supported UI locale codes. */
export type Locale = (typeof LOCALES)[number]["value"];

/** English — what an un-negotiable request falls back to. */
export const DEFAULT_LOCALE: Locale = "en";

/** The chosen-language cookie. Readable by the client (the switcher shows the
 * current pick without a round trip), so it is NOT httpOnly — it carries a
 * preference, never a credential. Written by /api/locale. */
export const LOCALE_COOKIE = "sc_locale";

const CODES: ReadonlySet<string> = new Set(LOCALES.map((l) => l.value));

export function isLocale(s: string | null | undefined): s is Locale {
  return typeof s === "string" && CODES.has(s);
}

/** Right-to-left scripts: Arabic, and Malay written in the Arabic script. */
export function isRtl(locale: Locale): boolean {
  return locale === "ar" || locale === "ms-arab";
}

/** The `dir` attribute for a locale — RTL flows through Tailwind 4's logical
 * properties (ps-/pe-/ms-/me-/text-start/border-s/…), so setting this on <html>
 * mirrors the whole document. */
export function dirFor(locale: Locale): "rtl" | "ltr" {
  return isRtl(locale) ? "rtl" : "ltr";
}

// The BCP-47 tag for <html lang>. Nine of the codes already ARE valid tags;
// "ms-arab" is our internal spelling of ms-Arab — BCP-47 title-cases the script
// subtag, and screen readers / spell checkers don't recognise the lower-case
// form. Kept here rather than in the registry so the stored code (which the
// 0069 CHECK and narration.ts both pin) stays exactly one lower-case string.
const HTML_LANG: Partial<Record<Locale, string>> = { "ms-arab": "ms-Arab" };

export function htmlLang(locale: Locale): string {
  return HTML_LANG[locale] ?? locale;
}

export const localeLabel = (code: string | null | undefined): string | null =>
  LOCALES.find((l) => l.value === code)?.label ?? null;
