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

export type Db = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: unknown): {
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null }>;
      };
    };
    upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
    insert(row: Record<string, unknown>): PromiseLike<{ error: { code?: string; message: string } | null }>;
  };
};

type LsSubscriptionAttributes = {
  status: string; // on_trial|active|paused|past_due|unpaid|cancelled|expired
  customer_id: number | string;
  variant_id?: number | string | null; // identifies WHICH product/cycle was bought
  product_id?: number | string | null;
  user_email?: string | null; // buyer email — the only identity signal on a public-link purchase
  user_name?: string | null;
  order_id?: number | string | null; // to look up the applied discount (founding)
  renews_at: string | null;
  ends_at: string | null;
  updated_at?: string | null; // LS's own timestamp — monotonicity gate
  urls?: { customer_portal?: string | null } | null;
};

export type LsEvent = {
  meta?: { event_name?: string; custom_data?: { user_id?: string; plan_key?: string } | null } | null;
  data?: { type?: string; id?: string; attributes?: LsSubscriptionAttributes } | null;
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
  if (!name.startsWith("subscription")) {
    log("ignored", { event: name });
    return;
  }
  const sub = event.data;
  // The `subscription_*` family includes invoice-shaped events
  // (subscription_payment_success/failed/refunded), whose `data.type` is
  // "subscription-invoices" and whose `status` is "paid"/"refunded" — NOT a
  // subscription lifecycle status. Drive entitlements ONLY from the actual
  // subscription object, or an invoice's "paid" would be read as "not active"
  // and wrongly revoke access. Payment health already flows through
  // subscription_updated (past_due/unpaid).
  if (sub?.type && sub.type !== "subscriptions") {
    log("ignored_non_subscription_object", { event: name, type: sub.type });
    return;
  }
  const attrs = sub?.attributes;
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
    .select("provider_updated_at, user_id")
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
