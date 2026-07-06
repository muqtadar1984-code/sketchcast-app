// Lemon Squeezy webhook handlers — pure-ish and testable (DB injected). LS
// SUBSCRIPTION events are the single driver of the provider-agnostic
// `entitlements` table for B2C plans; the app reads that table regardless of
// provider. Parent/teacher plans are personal, so their entitlement/customer
// rows carry school_id = NULL (invisible to a school admin, like personal
// Stripe plans).
//
// IDENTITY: the LS webhook signature proves the payload came from LS, and the
// custom_data (user_id, plan_key) is what WE set at checkout — so on the first
// event we trust it and store the ls_customer_id ↔ user_id mapping. Every later
// event (renewals may omit custom_data) is resolved via that stored mapping and
// cross-checked against any custom_data present — a mismatch is refused.

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
  renews_at: string | null;
  ends_at: string | null;
  updated_at?: string | null; // LS's own timestamp — monotonicity gate
  urls?: { customer_portal?: string | null } | null;
};

export type LsEvent = {
  meta?: { event_name?: string; custom_data?: { user_id?: string; plan_key?: string } | null } | null;
  data?: { type?: string; id?: string; attributes?: LsSubscriptionAttributes } | null;
};

// Statuses that keep access. `cancelled` keeps access until ends_at (grace) —
// deriveActive() flips it off once ends_at passes. paused/unpaid/expired = no
// access.
const ACTIVE_LS_STATUSES = ["on_trial", "active", "past_due", "cancelled"];

function log(kind: string, detail: Record<string, unknown>) {
  console.log(`billing.ls.${kind}`, detail);
}

async function resolveIdentity(
  db: Db,
  customData: { user_id?: string } | null | undefined,
  lsCustomerId: string,
): Promise<{ userId: string; isNew: boolean } | null> {
  const claimed = customData?.user_id;
  const { data: row } = await db
    .from("billing_customers")
    .select("user_id")
    .eq("ls_customer_id", lsCustomerId)
    .maybeSingle();
  if (row) {
    if (claimed && row.user_id !== claimed) {
      log("identity_mismatch", { ls_customer: lsCustomerId, claimed_user: claimed });
      return null;
    }
    return { userId: row.user_id as string, isNew: false };
  }
  if (claimed) return { userId: claimed, isNew: true };
  log("identity_unresolved", { ls_customer: lsCustomerId });
  return null;
}

async function resolvePlanKey(db: Db, lsSubscriptionId: string, customData: { plan_key?: string } | null | undefined): Promise<string | null> {
  if (customData?.plan_key) return customData.plan_key;
  const { data: row } = await db
    .from("subscriptions")
    .select("plan_key")
    .eq("ls_subscription_id", lsSubscriptionId)
    .maybeSingle();
  return (row?.plan_key as string | null) ?? null;
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

export async function handleLsEvent(db: Db, event: LsEvent): Promise<void> {
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
  const who = await resolveIdentity(db, event.meta?.custom_data, lsCustomerId);
  if (!who) return;

  const planKey = await resolvePlanKey(db, subId, event.meta?.custom_data);
  if (!planKey) {
    log("no_plan_key", { subscription: subId });
    return;
  }

  // MONOTONICITY GATE: LS delivery can be out of order, and each state has a
  // distinct idempotency key (updated_at is in the key), so a stale
  // "active" arriving AFTER "expired" would otherwise re-grant access. Compare
  // the incoming updated_at against the stored one and skip anything older.
  const incomingTs = attrs.updated_at ?? null;
  const { data: existingSub } = await db
    .from("subscriptions")
    .select("provider_updated_at")
    .eq("ls_subscription_id", subId)
    .maybeSingle();
  const storedTs = (existingSub?.provider_updated_at as string | null) ?? null;
  if (incomingTs && storedTs && new Date(incomingTs).getTime() < new Date(storedTs).getTime()) {
    log("stale_event_skipped", { subscription: subId, incoming: incomingTs, stored: storedTs });
    return;
  }

  // First sight of this customer → store the mapping (+ portal URL). A unique
  // violation here (e.g. the same LS customer racing to two of our accounts)
  // must ABORT — never proceed to grant with no stored mapping. Failing the
  // event makes LS retry, by which point the winning row is committed.
  if (who.isNew) {
    const { error: mapErr } = await db.from("billing_customers").upsert(
      {
        user_id: who.userId,
        school_id: null,
        provider: "lemonsqueezy",
        ls_customer_id: lsCustomerId,
        ls_customer_portal_url: attrs.urls?.customer_portal ?? null,
        stripe_customer_id: null,
        role: "", // snapshot; unknown from the webhook — left blank
      },
      { onConflict: "user_id,provider" },
    );
    if (mapErr) throw new Error(`LS customer mapping failed (possible ls_customer_id conflict): ${mapErr.message}`);
  } else if (attrs.urls?.customer_portal) {
    // Refresh the (24h-expiring) portal URL opportunistically.
    await db.from("billing_customers").upsert(
      { user_id: who.userId, provider: "lemonsqueezy", ls_customer_id: lsCustomerId, ls_customer_portal_url: attrs.urls.customer_portal },
      { onConflict: "user_id,provider" },
    );
  }

  // Access mapping. `cancelled` keeps access until ends_at (grace) — but a
  // cancelled subscription with NO ends_at has no grace window, so it must read
  // inactive rather than being granted forever (deriveActive treats a null
  // period-end as "no expiry").
  const cancelledOrExpired = attrs.status === "cancelled" || attrs.status === "expired";
  const periodEnd = (cancelledOrExpired ? attrs.ends_at : attrs.renews_at) ?? null;
  const active =
    ACTIVE_LS_STATUSES.includes(attrs.status) && !(attrs.status === "cancelled" && periodEnd === null);

  await db.from("subscriptions").upsert(
    {
      user_id: who.userId,
      school_id: null,
      provider: "lemonsqueezy",
      ls_subscription_id: subId,
      stripe_subscription_id: null,
      plan_key: planKey,
      status: attrs.status,
      current_period_end: periodEnd,
      cancel_at_period_end: attrs.status === "cancelled",
      provider_updated_at: incomingTs,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "ls_subscription_id" },
  );

  await upsertEntitlement(db, {
    userId: who.userId,
    active,
    planKey,
    status: attrs.status,
    currentPeriodEnd: periodEnd,
  });
  log("subscription_synced", { subscription: subId, status: attrs.status, event: name });
}
