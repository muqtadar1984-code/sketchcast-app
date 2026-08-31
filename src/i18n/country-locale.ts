// Which of our ten interface languages a country implies — the fallback used
// when the browser has told us nothing we can act on.
//
// WHAT THIS IS FOR. A teacher in Egypt whose phone was sold with an English
// system locale sends `Accept-Language: en-US`, negotiates to English, and gets
// an English portal — even though Arabic is the language they teach in and the
// language we already generate their lessons in. Country is the only other
// evidence we have, so it fills that gap. See resolveLocale for exactly where
// it sits in the order: it can only ever displace ENGLISH, never a language the
// browser positively asked for.
//
// WHAT IS IN THE MAP, AND WHY IT IS SHORT. A country implies a language only
// where that language is the medium of instruction AND English is not. So:
//
//   • India is NOT here, despite hi/te/mr being three of our ten. School
//     instruction is very widely English-medium, the three languages belong to
//     different states, and a country code cannot tell them apart — guessing
//     Hindi for a Telugu-medium teacher is worse than leaving English. Their
//     browser says `hi`/`te`/`mr` when they want it, and that already wins.
//   • Singapore, the Philippines, Nigeria, Kenya, Pakistan and South Africa are
//     absent for the same reason: English IS the school language there.
//   • Belgium, Switzerland and Luxembourg are absent because the country does
//     not pick one of our languages for them — mapping all of Belgium to French
//     would be wrong for most of it.
//   • ms-arab (Jawi) is deliberately unreachable from a country. It is a SCRIPT
//     preference within Malay, never a geographic default; Brunei and Malaysia
//     both get Rumi, and a Jawi reader chooses it.
//
// PURE module — a frozen lookup and one function. No next/*, no DB.

import type { Locale } from "./locales";

// Grouped by the language rather than the country so the reasoning above stays
// readable and a country is provably in exactly one group.
const BY_LOCALE: Partial<Record<Locale, readonly string[]>> = {
  // Arabic is the language of schooling across the Arab League states. Somalia
  // and the Comoros are deliberately omitted: Arabic is co-official but the
  // classroom language is Somali and French.
  ar: ["AE", "BH", "DZ", "EG", "EH", "IQ", "JO", "KW", "LB", "LY", "MA", "MR",
       "OM", "PS", "QA", "SA", "SD", "SY", "TN", "YE"],
  // France, Monaco, the overseas départements, francophone Africa and Haiti —
  // everywhere French is the classroom language. Rwanda is omitted (it moved
  // to English-medium); Mauritius, the Seychelles and Vanuatu are omitted
  // because they teach in English as well.
  fr: ["BF", "BI", "BJ", "BL", "CD", "CF", "CG", "CI", "CM", "DJ", "FR", "GA",
       "GF", "GN", "GP", "HT", "MC", "MF", "MG", "ML", "MQ", "NC", "NE", "PF",
       "PM", "RE", "SN", "TD", "TG", "WF", "YT"],
  es: ["AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "ES", "GQ", "GT", "HN",
       "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"],
  pt: ["AO", "BR", "CV", "GW", "MZ", "PT", "ST", "TL"],
  // Malaysia and Brunei teach in Malay. INDONESIA IS THE ONE DELIBERATE
  // NEAR-MATCH in this file: Indonesian is its own standardised language, not
  // Malay, but the two are broadly mutually intelligible in writing and a
  // Malay portal is far closer to readable for an Indonesian teacher than an
  // English one. It is on its own line so it can be removed on its own.
  ms: ["BN", "MY", "ID"],
};

const MAP: ReadonlyMap<string, Locale> = new Map(
  Object.entries(BY_LOCALE).flatMap(([locale, codes]) =>
    (codes ?? []).map((c) => [c, locale as Locale] as const),
  ),
);

/**
 * The interface language a country implies, or null when it implies nothing.
 *
 * Null is the common, correct answer for most of the world and callers must
 * fall back to English on it — this map is an aid for the places where we can
 * do better than English, not a claim to cover the planet.
 *
 * The code must already be an uppercase alpha-2 (countryFromHeaders and
 * profiles.country's CHECK both guarantee that); anything else returns null
 * rather than being silently normalised.
 */
export function localeForCountry(country: string | null | undefined): Locale | null {
  if (!country) return null;
  return MAP.get(country) ?? null;
}
