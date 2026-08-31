/**
 * localeForCountry (src/i18n/country-locale.ts) — the country → interface
 * language fallback, and the reason a teacher in Egypt on an English-system
 * phone gets an Arabic portal.
 *
 * What must hold:
 *  • every mapped country is a real ISO code and every target is one of our ten
 *    locales — a typo either side is a silent dead entry;
 *  • no country appears twice, because two languages for one country is an
 *    unresolvable contradiction the Map would settle by accident;
 *  • the deliberate ABSENCES stay absent. India, Singapore, the Philippines,
 *    Nigeria and Belgium are the whole argument of that file: they are the
 *    countries where a confident-looking guess would be wrong, and a later
 *    "let's complete the map" edit is exactly what these assertions exist to
 *    stop;
 *  • Jawi is unreachable — it is a script preference, never a location.
 * Run: npx vitest run src/i18n/__tests__/country-locale.test.ts
 */
import { describe, expect, it } from "vitest";
import { localeForCountry } from "@/i18n/country-locale";
import { LOCALES } from "@/i18n/locales";
import { COUNTRY_CODES, isCountryCode } from "@/utils/countries";

const CODES = LOCALES.map((l) => l.value) as string[];
const mapped = COUNTRY_CODES.filter((c) => localeForCountry(c) !== null);

describe("localeForCountry", () => {
  it("answers with one of the ten supported locales, or null", () => {
    for (const c of COUNTRY_CODES) {
      const l = localeForCountry(c);
      if (l !== null) expect(CODES).toContain(l);
    }
  });

  it("maps only assigned ISO codes", () => {
    // A typo like "UK" (not a country; GB is) would sit in the file forever
    // matching nothing, and the language it was meant to trigger never fires.
    for (const c of mapped) expect(isCountryCode(c)).toBe(true);
  });

  it("covers the languages it claims to, and only those", () => {
    expect(new Set(mapped.map((c) => localeForCountry(c)))).toEqual(
      new Set(["ar", "fr", "es", "pt", "ms"]),
    );
  });

  it("routes the founder's own example", () => {
    expect(localeForCountry("EG")).toBe("ar");
  });

  it("routes the obvious cases in each language", () => {
    expect(localeForCountry("SA")).toBe("ar");
    expect(localeForCountry("MA")).toBe("ar");
    expect(localeForCountry("FR")).toBe("fr");
    expect(localeForCountry("SN")).toBe("fr");
    expect(localeForCountry("MX")).toBe("es");
    expect(localeForCountry("BR")).toBe("pt");
    expect(localeForCountry("MY")).toBe("ms");
    expect(localeForCountry("BN")).toBe("ms");
  });

  it("leaves the English-medium and multilingual countries alone", () => {
    // India is the important one: hi, te and mr are three of our ten locales,
    // so "complete the map" is a tempting edit — but the country code cannot
    // tell a Telugu-medium teacher from a Marathi-medium one, and instruction
    // is very widely English anyway. Their browser already wins if it asks.
    for (const c of ["IN", "SG", "PH", "NG", "KE", "PK", "ZA", "BE", "CH", "LU", "GB", "US", "AU"]) {
      expect(localeForCountry(c)).toBeNull();
    }
  });

  it("never returns Jawi for a country", () => {
    // ms-arab is a SCRIPT choice within Malay. Brunei and Malaysia both get
    // Rumi; a Jawi reader picks Jawi.
    expect(mapped.map((c) => localeForCountry(c))).not.toContain("ms-arab");
  });

  it("treats null, undefined and junk as 'no opinion'", () => {
    expect(localeForCountry(null)).toBeNull();
    expect(localeForCountry(undefined)).toBeNull();
    expect(localeForCountry("")).toBeNull();
    expect(localeForCountry("eg")).toBeNull(); // lower case is never normalised here
  });
});
