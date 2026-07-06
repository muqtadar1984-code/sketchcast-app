// Stripe webhook event handlers — pure-ish and testable: the Supabase service
// client and (where needed) the Stripe client are INJECTED so tests can stub
// them. Every handler converges on `entitlements`, the single source of truth
// the app reads for paid access.
//
// SECURITY INVARIANT: tenant/user come from the Stripe object's metadata that
// WE set at session creation, and are CROSS-CHECKED against the stored
// billing_customers mapping for the Stripe customer on the object. A mismatch
// is logged and skipped — we never unlock anyone from data a client could
// have influenced.

import type Stripe from "stripe";
import { ONETIME_LICENCE_DAYS } from "./plans";

// Minimal shape of the Supabase client we use (stub-friendly). PromiseLike so
// supabase-js's thenable builders satisfy it; the route casts its real client
// through `unknown` to avoid excessively-deep generic instantiation.
export type Db = {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        v: unknown,
      ): {
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null }>;
      };
    };
    upsert(
      row: Record<string, unknown>,
      opts?: { onConflict?: string },
    ): PromiseLike<{ error: { message: string } | null }>;
    insert(row: Record<string, unknown>): PromiseLike<{ error: { code?: string; message: string } | null }>;
  };
};

type Meta = { user_id?: string; school_id?: string; plan_key?: string };

/** Statuses that keep access. `past_due` keeps access (grace) — Stripe moves
 * the subscription to canceled/unpaid when dunning gives up. */
const ACTIVE_STATUSES = ["active", "trialing", "past_due"];

function log(kind: string, detail: Record<string, unknown>) {
  // Structured, PII-free: Stripe IDs, event types, and statuses only.
  console.log(`billing.webhook.${kind}`, detail);
}

/** metadata → verified {userId, schoolId}. SECURITY: the Stripe customer on
 * the object must map (in billing_customers) to the same user_id the metadata
 * claims — that cross-check is what stops a forged/mis-metadata'd object from
 * unlocking someone else. ATTRIBUTION: schoolId comes from the object's
 * metadata, which WE set at session creation to the PLAN's school (null for
 * personal plans) — never the possibly-stale billing_customers snapshot. */
async function verifiedIdentity(
  db: Db,
  meta: Meta | null | undefined,
  stripeCustomerId: string | null,
): Promise<{ userId: string; schoolId: string | null } | null> {
  const userId = meta?.user_id;
  if (!userId || !stripeCustomerId) return null;
  const { data: row } = await db
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();
  if (!row || row.user_id !== userId) {
    log("identity_mismatch", { customer: stripeCustomerId, claimed_user: userId });
    return null;
  }
  const schoolId = (meta?.school_id ?? "").trim() || null;
  return { userId, schoolId };
}

async function upsertEntitlement(
  db: Db,
  args: {
    userId: string;
    schoolId: string | null;
    active: boolean;
    planKey: string;
    status: string | null;
    currentPeriodEnd: string | null;
  },
): Promise<void> {
  // Per-(user, plan): one adult may hold two concurrent plans, so keying per
  // user would let one plan's webhook clobber the other's.
  const { error } = await db.from("entitlements").upsert(
    {
      user_id: args.userId,
      school_id: args.schoolId,
      active: args.active,
      plan_key: args.planKey,
      status: args.status,
      current_period_end: args.currentPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,plan_key" },
  );
  if (error) throw new Error(`entitlement upsert failed: ${error.message}`);
  log("entitlement", { user: args.userId, active: args.active, plan: args.planKey, status: args.status });
}

function periodEndOf(sub: Stripe.Subscription): string | null {
  // API-version drift tolerance: current_period_end moved onto items in newer
  // versions; accept either shape.
  const direct = (sub as unknown as { current_period_end?: number }).current_period_end;
  const viaItem = sub.items?.data?.[0]
    ? (sub.items.data[0] as unknown as { current_period_end?: number }).current_period_end
    : undefined;
  const ts = direct ?? viaItem;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function syncSubscription(db: Db, sub: Stripe.Subscription): Promise<void> {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const who = await verifiedIdentity(db, sub.metadata as Meta, customer);
  if (!who) return;

  const planKey = (sub.metadata as Meta)?.plan_key ?? null;
  if (!planKey) {
    // No plan attribution — can't key an entitlement; record nothing rather
    // than write an unattributable row.
    log("subscription_no_plan", { subscription: sub.id });
    return;
  }
  const periodEnd = periodEndOf(sub);
  const { error } = await db.from("subscriptions").upsert(
    {
      user_id: who.userId,
      school_id: who.schoolId,
      stripe_subscription_id: sub.id,
      plan_key: planKey,
      status: sub.status,
      current_period_end: periodEnd,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_subscription_id" },
  );
  if (error) throw new Error(`subscription upsert failed: ${error.message}`);

  await upsertEntitlement(db, {
    userId: who.userId,
    schoolId: who.schoolId,
    active: ACTIVE_STATUSES.includes(sub.status),
    planKey,
    status: sub.status,
    currentPeriodEnd: periodEnd,
  });
}

export async function handleStripeEvent(
  db: Db,
  stripeClient: Pick<Stripe, "subscriptions">,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const customer = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
      const who = await verifiedIdentity(db, session.metadata as Meta, customer);
      if (!who) return;
      const planKey = (session.metadata as Meta)?.plan_key ?? null;
      if (!planKey) {
        log("checkout_no_plan", { session: session.id });
        return;
      }

      if (session.mode === "payment") {
        // One-off school licence: record the payment (MYR-asserted) and open
        // the licence window.
        const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
        const currency = (session.currency || "").toLowerCase();
        if (currency !== "myr") {
          log("non_myr_payment_skipped", { session: session.id, currency });
          return;
        }
        if (pi) {
          const { error } = await db.from("payments").insert({
            user_id: who.userId,
            school_id: who.schoolId,
            stripe_payment_intent_id: pi,
            amount: session.amount_total ?? 0,
            currency: "myr",
            plan_key: planKey,
            status: session.payment_status ?? "paid",
          });
          if (error && error.code !== "23505") throw new Error(`payment insert failed: ${error.message}`);
        }
        const end = new Date(Date.now() + ONETIME_LICENCE_DAYS * 86400000).toISOString();
        await upsertEntitlement(db, {
          userId: who.userId,
          schoolId: who.schoolId,
          active: true,
          planKey,
          status: "paid",
          currentPeriodEnd: end,
        });
      } else if (session.subscription) {
        // Subscription checkout: sync the subscription now rather than waiting
        // for the (possibly out-of-order) subscription.created event.
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const sub = await stripeClient.subscriptions.retrieve(subId);
        await syncSubscription(db, sub as Stripe.Subscription);
      }
      log("checkout_completed", { session: session.id, mode: session.mode });
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // Re-fetch the LIVE subscription rather than trusting a possibly
      // out-of-order event payload — a stale `updated(active)` arriving after
      // `deleted` must not re-grant access. (A deleted sub retrieves as
      // canceled.) Fall back to the payload if the re-fetch fails.
      const payload = event.data.object as Stripe.Subscription;
      let sub = payload;
      try {
        sub = (await stripeClient.subscriptions.retrieve(payload.id)) as Stripe.Subscription;
        // retrieve() drops the metadata we rely on if it wasn't expanded — keep
        // the payload's metadata when the live object lacks it.
        if (!(sub.metadata as Meta)?.plan_key && (payload.metadata as Meta)?.plan_key) {
          sub = { ...sub, metadata: payload.metadata } as Stripe.Subscription;
        }
      } catch (e) {
        log("subscription_refetch_failed", { subscription: payload.id, err: (e as Error).message });
      }
      await syncSubscription(db, sub);
      return;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      // Extend entitlement by re-syncing the subscription from Stripe (shape
      // of invoice.subscription varies across API versions — tolerate both).
      const inv = invoice as unknown as {
        subscription?: string | { id: string } | null;
        parent?: { subscription_details?: { subscription?: string | null } | null } | null;
      };
      const subId =
        (typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id) ??
        inv.parent?.subscription_details?.subscription ??
        null;
      if (subId) {
        const sub = await stripeClient.subscriptions.retrieve(subId);
        await syncSubscription(db, sub as Stripe.Subscription);
      }
      log("invoice_paid", { invoice: invoice.id, subscription: subId });
      return;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // Resolve the failing SUBSCRIPTION so we flag the right plan's
      // entitlement (per-plan keying). Flag past_due; DO NOT revoke — grace is
      // governed by the subscription status transitions (canceled/unpaid
      // arrive via subscription.updated/deleted).
      const inv = invoice as unknown as {
        subscription?: string | { id: string } | null;
        parent?: { subscription_details?: { subscription?: string | null } | null } | null;
      };
      const subId =
        (typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id) ??
        inv.parent?.subscription_details?.subscription ??
        null;
      if (!subId) {
        log("invoice_payment_failed_no_sub", { invoice: invoice.id });
        return;
      }
      let sub: Stripe.Subscription;
      try {
        sub = (await stripeClient.subscriptions.retrieve(subId)) as Stripe.Subscription;
      } catch (e) {
        log("invoice_failed_refetch_failed", { subscription: subId, err: (e as Error).message });
        return;
      }
      const who = await verifiedIdentity(db, sub.metadata as Meta, typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null);
      const planKey = (sub.metadata as Meta)?.plan_key ?? null;
      if (!who || !planKey) return;
      await upsertEntitlement(db, {
        userId: who.userId,
        schoolId: who.schoolId,
        active: ["active", "trialing", "past_due"].includes(sub.status), // keep grace
        planKey,
        status: "past_due",
        currentPeriodEnd: periodEndOf(sub),
      });
      log("invoice_payment_failed", { invoice: invoice.id, subscription: subId });
      return;
    }

    default:
      log("ignored", { type: event.type, id: event.id });
  }
}
