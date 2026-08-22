// Lemon Squeezy webhook handlers — pure-ish and testable (DB + resolvers
// injected). LS SUBSCRIPTION events are the single driver of the
// provider-agnostic `entitlements` table for B2C plans; the app reads that
// table regardless of provider. Parent/teacher plans are personal, so their
// entitlement/customer rows carry school_id = NULL (invisible to a school
// admin, like personal Stripe plans).
//
// IDENTITY — two very different origins:
//   (a) Authenticated in-app checkout (createLsCheckout) sets custom_data
//       {user_id, plan_key}; the signature proves it came from the checkout WE
//       created, so we trust it and store the ls_customer_id ↔ user_id mapping.
//   (b) The PUBLIC pricing page links straight to LS hosted checkout, so the
//       webhook carries NO custom_data and the buyer may be logged out. There
//       the only identity signal is the buyer's LS email — which a buyer can
//       type freely, so we NEVER auto-bind a paid sub onto a pre-existing
//       account from the webhook. Instead we PARK the subscription as
//       "unclaimed" (user_id NULL, claim_email = the LS email) and grant no
//       access until the account holder signs in with that verified email and
//       claims it (see claim.ts). An unclaimed sub has NO entitlement row.
//
// PLAN — the public checkout carries no plan_key, so plan_key is derived from
// the subscription's variant_id (the trusted source); custom_data.plan_key is
// only a cross-checked fast-path.

import { planKeyForVariant as defaultPlanKeyForVariant } from "@/utils/stripe/plans";
import { packForOrderItem } from "@/utils/billing/packs";

export type Db = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: unknown): {
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null }>;
      };
    };
    upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
    insert(row: Record<string, unknown>): PromiseLike<{ error: { code?: string; message: string } | null }>;
    update(row: Record<string, unknown>): {
      eq(col: string, v: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

type LsSubscriptionAttributes = {
  status: string; // on_trial|active|paused|past_due|unpaid|cancelled|expired
  customer_id: number | string;
  variant_id?: number | string | null; // identifies WHICH product/cycle was bought
  product_id?: number | string | null;
  product_name?: string | null; // fallback mapping for products whose variant env isn't set yet
  variant_name?: string | null;
  user_email?: string | null; // buyer email — the only identity signal on a public-link purchase
  user_name?: string | null;
  order_id?: number | string | null; // to look up the applied discount (founding)
  renews_at: string | null;
  ends_at: string | null;
  updated_at?: string | null; // LS's own timestamp — monotonicity gate
  urls?: { customer_portal?: string | null } | null;
};

// THE MONEY BLOCK, identical on an LS order and an LS subscription invoice:
// four SEPARATE integers in MINOR UNITS, plus LS's own USD conversion of each.
// Nothing here needs adding up or splitting apart — LS has already done the
// decomposition, which is the whole reason booking revenue net of tax needs no
// arithmetic beyond one subtraction. The identity LS maintains is
//
//     total = subtotal - discount_total + tax
//
// and lsNetOfTax() below is the ONLY place in this codebase that reads these.
type LsMoneyAttributes = {
  subtotal?: number | null; // MINOR UNITS, BEFORE discount, EXCLUDING tax
  discount_total?: number | null; // MINOR UNITS taken off the subtotal
  tax?: number | null; // MINOR UNITS LS collects and remits — never ours
  total?: number | null; // MINOR UNITS of `currency` — NOT necessarily USD
  currency?: string | null;
  subtotal_usd?: number | null; // the same four, converted by LS at currency_rate
  discount_total_usd?: number | null;
  tax_usd?: number | null;
  total_usd?: number | null;
};

// One-time purchase (credit packs). LS puts the bought product on
// first_order_item; single-item checkouts (ours) never populate more.
type LsOrderAttributes = LsMoneyAttributes & {
  customer_id: number | string;
  user_email?: string | null;
  status?: string | null; // paid | refunded | ...
  refunded?: boolean | null;
  updated_at?: string | null;
  first_order_item?: {
    product_id?: number | string | null;
    variant_id?: number | string | null;
    product_name?: string | null;
    variant_name?: string | null;
  } | null;
};

// A SUBSCRIPTION INVOICE — the object behind every subscription_payment_*
// event. Its LS type string is "subscription-invoices": neither "subscriptions"
// nor "orders", which is exactly why both existing handlers refuse it.
//
// WHAT IT DOES NOT CARRY, verified against the live object (invoice 8235804) on
// 2026-08-20 — these absences shape the whole design:
//   · NO order_id attribute and NO `order` relationship. Its only relationships
//     are store, subscription, customer, affiliate. There is no supportable way
//     to name the order a renewal belongs to, because a renewal HAS no order.
//   · NO variant_id / product_id / product_name / variant_name. plan_key cannot
//     be derived here; it has to be read from the stored subscriptions row.
// What it does carry: its own stable id, the subscription id, the customer id
// and buyer email (so park-and-claim works unchanged), the money in MINOR
// UNITS, and billing_reason — LS's own proof that an invoice is the initial
// charge rather than a renewal.
type LsInvoiceAttributes = LsMoneyAttributes & {
  subscription_id?: number | string | null;
  customer_id: number | string;
  user_email?: string | null;
  billing_reason?: string | null; // initial | renewal | updated
  status?: string | null; // pending | paid | void | refunded | partial_refund
  refunded?: boolean | null;
  refunded_amount?: number | null;
  created_at?: string | null; // when the money was taken — payments is a time series
  updated_at?: string | null;
  test_mode?: boolean | null;
};

export type LsEvent = {
  meta?: { event_name?: string; custom_data?: { user_id?: string; plan_key?: string } | null } | null;
  data?: { type?: string; id?: string; attributes?: LsSubscriptionAttributes | LsOrderAttributes | LsInvoiceAttributes } | null;
};

export type HandleLsDeps = {
  /** Reverse variant_id → plan_key lookup (defaults to the env-backed one). */
  planKeyForVariant?: (variantId: string | number | null | undefined) => string | null;
  /** Best-effort: did this subscription's order apply the founding discount?
   * Defaults to "no" so tests and non-teacher plans stay side-effect free. */
  detectFounding?: (attrs: { order_id?: string | number | null; variant_id?: string | number | null }) => Promise<boolean>;
};

// Statuses that keep access. `cancelled` keeps access until ends_at (grace) —
// deriveActive() flips it off once ends_at passes. paused/unpaid/expired = no
// access.
export const ACTIVE_LS_STATUSES = ["on_trial", "active", "past_due", "cancelled"];

/** Whether a stored LS subscription (status + already-computed period end) is
 * currently entitled. `cancelled` with no period end has no grace window, so it
 * must read inactive. Shared with claim.ts so a claimed sub grants the same
 * access the live webhook would. */
export function lsActiveFromStored(status: string, currentPeriodEnd: string | null): boolean {
  return ACTIVE_LS_STATUSES.includes(status) && !(status === "cancelled" && currentPeriodEnd === null);
}

/** THE TAX RULE — one subtraction, applied in exactly one place.
 *
 * "Collected to date" counts revenue NET OF TAX (founder, 2026-08-22). Lemon
 * Squeezy is Merchant of Record: on the first real sale it added $1.80 IGST to
 * a $9.99 list price for an Indian buyer and remits that $1.80 itself. The
 * business never keeps it, so it must never appear as revenue. The tax figure
 * is DISCARDED rather than stored — there is deliberately no tax column
 * anywhere, so this function is the whole of the policy: what it drops is gone.
 *
 * WHICH FIELD, and why the obvious answer is a trap. LS gives us all four
 * numbers separately (see LsMoneyAttributes), so this is a choice, not a
 * calculation:
 *   · NOT `total` — that is the bug this replaces: 1179 booked for a $9.99
 *     sale, $1.80 of it money we merely passed through to a tax authority.
 *   · NOT bare `subtotal` either, and this is the part that is easy to get
 *     wrong: subtotal is BEFORE any discount. A FOUNDINGTEACHER order takes $14
 *     off $24 — subtotal 2400, discount_total 1400, total 1000 + tax — so
 *     booking subtotal alone would report 2400 for a sale that collected $10.
 *     That is a LARGER error than the gross bug, in the same direction, and it
 *     would land on every discounted sale we ever make.
 *   · `subtotal - discount_total` — what the business charged, which is exactly
 *     what it keeps. The four live cases it has to get right:
 *         subscription invoice 8235804:  999 - 0    =  999   ($9.99 + 180 IGST)
 *         pack order 9261766:            800 - 0    =  800   ($8.00 + 144 IGST)
 *         a FOUNDINGTEACHER order:      2400 - 1400 = 1000
 *         the untaxed test packs:        800 - 0    =  800   (unchanged)
 *
 * `total - tax` is the same number reached from the other side of LS's identity
 * (total = subtotal - discount_total + tax — which reconciles field for field
 * on every payload this store has produced, order 9261766 and invoice 8235804
 * included), and it is the FALLBACK below for a payload that omits the first
 * pair. It is deliberately not the primary form: the rule is that the tax
 * number is discarded, and an expression that never READS `tax` cannot
 * mishandle it — not under LS's tax-inclusive pricing mode, not on a tax-only
 * adjustment.
 *
 * The one direction that trade goes the other way, named so it is a known edge
 * and not a surprise: if LS's money block ever grows a component of `total`
 * that is NOT tax and IS ours to keep (a setup fee is the obvious candidate),
 * `subtotal - discount_total` would silently omit it while the fallback would
 * catch it. No such field appears on this store's objects today. Re-check this
 * function against a live payload before enabling any variant option that adds
 * a charge outside the subtotal.
 *
 * A NEGATIVE result is never booked. A discount exceeding its own subtotal is
 * incoherent data, not a refund, and the standing rule here is that an invented
 * amount corrupts the revenue total silently — so it returns null and the
 * caller logs and skips. Zero IS bookable: a fully-discounted sale genuinely
 * collected nothing, and a 0 row is the truth about it. */
function netOfTax(
  subtotal: number | null | undefined,
  discountTotal: number | null | undefined,
  total: number | null | undefined,
  tax: number | null | undefined,
): number | null {
  const fin = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const sub = fin(subtotal);
  const gross = fin(total);
  const net = sub !== null ? sub - (fin(discountTotal) ?? 0) : gross !== null ? gross - (fin(tax) ?? 0) : null;
  if (net === null || net < 0) return null;
  return Math.round(net);
}

/** LS's money block reduced to the two net-of-tax figures every writer stores
 * and prices from. THE ONLY producer of the values written to
 * credit_purchases.total_minor and subscription_invoices.total_minor /
 * total_usd_minor.
 *
 * ⚠️ THOSE COLUMNS ARE NAMED FOR THE GROSS ERA AND NO LONGER HOLD A "total".
 * credit_purchases.total_minor shipped applied in 0092 as "what LS actually
 * collected"; renaming an applied column is not free, so 0093 corrects its
 * COMMENT instead and subscription_invoices keeps the same name so one concept
 * keeps one name across both tables. What makes that misnomer harmless is that
 * a single function produces the value and its name says net — never widen this
 * to a second producer.
 *
 * The USD side is netted from LS's OWN conversions of the same four fields
 * rather than converted here; see lsRevenueAmount for why that figure exists. */
export function lsNetOfTax(attrs: LsMoneyAttributes): {
  netMinor: number | null;
  currency: string | null;
  netUsdMinor: number | null;
} {
  return {
    netMinor: netOfTax(attrs.subtotal, attrs.discount_total, attrs.total, attrs.tax),
    currency: attrs.currency ? String(attrs.currency).trim().toLowerCase() : null,
    netUsdMinor: netOfTax(attrs.subtotal_usd, attrs.discount_total_usd, attrs.total_usd, attrs.tax_usd),
  };
}

/** THE ONE DEFINITION OF "the amount" for a sale, shared by the two writers
 * that can produce its payments row — this webhook (buyer already bound) and
 * claim.ts (buyer bound later). 0092's comments exist because pricing one
 * revenue series from two definitions is how "Collected to date" became a
 * number built out of incompatible parts; one exported function is the cheapest
 * way that cannot happen again.
 *
 * MINOR UNITS throughout, which is what LS reports and what payments.amount
 * stores. NET OF TAX — the figures handed in come from lsNetOfTax() at the
 * webhook boundary, or straight out of the columns it stamped, which is why
 * this function contains no tax arithmetic of its own and must never grow any.
 *
 * CURRENCY: payments_currency_check (0023) admits only 'myr' and 'usd'. A
 * charge in anything else cannot be stored faithfully as-is, so LS's OWN USD
 * conversion (netted from attributes.*_usd at its currency_rate) is used rather
 * than dropping the sale or — far worse — writing foreign minor units into a
 * row labelled dollars. Returns null when there is no usable figure at all: an
 * invented amount corrupts the revenue total silently, so the caller logs and
 * skips instead. */
export function lsRevenueAmount(
  netMinor: number | null | undefined,
  currency: string | null | undefined,
  netUsdMinor: number | null | undefined,
): { amount: number; currency: "usd" | "myr" } | null {
  const cur = (currency ?? "usd").trim().toLowerCase();
  if (typeof netMinor === "number" && Number.isFinite(netMinor) && (cur === "usd" || cur === "myr")) {
    return { amount: Math.round(netMinor), currency: cur };
  }
  if (typeof netUsdMinor === "number" && Number.isFinite(netUsdMinor)) {
    return { amount: Math.round(netUsdMinor), currency: "usd" };
  }
  return null;
}

function norm(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e || null;
}

function log(kind: string, detail: Record<string, unknown>) {
  console.log(`billing.ls.${kind}`, detail);
}

// ── identity ────────────────────────────────────────────────────────────────
type Identity =
  | { kind: "user"; userId: string; isNew: boolean } // known account (fast-path or previously claimed)
  | { kind: "unclaimed"; email: string } // paid, but not bound to any account yet
  | { kind: "refused" }; // conflicting/insufficient signal — do not write

async function resolveIdentity(
  db: Db,
  customData: { user_id?: string } | null | undefined,
  lsCustomerId: string,
  email: string | null,
): Promise<Identity> {
  const claimed = customData?.user_id;
  const { data: row } = await db
    .from("billing_customers")
    .select("user_id")
    .eq("ls_customer_id", lsCustomerId)
    .maybeSingle();

  if (row) {
    const storedUserId = (row.user_id as string | null) ?? null;
    if (storedUserId) {
      // Previously bound to an account. A later event claiming a DIFFERENT user
      // is a mismatch — refuse (mirrors the original guard).
      if (claimed && storedUserId !== claimed) {
        log("identity_mismatch", { ls_customer: lsCustomerId, claimed_user: claimed });
        return { kind: "refused" };
      }
      return { kind: "user", userId: storedUserId, isNew: false };
    }
    // Row exists but is still UNCLAIMED (parked). If a trusted app checkout now
    // supplies a user_id, we can bind it; otherwise it stays unclaimed.
    if (claimed) return { kind: "user", userId: claimed, isNew: false };
    if (email) return { kind: "unclaimed", email };
    return { kind: "refused" };
  }

  // First sight of this LS customer.
  if (claimed) return { kind: "user", userId: claimed, isNew: true }; // authenticated in-app checkout
  if (email) return { kind: "unclaimed", email }; // public-link purchase — park, never auto-bind
  log("identity_unresolved", { ls_customer: lsCustomerId }); // no user_id AND no email — cannot attribute
  return { kind: "refused" };
}

// ── plan_key ──────────────────────────────────────────────────────────────

/** LS product name → the plan_key pair for its two cycles.
 *
 *  These are the EXACT live product names (verified against the LS catalogue
 *  on 2026-08-20: products 1302951 / 1302956 / 1302959 / 1302964). They are
 *  load-bearing strings, not labels — renaming a product in the LS dashboard
 *  disables this fallback for it, so rename here in the same change.
 *
 *  Note the plan_key spelling: Home Basic's keys are `family_*`. The
 *  user-visible name changed in the homeschool release; billing/DB identifiers
 *  never rename (see PLANS in utils/stripe/plans.ts). */
const PRODUCT_NAME_TO_PLAN: Record<string, { monthly: string; annual: string }> = {
  "SketchCast Teacher Pro": { monthly: "teacher_pro_monthly", annual: "teacher_pro_annual" },
  "SketchCast Teacher Pro+": { monthly: "teacher_pro_plus_monthly", annual: "teacher_pro_plus_annual" },
  "SketchCast Home Basic": { monthly: "family_monthly", annual: "family_annual" },
  "SketchCast Homeschool": { monthly: "homeschool_monthly", annual: "homeschool_annual" },
};

async function resolvePlanKey(
  db: Db,
  attrs: LsSubscriptionAttributes,
  customData: { plan_key?: string } | null | undefined,
  lsSubscriptionId: string,
  planKeyForVariant: (v: string | number | null | undefined) => string | null,
): Promise<string | null> {
  // Trusted source first: the variant id on the subscription.
  const fromVariant = planKeyForVariant(attrs.variant_id);
  const claimed = customData?.plan_key;
  if (fromVariant) {
    if (claimed && claimed !== fromVariant) {
      // custom_data is client-influenceable; the variant is authoritative.
      log("plan_key_mismatch", { subscription: lsSubscriptionId, variant_plan: fromVariant, claimed_plan: claimed });
    }
    return fromVariant;
  }
  // PRODUCT NAME fallback — the safety net under a stale variant map.
  //
  // The variant id above is the primary mapping and the only one that
  // distinguishes cycle reliably, but it lives entirely in env, and LS
  // REASSIGNS a variant id whenever the variant is edited. On 2026-08-20 the
  // store went live and every id in env was still a dead TEST-mode object:
  // planKeyForVariant returned null for all four live products, and only
  // Homeschool (which already had this fallback) survived. The other three
  // reached `no_plan_key` and returned BEFORE writing billing_customers,
  // subscriptions or entitlements — i.e. a real card was charged and the app
  // held no record that the buyer existed. That is the failure this table now
  // covers for every plan, not just one.
  //
  // The product name is a stable, human-authored string on LS's own object
  // (custom_data, by contrast, comes from the client) — hence this sits ABOVE
  // the custom_data fast-path. variant_name decides the cycle ("Annual"/
  // "Yearly" → annual, anything else → monthly); access is identical either
  // way, only console MRR arithmetic differs, so monthly is the safe default.
  //
  // EXACT match, deliberately: a future "SketchCast Homeschool Plus" or
  // "SketchCast Teacher Pro Max" must surface as unmapped rather than silently
  // sell at a neighbouring plan's caps. Note "SketchCast Teacher Pro" and
  // "SketchCast Teacher Pro+" are distinct keys — exact matching is what keeps
  // the shorter one from swallowing the longer.
  //
  // ⚠️ This is a NET, not a replacement. It cannot tell a $240/yr buyer from a
  // $24/mo one when the variant is unmapped AND the variant name is unusual,
  // and it will not fire at all for a product renamed in the dashboard. Set
  // the eight LEMONSQUEEZY_VARIANT_* ids correctly and keep them correct.
  const byName = PRODUCT_NAME_TO_PLAN[(attrs.product_name ?? "").trim()];
  if (byName) {
    const cycle = /annual|year/i.test(attrs.variant_name ?? "") ? byName.annual : byName.monthly;
    log("plan_key_from_product_name", { subscription: lsSubscriptionId, product: attrs.product_name, variant_name: attrs.variant_name ?? null, plan: cycle });
    return cycle;
  }
  // No variant mapping — fall back to the (cross-checked) fast-path, then to any
  // plan_key we already stored for this subscription.
  if (claimed) return claimed;
  const { data: row } = await db
    .from("subscriptions")
    .select("plan_key")
    .eq("ls_subscription_id", lsSubscriptionId)
    .maybeSingle();
  const prior = (row?.plan_key as string | null) ?? null;
  if (!prior && attrs.variant_id != null) {
    log("unmapped_variant", { subscription: lsSubscriptionId, variant: String(attrs.variant_id) }); // ALERT: a real sale we can't map
  }
  return prior;
}

async function upsertEntitlement(
  db: Db,
  args: { userId: string; active: boolean; planKey: string; status: string; currentPeriodEnd: string | null },
): Promise<void> {
  const { error } = await db.from("entitlements").upsert(
    {
      user_id: args.userId,
      school_id: null, // LS plans are personal (B2C) — never school-scoped
      provider: "lemonsqueezy",
      active: args.active,
      plan_key: args.planKey,
      status: args.status,
      current_period_end: args.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,plan_key" },
  );
  if (error) throw new Error(`LS entitlement upsert failed: ${error.message}`);
  log("entitlement", { user: args.userId, active: args.active, plan: args.planKey, status: args.status });
}

export async function handleLsEvent(db: Db, event: LsEvent, deps: HandleLsDeps = {}): Promise<void> {
  const planKeyForVariant = deps.planKeyForVariant ?? defaultPlanKeyForVariant;
  const detectFounding = deps.detectFounding ?? (async () => false);

  const name = event.meta?.event_name ?? "";
  if (name.startsWith("order")) {
    await handleLsOrderEvent(db, event, name);
    return;
  }
  if (!name.startsWith("subscription")) {
    log("ignored", { event: name });
    return;
  }
  const sub = event.data;
  // INVOICE-SHAPED events get their OWN writer, above the guard below rather
  // than by relaxing it. This is the whole of the subscription revenue path:
  // an invoice exists for the initial charge AND for every renewal, while an
  // order exists only for the initial charge, so the invoice is the one object
  // that covers all collected subscription money exactly once. It grants
  // nothing — entitlements still come solely from the subscription object.
  if (sub?.type === "subscription-invoices") {
    await handleLsInvoiceEvent(db, event, name);
    return;
  }
  // The `subscription_*` family includes invoice-shaped events
  // (subscription_payment_success/failed/refunded), whose `data.type` is
  // "subscription-invoices" and whose `status` is "paid"/"refunded" — NOT a
  // subscription lifecycle status. Drive entitlements ONLY from the actual
  // subscription object, or an invoice's "paid" would be read as "not active"
  // and wrongly revoke access. Payment health already flows through
  // subscription_updated (past_due/unpaid). The branch above takes the invoice
  // for BOOKKEEPING; this guard is what keeps it away from ACCESS, and both
  // must stay.
  if (sub?.type && sub.type !== "subscriptions") {
    log("ignored_non_subscription_object", { event: name, type: sub.type });
    return;
  }
  const attrs = sub?.attributes as LsSubscriptionAttributes | undefined;
  const subId = sub?.id;
  if (!attrs || !subId) return;

  const lsCustomerId = String(attrs.customer_id);
  const email = norm(attrs.user_email);

  const planKey = await resolvePlanKey(db, attrs, event.meta?.custom_data, subId, planKeyForVariant);
  if (!planKey) {
    log("no_plan_key", { subscription: subId, variant: attrs.variant_id != null ? String(attrs.variant_id) : null });
    return;
  }

  const who = await resolveIdentity(db, event.meta?.custom_data, lsCustomerId, email);
  if (who.kind === "refused") return;

  // MONOTONICITY GATE: LS delivery can be out of order, and each state has a
  // distinct idempotency key (updated_at is in the key), so a stale "active"
  // arriving AFTER "expired" would otherwise re-grant access. Compare the
  // incoming updated_at against the stored one and skip anything older.
  const incomingTs = attrs.updated_at ?? null;
  const { data: existingSub } = await db
    .from("subscriptions")
    .select("provider_updated_at, user_id, is_founding")
    .eq("ls_subscription_id", subId)
    .maybeSingle();
  const storedTs = (existingSub?.provider_updated_at as string | null) ?? null;
  if (incomingTs && storedTs && new Date(incomingTs).getTime() < new Date(storedTs).getTime()) {
    log("stale_event_skipped", { subscription: subId, incoming: incomingTs, stored: storedTs });
    return;
  }

  let boundUserId = who.kind === "user" ? who.userId : null;
  let claimEmail = who.kind === "unclaimed" ? who.email : null;
  // Never DEMOTE an already-claimed subscription back to unclaimed. A later
  // no-custom_data lifecycle event (renewal/cancel) resolves as "unclaimed",
  // but if this sub was already bound to a user, that binding is authoritative —
  // keep it so the entitlement stays live and the row isn't re-parked.
  const priorSubUserId = (existingSub?.user_id as string | null) ?? null;
  if (!boundUserId && priorSubUserId) {
    boundUserId = priorSubUserId;
    claimEmail = null;
  }

  // Customer mapping, keyed by the LS customer id so it dedupes for both claimed
  // and unclaimed rows. A failure here must ABORT (LS retries) — never proceed
  // to grant with no customer record.
  const { error: mapErr } = await db.from("billing_customers").upsert(
    {
      user_id: boundUserId, // NULL while unclaimed
      email, // the LS email (lower-cased) — the claim key
      school_id: null,
      provider: "lemonsqueezy",
      ls_customer_id: lsCustomerId,
      ls_customer_portal_url: attrs.urls?.customer_portal ?? null,
      stripe_customer_id: null,
      role: "",
    },
    { onConflict: "ls_customer_id" },
  );
  if (mapErr) throw new Error(`LS customer mapping failed: ${mapErr.message}`);

  // Access mapping. `cancelled` keeps access until ends_at (grace); a cancelled
  // sub with NO ends_at has no grace window, so it must read inactive rather
  // than being granted forever (deriveActive treats a null period-end as "no
  // expiry").
  const cancelledOrExpired = attrs.status === "cancelled" || attrs.status === "expired";
  const periodEnd = (cancelledOrExpired ? attrs.ends_at : attrs.renews_at) ?? null;
  const active = lsActiveFromStored(attrs.status, periodEnd);

  // Founding cohort: Teacher Pro bought with the FOUNDINGTEACHER discount. Same
  // access as Teacher Pro, but tracked. Best-effort — never blocks the grant.
  let isFounding = false;
  try {
    isFounding = await detectFounding({ order_id: attrs.order_id, variant_id: attrs.variant_id });
  } catch (e) {
    log("founding_detect_failed", { subscription: subId, err: (e as Error).message });
  }
  // ⚠️ THE FLAG IS MONOTONIC: it may be set, never cleared. Detection is a
  // best-effort LS lookup that returns false for EVERY failure — a throw, a
  // getOrder error, a rate limit — and this handler runs again on every later
  // lifecycle event (renewal, payment status, cancel). Without this line a
  // routine subscription_updated arriving while LS is erroring would silently
  // turn a genuine founding subscriber's row back into a non-founding one, and
  // nothing would ever set it back. That is wrong twice over: the customer's
  // cohort is a historical fact about how they bought, and the row is what
  // /api/public/founding-places counts when LS is unreachable — i.e. exactly
  // when these failures cluster — so a cleared flag would understate how many
  // places are gone and overstate availability on the pricing page.
  if (!isFounding && existingSub?.is_founding === true) isFounding = true;

  await db.from("subscriptions").upsert(
    {
      user_id: boundUserId, // NULL while unclaimed
      claim_email: claimEmail, // set only while unclaimed
      school_id: null,
      provider: "lemonsqueezy",
      ls_subscription_id: subId,
      stripe_subscription_id: null,
      plan_key: planKey,
      status: attrs.status,
      current_period_end: periodEnd,
      cancel_at_period_end: attrs.status === "cancelled",
      is_founding: isFounding,
      provider_updated_at: incomingTs,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "ls_subscription_id" },
  );

  // The entitlement (the ACCESS grant) is written ONLY for a known user. An
  // unclaimed purchase stays parked as the subscription above and becomes an
  // entitlement the moment its email is claimed at sign-in (claim.ts).
  if (boundUserId) {
    await upsertEntitlement(db, { userId: boundUserId, active, planKey, status: attrs.status, currentPeriodEnd: periodEnd });
    log("subscription_synced", { subscription: subId, status: attrs.status, event: name });
  } else {
    // Not an error — money is safely recorded and reconcilable. Alert-tier so
    // ops can see paid-but-unclaimed customers (they get access on sign-in).
    console.warn("billing.ls.subscription_parked_unclaimed", { subscription: subId, email, plan: planKey, status: attrs.status });
  }
}

// ── one-time orders: credit packs (0086) ────────────────────────────────────
// The `order_*` family covers EVERY purchase, including the initial order of a
// subscription — so an order only matters here when its line item resolves to
// a configured credit pack (src/utils/billing/packs.ts: product-name prefix
// "SketchCast Credits" + a trailing "(N)" on the product OR variant name, so
// both LS shapes — three products, or one product with three variants —
// credit correctly). Everything else is logged and left to the
// subscription_* events.
//
// Identity works exactly like subscriptions: an in-app checkout carries
// custom_data.user_id (trusted — we created that checkout); a public-link
// purchase has only the buyer-typed email, so the pack is PARKED
// (credit_purchases.owner_id NULL, claim_email set) and claim.ts binds it when
// the account holder signs in with that verified email. Idempotency is the
// UNIQUE ls_order_id: LS re-delivery and order-update re-fires insert-conflict
// into a no-op, so one order credits exactly once.
async function handleLsOrderEvent(db: Db, event: LsEvent, name: string): Promise<void> {
  const order = event.data;
  if (order?.type && order.type !== "orders") {
    log("ignored_non_order_object", { event: name, type: order.type });
    return;
  }
  const attrs = order?.attributes as LsOrderAttributes | undefined;
  const orderId = order?.id;
  if (!attrs || !orderId) return;

  const item = attrs.first_order_item ?? null;
  const pack = packForOrderItem(item?.product_name, item?.variant_name);
  if (!pack) {
    // ⚠️ DO NOT "FIX" THIS INTO A SUBSCRIPTION REVENUE PATH. It looks like the
    // obvious place to catch a subscription's initial order, and doing so would
    // DOUBLE-COUNT month one: that same charge also arrives as a subscription
    // invoice (verified 2026-08-20 — order 9261749 and invoice 8235804 are the
    // same $11.79, field for field), and the invoice is the only object a
    // RENEWAL produces. handleLsInvoiceEvent books every subscription charge
    // exactly once; this return is what keeps it exactly once.
    //
    // ⚠️ THE ASSUMPTION THIS RETURN RESTS ON, named so it is a decision and not
    // a discovery: it also makes `order_refunded` on a SUBSCRIPTION's initial
    // order completely inert — we return here, above the refund block below,
    // and nothing stored links an order id to the invoice whose payments row
    // would need flipping (0093 deliberately does not add
    // subscriptions.ls_order_id). So "a refund stops counting" holds for
    // subscriptions ONLY IF Lemon Squeezy also delivers
    // subscription_payment_refunded for that same money. That is what the
    // invoice object's refunded/refunded_at/refunded_amount fields and the live
    // webhook's subscription_payment_refunded subscription both imply, but no
    // refund has ever occurred on this store, so it is INFERRED, not observed.
    // FIRST REAL REFUND: check that subscription_payment_refunded arrives. If it
    // does not, the fix is to persist subscriptions.ls_order_id (LS already
    // sends it as subscription.attributes.order_id and it is received above) and
    // stamp the linked invoice's payments row from here. Storing that id does
    // not create the double count — only BOOKING the order would, and this
    // return is what prevents that.
    log("order_ignored_not_pack", { order: orderId, product: item?.product_name ?? null });
    return;
  }

  // Refund (or a late-delivered order already refunded): the pack stops
  // contributing to the balance. Credits already spent stand — the DB clamps
  // the balance at 0 (fair_use_purchased_remaining). Idempotent by nature.
  const refunded = name === "order_refunded" || attrs.refunded === true || attrs.status === "refunded";
  if (name === "order_refunded") {
    const now = new Date().toISOString();
    const { error } = await db.from("credit_purchases").update({ refunded_at: now }).eq("ls_order_id", orderId);
    if (error) throw new Error(`LS pack refund update failed: ${error.message}`);
    await db.from("payments").update({ status: "refunded" }).eq("ls_order_id", orderId);
    // Refund-before-create race: if the order_created delivery failed and LS
    // is still retrying it, there was no row for the update above to stamp —
    // and the retried payload (frozen at status "paid") would later insert an
    // un-refunded pack. Insert a refunded TOMBSTONE now (parked by email;
    // owner doesn't matter — a refunded row never contributes to the balance)
    // so that retry lands on the unique ls_order_id and no-ops. In the normal
    // order the tombstone itself is the 23505 no-op.
    const { error: tombErr } = await db.from("credit_purchases").insert({
      owner_id: null,
      claim_email: norm(attrs.user_email),
      credits: pack.credits,
      pack_key: pack.key,
      usd: pack.usd,
      provider: "lemonsqueezy",
      ls_order_id: orderId,
      refunded_at: now,
    });
    if (tombErr && tombErr.code !== "23505") {
      // The stamp above succeeded on whatever row exists — this is belt over
      // braces, never worth failing the webhook (LS would retry the refund).
      console.warn("billing.ls.pack_refund_tombstone_failed", { order: orderId, err: tombErr.message });
    }
    log("pack_refunded", { order: orderId, pack: pack.key });
    return;
  }

  // ZERO-VALUE PACK ORDERS NEVER CREDIT.
  //
  // A credit pack is a one-time purchase; there is no legitimate $0 pack sale.
  // The comp lever is migration 0079's `credit_grants`, not a free pack — so a
  // pack order that collected nothing is either a fully-discounted checkout or
  // a mistake, and in both cases granting generations for it is wrong.
  //
  // This is not hypothetical. On 2026-08-20 the live FOUNDINGTEACHER discount
  // (id 1105799, $14 fixed, repeating 24 months) was created with
  // is_limited_to_products:false, so it applied to EVERY variant in the store.
  // Fetching the pack_6 checkout with that code returns subtotal 800,
  // discount_total 800, total 0 — and LS flips the cart to its
  // no-payment-details path, so the order completes with no card at all. The
  // code is printed in plain text with a Copy button on /pricing in all ten
  // languages. Without this guard each such order granted 6 generations, and
  // each one also burned one of the 50 store-wide redemptions the founding
  // teachers are meant to get.
  //
  // The real fix is scoping the discount to Teacher Pro in the LS dashboard;
  // this guard is the belt under that brace, and it stays either way because
  // "paid nothing" must never mean "credited". Deliberately `=== 0` on a
  // number, not a falsy test: an absent/unparsable total is NOT proof of a
  // free order, so it falls through and credits as before rather than
  // silently dropping a real sale. Logged loudly — a hit here means money and
  // the catalogue disagree, and someone must look.
  //
  // READS `total`, NOT the net figure, and that is deliberate. This is a
  // CREDIT-GRANTING decision — "did the buyer pay anything at all" — and it must
  // not be coupled to the revenue policy, which can change (it just did) and
  // whose invariant is that bookkeeping never costs a user their credits. The
  // two agree on every payload LS can send anyway: tax is levied on the
  // discounted price, so a 100%-discounted order has total 0 AND net 0, and
  // nothing can make one zero while the other is not.
  if (typeof attrs.total === "number" && attrs.total === 0) {
    log("pack_zero_total_refused", {
      order: orderId,
      pack: pack.key,
      credits_withheld: pack.credits,
      currency: attrs.currency ?? null,
      status: attrs.status ?? null,
    }); // ALERT: a $0 pack order — check the discount's product scope in LS
    return;
  }

  const lsCustomerId = String(attrs.customer_id);
  const email = norm(attrs.user_email);
  const who = await resolveIdentity(db, event.meta?.custom_data, lsCustomerId, email);
  if (who.kind === "refused") return; // money stays reconcilable in LS; never guess an owner

  const boundUserId = who.kind === "user" ? who.userId : null;
  const claimEmail = who.kind === "unclaimed" ? who.email : null;

  // Keep the customer mapping current (same dedupe key as subscriptions); a
  // failure aborts so LS retries — never credit without a customer record.
  const { error: mapErr } = await db.from("billing_customers").upsert(
    {
      user_id: boundUserId,
      email,
      school_id: null,
      provider: "lemonsqueezy",
      ls_customer_id: lsCustomerId,
      stripe_customer_id: null,
      role: "",
    },
    { onConflict: "ls_customer_id" },
  );
  if (mapErr) throw new Error(`LS customer mapping failed: ${mapErr.message}`);

  const { error: insErr } = await db.from("credit_purchases").insert({
    owner_id: boundUserId, // NULL while parked
    claim_email: claimEmail, // set only while parked
    credits: pack.credits,
    pack_key: pack.key,
    usd: pack.usd,
    provider: "lemonsqueezy",
    ls_order_id: orderId,
    refunded_at: refunded ? new Date().toISOString() : null,
  });
  if (insErr) {
    if (insErr.code === "23505") {
      log("pack_duplicate_order", { order: orderId, pack: pack.key });
      return; // already credited — LS re-delivery / order-update re-fire
    }
    throw new Error(`LS pack purchase insert failed: ${insErr.message}`);
  }

  // THE MONEY FACTS, stamped as a SEPARATE best-effort statement (0092 columns).
  // `usd` above is the catalogue LIST price — a TS constant from packs.ts that
  // cannot see a discount code — and it is the only price a parked pack used to
  // carry, so claim.ts had nothing else to bill from and a discounted sale was
  // booked at full price. total/currency/status are what LS actually reports,
  // and they are the same three values the payments insert below uses, so both
  // writers now price a pack from one definition of "the amount".
  //
  // WHY NOT JUST ADD THEM TO THE INSERT ABOVE: that insert is the CREDIT GRANT.
  // Naming a column that does not exist yet (0092 unapplied, or a stale
  // PostgREST schema cache right after a deploy) fails the whole statement,
  // which throws, which makes LS retry — and the buyer waits on a bookkeeping
  // column for credits they have already paid for. Credits before revenue: the
  // grant names only columns that shipped with 0086, and the money rides in
  // behind it where a failure is a warning and nothing more. 0092's backfill
  // and claim.ts's catalogue fallback both cover the gap.
  //
  // NET OF TAX, from lsNetOfTax and nowhere else. total_minor keeps its 0092
  // name but no longer holds LS's `total`: on the live pack order 9261766 LS
  // collected 944 ($8.00 + $1.44 IGST) and this stamps 800, because the $1.44
  // is remitted by LS and the business never keeps it. 0093 corrects the column
  // comment and repairs the rows this used to write gross.
  const net = lsNetOfTax(attrs);
  const { error: moneyErr } = await db
    .from("credit_purchases")
    .update({
      total_minor: net.netMinor,
      total_currency: net.currency,
      order_status: attrs.status ?? null,
    })
    .eq("ls_order_id", orderId);
  if (moneyErr) {
    console.warn("billing.ls.pack_money_stamp_failed", { order: orderId, err: moneyErr.message });
  }

  // Revenue record for the console (Collected to date). payments.user_id is
  // NOT NULL, so a parked pack records revenue only once claimed — claim.ts
  // writes that row at the moment it binds the pack, and 0092 backfills the
  // sales made before it did (a migration that must be APPLIED, present tense:
  // it is what repairs the packs already sold). Duplicate-tolerant like the
  // Stripe path (the unique ls_order_id makes webhook-vs-claim a race nobody
  // can lose).
  //
  // CORRECTION (2026-08-19): this block used to claim the parked path was "the
  // rare fallback" because packs are "sold from inside the app to signed-in
  // paid users". That was FALSE, and it hid a revenue hole for every pack ever
  // sold. The in-app buy chip (dashboard/fair-use-meter.tsx) is a plain
  // <a href> to the LS hosted checkout with NO custom_data, so resolveIdentity
  // never sees a user_id from it — PARKED IS THE ONLY PATH A PACK CAN TAKE
  // today, and this branch effectively never runs. It is kept because an
  // authenticated createLsCheckout pack flow would land here, and because a
  // repeat buyer whose ls_customer_id is already bound resolves as "user".
  if (boundUserId) {
    // Priced through lsRevenueAmount, the SAME function the invoice writer uses,
    // rather than writing LS's raw currency through. payments_currency_check
    // (0023) admits only 'myr' and 'usd', so a pack billed in any other currency
    // used to produce currency:'eur' → 23514 → the warn below → the sale never
    // reached "Collected to date" and nothing retried it. One revenue series had
    // three answers to "a sale in a currency payments cannot hold": this path
    // dropped it, claim.ts's packAmountMinor substituted the catalogue list
    // price, and the invoice writer converted at LS's own rate. Converting is
    // the right one (it is the amount LS itself reports collecting), and the
    // catalogue fallback survives underneath it for an order carrying no usable
    // figure at all — which is exactly what claim.ts would book for the same
    // pack, so both writers now agree in every case.
    //
    // The catalogue fallback is now on the RIGHT side of the tax rule by
    // construction: packs.ts `usd` is a LIST price, which is a net-of-tax
    // figure (LS adds tax on top of it as MoR). Under the old gross policy that
    // fallback quietly understated a taxed sale; it is exact for an
    // undiscounted one now. It still cannot see a discount code — pre-existing,
    // and the reason it is a fallback rather than the price.
    const booked = lsRevenueAmount(net.netMinor, net.currency, net.netUsdMinor) ?? {
      amount: Math.round(pack.usd * 100),
      currency: "usd" as const,
    };
    const { error: payErr } = await db.from("payments").insert({
      user_id: boundUserId,
      school_id: null,
      provider: "lemonsqueezy",
      ls_order_id: orderId,
      amount: booked.amount, // MINOR UNITS, NET of tax (see netOfTax)
      currency: booked.currency,
      plan_key: pack.key,
      status: attrs.status ?? "paid",
    });
    if (payErr && payErr.code !== "23505") {
      // The credits are already granted — a payments hiccup must not make LS
      // retry into a duplicate-looking failure loop. Log loudly instead.
      console.warn("billing.ls.pack_payment_record_failed", { order: orderId, err: payErr.message });
    }
    log("pack_credited", { order: orderId, pack: pack.key, credits: pack.credits, user: boundUserId });
  } else {
    console.warn("billing.ls.pack_parked_unclaimed", { order: orderId, pack: pack.key, email: claimEmail });
  }
}

// ── subscription invoices: ALL subscription revenue (0093) ──────────────────
// THE INVARIANT THIS FUNCTION EXISTS TO PROTECT:
//
//     Subscription revenue is recorded from the INVOICE. Always. Only.
//
// Not from order_created, for any billing_reason, ever. The reason is that LS
// represents the FIRST charge twice and every later charge once:
//   · initial order → order_created + subscription_created + subscription_payment_success
//   · renewal       → subscription_payment_success + subscription_updated  (NO order)
// Verified against the live store on 2026-08-20: order 9261749 and invoice
// 8235804 are the same $11.79 field for field (subtotal 999, tax 180, total
// 1179, USD), and LS files that invoice under that order's own identifier.
// Booking both would double-count month one for every subscriber; booking only
// orders would miss every renewal. Invoices alone cover each charge exactly
// once — which is why handleLsOrderEvent's `order_ignored_not_pack` return is
// CORRECT and must never be "fixed" into a revenue path.
//
// IDEMPOTENCY. The invoice's own id is the only stable identifier on the
// object, and it goes in payments.ls_invoice_id — NOT ls_order_id, because LS
// order ids and invoice ids are separate sequences occupying the same numeric
// space and will eventually collide (0093 section 1 has the live numbers). Four
// different things race for the same row: LS re-delivery, the
// payment_success/payment_recovered pair LS fires for ONE recovered payment,
// claim.ts running on every dashboard render, and 0093's backfill. Every one of
// them is absorbed by 23505 on that unique index.
//
// IDENTITY is the same two-sided shape packs have. The invoice carries
// customer_id and user_email, payments.user_id is NOT NULL, so a public-link
// purchase made while logged out PARKS (subscription_invoices.owner_id NULL,
// claim_email set) and claim.ts writes the payments row the moment it binds.
//
// THIS PATH GRANTS NOTHING — no entitlement, no credit, no cap. Access flows
// only from the subscription object handled above. That is precisely what makes
// it safe for the durable insert below to THROW: a failed
// subscription_payment_success delivery costs a red row in the LS dashboard and
// nothing else, and LS retries. Silence would be the expensive failure here,
// because the amount exists nowhere but Lemon Squeezy.
async function handleLsInvoiceEvent(db: Db, event: LsEvent, name: string): Promise<void> {
  const inv = event.data;
  const attrs = inv?.attributes as LsInvoiceAttributes | undefined;
  const invoiceId = inv?.id;
  if (!attrs || !invoiceId) return;

  const status = (attrs.status ?? "").trim().toLowerCase();
  const subscriptionId = attrs.subscription_id != null ? String(attrs.subscription_id) : null;
  const email = norm(attrs.user_email);
  const lsCustomerId = String(attrs.customer_id);

  // ── refund ────────────────────────────────────────────────────────────────
  // 'partial_refund' is treated as a FULL refund, and that is a known
  // approximation rather than an oversight: collectedUsd() counts only
  // PAID_STATUSES and understands neither 'refunded' nor 'partial_refund', so
  // the real choice is between dropping the whole sale and keeping all of it.
  // Drop it — never overstating collected money is the safe error — and 0093's
  // trailing note records this as a decision to revisit, not a thing nobody saw.
  const refunded =
    name === "subscription_payment_refunded" ||
    attrs.refunded === true ||
    status === "refunded" ||
    status === "partial_refund";
  if (refunded) {
    const now = new Date().toISOString();
    // The DURABLE fact first. A refund that lands while the sale is still
    // parked has no payments row to stamp, and without this column the claim
    // would later book returned money as collected with nothing left to correct
    // it — the exact ordering hole 0092 had to repair for packs.
    // recordSubscriptionRevenue (claim.ts) reads this and only this.
    const { error: stampErr } = await db
      .from("subscription_invoices")
      .update({ refunded_at: now, invoice_status: attrs.status ?? "refunded" })
      .eq("ls_invoice_id", invoiceId);
    if (stampErr) console.warn("billing.ls.invoice_refund_stamp_failed", { invoice: invoiceId, err: stampErr.message });
    const { error: payErr } = await db.from("payments").update({ status: "refunded" }).eq("ls_invoice_id", invoiceId);
    if (payErr) console.warn("billing.ls.invoice_refund_payment_failed", { invoice: invoiceId, err: payErr.message });
    // Refund-before-create race, handled exactly as the pack path handles it:
    // if the payment_success delivery failed and LS is still retrying it, there
    // was no row for the update above to stamp — and the retried payload
    // (frozen at "paid") would later insert an un-refunded invoice. A refunded
    // TOMBSTONE occupies the unique ls_invoice_id so that retry 23505-no-ops.
    // Parked by email; ownership is irrelevant to the REVENUE because a
    // refunded invoice is never booked. In the normal order this insert IS the
    // 23505 no-op.
    //
    // …except that "park it by email" silently assumes there IS an email.
    // subscription_invoices_attributable (0093 §2) requires owner_id OR
    // claim_email to be non-null, and norm() returns null for an absent or
    // blank user_email — LS already sends user_name "" on the live object, so a
    // blank email is not unthinkable. Both null violates the CHECK with 23514,
    // which is NOT 23505, so it would fall through to a console.warn and the
    // tombstone would simply not exist: the refund would leave no durable trace
    // at all, and the retried success delivery would then insert a fresh
    // un-refunded row and book returned money as collected. Fall back to the
    // bound owner (the ls_customer_id ↔ user_id mapping this same webhook
    // maintains) so the row is always attributable, and refuse to write a row
    // that cannot satisfy the constraint rather than emitting a violation.
    let tombOwner: string | null = null;
    if (!email) {
      const { data: cust } = await db
        .from("billing_customers")
        .select("user_id")
        .eq("ls_customer_id", lsCustomerId)
        .maybeSingle();
      tombOwner = (cust?.user_id as string | null) ?? null;
    }
    if (!email && !tombOwner) {
      // ALERT: a refund we cannot attribute. The stamps above already corrected
      // any existing rows; what is lost is only the refund-before-create guard,
      // and 0093's reconcile UPDATE is the standing repair.
      console.warn("billing.ls.invoice_refund_tombstone_unattributable", { invoice: invoiceId, subscription: subscriptionId });
    } else {
      const { error: tombErr } = await db.from("subscription_invoices").insert({
        owner_id: tombOwner,
        claim_email: email,
        provider: "lemonsqueezy",
        ls_invoice_id: invoiceId,
        ls_subscription_id: subscriptionId,
        billing_reason: attrs.billing_reason ?? null,
        invoice_status: attrs.status ?? "refunded",
        refunded_at: now,
      });
      if (tombErr && tombErr.code !== "23505") {
        console.warn("billing.ls.invoice_refund_tombstone_failed", { invoice: invoiceId, err: tombErr.message });
      }
    }
    log("invoice_refunded", { invoice: invoiceId, subscription: subscriptionId, event: name });
    return;
  }

  const who = await resolveIdentity(db, event.meta?.custom_data, lsCustomerId, email);
  if (who.kind === "refused") return; // money stays reconcilable in LS; never guess an owner
  const boundUserId = who.kind === "user" ? who.userId : null;
  const claimEmail = who.kind === "unclaimed" ? who.email : null;

  // plan_key HAS to come from the stored subscription: an invoice carries no
  // variant_id, product_id or product_name at all. LS's documented order sends
  // subscription_created BEFORE subscription_payment_success so the row is
  // normally there — but delivery order is not guaranteed, and when it is
  // missing the money is recorded anyway with plan_key NULL. Revenue stays
  // correct; only MRR attribution is lost. Blocking on it would trade a
  // reporting detail for a retry loop on a real payment.
  let planKey: string | null = null;
  if (subscriptionId) {
    const { data: row } = await db
      .from("subscriptions")
      .select("plan_key")
      .eq("ls_subscription_id", subscriptionId)
      .maybeSingle();
    planKey = (row?.plan_key as string | null) ?? null;
  }
  if (!planKey) {
    log("invoice_plan_unresolved", { invoice: invoiceId, subscription: subscriptionId }); // revenue right, MRR attribution lost
  }

  // THE DURABLE RECORD — the thing subscriptions have never had, and the only
  // reason a parked sale can be recorded later at all. public.subscriptions
  // carries no amount, no currency and no order id, and webhook_events keeps no
  // payload, so before 0093 an invoice's collected amount lived nowhere outside
  // Lemon Squeezy. A failure here THROWS (see the header): this event grants
  // nothing, so a retry is free and silence is not.
  //
  // NET OF TAX, and the durable record stores it that way so claim.ts and
  // 0093's backfill inherit the policy instead of each re-deciding it. Invoice
  // 8235804 is subtotal 999 / tax 180 / total 1179 and this row carries 999:
  // the $1.80 IGST is LS's to remit, and by the founder's decision it is
  // discarded here rather than kept in a column nobody may add.
  const net = lsNetOfTax(attrs);
  const money = {
    total_minor: net.netMinor,
    total_currency: net.currency,
    total_usd_minor: net.netUsdMinor,
    invoice_status: attrs.status ?? null,
  };
  const { error: invErr } = await db.from("subscription_invoices").insert({
    owner_id: boundUserId, // NULL while parked
    claim_email: claimEmail, // set only while parked
    provider: "lemonsqueezy",
    ls_invoice_id: invoiceId,
    ls_subscription_id: subscriptionId,
    plan_key: planKey,
    billing_reason: attrs.billing_reason ?? null,
    ...money,
    test_mode: attrs.test_mode ?? null,
    invoiced_at: attrs.created_at ?? null,
    refunded_at: null,
  });
  if (invErr && invErr.code !== "23505") {
    throw new Error(`LS subscription invoice insert failed: ${invErr.message}`);
  }
  // NOT a `return` on 23505, deliberately. LS's recovered-payment flow delivers
  // subscription_payment_failed first (status "pending", no revenue row) and
  // subscription_payment_success later carrying the SAME invoice id, so the
  // second delivery has to be able to refresh the stored status and finally
  // book the money. Its own best-effort statement, for the same reason the pack
  // path separates its money stamp: bookkeeping must never fail a delivery.
  if (invErr) {
    // …BUT THE ROW THAT WON THE KEY MAY BE A REFUND TOMBSTONE, and this is the
    // one place a refund can be undone. The refund branch above writes
    // refunded_at onto a row that may not exist yet (refund delivered before
    // the success it refunds — LS guarantees no delivery order, which is why
    // the monotonicity gate above exists at all). When the success finally
    // lands it finds that tombstone, 23505s into this branch, and — before
    // this check — refreshed invoice_status back to 'paid' and inserted a
    // brand-new payments row at status 'paid' for money that had already been
    // given back. Nothing downstream corrects it: the refund event is long
    // processed, and payments.status='refunded' is stamped BY ls_invoice_id on
    // a row that did not exist when the refund ran. Only re-running 0093's
    // reconcile UPDATE would find it.
    //
    // The pack path cannot hit this because handleLsOrderEvent RETURNS on
    // 23505 (it has nothing to refresh); this writer must not return, because
    // the recovered-payment flow legitimately re-delivers the same invoice id
    // to move it from 'pending' to 'paid'. So the discriminator has to be the
    // durable refund fact itself — refunded_at, the same column claim.ts's
    // recordSubscriptionRevenue reads and 0093's reconcile keys on. Read it
    // back rather than trusting the payload: THIS payload says "paid" (it is a
    // _success event), and the refund is knowable only from the stored row.
    const { data: existing } = await db
      .from("subscription_invoices")
      .select("refunded_at")
      .eq("ls_invoice_id", invoiceId)
      .maybeSingle();
    if ((existing?.refunded_at as string | null) ?? null) {
      // Deliberately no refresh either: overwriting invoice_status with 'paid'
      // would leave the durable record self-contradicting (refunded_at set,
      // status 'paid'), and the money columns are already whatever the refunded
      // delivery recorded. Returned money is not revenue; leave the row alone.
      log("invoice_refunded_not_booked", { invoice: invoiceId, subscription: subscriptionId, event: name });
      return;
    }
    const { error: refreshErr } = await db
      .from("subscription_invoices")
      .update({ plan_key: planKey, ...money })
      .eq("ls_invoice_id", invoiceId);
    if (refreshErr) console.warn("billing.ls.invoice_refresh_failed", { invoice: invoiceId, err: refreshErr.message });
  }

  // ── the revenue row ───────────────────────────────────────────────────────
  // ONLY a paid invoice is collected money. LS's other statuses are 'pending'
  // (a delayed payment method: nothing collected yet) and 'void'. Writing a
  // 'pending' row would be strictly worse than writing none — the later success
  // event carries the SAME invoice id, so its insert would 23505 into a no-op
  // and the row would sit at 'pending' forever while real money never counted.
  // Skipping lets that success event insert cleanly, first try.
  if (status && status !== "paid") {
    log("invoice_not_collected", { invoice: invoiceId, status, event: name });
    return;
  }
  if (attrs.test_mode === true) {
    // A test-mode charge is not money. The pack path has no such guard, and
    // three test-mode pack rows are inflating the console total by $24 today —
    // flagged in 0093 rather than silently repeated here. In practice LS routes
    // test events to test-mode webhooks, so this is cheap insurance rather than
    // a behavioural fork between the two writers.
    log("invoice_test_mode_not_booked", { invoice: invoiceId, subscription: subscriptionId });
    return;
  }
  if (!boundUserId) {
    // Not an error — the sale is durably recorded above and books its revenue
    // the moment claim.ts binds it. Alert-tier so ops can see paid-but-
    // unclaimed subscribers.
    console.warn("billing.ls.invoice_parked_unclaimed", { invoice: invoiceId, email: claimEmail, plan: planKey });
    return;
  }
  // The SAME net figures already stamped on the durable row above — read from
  // `net`, never re-derived from attrs, so the two can never drift apart.
  const booked = lsRevenueAmount(net.netMinor, net.currency, net.netUsdMinor);
  if (!booked) {
    console.warn("billing.ls.invoice_no_amount", { invoice: invoiceId, currency: attrs.currency ?? null });
    return;
  }
  const { error: payErr } = await db.from("payments").insert({
    user_id: boundUserId,
    school_id: null, // LS subscriptions are personal (B2C) — never school-scoped
    provider: "lemonsqueezy",
    ls_invoice_id: invoiceId,
    amount: booked.amount, // MINOR UNITS, NET of tax (see netOfTax)
    currency: booked.currency,
    plan_key: planKey,
    status: "paid", // the guard above admits nothing else
    // Dated to the INVOICE, never to now(): "Collected to date" is a time
    // series, so a replayed or late-claimed invoice must land in the month the
    // money was actually taken. 0093's backfill and claim.ts copy the same field.
    ...(attrs.created_at ? { created_at: attrs.created_at } : {}),
  });
  if (payErr) {
    if (payErr.code === "23505") {
      log("invoice_duplicate_payment", { invoice: invoiceId }); // re-delivery, the recovered pair, or the claim got there first
      return;
    }
    // The durable invoice row is already written and 0093's backfill is
    // re-runnable, so this is recoverable without a retry storm. Log loudly.
    console.warn("billing.ls.invoice_payment_record_failed", { invoice: invoiceId, err: payErr.message });
    return;
  }
  log("invoice_revenue_recorded", {
    invoice: invoiceId,
    subscription: subscriptionId,
    plan: planKey,
    reason: attrs.billing_reason ?? null,
    amount: booked.amount,
    currency: booked.currency,
    user: boundUserId,
  });
}
