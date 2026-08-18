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
          : { product_id: 42, variant_id: 4242, product_name: over.productName ?? "SketchCast Credits — 1 kit (6)", variant_name: "Default" },
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
  constructor(tables: Record<string, Row[]> = {}) {
    this.tables = tables;
  }
  from(table: string) {
    const tables = this.tables;
    const writes = this.writes;
    const make = (kind: "select" | "update", payload?: Row) => {
      const filters: Array<[string, unknown]> = [];
      const thenable = {
        eq(col: string, v: unknown) { filters.push([col, v]); return thenable; },
        is(col: string, v: unknown) { filters.push([col, v]); return thenable; },
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          try {
            const rows = (tables[table] ?? []).filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
            if (kind === "select") return resolve({ data: rows });
            rows.forEach((r) => Object.assign(r, payload)); // update
            writes.push({ table, op: "update", row: payload ?? {}, matched: rows.length });
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
