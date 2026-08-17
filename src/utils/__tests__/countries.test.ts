/**
 * The ISO 3166-1 alpha-2 registry (src/utils/countries.ts). What must hold:
 *  • shape — every entry is exactly two uppercase ASCII letters, because the
 *    0085 CHECK constraint pins that same regex: one malformed entry here is a
 *    signup that can NEVER save its country.
 *  • no duplicates — a duplicated <option> renders twice and breaks keyed lists.
 *  • the launch geographies are present — the pricing/market work names these
 *    (MY IN IQ EG TR IR ET DZ PK SA CA CN); losing one silently would strand
 *    those signups on the required select.
 *  • Intl coverage — every code resolves to a display name in English, so the
 *    select never shows a bare code to an English reader (other locales fall
 *    back to the code by design when CLDR data is thin).
 * Run: npx vitest run src/utils/__tests__/countries.test.ts
 */
import { describe, expect, it } from "vitest";
import { COUNTRY_CODES, isCountryCode } from "@/utils/countries";

describe("COUNTRY_CODES", () => {
  it("is the full assigned alpha-2 registry (249 codes)", () => {
    expect(COUNTRY_CODES.length).toBe(249);
  });

  it("has no duplicates", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it("holds only two-letter uppercase ASCII codes — the exact 0085 CHECK shape", () => {
    expect(COUNTRY_CODES.filter((c) => !/^[A-Z]{2}$/.test(c))).toEqual([]);
  });

  it("includes every launch geography", () => {
    for (const code of ["MY", "IN", "IQ", "EG", "TR", "IR", "ET", "DZ", "PK", "SA", "CA", "CN"]) {
      expect(COUNTRY_CODES).toContain(code);
    }
  });

  it("every code has an English display name via Intl.DisplayNames", () => {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    // .of() echoes the input when it has no name — that echo is the failure.
    expect(COUNTRY_CODES.filter((c) => (names.of(c) ?? c) === c)).toEqual([]);
  });
});

describe("isCountryCode", () => {
  it("accepts assigned codes only", () => {
    expect(isCountryCode("MY")).toBe(true);
    expect(isCountryCode("CA")).toBe(true);
  });

  it("rejects unassigned, lowercase, padded, and non-string input", () => {
    expect(isCountryCode("XX")).toBe(false); // shape-valid but not assigned
    expect(isCountryCode("my")).toBe(false); // normalisation is the caller's job
    expect(isCountryCode(" MY")).toBe(false);
    expect(isCountryCode("MYS")).toBe(false); // alpha-3 is a different registry
    expect(isCountryCode("")).toBe(false);
    expect(isCountryCode(null)).toBe(false);
    expect(isCountryCode(undefined)).toBe(false);
  });
});
