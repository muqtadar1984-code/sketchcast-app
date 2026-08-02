import "server-only";
import { DEFAULT_LOCALE, type Locale } from "./locales";
import en from "./messages/en.json";

// The dictionary loader — the Next 16 localization pattern (a locale → dynamic
// import map, resolved on the SERVER; see
// node_modules/next/dist/docs/01-app/02-guides/internationalization.md).
//
// `import "server-only"` is the whole point of this file living apart from
// locales.ts: layouts and pages are Server Components, so ten translation files
// never reach the browser bundle — client components are handed the handful of
// strings they need as props (or through the dashboard's provider), not the
// dictionary. Importing this from a "use client" module is a build error, on
// purpose.
//
// PLACEHOLDERS: message values interpolate with single braces — "Part {n} of
// {total}". The braces are part of the string in EVERY language; a translator
// moves them, never renames them.
//
// FALLBACK: English is the schema AND the safety net. getDictionary layers the
// requested locale over the English base, so a locale file that is missing keys
// (a stub awaiting translation, or a key added by a later phase) renders the
// English words rather than a blank button. That is what makes it safe to ship
// this spine before the nine translations land.

/** The complete message shape. English IS the schema — every other locale is a
 * subset of it, checked at compile time by the map below. */
export type Dictionary = typeof en;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** What a non-English message file may contain: any subset of the English shape. */
export type Messages = DeepPartial<Dictionary>;

// One entry per registry locale — `Record<Locale, …>` is the compile-time proof
// that the ten codes in locales.ts and the ten files in ./messages never drift
// apart (a missing entry, or a stray one, fails the type check). English is
// listed like the rest even though it is also imported statically above: the
// static import is the type source and the fallback base, the dynamic import
// keeps the map honest and resolves to the very same module.
const dictionaries: Record<Locale, () => Promise<Messages>> = {
  en: () => import("./messages/en.json").then((m) => m.default),
  ms: () => import("./messages/ms.json").then((m) => m.default),
  ar: () => import("./messages/ar.json").then((m) => m.default),
  fr: () => import("./messages/fr.json").then((m) => m.default),
  es: () => import("./messages/es.json").then((m) => m.default),
  pt: () => import("./messages/pt.json").then((m) => m.default),
  te: () => import("./messages/te.json").then((m) => m.default),
  mr: () => import("./messages/mr.json").then((m) => m.default),
  hi: () => import("./messages/hi.json").then((m) => m.default),
  "ms-arab": () => import("./messages/ms-arab.json").then((m) => m.default),
};

/** The docs' type guard. Provably equivalent to isLocale() in locales.ts (the
 * Record above pins the map's keys to exactly the registry) — this one exists
 * so a server module that already has the dictionaries doesn't need both, and
 * isLocale exists because THIS module can't be imported from a client one. */
export const hasLocale = (locale: string): locale is Locale => locale in dictionaries;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Layer a (possibly partial) translation over the English base, key by key. An
// empty string counts as MISSING, not as a deliberately blank label — a
// translator leaving a value empty must not blank the UI.
function overlay(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null || value === undefined || value === "") continue;
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? overlay(current, value) : value;
  }
  return out;
}

/** The messages for a locale, with English filling any gap. */
export async function getDictionary(locale: Locale): Promise<Dictionary> {
  const base = (await dictionaries[DEFAULT_LOCALE]()) as Dictionary;
  if (locale === DEFAULT_LOCALE) return base;
  const translated = await dictionaries[locale]();
  return overlay(
    base as unknown as Record<string, unknown>,
    translated as Record<string, unknown>,
  ) as unknown as Dictionary;
}
