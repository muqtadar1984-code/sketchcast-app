/**
 * Lemon Squeezy billing tests — the invariants a reviewer must see hold:
 *   * webhook signature rejects tampered/unsigned payloads (HMAC-SHA256)
 *   * plan_key is derived from the TRUSTED variant id (public checkout carries
 *     no plan_key); custom_data is only a cross-checked fast-path
 *   * an AUTHENTICATED in-app purchase (custom_data.user_id) grants immediately
 *   * a PUBLIC-LINK purchase (no custom_data, logged-out buyer) is PARKED by
 *     email with NO entitlement — money recorded, access withheld until claimed
 *   * we never attribute a sale with no identity signal at all
 *   * claim-on-sign-in binds a parked sub to the verified account + grants it
 *   * a claimed credit pack RECORDS ITS REVENUE (payments.user_id is NOT NULL,
 *     so the webhook cannot write that row for the parked path — and parked is
 *     the only path a pack can take), idempotently, and never at the cost of
 *     the credits themselves
 *   * status → access mapping (grace vs revoke), monotonicity, no card data
 *   * REVENUE IS NET OF TAX: every booked amount is `subtotal - discount_total`
 *     in minor units — not LS's `total` (which carries tax LS remits as
 *     Merchant of Record and the business never keeps), and not bare `subtotal`
 *     (which is before the discount). Pinned against the live objects: invoice
 *     8235804 books 999 of the 1179 collected, pack order 9261766 books 800 of
 *     the 944, a FOUNDINGTEACHER order books 1000 of a 2400 subtotal, and the
 *     three untaxed legacy packs still book 800 — a repair that moved those
 *     would be destroying real money, not removing tax
 * Run: npx vitest run
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLsSignature, lsEventKey } from "../webhook";
import { handleLsEvent, lsNetOfTax, lsRevenueAmount, type LsEvent } from "../handlers";
import { claimLsPurchasesWith, type ClaimDb } from "../claim";

type Row = Record<string, unknown>;

// ── handler stub DB (single-row-per-table reads) ────────────────────────────
class FakeDb {
  tables: Record<string, Row | null>;
  writes: Array<{ table: string; op: "insert" | "upsert" | "update"; row: Row; filter?: [string, unknown] }> = [];
  /** Per-table injected insert error (e.g. a unique-violation for idempotency tests). */
  insertErrors: Record<string, { code?: string; message: string }> = {};
  constructor(tables: Record<string, Row | null> = {}) {
    this.tables = tables;
  }
  from(table: string) {
    const read = async () => ({ data: this.tables[table] ?? null });
    return {
      select: () => ({ eq: () => ({ maybeSingle: read }) }),
      upsert: async (row: Row) => {
        this.writes.push({ table, op: "upsert" as const, row });
        return { error: null };
      },
      insert: async (row: Row) => {
        const error = this.insertErrors[table] ?? null;
        if (!error) this.writes.push({ table, op: "insert" as const, row });
        return { error };
      },
      update: (row: Row) => ({
        eq: async (col: string, v: unknown) => {
          this.writes.push({ table, op: "update" as const, row, filter: [col, v] });
          return { error: null };
        },
      }),
    };
  }
  ent() {
    return this.writes.find((w) => w.table === "entitlements");
  }
  sub() {
    return this.writes.find((w) => w.table === "subscriptions");
  }
  cust() {
    return this.writes.find((w) => w.table === "billing_customers");
  }
  pack() {
    return this.writes.find((w) => w.table === "credit_purchases");
  }
  pay() {
    return this.writes.find((w) => w.table === "payments");
  }
}

// Variant → plan_key stub so handler tests stay hermetic (no env needed).
const VMAP: Record<string, string> = {
  "1875871": "teacher_pro_monthly",
  "1875886": "teacher_pro_plus_monthly",
  "1875909": "family_monthly",
};
const planKeyForVariant = (v: string | number | null | undefined) => (v == null ? null : VMAP[String(v)] ?? null);
const run = (db: FakeDb, event: LsEvent, extra: Record<string, unknown> = {}) =>
  handleLsEvent(db, event, { planKeyForVariant, ...extra });

const subEvent = (over: {
  event?: string;
  status?: string;
  custom?: { user_id?: string; plan_key?: string } | null;
  customerId?: number;
  subId?: string;
  variantId?: number | string | null;
  productName?: string | null;
  variantName?: string | null;
  email?: string | null;
  ends_at?: string | null;
  renews_at?: string | null;
  updated_at?: string;
}): LsEvent => ({
  meta: { event_name: over.event ?? "subscription_created", custom_data: over.custom === undefined ? undefined : over.custom },
  data: {
    type: "subscriptions",
    id: over.subId ?? "sub_1",
    attributes: {
      status: over.status ?? "active",
      customer_id: over.customerId ?? 555,
      variant_id: over.variantId === undefined ? 1875871 : over.variantId,
      product_name: over.productName ?? null,
      variant_name: over.variantName ?? null,
      user_email: over.email === undefined ? null : over.email,
      renews_at: over.renews_at ?? "2999-01-01T00:00:00.000000Z",
      ends_at: over.ends_at ?? null,
      updated_at: over.updated_at ?? "2026-07-06T12:00:00Z",
      urls: { customer_portal: "https://x.lemonsqueezy.com/portal/abc" },
    },
  },
});

// One-time order events (credit packs). `productName: null` = order with no
// first_order_item at all.
//
// MONEY: the fixture never lets a test assert against a payload Lemon Squeezy
// could not have sent. `subtotal` defaults to whatever satisfies LS's own
// identity, total = subtotal - discount_total + tax, so passing `total: 944,
// tax: 144` yields subtotal 800 exactly as order 9261766 really reports it, and
// the many existing fixtures that pass a bare `total` keep subtotal == total
// (an untaxed, undiscounted sale — which is what the three test-mode pack
// orders actually were).
const orderEvent = (over: {
  event?: string;
  custom?: { user_id?: string } | null;
  orderId?: string;
  customerId?: number;
  email?: string | null;
  productName?: string | null;
  variantName?: string;
  status?: string;
  refunded?: boolean;
  total?: number | null;
  totalUsd?: number | null;
  subtotal?: number | null;
  subtotalUsd?: number | null;
  discountTotal?: number;
  tax?: number;
  taxUsd?: number;
  currency?: string;
}): LsEvent => {
  const total = over.total === undefined ? 800 : over.total;
  const totalUsd = over.totalUsd === undefined ? total : over.totalUsd;
  const tax = over.tax ?? 0;
  const taxUsd = over.taxUsd ?? tax;
  const discount = over.discountTotal ?? 0;
  const subtotal = over.subtotal === undefined ? (total === null ? null : total - tax + discount) : over.subtotal;
  const subtotalUsd = over.subtotalUsd === undefined ? (totalUsd === null ? null : totalUsd - taxUsd + discount) : over.subtotalUsd;
  return {
  meta: { event_name: over.event ?? "order_created", custom_data: over.custom === undefined ? undefined : over.custom },
  data: {
    type: "orders",
    id: over.orderId ?? "ord_1",
    attributes: {
      customer_id: over.customerId ?? 777,
      user_email: over.email === undefined ? null : over.email,
      status: over.status ?? "paid",
      refunded: over.refunded ?? false,
      subtotal,
      discount_total: discount,
      tax,
      total,
      subtotal_usd: subtotalUsd,
      discount_total_usd: discount,
      tax_usd: taxUsd,
      total_usd: totalUsd,
      currency: over.currency ?? "USD",
      updated_at: "2026-08-18T12:00:00Z",
      first_order_item:
        over.productName === null
          ? null
          : {
              product_id: 42,
              variant_id: 4242,
              product_name: over.productName ?? "SketchCast Credits — 1 kit (6)",
              variant_name: over.variantName ?? "Default",
            },
    },
  },
  };
};

// ── signature ────────────────────────────────────────────────────────────────
describe("LS webhook signature", () => {
  const secret = "whsec_ls_test";
  const body = JSON.stringify({ meta: { event_name: "subscription_created" } });
  const good = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

  it("accepts a correctly-signed body", () => expect(verifyLsSignature(body, good, secret)).toBe(true));
  it("rejects a tampered body", () => expect(verifyLsSignature(body + " ", good, secret)).toBe(false));
  it("rejects a missing / malformed signature", () => {
    expect(verifyLsSignature(body, null, secret)).toBe(false);
    expect(verifyLsSignature(body, "not-hex-zz", secret)).toBe(false);
    expect(verifyLsSignature(body, "deadbeef", secret)).toBe(false);
  });
  it("rejects when the secret is wrong", () => expect(verifyLsSignature(body, good, "whsec_other")).toBe(false));
  it("builds a stable idempotency key", () =>
    expect(lsEventKey("subscription_updated", 42, "2026-07-06T00:00:00Z")).toBe("ls_subscription_updated_42_2026-07-06T00:00:00Z"));
});

// ── handler ─────────────────────────────────────────────────────────────────
describe("LS subscription → entitlement", () => {
  it("AUTHENTICATED in-app purchase (custom_data.user_id) grants the user immediately", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, subEvent({ custom: { user_id: "user-A", plan_key: "teacher_pro_monthly" }, email: "a@x.com", variantId: 1875871 }));
    expect(db.cust()!.row.user_id).toBe("user-A");
    expect(db.cust()!.row.email).toBe("a@x.com");
    expect(db.sub()!.row.user_id).toBe("user-A");
    expect(db.sub()!.row.claim_email).toBeNull();
    expect(db.ent()!.row.user_id).toBe("user-A");
    expect(db.ent()!.row.plan_key).toBe("teacher_pro_monthly");
    expect(db.ent()!.row.active).toBe(true);
    expect(db.ent()!.row.school_id).toBeNull();
  });

  it("PUBLIC-LINK purchase (no custom_data, logged-out) is PARKED by email with NO entitlement", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, subEvent({ custom: undefined, email: "Buyer@X.com", variantId: 1875886 })); // Pro+
    // parked customer + subscription, keyed by email — but no access yet.
    expect(db.cust()!.row.user_id).toBeNull();
    expect(db.cust()!.row.email).toBe("buyer@x.com"); // normalised
    expect(db.sub()!.row.user_id).toBeNull();
    expect(db.sub()!.row.claim_email).toBe("buyer@x.com");
    expect(db.sub()!.row.plan_key).toBe("teacher_pro_plus_monthly"); // from the VARIANT, not custom_data
    expect(db.ent()).toBeUndefined(); // <-- the money-safety invariant: no entitlement until claimed
  });

  it("never demotes an already-claimed sub: a later no-custom_data event stays bound", async () => {
    // identity resolves "unclaimed" (no custom_data, no billing_customers row),
    // but the subscription was already bound to user-A → keep it bound.
    const db = new FakeDb({ billing_customers: null, subscriptions: { user_id: "user-A" } });
    await run(db, subEvent({ custom: undefined, email: "buyer@x.com", event: "subscription_updated", status: "active", variantId: 1875871 }));
    expect(db.sub()!.row.user_id).toBe("user-A");
    expect(db.sub()!.row.claim_email).toBeNull();
    expect(db.ent()!.row.user_id).toBe("user-A"); // entitlement stays live, not re-parked
  });

  it("plan_key comes from the trusted variant even if custom_data disagrees", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, subEvent({ custom: { user_id: "user-A", plan_key: "family_monthly" }, variantId: 1875871 })); // variant = Teacher Pro
    expect(db.ent()!.row.plan_key).toBe("teacher_pro_monthly"); // variant wins
  });

  it("unmapped variant with no custom_data → no plan_key, nothing written", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, subEvent({ custom: undefined, email: "a@x.com", variantId: 999999 }));
    expect(db.writes.length).toBe(0);
  });

  it("no user_id AND no email → refused (cannot attribute), nothing written", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, subEvent({ custom: undefined, email: null, variantId: 1875871 }));
    expect(db.writes.length).toBe(0);
  });

  it("refuses a later event whose custom_data claims a DIFFERENT user than the stored mapping", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, subEvent({ custom: { user_id: "user-B", plan_key: "teacher_pro_monthly" }, variantId: 1875871 }));
    expect(db.writes.length).toBe(0);
  });

  it("records the founding cohort when the order used the discount", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, subEvent({ custom: { user_id: "user-A" }, variantId: 1875871 }), { detectFounding: async () => true });
    expect(db.sub()!.row.is_founding).toBe(true);
  });

  it("never UNSETS the founding flag when a later event's detection fails", async () => {
    // detectFounding is a best-effort LS lookup that returns false for every
    // failure mode, and this handler re-runs on every renewal and status
    // change. Without monotonicity a routine subscription_updated arriving
    // during an LS outage would quietly demote a real founding subscriber —
    // and that row is what /api/public/founding-places counts when LS is
    // unreachable, i.e. during exactly those outages.
    for (const detect of [async () => false, async () => { throw new Error("LS 429"); }]) {
      const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: { user_id: "user-A", is_founding: true } });
      await run(db, subEvent({ custom: { user_id: "user-A" }, event: "subscription_updated", variantId: 1875871 }), { detectFounding: detect });
      expect(db.sub()!.row.is_founding).toBe(true);
    }
  });

  it("cancelled keeps access until ends_at (grace); paused/expired revoke", async () => {
    const db1 = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db1, subEvent({ custom: { user_id: "user-A" }, event: "subscription_cancelled", status: "cancelled", ends_at: "2999-01-01T00:00:00Z" }));
    expect(db1.ent()!.row.active).toBe(true);
    expect(db1.ent()!.row.current_period_end).toBe("2999-01-01T00:00:00Z");
    for (const s of ["paused", "unpaid", "expired"]) {
      const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
      await run(db, subEvent({ custom: { user_id: "user-A" }, event: "subscription_updated", status: s }));
      expect(db.ent()!.row.active).toBe(false);
    }
  });

  it("cancelled with NO ends_at reads inactive (no unbounded grant)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, subEvent({ custom: { user_id: "user-A" }, event: "subscription_cancelled", status: "cancelled", ends_at: null }));
    expect(db.ent()!.row.active).toBe(false);
    expect(db.ent()!.row.current_period_end).toBeNull();
  });

  it("skips a STALE out-of-order event (monotonicity gate)", async () => {
    const db = new FakeDb({
      billing_customers: { user_id: "user-A" },
      subscriptions: { provider_updated_at: "2026-07-06T13:00:00Z" },
    });
    await run(db, subEvent({ custom: { user_id: "user-A" }, event: "subscription_updated", status: "active", updated_at: "2026-07-06T12:00:00Z" }));
    expect(db.writes.length).toBe(0);
  });

  it("an invoice-shaped subscription_payment_* event never touches ACCESS (no 'paid' revocation)", async () => {
    // An invoice's status is "paid"/"refunded", NOT a subscription lifecycle
    // status: reading it as one would flip a live subscriber to inactive on the
    // very event that proves they just paid. Since 0093 these events ARE read —
    // for bookkeeping — so the assertion sharpens from "writes nothing" to
    // "writes no entitlement and no subscriptions row", which is the invariant
    // that actually mattered.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await handleLsEvent(db, {
      meta: { event_name: "subscription_payment_success", custom_data: { user_id: "user-A", plan_key: "teacher_pro_monthly" } },
      data: { type: "subscription-invoices", id: "inv_1", attributes: { status: "paid", customer_id: 555, renews_at: null, ends_at: null, updated_at: "2026-07-06T12:00:00Z" } },
    } as LsEvent);
    expect(db.ent()).toBeUndefined(); // access untouched
    expect(db.sub()).toBeUndefined(); // the subscription row is not rewritten from an invoice
  });

  it("ignores unrelated events", async () => {
    const db = new FakeDb({});
    await run(db, { meta: { event_name: "license_key_created" }, data: { id: "1", attributes: { status: "paid", customer_id: 1, renews_at: null, ends_at: null } } } as LsEvent);
    expect(db.writes.length).toBe(0);
  });

  it("maps an unmapped-variant Homeschool sub by PRODUCT NAME (annual + monthly)", async () => {
    // The product can go live before its variant env vars are set; the stable
    // product name must carry the sale rather than dropping it.
    const dbA = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(dbA, subEvent({ custom: { user_id: "user-A" }, variantId: 999999, productName: "SketchCast Homeschool", variantName: "Annual" }));
    expect(dbA.ent()!.row.plan_key).toBe("homeschool_annual");
    const dbM = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(dbM, subEvent({ custom: { user_id: "user-A" }, variantId: 999999, productName: "SketchCast Homeschool", variantName: "Monthly" }));
    expect(dbM.ent()!.row.plan_key).toBe("homeschool_monthly");
  });

  it("the variant env mapping stays authoritative over the name fallback", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    // VMAP maps 1875871 → teacher_pro_monthly; a (mislabelled) product name
    // must not override the trusted variant id.
    await run(db, subEvent({ custom: { user_id: "user-A" }, variantId: 1875871, productName: "SketchCast Homeschool", variantName: "Monthly" }));
    expect(db.ent()!.row.plan_key).toBe("teacher_pro_monthly");
  });

  it("a product merely SHARING the Homeschool name prefix is not mapped by name", async () => {
    // The name fallback is an exact match: a future "SketchCast Homeschool
    // Plus" must surface as unmapped (and get its own mapping), never silently
    // sell at this plan's price/caps.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, subEvent({ custom: { user_id: "user-A" }, variantId: 999999, productName: "SketchCast Homeschool Plus", variantName: "Monthly" }));
    expect(db.ent()).toBeUndefined();
  });

  it("maps EVERY live product by name when the whole variant map is stale", async () => {
    // The 2026-08-20 go-live scenario: the store was activated, every id in
    // env was still a dead TEST-mode object, and planKeyForVariant returned
    // null for all four products. Homeschool survived on its name fallback;
    // Teacher Pro / Pro+ / Home Basic had none and reached `no_plan_key`,
    // which returns BEFORE any entitlement write — a real card charged and no
    // record of the buyer. All four must now map.
    const cases: Array<[string, string, string]> = [
      ["SketchCast Teacher Pro", "Monthly", "teacher_pro_monthly"],
      ["SketchCast Teacher Pro", "Annual", "teacher_pro_annual"],
      ["SketchCast Teacher Pro+", "Monthly", "teacher_pro_plus_monthly"],
      ["SketchCast Teacher Pro+", "Annual", "teacher_pro_plus_annual"],
      ["SketchCast Home Basic", "Monthly", "family_monthly"],
      ["SketchCast Home Basic", "Annual", "family_annual"],
      ["SketchCast Homeschool", "Monthly", "homeschool_monthly"],
      ["SketchCast Homeschool", "Annual", "homeschool_annual"],
    ];
    for (const [productName, variantName, expected] of cases) {
      const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
      // 2037937 et al are the LIVE ids — deliberately absent from VMAP here,
      // standing in for an env that was never repointed.
      await run(db, subEvent({ custom: { user_id: "user-A" }, variantId: 2037937, productName, variantName }));
      expect(db.ent()!.row.plan_key).toBe(expected);
    }
  });

  it("'Teacher Pro' does not swallow 'Teacher Pro+' (exact match, not prefix)", async () => {
    // The two product names share a prefix and differ by one character. A
    // prefix/startsWith match would sell Pro+ at Pro's caps for $49.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, subEvent({ custom: { user_id: "user-A" }, variantId: 999999, productName: "SketchCast Teacher Pro+", variantName: "Monthly" }));
    expect(db.ent()!.row.plan_key).toBe("teacher_pro_plus_monthly");
  });

  it("Home Basic maps to the family_* plan keys, not a 'home_*' key", async () => {
    // The user-visible name changed in the homeschool release; the billing
    // identifier did not. Getting this wrong yields a plan_key no PLANS entry
    // matches, so entitlements would carry a key the app cannot price.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, subEvent({ custom: { user_id: "user-A" }, variantId: 999999, productName: "SketchCast Home Basic", variantName: "Annual" }));
    expect(db.ent()!.row.plan_key).toBe("family_annual");
  });

  it("persists no card data", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, subEvent({ custom: { user_id: "user-A" }, email: "a@x.com" }));
    const keys = db.writes.flatMap((w) => Object.keys(w.row));
    for (const k of keys) expect(k).not.toMatch(/card|pan|cvv|cvc|number/i);
    expect(JSON.stringify(db.writes)).not.toMatch(/\b\d{13,19}\b/);
  });
});

// ── one-time orders → credit packs ───────────────────────────────────────────
describe("LS order → credit pack", () => {
  it("credits a pack to a KNOWN customer and records the payment", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, email: "a@x.com", productName: "SketchCast Credits — 1 kit (6)", total: 800 }));
    expect(db.pack()!.op).toBe("insert");
    expect(db.pack()!.row.owner_id).toBe("user-A");
    expect(db.pack()!.row.claim_email).toBeNull();
    expect(db.pack()!.row.credits).toBe(6);
    expect(db.pack()!.row.pack_key).toBe("pack_6");
    expect(db.pack()!.row.ls_order_id).toBe("ord_1");
    expect(db.pack()!.row.refunded_at).toBeNull();
    expect(db.pay()!.row.amount).toBe(800);
    expect(db.pay()!.row.plan_key).toBe("pack_6");
    expect(db.pay()!.row.user_id).toBe("user-A");
    expect(db.cust()).toBeDefined(); // customer mapping kept current
    expect(db.ent()).toBeUndefined(); // a pack is credits, never an entitlement
  });

  it("a $0 pack order credits NOTHING", async () => {
    // The live FOUNDINGTEACHER discount was created is_limited_to_products:
    // false, so its $14 fixed amount applied to every variant in the store —
    // fetching the pack_6 checkout with the code returns total 0, and LS then
    // takes its no-payment-details path, so the order completes with no card.
    // The code is printed with a Copy button on /pricing in all ten languages.
    // There is no legitimate $0 pack sale (comps go through credit_grants), so
    // nothing may be granted and no revenue row written.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, email: "a@x.com", productName: "SketchCast Credits — 1 kit (6)", total: 0 }));
    expect(db.pack()).toBeUndefined();
    expect(db.pay()).toBeUndefined();
    expect(db.writes.length).toBe(0);
  });

  it("a pack order with an UNKNOWN total still credits", async () => {
    // The guard is `=== 0` on a number, deliberately not a falsy test: an
    // absent or unparsable total is not proof of a free order, and dropping a
    // real sale over a missing bookkeeping field would be the worse failure.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    const ev = orderEvent({ custom: { user_id: "user-A" }, email: "a@x.com", productName: "SketchCast Credits — 1 kit (6)" });
    delete (ev.data!.attributes as Record<string, unknown>).total;
    await run(db, ev);
    expect(db.pack()!.row.credits).toBe(6);
  });

  it("a DISCOUNTED but non-zero pack order still credits, at the price paid", async () => {
    // $20 pack with the $14 code applied = $6 collected. A real sale: credit
    // the pack, and bill from what LS reports rather than the catalogue price.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, email: "a@x.com", productName: "SketchCast Credits — 3 kits (18)", total: 600 }));
    expect(db.pack()!.row.credits).toBe(18);
    expect(db.pay()!.row.amount).toBe(600);
  });

  it("stamps what LS CHARGED onto the purchase, separately from the credit grant", async () => {
    // credit_purchases.usd is the catalogue constant, so a parked pack used to
    // carry no record of what was actually collected and claim.ts had to book
    // it at list. These three columns (0092) are what the claim bills from.
    const db = new FakeDb({ billing_customers: null });
    await run(db, orderEvent({ custom: undefined, email: "buyer@x.com", total: 400, status: "paid" }));
    const grant = db.writes.find((w) => w.table === "credit_purchases" && w.op === "insert");
    // The credit grant names ONLY columns that shipped with 0086: naming a
    // column 0092 has not added yet would throw, LS would retry, and the buyer
    // would wait on bookkeeping for credits they have paid for.
    expect(grant!.row.total_minor).toBeUndefined();
    const money = db.writes.find((w) => w.table === "credit_purchases" && w.op === "update");
    expect(money!.row.total_minor).toBe(400); // a discounted $8 pack — LS collected $4
    expect(money!.row.total_currency).toBe("usd");
    expect(money!.row.order_status).toBe("paid");
    expect(money!.filter).toEqual(["ls_order_id", "ord_1"]);
  });

  it("THE LIVE TAXED PACK: order 9261766 books 800, and stamps 800 — never the 944 collected", async () => {
    // The row that is wrong in production today, end to end through the webhook.
    // LS collected $9.44: $8.00 for the pack plus $1.44 IGST it remits itself.
    // BOTH writes have to be net, because claim.ts prices a still-parked pack
    // from the stamped column and the console prices from payments — one gross
    // and one net is how the revenue series became two numbers the first time.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, orderId: "9261766", subtotal: 800, tax: 144, total: 944 }));
    expect(db.pay()!.row.amount).toBe(800);
    expect(db.pay()!.row.currency).toBe("usd");
    const money = db.writes.find((w) => w.table === "credit_purchases" && w.op === "update");
    expect(money!.row.total_minor).toBe(800);
    // and the CREDITS are untouched by any of it — bookkeeping never costs a
    // buyer what they paid for.
    expect(db.pack()!.row.credits).toBe(6);
  });

  it("a discounted AND taxed pack books what was charged, not the list and not the total", async () => {
    // $8.00 pack, $2 off, 18% tax on the discounted price: LS collects 708.
    // Booking `total` gives 708, booking `subtotal` gives 800; only
    // subtotal - discount_total gives the 600 the business actually keeps.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, subtotal: 800, discountTotal: 200, tax: 108, total: 708 }));
    expect(db.pay()!.row.amount).toBe(600);
  });

  it("A REFUND STILL STOPS THE MONEY COUNTING, tax or no tax", async () => {
    // The invariant the tax change must not weaken: net-of-tax revenue that was
    // given back is still not revenue.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ event: "order_refunded", custom: { user_id: "user-A" }, orderId: "9261766", subtotal: 800, tax: 144, total: 944, refunded: true, status: "refunded" }));
    const pay = db.writes.find((w) => w.table === "payments");
    expect(pay?.op).toBe("update");
    expect(pay?.row.status).toBe("refunded");
    expect(db.writes.some((w) => w.table === "payments" && w.op === "insert")).toBe(false);
  });

  it("identifies the pack size from the product name (18 and 36)", async () => {
    for (const [name, credits, key] of [
      ["SketchCast Credits — 3 kits (18)", 18, "pack_18"],
      ["SketchCast Credits — 6 kits (36)", 36, "pack_36"],
    ] as const) {
      const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
      await run(db, orderEvent({ custom: { user_id: "user-A" }, productName: name }));
      expect(db.pack()!.row.credits).toBe(credits);
      expect(db.pack()!.row.pack_key).toBe(key);
    }
  });

  it("PUBLIC-LINK pack purchase is PARKED by email — credits recorded, no payment row yet", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, orderEvent({ custom: undefined, email: "Buyer@X.com" }));
    expect(db.pack()!.row.owner_id).toBeNull();
    expect(db.pack()!.row.claim_email).toBe("buyer@x.com"); // normalised
    expect(db.pay()).toBeUndefined(); // payments.user_id is NOT NULL — records on claim path instead
  });

  // payments_currency_check (0023) admits only 'myr' and 'usd'. Writing LS's
  // raw currency through meant a pack billed in anything else produced 23514,
  // which is not 23505, so the sale was warned about and lost — while the
  // invoice writer converted the same case correctly. One revenue series, one
  // rule: both now price through lsRevenueAmount.
  it("books a foreign-currency pack at LS's own USD conversion instead of dropping it", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, total: 736, currency: "EUR", totalUsd: 800 }));
    const pay = db.pay()!;
    expect(pay.row.currency).toBe("usd"); // never 'eur' — the CHECK would reject it
    expect(pay.row.amount).toBe(800);
  });

  it("falls back to the catalogue list price when LS reports no usable figure", async () => {
    // The same answer claim.ts's packAmountMinor gives for the same pack, so
    // whichever writer gets there first records the same number.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, total: null, currency: "EUR", totalUsd: null }));
    const pay = db.pay()!;
    expect(pay.row.currency).toBe("usd");
    expect(pay.row.amount).toBe(800); // pack_6 list price, in minor units
  });

  it("ignores a non-pack order (a subscription's own order_created)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, productName: "SketchCast Homeschool" }));
    expect(db.writes.length).toBe(0);
  });

  it("credits the ONE-product shape: 'SketchCast Credits' + the pack on the variant name", async () => {
    // The founder's preferred LS layout (same as Homeschool's Monthly/Annual):
    // one product, three variants — the credit count rides on the variant.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, productName: "SketchCast Credits", variantName: "3 kits (18)", total: 2000 }));
    expect(db.pack()!.row.credits).toBe(18);
    expect(db.pack()!.row.pack_key).toBe("pack_18");
    expect(db.pay()!.row.plan_key).toBe("pack_18");
  });

  it("ignores a bare 'SketchCast Credits' order whose variant carries no known count", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, productName: "SketchCast Credits", variantName: "Default" }));
    expect(db.writes.length).toBe(0);
  });

  it("ignores an order with no line item at all", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, productName: null }));
    expect(db.writes.length).toBe(0);
  });

  it("a re-delivered order credits exactly once (unique ls_order_id → no-op)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    db.insertErrors["credit_purchases"] = { code: "23505", message: "duplicate key value violates unique constraint" };
    await run(db, orderEvent({ custom: { user_id: "user-A" } }));
    expect(db.pack()).toBeUndefined(); // insert refused by the unique key
    expect(db.pay()).toBeUndefined(); // and nothing double-recorded after it
  });

  it("no identity signal at all → refused, nothing written", async () => {
    const db = new FakeDb({ billing_customers: null });
    await run(db, orderEvent({ custom: undefined, email: null }));
    expect(db.writes.length).toBe(0);
  });

  it("order_refunded voids the pack's contribution (and the payment record)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ event: "order_refunded", custom: { user_id: "user-A" }, status: "refunded", refunded: true }));
    const packUpd = db.writes.find((w) => w.table === "credit_purchases" && w.op === "update");
    expect(packUpd).toBeDefined();
    expect(packUpd!.row.refunded_at).toBeTruthy();
    expect(packUpd!.filter).toEqual(["ls_order_id", "ord_1"]);
    const payUpd = db.writes.find((w) => w.table === "payments" && w.op === "update");
    expect(payUpd!.row.status).toBe("refunded");
  });

  it("an order_created already flagged refunded lands with refunded_at set", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, status: "refunded", refunded: true }));
    expect(db.pack()!.row.refunded_at).toBeTruthy();
  });

  it("a refund arriving BEFORE its order_created inserts a refunded tombstone", async () => {
    // Race: order_created delivery fails, the refund processes first, then LS
    // retries the stale 'paid' payload. The tombstone occupies the unique
    // ls_order_id so that retry 23505-no-ops instead of crediting a refunded
    // pack.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, orderEvent({ event: "order_refunded", custom: { user_id: "user-A" }, status: "refunded", refunded: true }));
    const tomb = db.writes.find((w) => w.table === "credit_purchases" && w.op === "insert");
    expect(tomb).toBeDefined();
    expect(tomb!.row.refunded_at).toBeTruthy();
    expect(tomb!.row.ls_order_id).toBe("ord_1");
    // In the normal order (row already credited) the same insert is refused by
    // the unique key and swallowed — covered by the duplicate-order test.
  });
});

// ── claim-on-sign-in ─────────────────────────────────────────────────────────
class FakeClaimDb {
  tables: Record<string, Row[]>;
  writes: Array<{ table: string; op: string; row: Row; matched: number }> = [];
  /** Per-table injected insert error, mirroring FakeDb — so the payments unique
   * (23505) can be simulated on the CLAIM path too, which is now where a pack's
   * revenue row is written. */
  insertErrors: Record<string, { code?: string; message: string }> = {};
  /** Per-table injected READ error. supabase-js resolves errors instead of
   * throwing, and every one of these paths used to be discarded — a stale
   * PostgREST schema cache or an unapplied 0092 has to be reproducible. */
  selectErrors: Record<string, { message: string }> = {};
  /** Injected error for an UPDATE ... RETURNING (i.e. .select() chained onto an
   * update). This is the pre-0092 shape specifically: the update itself is
   * legal, only naming the new columns in the representation fails. */
  updateSelectErrors: Record<string, { message: string }> = {};
  /** Injected error for a plain UPDATE — the fallback bind failing too. */
  updateErrors: Record<string, { message: string }> = {};
  /** Runs immediately after a SELECT resolves. The ONLY way to model another
   * writer (a webhook delivery, a refund) landing between the probe and the
   * bind, which a single-threaded fake cannot otherwise exhibit. */
  afterSelect?: (table: string) => void;
  constructor(tables: Record<string, Row[]> = {}) {
    this.tables = tables;
  }
  from(table: string) {
    // Every nested callback below is an arrow so `this` stays the instance:
    // the injected-error maps and afterSelect are read at CALL time, not
    // captured at construction, which is what lets a hook disarm itself.
    const tables = this.tables;
    const writes = this.writes;
    const insertErrors = this.insertErrors;
    const make = (kind: "select" | "update", payload?: Row) => {
      const filters: Array<[string, unknown]> = [];
      const matched = () => (tables[table] ?? []).filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
      const apply = () => {
        const rows = matched();
        rows.forEach((r) => Object.assign(r, payload));
        writes.push({ table, op: "update", row: payload ?? {}, matched: rows.length });
        return rows;
      };
      const thenable = {
        eq(col: string, v: unknown) { filters.push([col, v]); return thenable; },
        is(col: string, v: unknown) { filters.push([col, v]); return thenable; },
        /** `Prefer: return=representation` — the rows the UPDATE actually
         * matched, snapshotted AFTER it ran, exactly as PostgREST hands them
         * back. */
        select: () => ({
          then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            try {
              const error = this.updateSelectErrors[table] ?? this.updateErrors[table] ?? null;
              if (error) return resolve({ data: null, error });
              return resolve({ data: apply().map((r) => ({ ...r })), error: null });
            } catch (e) {
              reject?.(e);
            }
          },
        }),
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
          try {
            if (kind === "select") {
              const error = this.selectErrors[table] ?? null;
              if (error) return resolve({ data: null, error });
              const rows = matched();
              this.afterSelect?.(table);
              return resolve({ data: rows });
            }
            const error = this.updateErrors[table] ?? null;
            if (error) return resolve({ error });
            apply();
            return resolve({ error: null });
          } catch (e) {
            reject?.(e);
          }
        },
      };
      return thenable;
    };
    return {
      select: () => make("select"),
      update: (row: Row) => make("update", row),
      upsert: async (row: Row) => {
        writes.push({ table, op: "upsert", row, matched: 1 });
        return { error: null };
      },
      insert: async (row: Row) => {
        const error = insertErrors[table] ?? null;
        if (!error) {
          (tables[table] ??= []).push(row);
          writes.push({ table, op: "insert", row, matched: 1 });
        }
        return { error };
      },
    };
  }
}

describe("claim-on-sign-in", () => {
  const parked = () => ({
    ls_subscription_id: "sub_1",
    plan_key: "teacher_pro_monthly",
    status: "active",
    current_period_end: "2999-01-01T00:00:00Z",
    user_id: null,
    provider: "lemonsqueezy",
    claim_email: "buyer@x.com",
  });

  it("binds a parked sub to the verified account and creates the entitlement", async () => {
    const db = new FakeClaimDb({ subscriptions: [parked()], billing_customers: [{ email: "buyer@x.com", user_id: null, provider: "lemonsqueezy" }] });
    const n = await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "Buyer@X.com"); // case-insensitive
    expect(n).toBe(1);
    const ent = db.writes.find((w) => w.table === "entitlements");
    expect(ent!.row.user_id).toBe("user-A");
    expect(ent!.row.plan_key).toBe("teacher_pro_monthly");
    expect(ent!.row.active).toBe(true);
    // the sub row got bound (user_id set, claim_email cleared)
    expect((db.tables.subscriptions[0] as Row).user_id).toBe("user-A");
    expect((db.tables.subscriptions[0] as Row).claim_email).toBeNull();
  });

  it("does NOT claim a purchase parked under a different email", async () => {
    const db = new FakeClaimDb({ subscriptions: [{ ...parked(), claim_email: "someone@else.com" }] });
    const n = await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect(n).toBe(0);
    expect(db.writes.find((w) => w.table === "entitlements")).toBeUndefined();
  });

  it("binds a parked CREDIT PACK by the verified email — even with no parked sub", async () => {
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [
        { owner_id: null, claim_email: "buyer@x.com", credits: 6 },
        { owner_id: null, claim_email: "someone@else.com", credits: 18 },
      ],
    });
    const n = await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "Buyer@X.com");
    expect(n).toBe(0); // the count reports subscriptions; the pack rides along
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A");
    expect((db.tables.credit_purchases[0] as Row).claim_email).toBeNull();
    expect((db.tables.credit_purchases[1] as Row).owner_id).toBeNull(); // other email untouched
  });

  it("no-ops on missing user or email", async () => {
    const db = new FakeClaimDb({ subscriptions: [parked()] });
    expect(await claimLsPurchasesWith(db as unknown as ClaimDb, "", "buyer@x.com")).toBe(0);
    expect(await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", null)).toBe(0);
    expect(db.writes.length).toBe(0);
  });
});

// ── claimed pack → revenue record ────────────────────────────────────────────
// payments.user_id is NOT NULL, so the webhook can only write a pack's revenue
// row when the buyer was already bound at webhook time. The in-app buy chip is
// a plain link to the LS hosted checkout with no custom_data, so that never
// happens: the claim is the first moment a user_id exists for the order, and
// therefore the only place the row can be written.
describe("claim-on-sign-in → credit pack revenue", () => {
  // Shaped exactly like a webhook-written parked pack. `usd` is a STRING
  // because credit_purchases.usd is numeric(8,2) and postgres serialises
  // numerics as text to protect precision — the conversion trap this pins.
  // total_minor/total_currency/order_status are NULL here on purpose: this is a
  // PRE-0092 sale, the shape every pack already in the table has, so the
  // catalogue fallback is what the default fixture exercises.
  const parkedPack = (over: Partial<Row> = {}): Row => ({
    owner_id: null,
    claim_email: "buyer@x.com",
    credits: 6,
    pack_key: "pack_6",
    usd: "8.00",
    total_minor: null,
    total_currency: null,
    order_status: null,
    ls_order_id: "9251234", // the real production order that went unrecorded
    refunded_at: null,
    created_at: "2026-08-18T12:34:56Z",
    ...over,
  });

  it("a bound pack writes the payments row the webhook could not", async () => {
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack()] });
    const n = await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "Buyer@X.com");
    expect(n).toBe(0); // the return value still reports SUBSCRIPTIONS only

    // the pack itself bound (credits first, always)
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A");
    expect((db.tables.credit_purchases[0] as Row).claim_email).toBeNull();

    const pay = db.writes.find((w) => w.table === "payments");
    expect(pay).toBeDefined();
    expect(pay!.op).toBe("insert");
    expect(pay!.row.user_id).toBe("user-A");
    expect(pay!.row.amount).toBe(800); // "8.00" dollars → 800 MINOR UNITS
    expect(pay!.row.currency).toBe("usd");
    expect(pay!.row.plan_key).toBe("pack_6");
    expect(pay!.row.ls_order_id).toBe("9251234");
    expect(pay!.row.status).toBe("paid");
    expect(pay!.row.provider).toBe("lemonsqueezy");
    expect(pay!.row.school_id).toBeNull(); // personal (B2C) — never school-scoped
    // Dated to the PURCHASE, not to this sign-in: "Collected to date" is a time
    // series and 0092's backfill copies credit_purchases.created_at, so the two
    // writers must agree or history and future stop being comparable.
    expect(pay!.row.created_at).toBe("2026-08-18T12:34:56Z");
  });

  it("prices the bigger packs from the numeric column, not the pack size", async () => {
    // usd DELIBERATELY disagrees with the catalogue (packs.ts has pack_18 at $20
    // and pack_36 at $36) so this can actually tell the column and the constant
    // apart — with matching values it proved nothing.
    for (const [usd, key, amount] of [
      ["17.00", "pack_18", 1700],
      [31, "pack_36", 3100], // already a number (driver/version dependent) — same answer
    ] as const) {
      const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack({ usd, pack_key: key, ls_order_id: `ord_${key}` })] });
      await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
      const pay = db.writes.find((w) => w.table === "payments");
      expect(pay!.row.amount).toBe(amount);
      expect(pay!.row.plan_key).toBe(key);
    }
  });

  it("books what LS CHARGED (total_minor), not the catalogue list price", async () => {
    // A discount code at the LS hosted checkout: list $20, collected $10. usd
    // still holds the catalogue constant the webhook copied in, so pricing from
    // it would overstate "Collected to date" by the whole discount, silently.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack({ pack_key: "pack_18", usd: "20.00", total_minor: 1000, total_currency: "usd" })],
    });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect(db.writes.find((w) => w.table === "payments")!.row.amount).toBe(1000);
  });

  it("books the STORED net figure as-is — the tax was already taken out upstream", async () => {
    // The stamped column is net (lsNetOfTax, at the webhook boundary), so this
    // path must book it unchanged. Pack order 9261766 collected 944 and stamps
    // 800; if claim.ts ever "helpfully" netted tax again the buyer's $8 sale
    // would land at $6.56 and nothing downstream would notice.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack({ usd: "8.00", total_minor: 800, total_currency: "usd", ls_order_id: "9261766" })],
    });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect(db.writes.find((w) => w.table === "payments")!.row.amount).toBe(800);
  });

  it("the catalogue fallback is a LIST price, which is net of tax by construction", async () => {
    // A pre-0092 sale has no stamped figure, so list is all there is. Under the
    // old gross policy that quietly UNDERSTATED a taxed sale; under net-of-tax
    // it is exactly right for an undiscounted one, because LS adds tax on top of
    // list rather than inside it. Same code path, newly correct.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack({ usd: "8.00", total_minor: null, total_currency: null })],
    });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect(db.writes.find((w) => w.table === "payments")!.row.amount).toBe(800);
  });

  it("falls back to the list price when the charge is in a currency payments cannot hold", async () => {
    // payments_currency_check (0023) admits only myr/usd. Booking foreign minor
    // units as dollars would be worse than booking list, so list wins.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack({ usd: "8.00", total_minor: 960, total_currency: "eur" })],
    });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    const pay = db.writes.find((w) => w.table === "payments");
    expect(pay!.row.amount).toBe(800);
    expect(pay!.row.currency).toBe("usd");
  });

  it("echoes LS's order status instead of asserting 'paid'", async () => {
    // A delayed payment method delivers order_created as "pending". Credits are
    // granted by the webhook either way, but collectedUsd() counts only
    // PAID_STATUSES — and if that order later fails, no order_refunded ever
    // fires to correct a row we called "paid".
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack({ order_status: "pending" })],
    });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect(db.writes.find((w) => w.table === "payments")!.row.status).toBe("pending");
  });

  it("a duplicate payments row (23505) is swallowed and the binding still stands", async () => {
    // The webhook got there first, 0092's backfill did, or a second tab claimed
    // concurrently. payments_ls_order_uq makes all three a harmless no-op.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack()] });
    db.insertErrors["payments"] = { code: "23505", message: 'duplicate key value violates unique constraint "payments_ls_order_uq"' };
    await expect(claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(0);
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined(); // refused by the unique key
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A"); // credits kept regardless
    expect((db.tables.credit_purchases[0] as Row).claim_email).toBeNull();
  });

  it("a HARD payments failure never costs the buyer their credits", async () => {
    // The credits are what was paid for; the revenue row is bookkeeping 0092
    // can rebuild. This is the ordering invariant, not just error tolerance.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack()] });
    db.insertErrors["payments"] = { code: "42501", message: "permission denied for table payments" };
    await expect(claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(0);
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A");
  });

  it("a REFUNDED parked pack binds, but records NO revenue", async () => {
    // Money that was given back is not "Collected to date". The pack still
    // binds — ownership must be right even for a voided purchase.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack({ refunded_at: "2026-08-19T00:00:00Z" })],
    });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A");
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("binds billing_customers for a pack-only buyer (no subscription parked)", async () => {
    // The regression this closes: the customer mapping used to sit BELOW the
    // "no parked subscriptions" early return, so a buyer who only ever bought a
    // pack was never mapped — no portal link, no console attribution.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack()],
      billing_customers: [{ email: "buyer@x.com", user_id: null, provider: "lemonsqueezy" }],
    });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.billing_customers[0] as Row).user_id).toBe("user-A");
  });

  it("writes NOTHING when nothing is parked — this now runs on every dashboard render", async () => {
    // dashboard/layout.tsx calls the claim on every authenticated adult
    // navigation, so the empty case must stay two index probes and zero writes.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [],
      billing_customers: [{ email: "buyer@x.com", user_id: null, provider: "lemonsqueezy" }],
    });
    expect(await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).toBe(0);
    expect(db.writes.length).toBe(0);
    expect((db.tables.billing_customers[0] as Row).user_id).toBeNull(); // not touched speculatively
  });

  it("a pack that arrives BETWEEN the probe and the bind still gets its revenue row", async () => {
    // The bind's predicate is `owner_id is null AND claim_email = <email>`, not
    // the id set the probe read, so a webhook delivery landing in that window is
    // bound too. Billing from the probe's snapshot silently lost that sale for
    // good: the row is now bound, so it never matches `owner_id is null` again,
    // and 0092 is a one-shot repair, not a sweep. Reading the recordable set
    // back FROM the UPDATE is what closes it.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack()] });
    db.afterSelect = (table) => {
      if (table !== "credit_purchases") return;
      db.afterSelect = undefined; // exactly one interleaving
      db.tables.credit_purchases.push(parkedPack({ ls_order_id: "9251299", pack_key: "pack_18", usd: "20.00" }));
    };
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    const recorded = db.writes.filter((w) => w.table === "payments").map((w) => w.row.ls_order_id);
    expect(recorded).toEqual(["9251234", "9251299"]);
  });

  it("a refund that lands mid-claim binds the pack but is never booked as paid", async () => {
    // The refund webhook stamps payments by ls_order_id and matches NOTHING when
    // the claim has not inserted yet, so a 'paid' row written afterwards from a
    // stale snapshot would sit in "Collected to date" forever — nothing runs
    // again to correct it. refunded_at is therefore read as of the bind.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack()] });
    db.afterSelect = (table) => {
      if (table !== "credit_purchases") return;
      db.afterSelect = undefined;
      (db.tables.credit_purchases[0] as Row).refunded_at = "2026-08-19T10:00:00Z";
    };
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A"); // ownership is still right
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("a failed probe still attempts the bind — 'unknown' is not 'nothing parked'", async () => {
    // supabase-js resolves read errors rather than throwing them, so discarding
    // one turns the only bind path into a silent no-op on every render.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack()] });
    db.selectErrors["credit_purchases"] = { message: "PGRST002 schema cache load failed" };
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A");
    expect(db.writes.find((w) => w.table === "payments")).toBeDefined();
  });

  it("credits still bind when 0092's money columns are missing (deployed out of order)", async () => {
    // The UPDATE ... RETURNING names three columns 0092 adds. If the code ships
    // first that statement fails — and the buyer must not pay for a deploy
    // ordering mistake: the bind re-runs blind, exactly as it did before the
    // revenue row existed, and 0092's re-runnable backfill supplies the row.
    const db = new FakeClaimDb({
      subscriptions: [],
      credit_purchases: [parkedPack()],
      billing_customers: [{ email: "buyer@x.com", user_id: null, provider: "lemonsqueezy" }],
    });
    db.updateSelectErrors["credit_purchases"] = { message: 'column credit_purchases.total_minor does not exist' };
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A"); // credits before revenue
    expect((db.tables.credit_purchases[0] as Row).claim_email).toBeNull();
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined(); // waits for the backfill
    expect((db.tables.billing_customers[0] as Row).user_id).toBe("user-A"); // still mapped
  });

  it("a bind that fails outright leaves the pack parked and reclaimable next render", async () => {
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [parkedPack()] });
    db.updateErrors["credit_purchases"] = { message: "permission denied for table credit_purchases" };
    await expect(claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(0);
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBeNull();
    expect((db.tables.credit_purchases[0] as Row).claim_email).toBe("buyer@x.com");
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });
});

// ── subscription invoices → ALL subscription revenue (0093) ──────────────────
// Before 0093 not one subscription payment had ever reached the console: an
// initial order resolves to no credit pack and returns, and a RENEWAL never
// produces an order at all. These tests pin the rule that fixes it and, above
// everything else, the rule that stops it double-counting.
//
// The fixtures use the REAL production objects of 2026-08-20 — order 9261749
// and invoice 8235804, the same $11.79 (999 + 180 IGST) — so "would this double
// count?" is asked with the numbers it was actually asked with.
const invoiceEvent = (over: {
  event?: string;
  custom?: { user_id?: string } | null;
  invoiceId?: string;
  subscriptionId?: number | string | null;
  customerId?: number;
  email?: string | null;
  status?: string | null;
  billingReason?: string;
  refunded?: boolean;
  total?: number | null;
  totalUsd?: number | null;
  subtotal?: number | null;
  subtotalUsd?: number | null;
  discountTotal?: number;
  tax?: number;
  taxUsd?: number;
  currency?: string;
  testMode?: boolean;
  createdAt?: string;
}): LsEvent => {
  // THE LIVE OBJECT'S OWN NUMBERS as the default: subtotal 999 · tax 180 ·
  // total 1179. The tax is not decoration here — it is the whole reason these
  // tests can tell "booked what LS collected" apart from "booked what the
  // business keeps", and every amount assertion below is 999 because of it.
  const total = over.total === undefined ? 1179 : over.total;
  const totalUsd = over.totalUsd === undefined ? total : over.totalUsd;
  const tax = over.tax ?? 180;
  const taxUsd = over.taxUsd ?? tax;
  const discount = over.discountTotal ?? 0;
  const subtotal = over.subtotal === undefined ? (total === null ? null : total - tax + discount) : over.subtotal;
  const subtotalUsd = over.subtotalUsd === undefined ? (totalUsd === null ? null : totalUsd - taxUsd + discount) : over.subtotalUsd;
  return {
  meta: { event_name: over.event ?? "subscription_payment_success", custom_data: over.custom === undefined ? undefined : over.custom },
  data: {
    type: "subscription-invoices", // LS's own type string — not "subscriptions", not "orders"
    id: over.invoiceId ?? "8235804",
    attributes: {
      subscription_id: over.subscriptionId === undefined ? 2448629 : over.subscriptionId,
      customer_id: over.customerId ?? 9663580,
      user_email: over.email === undefined ? "buyer@x.com" : over.email,
      billing_reason: over.billingReason ?? "initial",
      status: over.status === undefined ? "paid" : over.status,
      refunded: over.refunded ?? false,
      subtotal,
      discount_total: discount,
      tax,
      total,
      subtotal_usd: subtotalUsd,
      discount_total_usd: discount,
      tax_usd: taxUsd,
      total_usd: totalUsd,
      currency: over.currency ?? "USD",
      created_at: over.createdAt ?? "2026-08-20T07:19:46.000000Z",
      updated_at: "2026-08-20T07:21:34.000000Z",
      test_mode: over.testMode ?? false,
    },
  },
  };
};

/** The stored subscription an invoice reads its plan_key from — an invoice
 *  carries no variant_id, product_id or product_name, so this lookup is the
 *  only source there is. */
const storedSub = { plan_key: "family_monthly", user_id: "user-A" };

describe("LS subscription invoice → revenue", () => {
  const inv = (db: FakeDb) => db.writes.find((w) => w.table === "subscription_invoices");

  it("records the collected amount for a bound buyer, keyed by the INVOICE id", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({}));
    const pay = db.pay()!;
    expect(pay.op).toBe("insert");
    expect(pay.row.user_id).toBe("user-A");
    // NET OF TAX: LS collected 1179 ($9.99 + $1.80 IGST) and remits the 180
    // itself, so 999 is what the business keeps and 999 is the revenue.
    expect(pay.row.amount).toBe(999);
    expect(pay.row.currency).toBe("usd");
    expect(pay.row.plan_key).toBe("family_monthly"); // from the STORED subscription
    expect(pay.row.status).toBe("paid");
    expect(pay.row.provider).toBe("lemonsqueezy");
    expect(pay.row.school_id).toBeNull(); // personal (B2C) — never school-scoped
    // Dated to the invoice, not to now(): "Collected to date" is a time series
    // and a replayed or late-claimed invoice must land in its own month.
    expect(pay.row.created_at).toBe("2026-08-20T07:19:46.000000Z");
    // THE KEY: the invoice id, in its own column. NOT ls_order_id — LS order
    // ids and invoice ids are separate sequences in one numeric space, so
    // sharing the column would eventually swallow a real sale as a duplicate.
    expect(pay.row.ls_invoice_id).toBe("8235804");
    expect(pay.row.ls_order_id).toBeUndefined();
  });

  it("THE DOUBLE-COUNT PIN: an initial order and its own invoice book ONE payment, not two", async () => {
    // LS represents the first charge BOTH ways — order 9261749 and invoice
    // 8235804 are the same $11.79, field for field — while a renewal produces
    // an invoice and no order. So subscription revenue comes from the invoice
    // only, and order_created must keep ignoring subscription orders. If anyone
    // ever "fixes" that ignore into a revenue path, this test goes red instead
    // of the console quietly reporting $23.58 for one $11.79 sale.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, orderEvent({ custom: { user_id: "user-A" }, orderId: "9261749", productName: "SketchCast Home Basic", variantName: "Monthly", total: 1179, tax: 180 }));
    await run(db, invoiceEvent({ custom: { user_id: "user-A" } }));
    const payments = db.writes.filter((w) => w.table === "payments");
    expect(payments.length).toBe(1);
    expect(payments[0].row.amount).toBe(999);
    expect(payments[0].row.ls_invoice_id).toBe("8235804");
  });

  it("a RENEWAL is recorded — the charge that produces no order at all", async () => {
    // The half of the hole that could never have been closed on the order path:
    // LS sends subscription_payment_success + subscription_updated for a
    // successful renewal and NO order_created.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({ invoiceId: "8300001", billingReason: "renewal", createdAt: "2026-09-20T07:19:46.000000Z" }));
    expect(db.pay()!.row.amount).toBe(999);
    expect(db.pay()!.row.ls_invoice_id).toBe("8300001");
    expect(db.pay()!.row.created_at).toBe("2026-09-20T07:19:46.000000Z");
    expect(inv(db)!.row.billing_reason).toBe("renewal");
  });

  it("writes the durable invoice record every writer prices from", async () => {
    // public.subscriptions has no amount, no currency and no order id, and
    // webhook_events keeps no payload — so before this row existed an invoice's
    // collected amount lived nowhere but Lemon Squeezy. That is exactly why the
    // one sale already made cannot be backfilled from the database.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({}));
    const row = inv(db)!.row;
    expect(row.ls_invoice_id).toBe("8235804");
    expect(row.ls_subscription_id).toBe("2448629");
    expect(row.plan_key).toBe("family_monthly");
    expect(row.billing_reason).toBe("initial");
    expect(row.total_minor).toBe(999); // NET: subtotal 999, not total 1179
    expect(row.total_currency).toBe("usd");
    expect(row.invoice_status).toBe("paid");
    expect(row.invoiced_at).toBe("2026-08-20T07:19:46.000000Z");
    expect(row.refunded_at).toBeNull();
  });

  it("PUBLIC-LINK subscription parks the invoice by email — no payment row yet", async () => {
    // payments.user_id is NOT NULL, so revenue waits for the claim. The money
    // is not lost in the meantime: it is on the parked invoice row.
    const db = new FakeDb({ billing_customers: null, subscriptions: null });
    await run(db, invoiceEvent({ custom: undefined, email: "Buyer@X.com" }));
    expect(inv(db)!.row.owner_id).toBeNull();
    expect(inv(db)!.row.claim_email).toBe("buyer@x.com"); // normalised
    expect(inv(db)!.row.total_minor).toBe(999); // the money survives the wait, already net
    expect(db.pay()).toBeUndefined();
  });

  it("records the money even when the subscription row has not arrived yet", async () => {
    // Delivery order is documented but not guaranteed. plan_key is the only
    // casualty (MRR attribution), never the revenue.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: null });
    await run(db, invoiceEvent({}));
    expect(db.pay()!.row.amount).toBe(999);
    expect(db.pay()!.row.plan_key).toBeNull();
  });

  it("a re-delivered invoice books exactly once (unique ls_invoice_id → no-op)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    db.insertErrors["payments"] = { code: "23505", message: 'duplicate key value violates unique constraint "payments_ls_invoice_uq"' };
    await run(db, invoiceEvent({}));
    expect(db.pay()).toBeUndefined(); // refused by the unique key, swallowed as normal
  });

  it("the recovered-payment pair books ONE payment for ONE charge", async () => {
    // LS fires subscription_payment_success AND subscription_payment_recovered
    // for a single recovered payment, both carrying the same invoice id. An
    // order-keyed or timestamp-keyed scheme would double-count here; the
    // invoice-id unique index absorbs it.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({}));
    db.insertErrors["payments"] = { code: "23505", message: "duplicate key" };
    db.insertErrors["subscription_invoices"] = { code: "23505", message: "duplicate key" };
    await run(db, invoiceEvent({ event: "subscription_payment_recovered" }));
    expect(db.writes.filter((w) => w.table === "payments" && w.op === "insert").length).toBe(1);
  });

  it("a FAILED payment records the invoice but books no revenue, and the later success still books", async () => {
    // Writing a 'pending' row would be strictly worse than writing none: the
    // success event carries the SAME invoice id, so its insert would 23505 into
    // a no-op and the row would sit at 'pending' forever while real money never
    // counted. Skipping keeps the success insert clean on its first try.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({ event: "subscription_payment_failed", status: "pending" }));
    expect(inv(db)!.row.invoice_status).toBe("pending");
    expect(db.pay()).toBeUndefined();

    const db2 = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    db2.insertErrors["subscription_invoices"] = { code: "23505", message: "duplicate key" }; // the failed attempt already wrote it
    await run(db2, invoiceEvent({ event: "subscription_payment_success", status: "paid" }));
    const refresh = db2.writes.find((w) => w.table === "subscription_invoices" && w.op === "update");
    expect(refresh!.row.invoice_status).toBe("paid"); // the stored status catches up
    expect(db2.pay()!.row.amount).toBe(999); // and the money finally books, net
  });

  it("a refund stops the sale counting, and leaves a durable fact for a parked one", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({ event: "subscription_payment_refunded", status: "refunded", refunded: true }));
    const payUpd = db.writes.find((w) => w.table === "payments" && w.op === "update");
    expect(payUpd!.row.status).toBe("refunded");
    expect(payUpd!.filter).toEqual(["ls_invoice_id", "8235804"]);
    const stamp = db.writes.find((w) => w.table === "subscription_invoices" && w.op === "update");
    expect(stamp!.row.refunded_at).toBeTruthy(); // the fact the claim path reads
    // Refund-before-create race: a refunded TOMBSTONE occupies the unique
    // invoice id so a still-retrying 'paid' delivery 23505-no-ops instead of
    // booking money that was given back.
    const tomb = db.writes.find((w) => w.table === "subscription_invoices" && w.op === "insert");
    expect(tomb!.row.refunded_at).toBeTruthy();
    expect(tomb!.row.ls_invoice_id).toBe("8235804");
    // "no NEW money booked" — db.pay() would find the refund UPDATE above, so
    // this asks the question that matters: no payments INSERT happened.
    expect(db.writes.find((w) => w.table === "payments" && w.op === "insert")).toBeUndefined();
  });

  it("a PARTIAL refund is treated as a full refund (never overstates collected money)", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({ status: "partial_refund" }));
    expect(db.writes.find((w) => w.table === "payments" && w.op === "update")!.row.status).toBe("refunded");
    expect(db.writes.find((w) => w.table === "payments" && w.op === "insert")).toBeUndefined();
  });

  it("a TEST-MODE invoice is recorded but never booked as money", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({ testMode: true }));
    expect(inv(db)!.row.test_mode).toBe(true);
    expect(db.pay()).toBeUndefined();
  });

  it("books a non-USD charge at LS's own USD conversion, not as raw foreign minor units", async () => {
    // payments_currency_check (0023) admits only myr/usd. Writing euro cents
    // into a row labelled dollars would be worse than dropping the sale; LS
    // reports the whole money block in USD at its own currency_rate, so the
    // NET is taken from LS's own conversion — subtotal_usd, not total_usd.
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({ currency: "EUR", total: 1085, tax: 165, totalUsd: 1179, taxUsd: 180 }));
    expect(db.pay()!.row.amount).toBe(999); // 1179 usd total − 180 usd tax, never 1085 euro cents
    expect(db.pay()!.row.currency).toBe("usd");
  });

  it("skips the payment row rather than inventing an amount when LS reports none", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({ total: null, totalUsd: null }));
    expect(inv(db)).toBeDefined(); // the invoice is still recorded
    expect(db.pay()).toBeUndefined(); // but no guessed revenue
  });

  it("persists no card data", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" }, subscriptions: storedSub });
    await run(db, invoiceEvent({}));
    const keys = db.writes.flatMap((w) => Object.keys(w.row));
    for (const k of keys) expect(k).not.toMatch(/card|pan|cvv|cvc|number/i);
    expect(JSON.stringify(db.writes)).not.toMatch(/\b\d{13,19}\b/);
  });

  // ── the refund tombstone must survive the delivery it exists to absorb ────
  // The 23505 branch deliberately does NOT return (a recovered payment has to
  // move its stored invoice from 'pending' to 'paid'), so the row that won the
  // key has to be inspected. When it is a REFUND TOMBSTONE the money was given
  // back and the incoming payload — a _success event, frozen at "paid" — is the
  // one thing that cannot say so.
  it("does not book a success delivery that lands on a refund tombstone", async () => {
    const db = new FakeDb({
      billing_customers: { user_id: "user-A" },
      subscriptions: storedSub,
      subscription_invoices: { refunded_at: "2026-08-20T09:00:00.000Z" },
    });
    db.insertErrors.subscription_invoices = { code: "23505", message: "duplicate key" };
    await run(db, invoiceEvent({}));
    expect(db.pay()).toBeUndefined(); // returned money is not revenue
    // and the durable row is left alone — no refresh stamping it back to 'paid'
    expect(db.writes.find((w) => w.table === "subscription_invoices")).toBeUndefined();
  });

  it("still refreshes and books when the row that won the key is NOT refunded", async () => {
    // The recovered-payment flow: _failed stored it at 'pending', _success
    // carries the same invoice id and must finally record the money.
    const db = new FakeDb({
      billing_customers: { user_id: "user-A" },
      subscriptions: storedSub,
      subscription_invoices: { refunded_at: null },
    });
    db.insertErrors.subscription_invoices = { code: "23505", message: "duplicate key" };
    await run(db, invoiceEvent({}));
    const refresh = db.writes.find((w) => w.table === "subscription_invoices");
    expect(refresh?.op).toBe("update");
    expect(refresh?.row.invoice_status).toBe("paid");
    expect(db.pay()!.row.amount).toBe(999);
  });

  // ── the refund tombstone must be ATTRIBUTABLE ────────────────────────────
  // subscription_invoices_attributable (0093) requires owner_id OR claim_email.
  // Both null is 23514, not 23505, so it would degrade to a warning and the
  // refund would leave no durable trace at all — after which a retried success
  // inserts a clean row and books returned money as collected.
  it("attributes a refund tombstone to the bound owner when the invoice carries no email", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await run(db, invoiceEvent({ event: "subscription_payment_refunded", email: null, status: "refunded", refunded: true }));
    const tomb = db.writes.find((w) => w.table === "subscription_invoices" && w.op === "insert");
    expect(tomb).toBeDefined();
    expect(tomb!.row.owner_id).toBe("user-A");
    expect(tomb!.row.refunded_at).toBeTruthy();
  });

  it("refuses to write a tombstone it cannot attribute, rather than violating the CHECK", async () => {
    const db = new FakeDb({}); // no email on the invoice, no customer mapping
    await run(db, invoiceEvent({ event: "subscription_payment_refunded", email: null, status: "refunded", refunded: true }));
    expect(db.writes.find((w) => w.table === "subscription_invoices" && w.op === "insert")).toBeUndefined();
    // the stamps that CAN correct existing rows still ran
    expect(db.writes.filter((w) => w.op === "update").map((w) => w.table)).toEqual(
      expect.arrayContaining(["subscription_invoices", "payments"]),
    );
  });
});

describe("lsRevenueAmount — one definition of 'the amount' for both writers", () => {
  it("takes the NET charge when the currency is one payments can hold", () => {
    expect(lsRevenueAmount(999, "USD", 999)).toEqual({ amount: 999, currency: "usd" });
    expect(lsRevenueAmount(3400, "myr", null)).toEqual({ amount: 3400, currency: "myr" });
  });
  it("falls back to LS's own USD conversion for any other currency", () => {
    expect(lsRevenueAmount(920, "eur", 999)).toEqual({ amount: 999, currency: "usd" });
  });
  it("returns null rather than inventing a figure", () => {
    expect(lsRevenueAmount(null, "eur", null)).toBeNull();
    expect(lsRevenueAmount(undefined, undefined, undefined)).toBeNull();
  });
  it("treats a missing currency as USD — LS's B2C catalogue is USD-priced", () => {
    expect(lsRevenueAmount(800, null, null)).toEqual({ amount: 800, currency: "usd" });
  });
});

// ── THE TAX RULE ────────────────────────────────────────────────────────────
// "Collected to date" counts revenue NET OF TAX (founder, 2026-08-22). Lemon
// Squeezy is Merchant of Record: it adds the tax, it remits the tax, the
// business never keeps it. These are the four money shapes that exist, pinned
// with the numbers read off the live LS API, because every one of them has a
// plausible-looking wrong answer.
describe("lsNetOfTax — what the business keeps, not what LS collected", () => {
  it("THE LIVE SUBSCRIPTION: invoice 8235804 books 999, not the 1179 collected", () => {
    // $9.99 list + $1.80 IGST for an Indian buyer. The 180 is LS's to remit.
    expect(lsNetOfTax({ subtotal: 999, discount_total: 0, tax: 180, total: 1179, currency: "USD" })).toEqual({
      netMinor: 999,
      currency: "usd",
      netUsdMinor: null, // no *_usd fields on this fixture; the native figure is already USD
    });
  });

  it("THE LIVE PACK: order 9261766 books 800, not the 944 collected", () => {
    // The row that is wrong in production today: $8.00 + $1.44 IGST.
    expect(lsNetOfTax({ subtotal: 800, discount_total: 0, tax: 144, total: 944, currency: "usd" }).netMinor).toBe(800);
  });

  it("THE DISCOUNT TRAP: a FOUNDINGTEACHER order books 1000, not subtotal's 2400", () => {
    // $14 off $24. `subtotal` is BEFORE the discount, so booking it bare would
    // report $24 for a $10 sale — a bigger overstatement than the gross bug
    // this replaces, and in the same direction. If anyone ever "simplifies"
    // netOfTax to `return subtotal`, this is the test that goes red.
    expect(lsNetOfTax({ subtotal: 2400, discount_total: 1400, tax: 0, total: 1000, currency: "usd" }).netMinor).toBe(1000);
    // …and the same order taxed: the tax rides on the DISCOUNTED price, and
    // neither `total` (1180) nor `subtotal` (2400) is the answer.
    expect(lsNetOfTax({ subtotal: 2400, discount_total: 1400, tax: 180, total: 1180, currency: "usd" }).netMinor).toBe(1000);
  });

  it("a 100%-discounted sale books 0 — collected nothing, and 0 is the truth", () => {
    expect(lsNetOfTax({ subtotal: 2400, discount_total: 2400, tax: 0, total: 0 }).netMinor).toBe(0);
  });

  it("an untaxed order is unchanged — the three legacy test packs stay at 800", () => {
    // Correct under either policy. A blanket "reduce everything by the tax
    // rate" would have destroyed $24 of correctly-booked money here.
    expect(lsNetOfTax({ subtotal: 800, discount_total: 0, tax: 0, total: 800 }).netMinor).toBe(800);
  });

  it("falls back to total - tax when LS omits the subtotal pair", () => {
    // The other side of LS's identity (total = subtotal - discount_total + tax),
    // used only when the primary pair is absent — never in preference to it.
    expect(lsNetOfTax({ tax: 180, total: 1179 }).netMinor).toBe(999);
    expect(lsNetOfTax({ total: 800 }).netMinor).toBe(800); // no tax field at all
  });

  it("nets LS's own USD conversion the same way, for a currency payments cannot hold", () => {
    const net = lsNetOfTax({
      subtotal: 920, discount_total: 0, tax: 165, total: 1085, currency: "EUR",
      subtotal_usd: 999, discount_total_usd: 0, tax_usd: 180, total_usd: 1179,
    });
    expect(net).toEqual({ netMinor: 920, currency: "eur", netUsdMinor: 999 });
    // and the writer picks the USD one, because payments cannot hold euros
    expect(lsRevenueAmount(net.netMinor, net.currency, net.netUsdMinor)).toEqual({ amount: 999, currency: "usd" });
  });

  it("returns null rather than inventing a figure — including for incoherent data", () => {
    expect(lsNetOfTax({}).netMinor).toBeNull();
    expect(lsNetOfTax({ subtotal: null, total: null }).netMinor).toBeNull();
    // a discount larger than its own subtotal is corrupt, not a refund: skip and
    // log rather than write a negative row into the revenue series
    expect(lsNetOfTax({ subtotal: 800, discount_total: 900, total: null }).netMinor).toBeNull();
  });
});

// ── claim-on-sign-in → subscription revenue ──────────────────────────────────
// The mirror of the pack path: payments.user_id is NOT NULL, so a subscription
// bought from the public pricing page while logged out cannot record its
// revenue at webhook time. The bind is the first moment a user_id exists.
describe("claim-on-sign-in → subscription invoice revenue", () => {
  const parkedInvoice = (over: Partial<Row> = {}): Row => ({
    owner_id: null,
    claim_email: "buyer@x.com",
    provider: "lemonsqueezy",
    ls_invoice_id: "8235804",
    ls_subscription_id: "2448629",
    plan_key: "family_monthly",
    billing_reason: "initial",
    // NET of tax, exactly as lsNetOfTax stamps it: invoice 8235804 collected
    // 1179 and the business keeps 999. A 1179 here would be a gross row, which
    // this schema no longer has a way to produce.
    total_minor: 999,
    total_currency: "usd",
    total_usd_minor: 999,
    invoice_status: "paid",
    test_mode: false,
    refunded_at: null,
    invoiced_at: "2026-08-20T07:19:46.000000Z",
    ...over,
  });

  it("a bound invoice writes the payments row the webhook could not", async () => {
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice()] });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "Buyer@X.com"); // case-insensitive
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBe("user-A");
    expect((db.tables.subscription_invoices[0] as Row).claim_email).toBeNull();
    const pay = db.writes.find((w) => w.table === "payments")!;
    expect(pay.op).toBe("insert");
    expect(pay.row.user_id).toBe("user-A");
    expect(pay.row.amount).toBe(999);
    expect(pay.row.currency).toBe("usd");
    expect(pay.row.plan_key).toBe("family_monthly");
    expect(pay.row.ls_invoice_id).toBe("8235804");
    expect(pay.row.status).toBe("paid");
    expect(pay.row.created_at).toBe("2026-08-20T07:19:46.000000Z"); // the charge's own date
  });

  it("does NOT claim an invoice parked under a different email", async () => {
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice({ claim_email: "someone@else.com" })] });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBeNull();
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("a REFUNDED parked invoice binds, but records NO revenue", async () => {
    // Money given back is not "Collected to date". The webhook's refund path
    // stamps payments by invoice id and matches nothing when the claim has not
    // inserted yet, so refunded_at on the invoice is the only durable fact —
    // and it is read as of the BIND, not an earlier probe.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice({ refunded_at: "2026-08-21T00:00:00Z" })] });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBe("user-A"); // ownership still right
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("a refund landing mid-claim is seen, not booked from a stale snapshot", async () => {
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice()] });
    db.afterSelect = (table) => {
      if (table !== "subscription_invoices") return;
      db.afterSelect = undefined; // exactly one interleaving
      (db.tables.subscription_invoices[0] as Row).refunded_at = "2026-08-21T10:00:00Z";
    };
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBe("user-A");
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("an invoice arriving BETWEEN the probe and the bind still gets its revenue row", async () => {
    // The bind's predicate is `owner_id is null AND claim_email = <email>`, not
    // the id set the probe read. Billing from the probe's snapshot would lose
    // that renewal for good — a bound row never matches `owner_id is null`
    // again, and 0093's backfill only sees what was recorded.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice()] });
    db.afterSelect = (table) => {
      if (table !== "subscription_invoices") return;
      db.afterSelect = undefined;
      db.tables.subscription_invoices.push(parkedInvoice({ ls_invoice_id: "8300001", billing_reason: "renewal" }));
    };
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect(db.writes.filter((w) => w.table === "payments").map((w) => w.row.ls_invoice_id)).toEqual(["8235804", "8300001"]);
  });

  it("a PENDING invoice binds but is never booked as collected", async () => {
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice({ invoice_status: "pending" })] });
    await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com");
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBe("user-A");
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("a duplicate payments row (23505) is swallowed and the binding still stands", async () => {
    // The webhook got there first, 0093's backfill did, or a second tab claimed
    // concurrently. payments_ls_invoice_uq makes all three harmless.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice()] });
    db.insertErrors["payments"] = { code: "23505", message: 'duplicate key value violates unique constraint "payments_ls_invoice_uq"' };
    await expect(claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(0);
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBe("user-A");
  });

  it("a HARD payments failure never costs the buyer their entitlement", async () => {
    // Bookkeeping must never be able to fail an access grant. The parked
    // SUBSCRIPTION alongside must still claim and still produce its entitlement.
    const db = new FakeClaimDb({
      subscriptions: [{ ls_subscription_id: "2448629", plan_key: "family_monthly", status: "active", current_period_end: "2999-01-01T00:00:00Z", user_id: null, provider: "lemonsqueezy", claim_email: "buyer@x.com" }],
      credit_purchases: [],
      subscription_invoices: [parkedInvoice()],
    });
    db.insertErrors["payments"] = { code: "42501", message: "permission denied for table payments" };
    await expect(claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(1);
    expect(db.writes.find((w) => w.table === "entitlements")!.row.active).toBe(true);
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBe("user-A");
  });

  it("writes NOTHING when nothing is parked — this runs on every dashboard render", async () => {
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [] });
    expect(await claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).toBe(0);
    expect(db.writes.length).toBe(0);
  });

  it("a bind that fails outright leaves the invoice parked and reclaimable next render", async () => {
    // Nothing is granted on this path, so there is no blind-bind fallback to
    // make and nothing to lose: it simply tries again on the next render.
    const db = new FakeClaimDb({ subscriptions: [], credit_purchases: [], subscription_invoices: [parkedInvoice()] });
    db.updateErrors["subscription_invoices"] = { message: "permission denied for table subscription_invoices" };
    await expect(claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(0);
    expect((db.tables.subscription_invoices[0] as Row).owner_id).toBeNull();
    expect((db.tables.subscription_invoices[0] as Row).claim_email).toBe("buyer@x.com");
    expect(db.writes.find((w) => w.table === "payments")).toBeUndefined();
  });

  it("survives 0093 not being applied yet — credits and access still claim", async () => {
    // Deploy-order insurance. The probe and the bind both fail (no such table),
    // and neither the pack credits nor the subscription entitlement may notice.
    const db = new FakeClaimDb({
      subscriptions: [{ ls_subscription_id: "2448629", plan_key: "family_monthly", status: "active", current_period_end: "2999-01-01T00:00:00Z", user_id: null, provider: "lemonsqueezy", claim_email: "buyer@x.com" }],
      credit_purchases: [{ owner_id: null, claim_email: "buyer@x.com", credits: 6, pack_key: "pack_6", usd: "8.00", total_minor: null, total_currency: null, order_status: null, ls_order_id: "9251234", refunded_at: null, created_at: "2026-08-18T12:34:56Z" }],
      subscription_invoices: [],
    });
    db.selectErrors["subscription_invoices"] = { message: 'relation "public.subscription_invoices" does not exist' };
    db.updateErrors["subscription_invoices"] = { message: 'relation "public.subscription_invoices" does not exist' };
    await expect(claimLsPurchasesWith(db as unknown as ClaimDb, "user-A", "buyer@x.com")).resolves.toBe(1);
    expect((db.tables.credit_purchases[0] as Row).owner_id).toBe("user-A"); // credits
    expect(db.writes.find((w) => w.table === "entitlements")!.row.active).toBe(true); // access
  });
});
