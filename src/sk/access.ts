// SK book access (plan §11; distribution plan 2026-10-27 §3–§6): printed
// codes, edition codes, per-book access grants, and ONE access decision over
// school licences, subscriptions and grants. Pure — routes supply rows and
// the clock; nothing here touches the database.

import { createHmac } from "node:crypto";
import { normalizeCode, normalizeOrderNumber } from "./codes";

// ── Codes ────────────────────────────────────────────────────────────────────
// The code and order-number helpers (Crockford base32 + check character,
// SKB…/SKE prefixes, printed form, Amazon order numbers) are pure and live in
// ./codes so the /activate form can use them in the browser; everything is
// re-exported here so server code keeps importing from one place. Only the
// HMAC of the normalised form is ever stored.
export * from "./codes";

/** What the database stores. Never the code itself. */
export function hmacCode(code: string, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("BOOK_CODE_SECRET must be at least 16 characters");
  return createHmac("sha256", secret).update("sk-book-code:" + normalizeCode(code)).digest("hex");
}

/** HMAC of the canonical order number, under its own domain prefix so an order
 * number can never collide with a code of the same digits. */
export function hmacOrderNumber(orderNumber: string, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("BOOK_CODE_SECRET must be at least 16 characters");
  return createHmac("sha256", secret).update("sk-order:" + normalizeOrderNumber(orderNumber)).digest("hex");
}

// ── Grant terms ──────────────────────────────────────────────────────────────
// Book access is PERMANENT for every source; SK tutoring is a window per
// activation (plan §4: 30 days) plus a live-interaction allowance. The
// allowance numbers are set after the cost measurements (plan §11): null =
// unmetered while FEATURE_SK_ALLOWANCE is off. An edition code's allowance is
// smaller than a card's and lives on its edition_codes row (copied onto the
// grant by redeem_edition_code), so only the purchase terms are here.
export const GRANT_TERMS = {
  purchase: { tutorDays: 30, allowance: null as { live_turns?: number; generated_segments?: number } | null },
  edition_code: { tutorDays: 30 },
  code: { tutorDays: 30 },
} as const;

// ── The access decision ──────────────────────────────────────────────────────

export type GrantSource = "code" | "promo" | "staff" | "renewal" | "purchase" | "edition_code";
export type Grant = {
  product_id: string;
  source?: GrantSource | string;
  activated_at: string;
  /** When BOOK access ends; null = permanent (every grant since 0159). */
  expires_at: string | null;
  /** When live SK TUTORING on this grant ends; null = no tutoring window. */
  tutor_expires_at: string | null;
  revoked_at: string | null;
  usage_allowance: { live_turns?: number; generated_segments?: number } | null;
};
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
  /** May open the book's SK content (prepared teaching, the book's resources). */
  book_access: boolean;
  /** May use SK tutoring now: a school licence or subscription, or a grant whose tutor window is open. */
  tutor_access: boolean;
  source: "school" | "subscription" | "grant" | null;
  /** Which kind of grant decided (null for school/subscription). */
  grant_source: GrantSource | string | null;
  /** When tutoring ends: the grant's tutor window, or the subscription's period end; null = open-ended. */
  tutor_expires_at: string | null;
  /** Live-interaction allowance left this period; null = not metered. */
  allowance_remaining: { live_turns: number | null; generated_segments: number | null } | null;
  /** True when live help is used up: prepared teaching continues, live turns do not (R3 refinement 4). */
  live_exhausted: boolean;
  /** 75 % / 90 % warnings (R3): the fraction of the live-turn allowance used. */
  live_used_fraction: number | null;
};

/** Plans that include SK (mirrors planGrantsTutor's families + homeschool). */
export function planGrantsSk(planKey: string | null | undefined): boolean {
  const k = planKey ?? "";
  return k.startsWith("teacher_pro_plus") || k.startsWith("family") || k.startsWith("homeschool") || k.startsWith("school");
}

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : NaN);

export function skAccess(input: AccessInput): AccessDecision {
  const t = input.now.getTime();
  const none: AccessDecision = {
    book_access: false,
    tutor_access: false,
    source: null,
    grant_source: null,
    tutor_expires_at: null,
    allowance_remaining: null,
    live_exhausted: false,
    live_used_fraction: null,
  };
  // Book access comes ONLY from a live grant for the product (permanent unless
  // expires_at is set and past): a purchase, a printed or edition code, or a
  // staff/promo grant. Founder 2026-10-30: "real users are expected to buy a
  // hard copy or digital copy of the book which grants them access" — so a
  // school licence or a subscription opens SK TUTORING, never a book.
  const live = input.grants.filter(
    (g) => g.product_id === input.productId && !g.revoked_at && ms(g.activated_at) <= t && (g.expires_at == null || ms(g.expires_at) > t),
  );
  const book_access = live.length > 0;

  // Tutoring order: school licence → subscription → the grant's tutor window.
  if (input.schoolLicence) return { ...none, book_access, tutor_access: true, source: "school" };
  const sub = input.subscriptions.find((s) => s.active && planGrantsSk(s.plan_key) && (!s.current_period_end || ms(s.current_period_end) > t));
  if (sub) return { ...none, book_access, tutor_access: true, source: "subscription", tutor_expires_at: sub.current_period_end };

  // Tutoring on a grant: the grant whose tutor window reaches furthest.
  if (!live.length) return none;
  const tutorEnd = (g: Grant) => (g.tutor_expires_at ? ms(g.tutor_expires_at) : -Infinity);
  const g = [...live].sort((a, b) => tutorEnd(b) - tutorEnd(a))[0]!;
  const tutor = g.tutor_expires_at != null && ms(g.tutor_expires_at) > t;
  const base: AccessDecision = {
    ...none,
    book_access: true,
    tutor_access: tutor,
    source: "grant",
    grant_source: g.source ?? null,
    tutor_expires_at: g.tutor_expires_at,
  };
  const allowance = g.usage_allowance;
  if (!tutor || !input.allowanceEnforced || !allowance) return base;
  const used = input.usage ?? { live_turns: 0, generated_segments: 0 };
  const turnsLeft = allowance.live_turns == null ? null : Math.max(0, allowance.live_turns - used.live_turns);
  const segsLeft = allowance.generated_segments == null ? null : Math.max(0, allowance.generated_segments - used.generated_segments);
  const frac = allowance.live_turns ? Math.min(1, used.live_turns / allowance.live_turns) : null;
  return {
    ...base, // prepared teaching and the book's resources stay available for the whole tutor window
    allowance_remaining: { live_turns: turnsLeft, generated_segments: segsLeft },
    live_exhausted: turnsLeft === 0,
    live_used_fraction: frac,
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

/** Map a redeem_book_code() / redeem_edition_code() failure to what the
 * student sees. Never the raw error. */
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
    case "order_used":
      return "This order number has already been used to activate a copy.";
    case "daily_cap":
      return "This edition has reached today's activation limit. Please try again tomorrow.";
    case "bad_order":
      return "That doesn't look like an Amazon order number (123-1234567-1234567). Check your order confirmation.";
    default:
      return "Something went wrong activating this code. Please try again.";
  }
}

// ── Consent ──────────────────────────────────────────────────────────────────
export type Consent = { scope: "voice" | "transcripts" | "analytics"; revoked_at: string | null };

/**
 * Plan §14: a STUDENT may use voice (and keep transcripts) only with a live
 * guardian consent for that scope. Adults — teachers, parents, home educators,
 * the adult POC testers — need none. Consent rows come from `consents`
 * (child_id = the student); a revoked row no longer counts.
 */
export function consentAllows(scope: Consent["scope"], role: string | null | undefined, consents: Consent[]): boolean {
  if (role !== "student") return true;
  return consents.some((c) => c.scope === scope && !c.revoked_at);
}
