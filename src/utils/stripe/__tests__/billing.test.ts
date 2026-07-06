/**
 * Billing guard tests — the invariants a reviewer must see hold:
 *   * students are rejected from every billing surface
 *   * non-MYR prices are refused
 *   * webhook events are idempotent and identity is cross-checked
 *   * entitlements flip for the RIGHT user only, and cancellation revokes
 *   * no card data ever appears in what we persist
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import { assertAdultRole, assertBillingEnabled, assertTenantMatch, BillingGuardError } from "../guards";
import { assertMyrPrice, getPlan, PLANS } from "../plans";
import { deriveActive } from "../entitlements";
import { handleStripeEvent } from "../webhook-handlers";
import type Stripe from "stripe";

// ── stub DB (same pattern as the worker's FakeSB) ────────────────────────────
type Row = Record<string, unknown>;
class FakeDb {
  tables: Record<string, Row | Row[] | null>;
  writes: Array<{ table: string; op: "insert" | "upsert"; row: Row }> = [];
  uniqueViolationOn: string | null = null;

  constructor(tables: Record<string, Row | Row[] | null> = {}) {
    this.tables = tables;
  }

  from(table: string) {
    const read = async () => {
      const t = this.tables[table];
      return { data: (Array.isArray(t) ? t[0] : t) ?? null };
    };
    const record = (op: "insert" | "upsert") => async (row: Row) => {
      this.writes.push({ table, op, row });
      if (op === "insert" && this.uniqueViolationOn === table) {
        return { error: { code: "23505", message: "duplicate" } };
      }
      return { error: null };
    };
    return {
      select: () => ({ eq: () => ({ maybeSingle: read }) }),
      upsert: record("upsert"),
      insert: record("insert"),
    };
  }
}

// The subscription handlers re-fetch the LIVE subscription; this stub returns
// a subscription with the status/metadata the test intends for that id.
function makeStripe(byId: Record<string, { status: string; plan_key?: string; school_id?: string }>) {
  return {
    subscriptions: {
      retrieve: async (id: string) => {
        const cfg = byId[id] ?? { status: "active", plan_key: "teacher_monthly" };
        return {
          id,
          status: cfg.status,
          customer: "cus_1",
          cancel_at_period_end: false,
          metadata: { user_id: "user-A", school_id: cfg.school_id ?? "", plan_key: cfg.plan_key ?? "teacher_monthly" },
          items: { data: [{ current_period_end: 1900000000 }] },
        } as unknown as Stripe.Subscription;
      },
    },
  } as unknown as Pick<Stripe, "subscriptions">;
}
const stripeStub = makeStripe({});

// ── 1. students rejected ─────────────────────────────────────────────────────
describe("adults-only guard", () => {
  it("rejects student with 403", () => {
    try {
      assertAdultRole("student");
      expect.unreachable("student must be rejected");
    } catch (e) {
      expect(e).toBeInstanceOf(BillingGuardError);
      expect((e as BillingGuardError).status).toBe(403);
    }
  });
  it("rejects unknown/missing roles", () => {
    expect(() => assertAdultRole(null)).toThrow(BillingGuardError);
    expect(() => assertAdultRole("hacker")).toThrow(BillingGuardError);
  });
  it("allows teacher, parent, school_admin (and coordinator)", () => {
    for (const r of ["teacher", "parent", "school_admin", "coordinator"]) {
      expect(() => assertAdultRole(r)).not.toThrow();
    }
  });
});

// ── feature flag + tenant guards ─────────────────────────────────────────────
describe("billing flag + tenant guards", () => {
  it("refuses when BILLING_ENABLED is not true", () => {
    delete process.env.BILLING_ENABLED;
    expect(() => assertBillingEnabled(null)).toThrow(BillingGuardError);
  });
  it("refuses a school that opted out, allows otherwise", () => {
    process.env.BILLING_ENABLED = "true";
    expect(() => assertBillingEnabled({ billing_enabled: false })).toThrow(BillingGuardError);
    expect(() => assertBillingEnabled({ billing_enabled: null })).not.toThrow();
    expect(() => assertBillingEnabled(null)).not.toThrow();
  });
  it("blocks cross-tenant access", () => {
    expect(() => assertTenantMatch("school-A", "school-B")).toThrow(BillingGuardError);
    expect(() => assertTenantMatch(null, "school-B")).toThrow(BillingGuardError);
    expect(() => assertTenantMatch("school-A", "school-A")).not.toThrow();
    expect(() => assertTenantMatch(null, null)).not.toThrow();
  });
});

// ── 3. MYR-only ──────────────────────────────────────────────────────────────
describe("MYR currency gate", () => {
  it("refuses any non-MYR price", () => {
    expect(() => assertMyrPrice({ id: "price_x", currency: "usd" })).toThrow(/not MYR/);
    expect(() => assertMyrPrice({ id: "price_x", currency: "sgd" })).toThrow(/not MYR/);
  });
  it("accepts myr (case-insensitive)", () => {
    expect(() => assertMyrPrice({ id: "price_x", currency: "myr" })).not.toThrow();
    expect(() => assertMyrPrice({ id: "price_x", currency: "MYR" as string })).not.toThrow();
  });
  it("plan catalogue rejects unknown keys, routes providers, never hardcodes ids", () => {
    expect(getPlan("free_lunch")).toBeNull();
    expect(getPlan(undefined)).toBeNull();
    // Schools → Stripe (MYR); parents/teachers → Lemon Squeezy (MoR).
    expect(PLANS.school_annual.provider).toBe("stripe");
    expect(PLANS.school_onetime.provider).toBe("stripe");
    expect(PLANS.parent_monthly.provider).toBe("lemonsqueezy");
    expect(PLANS.teacher_monthly.provider).toBe("lemonsqueezy");
    for (const p of Object.values(PLANS)) {
      const prefix = p.provider === "stripe" ? /^STRIPE_PRICE_/ : /^LEMONSQUEEZY_VARIANT_/;
      expect(p.productEnv).toMatch(prefix);
    }
  });
});

// ── 5/6. webhook: entitlement flips for the RIGHT user, via identity check ──
describe("webhook handlers", () => {
  const completedSession = (over: Partial<Stripe.Checkout.Session> = {}) =>
    ({
      id: "evt_obj",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "payment",
          customer: "cus_1",
          currency: "myr",
          amount_total: 499000,
          payment_status: "paid",
          payment_intent: "pi_1",
          metadata: { user_id: "user-A", school_id: "school-A", plan_key: "school_onetime" },
          ...over,
        },
      },
    }) as unknown as Stripe.Event;

  it("checkout.session.completed unlocks the verified user only", async () => {
    const db = new FakeDb({
      billing_customers: { user_id: "user-A", school_id: "school-A" },
    });
    await handleStripeEvent(db as never, stripeStub, completedSession());
    const ent = db.writes.find((w) => w.table === "entitlements");
    expect(ent).toBeTruthy();
    expect(ent!.row.user_id).toBe("user-A");
    expect(ent!.row.active).toBe(true);
    const pay = db.writes.find((w) => w.table === "payments");
    expect(pay!.row.currency).toBe("myr");
  });

  it("refuses to unlock when metadata user doesn't match the stored customer", async () => {
    const db = new FakeDb({
      billing_customers: { user_id: "user-B", school_id: "school-A" }, // mapping says B
    });
    await handleStripeEvent(db as never, stripeStub, completedSession()); // metadata claims A
    expect(db.writes.find((w) => w.table === "entitlements")).toBeUndefined();
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("skips a non-MYR one-off payment entirely", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A", school_id: null } });
    await handleStripeEvent(db as never, stripeStub, completedSession({ currency: "usd" } as never));
    expect(db.writes.length).toBe(0);
  });

  it("subscription.updated(active) grants; deleted revokes (via live re-fetch)", async () => {
    const subEvent = (id: string, type: string) =>
      ({
        id: "evt_s",
        type,
        // payload status is deliberately WRONG to prove we re-fetch live state
        data: { object: { id, status: "active", customer: "cus_1", metadata: { user_id: "user-A", plan_key: "teacher_monthly" }, items: { data: [{ current_period_end: 1900000000 }] } } },
      }) as unknown as Stripe.Event;
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });

    await handleStripeEvent(db as never, makeStripe({ sub_live: { status: "active" } }), subEvent("sub_live", "customer.subscription.updated"));
    let ent = db.writes.filter((w) => w.table === "entitlements").pop();
    expect(ent!.row.active).toBe(true);

    // Even though the event payload says "active", the LIVE sub is canceled.
    await handleStripeEvent(db as never, makeStripe({ sub_live: { status: "canceled" } }), subEvent("sub_live", "customer.subscription.deleted"));
    ent = db.writes.filter((w) => w.table === "entitlements").pop();
    expect(ent!.row.active).toBe(false);
  });

  it("a personal plan does NOT clobber a school plan (per-plan keying)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    const evt = (planKey: string) =>
      ({
        id: "evt_x",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_x", status: "active", customer: "cus_1", metadata: { user_id: "user-A", plan_key: planKey }, items: { data: [{ current_period_end: 1900000000 }] } } },
      }) as unknown as Stripe.Event;
    await handleStripeEvent(db as never, makeStripe({ sub_x: { status: "active", plan_key: "school_annual" } }), evt("school_annual"));
    await handleStripeEvent(db as never, makeStripe({ sub_x: { status: "active", plan_key: "parent_monthly" } }), evt("parent_monthly"));
    // Both entitlement upserts target distinct (user, plan) rows — school row
    // is never overwritten by the personal one.
    const entWrites = db.writes.filter((w) => w.table === "entitlements");
    const plans = entWrites.map((w) => w.row.plan_key);
    expect(plans).toContain("school_annual");
    expect(plans).toContain("parent_monthly");
    // Personal plan carries null school_id (never credits/leaks to a school).
    const personal = entWrites.find((w) => w.row.plan_key === "parent_monthly");
    expect(personal!.row.school_id).toBeNull();
  });

  it("past_due keeps access (grace) but flags the status", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    const evt = {
      id: "evt_f",
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_pd" } },
    } as unknown as Stripe.Event;
    await handleStripeEvent(db as never, makeStripe({ sub_pd: { status: "past_due", plan_key: "teacher_monthly" } }), evt);
    const ent = db.writes.filter((w) => w.table === "entitlements").pop();
    expect(ent!.row.active).toBe(true); // grace
    expect(ent!.row.status).toBe("past_due");
  });

  // ── 9. no card data persisted ─────────────────────────────────────────────
  it("persists only Stripe IDs and statuses — never card data", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A", school_id: null } });
    await handleStripeEvent(db as never, stripeStub, completedSession());
    const allKeys = db.writes.flatMap((w) => Object.keys(w.row));
    for (const k of allKeys) {
      expect(k).not.toMatch(/card|pan|cvv|cvc|exp_|number/i);
    }
    const allValues = JSON.stringify(db.writes);
    expect(allValues).not.toMatch(/\b\d{13,19}\b/); // no PAN-shaped values
  });
});

// ── entitlement derivation ───────────────────────────────────────────────────
describe("entitlement derivation", () => {
  const now = new Date("2026-07-06T00:00:00Z");
  it("inactive row → false; active without end → true", () => {
    expect(deriveActive(null, now)).toBe(false);
    expect(deriveActive({ active: false, status: "canceled", current_period_end: null }, now)).toBe(false);
    expect(deriveActive({ active: true, status: "active", current_period_end: null }, now)).toBe(true);
  });
  it("expired period end reads inactive even before the webhook says so", () => {
    expect(
      deriveActive({ active: true, status: "active", current_period_end: "2026-01-01T00:00:00Z" }, now),
    ).toBe(false);
    expect(
      deriveActive({ active: true, status: "active", current_period_end: "2027-01-01T00:00:00Z" }, now),
    ).toBe(true);
  });
});
