import { describe, expect, it } from "vitest";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "../locales";
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

// The ten message files carry ~1,240 strings each. Nothing checked them as a
// SET until now: tsc proves every lookup in the app resolves against English
// (Dictionary = typeof en), and getDictionary's overlay means a missing key
// falls back to English rather than blanking — so both of the mechanisms we
// rely on are silent about a translation that is absent, empty, or has had a
// placeholder mangled. Those only surface to a reader of that language, which
// for most of these ten is nobody on the team.
//
// This is the check that isn't silent.

const FILES: Record<Locale, unknown> = {
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

/** "nav.tabs.library" → the string, for every leaf in the tree. */
function flatten(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** The placeholder NAMES a message uses, order-insensitive: "{n} of {total}" → "{n},{total}". */
const placeholders = (s: string): string => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");

/* Everything above is a SCHEMA check — keys present, no extras, placeholders
 * intact, nothing empty. A file can pass all of them while being, word for
 * word, English, because none of them ever compares a VALUE to its English
 * source. That is not hypothetical: a whole section shipped into the marketing
 * site's mr.json as raw English and both validators stayed green.
 *
 * "No value may equal English" is the obvious rule and the wrong one — it would
 * be red on day one and switched off within a week. Plenty of identical values
 * are correct: "SketchCast AI", the SKU names (Teacher Pro, Teacher Pro+, Home
 * Basic, Homeschool, Free), "01"/"02", "$0", values that are nothing but
 * placeholders like "{points}/{max} ({pct}%)", genuine cognates such as French
 * "Contact"/"FAQ"/"Maths", and the invented names in mock data.
 *
 * So compare only the values where sameness is actually suspicious — PROSE: a
 * space, and still a letter once inline tags and placeholders are stripped.
 * That removes most legitimate cases by construction ("FAQ" and "$0" have no
 * space; "{points}/{max} ({pct}%)" has no letters left). It deliberately does
 * NOT remove brand and SKU phrases — those are the irreducible floor that the
 * threshold, rather than a hand-maintained allowlist, has to pay for. */
const PROSE_LETTER = /\p{L}/u;
const isProse = (s: string): boolean =>
  / /.test(s) && PROSE_LETTER.test(s.replace(/<[^>]*>/g, "").replace(/\{[^{}]*\}/g, ""));

/* THE THRESHOLD, read off the corpus rather than chosen by taste.
 *
 * Across the 1,018 prose keys in en.json, today's locales measure: ar 0.00%,
 * hi/mr/ms-arab/te 0.10%, es/pt 0.69%, ms 0.79%, fr 0.98% — the highest being
 * 10 values, essentially all brand and SKU names. The marketing corpus sits in
 * the same band (1.22% for every healthy locale) and its one untranslated file
 * measured 26.5%.
 *
 * 6% is near the geometric mean of those two — the point furthest from both on
 * a ratio scale. A healthy locale can quintuple its cognates before this turns
 * red, while a failure four times smaller than the one that actually shipped
 * still trips it (61 untranslated values here). Raise it only against fresh
 * measurements, never to clear a red build. */
const MAX_IDENTICAL_PROSE = 0.06;

const base = new Map(flatten(en));
const translations = LOCALES.map((l) => l.value).filter((v) => v !== DEFAULT_LOCALE);

describe("message catalogue", () => {
  it("has a file for every registered locale and no others", () => {
    expect(Object.keys(FILES).sort()).toEqual(LOCALES.map((l) => l.value).sort());
  });

  it("English carries a non-trivial catalogue", () => {
    // Guards against an empty or truncated en.json making every other
    // assertion below vacuously true.
    expect(base.size).toBeGreaterThan(1000);
  });

  describe.each(translations)("%s", (locale) => {
    const entries = new Map(flatten(FILES[locale]));

    it("translates every English key — a gap here renders English to someone who can't read it", () => {
      expect([...base.keys()].filter((k) => !entries.has(k))).toEqual([]);
    });

    it("carries no key English does not have — a stray key is a string that will never render", () => {
      expect([...entries.keys()].filter((k) => !base.has(k))).toEqual([]);
    });

    it("keeps every placeholder intact", () => {
      // The one failure that reaches a user as a visibly broken sentence:
      // a renamed or dropped {n} leaves a literal "{n}" on screen, or blanks
      // the number entirely. fmt() leaves unknown placeholders standing.
      const broken = [...base.entries()]
        .filter(([k, v]) => entries.has(k) && placeholders(entries.get(k)!) !== placeholders(v))
        .map(([k, v]) => `${k}: "${entries.get(k)}" has ${placeholders(entries.get(k)!) || "(none)"}, English has ${placeholders(v)}`);
      expect(broken).toEqual([]);
    });

    it("has no empty values", () => {
      // overlay() treats "" as missing, so an empty value silently shows
      // English — which looks like a translation gap nobody reported.
      expect([...entries.entries()].filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
    });

    it("is actually translated, not English under a different filename", () => {
      // The check none of the four above can make. See MAX_IDENTICAL_PROSE.
      const prose = [...base.entries()].filter(([, v]) => isProse(v));
      const untranslated = prose.filter(([k, v]) => entries.get(k) === v);
      const ratio = untranslated.length / prose.length;
      const examples = untranslated
        .slice(0, 6)
        .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
        .join("\n");
      expect(
        ratio,
        `${locale}.json is not translated — ${untranslated.length} of ${prose.length} prose values ` +
          `(${(ratio * 100).toFixed(1)}%) are the English string verbatim, over the ${(MAX_IDENTICAL_PROSE * 100).toFixed(0)}% limit. ` +
          `Every other assertion passes because the KEYS are all correct; only the values are English.\nTranslate at least these:\n${examples}\n` +
          `...and ${Math.max(0, untranslated.length - 6)} more. Brand and SKU names (SketchCast, Teacher Pro, Home Basic, Homeschool, Free) ` +
          `are expected to match English — that is what the ${(MAX_IDENTICAL_PROSE * 100).toFixed(0)}% allowance covers.`,
      ).toBeLessThanOrEqual(MAX_IDENTICAL_PROSE);
    });

    it("has no bidi control characters", () => {
      // U+200E/200F/061C survive copy-paste and diffing invisibly, and the
      // layout already sets direction from <html dir>. A message never needs one.
      expect([...entries.entries()].filter(([, v]) => /[‎‏؜]/.test(v)).map(([k]) => k)).toEqual([]);
    });
  });

  it("keeps Jawi as Malay in Arabic script, not Arabic", () => {
    // ms-arab is the locale most likely to come back wrong, because a
    // translator (human or model) who reads "Arabic script" as "Arabic" produces
    // fluent output that looks correct to anyone who doesn't read it. Two
    // independent signals: it must not duplicate ar.json, and it must actually
    // use the letters Jawi adds to the Arabic alphabet — pa ڤ, ga ݢ, nga ڠ,
    // va ۏ, nya ڽ, ca چ — which Arabic itself never uses.
    const arabic = new Map(flatten(ar));
    const jawi = new Map(flatten(msArab));
    const identical = [...jawi.entries()].filter(([k, v]) => arabic.get(k) === v);
    expect(identical.length / jawi.size).toBeLessThan(0.05);

    const jawiOnly = /[ڤݢڠۏڽچ]/;
    const withJawiLetters = [...jawi.values()].filter((v) => jawiOnly.test(v));
    expect(withJawiLetters.length / jawi.size).toBeGreaterThan(0.5);
  });
});
