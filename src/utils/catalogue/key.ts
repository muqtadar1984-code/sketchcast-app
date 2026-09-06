// The topic catalogue's ONE normalisation function (topic-catalogue plan §5:
// "canonical_key (unique; one normalisation function, shared with the
// worker)"). The worker carries a byte-for-byte mirror in Python; both are
// pinned to the same truth table, src/utils/__tests__/fixtures/
// catalogue_key_cases.json, whose sha256 both test suites assert. Change the
// rule here and the fixture (and its hash, and the worker) move with it, or
// alias matching silently disagrees across the two repos.
//
// Steps, in order:
//   1. Unicode NFKD, strip combining marks, lower-case      ("Énergie" → "energie")
//   2. "&" → " and "                                         ("Acids & Salts")
//   3. every run of chars outside [a-z0-9] → ONE "_"          ("Light — Ref." → "light_ref")
//   4. trim leading/trailing "_"
//   5. drop ONE leading article token: the / a / an          ("The Cell" → "cell")
//   6. per "_"-token, fold a simple plural: drop a final "s" when the token is
//      purely alphabetic, at least 4 letters, and the letter before that "s"
//      is not "s" and not one of a/i/o/u — i.e. a consonant or an "e".
//        cells → cell, atoms → atom, laws → law, bases → base, forces → force
//        glass (ss), gas (a), bus (u), this (i), its (3 letters) stay
//        7bs (has a digit — curriculum codes are never folded) stays
//        a lone "s" ("newton_s_law") stays
//   7. rejoin with "_"
//
// Anything with no Latin letters or digits at all (an Arabic-only title)
// becomes "" — callers refuse to create a topic with an empty key.

const ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);

// Built from a string so tsc (target ES2017) does not reject the Unicode
// property escape; Node's RegExp has supported \p{M} with the u flag since 10.
const COMBINING_MARKS = new RegExp("\\p{M}+", "gu");

/** Fold one "_"-token's simple plural (step 6). Exported for the tests. */
export function singularToken(token: string): string {
  if (token.length < 4) return token;
  if (!/^[a-z]+$/.test(token)) return token;
  if (!token.endsWith("s")) return token;
  const before = token[token.length - 2];
  if (before === "s" || before === "a" || before === "i" || before === "o" || before === "u") return token;
  return token.slice(0, -1);
}

export function canonicalKey(input: string): string {
  let s = (input ?? "").normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9]+/g, "_");
  s = s.replace(/^_+/, "").replace(/_+$/, "");
  if (!s) return "";
  let tokens = s.split("_");
  if (ARTICLES.has(tokens[0])) tokens = tokens.slice(1);
  return tokens.map(singularToken).join("_");
}
