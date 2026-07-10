// Readable temporary passwords for hierarchical resets: three short words plus
// two digits ("fern-mint-star38") — easy to read over a shoulder or a phone
// call, hard to mistype. The alphabet avoids every ambiguous glyph the student
// provisioning alphabet avoids (0/O, 1/l/I, and lowercase o): no word contains
// `l` or `o`, and the digits are 2–9.
//
// Entropy is ~23 bits — intentionally a HANDOFF credential, not a durable one:
// the reset route sets profiles.must_reset_password, so the account is forced
// to choose a real password at the next sign-in, and Supabase rate-limits
// sign-in attempts.

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
  const words = [pick(WORDS), pick(WORDS), pick(WORDS)].join("-");
  return `${words}${pick(DIGITS)}${pick(DIGITS)}`;
}
