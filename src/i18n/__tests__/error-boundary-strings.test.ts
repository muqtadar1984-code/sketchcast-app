import { describe, expect, it } from "vitest";
import { LOCALES, type Locale } from "../locales";
import { ERROR_COPY } from "@/app/error";
import en from "../messages/en.json";
import ms from "../messages/ms.json";
import ar from "../messages/ar.json";
import fr from "../messages/fr.json";
import es from "../messages/es.json";
import pt from "../messages/pt.json";
import te from "../messages/te.json";
import mr from "../messages/mr.json";
import hi from "../messages/hi.json";
import msArab from "../messages/ms-arab.json";

// src/app/error.tsx carries its two strings INLINE rather than reading the
// dictionary, and that is deliberate: i18n/dictionaries.ts is `server-only`, and
// making the error boundary dynamically import a locale file would put a network
// fetch in the recovery path for an error a failed chunk load may well have
// caused. An error boundary that can itself fail is not a boundary.
//
// The cost of that choice is duplication, and duplication drifts. This test is
// the thing that stops it: change a word in the catalogue without changing the
// boundary (or vice versa) and it fails here, loudly, in CI.

const FILES: Record<Locale, { common: { somethingWentWrong: string; tryAgain: string } }> = {
  en,
  ms,
  ar,
  fr,
  es,
  pt,
  te,
  mr,
  hi,
  "ms-arab": msArab,
};

describe("error boundary copy", () => {
  it("covers every registered locale — a gap renders English to someone who can't read it", () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual(LOCALES.map((l) => l.value).sort());
  });

  describe.each(LOCALES.map((l) => l.value))("%s", (locale) => {
    it("matches common.somethingWentWrong in the catalogue", () => {
      expect(ERROR_COPY[locale].message).toBe(FILES[locale].common.somethingWentWrong);
    });

    it("matches common.tryAgain in the catalogue", () => {
      expect(ERROR_COPY[locale].retry).toBe(FILES[locale].common.tryAgain);
    });
  });

  it("has no empty values — a blank error screen is worse than an English one", () => {
    for (const [locale, copy] of Object.entries(ERROR_COPY)) {
      expect(copy.message.trim(), `${locale}.message`).not.toBe("");
      expect(copy.retry.trim(), `${locale}.retry`).not.toBe("");
    }
  });
});
