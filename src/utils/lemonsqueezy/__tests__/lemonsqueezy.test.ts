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
 * Run: npx vitest run
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLsSignature, lsEventKey } from "../webhook";
import { handleLsEvent, type LsEvent } from "../handlers";
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
  total?: number;
}): LsEvent => ({
  meta: { event_name: over.event ?? "order_created", custom_data: over.custom === undefined ? undefined : over.custom },
  data: {
    type: "orders",
    id: over.orderId ?? "ord_1",
    attributes: {
      customer_id: over.customerId ?? 777,
      user_email: over.email === undefined ? null : over.email,
      status: over.status ?? "paid",
      refunded: over.refunded ?? false,
      total: over.total ?? 800,
      currency: "USD",
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
});

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

  it("ignores invoice-shaped subscription_payment_* events (never revokes on 'paid')", async () => {
    const db = new FakeDb({ billing_customers: { user_id: "user-A" } });
    await handleLsEvent(db, {
      meta: { event_name: "subscription_payment_success", custom_data: { user_id: "user-A", plan_key: "teacher_pro_monthly" } },
      data: { type: "subscription-invoices", id: "inv_1", attributes: { status: "paid", customer_id: 555, renews_at: null, ends_at: null, updated_at: "2026-07-06T12:00:00Z" } },
    } as LsEvent);
    expect(db.writes.length).toBe(0);
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
