// Readable temporary passwords for hierarchical resets AND student/child
// provisioning: three short words plus two digits ("Fern-mint-star38") — easy
// to read over a shoulder or a phone call, hard to mistype. The alphabet
// avoids every ambiguous glyph (0/O, 1/l/I, lowercase o): no word contains
// `l` or `o`, and the digits are 2–9.
//
// POLICY COMPLIANCE: the Supabase project's password policy can require one
// character from EACH of lowercase / uppercase / digits / symbols — GoTrue
// enforces it on admin password updates (Khaja's child reset failed with the
// raw policy error, 2026-07-19). This format satisfies all four classes by
// construction: the first word is capitalized (upper + lower), two digits,
// and `-` is in GoTrue's accepted symbol set. Do NOT swap the hyphen out.
//
// Entropy is ~23 bits — intentionally a HANDOFF credential, not a durable one:
// provisioning/reset set profiles.must_reset_password, so the account is
// forced to choose a real password at the next sign-in, and Supabase
// rate-limits sign-in attempts.

const WORDS = [
  "amber", "aqua", "bear", "bird", "cake", "camp", "cave", "crab",
  "dart", "dawn", "drum", "dune", "dusk", "fern", "fig", "fire",
  "fish", "gem", "grape", "green", "hut", "jade", "jam", "jet",
  "kite", "maze", "mint", "nest", "pear", "pine", "rain", "reef",
  "ridge", "ruby", "sand", "seed", "star", "sun", "swan", "tide",
  "tree", "tusk", "wave", "west", "wind", "wren", "yak", "zest",
];

const DIGITS = "23456789";

function pick(items: readonly string[] | string): string {
  // Rejection sampling → uniform choice (no modulo bias).
  const n = items.length;
  const limit = Math.floor(256 / n) * n;
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return items[buf[0] % n];
  }
}

export function generateTempPassword(): string {
  const first = pick(WORDS);
  const words = [first[0].toUpperCase() + first.slice(1), pick(WORDS), pick(WORDS)].join("-");
  return `${words}${pick(DIGITS)}${pick(DIGITS)}`;
}
