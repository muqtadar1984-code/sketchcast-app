// SK codes and order numbers — the PURE part (no Node imports), safe to use
// from client components (the /activate form) as well as the server. The
// HMACs that the database stores live in ./access (node:crypto).
//
// 16 characters of Crockford base32 (no I, L, O, U — nothing a child misreads)
// plus one check character, printed in blocks under the scratch panel (a code
// CARD, prefix SKB…) or on the activation page of a KDP copy (an EDITION code,
// prefix SKE, the same in every copy of that edition).

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_BODY_LEN = 16;

/** Prefix of a per-copy code card (print batches carry their own, e.g. SKB2). */
export const CARD_PREFIX = "SKB";
/** Prefix of a per-edition code (KDP): SKE-XXXX-XXXX-XXXX-XXXXC. */
export const EDITION_PREFIX = "SKE";

/** Crockford mod-37-2 check character (the standard's own check scheme). */
export function checkChar(body: string): string {
  const CHECK = CROCKFORD + "*~$=U";
  // (n·32 + v) mod 37 step by step — no BigInt needed (the app targets < ES2020).
  let n = 0;
  for (const ch of body) n = (n * 32 + CROCKFORD.indexOf(ch)) % 37;
  return CHECK[n]!;
}

/** Fold what a person typed (dashes, spaces, case, I/L→1, O→0) into the canonical form. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z*~$=]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** Shape + check-character validity; says nothing about whether the code exists. */
export function isWellFormedCode(input: string, prefix?: string): boolean {
  const n = normalizeCode(input);
  const p = prefix ? normalizeCode(prefix) : "";
  if (!n.startsWith(p)) return false;
  const rest = n.slice(p.length);
  if (rest.length !== CODE_BODY_LEN + 1) return false;
  const body = rest.slice(0, CODE_BODY_LEN);
  if ([...body].some((c) => !CROCKFORD.includes(c))) return false;
  return checkChar(body) === rest[CODE_BODY_LEN];
}

/** Which kind of code a person typed, by prefix: a code card (SKB…) or an
 * edition code (SKE). The activation page uses this to ask for an order
 * number only when one is needed. Null = neither. */
export function codeKind(input: string): "card" | "edition" | null {
  const n = normalizeCode(input);
  if (n.startsWith(EDITION_PREFIX)) return "edition";
  if (n.startsWith(CARD_PREFIX)) return "card";
  return null;
}

/** A fresh code from 80 random bits. `random` is injectable for tests. */
export function generateCode(prefix: string, random: (n: number) => Uint8Array = defaultRandom): string {
  const bytes = random(10); // 80 bits → 16 base32 chars, 5 bits each
  let body = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      body += CROCKFORD[(acc >> bits) & 31];
      acc &= (1 << bits) - 1;
    }
  }
  return normalizeCode(prefix) + body + checkChar(body);
}

/** An edition code (SKE…) — the same check scheme as a card, a different prefix. */
export function generateEditionCode(random: (n: number) => Uint8Array = defaultRandom): string {
  return generateCode(EDITION_PREFIX, random);
}

function defaultRandom(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Printed form: SKB2-XXXX-XXXX-XXXX-XXXXC / SKE-XXXX-XXXX-XXXX-XXXXC. The
 * prefix is whatever precedes the 16-character body and its check character,
 * so both the four-character batch prefixes and the three-character edition
 * prefix print correctly; `prefixLen` overrides that. */
export function formatCode(code: string, prefixLen?: number): string {
  const n = normalizeCode(code);
  const pl = prefixLen ?? Math.max(0, n.length - (CODE_BODY_LEN + 1));
  const prefix = n.slice(0, pl);
  const body = n.slice(pl, pl + CODE_BODY_LEN);
  const check = n.slice(pl + CODE_BODY_LEN);
  const blocks = body.match(/.{1,4}/g) ?? [];
  if (blocks.length) blocks[blocks.length - 1] += check; // the check character rides on the last block
  return [prefix, ...blocks].filter(Boolean).join("-");
}

// ── Order numbers (KDP) ──────────────────────────────────────────────────────
// An Amazon order number is 17 digits printed as 123-1234567-1234567. A buyer
// may type it with or without the dashes or with spaces; the canonical form
// is the dashed one. Only its HMAC is stored (order_claims.order_hmac).

export function normalizeOrderNumber(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 17) return digits; // leaves a wrong length visible to isWellFormedOrderNumber
  return `${digits.slice(0, 3)}-${digits.slice(3, 10)}-${digits.slice(10)}`;
}

export function isWellFormedOrderNumber(input: string): boolean {
  return /^\d{3}-\d{7}-\d{7}$/.test(normalizeOrderNumber(input));
}
