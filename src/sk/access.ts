// SK book access (plan §11): printed codes, per-book access grants, and ONE
// access decision over school licences, subscriptions and grants. Pure —
// routes supply rows and the clock; nothing here touches the database.

import { createHmac } from "node:crypto";

// ── Codes ────────────────────────────────────────────────────────────────────
// 16 characters of Crockford base32 (no I, L, O, U — nothing a child misreads)
// plus one check character, printed as SKB2-XXXX-XXXX-XXXX-XXXXC under the
// scratch panel. Only the HMAC of the normalised form is stored.

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BODY_LEN = 16;

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

function defaultRandom(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Printed form: SKB2-XXXX-XXXX-XXXX-XXXXC. */
export function formatCode(code: string, prefixLen = 4): string {
  const n = normalizeCode(code);
  const prefix = n.slice(0, prefixLen);
  const body = n.slice(prefixLen, prefixLen + CODE_BODY_LEN);
  const check = n.slice(prefixLen + CODE_BODY_LEN);
  const blocks = body.match(/.{1,4}/g) ?? [];
  if (blocks.length) blocks[blocks.length - 1] += check; // the check character rides on the last block
  return [prefix, ...blocks].join("-");
}

/** What the database stores. Never the code itself. */
export function hmacCode(code: string, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("BOOK_CODE_SECRET must be at least 16 characters");
  return createHmac("sha256", secret).update("sk-book-code:" + normalizeCode(code)).digest("hex");
}

// ── The access decision ──────────────────────────────────────────────────────

export type Grant = { product_id: string; activated_at: string; expires_at: string; revoked_at: string | null; usage_allowance: { live_turns?: number; generated_segments?: number } | null };
export type Subscription = { plan_key: string; active: boolean; current_period_end: string | null };
export type Usage = { live_turns: number; generated_segments: number };
export type AccessInput = {
  productId: string;
  now: Date;
  schoolLicence?: boolean; // the student's school holds an SK licence (plan key school_*)
  subscriptions: Subscription[];
  grants: Grant[];
  usage?: Usage; // this month's live usage for the product
  allowanceEnforced?: boolean; // FEATURE_SK_ALLOWANCE — off until the cost measurements set the numbers
};
export type AccessDecision = {
  allowed: boolean;
  source: "school" | "subscription" | "grant" | null;
  expiresAt: string | null;
  /** Live-interaction allowance left this period; null = not metered. */
  allowanceRemaining: { live_turns: number | null; generated_segments: number | null } | null;
  /** True when live help is used up: prepared teaching continues, live turns do not (R3 refinement 4). */
  liveExhausted: boolean;
  /** 75 % / 90 % warnings (R3): the fraction of the live-turn allowance used. */
  liveUsedFraction: number | null;
};

/** Plans that include SK (mirrors planGrantsTutor's families + homeschool). */
export function planGrantsSk(planKey: string | null | undefined): boolean {
  const k = planKey ?? "";
  return k.startsWith("teacher_pro_plus") || k.startsWith("family") || k.startsWith("homeschool") || k.startsWith("school");
}

export function skAccess(input: AccessInput): AccessDecision {
  const t = input.now.getTime();
  const none: AccessDecision = { allowed: false, source: null, expiresAt: null, allowanceRemaining: null, liveExhausted: false, liveUsedFraction: null };
  // Order: school licence → subscription → book grant (plan §11).
  if (input.schoolLicence) return { ...none, allowed: true, source: "school" };
  const sub = input.subscriptions.find((s) => s.active && planGrantsSk(s.plan_key) && (!s.current_period_end || new Date(s.current_period_end).getTime() > t));
  if (sub) return { ...none, allowed: true, source: "subscription", expiresAt: sub.current_period_end };
  const live = input.grants
    .filter((g) => g.product_id === input.productId && !g.revoked_at && new Date(g.activated_at).getTime() <= t && new Date(g.expires_at).getTime() > t)
    .sort((a, b) => new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime());
  const g = live[0];
  if (!g) return none;
  const allowance = g.usage_allowance;
  if (!input.allowanceEnforced || !allowance) return { ...none, allowed: true, source: "grant", expiresAt: g.expires_at };
  const used = input.usage ?? { live_turns: 0, generated_segments: 0 };
  const turnsLeft = allowance.live_turns == null ? null : Math.max(0, allowance.live_turns - used.live_turns);
  const segsLeft = allowance.generated_segments == null ? null : Math.max(0, allowance.generated_segments - used.generated_segments);
  const frac = allowance.live_turns ? Math.min(1, used.live_turns / allowance.live_turns) : null;
  return {
    allowed: true, // prepared teaching and the book's resources stay available for the whole grant
    source: "grant",
    expiresAt: g.expires_at,
    allowanceRemaining: { live_turns: turnsLeft, generated_segments: segsLeft },
    liveExhausted: turnsLeft === 0,
    liveUsedFraction: frac,
  };
}

/** The warning step a usage fraction has crossed (R3: warn at 75 % and 90 %). */
export function allowanceWarning(fraction: number | null): "none" | "75" | "90" | "exhausted" {
  if (fraction == null) return "none";
  if (fraction >= 1) return "exhausted";
  if (fraction >= 0.9) return "90";
  if (fraction >= 0.75) return "75";
  return "none";
}

/** Map a redeem_book_code() failure to what the student sees. Never the raw error. */
export function redeemMessage(reason: string): string {
  switch (reason) {
    case "invalid":
      return "That code isn't recognised. Check the letters under the scratch panel and try again.";
    case "used":
      return "This code has already been used.";
    case "revoked":
      return "This code is no longer valid. Please contact support with your book's details.";
    case "rate_limited":
      return "Too many attempts. Please wait an hour and try again.";
    case "not_your_child":
      return "You can only activate a book for a child linked to your account.";
    default:
      return "Something went wrong activating this code. Please try again.";
  }
}
